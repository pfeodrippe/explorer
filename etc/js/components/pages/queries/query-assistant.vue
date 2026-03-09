<template>
  <div id="query-assistant" class="pane">
    <div class="assistant-scroll">
      <section class="assistant-section">
        <div class="assistant-row assistant-row-header">
          <div>
            <div class="assistant-title">AI Query Assistant</div>
            <div class="assistant-subtitle">
              Connect a local provider bridge, choose a model source, then turn plain-English intent into Flecs queries.
            </div>
          </div>
          <button @click="refreshBridge" :disabled="bridgeLoading">
            {{ bridgeLoading ? "Checking..." : "Refresh" }}
          </button>
        </div>

        <label class="assistant-label" for="assistant-bridge-url">Bridge URL</label>
        <div class="assistant-row">
          <input
            id="assistant-bridge-url"
            type="text"
            v-model="bridgeUrl"
            @change="persistBridgeUrl"
            placeholder="http://127.0.0.1:27891">
          <button @click="refreshBridge">Check</button>
        </div>

        <div class="assistant-status" :class="bridgeStatusClass">
          {{ bridgeStatusMessage }}
        </div>

        <pre v-if="!bridgeHealthy" class="assistant-command">cd ../flecs-explorer
npm run bridge</pre>
      </section>

      <section class="assistant-section">
        <div class="assistant-title assistant-title-small">Generate</div>
        <label class="assistant-label" for="assistant-prompt">Intent</label>
        <textarea
          id="assistant-prompt"
          v-model="prompt"
          rows="6"
          placeholder="Examples: find all entities with Position and Velocity, show queries writing Position, find children of Player without Health"
          @keydown.enter="handlePromptKeydown">
        </textarea>
        <div class="provider-help">
          Context sent with the request includes the current query, the selected entity, the active host, and sampled component/query symbols when available. Press Enter to submit (Shift+Enter for new line).
        </div>

        <div class="assistant-row assistant-row-generate">
          <toggle v-model="autoRun" css="assistant-auto-run-toggle">Auto Run</toggle>
          <div class="assistant-row">
            <button v-if="agentCanStop" @click="stopAgent">
              Stop
            </button>
            <button @click="generateQuery" :disabled="!canGenerate">
              {{ generateLoading ? "Generating..." : (autoRun ? "Generate and Run Query" : "Generate Query Only") }}
            </button>
          </div>
        </div>

        <div v-if="errorMessage" class="assistant-error">{{ errorMessage }}</div>
      </section>

      <section v-if="agentHasMessages || agentStatusMessage" class="assistant-section">
        <div class="assistant-row assistant-row-header">
          <div class="assistant-title assistant-title-small">Agent</div>
          <button v-if="agentHasMessages" @click="clearConversation" :disabled="agentCanStop">
            Clear
          </button>
        </div>

        <div v-if="agentStatusMessage" class="assistant-status assistant-status-agent">
          {{ agentStatusMessage }}
        </div>

        <div class="assistant-conversation">
          <div
            v-for="message in conversation"
            :key="message.id"
            class="assistant-message"
            :class="`assistant-message-${message.role}`">
            <div class="assistant-message-role">{{ message.role }}</div>
            <pre class="assistant-message-body">{{ message.content }}</pre>
          </div>
        </div>
      </section>

      <section v-if="result" class="assistant-section">
        <div class="assistant-title assistant-title-small">Result</div>
        <div class="assistant-result-meta">
          {{ result.providerName }}<span v-if="result.model"> / {{ result.model }}</span>
        </div>
        <pre class="assistant-query">{{ result.query }}</pre>
        <div v-if="result.reasoning" class="assistant-reasoning">
          {{ result.reasoning }}
        </div>

        <ul v-if="result.warnings && result.warnings.length" class="assistant-warnings">
          <li v-for="warning in result.warnings" :key="warning">{{ warning }}</li>
        </ul>

        <div class="assistant-row">
          <button @click="runResult">Run In Explorer</button>
          <button @click="applyResult">Apply To Editor</button>
          <button @click="copyResult">Copy Query</button>
        </div>
      </section>

      <section class="assistant-section">
        <div class="assistant-title assistant-title-small">Providers</div>
        <div class="provider-grid">
          <button
            v-for="provider in providers"
            :key="provider.id"
            class="provider-card"
            :class="providerCardClass(provider)"
            @click="selectedProviderId = provider.id">
            <div class="provider-card-header">
              <span>{{ provider.name }}</span>
              <span class="provider-pill" :class="provider.status">{{ providerStatusLabel(provider) }}</span>
            </div>
            <div class="provider-card-meta">
              {{ providerAuthMeta(provider) }}
            </div>
            <div class="provider-card-message">
              {{ provider.message }}
            </div>
          </button>
        </div>

        <template v-if="selectedProvider">
          <div class="provider-config">
            <div class="assistant-subtitle">{{ selectedProvider.name }}</div>

            <template v-if="selectedProvider.kind === 'cli'">
              <div class="provider-help">
                {{ providerHelpText(selectedProvider) }}
              </div>
              <pre class="assistant-command">{{ selectedProvider.command }}</pre>

              <div
                v-if="selectedProviderAuthSession"
                class="assistant-auth-session"
                :class="authSessionClass(selectedProviderAuthSession)">
                <div class="assistant-auth-session-header">
                  <span>Browser Sign-In</span>
                  <span>{{ authSessionStatusLabel(selectedProviderAuthSession) }}</span>
                </div>
                <div class="provider-help">{{ selectedProviderAuthSession.message }}</div>
                <div v-if="selectedProviderAuthSession.authorizationCode" class="assistant-auth-code">
                  Use code <code>{{ selectedProviderAuthSession.authorizationCode }}</code> if prompted.
                </div>
                <a
                  v-if="selectedProviderAuthSession.authorizationUrl"
                  class="assistant-auth-link"
                  :href="selectedProviderAuthSession.authorizationUrl"
                  target="_blank"
                  rel="noreferrer">
                  Open authorization page
                </a>
                <pre
                  v-if="selectedProviderAuthSession.outputPreview"
                  class="assistant-command assistant-command-small">{{ selectedProviderAuthSession.outputPreview }}</pre>
              </div>

              <div class="assistant-row">
                <button
                  v-if="selectedProvider.supportsBrowserOauth"
                  @click="startBrowserOauth"
                  :disabled="providerActionLoading || !selectedProvider.installed || authSessionInFlight(selectedProviderAuthSession)">
                  {{ providerActionLoading ? "Starting..." : "Browser OAuth" }}
                </button>
                <button @click="launchLogin" :disabled="providerActionLoading || !selectedProvider.installed">
                  {{ providerActionLoading ? "Opening..." : "Launch Login" }}
                </button>
                <button @click="refreshBridge">Refresh Status</button>
              </div>

              <div v-if="selectedProvider.id === 'opencode-cli'" class="assistant-row assistant-row-model">
                <label class="assistant-label" for="opencode-model">Model</label>
                <select
                  id="opencode-model"
                  v-model="selectedOpencodeModel"
                  @change="persistOpencodeModel"
                  class="assistant-select">
                  <option value="">Default</option>
                  <option v-for="model in opencodeModels" :key="model.id" :value="model.id">
                    {{ model.name }}
                  </option>
                </select>
              </div>
            </template>

            <template v-else>
              <div class="provider-help">
                API keys are stored locally by the bridge at <code>{{ bridgeConfigPath || "the bridge config file" }}</code>. OAuth is not supported for this provider path.
              </div>
              <label class="assistant-label" for="assistant-api-key">API key</label>
              <input
                id="assistant-api-key"
                type="password"
                v-model="apiKey"
                placeholder="Paste API key">

              <label class="assistant-label" for="assistant-api-model">Model</label>
              <input
                id="assistant-api-model"
                type="text"
                v-model="apiModel"
                :placeholder="modelPlaceholder(selectedProvider.id)">

              <div class="assistant-row">
                <button @click="saveApiConfig" :disabled="providerActionLoading">
                  {{ providerActionLoading ? "Saving..." : "Save" }}
                </button>
                <button @click="deleteApiConfig" :disabled="providerActionLoading || !selectedProvider.hasStoredSecret">
                  Remove
                </button>
              </div>
            </template>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script>
