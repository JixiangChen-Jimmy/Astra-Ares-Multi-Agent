import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexRpc } from "./rpc.mjs";

const stockBinary = resolve(process.argv[2]);
const patchedBinary = resolve(process.argv[3]);
const evidence = resolve(process.argv[4]);
mkdirSync(evidence, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "ares-stock-schema-"));
const model = JSON.parse(
  readFileSync(new URL("../fixtures/models.json", import.meta.url), "utf8"),
).models[0];
writeFileSync(
  join(scratch, "models.json"),
  JSON.stringify({ models: [model] }),
);

const requests = [];
const response = [
  { type: "response.created", response: { id: "schema-check" } },
  {
    type: "response.output_item.done",
    item: {
      type: "message",
      id: "schema-result",
      role: "assistant",
      content: [{ type: "output_text", text: "READY" }],
    },
  },
  {
    type: "response.completed",
    response: {
      id: "schema-check",
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
    let bytes = Buffer.from(await request.arrayBuffer());
    if (request.headers.get("content-encoding") === "zstd")
      bytes = Bun.zstdDecompressSync(bytes);
    requests.push(JSON.parse(bytes));
    return new Response(response, {
      headers: { "content-type": "text/event-stream" },
    });
  },
});

function spawnSpec(request) {
  const advertised = [
    ...(request.tools ?? []),
    ...(request.input ?? [])
      .filter((item) => item.type === "additional_tools")
      .flatMap((item) => item.tools ?? []),
  ];
  for (const tool of advertised) {
    if (tool.name === "spawn_agent") return schemaContract(null, tool);
    const nested = tool.tools?.find((entry) => entry.name === "spawn_agent");
    if (nested) return schemaContract(tool.name, nested);
  }
  throw new Error(
    `stock spawn_agent tool was not advertised: ${JSON.stringify(advertised.map((tool) => [tool.type, tool.name, tool.tools?.map((entry) => entry.name)]))}`,
  );
}

function schemaContract(namespace, tool) {
  return {
    namespace,
    name: tool.name,
    strict: tool.strict,
    defer_loading: tool.defer_loading,
    parameters: tool.parameters,
    output_schema: tool.output_schema,
  };
}

async function capture(binary, v2) {
  const home = mkdtempSync(join(scratch, "home-"));
  const config = {
    model: '"gpt-6-astra"',
    model_provider: '"fixture"',
    "model_providers.fixture": `{name="OpenAI",base_url="http://127.0.0.1:${provider.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
    model_catalog_json: JSON.stringify(join(scratch, "models.json")),
    "features.collab": "true",
    "features.multi_agent_v2": String(v2),
    "features.hooks": "false",
    "features.apps": "false",
    "features.plugins": "false",
    "features.remote_models": "false",
    "features.shell_snapshot": "false",
    "analytics.enabled": "false",
  };
  const args = Object.entries(config).flatMap(([key, value]) => [
    "-c",
    `${key}=${value}`,
  ]);
  args.push("app-server", "--stdio");
  const env = {
    ...process.env,
    CODEX_HOME: home,
    OPENAI_API_KEY: "fixture-only",
  };
  delete env.CODEX_TASK_ROUTER_SOCKET;
  const rpc = new CodexRpc(binary, args, env);
  try {
    await rpc.call("initialize", {
      clientInfo: { name: "stock-schema-fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    rpc.send({ method: "initialized", params: {} });
    const started = await rpc.call("thread/start", {
      model: "gpt-6-astra",
      cwd: evidence,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const threadId = started.thread.id;
    const firstRequest = requests.length;
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("turn timed out")),
        30_000,
      );
      rpc.on("message", (message) => {
        if (
          message.method === "turn/completed" &&
          message.params.threadId === threadId
        ) {
          clearTimeout(timer);
          resolve(message.params.turn);
        }
      });
    });
    await rpc.call("turn/start", {
      threadId,
      input: [{ type: "text", text: "Inspect the available spawn tool." }],
    });
    const turn = await completed;
    assert.equal(turn.status, "completed", JSON.stringify(turn.error));
    assert(requests[firstRequest], "provider received no request");
    return spawnSpec(requests[firstRequest]);
  } finally {
    rpc.stop();
  }
}

try {
  const cases = [];
  for (const v2 of [false, true]) {
    const stock = await capture(stockBinary, v2);
    const patched = await capture(patchedBinary, v2);
    assert.deepEqual(patched, stock, `V${v2 ? 2 : 1} spawn schema differs`);
    cases.push({ mode: v2 ? "v2" : "v1", passed: true, schema: stock });
  }
  const result = { passed: true, cases };
  writeFileSync(
    join(evidence, "stock-spawn-schema.json"),
    JSON.stringify(result, null, 2),
  );
  console.log("Stock spawn tool schemas match in V1 and V2");
} finally {
  provider.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
