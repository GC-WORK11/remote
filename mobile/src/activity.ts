// Maps omp RPC frames to elegant human status lines and checklist items.
// The UI never shows frame types, tool names, or raw payloads — friendly
// verbs, the agent's own `intent` summaries, and basenames only.
import { Frame } from "./rig";

export interface Activity {
  label: string;
}

const TOOL_LABELS: [RegExp, string][] = [
  [/bash|shell|exec|terminal|command|run/i, "Running a command…"],
  [/read|view|cat|open|inspect|peek/i, "Reading files…"],
  [/write|edit|patch|replace|rename|create|delete|move|insert/i, "Editing files…"],
  [/glob|grep|search|find|list|scan|tree|lookup|query/i, "Searching the codebase…"],
  [/web|fetch|browse|url|http|search_web|navigate/i, "Browsing the web…"],
  [/computer|screen|click|type|key|scroll|observe|launch|window|cursor|drag/i, "Using the computer…"],
  [/task|subagent|delegate|spawn|agent/i, "Coordinating a subagent…"],
  [/todo|plan|phase/i, "Updating the plan…"],
  [/memory|note|remember/i, "Taking notes…"],
  [/deliver/i, "Delivering a file…"],
  [/git|commit|diff|merge|checkout/i, "Working with git…"],
  [/install|build|test|lint|compile/i, "Building…"],
];

// Friendly verbs for the checklist bubble — tool names are never shown raw.
const TOOL_VERBS: [RegExp, string][] = [
  [/bash|shell|exec|terminal|command|run/i, "Ran"],
  [/read|view|cat|open|inspect|peek/i, "Read"],
  [/write|create/i, "Wrote"],
  [/edit|patch|replace|rename|move|insert|delete/i, "Edited"],
  [/glob|grep|search|find|list|scan|tree|lookup|query/i, "Searched"],
  [/web|fetch|browse|url|http|navigate/i, "Browsed"],
  [/computer|screen|click|type|key|scroll|observe|launch|window|cursor|drag/i, "Used the computer"],
  [/task|subagent|delegate|spawn|agent/i, "Delegated"],
  [/deliver/i, "Delivered"],
  [/todo|plan|phase/i, "Planned"],
  [/git|commit|diff|merge|checkout/i, "Worked with git"],
  [/install|build|test|lint|compile/i, "Built"],
];

function toolLabel(name: string): string {
  for (const [re, label] of TOOL_LABELS) if (re.test(name)) return label;
  return "Working…";
}

function toolVerb(name: string): string {
  for (const [re, verb] of TOOL_VERBS) if (re.test(name)) return verb;
  return "Worked";
}

function basename(p: string): string {
  const s = String(p).replace(/\/+$/, "");
  return s.split("/").pop() || s;
}

// Tool families — drives the leading glyph in Working-card rows and which
// tool results get a card of their own (terminal output, file diffs).
export type ToolClass =
  | "term"
  | "file"
  | "search"
  | "computer"
  | "web"
  | "subagent"
  | "plan"
  | "git"
  | "build"
  | "work";

export function toolClass(name: string): ToolClass {
  if (/rig_computer|screen|click|type|key|scroll|observe|launch|window|cursor|drag/i.test(name))
    return "computer";
  if (/task|subagent|delegate|spawn|agent/i.test(name)) return "subagent";
  if (/todo|plan|phase/i.test(name)) return "plan";
  if (/bash|shell|exec|terminal|command|run/i.test(name)) return "term";
  if (/write|edit|patch|replace|rename|create|delete|move|insert/i.test(name))
    return "file";
  if (/glob|grep|search|find|list|scan|tree|lookup|query|ls\b|read|view|cat|open|inspect|peek/i.test(name))
    return "search";
  if (/web|fetch|browse|url|http|navigate/i.test(name)) return "web";
  if (/git|commit|diff|merge|checkout/i.test(name)) return "git";
  if (/install|build|test|lint|compile/i.test(name)) return "build";
  return "work";
}

// Command text a terminal-class tool ran — shown verbatim in the terminal
// card's `$` line (it IS the work; output stays capped separately).
export function commandOf(inner: Frame): string {
  const a = inner.args || {};
  const c = a.command ?? a.cmd ?? a.script ?? a.input;
  return typeof c === "string" ? c.trim() : "";
}

// Path any file-class tool touched — write/edit/patch args all name it.
export function pathOf(inner: Frame): string {
  const a = inner.args || {};
  const p = a.path ?? a.file ?? a.filePath ?? a.file_path ?? a.target;
  return typeof p === "string" ? p : "";
}

