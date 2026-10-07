# Optional GitHub Actions

Workflow templates are included in `ci/workflows/`. They are not active workflows in this repository. To enable them with an account or token authorized to modify workflows, copy them into `.github/workflows/` and commit that change.

- `ci.yml`: Node 22 and Python tests on Linux and macOS, with an npm package preview; no API credentials.
- `native-build.yml`: manual native build and fixture workflow. It is not evidence of a completed macOS acceptance run.

Local release checks are documented in `docs/validation.md`. Do not put provider secrets into test fixtures.
