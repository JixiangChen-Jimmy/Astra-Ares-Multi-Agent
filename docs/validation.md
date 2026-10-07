# Validation

Run the keyless checks from the repository root:

```sh
npm ci --ignore-scripts
npm test
python3 -m unittest routing/test_select_model.py
npm pack --dry-run
```

The Node tests cover launcher and bridge contracts, configuration, mode behavior, and release packaging rules. The Python tests exercise routing with synthetic inputs. Neither check needs a provider key or spends API credits. The npm pack preview verifies published files; it does not create a native binary.

Native fixture tests require Bun and a compatible patched Codex with `codex-code-mode-host` beside it:

```sh
JEV_TEST_BINARY=/absolute/path/to/codex npm run test:native
```

These fixtures use local synthetic endpoints. The accepted Linux x86_64 GNU binary has SHA-256 `accacf313385c7c20901162af3049a3a6d53428e2df3ebed3759450f327ec05d`. Its helper has SHA-256 `b33e8a5283f3c65c2a0aca6d43a59cfe850f624d8fa16992e3cad4fcc27c14e1`. Source and patch hashes are in `patches/upstream.json`. The Linux binary references `GLIBC_2.39`, OpenSSL 3, and libgcc. Do not infer acceptance on macOS, Linux ARM, or every glibc/OpenSSL combination from this result.

## Original upgrade acceptance boundary

The source binary was accepted in the earlier local Codex/Ares upgrade, before packaging this new repository. That work completed 20,976 supported upstream workspace tests: 20,876 passed and 100 failed, with 45 more skipped. The standalone `codex-voice-host` was excluded because the host had GStreamer 1.24.2 while that crate requires at least 1.28. The focused upgrade-owned checks passed; a later focused batch passed 18 of 19, with an unchanged skills-ancestry failure. This is not a claim that the upstream workspace passed in full.

The original deployment also ran real model probes for Sol-6.1-Jev checkpoints, ordinary Sol-6.1, Luna max, and routed child startup. Those probes were on that installed runtime, not on a fresh install of this portable archive. The archive and this repository's keyless tests do not repeat paid provider checks.

Known limitations from the original acceptance remain: both stock and patched Codex left live command processes after an owning WebSocket disconnected; network rejection also left live sandbox processes in an unchanged, non-Jev cancellation path, without an exact stock-equivalent network-rejection comparison. Host login scripts reintroduced `BASH_ENV` and broke shell snapshot fixtures; container namespace restrictions blocked a Landlock test. Upstream TUI snapshots expected version 0.0.0 rather than 0.160.1. The full-workspace V8 proof-of-concept test conflicted with code-mode runtime feature unification, though the isolated official V8 asset matched the shipped runtime. TLS fallback classification, mock authentication, short-deadline MCP, and remaining skills/path fixtures were not claimed passing. See the original upgrade's `UPGRADE.md` and `checks/` records for the full local evidence; those records are not bundled with this release.

After installing, `ares doctor` checks the local binary and configured provider key. `ares doctor --probe` makes a small billable provider request and is optional. Keep keys, session transcripts, and decision logs out of public validation reports.

## GitHub Actions templates

Optional workflows are provided under `ci/workflows/` and are not activated by this initial publication. See [CI instructions](../ci/README.md). Local test results are independent of GitHub Actions status.

## Portable package checks — 2026-10-08

On Linux x86_64, using the required Node 22+ runtime, all **86 Node tests** and **9 Python selector tests** passed. The complete packaged native fixture runner also passed: context, session, routed child acknowledgement, and Astra/Sol/Sol-6.1/Luna selection cases. These fixtures use synthetic local endpoints and are separate from the earlier live-provider evidence.

An initial run under the host's unsupported Node 18 rejected CLI cases as designed; the acceptance run used the supported runtime. Package contents were checked to exclude Python bytecode, private paths in source files, credentials and conversation logs. The unchanged native binary can retain compiler source-path metadata, as documented in the build notes.
