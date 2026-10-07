import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IsolatedEvaluator } from "../src/isolated-evaluator.mjs";

const workerUrl = new URL("./fixtures/evaluator-worker.mjs", import.meta.url);
const state = (latestUserPrompt) => ({
  model: "gpt-6-astra",
  supportedEfforts: ["low", "medium", "high"],
  previousEffort: "high",
  latestUserPrompt,
});

function evaluator(records, timeoutMs = 500) {
  return new IsolatedEvaluator({
    config: { lunaSummary: true },
    binary: "unused",
    home: "unused",
    record: (event) => records.push(event),
    timeoutMs,
    workerUrl,
  });
}

async function waitUntil(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true before deadline");
}

function stopped(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] === "Z";
  } catch {
    return true;
  }
}

test(
  "parent watchdog survives a synchronously blocked worker and next decision recovers",
  { timeout: 3000 },
  async () => {
    const records = [];
    const isolated = evaluator(records);
    try {
      const started = performance.now();
      const timed = await isolated.decide(state("block"), {
        trace: { threadId: "thread-a", turnId: "turn-a", step: 1 },
      });
      assert(performance.now() - started < 1200);
      assert.equal(timed.effort, "high");
      assert.equal(timed.leaseSteps, 1);
      assert.equal(timed.requestStats.reason, "timeout");
      assert.equal(records.at(-1).phase, "outer_watchdog");
      assert.equal(records.at(-1).reason, "timeout");
      const next = await isolated.decide(state("success"), {
        trace: { threadId: "thread-a", turnId: "turn-a", step: 2 },
      });
      assert.equal(next.effort, "low");
      assert.equal(next.calls, 1);
    } finally {
      await isolated.close();
    }
  },
);

test(
  "healthy worker retains state for sequential decisions",
  { timeout: 3000 },
  async () => {
    const isolated = evaluator([]);
    try {
      const trace = { threadId: "thread-b", turnId: "turn-b" };
      assert.equal(
        (await isolated.decide(state("success"), { trace })).calls,
        1,
      );
      assert.equal(
        (await isolated.decide(state("success"), { trace })).calls,
        2,
      );
    } finally {
      await isolated.close();
    }
  },
);

test(
  "worker crash gives one-step fallback and later recovery",
  { timeout: 3000 },
  async () => {
    const records = [];
    const isolated = evaluator(records);
    try {
      const trace = { threadId: "thread-c", turnId: "turn-c" };
      const failed = await isolated.decide(state("crash"), { trace });
      assert.equal(failed.requestStats.reason, "worker_failure");
      assert.equal(failed.leaseSteps, 1);
      assert.equal(
        (await isolated.decide(state("success"), { trace })).effort,
        "low",
      );
    } finally {
      await isolated.close();
    }
  },
);

test(
  "cancelled turn rejects and disposes its blocked worker",
  { timeout: 3000 },
  async () => {
    const records = [];
    const isolated = evaluator(records, 1000);
    try {
      const controller = new AbortController();
      const trace = { threadId: "thread-d", turnId: "turn-d" };
      const pending = isolated.decide(state("block"), {
        signal: controller.signal,
        trace,
      });
      controller.abort(new Error("turn disconnected"));
      await assert.rejects(pending, /turn disconnected/);
      assert.equal(records.length, 0);
      assert.equal(
        (await isolated.decide(state("success"), { trace })).calls,
        1,
      );
    } finally {
      await isolated.close();
    }
  },
);

test(
  "timeout stops its reported child, removes its home, and leaves other children alive",
  { timeout: 5000, skip: process.platform !== "linux" },
  async () => {
    const before = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith("ares-luna-")),
    );
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const isolated = evaluator([], 300);
    try {
      const result = await isolated.decide(state("spawn-block"), {
        trace: { threadId: "child-thread", turnId: "child-turn" },
      });
      assert.equal(result.requestStats.reason, "timeout");
      const names = readdirSync(tmpdir()).filter(
        (name) => name.startsWith("ares-luna-") && !before.has(name),
      );
      assert.equal(names.length, 1);
      const home = join(tmpdir(), names[0]);
      const pid = Number(readFileSync(join(home, "pid"), "utf8"));
      await waitUntil(() => stopped(pid) && !existsSync(home));
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    } finally {
      unrelated.kill("SIGTERM");
      await isolated.close();
    }
  },
);
