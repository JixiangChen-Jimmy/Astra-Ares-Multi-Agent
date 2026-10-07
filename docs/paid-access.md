# Provider access and cost boundaries

Your model account and Jev account are separate. This project contains no keys and does not create accounts, buy credits or grant model access.

The effort bridge supports direct TypeSafe, OpenRouter Decisions and Vercel AI Gateway. Configure a key from the provider you actually select:

```sh
ares configure --provider typesafe
# Or explicitly choose another supported effort provider:
ares configure --provider openrouter
```

The bundled task-start selector supports direct TypeSafe and a legacy Zen adapter. Direct TypeSafe effort configuration can reuse the same key; other effort providers need a separately configured route credential. See [configuration](configuration.md).

Provider endpoints and model identifiers are adapter contracts, not promises about account eligibility or current prices. Consult your provider's account console and terms. `ares doctor --probe` makes a small billable request to the effort provider; ordinary local tests do not need paid access.

The [model price snapshot](../routing/pricing.json) is dated. It is used to compare Sol-6.1 with Luna at task start and should be reviewed when model pricing changes. Actual token use, cached tokens, selected service tier, retries and your inference provider's billing determine charges. Different efforts can consume different token amounts even when the model's unit rates are identical. No workload savings are claimed without a measured baseline.

Missing service-reported usage or cost remains unknown. Mock requests are labeled and are not live billing evidence. Paying for access does not guarantee capacity, and providers are never silently swapped.
