const fs = require("fs");
const os = require("os");
const path = require("path");

const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_CONTEXT_SYMBOLS = 80;
const MAX_TOOL_RESULTS = 8;
const FLECS_QUERY_DOCS = [
  "https://www.flecs.dev/flecs/md_docs_2FlecsQueryLanguage.html",
  "https://www.flecs.dev/flecs/md_docs_2Queries.html",
  "https://www.flecs.dev/flecs/md_docs_2FlecsRemoteApi.html",
  "https://flecs.dev/explorer"
];
const FLECS_QUERY_EXAMPLES = [
  {
    request: "entities with Position and Velocity",
    query: "Position, Velocity"
  },
  {
    request: "entities with Position but not Velocity",
    query: "Position, !Velocity"
  },
  {
    request: "entities with Position and optional Velocity",
    query: "Position, ?Velocity"
  },
  {
    request: "entities with Position and either Velocity or Mass",
    query: "Position, Velocity || Mass"
  },
  {
    request: "match a pair relationship",
    query: "(Likes, Bob), (Eats, Apples)"
  },
  {
    request: "spaceships docked to planets using variables",
    query: "SpaceShip($this), DockedTo($this, $planet), Planet($planet)"
  },
  {
    request: "entities eating healthy food they do not like",
    query: "Eats($this, $food), !Likes($this, $food), Healthy($food)"
  },
  {
    request: "read a singleton or static source",
    query: "TimeOfDay($)"
  }
];

const QUERY_TOOLS = [
  {
    name: "list_entities",
    description: "List all available Flecs entities and components. Use this when you need to see all available symbols.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "search_entities",
    description: "Search for entities/components by name using a regex pattern. Use this when you need to find symbols matching a specific pattern (e.g., when you get a component error and need to find the correct name).",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to match entity/component names (e.g., 'Position.*', '.*Velocity.*', '^flecs\\.core\\..*')"
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 20)",
          default: 20
        }
      },
      required: ["pattern"]
    }
  }
];

function getToolDefinitions() {
  return QUERY_TOOLS;
}

function executeToolCall(toolName, toolInput, context) {
  if (toolName === "list_entities") {
    const symbols = context.knownSymbols || [];
    if (symbols.length === 0) {
      return {
        ok: true,
        result: "No entities or components are available in the current session."
      };
    }

    const formatted = symbols.slice(0, MAX_CONTEXT_SYMBOLS).map((symbol) => `  - ${symbol}`);
    return {
      ok: true,
      result: `Available entities and components:\n${formatted.join("\n")}\n\nTotal: ${symbols.length} symbol${symbols.length === 1 ? "" : "s"}.`
    };
  }

  if (toolName === "search_entities") {
    const symbols = context.knownSymbols || [];
    const pattern = toolInput.pattern;
    const limit = toolInput.limit || 20;

    if (!pattern) {
      return {
        ok: false,
        error: "Pattern is required for search_entities"
      };
    }

    try {
      const regex = new RegExp(pattern, "i"); // Case-insensitive search
      const matches = symbols.filter(symbol => regex.test(symbol)).slice(0, limit);
      
      if (matches.length === 0) {
        return {
          ok: true,
          result: `No entities or components found matching pattern: ${pattern}`
        };
      }

      const formatted = matches.map((symbol, index) => `  ${index + 1}. ${symbol}`);
      return {
        ok: true,
        result: `Found ${matches.length} symbol(s) matching "${pattern}":\n${formatted.join("\n")}`
      };
    } catch (error) {
      return {
        ok: false,
        error: `Invalid regex pattern: ${error.message}`
      };
    }
  }

  return {
    ok: false,
    error: `Unknown tool: ${toolName}`
  };
}

const QUERY_RESULT_SCHEMA = {
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
};

function stripAnsi(value) {
  return String(value || "").replace(ANSI_ESCAPE_RE, "");
}

