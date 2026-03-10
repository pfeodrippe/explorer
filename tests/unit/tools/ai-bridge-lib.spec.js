const {
  buildQueryPrompt,
  executeToolCall,
  extractDeviceCode,
  extractFirstJsonObject,
  extractFirstUrl,
  getToolDefinitions,
  normalizeQueryResponse,
  parseOpencodeAuthList
} = require("../../../tools/ai-bridge-lib");

describe("ai-bridge-lib", () => {
  test("extracts the first JSON object from mixed output", () => {
    const payload = extractFirstJsonObject("prefix\n```json\n{\"query\":\"Position\",\"reasoning\":\"Because\",\"warnings\":[]}\n```\n");

    expect(payload.query).toBe("Position");
    expect(payload.reasoning).toBe("Because");
  });

  test("normalizes alternate response field names", () => {
    const payload = normalizeQueryResponse({
      query: "Velocity",
      explanation: "Matches velocity",
      notes: "best effort"
    });

    expect(payload).toEqual({
      query: "Velocity",
      reasoning: "Matches velocity",
      warnings: ["best effort"]
    });
  });

  test("parses opencode auth list output with ansi escapes", () => {
    const payload = parseOpencodeAuthList("\u001b[0m\n└  2 credentials\n");

    expect(payload.ready).toBe(true);
    expect(payload.credentialCount).toBe(2);
  });

  test("extracts provider auth urls and device codes from login output", () => {
    const output = "Open https://chatgpt.com/auth/device and enter code ABCD-1234";

    expect(extractFirstUrl(output)).toBe("https://chatgpt.com/auth/device");
    expect(extractDeviceCode(output)).toBe("ABCD-1234");
  });

  test("builds a prompt with current context", () => {
    const prompt = buildQueryPrompt({
      prompt: "find moving entities",
      currentQuery: "Position",
      selectedEntity: "game.Player",
      host: "localhost",
      knownSymbols: ["Position", "Velocity", "Health"],
      conversation: [
        { role: "user", content: "Find all entities with position" },
        { role: "assistant", content: "Query: Position" },
        { role: "tool", content: "Explorer rejected query \"Position\": unresolved identifier 'Position'" }
      ],
      executionFeedback: "Explorer rejected query \"Position\": unresolved identifier 'Position'"
    });

    expect(prompt.system).toContain("Flecs Explorer");
    expect(prompt.system).toContain("flecs.dev");
    expect(prompt.system).toContain("Do not invent undocumented operators");
    expect(prompt.system).toContain("Return exactly one JSON object and nothing else.");
    expect(prompt.system).toContain("tool_use");
    expect(prompt.system).toContain("millions of entities");
    expect(prompt.system).toContain("never invent aliases such as EcsPosition or Position2D");
    expect(prompt.system).toContain("do not return that unresolved identifier again");
    expect(prompt.system).toContain("Exact visible symbol matches");
    expect(prompt.system).toContain("must do one narrow search_entities call");
    expect(prompt.system).toContain("Mandatory discovery before final answer");
    expect(prompt.system).toContain("Mandatory recovery from explorer error");
    expect(prompt.system).toContain("Automatic preflight name search results");
    expect(prompt.user).toContain("find moving entities");
    expect(prompt.user).toContain("Current query: Position");
    expect(prompt.user).toContain("Selected entity: game.Player");
    expect(prompt.user).toContain("Automatic preflight name search results (bounded scan of available symbols):");
    expect(prompt.user).toContain("Exact visible symbol matches for the request terms: Position");
    expect(prompt.user).toContain("Likely exact symbol candidates for this request:");
    expect(prompt.user).toContain("- Position");
    expect(prompt.user).toContain("Do not shorten, rename, or strip namespaces.");
    expect(prompt.user).toContain("Known component and query symbols (relevance-ranked sample, capped to 100):");
    expect(prompt.user).toContain("Position");
    expect(prompt.user).toContain("Velocity");
    expect(prompt.user).toContain("Health");
    expect(prompt.user).toContain("https://www.flecs.dev/flecs/md_docs_2FlecsQueryLanguage.html");
    expect(prompt.user).toContain("https://flecs.dev/explorer");
    expect(prompt.user).toContain("Metadata inspection guide:");
    expect(prompt.user).toContain("GET /entity/flecs");
    expect(prompt.user).toContain("GET /entity/game.Player");
    expect(prompt.user).toContain("GET /query?expr=Position");
    expect(prompt.user).toContain("GET /world");
    expect(prompt.user).toContain("do not execute HTTP requests directly");
    expect(prompt.user).toContain("Recent agent conversation:");
    expect(prompt.user).toContain("1. user: Find all entities with position");
    expect(prompt.user).toContain("3. tool: Explorer rejected query \"Position\": unresolved identifier 'Position'");
    expect(prompt.user).toContain("Latest explorer execution feedback:");
    expect(prompt.user).toContain("Mandatory recovery from explorer error:");
    expect(prompt.user).toContain('The explorer rejected "Position" as unresolved.');
    expect(prompt.user).toContain("entities with Position but not Velocity: Position, !Velocity");
    expect(prompt.user).toContain("spaceships docked to planets using variables: SpaceShip($this), DockedTo($this, $planet), Planet($planet)");
    expect(prompt.user).toContain("If you need discovery first, return a tool request object with key tool_use instead.");
  });

  test("prioritizes relevant symbols into the prompt context even when they appear late", () => {
    const knownSymbols = Array.from({ length: 120 }, (_, index) => `game.misc.Component_${index + 1}`);
    knownSymbols[110] = "flecs.components.transform.Position3";
    knownSymbols[111] = "flecs.components.transform.Position2";

    const prompt = buildQueryPrompt({
      prompt: "find entities with position",
      knownSymbols
    });

    expect(prompt.user).toContain("Exact visible symbol matches for the request terms: none");
    expect(prompt.user).toContain("Automatic preflight name search results (bounded scan of available symbols):");
    expect(prompt.user).toContain("Related visible symbol variants:");
    expect(prompt.user).toContain("Mandatory discovery before final answer:");
    expect(prompt.user).toContain('Term "position" has no exact visible symbol match.');
    expect(prompt.user).toContain("Likely exact symbol candidates for this request:");
    expect(prompt.user).toContain("flecs.components.transform.Position3");
    expect(prompt.user).toContain("flecs.components.transform.Position2");
    expect(prompt.user).not.toContain("game.misc.Component_120");
  });

  test("exposes tool definitions for the agent", () => {
    const tools = getToolDefinitions();

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe("list_entities");
    expect(tools[0].description).toContain("entities");
    expect(tools[0].input_schema.type).toBe("object");
    expect(tools[1].name).toBe("search_entities");
    expect(tools[1].input_schema.properties.pattern).toBeDefined();
  });

  test("executes list_entities tool with known symbols", () => {
    const context = {
      knownSymbols: ["Position", "Velocity", "Health", "Mass"]
    };

    const result = executeToolCall("list_entities", {}, context);

    expect(result.ok).toBe(true);
    expect(result.result).toContain("Position");
    expect(result.result).toContain("Velocity");
    expect(result.result).toContain("first 4 of 4");
  });

  test("executes list_entities tool with empty symbols", () => {
    const result = executeToolCall("list_entities", {}, { knownSymbols: [] });

    expect(result.ok).toBe(true);
    expect(result.result).toContain("No entities or components");
  });

  test("executes search_entities tool with matching pattern", () => {
    const context = {
      knownSymbols: ["Position", "Position3", "Velocity", "Velocity3", "Health"]
    };

    const result = executeToolCall("search_entities", { pattern: "Pos.*" }, context);

    expect(result.ok).toBe(true);
    expect(result.result).toContain("Found 2");
    expect(result.result).toContain("Position");
    expect(result.result).toContain("Position3");
    expect(result.result).not.toContain("Velocity");
  });

  test("executes search_entities tool with no matches", () => {
    const context = {
      knownSymbols: ["Position", "Velocity"]
    };

    const result = executeToolCall("search_entities", { pattern: "NonExistent.*" }, context);

    expect(result.ok).toBe(true);
    expect(result.result).toContain("No entities or components found");
  });

  test("executes search_entities tool with invalid regex", () => {
    const context = {
      knownSymbols: ["Position"]
    };

    const result = executeToolCall("search_entities", { pattern: "[invalid(" }, context);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid regex pattern");
  });

  test("executes search_entities tool with limit", () => {
    const context = {
      knownSymbols: ["Pos1", "Pos2", "Pos3", "Pos4", "Pos5"]
    };

    const result = executeToolCall("search_entities", { pattern: "Pos.*", limit: 3 }, context);

    expect(result.ok).toBe(true);
    expect(result.result).toContain("Found 3");
  });

  test("caps list_entities output to 100 symbols", () => {
    const context = {
      knownSymbols: Array.from({ length: 120 }, (_, index) => `Symbol_${index + 1}`)
    };

    const result = executeToolCall("list_entities", {}, context);

    expect(result.ok).toBe(true);
    expect(result.result).toContain("first 100 of 120");
    expect(result.result).toContain("Symbol_100");
    expect(result.result).not.toContain("Symbol_101");
  });

  test("caps search_entities output to 100 symbols even when a higher limit is requested", () => {
    const context = {
      knownSymbols: Array.from({ length: 150 }, (_, index) => `flecs.components.transform.Position_${String(index + 1).padStart(3, "0")}`)
    };

    const result = executeToolCall("search_entities", {
      pattern: "Position_.*",
      limit: 999
    }, context);

    expect(result.ok).toBe(true);
    expect(result.result).toContain('Found 100 of 150 symbol(s) matching "Position_.*" (capped at 100)');
    expect(result.result).toContain("Position_100");
    expect(result.result).not.toContain("Position_101");
  });

  test("returns error for unknown tool", () => {
    const result = executeToolCall("unknown_tool", {}, {});

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });
});
