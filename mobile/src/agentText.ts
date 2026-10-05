// Text-protocol tool calling (Hermes/Qwen style) leaks markup + raw JSON
// into agent text — hide it everywhere agent text renders: the thread
// shows prose, never tool plumbing. Tool execution detail already lives
// in status lines and result cards.
const TOOL_BLOCK = /<tool_call\b[^>]*>[\s\S]*?(<\/tool_call>|$)/gi;
const TOOL_JSON_TO_CLOSE =
  /\{\s*"name"\s*:\s*"[\w.-]+"\s*,\s*"arguments"\s*:[\s\S]*?<\/tool_call>/gi;
const TOOL_FENCE = /```\s*(?:tool_call|tool_response)\s*\n?[\s\S]*?(?:```|$)/gi;
const TOOL_TAG =
  /<\/?(tool_call|tool_response|function_calls?|invoke|argument)\b[^>]*>/gi;

// Agents describe code in prose — `<footer>`, `<div>` etc. appear as raw
// angle-bracket literals mid-sentence and read as markup vomit on the
// bubble. Rewrite them as inline-code so they render like every other
// chat client renders code identifiers.
const INLINE_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]{0,30})((?:\s+[^<>]*)?)>/g;

export function cleanAgentText(text: string): string {
  if (!text) return text;
  return text
    .replace(TOOL_BLOCK, "")
    .replace(TOOL_JSON_TO_CLOSE, "")
    .replace(TOOL_FENCE, "")
    .replace(TOOL_TAG, "")
    .replace(INLINE_TAG, "`$&`")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The live tail sits mid-token: a half-written `**bo`, `[label](`, or `co`
// renders the literal marker until the closing token lands — reads as vomit.
// Hide the dangling opener while the turn is still streaming.
export function liveTailText(text: string): string {
  if (!text) return text;
  let t = text;
  // Partial link at the frontier: "[label](url…" or a bare "[label".
  t = t.replace(/\[[^\]\n]*\]\([^)\n]*$/, "").replace(/\[[^\]\n]*$/, "");
  // Unclosed bold: odd count of "**" → drop the last one.
  if ((t.match(/\*\*/g) ?? []).length % 2 === 1) {
    const i = t.lastIndexOf("**");
    t = t.slice(0, i) + t.slice(i + 2);
  }
  // Unclosed italic: after pairs are out, an odd single "*" is dangling.
  const noPairs = t.replace(/\*\*/g, "");
  if ((noPairs.match(/\*/g) ?? []).length % 2 === 1) {
    const i = t.lastIndexOf("*");
    t = t.slice(0, i) + t.slice(i + 1);
  }
  // Unclosed inline code — "```" fences are the block parser's business;
  // an odd count of single backticks means the last one is still open.
  const noFences = t.replace(/```/g, "");
  if ((noFences.match(/`/g) ?? []).length % 2 === 1) {
    const i = t.lastIndexOf("`");
    t = t.slice(0, i) + t.slice(i + 1);
  }
  return t;
}
