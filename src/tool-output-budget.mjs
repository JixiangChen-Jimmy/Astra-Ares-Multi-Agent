import { encode, decode, countTokens } from "gpt-tokenizer/encoding/o200k_base";

export const TOOL_OUTPUT_TOKEN_LIMIT = 1000;
export const TOOL_OUTPUT_TOKENIZER = "o200k_base";
const options = { disallowedSpecial: new Set() };
const marker = "\n[Tool output truncated: middle omitted]\n";

// Budget both the text and its JSON-escaped representation. This is a local
// o200k_base budget, not a claim about Jev's unpublished tokenizer.
export function outputTokens(text) {
  if (!text) return 0;
  return Math.max(
    countTokens(text, options),
    countTokens(JSON.stringify(text), options),
  );
}

function preview(text, budget) {
  if (outputTokens(text) <= budget) return text;
  if (!budget) return null;
  const tokens = encode(text, options);
  const markerFits = outputTokens(marker) <= budget;
  let keep = Math.min(tokens.length, budget);
  while (keep > 0) {
    let headCount = markerFits ? Math.ceil(keep * 0.75) : keep;
    let tailCount = markerFits ? keep - headCount : 0;
    let head = decode(tokens.slice(0, headCount));
    let tail = tailCount ? decode(tokens.slice(-tailCount)) : "";
    // A BPE cut can split a UTF-8 character. Move inward to valid boundaries.
    while (headCount && !text.startsWith(head))
      head = decode(tokens.slice(0, --headCount));
    while (tailCount && !text.endsWith(tail))
      tail = --tailCount ? decode(tokens.slice(-tailCount)) : "";
    const result = head + (markerFits ? marker : "") + tail;
    const cost = outputTokens(result);
    if (cost <= budget) return result || null;
    keep -= Math.max(1, cost - budget);
  }
  return markerFits ? marker : null;
}

export function budgetToolOutputs(calls, { preserveFull = false } = {}) {
  // In semantic-summary mode the bridge only transports these strings. Exact
  // BPE counts must not block its socket/watchdog thread on large tool output.
  if (preserveFull) {
    const perTool = calls.map((call) => ({
      callId: call.callId,
      originalBytes: call.outputs.reduce(
        (total, output) => total + Buffer.byteLength(output.text ?? ""),
        0,
      ),
    }));
    return {
      recentToolCalls: calls,
      stats: {
        tokenizer: null,
        toolOutputBudgetTokens: null,
        toolOutputTokensBefore: null,
        toolOutputTokensAfter: null,
        toolOutputBytes: perTool.reduce(
          (sum, item) => sum + item.originalBytes,
          0,
        ),
        truncatedToolOutputs: 0,
        perTool,
      },
    };
  }
  const stats = {
    tokenizer: TOOL_OUTPUT_TOKENIZER,
    toolOutputBudgetTokens: preserveFull ? null : TOOL_OUTPUT_TOKEN_LIMIT,
    toolOutputTokensBefore: 0,
    toolOutputTokensAfter: 0,
    truncatedToolOutputs: 0,
    perTool: [],
  };
  const recentToolCalls = calls.map((call) => {
    const counts = call.outputs.map((output) => outputTokens(output.text));
    const total = counts.reduce((sum, count) => sum + count, 0);
    const budgets = [...counts];
    if (!preserveFull && total > TOOL_OUTPUT_TOKEN_LIMIT) {
      let remaining = TOOL_OUTPUT_TOKEN_LIMIT;
      const nonempty = counts
        .map((count, index) => ({ count, index }))
        .filter((v) => v.count > 0)
        .sort((a, b) => a.count - b.count);
      for (let i = 0; i < nonempty.length; i++) {
        const { count, index } = nonempty[i];
        budgets[index] = Math.min(
          count,
          Math.floor(remaining / (nonempty.length - i)),
        );
        remaining -= budgets[index];
      }
    }
    let sent = 0;
    const outputs = call.outputs.map((output, index) => {
      const text =
        counts[index] > budgets[index]
          ? preview(output.text, budgets[index])
          : output.text;
      const sentTokens = outputTokens(text);
      sent += sentTokens;
      if (text === output.text) return output;
      stats.truncatedToolOutputs++;
      return {
        ...output,
        text,
        truncation: {
          tokenizer: TOOL_OUTPUT_TOKENIZER,
          originalTokens: counts[index],
          sentTokens,
          budgetTokens: budgets[index],
          truncated: true,
        },
      };
    });
    stats.toolOutputTokensBefore += total;
    stats.toolOutputTokensAfter += sent;
    stats.perTool.push({
      callId: call.callId,
      originalTokens: total,
      sentTokens: sent,
    });
    return { ...call, outputs };
  });
  return { recentToolCalls, stats };
}
