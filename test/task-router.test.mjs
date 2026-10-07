import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseRoute,
  runSelector,
  TaskRouter,
  validateRoute,
} from "../src/task-router.mjs";
import { validateConfig } from "../src/config.mjs";

const task = (kind = "simple_code") => ({
  kind,
  description: "Change one synthetic utility with a known acceptance check.",
  failure_count: 0,
  uncertainty: "low",
  scope: "local",
  effects_known: true,
  data_class: "synthetic",
});
const request = (routeId = "route-1", kind = "simple_code") => ({
  protocol: 1,
  type: "route",
  routeId,
  parentThreadId: "parent-1",
  requestedRole: "luna_worker",
  task: task(kind),
});
const selectorResult = (model) => ({
  status: "ok",
  mode: "live",
  confidence: 0.95,
  live_attempted: true,
  usage: { input_tokens: 42, output_tokens: 5 },
  cost: 0.001,
  model,
  effort: model === "gpt-6-luna" ? "max" : "medium",
  ares_model_alias: model === "gpt-6.1-sol" ? "Sol-6.1-Jev" : null,
});

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
async function exchange(path, message) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let bytes = Buffer.alloc(0);
    socket.on("connect", () => socket.write(frame(message)));
    socket.on("data", (part) => {
      bytes = Buffer.concat([bytes, part]);
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        assert(bytes.length >= 4);
        assert.equal(bytes.readUInt32BE(0), bytes.length - 4);
        resolve(JSON.parse(bytes.subarray(4)));
      } catch (error) {
        reject(error);
      }
    });
  });
}
async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for subprocess state");
}
function isRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
  if (process.platform === "linux") {
    try {
      const state = readFileSync(`/proc/${pid}/stat`, "utf8").match(
        /\) ([A-Z])/,
      )?.[1];
      if (state === "Z" || state === "X") return false;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

test("multi-agent routing uses bundled selector and validates custom paths", () => {
  assert.equal(
    validateConfig({ provider: "openrouter", mode: "multi-agent" }).mode,
    "multi-agent",
  );
  assert.throws(
    () =>
      validateConfig({
        provider: "openrouter",
        mode: "multi-agent",
        taskRouterScript: "relative.py",
      }),
    /absolute path/,
  );
  assert.equal(
    validateConfig({
      provider: "openrouter",
      mode: "multi-agent",
      taskRouterScript: "/tmp/select_model.py",
    }).taskRouterScript,
    "/tmp/select_model.py",
  );
});

test("missing metadata fails and requested role cannot bypass fixed rules", async () => {
  const bad = request();
  delete bad.task.failure_count;
  assert.throws(() => validateRoute(bad), /metadata/);
  const extra = request();
  extra.task.private_note = "untrusted";
  assert.throws(() => validateRoute(extra), /metadata/);
  for (const [kind, model, effort] of [
    ["core_implementation", "gpt-6.1-sol", "high"],
    ["review", "gpt-6-astra", "low"],
    ["review_core", "gpt-6-astra", "medium"],
    ["research", "gpt-6.1-sol", "high"],
  ]) {
    const answer = await chooseRoute(task(kind), {
      selector: () => assert.fail("selector called"),
    });
    assert.deepEqual([answer.model, answer.effort], [model, effort]);
  }
  const core = request("core-1", "core_implementation");
  assert.equal(core.requestedRole, "luna_worker");
  assert.equal((await chooseRoute(core.task)).model, "gpt-6.1-sol");
});

test("live eligible selection yields exact Sol alias or Luna max", async () => {
  for (const [model, kind, expectedModel, expectedRole] of [
    ["gpt-6.1-sol", "simple_code", "Sol-6.1-Jev", "simple_worker"],
    ["gpt-6-luna", "execution", "gpt-6-luna", "luna_executor"],
  ]) {
    const answer = await chooseRoute(task(kind), {
      selector: async () => selectorResult(model),
    });
    assert.equal(answer.model, expectedModel);
    assert.equal(answer.role, expectedRole);
    assert.equal(answer.source, "jev_live");
  }
});

test("failure, uncertainty, mock output and timeout fall back to Sol high", async () => {
  const failed = { ...task(), failure_count: 1 };
  assert.equal(
    (await chooseRoute(failed)).reason,
    "prior_failure_requires_root",
  );
  const uncertain = { ...task(), scope: "cross_module" };
  assert.equal((await chooseRoute(uncertain)).effort, "high");
  for (const result of [
    { ...selectorResult("gpt-6-luna"), mode: "mock" },
    { status: "timeout" },
    { ...selectorResult("gpt-6-luna"), confidence: 0.7 },
    { ...selectorResult("gpt-6-luna"), confidence: Number.NaN },
  ]) {
    const answer = await chooseRoute(task(), { selector: async () => result });
    assert.equal(answer.model, "gpt-6.1-sol");
    assert.equal(answer.effort, "high");
  }
});

test("selector subprocess times out and cancels without a route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-router-selector-"));
  const script = join(dir, "slow.py");
  writeFileSync(script, "import time\ntime.sleep(10)\n");
  try {
    const timed = await runSelector(task(), { script, timeoutMs: 30 });
    assert.equal(timed.status, "timeout");
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      runSelector(task(), { script, signal: abort.signal }),
      /aborted/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "in-flight selector cancellation kills its subprocess group",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ares-router-group-"));
    const script = join(dir, "spawn.py");
    const pidsFile = join(dir, "pids.json");
    writeFileSync(
      script,
      [
        "import json, os, subprocess, sys, time",
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])",
        `with open(${JSON.stringify(pidsFile)}, 'w') as file: json.dump([os.getpid(), child.pid], file)`,
        "time.sleep(30)",
      ].join("\n") + "\n",
    );
    const abort = new AbortController();
    let pids;
    try {
      const running = runSelector(task(), {
        script,
        signal: abort.signal,
        timeoutMs: 5000,
      });
      await waitFor(() => {
        if (!existsSync(pidsFile)) return false;
        try {
          return Array.isArray(JSON.parse(readFileSync(pidsFile, "utf8")));
        } catch {
          return false;
        }
      });
      pids = JSON.parse(readFileSync(pidsFile, "utf8"));
      assert(pids.every(isRunning));
      abort.abort();
      assert.equal((await running).status, "cancelled");
      await waitFor(() => pids.every((pid) => !isRunning(pid)));
    } finally {
      abort.abort();
      if (pids?.[0]) {
        try {
          process.kill(-pids[0], "SIGKILL");
        } catch {
          /* exited */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("route capacity and TTL reject stale applied confirmations", async () => {
  let now = 1000;
  const router = new TaskRouter({
    socketPath: "/unused",
    script: "/unused",
    now: () => now,
    pendingTtlMs: 100,
    replayTtlMs: 200,
    maxPendingRoutes: 1,
    maxRememberedIds: 2,
  });
  const first = request("route-1", "core_implementation");
  const second = request("route-2", "core_implementation");
  await router.handle(first);
  await assert.rejects(router.handle(second), /capacity/);
  assert.equal(router.pending.size, 1);
  now = 1101;
  const staleApplied = {
    protocol: 1,
    type: "route_applied",
    routeId: "route-1",
    parentThreadId: "parent-1",
    childThreadId: "child-1",
    model: "gpt-6.1-sol",
    effort: "high",
    confirmation: "native_child_context_captured",
  };
  await assert.rejects(router.handle(staleApplied), /does not match/);
  assert.equal(router.pending.size, 0);
  await router.handle(second);
  await assert.rejects(router.handle(first), /Duplicate route ID/);
  assert.equal(router.usedRouteIds.size, 2);
  now = 1402;
  await assert.rejects(
    router.handle({ ...staleApplied, routeId: "route-2" }),
    /does not match/,
  );
  assert.equal(router.usedRouteIds.size, 0);
  await router.handle(first);
  assert.equal(router.pending.size, 1);
});

test("in-flight routes count toward capacity", async () => {
  let complete;
  const router = new TaskRouter({
    socketPath: "/unused",
    script: "/unused",
    maxPendingRoutes: 1,
    maxRememberedIds: 2,
    selector: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const first = router.handle(request("route-1"));
  assert.equal(router.inflightRoutes.size, 1);
  await assert.rejects(router.handle(request("route-2")), /capacity/);
  complete(selectorResult("gpt-6-luna"));
  await first;
  assert.equal(router.inflightRoutes.size, 0);
  assert.equal(router.pending.size, 1);
});

test("remembered route and child IDs stay bounded until replay TTL expires", async () => {
  let now = 0;
  const router = new TaskRouter({
    socketPath: "/unused",
    script: "/unused",
    now: () => now,
    pendingTtlMs: 100,
    replayTtlMs: 200,
    maxPendingRoutes: 2,
    maxRememberedIds: 2,
  });
  for (let id = 1; id <= 2; id++) {
    await router.handle(request(`route-${id}`, "core_implementation"));
    await router.handle({
      protocol: 1,
      type: "route_applied",
      routeId: `route-${id}`,
      parentThreadId: "parent-1",
      childThreadId: `child-${id}`,
      model: "gpt-6.1-sol",
      effort: "high",
      confirmation: "native_child_context_captured",
    });
  }
  assert.equal(router.usedRouteIds.size, 2);
  assert.equal(router.usedChildIds.size, 2);
  await assert.rejects(
    router.handle(request("route-3", "core_implementation")),
    /capacity/,
  );
  now = 301;
  await router.handle(request("route-3", "core_implementation"));
  assert.equal(router.usedRouteIds.size, 1);
  assert.equal(router.usedChildIds.size, 0);
});

test("wire audit accepts exact applied confirmation once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-router-wire-"));
  const records = [];
  const router = new TaskRouter({
    socketPath: join(dir, "router.sock"),
    script: "/unused",
    record: (event) => records.push(event),
    selector: async () => selectorResult("gpt-6-luna"),
  });
  await router.start();
  try {
    const decision = await exchange(router.socketPath, request());
    assert.deepEqual(
      [decision.type, decision.model, decision.effort, decision.role],
      ["route_decision", "gpt-6-luna", "max", "luna_worker"],
    );
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].usage, { input_tokens: 42, output_tokens: 5 });
    assert.equal(records[0].cost, 0.001);
    assert.equal((await exchange(router.socketPath, request())).type, "error");
    const applied = {
      protocol: 1,
      type: "route_applied",
      routeId: "route-1",
      parentThreadId: "parent-1",
      childThreadId: "child-1",
      model: "gpt-6-luna",
      effort: "max",
      confirmation: "native_child_context_captured",
    };
    assert.equal(
      (await exchange(router.socketPath, { ...applied, model: "gpt-6.1-sol" }))
        .type,
      "error",
    );
    assert.equal(router.completedRoutes, 0);
    assert.equal(
      (await exchange(router.socketPath, applied)).type,
      "route_applied_ack",
    );
    assert.equal((await exchange(router.socketPath, applied)).type, "error");
    assert.equal(router.completedRoutes, 1);
    assert.equal(records.length, 2);
    assert.equal(records[0].type, "task_route_decision");
    assert.equal(records[1].confirmation, "native_child_context_captured");
    assert(!JSON.stringify(records).includes(task().description));
  } finally {
    await router.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disconnect aborts pending selection without a decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-router-cancel-"));
  let stopped = false;
  const router = new TaskRouter({
    socketPath: join(dir, "router.sock"),
    script: "/unused",
    selector: (_task, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            resolve({ status: "cancelled" });
          },
          { once: true },
        );
      }),
  });
  await router.start();
  try {
    const socket = createConnection(router.socketPath);
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(frame(request("cancel-1")));
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stopped, true);
    assert.equal(router.pending.size, 0);
  } finally {
    await router.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
