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
const MAX_TOOL_RESULTS = 8;
const AUTH_SESSIONS = new Map();
const OPENCODE_SESSION_CACHE = new Map();
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

function extractToolCallsFromResponse(rawOutput) {
  const text = stripAnsi(rawOutput);
  const toolCalls = [];

  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.tool_use) {
      toolCalls.push(...(Array.isArray(parsed.tool_use) ? parsed.tool_use : [parsed.tool_use]));
    }
  } catch (error) {
    // Try to find tool calls in the text
    const toolUseMatch = text.match(/"tool_use"\s*:\s*\[/);
    if (toolUseMatch) {
      try {
        const jsonMatch = text.slice(toolUseMatch.index).match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed && parsed.tool_use) {
            toolCalls.push(...(Array.isArray(parsed.tool_use) ? parsed.tool_use : [parsed.tool_use]));
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  return toolCalls;
}

async function generateViaOpencode(promptBundle, model, cwd, context) {
  const OPENCODE_SERVER = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
  
  debugLog("info", "Starting OpenCode generation", { 
    server: OPENCODE_SERVER, 
    model: model || "default",
    symbolsCount: (context.knownSymbols || []).length 
  });
  
  async function createNewSession() {
    debugLog("info", "Creating new OpenCode session");
    const sessionResponse = await fetchJson(`${OPENCODE_SERVER}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    
    const sessionID = sessionResponse.id;
    OPENCODE_SESSION_CACHE.set(OPENCODE_SERVER, sessionID);
    debugLog("info", "OpenCode session created", { sessionID });
    return sessionID;
  }
  
  // Reuse or create session (cache by server URL)
  let sessionID = OPENCODE_SESSION_CACHE.get(OPENCODE_SERVER);
  
  if (!sessionID) {
    debugLog("info", "No cached session, creating new one");
    sessionID = await createNewSession();
  } else {
    debugLog("info", "Using cached session", { sessionID });
  }
  
  // Prepare the message
  const fullPrompt = `${promptBundle.system}\n\n${promptBundle.user}\n\nAvailable components: ${(context.knownSymbols || []).slice(0, 20).join(", ")}`;
  const promptLength = fullPrompt.length;
  
  debugLog("info", "Sending message to OpenCode", { 
    sessionID, 
    promptLength,
    userPrompt: promptBundle.user 
  });
  
  // Send message and wait for response
  try {
    const startTime = Date.now();
    const messageResponse = await fetchJson(`${OPENCODE_SERVER}/session/${sessionID}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: fullPrompt }]
      })
    });
    const elapsed = Date.now() - startTime;
    
    debugLog("info", "OpenCode response received", { 
      elapsed: `${elapsed}ms`,
      partsCount: (messageResponse.parts || []).length 
    });
    
    // Extract text from response parts
    const textParts = (messageResponse.parts || [])
      .filter(part => part && part.type === "text")
      .map(part => part.text)
      .join("\n");
    
    debugLog("debug", "Response text extracted", { 
      textLength: textParts.length,
      preview: textParts.substring(0, 200)
    });
    
    // Try to parse as JSON
    try {
      const parsed = normalizeQueryResponse(extractFirstJsonObject(textParts));
      debugLog("info", "Successfully parsed response", { query: parsed.query });
      return parsed;
    } catch (error) {
      debugLog("warn", "Failed to parse JSON, using raw text", { error: error.message });
      return {
        query: textParts.trim().split("\n")[0] || "",
        reasoning: "Generated by OpenCode server",
        warnings: ["Could not parse structured response"]
      };
    }
  } catch (error) {
    debugLog("error", "OpenCode request failed", { 
      error: error.message,
      sessionID 
    });
    
    // If session is invalid, create a new one and retry once
    if (error.message && (error.message.includes("404") || error.message.includes("not found"))) {
      debugLog("info", "Session invalid, creating new one and retrying");
      OPENCODE_SESSION_CACHE.delete(OPENCODE_SERVER);
      sessionID = await createNewSession();
      
      const startTime = Date.now();
      const messageResponse = await fetchJson(`${OPENCODE_SERVER}/session/${sessionID}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: fullPrompt }]
        })
      });
      const elapsed = Date.now() - startTime;
      
      debugLog("info", "Retry successful", { elapsed: `${elapsed}ms` });
      
      const textParts = (messageResponse.parts || [])
        .filter(part => part && part.type === "text")
        .map(part => part.text)
        .join("\n");
      
      try {
        const parsed = normalizeQueryResponse(extractFirstJsonObject(textParts));
        debugLog("info", "Successfully parsed retry response", { query: parsed.query });
        return parsed;
      } catch (error) {
        debugLog("warn", "Failed to parse retry response", { error: error.message });
        return {
          query: textParts.trim().split("\n")[0] || "",
          reasoning: "Generated by OpenCode server",
          warnings: ["Could not parse structured response"]
        };
      }
    }
    
    throw error;
  }
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

async function generateViaOpenAI(promptBundle, configEntry, context) {
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

async function generateViaAnthropic(promptBundle, configEntry, context) {
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
  const startTime = Date.now();
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
      result = await generateViaClaude(promptBundle, context);
      model = model || "cli-default";
    } else if (provider.id === "codex-cli") {
      result = await generateViaCodex(promptBundle, model, body.cwd, context);
      model = model || "cli-default";
    } else if (provider.id === "opencode-cli") {
      result = await generateViaOpencode(promptBundle, model, body.cwd, context);
      model = model || "cli-default";
    } else if (provider.id === "openai-api") {
      const entry = config.providers.openai || {};
      result = await generateViaOpenAI(promptBundle, entry, context);
      model = entry.model || model;
    } else if (provider.id === "anthropic-api") {
      const entry = config.providers.anthropic || {};
      result = await generateViaAnthropic(promptBundle, entry, context);
      model = entry.model || model;
    } else {
      throw new Error("Provider does not support query generation");
    }

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

    if (req.method === "GET" && url.pathname === "/v1/opencode/models") {
      try {
        const opencodeUrl = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
        const response = await fetchJson(`${opencodeUrl}/config/providers`);
        
        // Extract models from the response
        const models = [];
        if (response.providers) {
          for (const provider of response.providers) {
            if (provider.models) {
              for (const [modelId, modelInfo] of Object.entries(provider.models)) {
                models.push({
                  id: modelId,
                  providerId: provider.id,
                  name: modelInfo.name || modelId,
                  family: modelInfo.family || "unknown"
                });
              }
            }
          }
        }
        
        sendJson(res, 200, { models });
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
