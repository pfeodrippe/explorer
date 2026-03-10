#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile, spawn, spawnSync } = require("child_process");

const {
  buildQueryPrompt,
  executeToolCall,
  extractDeviceCode,
  extractFirstJsonObject,
  extractFirstUrl,
  findStringWithJson,
  getBridgeConfigPath,
  getToolDefinitions,
  loadBridgeConfig,
  normalizeQueryResponse,
  parseClaudeStatus,
  parseCodexStatus,
  parseOpencodeAuthList,
  saveBridgeConfig,
  stripAnsi
} = require("./ai-bridge-lib");

const DEFAULT_HOST = process.env.FLECS_EXPLORER_AI_BRIDGE_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.FLECS_EXPLORER_AI_BRIDGE_PORT || "27891");
const CONFIG_PATH = getBridgeConfigPath(process.env);
const AUTH_SESSION_POLL_MS = 1500;
const AUTH_SESSION_TIMEOUT_MS = 3 * 60 * 1000;
const AUTH_SESSION_RETENTION_MS = 10 * 60 * 1000;
const AUTH_SESSION_OUTPUT_LIMIT = 2400;
const GENERATION_JOB_POLL_MS = 400;
const GENERATION_JOB_TIMEOUT_MS = 90 * 1000;
const GENERATION_JOB_RETENTION_MS = 10 * 60 * 1000;
const GENERATION_JOB_EVENT_LIMIT = 12;
const OPENCODE_SERVER_TIMEOUT_MS = 5000;
const OPENCODE_REQUEST_TIMEOUT_MS = 10000;
const MAX_PROVIDER_TOOL_STEPS = 3;
const MAX_TOOL_RESULTS = 8;
const OPENCODE_DISABLED_TOOLS = {
  invalid: false,
  question: false,
  bash: false,
  read: false,
  glob: false,
  grep: false,
  task: false,
  webfetch: false,
  websearch: false,
  codesearch: false,
  todowrite: false,
  todoread: false,
  skill: false,
  apply_patch: false,
  lsp: false
};
const AUTH_SESSIONS = new Map();
const GENERATION_JOBS = new Map();
const DEBUG_LOGS = [];
const MAX_DEBUG_LOGS = 100;

function debugLog(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, message, data };
  
  DEBUG_LOGS.push(entry);
  if (DEBUG_LOGS.length > MAX_DEBUG_LOGS) {
    DEBUG_LOGS.shift();
  }
  
  // Also log to console
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  if (data) {
    console.log(prefix, message, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(prefix, message);
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getOpencodeServerUrl() {
  return process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
}

function createAbortError(message = "Request aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function createTimeoutError(message) {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function isTerminalGenerationJobStatus(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function serializeGenerationJob(job) {
  return {
    id: job.id,
    providerId: job.providerId,
    providerName: job.providerName,
    model: job.model || "",
    status: job.status,
    stage: job.stage || "",
    stageDetail: job.stageDetail || "",
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || "",
    elapsedMs: Date.now() - job.startedAtMs,
    canCancel: Boolean(job.canCancel),
    result: job.result,
    error: job.error || "",
    events: job.events || []
  };
}

function appendGenerationJobEvent(job, message, level = "info") {
  if (!message) {
    return;
  }

  const nextEvents = (job.events || []).concat({
    time: new Date().toISOString(),
    level,
    message: String(message)
  });

  job.events = nextEvents.slice(-GENERATION_JOB_EVENT_LIMIT);
}

function updateGenerationJob(job, patch) {
  Object.assign(job, patch, {
    updatedAt: new Date().toISOString()
  });
}

function setGenerationJobStage(job, stage, detail = "", level = "info") {
  const nextStage = String(stage || "").trim();
  const nextDetail = String(detail || "").trim();

  if (job.stage === nextStage && job.stageDetail === nextDetail) {
    return;
  }

  updateGenerationJob(job, {
    stage: nextStage,
    stageDetail: nextDetail,
    status: job.status === "queued" ? "running" : job.status
  });
  appendGenerationJobEvent(job, nextDetail ? `${nextStage}: ${nextDetail}` : nextStage, level);
}

function scheduleGenerationJobRetirement(job) {
  if (job.retireTimer) {
    clearTimeout(job.retireTimer);
  }

  job.retireTimer = setTimeout(() => {
    GENERATION_JOBS.delete(job.id);
  }, GENERATION_JOB_RETENTION_MS);
}

function finalizeGenerationJob(job, status, patch = {}) {
  if (isTerminalGenerationJobStatus(job.status)) {
    return job;
  }

  updateGenerationJob(job, {
    ...patch,
    status,
    canCancel: false,
    completedAt: new Date().toISOString()
  });
  scheduleGenerationJobRetirement(job);
  return job;
}

function createGenerationJob({ providerId, providerName, model }) {
  const now = new Date();
  const job = {
    id: crypto.randomUUID(),
    providerId,
    providerName,
    model: model || "",
    status: "queued",
    stage: "Queued",
    stageDetail: "Waiting to start generation",
    startedAt: now.toISOString(),
    startedAtMs: now.getTime(),
    updatedAt: now.toISOString(),
    completedAt: "",
    canCancel: true,
    result: undefined,
    error: "",
    events: [],
    abortController: new AbortController(),
    cancel: undefined,
    retireTimer: undefined
  };

  appendGenerationJobEvent(job, "Queued: Waiting to start generation");
  GENERATION_JOBS.set(job.id, job);
  return job;
}

function getGenerationJob(jobId) {
  const job = GENERATION_JOBS.get(jobId);
  if (!job) {
    throw new Error("Generation job not found");
  }
  return job;
}

async function cancelGenerationJob(job, reason = "Generation cancelled") {
  if (isTerminalGenerationJobStatus(job.status)) {
    return job;
  }

  appendGenerationJobEvent(job, reason, "warn");

  const cancel = job.cancel;
  if (typeof cancel === "function") {
    try {
      await cancel();
    } catch (error) {
      appendGenerationJobEvent(job, `Abort cleanup failed: ${error.message || error}`, "warn");
    }
  }

  if (!job.abortController.signal.aborted) {
    job.abortController.abort(createAbortError(reason));
  }

  finalizeGenerationJob(job, "cancelled", {
    stage: "Cancelled",
    stageDetail: reason,
    error: ""
  });

  return job;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason || createAbortError());
      return;
    }

    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason || createAbortError());
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

