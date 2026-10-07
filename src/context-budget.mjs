import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

const options = { disallowedSpecial: new Set() };
const profiles = {
  normal: {
    tokens: 8_000,
    bytes: 30_000,
    fields: {
      latestUserPrompt: 5_500,
      originalTask: 4_500,
      priorUserPrompts: 2_200,
      publicNotes: 6_000,
      recentToolCalls: 6_500,
    },
  },
  retry: {
    tokens: 4_000,
    bytes: 14_000,
    fields: {
      latestUserPrompt: 2_600,
      originalTask: 2_100,
      priorUserPrompts: 900,
      publicNotes: 2_500,
      recentToolCalls: 2_700,
    },
  },
};

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "");
}

function preview(text, limit) {
  if (bytes(text) <= limit) return text;
  const marker = " [middle omitted] ";
  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  let best = marker;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const head = Math.ceil(keep * 0.7);
    const tail = keep - head;
    const candidate =
      chars.slice(0, head).join("") +
      marker +
      (tail ? chars.slice(-tail).join("") : "");
    if (bytes(candidate) <= limit) {
      best = candidate;
      low = keep + 1;
    } else high = keep - 1;
  }
  return bytes(best) <= limit ? best : "";
}

function compact(value, limit, depth = 0, keepFirst = false) {
  if (bytes(value) <= limit) return value;
  if (typeof value === "string") return preview(value, limit);
  if (value === null || typeof value !== "object" || depth >= 6)
    return preview(JSON.stringify(value), limit);
  if (Array.isArray(value)) {
    const selected =
      keepFirst && value.length > 8
        ? [value[0], ...value.slice(-7)]
        : value.slice(-Math.min(value.length, 8));
    const allowance = Math.max(
      32,
      Math.floor((limit - 150) / Math.max(selected.length, 1)),
    );
    const result = selected.map((item) => compact(item, allowance, depth + 1));
    if (selected.length < value.length)
      result.splice(
        keepFirst ? 1 : 0,
        0,
        `[${value.length - selected.length} intermediate entries omitted]`,
      );
    return bytes(result) <= limit
      ? result
      : preview(JSON.stringify(value), limit);
  }
  const keys = Object.keys(value).slice(0, 16);
  const allowance = Math.max(
    32,
    Math.floor((limit - 150) / Math.max(keys.length, 1)),
  );
  const result = Object.fromEntries(
    keys.map((key) => [key, compact(value[key], allowance, depth + 1)]),
  );
  if (keys.length < Object.keys(value).length)
    result.omittedFields = Object.keys(value).length - keys.length;
  return bytes(result) <= limit
    ? result
    : preview(JSON.stringify(value), limit);
}

function compactState(state, profile, scale) {
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [
      key,
      compact(
        value,
        Math.max(100, Math.floor((profile.fields[key] ?? 400) * scale)),
        0,
        key === "priorUserPrompts",
      ),
    ]),
  );
}

function measure(body) {
  return {
    requestBytes: Buffer.byteLength(body),
    localTokens: countTokens(body, options),
  };
}

// The provider's tokenizer is unpublished; both limits apply to the complete
// serialized request. The byte bound also constrains text with dense UTF-8.
export function budgetRequest(request, { retry = false } = {}) {
  const profile = profiles[retry ? "retry" : "normal"];
  const originalBody = JSON.stringify(request);
  const original = measure(originalBody);
  if (
    !retry &&
    original.localTokens <= profile.tokens &&
    original.requestBytes <= profile.bytes
  )
    return {
      request,
      body: originalBody,
      stats: { ...original, truncated: false },
    };

  for (const scale of [1, 0.75, 0.5, 0.25, 0.125]) {
    const candidate = {
      ...request,
      state: compactState(request.state, profile, scale),
    };
    const body = JSON.stringify(candidate);
    const stats = measure(body);
    if (
      stats.localTokens <= profile.tokens &&
      stats.requestBytes <= profile.bytes
    )
      return {
        request: candidate,
        body,
        stats: {
          ...stats,
          truncated:
            candidate.state !== request.state &&
            JSON.stringify(candidate.state) !== JSON.stringify(request.state),
          originalRequestBytes: original.requestBytes,
          originalLocalTokens: original.localTokens,
        },
      };
  }
  return {
    request: null,
    body: null,
    stats: { ...original, truncated: false, limitExceeded: true },
  };
}