export default { name: "query-assistant" };
</script>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  conn: { type: Object, required: true },
  host: { type: String, required: false, default: "" },
  query: { type: String, required: true },
  query_state: { type: Object, required: true },
  query_result_state: {
    type: Object,
    required: false,
    default: () => ({ seq: 0, value: {}, queryExpr: "", useName: false })
  }
});

const emit = defineEmits(["update:query", "run", "apply"]);

const BRIDGE_URL_KEY = "flecs.ai.bridgeUrl";
const PROVIDER_ID_KEY = "flecs.ai.providerId";
const AUTO_RUN_KEY = "flecs.ai.autoRun";
const CONVERSATION_KEY = "flecs.ai.conversation";
const OPENCODE_MODEL_KEY = "flecs.ai.opencodeModel";
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:27891";
const MAX_AGENT_ATTEMPTS = 4;

const bridgeUrl = ref(localStorage.getItem(BRIDGE_URL_KEY) || DEFAULT_BRIDGE_URL);
const bridgeHealthy = ref(false);
const bridgeLoading = ref(false);
const bridgeConfigPath = ref("");
const providers = ref([]);
const selectedProviderId = ref(localStorage.getItem(PROVIDER_ID_KEY) || "");
const providerActionLoading = ref(false);
const generateLoading = ref(false);
const prompt = ref("");
const result = ref(undefined);
const errorMessage = ref("");
const authSession = ref(undefined);
const autoRun = ref(localStorage.getItem(AUTO_RUN_KEY) !== "false");

