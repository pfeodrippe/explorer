import { mount } from "@vue/test-utils";
import QueryAssistant from "../../../../../etc/js/components/pages/queries/query-assistant.vue";
import Toggle from "../../../../../etc/js/components/toggle.vue";

function mockResponse(payload, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => payload
  });
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildProvider(overrides = {}) {
  return {
    id: "claude-cli",
    name: "Claude CLI",
    kind: "cli",
    status: "ready",
    ready: true,
    installed: true,
    message: "Signed in",
    command: "claude auth login",
    supportsBrowserOauth: true,
    ...overrides
  };
}

function mountAssistant(queryUpdate = jest.fn()) {
  return mount(QueryAssistant, {
    global: {
      components: {
        toggle: Toggle
      }
    },
    props: {
      conn: {
        query(_expr, _params, recv) {
          recv({
            results: [
              {
                fields: {
                  values: [
                    { value: "Position" },
                    { value: "Velocity" }
                  ]
                }
              }
            ]
          });
        }
      },
      host: "localhost",
      query: "Position",
      query_state: {
        path: "game.Player"
      },
      query_result_state: {
        seq: 0,
        queryExpr: "",
        useName: false,
        value: {}
      },
      "onUpdate:query": queryUpdate
    }
  });
}

function findButton(wrapper, label) {
  return wrapper.findAll("button").find((node) => node.text() === label);
}