const PROVIDERS = {
  "claude-cli": {
    id: "claude-cli",
    name: "Claude CLI",
    kind: "cli",
    authMode: "oauth",
    binary: "claude",
    loginCommand: ["claude", "auth", "login"],
    browserOauthCommand: ["claude", "auth", "login"],
    supportsBrowserOauth: true,
    supportsTerminalLaunch: true,
    authDescription: "Browser sign-in through the local Claude CLI."
  },
  "codex-cli": {
    id: "codex-cli",
    name: "Codex CLI",
    kind: "cli",
    authMode: "oauth",
    binary: "codex",
    loginCommand: ["codex", "login"],
    browserOauthCommand: ["codex", "login", "--device-auth"],
    supportsBrowserOauth: true,
    supportsTerminalLaunch: true,
    authDescription: "Device and browser sign-in through the local Codex CLI."
  },
  "opencode-cli": {
    id: "opencode-cli",
    name: "OpenCode CLI",
    kind: "cli",
    authMode: "oauth",
    binary: "opencode",
    loginCommand: ["opencode", "auth", "login"],
    supportsBrowserOauth: false,
    supportsTerminalLaunch: true,
    authDescription: "Terminal-assisted sign-in through the local OpenCode CLI."
  },
  "openai-api": {
    id: "openai-api",
    name: "OpenAI API",
    kind: "api",
    authMode: "api_key",
    supportsBrowserOauth: false,
    supportsTerminalLaunch: false,
    authDescription: "Configure an API key and model for direct API access."
  },
  "anthropic-api": {
    id: "anthropic-api",
    name: "Anthropic API",
    kind: "api",
    authMode: "api_key",
    supportsBrowserOauth: false,
    supportsTerminalLaunch: false,
    authDescription: "Configure an API key and model for direct API access."
  }
};

function sendJson(res, code, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendError(res, code, error) {
  sendJson(res, code, {
    error: String(error && error.message ? error.message : error)
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Request body must be valid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function lookupBinary(binary) {
  const result = spawnSync("which", [binary], { encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  return undefined;
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appleScriptEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runCommand(binary, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        cwd: options.cwd || process.cwd(),
        timeout: options.timeout || 120000,
        maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
        env: {
          ...process.env,
          ...(options.env || {})
        }
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          error,
          stdout: stdout || "",
          stderr: stderr || "",
          code: error && typeof error.code === "number" ? error.code : 0,
          timedOut: Boolean(error && error.killed)
        });
      }
    );
  });
}

function trimOutputPreview(value) {
  return stripAnsi(value || "").slice(-AUTH_SESSION_OUTPUT_LIMIT).trim();
}

function isTerminalAuthSessionStatus(status) {
  return status === "ready" || status === "failed" || status === "timed_out";
}

function serializeAuthSession(session) {
  return {
    id: session.id,
    providerId: session.providerId,
    providerName: session.providerName,
    status: session.status,
    message: session.message,
    command: session.command,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt || "",
    authorizationUrl: session.authorizationUrl || "",
    authorizationCode: session.authorizationCode || "",
    browserOpened: Boolean(session.browserOpened),
    outputPreview: session.outputPreview || "",
    error: session.error || ""
  };
}

function updateAuthSession(session, patch) {
  Object.assign(session, patch, {
    updatedAt: new Date().toISOString()
  });
}

function cleanupAuthSession(session) {
  if (session.pollTimer) {
    clearInterval(session.pollTimer);
    session.pollTimer = undefined;
  }

  if (session.retireTimer) {
    clearTimeout(session.retireTimer);
    session.retireTimer = undefined;
  }

  if (session.child && !session.child.killed) {
    try {
      session.child.kill("SIGTERM");
    } catch (error) {
      // Ignore kill failures for already-finished children.
    }
  }
}

function scheduleAuthSessionRetirement(session) {
  if (session.retireTimer) {
    clearTimeout(session.retireTimer);
  }

  session.retireTimer = setTimeout(() => {
    cleanupAuthSession(session);
    AUTH_SESSIONS.delete(session.id);
  }, AUTH_SESSION_RETENTION_MS);
}

async function openExternalUrl(url) {
  if (!url) {
    return false;
  }

  if (process.platform === "darwin") {
    const result = await runCommand("open", [url], { timeout: 10000 });
    return result.ok;
  }

  if (process.platform === "win32") {
    const result = await runCommand("cmd", ["/c", "start", "", url], { timeout: 10000 });
    return result.ok;
  }

  const result = await runCommand("xdg-open", [url], { timeout: 10000 });
  return result.ok;
}

function providerConfigKey(providerId) {
  if (providerId === "openai-api") {
    return "openai";
  }
  if (providerId === "anthropic-api") {
    return "anthropic";
  }
  return undefined;
}

function summarizeError(prefix, result) {
  const detail = stripAnsi(result.stderr || result.stdout || result.error && result.error.message || "").trim();
  return detail ? `${prefix}: ${detail}` : prefix;
}

function parseOpencodeModelRef(value) {
  const text = String(value || "").trim();
  if (!text) {
    return undefined;
  }

  const separatorIndex = text.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === text.length - 1) {
    return undefined;
  }

  const providerID = text.slice(0, separatorIndex).trim();
  const modelID = text.slice(separatorIndex + 1).trim();
  if (!providerID || !modelID) {
    return undefined;
  }

  return { providerID, modelID };
}