let savedConversation = [];
try {
  const saved = localStorage.getItem(CONVERSATION_KEY);
  if (saved) {
    savedConversation = JSON.parse(saved);
  }
} catch (error) {
  // Ignore parse errors
}

const conversation = ref(savedConversation);
const agentRunning = ref(false);
const agentStopRequested = ref(false);
const agentStatusMessage = ref("");
const agentAttempt = ref(0);
const awaitingExecution = ref(undefined);
const apiKey = ref("");
const apiModel = ref("");
const knownSymbols = ref([]);
const opencodeModels = ref([]);
const selectedOpencodeModel = ref(localStorage.getItem("flecs.ai.opencodeModel") || "");
let authSessionPollTimer = 0;
let messageId = 0;
let generationController = undefined;

const selectedProvider = computed(() => {
  return providers.value.find((provider) => provider.id === selectedProviderId.value);
});

const selectedProviderAuthSession = computed(() => {
  if (!authSession.value || !selectedProvider.value) {
    return undefined;
  }

  return authSession.value.providerId === selectedProvider.value.id
    ? authSession.value
    : undefined;
});

const agentHasMessages = computed(() => conversation.value.length > 0);
const agentCanStop = computed(() => {
  return generateLoading.value || Boolean(awaitingExecution.value) || agentRunning.value;
});

const canGenerate = computed(() => {
  return bridgeHealthy.value &&
    !generateLoading.value &&
    !awaitingExecution.value &&
    selectedProvider.value &&
    selectedProvider.value.ready &&
    prompt.value.trim().length > 0;
});

const bridgeStatusMessage = computed(() => {
  if (bridgeLoading.value) {
    return "Checking local bridge...";
  }

  if (bridgeHealthy.value) {
    return `Bridge reachable at ${bridgeUrl.value}`;
  }

  return "Bridge unavailable. Start it locally to enable provider auth and query generation.";
});

const bridgeStatusClass = computed(() => {
  return bridgeHealthy.value ? "assistant-status-ok" : "assistant-status-error";
});

function providerStatusLabel(provider) {
  if (provider.status === "ready") {
    return "Ready";
  }
  if (provider.status === "missing") {
    return "Missing";
  }
  if (provider.status === "needs_config") {
    return "Configure";
  }
  return "Sign In";
}

function providerCardClass(provider) {
  return {
    "provider-card-selected": provider.id === selectedProviderId.value,
    "provider-card-ready": provider.status === "ready",
    "provider-card-error": provider.status !== "ready"
  };
}

