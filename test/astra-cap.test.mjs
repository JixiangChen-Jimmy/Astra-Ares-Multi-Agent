import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnEvaluator } from "../src/bridge.mjs";

const allEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

function checkpoint({
  model = "gpt-6-astra",
  supportedEfforts = allEfforts,
  currentEffort = "ultra",
  step = 1,
} = {}) {
  return {
    protocol: 3,
    type: "checkpoint",
    threadId: "thread",
    turnId: "turn",
    step,
    model,
    supportedEfforts,
    currentEffort,
    failedToolCount: 0,
    inputRevision: 1,
    context: {
      schema: "CODEX_STEP_CONTROLLER_CONTEXT_V3",
      scope: "native_retained_history",
      latestUserPrompt: "Implement the requested change",
      originalTurnPrompt: "Implement the requested change",
      publicNotes: [],
      recentToolCalls: [],
      priorUserPrompts: [],
      omittedOlderToolCalls: 0,
    },
  };
}

async function confirm(evaluator, decision) {
  await evaluator.handle({
    ...decision,
    type: "applied",
    confirmation: "native_step_context_captured",
  });
}

for (const model of ["gpt-6-astra", "Astra-Jev"]) {
  test(`${model} exposes no effort above high to Jev`, async () => {
    let evaluated;
    const evaluator = new TurnEvaluator({
      record: () => {},
      jev: {
        decide: async (state) => {
          evaluated = state;
          return { effort: "high", leaseSteps: 1, jevMs: 1 };
        },
      },
    });

    const decision = await evaluator.handle(checkpoint({ model }));
    assert.deepEqual(evaluated.supportedEfforts, [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    assert.equal(evaluated.previousEffort, "ultra");
    assert.equal(decision.effort, "high");
  });
}

test("Astra clamps an evaluator effort above high and records both values", async () => {
  const records = [];
  const evaluator = new TurnEvaluator({
    record: (event) => records.push(event),
    jev: {
      decide: async () => ({ effort: "ultra", leaseSteps: 1, jevMs: 1 }),
    },
  });

  const decision = await evaluator.handle(checkpoint());
  assert.equal(decision.effort, "high");
  await confirm(evaluator, decision);

  const applied = records.find((event) => event.type === "decision");
  assert.equal(applied.effort, "high");
  assert.equal(applied.originalEffort, "ultra");
  assert.equal(applied.appliedEffort, "high");
  assert.equal(applied.previousEffort, "ultra");
  assert.deepEqual(
    records.find((event) => event.type === "effort_selected"),
    {
      type: "effort_selected",
      threadId: "thread",
      turnId: "turn",
      step: 1,
      from: "ultra",
      to: "high",
      confirmation: "native_step_context_captured",
    },
  );
});

test("a reused Astra lease remains capped at high", async () => {
  let evaluations = 0;
  const evaluator = new TurnEvaluator({
    record: () => {},
    jev: {
      decide: async () => {
        evaluations++;
        return { effort: "ultra", leaseSteps: 2, jevMs: 1 };
      },
    },
  });

  const first = await evaluator.handle(checkpoint());
  await confirm(evaluator, first);
  const second = await evaluator.handle(
    checkpoint({ currentEffort: "high", step: 2 }),
  );
  assert.equal(second.effort, "high");
  assert.equal(evaluations, 1);
});

test("Astra refuses checkpoints with no supported effort at or below high", async () => {
  let evaluations = 0;
  const evaluator = new TurnEvaluator({
    record: () => {},
    jev: {
      decide: async () => {
        evaluations++;
        return { effort: "ultra", leaseSteps: 1, jevMs: 1 };
      },
    },
  });

  await assert.rejects(
    evaluator.handle(
      checkpoint({ supportedEfforts: ["xhigh", "max", "ultra"] }),
    ),
    /Astra requires a supported effort at or below high/,
  );
  assert.equal(evaluations, 0);
});

for (const model of ["gpt-6-sol", "gpt-6-luna"]) {
  test(`${model} keeps its full supported effort range`, async () => {
    let evaluated;
    const evaluator = new TurnEvaluator({
      record: () => {},
      jev: {
        decide: async (state) => {
          evaluated = state;
          return { effort: "max", leaseSteps: 1, jevMs: 1 };
        },
      },
    });

    const decision = await evaluator.handle(
      checkpoint({ model, currentEffort: "low" }),
    );
    assert.deepEqual(evaluated.supportedEfforts, allEfforts);
    assert.equal(decision.effort, "max");
  });
}
