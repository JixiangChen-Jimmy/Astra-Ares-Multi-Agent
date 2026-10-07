import { parentPort, workerData } from "node:worker_threads";
import { Jev } from "./jev.mjs";
import { SummaryEvaluator } from "./luna-summary.mjs";
import { readKey } from "./config.mjs";
import { budgetToolOutputs } from "./tool-output-budget.mjs";

let evaluator;
function getEvaluator() {
  if (evaluator) return evaluator;
  const { config, binary, home } = workerData;
  const record = (event) => parentPort.postMessage({ type: "record", event });
  const direct = new Jev({
    apiKey: readKey(config),
    provider: config.provider,
    maxLeaseSteps: config.maxLeaseSteps,
    record,
  });
  evaluator = config.lunaSummary
    ? new SummaryEvaluator({
        jev: direct,
        binary: config.summaryCodexBinary ?? binary,
        codexHome: config.summaryCodexHome ?? home,
        summaryMaxAttempts: config.summaryMaxAttempts,
        secretEnvNames: [config.apiKeyEnv, config.routeApiKeyEnv].filter(
          Boolean,
        ),
        onSpawn: ({ pid, home: childHome }) =>
          parentPort.postMessage({ type: "child_spawn", pid, home: childHome }),
        onClose: ({ pid, home: childHome }) =>
          parentPort.postMessage({ type: "child_close", pid, home: childHome }),
        record,
      })
    : direct;
  return evaluator;
}

parentPort.on("message", async (message) => {
  if (message?.type !== "decide") return;
  try {
    const state = workerData.config.lunaSummary
      ? message.state
      : {
          ...message.state,
          recentToolCalls: budgetToolOutputs(message.state.recentToolCalls)
            .recentToolCalls,
        };
    const decision = await getEvaluator().decide(state, {
      trace: message.trace,
    });
    parentPort.postMessage({ type: "result", id: message.id, decision });
  } catch {
    parentPort.postMessage({ type: "failure", id: message.id });
  }
});