function providerAuthMeta(provider) {
  if (provider.kind === "api") {
    return "Direct API key";
  }

  return provider.supportsBrowserOauth ? "CLI / Browser OAuth" : "CLI / Terminal sign-in";
}

function providerHelpText(provider) {
  if (!provider) {
    return "";
  }

  if (provider.supportsBrowserOauth) {
    return "Explorer can start the provider browser sign-in flow through the local bridge and track completion. Terminal launch remains available as a fallback.";
  }

  return "Explorer uses the local CLI for generation. This provider still needs its native terminal login flow.";
}

function modelPlaceholder(providerId) {
  if (providerId === "openai-api") {
    return "e.g. gpt-5";
  }
  return "e.g. claude-sonnet-4-5";
}

function persistBridgeUrl() {
  localStorage.setItem(BRIDGE_URL_KEY, bridgeUrl.value.trim() || DEFAULT_BRIDGE_URL);
}

function persistProviderId() {
  if (selectedProviderId.value) {
    localStorage.setItem(PROVIDER_ID_KEY, selectedProviderId.value);
  }
}

function persistAutoRun() {
  localStorage.setItem(AUTO_RUN_KEY, autoRun.value ? "true" : "false");
}

function persistConversation() {
  try {
    localStorage.setItem(CONVERSATION_KEY, JSON.stringify(conversation.value));
  } catch (error) {
    // Ignore storage errors
  }
}

function persistOpencodeModel() {
  if (selectedOpencodeModel.value) {
    localStorage.setItem(OPENCODE_MODEL_KEY, selectedOpencodeModel.value);
  } else {
    localStorage.removeItem(OPENCODE_MODEL_KEY);
  }
}

function appendConversation(role, content, extras = {}) {
  conversation.value = [
    ...conversation.value,
    {
      id: ++messageId,
      role,
      content: String(content || "").trim(),
      ...extras
    }
  ].filter((message) => message.content).slice(-16);
  
  persistConversation();
}

function clearConversation() {
  conversation.value = [];
  agentStatusMessage.value = "";
  localStorage.removeItem(CONVERSATION_KEY);
  agentAttempt.value = 0;
  agentStopRequested.value = false;
}

function stopAgent() {
  agentStopRequested.value = true;
  agentRunning.value = false;

  if (generationController) {
    generationController.abort();
    generationController = undefined;
  }

  agentStatusMessage.value = awaitingExecution.value
    ? "Agent stopped. Waiting for the current explorer run to finish."
    : "Agent stopped.";
}

function formatAssistantMessage(nextResult) {
  const parts = [`Query: ${nextResult.query}`];

  if (nextResult.reasoning) {
    parts.push(`Reasoning: ${nextResult.reasoning}`);
  }

  if (nextResult.warnings && nextResult.warnings.length) {
    parts.push(`Warnings: ${nextResult.warnings.join(" | ")}`);
  }

  return parts.join("\n");
}

