# Third-party notices

- **Astra-Ares — MIT.** Derived from [miuuyy/Astra-Ares](https://github.com/miuuyy/Astra-Ares). Original copyright is retained in LICENSE. This project adds portable mode configuration, task-start model routing, Sol-6.1 integration, semantic summarization and bounded failure handling.

- **OpenAI Codex — Apache-2.0.** The patch in `patches/native-checkpoint.patch` modifies [OpenAI Codex](https://github.com/openai/codex) at commit `d27764b82f7118f674371e6d6e76271d9d606edb`. Changes add the native generation checkpoint, evaluator context, Astra-Jev model entry, and effort notifications. Original attribution and terms are preserved in [LICENSE.codex](patches/LICENSE.codex) and [NOTICE.codex](patches/NOTICE.codex).
- **gpt-tokenizer 4.0.0 — MIT.** By Bazyli Brzoska and contributors. Used to count evaluator request tokens and bound tool-result previews with `o200k_base`; this is not Jev's exact tokenizer. npm installs the dependency's license alongside its code.