function extractOpencodeTextParts(messageResponse) {
  if (!messageResponse || !Array.isArray(messageResponse.parts)) {
    return "";
  }

  return messageResponse.parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function findCompletedOpencodeMessage(messages) {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  return messages.find((message) => {
    return message &&
      message.info &&
      message.info.role === "assistant" &&
      message.info.time &&
      message.info.time.completed;
  });
}

function extractOpencodeMessageError(message) {
  if (!message || !message.info || !message.info.error) {
    return "";
  }

  const error = message.info.error;
  if (typeof error === "string") {
    return error;
  }

  if (error.data && error.data.message) {
    return String(error.data.message);
  }

  if (error.message) {
    return String(error.message);
  }

  return "OpenCode returned an error";
}

async function getOpencodeServerStatus(signal) {
  const serverUrl = getOpencodeServerUrl();

  try {
    const response = await fetchJson(`${serverUrl}/global/health`, {
      signal,
      timeout: OPENCODE_SERVER_TIMEOUT_MS
    });

    return {
      healthy: Boolean(response && response.healthy),
      serverUrl,
      version: response && response.version ? String(response.version) : "",
      message: response && response.healthy
        ? `OpenCode server reachable at ${serverUrl}`
        : `OpenCode server is unhealthy at ${serverUrl}`
    };
  } catch (error) {
    return {
      healthy: false,
      serverUrl,
      version: "",
      message: `OpenCode server unavailable at ${serverUrl}`,
      error: String(error.message || error)
    };
  }
}

async function getCliProviderStatus(provider) {
  const binaryPath = lookupBinary(provider.binary);
  if (!binaryPath) {
    return {
      ...provider,
      installed: false,
      ready: false,
      status: "missing",
      message: `${provider.binary} is not installed`,
      command: provider.loginCommand.join(" ")
    };
  }

  if (provider.id === "claude-cli") {
    const result = await runCommand(provider.binary, ["auth", "status", "--json"], {
      timeout: 10000
    });

    const parsed = parseClaudeStatus(result.stdout || result.stderr);
    return {
      ...provider,
      installed: true,
      ready: parsed.ready,
      status: parsed.ready ? "ready" : "needs_auth",
      message: parsed.ready
        ? `Signed in with ${parsed.details.authMethod || "Claude"}`
        : "Claude CLI needs sign-in",
      details: parsed.details,
      command: provider.loginCommand.join(" "),
      binaryPath
    };
  }

  if (provider.id === "codex-cli") {
    const result = await runCommand(provider.binary, ["login", "status"], {
      timeout: 10000
    });

    const parsed = parseCodexStatus(result.stdout || result.stderr);
    return {
      ...provider,
      installed: true,
      ready: parsed.ready,
      status: parsed.ready ? "ready" : "needs_auth",
      message: parsed.ready ? parsed.summary : "Codex CLI needs sign-in",
      command: provider.loginCommand.join(" "),
      binaryPath
    };
  }

  const result = await runCommand(provider.binary, ["auth", "list"], {
    timeout: 10000
  });
  const parsed = parseOpencodeAuthList(result.stdout || result.stderr);
  const serverStatus = await getOpencodeServerStatus();
  const credentialsReady = parsed.ready;
  const serverReady = serverStatus.healthy;
  const ready = credentialsReady && serverReady;
  const status = !credentialsReady
    ? "needs_auth"
    : (serverReady ? "ready" : "needs_server");

  return {
    ...provider,
    installed: true,
    ready,
    status,
    message: !credentialsReady
      ? "OpenCode CLI needs sign-in"
      : (
          serverReady
            ? `${parsed.credentialCount} configured credential${parsed.credentialCount === 1 ? "" : "s"}`
            : `${parsed.credentialCount} configured credential${parsed.credentialCount === 1 ? "" : "s"}; start the OpenCode server`
        ),
    details: parsed,
    command: provider.loginCommand.join(" "),
    binaryPath,
    serverHealthy: serverReady,
    serverMessage: serverStatus.message,
    serverError: serverStatus.error || "",
    serverUrl: serverStatus.serverUrl,
    serverVersion: serverStatus.version
  };
}

function getApiProviderStatus(provider, config) {
  const key = providerConfigKey(provider.id);
  const saved = key ? (config.providers[key] || {}) : {};
  const hasKey = Boolean(saved.apiKey);
  const hasModel = Boolean(saved.model);

  return {
    ...provider,
    installed: true,
    ready: hasKey && hasModel,
    status: hasKey && hasModel ? "ready" : "needs_config",
    message: hasKey
      ? (hasModel ? "API key and model configured" : "Model is required")
      : "API key not configured",
    hasStoredSecret: hasKey,
    model: saved.model || ""
  };
}

function getAuthSession(sessionId) {
  const session = AUTH_SESSIONS.get(sessionId);
  if (!session) {
    throw new Error("Auth session not found");
  }
  return session;
}

function getActiveAuthSessionForProvider(providerId) {
  for (const session of AUTH_SESSIONS.values()) {
    if (session.providerId === providerId && !isTerminalAuthSessionStatus(session.status)) {
      return session;
    }
  }
  return undefined;
}

function finalizeAuthSession(session, status, message, extras = {}) {
  if (isTerminalAuthSessionStatus(session.status)) {
    return session;
  }

  updateAuthSession(session, {
    ...extras,
    status,
    message,
    completedAt: new Date().toISOString(),
    error: status === "failed" ? (extras.error || message) : (extras.error || "")
  });
  cleanupAuthSession(session);
  scheduleAuthSessionRetirement(session);
  return session;
}

async function refreshAuthSessionState(session) {
  if (isTerminalAuthSessionStatus(session.status)) {
    return session;
  }

  if (Date.now() > session.expiresAt) {
    return finalizeAuthSession(
      session,
      "timed_out",
      `${session.providerName} sign-in did not complete before timeout`
    );
  }

  const provider = PROVIDERS[session.providerId];
  if (!provider) {
    return finalizeAuthSession(session, "failed", "Provider is no longer available");
  }

  const providerStatus = await getCliProviderStatus(provider);
  if (providerStatus.ready) {
    return finalizeAuthSession(session, "ready", providerStatus.message || `${provider.name} is ready`);
  }

  if (session.processExited && session.exitCode === 0) {
    updateAuthSession(session, {
      status: "running",
      message: session.authorizationUrl
        ? `Complete ${provider.name} sign-in in the browser`
        : `${provider.name} started a browser sign-in flow`
    });
  }

  return session;
}

async function captureAuthSessionOutput(session, chunk) {
  const nextOutput = trimOutputPreview(`${session.outputPreview}\n${chunk}`);
  const authorizationUrl = extractFirstUrl(nextOutput) || session.authorizationUrl;
  const authorizationCode = extractDeviceCode(nextOutput) || session.authorizationCode;
  const updates = {
    outputPreview: nextOutput
  };

  if (authorizationUrl && authorizationUrl !== session.authorizationUrl) {
    updates.authorizationUrl = authorizationUrl;
  }

  if (authorizationCode && authorizationCode !== session.authorizationCode) {
    updates.authorizationCode = authorizationCode;
  }

  if (authorizationUrl && !session.browserOpenAttempted) {
    session.browserOpenAttempted = true;
    updates.message = `Opening ${session.providerName} sign-in in the browser`;
    updateAuthSession(session, updates);

    try {
      const browserOpened = await openExternalUrl(authorizationUrl);
      updateAuthSession(session, {
        browserOpened,
        message: browserOpened
          ? `Complete ${session.providerName} sign-in in the browser`
          : `Open the authorization link to finish ${session.providerName} sign-in`
      });
    } catch (error) {
      updateAuthSession(session, {
        browserOpened: false,
        message: `Open the authorization link to finish ${session.providerName} sign-in`
      });
    }
    return;
  }

  if (authorizationUrl) {
    updates.message = `Complete ${session.providerName} sign-in in the browser`;
  }

  updateAuthSession(session, updates);
}

async function listProviders(config) {
  const providers = await Promise.all(
    Object.values(PROVIDERS).map((provider) => {
      if (provider.kind === "cli") {
        return getCliProviderStatus(provider);
      }
      return Promise.resolve(getApiProviderStatus(provider, config));
    })
  );

  return providers;
}

async function launchLogin(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider || provider.kind !== "cli") {
    throw new Error("Login launch is only supported for CLI providers");
  }

  const command = provider.loginCommand.map(shellEscape).join(" ");
  if (process.platform !== "darwin") {
    return {
      launched: false,
      command,
      message: "Run the command manually in a local terminal"
    };
  }

  const script = `tell application "Terminal"\nactivate\ndo script "cd ${appleScriptEscape(process.cwd())}; ${appleScriptEscape(command)}"\nend tell`;
  const result = await runCommand("osascript", ["-e", script], {
    timeout: 10000
  });

  if (!result.ok) {
    throw new Error(summarizeError("Failed to launch login flow", result));
  }

  return {
    launched: true,
    command,
    message: "Login flow opened in Terminal"
  };
}