// First text blob of a tool result — output previews read this.
export function resultText(result: any): string {
  const c = result?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((b: any) => (b && b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

// A checklist line like "Read auth.ts" built from verb + a sanitized target.
// Never surfaces commands, queries, or JSON — file basenames only.
// rig_computer ops → the action the user is actually watching on their
// screen ("Opening Chrome" beats "Used the computer").
const COMPUTER_VERBS: Record<string, string> = {
  observe: "Looking at the screen",
  screenshot: "Taking a screenshot",
  click: "Clicking",
  doubleclick: "Double-clicking",
  type: "Typing",
  key: "Pressing keys",
  scroll: "Scrolling",
  drag: "Dragging",
  gesture: "Gesturing",
  launch: "Opening",
  activate: "Bringing to front",
  close: "Closing window",
  waitWindow: "Waiting for window",
  windows: "Listing windows",
  state: "Checking the display",
  perms: "Checking permissions",
  batch: "Running actions",
};

export interface ChecklistItem {
  id: string;
  label: string;
  cls: ToolClass;
}

export function checklistItem(inner: Frame): ChecklistItem | null {
  if (inner.type !== "tool_execution_start") return null;
  const name = String(inner.toolName || "");
  const args = inner.args || {};
  const intent = typeof inner.intent === "string" ? inner.intent.trim() : "";
  const cls = toolClass(name);

  if (cls === "computer") {
    const op = String(args.op || "");
    let label = COMPUTER_VERBS[op] || "Using the computer";
    if (intent) label = intent;
    else if (op === "launch" && typeof args.app === "string")
      label = `Opening ${basename(args.app.replace(/^open\s+-a\s+/, ""))}`;
    else if (op === "key" && typeof args.combo === "string")
      label = `Pressing ${args.combo}`;
    return { id: String(inner.toolCallId || inner.id || label + Date.now()), label, cls };
  }

  const verb = toolVerb(name);
  let target = "";
  if (intent) target = intent;
  else if (typeof args.path === "string") target = basename(args.path);
  else if (typeof args.file === "string") target = basename(args.file);
  else if (typeof args.filePath === "string") target = basename(args.filePath);
  else if (typeof args.pattern === "string") target = `“${basename(args.pattern)}”`;
  else if (cls === "term" && commandOf(inner)) target = "a command";
  const label = target ? `${verb} ${target}` : verb === "Ran" ? "Ran a command" : verb;
  return { id: String(inner.toolCallId || inner.id || label + Date.now()), label, cls };
}

// Path a mutating tool is writing to — collected for the PR view's touched
// files list. Read/search-class tools return null; basenames aren't enough
// here so the raw arg survives (display trims it against session cwd).
export function touchedPath(inner: Frame): string | null {
  if (inner.type !== "tool_execution_start") return null;
  if (!/write|edit|patch|replace|rename|create|delete|move|insert/i.test(String(inner.toolName || "")))
    return null;
  const args = inner.args || {};
  const p = args.path || args.file || args.filePath || args.file_path;
  return typeof p === "string" && p ? p : null;
}

// Deploy-style progress lines from a tool result's own fields — nothing is
// rendered unless the result literally carries the key (Build ID / Status /
// Run from the code refs). Checked shallow + one nested `details` level.
export function deployLines(result: any): string[] {
  if (!result || typeof result !== "object") return [];
  const pick = (keys: string[]): string => {
    for (const k of keys) {
      const v = result[k] ?? result.details?.[k];
      if (typeof v === "string" && v) return v;
      if (typeof v === "number") return String(v);
    }
    return "";
  };
  const out: string[] = [];
  const id = pick(["buildId", "build_id", "deploymentId", "deployId", "releaseId"]);
  const status = pick(["status", "state"]);
  const url = pick(["url", "runUrl", "deployUrl", "deploymentUrl", "previewUrl"]);
  if (id) out.push(`Build ID: ${id}`);
  if (status) out.push(`Status: ${status}`);
  if (url && /^https?:\/\//.test(url)) out.push(`Run: ${url}`);
  return out;
}

// Settle time a tool result reports for itself (bash executions carry
// durationMs, rig_computer actions tookMs) — preferred over the locally
// measured start→end gap when present.
export function resultMs(result: any): number | undefined {
  if (!result || typeof result !== "object") return undefined;
  const n =
    result.durationMs ??
    result.tookMs ??
    result.details?.durationMs ??
    result.details?.wallTimeMs;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

// Returns the status a frame implies for the live pill/header snippet,
// or null when the frame should not change the visible status.
export function activityFor(inner: Frame): Activity | null {
  const t = inner.type || "";
  if (t === "agent_start" || t === "turn_start") return { label: "Thinking…" };
  if (t === "tool_execution_start") return { label: toolLabel(String(inner.toolName || "")) };
  if (t === "tool_execution_update" || t === "tool_execution_end")
    return { label: "Thinking…" };
  if (t === "message_update") {
    const ev = inner.assistantMessageEvent?.type || "";
    if (ev.startsWith("thinking")) return { label: "Thinking…" };
    if (ev.startsWith("toolcall")) return { label: "Working…" };
    if (ev.startsWith("text")) return { label: "Replying…" };
    return null;
  }
  if (t === "auto_compaction_start") return { label: "Compacting context…" };
  if (t === "auto_compaction_end") return { label: "Thinking…" };
  if (t === "subagent_lifecycle" || t === "subagent_progress")
    return { label: "Coordinating a subagent…" };
  if (t === "extension_ui_request") return { label: "Needs your input…" };
  return null;
}
