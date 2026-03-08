#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile, spawn, spawnSync } = require("child_process");

const {
  buildQueryPrompt,
  extractDeviceCode,
  extractFirstJsonObject,
  extractFirstUrl,
  findStringWithJson,
  getBridgeConfigPath,
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
const AUTH_SESSIONS = new Map();

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
  return {
    ...provider,
    installed: true,
    ready: parsed.ready,
    status: parsed.ready ? "ready" : "needs_auth",
    message: parsed.ready
      ? `${parsed.credentialCount} configured credential${parsed.credentialCount === 1 ? "" : "s"}`
      : "OpenCode CLI needs sign-in",
    details: parsed,
    command: provider.loginCommand.join(" "),
    binaryPath
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

async function generateViaClaude(promptBundle) {
  const fullPrompt = `${promptBundle.system}\n\n${promptBundle.user}`;
  const result = await runCommand("claude", [
    "-p",
    "--tools",
    "",
    "--json-schema",
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["query", "reasoning", "warnings"],
      properties: {
        query: { type: "string" },
        reasoning: { type: "string" },
        warnings: {
          type: "array",
          items: { type: "string" }
        }
      }
    }),
    fullPrompt
  ], {
    timeout: 120000
  });

  if (!result.ok) {
    throw new Error(summarizeError("Claude query generation failed", result));
  }

  return normalizeQueryResponse(extractFirstJsonObject(result.stdout));
}

async function generateViaCodex(promptBundle, model, cwd) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flecs-query-codex-"));
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "output.json");
  const fullPrompt = `${promptBundle.system}\n\n${promptBundle.user}`;

  fs.writeFileSync(schemaPath, JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["query", "reasoning", "warnings"],
    properties: {
      query: { type: "string" },
      reasoning: { type: "string" },
      warnings: {
        type: "array",
        items: { type: "string" }
      }
    }
  }));

  const args = ["--ask-for-approval", "never"];
  if (model) {
    args.push("--model", model);
  }

  args.push(
    "exec",
    "--skip-git-repo-check",
    "-C", cwd || process.cwd(),
    "--sandbox", "read-only",
    "--output-schema", schemaPath,
    "-o", outputPath,
    fullPrompt
  );

  const result = await runCommand("codex", args, {
    timeout: 120000
  });

  let payload = "";
  if (fs.existsSync(outputPath)) {
    payload = fs.readFileSync(outputPath, "utf8");
  }

  fs.rmSync(tempDir, { recursive: true, force: true });

  if (!payload && !result.ok) {
    throw new Error(summarizeError("Codex query generation failed", result));
  }

  return normalizeQueryResponse(extractFirstJsonObject(payload || result.stdout));
}

async function generateViaOpencode(promptBundle, model, cwd) {
  const fullPrompt = `${promptBundle.system}\n\n${promptBundle.user}`;
  const args = ["run", "--format", "json"];

  if (model) {
    args.push("--model", model);
  }

  if (cwd) {
    args.push("--dir", cwd);
  }

  args.push(fullPrompt);

  const result = await runCommand("opencode", args, {
    timeout: 120000
  });

  if (!result.ok) {
    throw new Error(summarizeError("OpenCode query generation failed", result));
  }

  const raw = stripAnsi(result.stdout);
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const candidate = findStringWithJson(parsed);
      if (candidate) {
        return normalizeQueryResponse(extractFirstJsonObject(candidate));
      }
    } catch (error) {
      // Ignore non-JSON lines.
    }
  }

  return normalizeQueryResponse(extractFirstJsonObject(raw));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
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
}

async function generateViaOpenAI(promptBundle, configEntry) {
  if (!configEntry.apiKey) {
    throw new Error("OpenAI API key is not configured");
  }
  if (!configEntry.model) {
    throw new Error("OpenAI model is not configured");
  }

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
    })
  });

  const text = payload.output_text || findStringWithJson(payload.output) || findStringWithJson(payload);
  if (!text) {
    throw new Error("OpenAI response did not contain a query payload");
  }

  return normalizeQueryResponse(extractFirstJsonObject(text));
}

async function generateViaAnthropic(promptBundle, configEntry) {
  if (!configEntry.apiKey) {
    throw new Error("Anthropic API key is not configured");
  }
  if (!configEntry.model) {
    throw new Error("Anthropic model is not configured");
  }

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
    })
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

async function generateQuery(body) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const provider = PROVIDERS[body.providerId];
  if (!provider) {
    throw new Error("Unknown provider");
  }

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

  let result;
  let model = String(body.model || "").trim();

  if (provider.id === "claude-cli") {
    result = await generateViaClaude(promptBundle);
    model = model || "cli-default";
  } else if (provider.id === "codex-cli") {
    result = await generateViaCodex(promptBundle, model, body.cwd);
    model = model || "cli-default";
  } else if (provider.id === "opencode-cli") {
    result = await generateViaOpencode(promptBundle, model, body.cwd);
    model = model || "cli-default";
  } else if (provider.id === "openai-api") {
    const entry = config.providers.openai || {};
    result = await generateViaOpenAI(promptBundle, entry);
    model = entry.model || model;
  } else if (provider.id === "anthropic-api") {
    const entry = config.providers.anthropic || {};
    result = await generateViaAnthropic(promptBundle, entry);
    model = entry.model || model;
  } else {
    throw new Error("Provider does not support query generation");
  }

  return {
    ...result,
    provider: provider.id,
    providerName: provider.name,
    model
  };
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
      const result = await generateQuery(body);
      sendJson(res, 200, result);
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