async function startBrowserOauth(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider || provider.kind !== "cli") {
    throw new Error("Browser OAuth is only supported for CLI providers");
  }
  if (!provider.supportsBrowserOauth || !provider.browserOauthCommand) {
    throw new Error(`${provider.name} does not support bridge-managed browser OAuth`);
  }

  const activeSession = getActiveAuthSessionForProvider(providerId);
  if (activeSession) {
    return serializeAuthSession(activeSession);
  }

  const providerStatus = await getCliProviderStatus(provider);
  if (providerStatus.ready) {
    const now = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(),
      providerId: provider.id,
      providerName: provider.name,
      status: "ready",
      message: providerStatus.message || `${provider.name} is already signed in`,
      command: provider.browserOauthCommand.join(" "),
      startedAt: now,
      updatedAt: now,
      completedAt: now,
      authorizationUrl: "",
      authorizationCode: "",
      browserOpened: false,
      outputPreview: "",
      error: ""
    };
    AUTH_SESSIONS.set(session.id, session);
    scheduleAuthSessionRetirement(session);
    return serializeAuthSession(session);
  }

  const session = {
    id: crypto.randomUUID(),
    providerId: provider.id,
    providerName: provider.name,
    status: "pending",
    message: `Starting ${provider.name} browser sign-in`,
    command: provider.browserOauthCommand.join(" "),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: "",
    authorizationUrl: "",
    authorizationCode: "",
    browserOpened: false,
    browserOpenAttempted: false,
    outputPreview: "",
    error: "",
    expiresAt: Date.now() + AUTH_SESSION_TIMEOUT_MS,
    processExited: false,
    exitCode: undefined,
    child: undefined,
    pollTimer: undefined,
    retireTimer: undefined
  };
  AUTH_SESSIONS.set(session.id, session);

  const child = spawn(provider.browserOauthCommand[0], provider.browserOauthCommand.slice(1), {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  session.child = child;
  updateAuthSession(session, {
    status: "running",
    message: `Waiting for ${provider.name} sign-in`
  });

  const handleOutput = (chunk) => {
    captureAuthSessionOutput(session, chunk.toString("utf8")).catch((error) => {
      updateAuthSession(session, {
        outputPreview: trimOutputPreview(`${session.outputPreview}\n${error.message}`),
        message: `Waiting for ${provider.name} sign-in`
      });
    });
  };

  if (child.stdout) {
    child.stdout.on("data", handleOutput);
  }

  if (child.stderr) {
    child.stderr.on("data", handleOutput);
  }

  child.on("error", (error) => {
    finalizeAuthSession(
      session,
      "failed",
      `Could not start ${provider.name} sign-in`,
      {
        error: String(error.message || error),
        outputPreview: trimOutputPreview(`${session.outputPreview}\n${error.message}`)
      }
    );
  });

  child.on("exit", (code) => {
    session.processExited = true;
    session.exitCode = typeof code === "number" ? code : 0;

    if (isTerminalAuthSessionStatus(session.status)) {
      return;
    }

    if (session.exitCode !== 0) {
      finalizeAuthSession(
        session,
        "failed",
        `${provider.name} sign-in exited before authentication completed`,
        {
          error: trimOutputPreview(session.outputPreview) || `${provider.name} login exited with code ${session.exitCode}`
        }
      );
      return;
    }

    updateAuthSession(session, {
      status: "running",
      message: session.authorizationUrl
        ? `Complete ${provider.name} sign-in in the browser`
        : `${provider.name} started a browser sign-in flow`
    });
  });

  session.pollTimer = setInterval(() => {
    refreshAuthSessionState(session).catch((error) => {
      finalizeAuthSession(session, "failed", `Could not verify ${provider.name} sign-in`, {
        error: String(error.message || error),
        outputPreview: trimOutputPreview(`${session.outputPreview}\n${error.message}`)
      });
    });
  }, AUTH_SESSION_POLL_MS);

  await refreshAuthSessionState(session);
  return serializeAuthSession(session);
}

function extractToolCallsFromResponse(rawOutput) {
  const text = stripAnsi(rawOutput);

  try {
    const parsed = extractFirstJsonObject(text);
    if (parsed && parsed.tool_use) {
      return Array.isArray(parsed.tool_use) ? parsed.tool_use : [parsed.tool_use];
    }
  } catch (error) {
    // Ignore parse errors and fall back to no tool calls.
  }

  return [];
}

function normalizeToolInput(toolName, rawInput) {
  if (!rawInput || typeof rawInput === "undefined") {
    return {};
  }

  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      return {};
    }

    try {
      const parsed = extractFirstJsonObject(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      // Fall back to a tool-specific coercion below.
    }

    if (toolName === "search_entities") {
      return { pattern: trimmed };
    }

    return {};
  }

  if (typeof rawInput === "object" && !Array.isArray(rawInput)) {
    return rawInput;
  }

  return {};
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall) => {
      const name = String(
        toolCall && (toolCall.name || toolCall.tool || toolCall.tool_name || "")
      ).trim();

      const rawInput = toolCall && typeof toolCall === "object"
        ? (toolCall.input || toolCall.arguments || toolCall.params || {})
        : {};
      const input = normalizeToolInput(name, rawInput);

      return { name, input };
    })
    .filter((toolCall) => toolCall.name)
    .slice(0, MAX_TOOL_RESULTS);
}

