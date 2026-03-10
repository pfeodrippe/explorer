const fs = require("fs");
const os = require("os");
const path = require("path");

const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_CONTEXT_SYMBOLS = 100;
const MAX_PROMPT_CANDIDATE_SYMBOLS = 12;
const MAX_TOOL_RESULTS = 8;
const SYMBOL_TERM_STOP_WORDS = new Set([
  "a", "all", "an", "and", "any", "are", "as", "at", "be", "but", "by", "component",
  "components", "entities", "entity", "error", "errors", "exact", "failed", "find",
  "first", "for", "from", "get", "have", "identifier", "identifiers", "in", "into",
  "is", "it", "its", "latest", "like", "match", "matches", "me", "name", "names",
  "need", "not", "of", "on", "or", "query", "related", "rejected", "return", "search",
  "show", "symbol", "symbols", "that", "the", "their", "them", "then", "these", "this",
  "those", "to", "tool", "unresolved", "use", "using", "with", "without", "write",
  "writing"
]);
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
    description: "List available Flecs entities and components by name, capped to 100 results. Use this when you need a bounded sample of available symbols.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "search_entities",
    description: "Search for entities/components by name using a regex pattern. Use this when you need to find symbols matching a specific pattern without listing the whole world.",
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
      result: `Available entities and components (first ${formatted.length} of ${symbols.length}):\n${formatted.join("\n")}`
    };
  }

  if (toolName === "search_entities") {
    const symbols = context.knownSymbols || [];
    const pattern = typeof toolInput === "string"
      ? toolInput
      : toolInput && toolInput.pattern;
    const requestedLimit = typeof toolInput === "string"
      ? 20
      : Number(toolInput && toolInput.limit);
    const limit = Math.max(
      1,
      Math.min(
        Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 20,
        MAX_CONTEXT_SYMBOLS
      )
    );

    if (!pattern) {
      return {
        ok: false,
        error: "Pattern is required for search_entities"
      };
    }

    try {
      const regex = new RegExp(pattern, "i"); // Case-insensitive search
      const allMatches = symbols.filter(symbol => regex.test(symbol));
      const matches = allMatches.slice(0, limit);
      
      if (matches.length === 0) {
        return {
          ok: true,
          result: `No entities or components found matching pattern: ${pattern}`
        };
      }

      const formatted = matches.map((symbol, index) => `  ${index + 1}. ${symbol}`);
      return {
        ok: true,
        result: allMatches.length > matches.length
          ? `Found ${matches.length} of ${allMatches.length} symbol(s) matching "${pattern}" (capped at ${limit}):\n${formatted.join("\n")}`
          : `Found ${matches.length} symbol(s) matching "${pattern}":\n${formatted.join("\n")}`
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

function extractSymbolTerms({
  prompt,
  currentQuery,
  selectedEntity,
  conversation,
  executionFeedback
}) {
  const chunks = [
    prompt,
    currentQuery,
    selectedEntity,
    executionFeedback
  ];

  if (Array.isArray(conversation)) {
    for (const message of conversation) {
      chunks.push(message && message.content);
    }
  }

  const terms = new Set();

  for (const chunk of chunks) {
    const text = String(chunk || "");

    const quotedMatches = text.match(/['"`]([A-Za-z0-9_.:$-]{3,})['"`]/g) || [];
    for (const quoted of quotedMatches) {
      const cleaned = quoted.slice(1, -1).trim().toLowerCase();
      if (cleaned && !SYMBOL_TERM_STOP_WORDS.has(cleaned)) {
        terms.add(cleaned);
      }
    }

    const rawTokens = text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9_.:$-]+/);

    for (const token of rawTokens) {
      const cleaned = token.trim().toLowerCase();
      if (cleaned.length < 3) {
        continue;
      }
      if (SYMBOL_TERM_STOP_WORDS.has(cleaned)) {
        continue;
      }
      terms.add(cleaned);
    }
  }

  return Array.from(terms);
}

function prioritizeSymbols(symbols, searchTerms) {
  if (!Array.isArray(symbols)) {
    return [];
  }

  const scored = rankSymbols(symbols, searchTerms);
  return scored.slice(0, MAX_CONTEXT_SYMBOLS).map((entry) => entry.symbol);
}

function rankSymbols(symbols, searchTerms) {
  const normalized = [];
  const seen = new Set();

  for (const symbol of symbols) {
    const value = String(symbol || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  if (!searchTerms.length) {
    return normalized.map((symbol, index) => ({
      symbol,
      index,
      score: 0
    }));
  }

  const scored = normalized.map((symbol, index) => {
    const lower = symbol.toLowerCase();
    let score = 0;

    for (const term of searchTerms) {
      if (lower === term) {
        score += 12;
        continue;
      }
      if (lower.endsWith(`.${term}`) || lower.endsWith(`:${term}`)) {
        score += 10;
        continue;
      }
      if (lower.includes(term)) {
        score += 5;
      }
    }

    return {
      symbol,
      index,
      score
    };
  });

  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    if (left.symbol.length !== right.symbol.length) {
      return left.symbol.length - right.symbol.length;
    }
    return left.index - right.index;
  });

  return scored;
}

function isExactSymbolMatch(symbol, term) {
  const lower = String(symbol || "").toLowerCase();
  return lower === term || lower.endsWith(`.${term}`) || lower.endsWith(`:${term}`);
}

function findCandidateSymbols(symbols, searchTerms) {
  return rankSymbols(symbols, searchTerms)
    .filter((entry) => entry.score > 0)
    .slice(0, MAX_PROMPT_CANDIDATE_SYMBOLS)
    .map((entry) => entry.symbol);
}

function findExactVisibleSymbols(symbols, searchTerms) {
  const scored = rankSymbols(symbols, searchTerms);
  const matches = [];

  for (const entry of scored) {
    if (!searchTerms.some((term) => isExactSymbolMatch(entry.symbol, term))) {
      continue;
    }
    matches.push(entry.symbol);
    if (matches.length >= MAX_PROMPT_CANDIDATE_SYMBOLS) {
      break;
    }
  }

  return matches;
}

function findMandatoryDiscoveryTerms(symbols, searchTerms) {
  if (!Array.isArray(symbols) || !searchTerms.length) {
    return [];
  }

  const normalizedSymbols = symbols
    .map((symbol) => String(symbol || "").trim())
    .filter(Boolean);

  const terms = [];

  for (const term of searchTerms) {
    const exactMatches = normalizedSymbols.filter((symbol) => isExactSymbolMatch(symbol, term));
    const relatedMatches = normalizedSymbols.filter((symbol) => {
      const lower = symbol.toLowerCase();
      return lower.includes(term) && !isExactSymbolMatch(symbol, term);
    });

    if (!exactMatches.length && relatedMatches.length) {
      terms.push({
        term,
        relatedMatches: relatedMatches.slice(0, 4)
      });
    }

    if (terms.length >= 4) {
      break;
    }
  }

  return terms;
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

function extractUnresolvedIdentifiers(executionFeedback) {
  const text = String(executionFeedback || "");
  const identifiers = new Set();
  const patterns = [
    /unresolved identifier\s+["']([^"'`\s]+)["']/gi,
    /unresolved identifier\s+`([^"`\s]+)`/gi
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      const value = String(match[1] || "").trim();
      if (value) {
        identifiers.add(value);
      }
      match = pattern.exec(text);
    }
  }

  return Array.from(identifiers);
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
  const symbolTerms = extractSymbolTerms({
    prompt,
    currentQuery,
    selectedEntity,
    conversation,
    executionFeedback
  });
  const exactVisibleSymbols = findExactVisibleSymbols(knownSymbols, symbolTerms);
  const candidateSymbols = findCandidateSymbols(knownSymbols, symbolTerms);
  const contextSymbols = prioritizeSymbols(knownSymbols, symbolTerms);
  const variantVisibleSymbols = candidateSymbols.filter((symbol) => !exactVisibleSymbols.includes(symbol));
  const mandatoryDiscoveryTerms = findMandatoryDiscoveryTerms(knownSymbols, symbolTerms);
  const unresolvedIdentifiers = extractUnresolvedIdentifiers(executionFeedback);
  const transcript = normalizeConversation(conversation);

  const system = [
    "You translate natural-language requests into Flecs query expressions for Flecs Explorer.",
    "Follow Flecs Query Language syntax from flecs.dev exactly.",
    "Return exactly one JSON object and nothing else.",
    "Prefer the shortest correct query.",
    "Use Flecs query syntax, not SQL.",
    "Do not invent undocumented operators, functions or keywords.",
    "Use documented patterns such as ! for not, ? for optional, || for or, pair syntax like (Rel, Obj), and variables such as $this and $var when needed.",
    "You may receive explorer execution feedback from earlier attempts. When that feedback shows a parser, identifier or semantic error, fix the query instead of repeating the failing query.",
    "Identifier rules: use exact names from the provided known symbols or tool results, preserve full namespaces and case, and never invent aliases such as EcsPosition or Position2D unless they are explicitly present in context.",
    "If explorer feedback says an identifier is unresolved, do not return that unresolved identifier again unless later discovery proves the exact same identifier exists.",
    "If several exact component names satisfy a broad request and the user did not narrow the choice, combine the matching names with || instead of guessing one variant.",
    "If the prompt asks for a name like Velocity and the user context says 'Exact visible symbol matches' is none, you must do one narrow search_entities call before returning the final JSON, even when related variants like Velocity2 or Velocity3 are already visible.",
    "If search results confirm only related variants and no exact base name exists, say that explicitly in reasoning or warnings. Never imply that the plain base name exists when only suffixed or namespaced variants were found.",
    "If the user prompt includes a section named 'Mandatory discovery before final answer', you must obey it and return a tool_use object before any final query response.",
    "If the user prompt includes a section named 'Mandatory recovery from explorer error', you must obey it before finalizing the query.",
    "The prompt may include an 'Automatic preflight name search results' section summarizing a bounded name search already performed over the available symbol list. Treat that section as authoritative discovery context and do not guess past it.",
    "If a request is ambiguous, prefer the most likely valid query and explain the uncertainty in warnings.",
    "If information is missing, return the best query you can and explain uncertainty in warnings.",
    "You have access to tools: list_entities (returns a bounded sample of up to 100 entity/component names) and search_entities (searches entity/component names by regex pattern). Use these tools when you need to discover what entities/components exist or when you need to find the correct name for a component after getting an error.",
    "There may be millions of entities available. Never ask for or assume an exhaustive listing. Prefer search_entities with a narrow regex first, and use list_entities only when a bounded sample is enough.",
    "Tool policy: usually request one narrow search_entities call first; only use list_entities when you genuinely do not have a useful search term.",
    "If you need a tool, return a JSON object with a top-level tool_use array instead of a final query response.",
    "Each tool_use entry must have keys name and input.",
    "Example tool request: {\"tool_use\":[{\"name\":\"search_entities\",\"input\":{\"pattern\":\"Position\",\"limit\":10}}]}",
    "When you already have enough information, return the final object with keys query, reasoning, warnings."
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

  if (unresolvedIdentifiers.length) {
    parts.push(
      "",
      "Mandatory recovery from explorer error:",
      ...unresolvedIdentifiers.map((identifier) => `- The explorer rejected "${identifier}" as unresolved. Do not return "${identifier}" again unless exact visible matches or search_entities results prove it exists.`)
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

  parts.push(
    "",
    "Automatic preflight name search results (bounded scan of available symbols):",
    `- Exact visible symbol matches for the request terms: ${exactVisibleSymbols.length ? exactVisibleSymbols.join(", ") : "none"}`
  );

  if (variantVisibleSymbols.length) {
    parts.push(
      `- Related visible symbol variants: ${variantVisibleSymbols.join(", ")}`
    );
  }

  if (mandatoryDiscoveryTerms.length) {
    parts.push(
      "",
      "Mandatory discovery before final answer:",
      ...mandatoryDiscoveryTerms.map((entry) => `- Term "${entry.term}" has no exact visible symbol match. Call search_entities for this term before producing the final query. Related visible variants: ${entry.relatedMatches.join(", ")}`)
    );
  }

  if (candidateSymbols.length) {
    parts.push(
      "",
      "Likely exact symbol candidates for this request:",
      ...candidateSymbols.map((symbol) => `- ${symbol}`),
      "Use these exact identifiers if they fit. Do not shorten, rename, or strip namespaces."
    );
  }

  if (contextSymbols.length) {
    parts.push("", "Known component and query symbols (relevance-ranked sample, capped to 100):");
    parts.push(contextSymbols.join(", "));
  }

  parts.push(
    "",
    "Return an object with keys query, reasoning, warnings.",
    "If you need discovery first, return a tool request object with key tool_use instead.",
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
