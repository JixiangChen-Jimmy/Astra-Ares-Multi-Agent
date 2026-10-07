import { test } from "node:test";
import assert from "node:assert/strict";
import { SummaryEvaluator } from "../src/luna-summary.mjs";

const summary = {
  current_goal: "Repair routing",
  latest_user_intent: "Apply the latest correction",
  constraints: ["Preserve the source"],
  verified_done: ["Mock test passed"],
  unresolved: ["Live outcome unknown"],
  recent_evidence: ["A failure was observed"],
  next_work: ["Inspect the result"],
  uncertainty: ["Provider limit unknown"],
  source_refs: ["latestUserPrompt", "priorUserPrompts"],
};
const state = () => ({
  model: "gpt-6-astra",
  supportedEfforts: ["low", "medium", "high"],
  latestUserPrompt: "Apply the latest correction",
  priorUserPrompts: ["middle evidence ".repeat(100)],
  publicNotes: [],
  recentToolCalls: [],
  step: 7,
  previousEffort: "high",
  newToolFailures: 2,
});

test("small states reach Jev unchanged", async () => {
  const original = state();
  let seen;
  let options;
  const evaluator = new SummaryEvaluator({
    jev: {
      decide: async (input, opts) => {
        seen = input;
        options = opts;
        return { effort: "low", leaseSteps: 2 };
      },
    },
    summarize: () => {
      throw new Error("unexpected Luna call");
    },
  });
  assert.equal((await evaluator.decide(original)).effort, "low");
  assert.strictEqual(seen, original);
  assert.equal(options.allowCompaction, false);
  evaluator.close();
});

test("oversized state is summarized, immutable, and reused only for identical thread state", async () => {
  const original = state();
  const snapshot = structuredClone(original);
  const records = [];
  const inputs = [];
  const lunaInputs = [];
  const jevOptions = [];
  let calls = 0;
  const evaluator = new SummaryEvaluator({
    jev: {
      decide: async (input, opts) => {
        inputs.push(input);
        jevOptions.push(opts);
        return { effort: "medium", leaseSteps: 1 };
      },
    },
    summarize: async (body) => {
      calls++;
      lunaInputs.push(JSON.parse(body));
      return JSON.stringify(summary);
    },
    record: (event) => records.push(event),
    thresholdBytes: 100,
  });
  const options = { trace: { threadId: "thread-a", step: 7 } };
  await evaluator.decide(original, options);
  await evaluator.decide(original, options);
  assert.equal(calls, 1);
  assert.deepEqual(original, snapshot);
  assert.equal(inputs[0].model, original.model);
  assert.deepEqual(inputs[0].supportedEfforts, original.supportedEfforts);
  assert.equal(inputs[0].step, 7);
  assert.equal(inputs[0].previousEffort, "high");
  assert.equal(inputs[0].newToolFailures, 2);
  assert.equal(inputs[0].latestUserPrompt, summary.latest_user_intent);
  assert.equal(inputs[0].originalTask, summary.current_goal);
  assert.equal(inputs[0].priorUserPrompts, undefined);
  assert.equal(lunaInputs[0].previousEffort, undefined);
  assert.equal(lunaInputs[0].newToolFailures, undefined);
  assert.equal(lunaInputs[0].step, undefined);
  assert.equal(jevOptions[0].allowCompaction, false);
  assert.equal(
    records.filter((event) => event.type === "luna_summary")[1].cached,
    true,
  );
  assert(!JSON.stringify(records).includes("middle evidence"));
  await evaluator.decide(
    { ...original, step: 8, previousEffort: "medium", newToolFailures: 3 },
    options,
  );
  assert.equal(calls, 1);
  assert.equal(inputs.at(-1).step, 8);
  assert.equal(inputs.at(-1).previousEffort, "medium");
  assert.equal(inputs.at(-1).newToolFailures, 3);
  await evaluator.decide(
    { ...original, latestUserPrompt: "A new correction" },
    options,
  );
  assert.equal(calls, 2);
  evaluator.close();
});

test("summary failure returns an audited supported one-step fallback", async () => {
  const records = [];
  let jevCalls = 0;
  const evaluator = new SummaryEvaluator({
    jev: {
      decide: async () => {
        jevCalls++;
      },
    },
    summarize: async () => {
      throw new Error("private source content");
    },
    thresholdBytes: 100,
    record: (event) => records.push(event),
  });
  const decision = await evaluator.decide(state());
  assert.equal(decision.effort, "high");
  assert.equal(decision.leaseSteps, 1);
  assert.equal(decision.requestStats.reason, "summary_failure");
  assert.equal(jevCalls, 0);
  assert.equal(records.at(-1).type, "summary_evaluator_fallback");
  assert.equal(
    records.filter((event) => event.type === "luna_summary_attempt").length,
    1,
  );
  assert(!JSON.stringify(records).includes("private source content"));
  evaluator.close();
});

