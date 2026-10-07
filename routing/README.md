# Task-start model routing

The bundled `select_model.py` chooses a child model for a bounded task. Astra-Ares calls it through the native task router in multi-agent mode; it does not start an agent or authorize an action. Adaptive mode does not start the task router and retains the stock spawn tool.

The selector accepts JSON on stdin or from a file:

```json
{
  "kind": "simple_code",
  "description": "Change one synthetic utility with a known acceptance check.",
  "failure_count": 0,
  "uncertainty": "low",
  "scope": "local",
  "effects_known": true,
  "data_class": "synthetic"
}
```

`kind` is `core_implementation`, `simple_code`, or `execution`; the native router also handles `review`, `review_core`, and `research` with fixed rules. `uncertainty` is `low`, `moderate`, or `high`; `scope` is `local`, `cross_module`, or `core`. `data_class` is `public` or `synthetic`. Description is one line and at most 400 characters. Do not include private source, sensitive records, credentials, or internal logs. The caller must check that the description really fits its label.

Core tasks use gpt-6.1-sol high. Prior failures, high uncertainty, cross-module scope, unknown effects, service errors, and low confidence also return Sol high for Root to reassess. Eligible local code and execution tasks send one Choice to Jev: `sol_adaptive` or `luna_max`. A confident Sol choice starts `Sol-6.1-Jev` at medium effort; the native bridge adapts subsequent effort. Luna uses gpt-6-luna max. Root reclassifies work after failure, changed scope, or a new task. A route does not grant tool, spending, or external-action permission.

`ares configure-route --provider typesafe|zen --key-stdin` stores a separate routing key, or config can use `routeProvider` plus one of `routeApiKey`, `routeApiKeyEnv`, or `routeApiKeyFile`. If the main Jev provider is `typesafe` and no route credential is configured, routing reuses that TypeSafe key. For any other main provider, set a route provider and its matching credential explicitly; an OpenRouter or Vercel key cannot authenticate to the direct TypeSafe or Zen selector endpoint. The launcher passes only the selected route key to the Python child as `TYPESAFE_API_KEY` or `ZEN_API_KEY`. `ares doctor` checks its presence in multi-agent mode; `ares doctor --probe` probes only the main Jev provider and does not send a routing request.

Optional `lunaSummary: true` in config enables Luna low context summaries for Jev in either mode. `summaryMaxAttempts` accepts 1, 2, or 3. This summary setting does not change routed Luna workers, which stay at max effort.

The dated [pricing snapshot](pricing.json) is a comparison input, not a current quote or predicted bill. It records model page rates and multipliers as checked on 2026-10-07. Actual provider billing and the number of tokens needed to complete a task may differ. Selector output preserves service reported `usage` and `cost` when available; mock output is labeled `mock`.

For an offline contract check:

```sh
python3 -m unittest routing/test_select_model.py
python3 routing/select_model.py --offline task.json
```
