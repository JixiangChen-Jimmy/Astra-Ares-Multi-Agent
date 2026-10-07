# Astra-Ares Multi-Agent

Jev-powered adaptive thinking for Codex, with an optional multi-agent workflow.

[中文说明](README.zh-CN.md) · [Installation](docs/installation.md) · [Configuration](docs/configuration.md) · [Validation and limits](docs/validation.md)

Derived from [miuuyy/Astra-Ares](https://github.com/miuuyy/Astra-Ares). This independent project targets a pinned, patched **Codex 0.160.1**. It adds two selectable modes, Sol-6.1 support, task-start model routing, semantic context summaries, and bounded decision failure handling. It does not replace your ordinary `codex` command.

## Two modes

|                                   | `adaptive` — default            | `multi-agent`                            |
| --------------------------------- | ------------------------------- | ---------------------------------------- |
| Root                              | Astra-Jev, starts at medium     | Astra-Jev, starts at medium              |
| Root effort                       | Jev chooses low / medium / high | Jev chooses low / medium / high          |
| Automatic child model routing     | Off                             | On, before each child task starts        |
| Core implementation               | No added orchestration policy   | Sol-6.1, fixed high                      |
| Routine code / explicit execution | No added orchestration policy   | Jev chooses Sol-6.1 adaptive or Luna max |
| Review / core review              | No added orchestration policy   | Astra low / medium                       |
| Research                          | No added orchestration policy   | Sol-6.1 high                             |
| History                           | Shared between both modes       | Shared between both modes                |

Adaptive mode does not install the multi-agent routing policy. Multi-agent mode uses native `spawn_routed_agent` tools and waits for Codex to acknowledge the selected child settings before submitting the first task input. A failed or expanded task returns to Root for a new selection; models are not silently swapped midway through a child task.

## Install

You need Node.js 22+, npm, Python 3 for multi-agent routing, your own Codex authentication/model access, and a Jev provider key. The tested prebuilt native target is **Linux x86_64 with glibc and OpenSSL 3**; it is not a musl build. See [installation](docs/installation.md) for exact compatibility and source builds on other targets.

For a downloaded native bundle, extract it, enter its directory, then run:

```sh
npm ci --omit=dev
node bin/ares.mjs setup --binary "$PWD/native/bin/codex" --provider typesafe --mode adaptive
node bin/ares.mjs configure --provider typesafe
npm link
```

The credential prompt is hidden and stores the key in your private configuration, outside the repository. Model inference uses your own Codex login/API configuration separately from Jev. If needed, use `astra-ares login`.

For a source checkout:

```sh
git clone https://github.com/JixiangChen-Jimmy/Astra-Ares-Multi-Agent.git
cd Astra-Ares-Multi-Agent
npm ci
npm run setup -- --provider typesafe --mode adaptive
npm link
ares configure --provider typesafe
```

Source setup compiles the pinned native patch and is substantially slower than installing a compatible bundle. It needs Rust and native build dependencies; check [building](docs/building.md) before starting. Ordinary upstream Codex binaries cannot be substituted for the patched binary.

## Select a mode

Only Astra adaptive thinking:

```sh
ares mode adaptive
astra-ares -C /path/to/project
```

Enable multi-agent task routing:

```sh
ares mode multi-agent
astra-ares -C /path/to/project
```

Override the mode for one launch without changing the saved setting:

```sh
astra-ares --ares-mode multi-agent -C /path/to/project
```

Switches apply to newly launched sessions, not an already-running process. Both modes use the same profile, so history remains available:

```sh
astra-ares -C /path/to/project --no-alt-screen resume
```

Native Codex approval and sandbox options remain available. This project does not enable `--yolo` automatically. A routing decision never authorizes an action.

## Jev, summaries and costs

A lease lasts at most **five model generations**, not five tool calls. Root Astra is capped at high. Sol-6.1 adaptive can use the efforts supported by its model catalog; Luna execution uses fixed max. The dated [price snapshot](routing/pricing.json) informs task-start choices; it is not a billing quote or a savings guarantee.

Optional **Luna low** semantic compression supplies the effort evaluator with a summary of the available task context. It does not execute tasks or replace the main model's history. Enable `lunaSummary` in your configuration; see [configuration](docs/configuration.md). This is a separate role from **Luna max**, which executes eligible routed tasks.

Direct TypeSafe is the simplest setup for both modes because the effort evaluator and task selector can share its key. Other effort providers require a separately configured, compatible task-routing credential. Missing routing credentials must be fixed before using multi-agent mode. Provider switching is explicit.

## What is sent and stored

The effort evaluator receives a bounded projection of task prompts, public progress and tool results. If enabled, Luna also receives context to summarize. These texts can contain information from your workspace; compression is not anonymization. Use this only with data you are permitted to send to your chosen providers. Private/encrypted model reasoning is not forwarded.

Task-start routing accepts a short public or synthetic description supplied by Root. The labels are a contract for the caller, not an automatic privacy detector. Native conversation history and decision metadata stay in your local profile. No credentials, personal history, private model gateway configuration or project data are included in this repository or its bundles.

## Reliability and limits

The bridge has bounded retries, isolated evaluator workers, timeout fallback and native application acknowledgements. Fallbacks are logged and use a short lease; successful application and fallback are distinguishable. Neither a log entry nor a successful installation proves that your account can access every model.

Live upstream-integration checks covered Astra-Jev, Sol-6.1-Jev, Sol-6.1 high, Luna max, semantic compression and a real routed child. Package mode tests are separate offline checks. The broader Codex workspace was **not fully green** in the development environment; known process-cleanup, environment and fixture limitations are recorded in [validation](docs/validation.md). Do not interpret this project as a fix for every upstream Codex issue.

```sh
ares doctor          # local binary/config/credential checks
ares doctor --probe  # one billable effort-evaluator request
npm test             # offline package tests
```

[Architecture](docs/architecture.md) · [Troubleshooting](docs/troubleshooting.md) · [Provider access](docs/paid-access.md)

## License and attribution

The bridge and orchestration code are MIT-licensed, retaining the original Astra-Ares attribution. The Codex patch and native components preserve Apache-2.0 notices. See [LICENSE](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md), and [upstream pin](patches/upstream.json). Independent software, unaffiliated with OpenAI or Jev providers.