describe("query-assistant.vue", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("loads providers and applies a generated query", async () => {
    const queryUpdate = jest.fn();
    global.fetch = jest.fn((url, options = {}) => {
      if (url.endsWith("/v1/health")) {
        return mockResponse({
          ok: true,
          configPath: "/tmp/flecs-ai-bridge.json"
        });
      }

      if (url.endsWith("/v1/providers")) {
        return mockResponse({
          providers: [buildProvider()]
        });
      }

      if (url.endsWith("/v1/generate-query")) {
        return mockResponse({
          query: "Position, Velocity",
          reasoning: "Matches moving entities",
          warnings: [],
          provider: "claude-cli",
          providerName: "Claude CLI",
          model: "cli-default"
        });
      }

      if (url.endsWith("/v1/providers/claude-cli/login")) {
        return mockResponse({
          launched: true
        });
      }

      return mockResponse({ error: "not found" }, false, 404);
    });

    const wrapper = mountAssistant(queryUpdate);

    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("Claude CLI");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:27891/v1/health",
      expect.any(Object)
    );

    await wrapper.find("#assistant-prompt").setValue("find moving entities");
    expect(wrapper.text()).toContain("Generate and Run Query");

    await findButton(wrapper, "Generate and Run Query").trigger("click");
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("Position, Velocity");
    expect(wrapper.emitted().run[0]).toEqual(["Position, Velocity"]);

    await findButton(wrapper, "Apply To Editor").trigger("click");

    expect(queryUpdate).toHaveBeenCalledWith("Position, Velocity");
    expect(wrapper.emitted().apply[0]).toEqual(["Position, Velocity"]);
  });

  test("can disable auto run and run manually", async () => {
    global.fetch = jest.fn((url, options = {}) => {
      if (url.endsWith("/v1/health")) {
        return mockResponse({
          ok: true,
          configPath: "/tmp/flecs-ai-bridge.json"
        });
      }

      if (url.endsWith("/v1/providers")) {
        return mockResponse({
          providers: [buildProvider()]
        });
      }

      if (url.endsWith("/v1/generate-query")) {
        return mockResponse({
          query: "Mass",
          reasoning: "Matches the demo component",
          warnings: [],
          provider: "claude-cli",
          providerName: "Claude CLI",
          model: "cli-default"
        });
      }

      return mockResponse({ error: "not found" }, false, 404);
    });

    const wrapper = mountAssistant();

    await flushPromises();
    await flushPromises();

    await findButton(wrapper, "Auto Run").trigger("click");
    expect(wrapper.text()).toContain("Generate Query Only");
    await wrapper.find("#assistant-prompt").setValue("find masses");
    await findButton(wrapper, "Generate Query Only").trigger("click");
    await flushPromises();
    await flushPromises();

    expect(wrapper.emitted().run).toBeUndefined();

    await findButton(wrapper, "Run In Explorer").trigger("click");

    expect(wrapper.emitted().run[0]).toEqual(["Mass"]);
  });

  test("starts browser oauth and polls auth-session status", async () => {
    let authPollCount = 0;
    global.fetch = jest.fn((url, options = {}) => {
      if (url.endsWith("/v1/health")) {
        return mockResponse({
          ok: true,
          configPath: "/tmp/flecs-ai-bridge.json"
        });
      }

      if (url.endsWith("/v1/providers")) {
        return mockResponse({
          providers: [
            buildProvider(
              authPollCount >= 2
                ? { status: "ready", ready: true, message: "Signed in with Claude" }
                : { status: "needs_auth", ready: false, message: "Claude CLI needs sign-in" }
            )
          ]
        });
      }

      if (url.endsWith("/v1/providers/claude-cli/browser-oauth")) {
        return mockResponse({
          session: {
            id: "auth-1",
            providerId: "claude-cli",
            providerName: "Claude CLI",
            status: "running",
            message: "Complete Claude CLI sign-in in the browser",
            authorizationUrl: "https://auth.example/claude",
            authorizationCode: "",
            browserOpened: true,
            outputPreview: "Open https://auth.example/claude",
            error: ""
          }
        });
      }

      if (url.endsWith("/v1/auth-sessions/auth-1")) {
        authPollCount += 1;
        return mockResponse({
          session: {
            id: "auth-1",
            providerId: "claude-cli",
            providerName: "Claude CLI",
            status: authPollCount >= 2 ? "ready" : "running",
            message: authPollCount >= 2
              ? "Signed in with Claude"
              : "Complete Claude CLI sign-in in the browser",
            authorizationUrl: "https://auth.example/claude",
            authorizationCode: "",
            browserOpened: true,
            outputPreview: "Open https://auth.example/claude",
            error: ""
          }
        });
      }

      return mockResponse({ error: "not found" }, false, 404);
    });

    const wrapper = mountAssistant();

    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("Browser OAuth");

    await findButton(wrapper, "Browser OAuth").trigger("click");
    await flushPromises();
    await flushPromises();

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:27891/v1/providers/claude-cli/browser-oauth",
      expect.any(Object)
    );
    expect(wrapper.text()).toContain("Open authorization page");

    await new Promise((resolve) => setTimeout(resolve, 1600));
    await flushPromises();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await flushPromises();
    await flushPromises();

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:27891/v1/auth-sessions/auth-1",
      expect.any(Object)
    );
    expect(wrapper.text()).toContain("Signed in with Claude");
  });

  test("retries automatically when explorer rejects the generated query", async () => {
    const generationReplies = [
      {
        query: "Position",
        reasoning: "Shortest possible query",
        warnings: ["Position may be namespaced"],
        provider: "claude-cli",
        providerName: "Claude CLI",
        model: "cli-default"
      },
      {
        query: "game.Position",
        reasoning: "Use the namespaced component from explorer feedback",
        warnings: [],
        provider: "claude-cli",
        providerName: "Claude CLI",
        model: "cli-default"
      }
    ];

    global.fetch = jest.fn((url, options = {}) => {
      if (url.endsWith("/v1/health")) {
        return mockResponse({
          ok: true,
          configPath: "/tmp/flecs-ai-bridge.json"
        });
      }

      if (url.endsWith("/v1/providers")) {
        return mockResponse({
          providers: [buildProvider()]
        });
      }

      if (url.endsWith("/v1/generate-query")) {
        return mockResponse(generationReplies.shift());
      }

      return mockResponse({ error: "not found" }, false, 404);
    });

    const wrapper = mountAssistant();

    await flushPromises();
    await flushPromises();

    await wrapper.find("#assistant-prompt").setValue("Find all entities with position");
    await findButton(wrapper, "Generate and Run Query").trigger("click");
    await flushPromises();
    await flushPromises();

    expect(wrapper.emitted().run[0]).toEqual(["Position"]);

    await wrapper.setProps({
      query_result_state: {
        seq: 1,
        queryExpr: "Position",
        useName: false,
        value: {
          error: "unresolved identifier 'Position'"
        }
      }
    });
    await flushPromises();
    await flushPromises();

    const generationCalls = global.fetch.mock.calls.filter(([url]) => url.endsWith("/v1/generate-query"));
    expect(generationCalls).toHaveLength(2);
    expect(generationCalls[1][1].body).toContain("unresolved identifier 'Position'");
    expect(wrapper.emitted().run[1]).toEqual(["game.Position"]);
    expect(wrapper.text()).toContain("Explorer rejected query");
    expect(wrapper.text()).toContain("game.Position");
  });
});