function extractFirstJsonObject(value) {
  const text = stripAnsi(value).trim();

  try {
    return JSON.parse(text);
  } catch (error) {
    // Fall through and try to extract the first JSON object.
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i ++) {
    const ch = text[i];

    if (start === -1) {
      if (ch === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      depth ++;
    } else if (ch === "}") {
      depth --;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }

  throw new Error("No JSON object found in provider response");
}

function normalizeWarnings(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return [];
}

function normalizeQueryResponse(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Provider returned an invalid query payload");
  }

  const query = String(value.query || "").trim();
  const reasoning = String(
    value.reasoning || value.explanation || value.rationale || ""
  ).trim();
  const warnings = normalizeWarnings(value.warnings || value.caveats || value.notes);

  if (!query) {
    throw new Error("Provider response did not include a query");
  }

  return {
    query,
    reasoning,
    warnings
  };
}

function sampleSymbols(symbols) {
  if (!Array.isArray(symbols)) {
    return [];
  }

  return symbols
    .map((symbol) => String(symbol || "").trim())
    .filter(Boolean)
    .slice(0, MAX_CONTEXT_SYMBOLS);
}

function buildMetadataGuide({ currentQuery, selectedEntity, host }) {
  const lines = [
    "Metadata inspection guide:",
    "- Flecs Explorer and remote servers expose metadata through the Flecs Remote API.",
    "- Inspect the root module or builtin metadata: GET /entity/flecs",
    "- Inspect a specific entity path: GET /entity/<path>",
    "- Inspect query results: GET /query?expr=<url-encoded-query>",
    "- Inspect full matched entity tables: GET /query?expr=<url-encoded-query>&table=true",
    "- Inspect the world overview: GET /world",
    "- Query endpoint responses can be used to confirm component names, relationship pairs, fields, and matching entities.",
    "- Entity endpoint responses can be used to confirm paths, ids, type information, labels, and component/pair metadata."
  ];

  if (host) {
    lines.push(`- Current explorer host hint: ${host}`);
  }

  if (selectedEntity) {
    lines.push(`- Metadata starting point for this session: GET /entity/${selectedEntity}`);
  }

  if (currentQuery) {
    lines.push(`- Current query starting point: GET /query?expr=${encodeURIComponent(currentQuery)}`);
  }

  lines.push(
    "- In this bridge flow you usually do not execute HTTP requests directly, so use the supplied host, entity, query and known symbols as your primary metadata context."
  );

  return lines;
}

function normalizeConversation(conversation) {
  if (!Array.isArray(conversation)) {
    return [];
  }

  return conversation
    .map((message) => ({
      role: String(message && message.role || "").trim().toLowerCase(),
      content: String(message && message.content || "").trim()
    }))
    .filter((message) => message.role && message.content)
    .slice(-12);
}

function buildQueryPrompt({
  prompt,
  currentQuery,
  selectedEntity,
  host,
  knownSymbols,
  conversation,
  executionFeedback
}) {
  const contextSymbols = sampleSymbols(knownSymbols);
  const transcript = normalizeConversation(conversation);

  const system = [
    "You translate natural-language requests into Flecs query expressions for Flecs Explorer.",
    "Follow Flecs Query Language syntax from flecs.dev exactly.",
    "Return JSON only.",
    "Prefer the shortest correct query.",
    "Use Flecs query syntax, not SQL.",
    "Do not invent undocumented operators, functions or keywords.",
    "Use documented patterns such as ! for not, ? for optional, || for or, pair syntax like (Rel, Obj), and variables such as $this and $var when needed.",
    "You may receive explorer execution feedback from earlier attempts. When that feedback shows a parser, identifier or semantic error, fix the query instead of repeating the failing query.",
    "When choosing identifiers, prefer exact names from the provided known symbol list and treat explorer error messages as authoritative feedback.",
    "If a request is ambiguous, prefer the most likely valid query and explain the uncertainty in warnings.",
    "If information is missing, return the best query you can and explain uncertainty in warnings.",
    "You have access to tools: list_entities (returns all available entities/components) and search_entities (searches entities/components by regex pattern). Use these tools when you need to discover what entities/components exist or when you need to find the correct name for a component after getting an error."
  ].join(" ");

  const parts = [
    "Generate a Flecs query for this request:",
    prompt || ""
  ];

  parts.push(
    "",
    "Official Flecs references:",
    ...FLECS_QUERY_DOCS.map((url) => `- ${url}`),
    "",
    ...buildMetadataGuide({ currentQuery, selectedEntity, host }),
    "",
    "Use the documentation style and syntax shown by these examples:",
    ...FLECS_QUERY_EXAMPLES.map((example) => `- ${example.request}: ${example.query}`)
  );

  if (transcript.length) {
    parts.push(
      "",
      "Recent agent conversation:",
      ...transcript.map((message, index) => `${index + 1}. ${message.role}: ${message.content}`)
    );
  }

  if (executionFeedback) {
    parts.push(
      "",
      "Latest explorer execution feedback:",
      String(executionFeedback)
    );
  }

  if (currentQuery) {
    parts.push("", `Current query: ${currentQuery}`);
  }

  if (selectedEntity) {
    parts.push(`Selected entity: ${selectedEntity}`);
  }

  if (host) {
    parts.push(`Explorer host: ${host}`);
  }

  if (contextSymbols.length) {
    parts.push("", "Known component and query symbols:");
    parts.push(contextSymbols.join(", "));
  }

  parts.push(
    "",
    "Return an object with keys query, reasoning, warnings.",
    "Warnings must be an array of strings.",
    "Do not wrap the JSON in markdown."
  );

  return {
    system,
    user: parts.join("\n")
  };
}

function getBridgeConfigPath(env = process.env) {
  if (env.FLECS_EXPLORER_AI_BRIDGE_CONFIG) {
    return env.FLECS_EXPLORER_AI_BRIDGE_CONFIG;
  }

  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "flecs-explorer", "ai-bridge.json");
}