function formatToolResults(toolCalls, toolResults) {
  const lines = [
    "Tool results are now available.",
    "Use these results to continue the Flecs query generation.",
    "Return either another tool request object with key tool_use or the final object with keys query, reasoning, warnings."
  ];

  toolResults.forEach((result, index) => {
    const input = toolCalls[index] && toolCalls[index].input
      ? JSON.stringify(toolCalls[index].input)
      : "{}";
    lines.push(
      "",
      `Tool ${index + 1}: ${result.name}(${input})`,
      result.ok ? result.result : `ERROR: ${result.error}`
    );
  });

  return lines.join("\n");
}

async function generateViaOpencode(promptBundle, model, cwd, context, runtime = {}) {
  const serverUrl = getOpencodeServerUrl();
  const selectedModel = parseOpencodeModelRef(model);
  const signal = runtime.signal;
  const onStage = typeof runtime.onStage === "function" ? runtime.onStage : () => {};
  const timeoutMs = runtime.timeout || GENERATION_JOB_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let sessionID = "";

  debugLog("info", "Starting OpenCode generation", {
    server: serverUrl,
    model: model || "default",
    symbolsCount: (context.knownSymbols || []).length
  });

  const abortRemoteSession = async () => {
    if (!sessionID) {
      return;
    }

    try {
      await fetchJson(`${serverUrl}/session/${sessionID}/abort`, {
        method: "POST",
        timeout: OPENCODE_REQUEST_TIMEOUT_MS
      });
      debugLog("info", "OpenCode session aborted", { sessionID });
    } catch (error) {
      debugLog("warn", "Failed to abort OpenCode session", {
        sessionID,
        error: error.message
      });
    }
  };

  if (typeof runtime.setCancel === "function") {
    runtime.setCancel(abortRemoteSession);
  }

  try {
    onStage("Checking OpenCode server", `Connecting to ${serverUrl}`);
    const health = await fetchJson(`${serverUrl}/global/health`, {
      signal,
      timeout: OPENCODE_SERVER_TIMEOUT_MS
    });
    if (!health || !health.healthy) {
      throw new Error(`OpenCode server is not healthy at ${serverUrl}`);
    }

    onStage("Creating OpenCode session", selectedModel
      ? `Using ${selectedModel.providerID}/${selectedModel.modelID}`
      : "Using the server default model");
    const sessionResponse = await fetchJson(`${serverUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal,
      timeout: OPENCODE_REQUEST_TIMEOUT_MS
    });

    sessionID = sessionResponse.id;
    if (!sessionID) {
      throw new Error("OpenCode server did not return a session id");
    }

    debugLog("info", "OpenCode session created", { sessionID });

    async function runPrompt(text, step) {
      onStage("Dispatching prompt", step > 0
        ? `Sent tool results back to OpenCode (step ${step + 1})`
        : "OpenCode accepted the query request");

      const promptRequest = {
        system: promptBundle.system,
        tools: OPENCODE_DISABLED_TOOLS,
        parts: [{ type: "text", text }]
      };

      if (selectedModel) {
        promptRequest.model = selectedModel;
      }

      await fetchJson(`${serverUrl}/session/${sessionID}/prompt_async`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(promptRequest),
        signal,
        timeout: OPENCODE_REQUEST_TIMEOUT_MS
      });

      let lastStage = "";

      while (Date.now() < deadline) {
        if (signal && signal.aborted) {
          throw signal.reason || createAbortError("Generation cancelled");
        }

        const [statuses, messages] = await Promise.all([
          fetchJson(`${serverUrl}/session/status`, {
            signal,
            timeout: OPENCODE_REQUEST_TIMEOUT_MS
          }),
          fetchJson(`${serverUrl}/session/${sessionID}/message?limit=1`, {
            signal,
            timeout: OPENCODE_REQUEST_TIMEOUT_MS
          })
        ]);

        const sessionStatus = statuses ? statuses[sessionID] : undefined;
        const latestMessage = Array.isArray(messages) ? messages[0] : undefined;
        const completedMessage = findCompletedOpencodeMessage(messages);

        if (sessionStatus && sessionStatus.type === "busy") {
          lastStage = "Waiting for OpenCode";
          onStage(lastStage, selectedModel
            ? `Model ${selectedModel.providerID}/${selectedModel.modelID} is generating a reply`
            : "OpenCode is generating a reply");
        } else if (latestMessage && Array.isArray(latestMessage.parts) && latestMessage.parts.length) {
          lastStage = "Receiving response";
          onStage(lastStage, "OpenCode has started returning the answer");
        } else if (!lastStage) {
          lastStage = "Waiting for OpenCode";
          onStage(lastStage, "Waiting for the first response chunk");
        }

        if (completedMessage) {
          const messageError = extractOpencodeMessageError(completedMessage);
          if (messageError) {
            throw new Error(`OpenCode returned an error: ${messageError}`);
          }

          const responseText = extractOpencodeTextParts(completedMessage);
          if (!responseText) {
            throw new Error("OpenCode response did not contain any text");
          }

          debugLog("debug", "OpenCode response text extracted", {
            sessionID,
            textLength: responseText.length,
            preview: responseText.slice(0, 200)
          });

          return {
            text: responseText,
            completedMessage
          };
        }

        await sleep(GENERATION_JOB_POLL_MS, signal);
      }

      throw createTimeoutError(`OpenCode did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
    }

    let promptText = promptBundle.user;

    for (let toolStep = 0; toolStep <= MAX_PROVIDER_TOOL_STEPS; toolStep ++) {
      const reply = await runPrompt(promptText, toolStep);
      const toolCalls = normalizeToolCalls(extractToolCallsFromResponse(reply.text));

      if (!toolCalls.length) {
        onStage("Parsing response", "Reading the generated Flecs query");

        try {
          const parsed = normalizeQueryResponse(extractFirstJsonObject(reply.text));
          return {
            ...parsed,
            resolvedModel: reply.completedMessage.info && reply.completedMessage.info.providerID && reply.completedMessage.info.modelID
              ? `${reply.completedMessage.info.providerID}/${reply.completedMessage.info.modelID}`
              : (model || "")
          };
        } catch (error) {
          debugLog("warn", "Failed to parse OpenCode JSON response", {
            sessionID,
            error: error.message
          });

          return {
            query: reply.text.split("\n")[0].trim(),
            reasoning: "Generated by OpenCode server",
            warnings: ["Could not parse structured response"],
            resolvedModel: reply.completedMessage.info && reply.completedMessage.info.providerID && reply.completedMessage.info.modelID
              ? `${reply.completedMessage.info.providerID}/${reply.completedMessage.info.modelID}`
              : (model || "")
          };
        }
      }

      if (toolStep >= MAX_PROVIDER_TOOL_STEPS) {
        throw new Error(`OpenCode requested too many tool rounds (limit ${MAX_PROVIDER_TOOL_STEPS})`);
      }

      onStage("Running discovery tools", `Executing ${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}`);
      const toolResults = toolCalls.map((toolCall) => {
        const result = executeToolCall(toolCall.name, toolCall.input, context);
        debugLog("info", "Executed query discovery tool", {
          name: toolCall.name,
          input: toolCall.input,
          ok: result.ok
        });
        return {
          name: toolCall.name,
          ...result
        };
      });

      promptText = formatToolResults(toolCalls, toolResults);
    }
  } catch (error) {
    if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      await abortRemoteSession();
    }

    debugLog("error", "OpenCode request failed", {
      error: error.message,
      sessionID
    });
    throw error;
  }
}

