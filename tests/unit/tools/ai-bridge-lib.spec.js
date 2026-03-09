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
    expect(prompt.user).toContain("find moving entities");
    expect(prompt.user).toContain("Current query: Position");
    expect(prompt.user).toContain("Selected entity: game.Player");
    expect(prompt.user).toContain("Position, Velocity, Health");
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
    expect(prompt.user).toContain("entities with Position but not Velocity: Position, !Velocity");
    expect(prompt.user).toContain("spaceships docked to planets using variables: SpaceShip($this), DockedTo($this, $planet), Planet($planet)");
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
    expect(result.result).toContain("Total: 4");
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

  test("returns error for unknown tool", () => {
    const result = executeToolCall("unknown_tool", {}, {});

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });
});