function defaultBridgeConfig() {
  return {
    version: 1,
    providers: {
      openai: {
        apiKey: "",
        model: ""
      },
      anthropic: {
        apiKey: "",
        model: ""
      }
    }
  };
}

function loadBridgeConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    return defaultBridgeConfig();
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    ...defaultBridgeConfig(),
    ...parsed,
    providers: {
      ...defaultBridgeConfig().providers,
      ...(parsed.providers || {})
    }
  };
}

function saveBridgeConfig(filePath, config) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
}

function parseClaudeStatus(rawValue) {
  try {
    const parsed = JSON.parse(stripAnsi(rawValue));
    return {
      ready: Boolean(parsed.loggedIn),
      details: parsed
    };
  } catch (error) {
    return {
      ready: false,
      details: {
        error: "Could not parse Claude auth status"
      }
    };
  }
}

function parseCodexStatus(rawValue) {
  const text = stripAnsi(rawValue);
  return {
    ready: /^Logged in\b/i.test(text),
    summary: text.trim()
  };
}

function parseOpencodeAuthList(rawValue) {
  const text = stripAnsi(rawValue);
  const match = text.match(/(\d+)\s+credentials?/i);
  const count = match ? Number(match[1]) : 0;
  return {
    ready: count > 0,
    credentialCount: count,
    summary: text.trim()
  };
}

function extractFirstUrl(value) {
  const text = stripAnsi(value);
  const match = text.match(/https?:\/\/[^\s<>"')\]}]+/i);
  return match ? match[0] : undefined;
}

function extractDeviceCode(value) {
  const text = stripAnsi(value);
  const patterns = [
    /\bcode\b\s*[:=]?\s*([A-Z0-9-]{4,})/i,
    /\benter\b[^\n]*\b([A-Z0-9-]{4,})\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function findStringWithJson(value) {
  if (typeof value === "string") {
    try {
      extractFirstJsonObject(value);
      return value;
    } catch (error) {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringWithJson(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findStringWithJson(item);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

module.exports = {
  QUERY_RESULT_SCHEMA,
  QUERY_TOOLS,
  buildQueryPrompt,
  defaultBridgeConfig,
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
};
