const {
  buildQueryPrompt,
  extractDeviceCode,
  extractFirstJsonObject,
  extractFirstUrl,
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
});