async function fetchJson(url, options = {}) {
  const {
    timeout = 0,
    signal,
    ...fetchOptions
  } = options;

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId = 0;

  const abortFromSignal = () => {
    controller.abort(signal && signal.reason ? signal.reason : createAbortError());
  };

  if (signal) {
    if (signal.aborted) {
      abortFromSignal();
    } else {
      signal.addEventListener("abort", abortFromSignal, { once: true });
    }
  }

  if (timeout > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(createTimeoutError(`Request timed out after ${timeout}ms`));
    }, timeout);
  }

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });
    const text = await response.text();

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      payload = { raw: text };
    }

    if (!response.ok) {
      throw new Error(payload.error && payload.error.message ? payload.error.message : text || `HTTP ${response.status}`);
    }

    return payload;
  } catch (error) {
    if (timedOut) {
      throw createTimeoutError(`Request timed out after ${timeout}ms`);
    }
    if (signal && signal.aborted) {
      throw signal.reason || createAbortError();
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (signal) {
      signal.removeEventListener("abort", abortFromSignal);
    }
  }
}

async function generateViaClaude() {
  throw new Error("Claude CLI generation is not implemented in this branch");
}

async function generateViaCodex() {
  throw new Error("Codex CLI generation is not implemented in this branch");
}

async function generateViaOpenAI(promptBundle, configEntry, context, runtime = {}) {
  const signal = runtime.signal;
  const onStage = typeof runtime.onStage === "function" ? runtime.onStage : () => {};

  if (!configEntry.apiKey) {
    throw new Error("OpenAI API key is not configured");
  }
  if (!configEntry.model) {
    throw new Error("OpenAI model is not configured");
  }

  onStage("Calling OpenAI API", `Generating with ${configEntry.model}`);
  const payload = await fetchJson("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${configEntry.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: configEntry.model,
      input: [
        {
          role: "developer",
          content: promptBundle.system
        },
        {
          role: "user",
          content: promptBundle.user
        }
      ]
    }),
    signal,
    timeout: GENERATION_JOB_TIMEOUT_MS
  });

  const text = payload.output_text || findStringWithJson(payload.output) || findStringWithJson(payload);
  if (!text) {
    throw new Error("OpenAI response did not contain a query payload");
  }

  return normalizeQueryResponse(extractFirstJsonObject(text));
}

async function generateViaAnthropic(promptBundle, configEntry, context, runtime = {}) {
  const signal = runtime.signal;
  const onStage = typeof runtime.onStage === "function" ? runtime.onStage : () => {};

  if (!configEntry.apiKey) {
    throw new Error("Anthropic API key is not configured");
  }
  if (!configEntry.model) {
    throw new Error("Anthropic model is not configured");
  }

  onStage("Calling Anthropic API", `Generating with ${configEntry.model}`);
  const payload = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": configEntry.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: configEntry.model,
      max_tokens: 800,
      system: promptBundle.system,
      messages: [
        {
          role: "user",
          content: promptBundle.user
        }
      ]
    }),
    signal,
    timeout: GENERATION_JOB_TIMEOUT_MS
  });

  const textBlocks = Array.isArray(payload.content)
    ? payload.content
        .filter((item) => item && item.type === "text")
        .map((item) => item.text)
        .join("\n")
    : "";
  const text = textBlocks || findStringWithJson(payload);
  if (!text) {
    throw new Error("Anthropic response did not contain a query payload");
  }

  return normalizeQueryResponse(extractFirstJsonObject(text));
}

