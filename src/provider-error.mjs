export function safeText(value, secret = "") {
  let text = typeof value === "string" ? value : "";
  if (secret) text = text.replaceAll(secret, "[REDACTED]");
  return text
    .replace(/(?:Bearer\s+|(?:vck_|sk-))[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 400);
}
export function retryDelay(headers, attempt, now = Date.now()) {
  const ms = headers.get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const after = headers.get("retry-after");
  if (after) {
    if (Number.isFinite(Number(after)))
      return Math.max(0, Number(after) * 1000);
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
}
export class ProviderError extends Error {
  constructor(details) {
    super(
      `Jev ${details.provider}: ${details.category}${details.status ? ` (HTTP ${details.status})` : ""}${details.providerCode ? ` [${details.providerCode}]` : ""}${details.providerMessage ? `: ${details.providerMessage}` : ""}`,
    );
    this.name = "ProviderError";
    this.details = details;
  }
}
export function responseError(provider, response, body, secret) {
  const error = body?.error ?? body?.detail ?? {};
  const rawCode = error.error_type ?? error.type ?? error.code;
  const code = safeText(
    typeof rawCode === "number" ? String(rawCode) : rawCode,
    secret,
  );
  const message = safeText(
    error.message ?? (typeof error === "string" ? error : ""),
    secret,
  );
  const context =
    /max_tokens_exceeded|context_length_exceeded|context_window_exceeded/.test(
      code,
    );
  const quota =
    /quota|insufficient|billing/.test(code) || response.status === 402;
  const category = context
    ? "context_limit"
    : quota
      ? "quota"
      : response.status === 429
        ? "rate_limit_or_capacity"
        : [401, 403].includes(response.status)
          ? "authentication"
          : response.status >= 500
            ? "provider_unavailable"
            : "invalid_request";
  const gateway = body?.providerMetadata?.gateway;
  const modelAttempts = gateway?.routing?.modelAttempts;
  const upstreamAttempts = Array.isArray(modelAttempts)
    ? modelAttempts
        .flatMap((attempt) =>
          Array.isArray(attempt?.providerAttempts)
            ? attempt.providerAttempts
            : [],
        )
        .slice(0, 16)
        .map((attempt) => ({
          provider: safeText(attempt?.provider, secret),
          credentialType: safeText(attempt?.credentialType, secret),
          status: Number.isInteger(attempt?.statusCode)
            ? attempt.statusCode
            : undefined,
          message: safeText(attempt?.error, secret),
        }))
    : undefined;
  return new ProviderError({
    provider,
    category,
    status: response.status,
    providerCode: code || undefined,
    providerMessage: message || undefined,
    upstreamAttempts,
    generationId: safeText(gateway?.generationId, secret) || undefined,
    requestId:
      safeText(
        response.headers.get("x-request-id") ??
          response.headers.get("x-vercel-id"),
        secret,
      ) || undefined,
    retryAfter:
      safeText(response.headers.get("retry-after"), secret) || undefined,
    retryable:
      !context &&
      !quota &&
      [408, 429, 500, 502, 503, 504, 529].includes(response.status),
  });
}
