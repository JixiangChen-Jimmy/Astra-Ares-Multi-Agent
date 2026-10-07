# Configuration

The persistent config is `~/.config/astra-ares-multi-agent/config.json`; `ARES_CONFIG` overrides it. Runtime files and history use `~/.local/share/astra-ares-multi-agent`; `ARES_HOME` overrides that base directory. Both modes use the same `codexHome`. This project does not read the development machine's `CT_ARES_CONFIG` setting.

```sh
ares config-path
ares mode                 # show saved mode
ares mode adaptive
ares mode multi-agent
astra-ares --ares-mode adaptive -C /path/to/project
```

Changing mode affects the next launch, including `resume`; it does not mutate running processes or copy history between directories.

## Effort-evaluator credentials

| `provider`   | Credential environment variable |
| ------------ | ------------------------------- |
| `typesafe`   | `TYPESAFE_API_KEY`              |
| `openrouter` | `OPENROUTER_API_KEY`            |
| `vercel`     | `AI_GATEWAY_API_KEY`            |

New configurations default to OpenRouter unless selected explicitly. The quick-start examples select direct TypeSafe because its key can also serve the multi-agent task selector.

```sh
ares configure --provider typesafe
```

The hidden prompt saves a private key to the user config with mode `0600`. A password manager can pipe a key with `ares configure --provider typesafe --key-stdin`. Choose one of `apiKey`, `apiKeyEnv`, or `apiKeyFile`; do not commit a filled config. Model inference uses separate Codex authentication.

## Multi-agent task-routing credentials

With `provider: "typesafe"`, the route selector defaults to TypeSafe and reuses the configured effort-evaluator credential. If you use OpenRouter or Vercel for effort decisions, configure a separate compatible route credential:

```sh
ares configure-route --provider typesafe
ares mode multi-agent
ares doctor
```

`routeProvider` supports `typesafe` and the legacy `zen` adapter. Set one of `routeApiKey`, `routeApiKeyEnv`, or `routeApiKeyFile`; the default routing environment variables are `TYPESAFE_API_KEY` and `ZEN_API_KEY`, respectively. Never use an OpenRouter/Vercel key as a direct TypeSafe key. Only the selected routing credential is passed to the selector subprocess. Missing route credentials are reported before launching multi-agent mode.

`ares doctor` checks local binary compatibility and credential presence. `ares doctor --probe` makes one billable effort-evaluator request. It does not test every model, the separate routing provider, or long-running multi-agent behavior.

## Example

```json
{
  "mode": "adaptive",
  "provider": "typesafe",
  "apiKeyEnv": "TYPESAFE_API_KEY",
  "maxLeaseSteps": 5,
  "lunaSummary": false
}
```

| Field                | Meaning                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `mode`               | `adaptive` (default) or `multi-agent`                                       |
| `maxLeaseSteps`      | `1`, `2` or `5`; maximum generations per Jev decision, default `5`          |
| `codexBinary`        | Absolute path to the compatible patched native executable                   |
| `codexHome`          | Optional absolute path for shared history/config                            |
| `lunaSummary`        | Enable Luna low semantic summarization before effort selection; default off |
| `summaryCodexBinary` | Optional compatible Codex executable for summary requests                   |
| `summaryCodexHome`   | Optional profile for summary model/provider configuration                   |
| `summaryMaxAttempts` | `1`, `2` or `3`, including the first attempt, within the shared deadline    |
| `routeProvider`      | Optional explicit routing provider                                          |
| `taskRouterScript`   | Optional absolute selector path; the bundled selector is the default        |

`taskRouting` is a legacy compatibility setting. Prefer `mode`; `ares mode` removes the legacy flag when switching. Contradictory adaptive/routing settings are rejected.

## Optional Luna low summarization

Edit the file printed by `ares config-path` to set `"lunaSummary": true`. Your configured model provider must offer `gpt-6-luna`; an API key for Jev alone does not grant that access. The summary runner uses low effort, disables execution tools, and returns a structured summary. The evaluator retains separate control metadata; it does not ask Luna to authorize actions or select the final effort.

The summary operation has bounded attempts and a time budget. If it fails, the bridge records fallback behavior rather than waiting indefinitely. The native model's full retained history is not replaced by the summary. Jev still has a bounded request size; this is semantic compression with explicit fallback limits, not a promise to send unlimited context.

## Logs and privacy

Decision metadata is recorded under `<ARES_HOME>/runs/<run>/decisions.jsonl`. It includes model/effort applications, routes, attempts, usage, latency and fallback reasons, without intentionally logging keys or complete history. Native Codex retains ordinary conversation history under `codexHome`.

Effort evaluation can transmit workspace-derived prompts and tool outputs to the configured provider. Luna sees the supplied context when summarization is enabled. Task routing sends a short caller-provided description plus metadata and the dated price snapshot. Public/synthetic labels do not anonymize text. Share only data permitted for those services, and inspect logs before publishing them.
