# Troubleshooting

Start with `ares doctor`. Use `ares doctor --probe` only when you want a small billable test of the configured effort provider. It does not test all model permissions or the separate task selector.

## Commands are missing

`npm link` creates the `ares` and `astra-ares` commands in your npm prefix. Ensure that prefix's bin directory is in `PATH`, or use `node bin/ares.mjs` and `node bin/astra-ares.mjs` from the extracted package. `resume` has a final **e**.

The pinned native UI may print an older `codex-jev resume <id>` hint when exiting. This package installs `astra-ares`; use `astra-ares resume <id>` instead. No separate `codex-jev` command is required.

## Cannot find old sessions

Both package modes share `<ARES_HOME>/codex-home`, unless `codexHome` is overridden. `astra-ares resume` lists history in that profile. Ordinary Codex and the original Astra-Ares project may use other directories. The package never silently imports or merges them. Back up old data before configuring a different profile, and do not share a writable profile between incompatible concurrent versions.

## Multi-agent credential error

The task selector requires a direct TypeSafe or legacy Zen key. If your effort evaluator uses OpenRouter or Vercel, run `ares configure-route --provider typesafe` with a TypeSafe key. Keys from different providers are not interchangeable. Adaptive mode does not require a routing credential.

## Model unavailable

Astra, Sol-6.1 and Luna access comes from your Codex model provider. Jev access does not include those models. Check your native model catalog and login; the project does not invent missing catalog entries or promise access for every account. The legacy Sol-Jev selection still means Sol6, not Sol-6.1.

## Context limit or decision timeout

Enable optional `lunaSummary` for semantic compression. The evaluator also applies bounded context budgets, same-provider retries and a parent watchdog. A recoverable failure uses a short logged fallback rather than waiting indefinitely. Repeated fallbacks indicate provider, account, context or summary failures that need investigation. Native transport/protocol errors can still stop a turn.

A `429` is not itself proof of context overflow. Inspect provider codes, attempt counts and fallback events without sharing credentials or complete private histories.

## Native binary will not run

The prebuilt archive is Linux x86_64 GNU and requires the libraries/version listed in its release manifest. It is not for macOS, Linux ARM or Alpine/musl. Keep `codex-code-mode-host` beside `codex`, and retain the extracted directory after setup because the config stores its absolute binary path. Use the source build on other supported Unix targets; those targets need independent validation.

## Background commands after disconnect or rejected network access

Process cleanup limitations were reproduced in upstream-related tests on the development host. Do not assume closing the UI/socket guarantees that every background process has stopped. Inspect your own task processes when this matters. This release does not claim to fix those upstream paths; see [validation](validation.md).