function stringifyFeedback(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

function summarizeExecutionFeedback(resultState) {
  if (!resultState || resultState.useName) {
    return undefined;
  }

  const payload = resultState.value;
  if (Array.isArray(payload)) {
    return undefined;
  }

  if (payload && payload.error) {
    return {
      ok: false,
      message: `Explorer rejected query "${resultState.queryExpr}": ${stringifyFeedback(payload.error)}`
    };
  }

  const resultCount = Array.isArray(payload && payload.results)
    ? payload.results.length
    : 0;

  return {
    ok: true,
    message: `Explorer ran query "${resultState.queryExpr}" successfully with ${resultCount} result${resultCount === 1 ? "" : "s"}.`
  };
}

async function bridgeRequest(path, options = {}) {
  const response = await fetch(`${bridgeUrl.value}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function requestAgentQuery(executionFeedback) {
  if (!selectedProvider.value) {
    return;
  }

  generateLoading.value = true;
  errorMessage.value = "";
  generationController = new AbortController();

  try {
    const requestBody = {
      providerId: selectedProvider.value.id,
      prompt: prompt.value,
      currentQuery: props.query,
      selectedEntity: props.query_state.path,
      host: props.host,
      knownSymbols: knownSymbols.value,
      conversation: conversation.value.map((message) => ({
        role: message.role,
        content: message.content
      })),
      executionFeedback
    };

    // Add model for OpenCode CLI
    if (selectedProvider.value.id === "opencode-cli" && selectedOpencodeModel.value) {
      requestBody.model = selectedOpencodeModel.value;
    }

    const nextResult = await bridgeRequest("/v1/generate-query", {
      method: "POST",
      signal: generationController.signal,
      body: JSON.stringify(requestBody)
    });

    result.value = nextResult;
    appendConversation("assistant", formatAssistantMessage(nextResult), {
      query: nextResult.query
    });

    if (autoRun.value && nextResult.query) {
      awaitingExecution.value = {
        query: nextResult.query,
        seq: props.query_result_state ? props.query_result_state.seq : 0
      };
      agentStatusMessage.value = `Running generated query in explorer (attempt ${agentAttempt.value}/${MAX_AGENT_ATTEMPTS})`;
      emit("run", nextResult.query);
    } else {
      agentRunning.value = false;
      agentStatusMessage.value = "Generated query ready for manual run.";
    }
  } catch (error) {
    if (error && error.name === "AbortError") {
      return;
    }

    agentRunning.value = false;
    errorMessage.value = String(error.message || error);
    agentStatusMessage.value = "Agent stopped due to a generation error.";
  } finally {
    generationController = undefined;
    generateLoading.value = false;
  }
}

async function refreshBridge() {
  bridgeLoading.value = true;
  errorMessage.value = "";

  try {
    const [health, providerReply] = await Promise.all([
      bridgeRequest("/v1/health"),
      bridgeRequest("/v1/providers")
    ]);

    bridgeHealthy.value = true;
    bridgeConfigPath.value = health.configPath || "";
    providers.value = providerReply.providers || [];

    if (!selectedProvider.value && providers.value.length) {
      const preferred =
        providers.value.find((provider) => provider.id === selectedProviderId.value) ||
        providers.value.find((provider) => provider.ready) ||
        providers.value[0];
      selectedProviderId.value = preferred.id;
    }

    // Load OpenCode models if OpenCode CLI is selected
    if (selectedProvider.value && selectedProvider.value.id === "opencode-cli") {
      await loadOpencodeModels();
    }
  } catch (error) {
    bridgeHealthy.value = false;
    providers.value = [];
    bridgeConfigPath.value = "";
    errorMessage.value = String(error.message || error);
  } finally {
    bridgeLoading.value = false;
  }
}

async function loadOpencodeModels() {
  try {
    const reply = await bridgeRequest("/v1/opencode/models");
    opencodeModels.value = reply.models || [];
  } catch (error) {
    opencodeModels.value = [];
  }
}

function authSessionInFlight(session) {
  return Boolean(session && (session.status === "pending" || session.status === "running"));
}

function authSessionStatusLabel(session) {
  if (!session) {
    return "";
  }

  if (session.status === "ready") {
    return "Ready";
  }
  if (session.status === "failed") {
    return "Failed";
  }
  if (session.status === "timed_out") {
    return "Timed out";
  }
  return "Running";
}

function authSessionClass(session) {
  if (!session) {
    return "";
  }

  if (session.status === "ready") {
    return "assistant-auth-session-ready";
  }
  if (session.status === "failed" || session.status === "timed_out") {
    return "assistant-auth-session-error";
  }
  return "assistant-auth-session-running";
}

function stopAuthSessionPolling() {
  if (authSessionPollTimer) {
    window.clearTimeout(authSessionPollTimer);
    authSessionPollTimer = 0;
  }
}

async function pollAuthSession(sessionId) {
  stopAuthSessionPolling();

  if (!sessionId) {
    return;
  }

  try {
    const reply = await bridgeRequest(`/v1/auth-sessions/${sessionId}`);
    authSession.value = reply.session;

    if (authSessionInFlight(reply.session)) {
      authSessionPollTimer = window.setTimeout(() => {
        pollAuthSession(sessionId);
      }, 1500);
      return;
    }

    await refreshBridge();
  } catch (error) {
    errorMessage.value = String(error.message || error);
  }
}

function updateApiForm() {
  apiKey.value = "";
  apiModel.value = selectedProvider.value && selectedProvider.value.model
    ? selectedProvider.value.model
    : "";
}

async function startBrowserOauth() {
  if (!selectedProvider.value) {
    return;
  }

  providerActionLoading.value = true;
  errorMessage.value = "";

  try {
    const reply = await bridgeRequest(`/v1/providers/${selectedProvider.value.id}/browser-oauth`, {
      method: "POST",
      body: JSON.stringify({})
    });
    authSession.value = reply.session;

    if (authSessionInFlight(reply.session)) {
      await pollAuthSession(reply.session.id);
    } else {
      await refreshBridge();
    }
  } catch (error) {
    errorMessage.value = String(error.message || error);
  } finally {
    providerActionLoading.value = false;
  }
}

async function launchLogin() {
  if (!selectedProvider.value) {
    return;
  }

  providerActionLoading.value = true;
  errorMessage.value = "";

  try {
    await bridgeRequest(`/v1/providers/${selectedProvider.value.id}/login`, {
      method: "POST",
      body: JSON.stringify({})
    });
  } catch (error) {
    errorMessage.value = String(error.message || error);
  } finally {
    providerActionLoading.value = false;
  }
}

async function saveApiConfig() {
  if (!selectedProvider.value) {
    return;
  }

  providerActionLoading.value = true;
  errorMessage.value = "";

  try {
    await bridgeRequest(`/v1/providers/${selectedProvider.value.id}/api-key`, {
      method: "POST",
      body: JSON.stringify({
        apiKey: apiKey.value,
        model: apiModel.value
      })
    });
    await refreshBridge();
  } catch (error) {
    errorMessage.value = String(error.message || error);
  } finally {
    providerActionLoading.value = false;
  }
}

async function deleteApiConfig() {
  if (!selectedProvider.value) {
    return;
  }

  providerActionLoading.value = true;
  errorMessage.value = "";

  try {
    await bridgeRequest(`/v1/providers/${selectedProvider.value.id}/api-key`, {
      method: "DELETE"
    });
    updateApiForm();
    await refreshBridge();
  } catch (error) {
    errorMessage.value = String(error.message || error);
  } finally {
    providerActionLoading.value = false;
  }
}

function collectKnownSymbols() {
  if (!props.conn || typeof props.conn.query !== "function") {
    return;
  }

  props.conn.query(
    "Component, (Identifier, Symbol), ?(flecs.doc.Description, flecs.doc.Brief)",
    { try: true, limit: 120 },
    (reply) => {
      const symbols = new Set();
      for (const item of reply.results || []) {
        if (item && typeof item.path === "string" && item.path.length) {
          symbols.add(item.path);
        }

        if (item && typeof item.name === "string" && item.name.length) {
          symbols.add(item.name);
          if (item.parent && typeof item.parent === "string") {
            symbols.add(`${item.parent}.${item.name}`);
          }
        }

        const values = item.fields && item.fields.values;
        if (!Array.isArray(values)) {
          continue;
        }

        for (const value of values) {
          if (value && typeof value.value === "string") {
            symbols.add(value.value);
          }
        }
      }

      knownSymbols.value = Array.from(symbols);
    },
    () => {}
  );
}

async function generateQuery() {
  if (!canGenerate.value) {
    return;
  }

  agentRunning.value = true;
  agentStopRequested.value = false;
  agentAttempt.value = 1;
  errorMessage.value = "";
  result.value = undefined;
  appendConversation("user", prompt.value);
  agentStatusMessage.value = "Generating initial query...";

  await requestAgentQuery();
}

function runResult() {
  if (!result.value) {
    return;
  }

  agentStatusMessage.value = "Running generated query in explorer.";
  emit("run", result.value.query);
}

function handlePromptKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (canGenerate.value && !generateLoading.value) {
      generateQuery();
    }
  }
}

function applyResult() {
  if (!result.value) {
    return;
  }

  emit("update:query", result.value.query);
  emit("apply", result.value.query);
}

async function copyResult() {
  if (!result.value || !navigator.clipboard) {
    return;
  }

  try {
    await navigator.clipboard.writeText(result.value.query);
  } catch (error) {
    errorMessage.value = "Could not copy query to clipboard";
  }
}

watch(selectedProviderId, () => {
  persistProviderId();
  updateApiForm();
});

watch(autoRun, () => {
  persistAutoRun();
});

watch(providers, () => {
  if (!selectedProvider.value && providers.value.length) {
    selectedProviderId.value = providers.value[0].id;
  }
  updateApiForm();
});

watch(() => props.query_result_state && props.query_result_state.seq, async (nextSeq) => {
  if (!nextSeq || !awaitingExecution.value) {
    return;
  }

  const resultState = props.query_result_state;
  if (!resultState || resultState.useName) {
    return;
  }

  if (nextSeq <= awaitingExecution.value.seq) {
    return;
  }

  if (resultState.queryExpr !== awaitingExecution.value.query) {
    return;
  }

  awaitingExecution.value = undefined;

  const feedback = summarizeExecutionFeedback(resultState);
  if (!feedback) {
    return;
  }

  appendConversation("tool", feedback.message);

  if (feedback.ok) {
    agentRunning.value = false;
    agentStatusMessage.value = "Query executed successfully.";
    return;
  }

  if (agentStopRequested.value) {
    agentStatusMessage.value = "Agent stopped after receiving explorer feedback.";
    return;
  }

  if (!autoRun.value) {
    agentRunning.value = false;
    agentStatusMessage.value = "Explorer returned an error. Auto Run is off, so no retry was sent.";
    return;
  }

  if (agentAttempt.value >= MAX_AGENT_ATTEMPTS) {
    agentRunning.value = false;
    agentStatusMessage.value = `Explorer still rejects the query after ${MAX_AGENT_ATTEMPTS} attempts.`;
    return;
  }

  agentAttempt.value += 1;
  agentStatusMessage.value = `Explorer rejected the query. Retrying with execution feedback (attempt ${agentAttempt.value}/${MAX_AGENT_ATTEMPTS})...`;
  appendConversation(
    "tool",
    `Retrying with model using explorer feedback (attempt ${agentAttempt.value}/${MAX_AGENT_ATTEMPTS}).`
  );
  await requestAgentQuery(feedback.message);
});

onMounted(() => {
  refreshBridge();
  collectKnownSymbols();
});

onBeforeUnmount(() => {
  stopAuthSessionPolling();
  if (generationController) {
    generationController.abort();
    generationController = undefined;
  }
});
</script>

<style scoped>
#query-assistant {
  height: calc(100vh - var(--header-height) - var(--footer-height) - 3 * var(--gap) - 4rem);
  overflow: hidden;
}

div.assistant-scroll {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
  overflow-y: auto;
  padding-right: 0.25rem;
}

section.assistant-section {
  background-color: var(--bg-content);
  border-radius: var(--border-radius-medium);
  padding: 0.75rem;
}

div.assistant-title {
  color: var(--primary-text);
  font-size: 1rem;
  font-weight: 600;
}

div.assistant-title-small {
  margin-bottom: 0.5rem;
}

div.assistant-subtitle,
div.provider-help,
div.assistant-result-meta,
div.assistant-reasoning {
  color: var(--secondary-text);
  font-size: 0.85rem;
  line-height: 1.4;
}

div.assistant-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

div.assistant-row-generate {
  justify-content: space-between;
}

div.assistant-row-generate :deep(button.toggle) {
  margin-bottom: 0;
  white-space: nowrap;
}

div.assistant-row-generate :deep(button.assistant-auto-run-toggle.toggle-active),
div.assistant-row-generate :deep(button.assistant-auto-run-toggle.toggle-active:hover) {
  background-color: rgba(88, 214, 141, 0.18);
  color: var(--green);
  box-shadow: inset 0 0 0 1px rgba(88, 214, 141, 0.35);
}

div.assistant-row-header {
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.75rem;
}

label.assistant-label {
  display: block;
  color: var(--secondary-text);
  font-size: 0.8rem;
  margin-bottom: 0.35rem;
  margin-top: 0.65rem;
  text-transform: uppercase;
}

input,
textarea {
  width: 100%;
  box-sizing: border-box;
  border-radius: var(--border-radius-medium);
  background-color: var(--bg-pane);
  padding: 0.55rem 0.7rem;
  color: var(--primary-text);
}

textarea {
  resize: vertical;
  min-height: 8rem;
}

div.assistant-status {
  margin-top: 0.75rem;
  font-size: 0.85rem;
}

div.assistant-status-ok {
  color: var(--green);
}

div.assistant-status-agent {
  margin-top: 0;
  margin-bottom: 0.75rem;
  color: var(--secondary-text);
}

div.assistant-status-error,
div.assistant-error {
  color: #ff8e8e;
}

div.provider-grid {
  display: grid;
  gap: 0.5rem;
}

div.assistant-conversation {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  max-height: 20rem;
  overflow: auto;
}

div.assistant-message {
  padding: 0.6rem 0.7rem;
  border-radius: var(--border-radius-medium);
  background-color: var(--bg-pane);
}

div.assistant-message-user {
  box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.22);
}

div.assistant-message-assistant {
  box-shadow: inset 0 0 0 1px rgba(88, 214, 141, 0.22);
}

div.assistant-message-tool {
  box-shadow: inset 0 0 0 1px rgba(255, 211, 124, 0.24);
}

div.assistant-message-role {
  margin-bottom: 0.35rem;
  color: var(--secondary-text);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
}

pre.assistant-message-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--primary-text);
  background: transparent;
  padding: 0;
}

button.provider-card {
  width: 100%;
  text-align: left;
  padding: 0.75rem;
  background-color: var(--bg-pane);
}

button.provider-card:hover {
  background-color: var(--bg-content-hover);
}

button.provider-card-selected,
button.provider-card-selected:hover {
  background-color: var(--bg-content-select);
}

div.provider-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  color: var(--primary-text);
  font-weight: 600;
}

div.provider-card-meta,
div.provider-card-message {
  font-size: 0.82rem;
  color: var(--secondary-text);
  margin-top: 0.25rem;
}

span.provider-pill {
  border-radius: 999px;
  padding: 0.2rem 0.55rem;
  font-size: 0.72rem;
  background-color: rgba(255, 255, 255, 0.08);
}

span.provider-pill.ready {
  color: var(--green);
}

span.provider-pill.missing,
span.provider-pill.needs_auth,
span.provider-pill.needs_config {
  color: #ffb37a;
}

div.provider-config {
  margin-top: 0.75rem;
}

div.assistant-auth-session {
  margin: 0.75rem 0;
  padding: 0.7rem;
  border-radius: var(--border-radius-medium);
  background-color: var(--bg-pane);
}

div.assistant-auth-session-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
  color: var(--primary-text);
  font-size: 0.82rem;
  font-weight: 600;
}

div.assistant-auth-session-ready {
  box-shadow: inset 0 0 0 1px rgba(88, 214, 141, 0.35);
}

div.assistant-auth-session-running {
  box-shadow: inset 0 0 0 1px rgba(255, 211, 124, 0.3);
}

div.assistant-auth-session-error {
  box-shadow: inset 0 0 0 1px rgba(255, 142, 142, 0.35);
}

div.assistant-auth-code {
  margin-top: 0.5rem;
  color: var(--secondary-text);
  font-size: 0.82rem;
}

a.assistant-auth-link {
  display: inline-block;
  margin-top: 0.5rem;
}

pre.assistant-command,
pre.assistant-query {
  margin: 0.6rem 0;
  background-color: var(--bg-pane);
}

pre.assistant-command-small {
  margin-top: 0.5rem;
  max-height: 10rem;
  overflow: auto;
}

ul.assistant-warnings {
  margin: 0.5rem 0 0.8rem 1rem;
  padding: 0;
  color: #ffcf8b;
}

div.assistant-row-model {
  margin-top: 0.75rem;
  align-items: center;
}

select.assistant-select {
  flex: 1;
  padding: 0.55rem 0.7rem;
  border-radius: var(--border-radius-medium);
  background-color: var(--bg-pane);
  color: var(--primary-text);
  border: none;
  font-size: 0.9rem;
}

@media screen and (max-width: 800px) {
  #query-assistant {
    height: calc(30vh - 4rem);
  }
}
</style>