async function generateQuery(body, runtime = {}) {
  const startTime = Date.now();
  const onStage = typeof runtime.onStage === "function" ? runtime.onStage : () => {};
  debugLog("info", "Generate query request received", { 
    providerId: body.providerId,
    prompt: body.prompt,
    model: body.model,
    knownSymbolsCount: body.knownSymbols?.length || 0
  });
  
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const provider = PROVIDERS[body.providerId];
  if (!provider) {
    throw new Error("Unknown provider");
  }

  onStage("Building prompt", "Preparing explorer context for generation");
  const config = loadBridgeConfig(CONFIG_PATH);
  const promptBundle = buildQueryPrompt({
    prompt,
    currentQuery: body.currentQuery,
    selectedEntity: body.selectedEntity,
    host: body.host,
    knownSymbols: body.knownSymbols,
    conversation: body.conversation,
    executionFeedback: body.executionFeedback
  });

  debugLog("debug", "Prompt bundle created", {
    systemPromptLength: promptBundle.system.length,
    userPromptLength: promptBundle.user.length
  });

  let result;
  let model = String(body.model || "").trim();

  const context = {
    knownSymbols: body.knownSymbols || [],
    host: body.host,
    selectedEntity: body.selectedEntity,
    currentQuery: body.currentQuery
  };

  try {
    if (provider.id === "claude-cli") {
      onStage("Calling Claude CLI", "Starting provider generation");
      result = await generateViaClaude(promptBundle, context, runtime);
      model = model || "cli-default";
    } else if (provider.id === "codex-cli") {
      onStage("Calling Codex CLI", "Starting provider generation");
      result = await generateViaCodex(promptBundle, model, body.cwd, context, runtime);
      model = model || "cli-default";
    } else if (provider.id === "opencode-cli") {
      result = await generateViaOpencode(promptBundle, model, body.cwd, context, runtime);
      model = result.resolvedModel || model || "server-default";
    } else if (provider.id === "openai-api") {
      const entry = config.providers.openai || {};
      result = await generateViaOpenAI(promptBundle, entry, context, runtime);
      model = entry.model || model;
    } else if (provider.id === "anthropic-api") {
      const entry = config.providers.anthropic || {};
      result = await generateViaAnthropic(promptBundle, entry, context, runtime);
      model = entry.model || model;
    } else {
      throw new Error("Provider does not support query generation");
    }

    delete result.resolvedModel;

    const duration = Date.now() - startTime;
    debugLog("info", "Query generation completed", {
      provider: provider.id,
      model,
      duration: `${duration}ms`,
      resultQuery: result.query,
      resultWarnings: result.warnings?.length || 0
    });

    return {
      ...result,
      provider: provider.id,
      providerName: provider.name,
      model
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    debugLog("error", "Query generation failed", {
      provider: provider.id,
      model,
      duration: `${duration}ms`,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

function updateApiProviderConfig(providerId, body) {
  const key = providerConfigKey(providerId);
  if (!key) {
    throw new Error("Provider does not support API key configuration");
  }

  const config = loadBridgeConfig(CONFIG_PATH);
  const apiKey = String(body.apiKey || "").trim();
  const model = String(body.model || "").trim();
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (!model) {
    throw new Error("Model is required");
  }

  config.providers[key] = {
    apiKey,
    model
  };
  saveBridgeConfig(CONFIG_PATH, config);

  return getApiProviderStatus(PROVIDERS[providerId], config);
}

function deleteApiProviderConfig(providerId) {
  const key = providerConfigKey(providerId);
  if (!key) {
    throw new Error("Provider does not support API key configuration");
  }

  const config = loadBridgeConfig(CONFIG_PATH);
  config.providers[key] = {
    apiKey: "",
    model: ""
  };
  saveBridgeConfig(CONFIG_PATH, config);

  return getApiProviderStatus(PROVIDERS[providerId], config);
}

async function runGenerationJob(job, body) {
  const runtime = {
    signal: job.abortController.signal,
    timeout: GENERATION_JOB_TIMEOUT_MS,
    onStage(stage, detail) {
      setGenerationJobStage(job, stage, detail);
    },
    setCancel(cancel) {
      job.cancel = cancel;
    }
  };

  try {
    setGenerationJobStage(job, "Starting generation", `Using ${job.providerName}`);
    const result = await generateQuery(body, runtime);
    finalizeGenerationJob(job, "completed", {
      stage: "Completed",
      stageDetail: "Generated query is ready",
      model: result.model || job.model,
      result
    });
    appendGenerationJobEvent(job, "Completed: Generated query is ready");
  } catch (error) {
    if (isTerminalGenerationJobStatus(job.status)) {
      return job;
    }

    if (error && error.name === "AbortError") {
      finalizeGenerationJob(job, "cancelled", {
        stage: "Cancelled",
        stageDetail: error.message || "Generation cancelled",
        error: ""
      });
      return job;
    }

    finalizeGenerationJob(job, "failed", {
      stage: error && error.name === "TimeoutError" ? "Timed out" : "Failed",
      stageDetail: String(error && error.message ? error.message : error),
      error: String(error && error.message ? error.message : error)
    });
    appendGenerationJobEvent(job, `Failed: ${job.error}`, "error");
  } finally {
    job.cancel = undefined;
  }

  return job;
}

function startGenerationJob(body) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const provider = PROVIDERS[body.providerId];
  if (!provider) {
    throw new Error("Unknown provider");
  }

  const job = createGenerationJob({
    providerId: provider.id,
    providerName: provider.name,
    model: String(body.model || "").trim()
  });

  runGenerationJob(job, body).catch((error) => {
    if (!isTerminalGenerationJobStatus(job.status)) {
      finalizeGenerationJob(job, "failed", {
        stage: "Failed",
        stageDetail: String(error && error.message ? error.message : error),
        error: String(error && error.message ? error.message : error)
      });
      appendGenerationJobEvent(job, `Failed: ${job.error}`, "error");
    }
  });

  return job;
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url, "http://127.0.0.1");

  try {
    if (req.method === "GET" && url.pathname === "/v1/health") {
      sendJson(res, 200, {
        ok: true,
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        configPath: CONFIG_PATH,
        platform: process.platform
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/providers") {
      const providers = await listProviders(loadBridgeConfig(CONFIG_PATH));
      sendJson(res, 200, {
        providers
      });
      return;
    }

    const authSessionMatch = url.pathname.match(/^\/v1\/auth-sessions\/([^/]+)$/);
    if (authSessionMatch && req.method === "GET") {
      const session = getAuthSession(authSessionMatch[1]);
      await refreshAuthSessionState(session);
      sendJson(res, 200, {
        session: serializeAuthSession(session)
      });
      return;
    }

    const generationJobMatch = url.pathname.match(/^\/v1\/generation-jobs\/([^/]+)$/);
    if (generationJobMatch && req.method === "GET") {
      const job = getGenerationJob(generationJobMatch[1]);
      sendJson(res, 200, {
        job: serializeGenerationJob(job)
      });
      return;
    }

    if (generationJobMatch && req.method === "DELETE") {
      const job = getGenerationJob(generationJobMatch[1]);
      await cancelGenerationJob(job, "Generation cancelled by the user");
      sendJson(res, 200, {
        job: serializeGenerationJob(job)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/generation-jobs") {
      const body = await readRequestBody(req);
      const job = startGenerationJob(body);
      sendJson(res, 202, {
        job: serializeGenerationJob(job)
      });
      return;
    }

    const providerMatch = url.pathname.match(/^\/v1\/providers\/([^/]+)\/(api-key|login|browser-oauth)$/);
    if (providerMatch) {
      const providerId = providerMatch[1];
      const action = providerMatch[2];

      if (action === "api-key" && req.method === "POST") {
        const body = await readRequestBody(req);
        const provider = updateApiProviderConfig(providerId, body);
        sendJson(res, 200, { provider });
        return;
      }

      if (action === "api-key" && req.method === "DELETE") {
        const provider = deleteApiProviderConfig(providerId);
        sendJson(res, 200, { provider });
        return;
      }

      if (action === "login" && req.method === "POST") {
        const launch = await launchLogin(providerId);
        sendJson(res, 200, launch);
        return;
      }

      if (action === "browser-oauth" && req.method === "POST") {
        const session = await startBrowserOauth(providerId);
        sendJson(res, 200, { session });
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/generate-query") {
      const body = await readRequestBody(req);
      const result = await generateQuery(body, {
        timeout: GENERATION_JOB_TIMEOUT_MS
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/opencode/models") {
      try {
        const opencodeUrl = getOpencodeServerUrl();
        const response = await fetchJson(`${opencodeUrl}/config/providers`, {
          timeout: OPENCODE_REQUEST_TIMEOUT_MS
        });
        
        // Extract models from the response
        const models = [];
        const defaults = response.default || {};
        if (response.providers) {
          for (const provider of response.providers) {
            if (provider.models) {
              for (const [modelId, modelInfo] of Object.entries(provider.models)) {
                models.push({
                  id: `${provider.id}/${modelId}`,
                  providerId: provider.id,
                  modelId,
                  name: modelInfo.name || modelId,
                  label: `${provider.name} / ${modelInfo.name || modelId}`,
                  family: modelInfo.family || "unknown",
                  isDefault: defaults[provider.id] === modelId
                });
              }
            }
          }
        }

        models.sort((left, right) => {
          if (left.isDefault && !right.isDefault) {
            return -1;
          }
          if (!left.isDefault && right.isDefault) {
            return 1;
          }
          return left.label.localeCompare(right.label);
        });

        sendJson(res, 200, {
          serverUrl: opencodeUrl,
          models
        });
      } catch (error) {
        sendError(res, 500, error);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/debug/logs") {
      // Pre-process logs to avoid using functions in template literals
      const logEntries = DEBUG_LOGS.slice().reverse().map(entry => {
        const escapedMessage = escapeHtml(entry.message);
        const escapedData = entry.data ? escapeHtml(typeof entry.data === 'object' ? JSON.stringify(entry.data, null, 2) : entry.data) : null;
        
        return {
          level: entry.level,
          timestamp: entry.timestamp,
          message: escapedMessage,
          data: escapedData
        };
      });
      
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>AI Bridge Debug Logs</title>
  <style>
    body {
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
      background: #1e1e1e;
      color: #d4d4d4;
      margin: 0;
      padding: 20px;
    }
    h1 {
      color: #4ec9b0;
      margin-top: 0;
    }
    .controls {
      margin-bottom: 20px;
    }
    button {
      background: #0e639c;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 8px;
    }
    button:hover {
      background: #1177bb;
    }
    .stats {
      background: #252526;
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 20px;
    }
    .log-entry {
      background: #252526;
      margin-bottom: 8px;
      padding: 12px;
      border-radius: 4px;
      border-left: 3px solid #0e639c;
    }
    .log-entry.log-info { border-left-color: #0e639c; }
    .log-entry.log-warn { border-left-color: #cca700; }
    .log-entry.log-error { border-left-color: #f48771; }
    .log-timestamp {
      color: #858585;
      font-size: 0.85em;
    }
    .log-level {
      font-weight: bold;
      text-transform: uppercase;
      margin: 0 8px;
    }
    .log-level.log-info { color: #4ec9b0; }
    .log-level.log-warn { color: #cca700; }
    .log-level.log-error { color: #f48771; }
    .log-message {
      color: #d4d4d4;
      margin-top: 8px;
    }
    .log-data {
      background: #1e1e1e;
      padding: 8px;
      margin-top: 8px;
      border-radius: 4px;
      white-space: pre-wrap;
      word-wrap: break-word;
      color: #9cdcfe;
    }
    .refresh-notice {
      color: #858585;
      font-style: italic;
    }
  </style>
</head>
<body>
  <h1>AI Bridge Debug Logs</h1>
  
  <div class="controls">
    <button onclick="location.reload()">Refresh</button>
    <button onclick="fetch('/v1/debug/logs/clear', {method: 'POST'}).then(() => location.reload())">Clear Logs</button>
    <button onclick="toggleAutoRefresh()">Toggle Auto-Refresh (2s)</button>
    <span class="refresh-notice" id="auto-refresh-status"></span>
  </div>
  
  <div class="stats">
    <strong>Total Logs:</strong> ${DEBUG_LOGS.length} / ${MAX_DEBUG_LOGS}
  </div>
  
  <div id="logs">
    ${logEntries.map(entry => `
      <div class="log-entry log-${entry.level}">
        <div>
          <span class="log-timestamp">${entry.timestamp}</span>
          <span class="log-level log-${entry.level}">${entry.level}</span>
        </div>
        <div class="log-message">${entry.message}</div>
        ${entry.data ? `<div class="log-data">${entry.data}</div>` : ''}
      </div>
    `).join('')}
  </div>
  
  <script>
    let autoRefreshInterval = null;
    
    function toggleAutoRefresh() {
      if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        document.getElementById('auto-refresh-status').textContent = '';
      } else {
        autoRefreshInterval = setInterval(() => location.reload(), 2000);
        document.getElementById('auto-refresh-status').textContent = 'Auto-refreshing every 2s';
      }
    }
  </script>
</body>
</html>`;
      
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/debug/logs/clear") {
      DEBUG_LOGS.length = 0;
      sendJson(res, 200, { ok: true, message: "Logs cleared" });
      return;
    }

    sendError(res, 404, "Route not found");
  } catch (error) {
    sendError(res, 400, error);
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendError(res, 500, error);
  });
});

server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
  console.log(
    `flecs explorer ai bridge listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`
  );
  console.log(`config: ${CONFIG_PATH}`);
});