test("Jev failure after summarization falls back and records evaluator phase", async () => {
  const records = [];
  const evaluator = new SummaryEvaluator({
    jev: {
      decide: async () => {
        throw new Error("upstream unavailable");
      },
    },
    summarize: async () => JSON.stringify(summary),
    thresholdBytes: 100,
    record: (event) => records.push(event),
  });
  const decision = await evaluator.decide({
    ...state(),
    previousEffort: "unsupported",
  });
  assert.equal(decision.effort, "medium");
  assert.equal(decision.leaseSteps, 1);
  assert.equal(records.at(-1).phase, "jev");
  evaluator.close();
});

test("external abort propagates; summary timeout falls back within budget", async () => {
  const controller = new AbortController();
  const evaluator = new SummaryEvaluator({
    jev: { decide: async () => ({ effort: "low", leaseSteps: 1 }) },
    summarize: () => new Promise(() => {}),
    thresholdBytes: 100,
    summaryTimeoutMs: 15,
  });
  const timed = await evaluator.decide(state());
  assert.equal(timed.requestStats.reason, "timeout");
  const pending = evaluator.decide(state(), { signal: controller.signal });
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(pending, /caller cancelled/);
  evaluator.close();
});

test("a timed-out summary closes only its own RPC", async () => {
  const instances = [];
  const evaluator = new SummaryEvaluator({
    jev: { decide: async () => ({ effort: "low", leaseSteps: 1 }) },
    rpcFactory: () => {
      const instance = {
        closed: false,
        summarize: (body) =>
          JSON.parse(body).latestUserPrompt === "hang"
            ? new Promise(() => {})
            : new Promise((resolve) =>
                setTimeout(() => resolve(JSON.stringify(summary)), 5),
              ),
        close() {
          this.closed = true;
        },
      };
      instances.push(instance);
      return instance;
    },
    thresholdBytes: 100,
    summaryTimeoutMs: 20,
    summaryMaxAttempts: 1,
  });
  const [timed, successful] = await Promise.all([
    evaluator.decide(
      { ...state(), latestUserPrompt: "hang" },
      { trace: { threadId: "a" } },
    ),
    evaluator.decide(
      { ...state(), latestUserPrompt: "complete" },
      { trace: { threadId: "b" } },
    ),
  ]);
  assert.equal(instances.length, 2);
  assert(instances.every((instance) => instance.closed));
  assert.equal(timed.requestStats.reason, "timeout");
  assert.equal(successful.effort, "low");
  assert.equal(successful.provider, undefined);
  evaluator.close();
});

test("transient Luna failure retries once and succeeds within the summary budget", async () => {
  const records = [];
  let calls = 0;
  const evaluator = new SummaryEvaluator({
    jev: { decide: async () => ({ effort: "low", leaseSteps: 2 }) },
    summarize: async () => {
      calls++;
      if (calls === 1) throw new Error("Luna app-server exited");
      return JSON.stringify(summary);
    },
    record: (event) => records.push(event),
    thresholdBytes: 100,
  });
  const decision = await evaluator.decide(state());
  assert.equal(calls, 2);
  assert.equal(decision.leaseSteps, 2);
  assert.equal(records[0].type, "luna_summary_retry");
  assert.equal(records[0].reason, "transport");
  assert.equal(records[1].attempt, 2);
  evaluator.close();
});

test("invalid summary does not retry or call Jev", async () => {
  let calls = 0;
  let jevCalls = 0;
  const evaluator = new SummaryEvaluator({
    jev: {
      decide: async () => {
        jevCalls++;
      },
    },
    summarize: async () => {
      calls++;
      return "{}";
    },
    thresholdBytes: 100,
  });
  const decision = await evaluator.decide(state());
  assert.equal(calls, 1);
  assert.equal(jevCalls, 0);
  assert.equal(decision.requestStats.reason, "summary_failure");
  evaluator.close();
});

test("caller cancellation during retry propagates without another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const evaluator = new SummaryEvaluator({
    jev: { decide: async () => ({ effort: "low", leaseSteps: 1 }) },
    summarize: async () => {
      calls++;
      if (calls === 1) throw new Error("Luna app-server exited");
      return new Promise(() => {});
    },
    thresholdBytes: 100,
    summaryTimeoutMs: 100,
  });
  const pending = evaluator.decide(state(), { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(pending, /caller cancelled/);
  assert.equal(calls, 2);
  evaluator.close();
});

test("summary attempts share one deadline and leave time for fallback", async () => {
  const records = [];
  let attempts = 0;
  const evaluator = new SummaryEvaluator({
    jev: {
      decide: async () => {
        throw new Error("should not call Jev");
      },
    },
    summarize: () => {
      attempts++;
      if (attempts === 1) throw new Error("Luna app-server exited");
      return new Promise(() => {});
    },
    thresholdBytes: 100,
    summaryTimeoutMs: 45,
    decisionTimeoutMs: 3_100,
    record: (event) => records.push(event),
  });
  const start = performance.now();
  const decision = await evaluator.decide(state());
  const elapsed = performance.now() - start;
  assert.equal(decision.leaseSteps, 1);
  assert.equal(decision.requestStats.reason, "timeout");
  assert(elapsed < 90, `elapsed ${elapsed} ms`);
  assert.equal(attempts, 2);
  assert.equal(
    records.filter((event) => event.type === "luna_summary_retry").length,
    1,
  );
  evaluator.close();
});
