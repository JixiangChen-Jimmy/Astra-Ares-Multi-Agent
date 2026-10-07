import assert from "node:assert/strict";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Bridge } from "../../src/bridge.mjs";
import { TaskRouter } from "../../src/task-router.mjs";
import { CodexRpc } from "./rpc.mjs";

const binary = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
mkdirSync(evidence, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "ares-route-"));
const home = join(scratch, "home");
mkdirSync(home);
const base = JSON.parse(
  readFileSync(new URL("../fixtures/models.json", import.meta.url), "utf8"),
).models[0];
const models = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"].map((slug) => ({
  ...structuredClone(base),
  slug,
  display_name: slug,
  supported_reasoning_levels: ["low", "medium", "high", "max"].map(
    (effort) => ({ effort, description: effort }),
  ),
}));
writeFileSync(join(scratch, "models.json"), JSON.stringify({ models }));
writeFileSync(
  join(home, "config.toml"),
  [
    "[agents]",
    "max_threads = 6",
    "",
    "[agents.simple_worker]",
    'description = "Fixture simple worker"',
    "",
    "[agents.luna_worker]",
    'description = "Fixture Luna worker"',
    "",
  ].join("\n"),
);

const records = [];
const requests = [];
const failures = [];
const notifications = [];
const cases = [];
const parentCases = new Map();
const sse = (item) =>
  [
    { type: "response.created", response: { id: `r-${requests.length}` } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: `r-${requests.length}`,
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 426 });
    try {
      let bytes = Buffer.from(await request.arrayBuffer());
      if (request.headers.get("content-encoding") === "zstd")
        bytes = Bun.zstdDecompressSync(bytes);
      const body = JSON.parse(bytes);
      const threadId = request.headers.get("thread-id");
      const child = body.model !== "gpt-6-astra";
      const applied = records.find(
        (record) =>
          record.type === "task_route_applied" &&
          record.childThreadId === threadId,
      );
      const scenario =
        parentCases.get(threadId) ?? parentCases.get(applied?.parentThreadId);
      assert(scenario, `unknown provider thread ${threadId}`);
      if (child) {
        assert(scenario.valid, "missing-route case spawned a child");
        assert.equal(body.model, scenario.childProviderModel);
        assert(
          applied,
          "child began inference before native applied acknowledgement",
        );
      }
      requests.push({
        name: scenario.name,
        threadId,
        model: body.model,
        child,
        body,
      });
      const item =
        !child && !scenario.called
          ? (() => {
              scenario.called = true;
              return {
                type: "function_call",
                call_id: `spawn-${scenario.name}`,
                namespace: scenario.v2 ? "routed_agents" : "multi_agent_v1",
                name: "spawn_routed_agent",
                arguments: JSON.stringify(scenario.args),
              };
            })()
          : {
              type: "message",
              id: `final-${requests.length}`,
              role: "assistant",
              content: [{ type: "output_text", text: "READY" }],
            };
      return new Response(sse(item), {
        headers: { "content-type": "text/event-stream" },
      });
    } catch (error) {
      failures.push(error.message);
      return new Response("Fixture failed", { status: 500 });
    }
  },
});
const router = new TaskRouter({
  socketPath: join(scratch, "route.sock"),
  record: (record) => records.push(record),
  selector: async (task) =>
    task.description.includes("luna")
      ? {
          status: "ok",
          mode: "live",
          confidence: 0.99,
          model: "gpt-6-luna",
          effort: "max",
        }
      : {
          status: "ok",
          mode: "live",
          confidence: 0.99,
          model: "gpt-6.1-sol",
          effort: "medium",
          ares_model_alias: "Sol-6.1-Jev",
        },
});
const bridge = new Bridge({
  socketPath: join(scratch, "step.sock"),
  record: (record) => records.push(record),
  jev: {
    decide: async () => ({
      effort: "medium",
      leaseSteps: 10,
      jevMs: 0,
      cost: "0",
    }),
  },
});
const stderr = createWriteStream(join(evidence, "stderr.log"));
const task = (description) => ({
  kind: "simple_code",
  description,
  failure_count: 0,
  uncertainty: "low",
  scope: "local",
  effects_known: true,
  data_class: "synthetic",
});
async function waitForChild(name) {
  const deadline = Date.now() + 10_000;
  while (!requests.some((request) => request.name === name && request.child)) {
    if (Date.now() >= deadline)
      throw new Error(`${name}: child did not request inference`);
    await Bun.sleep(20);
  }
}
const settings = {
  model: '"gpt-6-astra"',
  model_provider: '"fixture"',
  "model_providers.fixture": `{name="OpenAI",base_url="http://127.0.0.1:${provider.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
  model_catalog_json: JSON.stringify(join(scratch, "models.json")),
  model_reasoning_effort: '"medium"',
  "features.collab": "true",
  "features.step_model_switching": "true",
  "features.reasoning_effort_override": "true",
  "features.hooks": "false",
  "features.apps": "false",
  "features.plugins": "false",
  "features.code_mode_host": "false",
  "features.remote_models": "false",
  "features.shell_snapshot": "false",
  "analytics.enabled": "false",
  "feedback.enabled": "false",
};

async function runMode(v2) {
  const config = { ...settings, "features.multi_agent_v2": String(v2) };
  const args = Object.entries(config).flatMap(([key, value]) => [
    "-c",
    `${key}=${value}`,
  ]);
  args.push("app-server", "--stdio");
  const rpc = new CodexRpc(
    binary,
    args,
    {
      ...process.env,
      CODEX_HOME: home,
      CODEX_TASK_ROUTER_SOCKET: router.socketPath,
      CODEX_STEP_CONTROLLER_SOCKET: bridge.socketPath,
      OPENAI_API_KEY: "fixture-only",
      CODEX_API_KEY: "fixture-only",
    },
    stderr,
  );
  try {
    rpc.on("fault", (error) => failures.push(error.message));
    rpc.on("message", (message) => {
      if (message.method && message.method !== "thread/tokenUsage/updated")
        notifications.push({ method: message.method, params: message.params });
    });
    await rpc.call("initialize", {
      clientInfo: { name: "native-route-fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    rpc.send({ method: "initialized", params: {} });
    for (const valid of [false, true]) {
      const name = `${v2 ? "v2" : "v1"}-${valid ? "routed" : "missing"}`;
      const route = v2 ? task("run luna fixture") : task("run sol fixture");
      const toolArgs = v2
        ? {
            task_name: name.replaceAll("-", "_"),
            message: "Synthetic child task.",
            fork_turns: "none",
          }
        : { message: "Synthetic child task.", fork_context: false };
      if (valid)
        Object.assign(toolArgs, {
          task_route: route,
          agent_type: "reviewer",
          model: "gpt-6-astra",
          reasoning_effort: "low",
        });
      const scenario = {
        name,
        v2,
        valid,
        called: false,
        args: toolArgs,
        childProviderModel: v2 ? "gpt-6-luna" : "gpt-6.1-sol",
      };
      const created = await rpc.call("thread/start", {
        model: "gpt-6-astra",
        cwd: evidence,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const id = created.thread.id;
      parentCases.set(id, scenario);
      let finish, fail;
      const completed = new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const timer = setTimeout(
        () => fail(new Error(`Timed out: ${name}`)),
        40_000,
      );
      const onMessage = (message) => {
        if (
          message.method === "turn/completed" &&
          message.params.threadId === id
        )
          finish(message.params.turn);
      };
      rpc.on("message", onMessage);
      try {
        await rpc.call("turn/start", {
          threadId: id,
          input: [{ type: "text", text: name }],
        });
        const turn = await completed;
        assert.equal(
          turn.status,
          "completed",
          `${name}: ${JSON.stringify(turn.error)}`,
        );
        if (valid) {
          await waitForChild(name);
          const applied = records.findLast(
            (record) => record.type === "task_route_applied",
          );
          assert(applied, `${name}: no applied record`);
          assert.equal(applied.model, v2 ? "gpt-6-luna" : "Sol-6.1-Jev");
          assert.equal(applied.effort, v2 ? "max" : "medium");
          assert.equal(applied.role, v2 ? "luna_worker" : "simple_worker");
        } else {
          assert(
            !requests.some((request) => request.name === name && request.child),
          );
          assert(
            !records.some(
              (record) =>
                record.type === "task_route_applied" &&
                record.parentThreadId === id,
            ),
          );
          const followup = requests.findLast(
            (request) => request.name === name && !request.child,
          );
          assert(
            followup?.body.input?.some((item) =>
              JSON.stringify(item).includes("task_route is required"),
            ),
            `${name}: missing task route was not returned as a tool error`,
          );
        }
        cases.push({ name, passed: true, parentThreadId: id });
      } finally {
        clearTimeout(timer);
        rpc.off("message", onMessage);
      }
    }
  } finally {
    rpc.stop();
  }
}

try {
  await router.start();
  await bridge.start();
  await runMode(false);
  await runMode(true);
  assert.deepEqual(failures, []);
  const result = {
    passed: true,
    scope: "Native V1/V2 spawn with synthetic router and provider fixtures",
    cases,
    decisions: records.filter(
      (record) => record.type === "task_route_decision",
    ),
    applied: records.filter((record) => record.type === "task_route_applied"),
    childRequests: requests
      .filter((request) => request.child)
      .map(({ name, threadId, model }) => ({ name, threadId, model })),
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  writeFileSync(
    join(evidence, "diagnostic.json"),
    JSON.stringify(
      {
        error: error.message,
        records,
        requests: requests.map(({ name, threadId, model, child }) => ({
          name,
          threadId,
          model,
          child,
        })),
        notifications,
        failures,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await bridge.stop();
  await router.stop();
  provider.stop(true);
  stderr.end();
  rmSync(scratch, { recursive: true, force: true });
}
