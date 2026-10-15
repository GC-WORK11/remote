// ChatEngine — per-session transcript builder. Faithful port of
// mobile/src/useChat.ts row-folding semantics to a Solid store.
import { createSignal } from "solid-js";
import { rig, Frame } from "./rig";
import { app, messageText } from "./store";

export interface ChecklistItem {
  id: string;
  label: string;
  done?: boolean;
  failed?: boolean;
  ms?: number;
  cls?: string;
}
export interface Row {
  id: string;
  kind:
    | "sep" | "user" | "agent" | "check" | "event" | "error" | "shot"
    | "prog" | "term" | "file" | "sub" | "approval" | "deliver" | "voice" | "video" | "build";
  text?: string;
  images?: string[];
  at?: number;
  items?: ChecklistItem[];
  streaming?: boolean;
  noEnter?: boolean;
  shot?: string;
  shotCaption?: string;
  shotUri?: string;
  live?: boolean;
  deliver?: { path: string; name: string; size?: number | null; caption?: string };
  term?: { cmd: string; out: string; ms?: number; failed?: boolean };
  file?: { name: string; dir?: string; bytes?: number; adds?: number; dels?: number; failed?: boolean };
  sub?: { key: string; desc: string; status: string; agent?: string };
  approval?: {
    reqId?: string;
    title: string;
    preview?: string;
    state?: "pending" | "done";
    resolved?: "primary" | "secondary";
    doneLabel?: string;
  };
  video?: { uri?: string; durationSec?: number; caption?: string };
}

let rowSeq = 0;
const nid = () => `r${++rowSeq}`;
const GAP_MS = 10 * 60 * 1000;
const now = () => Date.now();

export function sepLabel(at: number): string {
  const d = new Date(at);
  const n = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === n.toDateString()) return `Today ${time}`;
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

function friendlyError(raw: any): string {
  const m = String(raw || "Something went wrong");
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|network|fetch failed|socket/i.test(m))
    return "Can't reach the rig — check the connection";
  if (/reconnect/i.test(m)) return "Lost the link to your rig — trying again in a moment";
  if (/quota|rate.?limit|429|insufficient/i.test(m))
    return "Provider rate limit — try again or switch model";
  if (/auth|401|403|unauthorized|permission/i.test(m))
    return "The provider needs a sign-in — check accounts";
  if (/timeout|timed out|deadline/i.test(m))
    return "The provider isn't responding — try again in a moment";
  if (/gave up|retry|retries/i.test(m))
    return "The provider kept failing after retries — try again or switch model";
  return m.split("\n")[0].slice(0, 160);
}

// ---- tool classification (port of activity.ts) ----
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
const toolLabel = (n: string) => TOOL_LABELS.find(([re]) => re.test(n))?.[1] || "Working…";
const toolVerb = (n: string) => TOOL_VERBS.find(([re]) => re.test(n))?.[1] || "Worked";
const basename = (p: string) => String(p).replace(/\/+$/, "").split("/").pop() || p;

export type ToolClass = "term" | "file" | "search" | "computer" | "web" | "subagent" | "plan" | "git" | "build" | "work";
export function toolClass(name: string): ToolClass {
  if (/rig_computer|screen|click|type|key|scroll|observe|launch|window|cursor|drag/i.test(name)) return "computer";
  if (/task|subagent|delegate|spawn|agent/i.test(name)) return "subagent";
  if (/todo|plan|phase/i.test(name)) return "plan";
  if (/bash|shell|exec|terminal|command|run/i.test(name)) return "term";
  if (/write|edit|patch|replace|rename|create|delete|move|insert/i.test(name)) return "file";
  if (/glob|grep|search|find|list|scan|tree|lookup|query|ls\b|read|view|cat|open|inspect|peek/i.test(name)) return "search";
  if (/web|fetch|browse|url|http|navigate/i.test(name)) return "web";
  if (/git|commit|diff|merge|checkout/i.test(name)) return "git";
  if (/install|build|test|lint|compile/i.test(name)) return "build";
  return "work";
}
const commandOf = (inner: Frame): string => {
  const a = inner.args || {};
  const c = a.command ?? a.cmd ?? a.script ?? a.input;
  return typeof c === "string" ? c.trim() : "";
};
const pathOf = (inner: Frame): string => {
  const a = inner.args || {};
  const p = a.path ?? a.file ?? a.filePath ?? a.file_path ?? a.target;
  return typeof p === "string" ? p : "";
};
const resultText = (result: any): string => {
  const c = result?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (b && b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
  return "";
};
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
function checklistItem(inner: Frame): ChecklistItem | null {
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
    else if (op === "key" && typeof args.combo === "string") label = `Pressing ${args.combo}`;
    return { id: String(inner.toolCallId || inner.id || label + now()), label, cls };
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
  return { id: String(inner.toolCallId || inner.id || label + now()), label, cls };
}
const touchedPath = (inner: Frame): string | null => {
  if (inner.type !== "tool_execution_start") return null;
  if (!/write|edit|patch|replace|rename|create|delete|move|insert/i.test(String(inner.toolName || ""))) return null;
  const args = inner.args || {};
  const p = args.path || args.file || args.filePath || args.file_path;
  return typeof p === "string" && p ? p : null;
};
const deployLines = (result: any): string[] => {
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
};
const resultMs = (result: any): number | undefined => {
  const n = result?.durationMs ?? result?.tookMs ?? result?.details?.durationMs ?? result?.details?.wallTimeMs;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
};
function activityFor(inner: Frame): { label: string } | null {
  const t = inner.type || "";
  if (t === "agent_start" || t === "turn_start") return { label: "Thinking…" };
  if (t === "tool_execution_start") return { label: toolLabel(String(inner.toolName || "")) };
  if (t === "tool_execution_update" || t === "tool_execution_end") return { label: "Thinking…" };
  if (t === "message_update") {
    const ev = inner.assistantMessageEvent?.type || "";
    if (ev.startsWith("thinking")) return { label: "Thinking…" };
    if (ev.startsWith("toolcall")) return { label: "Working…" };
    if (ev.startsWith("text")) return { label: "Replying…" };
    return null;
  }
  if (t === "auto_compaction_start") return { label: "Compacting context…" };
  if (t === "auto_compaction_end") return { label: "Thinking…" };
  if (t === "subagent_lifecycle" || t === "subagent_progress") return { label: "Coordinating a subagent…" };
  if (t === "extension_ui_request") return { label: "Needs your input…" };
  return null;
}

export function findPrUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s"'`]+\/(?:pull|merge_requests|\/-\/merge_requests)\/\d+/i);
  return m ? m[0] : null;
}

// A "scripted-ok" assistant line collapses into a checklist item, not prose.
function scriptOkDetail(txt: string): string | null {
  const m = txt.match(/^\s*(?:OK|DONE|READY)[:\-–—]\s*(.{3,80})\s*$/im);
  return m ? m[1] : null;
}

function shotRow(txt: string): Row | null {
  if (!txt.startsWith("{") || !txt.includes("computer.")) return null;
  try {
    const j = JSON.parse(txt) as any;
    if (j?.type !== "computer.observe" && j?.type !== "computer.screenshot") return null;
    const savedTo = typeof j.savedTo === "string" ? j.savedTo : "";
    const name = savedTo.split("/").pop() || "";
    if (!name) return null;
    const wins = Array.isArray(j.windows) ? j.windows : [];
    const titled = wins.filter((w: any) => typeof w?.title === "string" && w.title);
    const active = titled.find((w: any) => w?.active)?.title || titled[0]?.title || "";
    const short = String(active).split("—")[0].split(" - ")[0].trim().slice(0, 28);
    const caption =
      j.type === "computer.screenshot"
        ? "Screenshot"
        : `Observed${short ? ` · ${short}` : ""}${titled.length > 1 && titled.length <= 6 ? ` +${titled.length - 1}` : ""}`;
    return { id: nid(), kind: "shot", shot: name, shotCaption: caption };
  } catch {
    return null;
  }
}
function deliverRow(txt: string): Row | null {
  if (!txt.startsWith("{") || !txt.includes("rig.deliver")) return null;
  try {
    const j = JSON.parse(txt) as any;
    if (j?.type !== "rig.deliver") return null;
    const path = typeof j.path === "string" ? j.path : "";
    if (!path) return null;
    return {
      id: nid(),
      kind: "deliver",
      deliver: {
        path,
        name: typeof j.name === "string" && j.name ? j.name : path.split("/").pop() || path,
        size: typeof j.size === "number" ? j.size : null,
        caption: typeof j.caption === "string" && j.caption ? j.caption : undefined,
      },
    };
  } catch {
    return null;
  }
}

const rowKey = (r: Row) => `${r.kind}:${r.text ?? r.shot ?? r.deliver?.name ?? r.file?.name ?? ""}`;

// ---------------------------------------------------------------------------
export class ChatEngine {
  sessionId: string;
  get rows(): Row[] {
    return this._rows();
  }
  setRows: (fn: (prev: Row[]) => Row[]) => void;
  private _rows: () => Row[];
  streaming: () => boolean;
  setStreaming: (v: boolean) => void;
  status: () => string;
  setStatus: (v: string) => void;
  streamText: () => string;
  setStreamText: (v: string) => void;
  workSec: () => number;
  setWorkSec: (v: number) => void;
  computerActive: () => boolean;
  setComputerActive: (v: boolean) => void;
  historyLoading: () => boolean;
  setHistoryLoading: (v: boolean) => void;
  historyExhausted: () => boolean;
  setHistoryExhausted: (v: boolean) => void;
  model: () => string | null;
  setModel: (v: string | null) => void;

  private off: (() => void) | null = null;
  private streamBuf = "";
  private streamTimer: any = null;
  private toolStarts = new Map<string, number>();
  private toolFrames = new Map<string, Frame>();
  private turnStartAt = 0;
  private turnActions = 0;
  private progLine: { id: string; label: string; start: number } | null = null;
  private pendingUser: string[] = [];
  private minSeqSeen = Infinity;
  private maxSeqSeen = 0;
  private histInflight = false;
  private histCut: number | null = null;
  private replayBuf: Frame[] | null = null;
  private replayMaxSeq = 0;
  private replayRetries = 0;
  private quietT: any = null;
  private lostT: any = null;
  private workTimer: any = null;
  private prData = { url: undefined as string | undefined, at: 0, files: new Set<string>(), shots: new Set<string>() };
  private disposed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    const [rows, setRows] = createSignal<Row[]>([], { equals: false });
    this._rows = rows;
    this.setRows = (fn) => setRows((prev) => fn(prev));
    [this.streaming, this.setStreaming] = createSignal(false);
    [this.status, this.setStatus] = createSignal("On it…");
    [this.streamText, this.setStreamText] = createSignal("");
    [this.workSec, this.setWorkSec] = createSignal(0);
    [this.computerActive, this.setComputerActive] = createSignal(false);
    [this.historyLoading, this.setHistoryLoading] = createSignal(false);
    [this.historyExhausted, this.setHistoryExhausted] = createSignal(false);
    [this.model, this.setModel] = createSignal<string | null>(null);

    this.replayBuf = [];
    this.off = rig.onFrame((f) => this.onWire(f));
    this.lostT = setTimeout(() => {
      if (!rig.connected) this.settle("Lost the link to your rig — trying again in a moment", true);
    }, 1500);
    this.subscribe(0);
    rig
      .request(sessionId, { type: "get_state" }, 8000)
      .then((r) => {
        const m = r?.data?.model;
        const label = typeof m === "string" ? m : m?.id || m?.modelId;
        if (label) {
          this.setModel(String(label));
          app.patchMeta(sessionId, { model: String(label) });
        }
      })
      .catch(() => {});
  }

  subscribe(since: number) {
    try {
      rig.subscribe(this.sessionId, since);
    } catch {
      setTimeout(() => this.subscribe(since), 800);
    }
  }

  dispose() {
    this.disposed = true;
    this.off?.();
    clearTimeout(this.quietT);
    clearTimeout(this.lostT);
    clearInterval(this.workTimer);
    clearTimeout(this.streamTimer);
  }

  private flushReplay = () => {
    const buf = this.replayBuf;
    if (!buf) return;
    this.replayBuf = null;
    this.batching++;
    try {
      for (const inner of buf) {
        try {
          this.handleReplay(inner, true);
        } catch {}
      }
    } finally {
      this.batching--;
      if (this.pendingRows.length) {
        const pr = this.pendingRows;
        this.pendingRows = [];
        this.setRows((prev) => [...prev, ...pr].slice(-1600));
      }
      // ring replay may be all delta noise — pull persisted history when thin
      if (this.rows.length < 40 && this.minSeqSeen > 1) this.loadOlder();
    }
  };

  private onWire(f: Frame) {
    if (this.disposed) return;
    if (f.type === "session.subscribed" && f.sessionId === this.sessionId) {
      clearTimeout(this.quietT);
      this.quietT = null;
      this.flushReplay();
      // ring may carry only delta noise — page the persisted log for real rows
      if (this.rows.length < 40 && this.minSeqSeen > 1) this.loadOlder();
      return;
    }
    if (f.type === "error" && (f.sessionId === this.sessionId || !f.sessionId)) {
      const msg = String(f.error || f.message || "");
      if (/replay truncated/i.test(msg)) {
        this.flushReplay();
        if (this.replayRetries++ < 5 && rig.connected) {
          this.replayBuf = [];
          rig.subscribe(this.sessionId, this.replayMaxSeq);
        }
        return;
      }
      if (/no such session/i.test(msg)) {
        app.patchMeta(this.sessionId, { dead: true });
        this.settle("Session ended — the rig restarted it", true);
        return;
      }
      if (this.replayBuf?.length) {
        this.flushReplay();
        return;
      }
    }
    if (f.type === "session.history" && f.sessionId === this.sessionId) {
      const cut = this.histCut ?? this.rows.length;
      this.histCut = null;
      this.histInflight = false;
      this.setHistoryLoading(false);
      this.setHistoryExhausted(!!f.exhausted);
      this.setRows((prev) => {
        const head = prev.slice(0, cut);
        const page = prev.slice(cut);
        if (!page.length) return prev;
        const seen = new Set(head.map(rowKey));
        const clean = page.filter((r) => r.kind === "sep" || !seen.has(rowKey(r)));
        const lastP = [...clean].reverse().find((r) => r.kind !== "sep" && r.at);
        const firstH = head.find((r) => r.kind !== "sep" && r.at);
        const gapSep =
          lastP?.at && firstH?.at && firstH.at - lastP.at > GAP_MS
            ? [{ id: nid(), kind: "sep" as const, text: sepLabel(firstH.at) }]
            : [];
        return [...clean, ...gapSep, ...head];
      });
      // keep paging until the transcript is readable or the log is exhausted
      if (this.rows.length < 40 && !this.historyExhausted() && this.minSeqSeen > 1)
        queueMicrotask(() => this.loadOlder());
      return;
    }
    if (f.type !== "rpc" || f.sessionId !== this.sessionId) return;
    const inner = (f.frame || {}) as Frame;
    if (typeof f.seq === "number") {
      if (f.seq < this.minSeqSeen) this.minSeqSeen = f.seq;
      if (f.seq > this.maxSeqSeen) this.maxSeqSeen = f.seq;
    }
    if (f.history) {
      if (this.histCut === null) this.histCut = this.rows.length;
      try {
        this.handleReplay(inner);
      } catch {}
      return;
    }
    if (f.replay && typeof f.seq === "number" && f.seq > this.replayMaxSeq) this.replayMaxSeq = f.seq;
    if (f.replay && this.replayBuf) {
      this.replayBuf.push(inner);
      clearTimeout(this.quietT);
      this.quietT = setTimeout(this.flushReplay, 1200);
      return;
    }
    try {
      if (f.replay) this.handleReplay(inner, true);
      else this.handleLive(inner);
    } catch {}
  }

  // ---- row helpers ----
  private batching = 0;
  private pendingRows: Row[] = [];
  private pushRow(r: Row, prev: Row[]): Row[] {
    const next = [...prev];
    const lastMsg = [...next.slice(-200)].reverse().find((x) => x.kind !== "sep" && x.at);
    if (r.at && (!lastMsg || r.at - (lastMsg.at || 0) > GAP_MS))
      next.push({ id: nid(), kind: "sep", text: sepLabel(r.at) });
    next.push(r);
    return next;
  }
  private addRow = (r: Row, dedupeLast = false) => {
    r = { ...r, at: r.at ?? now() };
    if (this.batching > 0) {
      const last = this.pendingRows[this.pendingRows.length - 1];
      if (dedupeLast && last && last.kind === r.kind && last.text === r.text) return;
      // seed the gap check from committed rows when the batch is empty
      const base = this.pendingRows.length ? this.pendingRows : this.rows.slice(-1);
      this.pendingRows = this.pushRow(r, base).slice(this.pendingRows.length ? 0 : base.length);
      return;
    }
    this.setRows((prev) => {
      const last = prev[prev.length - 1];
      if (dedupeLast && last && last.kind === r.kind && last.text === r.text) return prev;
      const next = [...prev];
      const lastMsg = [...next.slice(-200)].reverse().find((x) => x.kind !== "sep" && x.at);
      if (r.at && (!lastMsg || r.at - (lastMsg.at || 0) > GAP_MS))
        next.push({ id: nid(), kind: "sep", text: sepLabel(r.at) });
      next.push(r);
      return next.slice(-1600);
    });
  };
  private addRowOnce = (r: Row) => {
    r = { ...r, at: r.at ?? now() };
    if (this.batching > 0) {
      const tail = this.pendingRows.slice(-200);
      if (r.kind === "event" || r.kind === "error") {
        if (tail.some((x) => (x.kind === "event" || x.kind === "error") && x.text === r.text)) return;
      } else if (r.kind === "shot") {
        if (tail.some((x) => x.kind === "shot" && x.shot === r.shot)) return;
      } else if (tail.some((x) => x.kind === r.kind && x.text === r.text)) return;
      const base = this.pendingRows.length ? this.pendingRows : this.rows.slice(-1);
      this.pendingRows = this.pushRow(r, base).slice(this.pendingRows.length ? 0 : base.length);
      return;
    }
    this.setRows((prev) => {
      const tail = prev.slice(-200);
      if (r.kind === "event" || r.kind === "error") {
        if (tail.some((x) => (x.kind === "event" || x.kind === "error") && x.text === r.text)) return prev;
      } else if (r.kind === "shot") {
        if (tail.some((x) => x.kind === "shot" && x.shot === r.shot)) return prev;
      } else if (tail.some((x) => x.kind === r.kind && x.text === r.text)) return prev;
      const next = [...prev];
      const lastMsg = [...tail].reverse().find((x) => x.kind !== "sep" && x.at);
      if (r.at && (!lastMsg || r.at - (lastMsg.at || 0) > GAP_MS))
        next.push({ id: nid(), kind: "sep", text: sepLabel(r.at) });
      next.push(r);
      return next.slice(-1600);
    });
  };

  private flushStream = (imm = false) => {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    if (imm) {
      this.setStreamText(this.streamBuf);
      return;
    }
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this.setStreamText(this.streamBuf);
    }, 80);
  };

  private markWorking() {
    if (!this.streaming()) {
      this.setStreaming(true);
      this.workTimer && clearInterval(this.workTimer);
      const t0 = now();
      this.workTimer = setInterval(() => this.setWorkSec(Math.max(1, Math.floor((now() - t0) / 1000))), 1000);
    }
  }

  private closeChecklist() {
    this.setRows((prev) =>
      prev.map((r) => (r.kind === "check" && r.streaming ? { ...r, streaming: false } : r))
    );
  }

  private noteProg = (label: string) => {
    if (this.progLine?.label === label) return;
    const t = now();
    const prev = this.progLine;
    const rowId = nid();
    this.progLine = { id: rowId, label, start: t };
    this.setRows((rows) => {
      const next = prev
        ? rows.map((r) =>
            r.id === prev.id
              ? { ...r, text: `${prev.label.replace(/…+\s*$/, "").trim()} · ${fmtMs(t - prev.start)}`, live: false }
              : r
          )
        : [...rows];
      next.push({ id: rowId, kind: "prog", text: label, live: true, at: t });
      return next.slice(-1600);
    });
  };
  private stampProgLine = () => {
    const prev = this.progLine;
    if (!prev) return;
    this.progLine = null;
    const text = `${prev.label.replace(/…+\s*$/, "").trim()} · ${fmtMs(now() - prev.start)}`;
    this.setRows((rows) => rows.map((r) => (r.id === prev.id ? { ...r, text, live: false } : r)));
  };

  private settle = (label?: string, isErr = false) => {
    this.setStreaming(false);
    this.streamBuf = "";
    this.flushStream(true);
    this.setWorkSec(0);
    clearInterval(this.workTimer);
    this.workTimer = null;
    this.setComputerActive(false);
    this.closeChecklist();
    this.setRows((prev) =>
      prev.map((r) => {
        if (r.kind === "sub" && /running|waiting/i.test(r.sub?.status || ""))
          return { ...r, sub: { ...(r.sub || { key: "", desc: "" }), status: "Done" } };
        if (r.kind === "approval" && r.approval?.state === "pending")
          return { ...r, approval: { ...r.approval, state: "done" as const, resolved: "secondary" as const, doneLabel: "Dismissed" } };
        return r;
      })
    );
    this.stampProgLine();
    if (!isErr && this.turnStartAt && this.turnActions > 0)
      this.addRow({ id: nid(), kind: "prog", text: `Worked ${fmtMs(now() - this.turnStartAt)}` });
    this.turnStartAt = 0;
    this.turnActions = 0;
    if (label)
      this.addRowOnce({
        id: nid(),
        kind: isErr ? "error" : "event",
        text: isErr ? friendlyError(label) : label.split("\n")[0].slice(0, 200),
      });
  };

  private addCheckItem = (label: string) => {
    this.setRows((prev) => {
      let cIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].kind === "user") break;
        if (prev[i].kind === "check") {
          cIdx = i;
          break;
        }
      }
      if (cIdx >= 0) {
        const items = prev[cIdx].items || [];
        if (items.some((i) => i.label === label)) return prev;
        return prev.map((r, i) =>
          i === cIdx ? { ...r, items: [...items, { id: nid(), label, done: true }] } : r
        );
      }
      const at = now();
      const next = [...prev];
      const lastMsg = [...next].reverse().find((x) => x.kind !== "sep" && x.at);
      if (!lastMsg || at - (lastMsg.at || 0) > GAP_MS)
        next.push({ id: nid(), kind: "sep", text: sepLabel(at) });
      next.push({ id: nid(), kind: "check", at, items: [{ id: nid(), label, done: true }] });
      return next.slice(-1600);
    });
  };

  private upsertSub = (p: any) => {
    const key = String(p.parentToolCallId || p.id || p.toolCallId || "");
    if (!key) return;
    const hasDesc = Boolean(p.description ?? p.task ?? p.assignment ?? p.prompt);
    const desc = String(p.description ?? p.task ?? p.assignment ?? p.prompt ?? "Delegated task").slice(0, 180);
    const status = String(p.status || "Running");
    const agent = p.agent ? String(p.agent) : undefined;
    this.setRows((prev) => {
      const idx = prev.findIndex((r) => r.kind === "sub" && r.sub?.key === key);
      if (idx >= 0)
        return prev.map((r, i) =>
          i === idx
            ? { ...r, sub: { key, desc: hasDesc ? desc : r.sub?.desc || desc, status, agent: agent ?? r.sub?.agent } }
            : r
        );
      const next = [...prev];
      const lastMsg = [...next].reverse().find((x) => x.kind !== "sep" && x.at);
      const at = now();
      if (!lastMsg || at - (lastMsg.at || 0) > GAP_MS)
        next.push({ id: nid(), kind: "sep", text: sepLabel(at) });
      next.push({ id: nid(), kind: "sub", at, sub: { key, desc, status, agent } });
      return next.slice(-1600);
    });
  };

  private patchPr = () => {
    const d = this.prData;
    if (!d.url && !d.files.size && !d.shots.size) return;
    app.patchMeta(this.sessionId, {
      pr: { url: d.url, at: d.at, files: [...d.files], shots: [...d.shots] },
    });
  };
  private collectPr = (inner: Frame) => {
    const p = touchedPath(inner);
    if (p && !this.prData.files.has(p)) {
      this.prData.files.add(p);
      this.patchPr();
    }
  };

  private handleToolStart = (inner: Frame) => {
    if (String(inner.toolName || "") === "wait") {
      this.setRows((prev) => {
        const idx = prev.map((r, i) => (r.kind === "sub" ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
        if (idx < 0) return prev;
        return prev.map((r, i) =>
          i === idx && r.kind === "sub"
            ? { ...r, sub: { ...(r.sub || { key: "", desc: "" }), status: "Waiting on job…" } }
            : r
        );
      });
      return;
    }
    const item = checklistItem(inner);
    if (!item) return;
    this.toolStarts.set(item.id, now());
    this.toolFrames.set(item.id, inner);
    this.turnActions += 1;
    this.collectPr(inner);
    this.setRows((prev) => {
      let cIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].kind === "user") break;
        if (prev[i].kind === "check") {
          cIdx = i;
          break;
        }
      }
      if (cIdx >= 0) {
        return prev.map((r, i) =>
          i === cIdx && r.kind === "check"
            ? {
                ...r,
                streaming: true,
                items: (r.items || []).some((it) => it.id === item.id)
                  ? r.items
                  : [...(r.items || []), { ...item, done: false }],
              }
            : r
        );
      }
      return [...prev, { id: nid(), kind: "check" as const, streaming: true, items: [{ ...item, done: false }] }].slice(-1600);
    });
  };

  private emitToolCard = (inner: Frame, cid: string) => {
    const start = this.toolFrames.get(cid);
    this.toolFrames.delete(cid);
    const name = String(start?.toolName || inner.toolName || "");
    const cls = toolClass(name);
    const failed = inner.isError === true;
    if (cls === "term") {
      const cmd = start ? commandOf(start) : "";
      if (!cmd) return;
      const out = resultText(inner.result).replace(/\s*\n?Wall time:.*/is, "");
      const capped = out.trim().length > 12000 ? `${out.slice(0, 12000)}\n…` : out;
      this.addRow({ id: nid(), kind: "term", text: `term:${cid}`, term: { cmd, out: capped, ms: resultMs(inner.result), failed } }, true);
      return;
    }
    if (cls === "file") {
      const raw = pathOf(start || inner) || String(inner.result?.details?.resolvedPath || "");
      if (!raw) return;
      const resolved = String(inner.result?.details?.resolvedPath || raw);
      const clean = resolved.replace(/\/+$/, "");
      const fname = clean.split("/").pop() || clean;
      const dir = clean.slice(0, clean.length - fname.length).replace(/\/$/, "");
      let bytes: number | undefined;
      const c = (start as any)?.args?.content;
      if (typeof c === "string" && c.length) bytes = utf8Len(c);
      if (bytes == null) {
        const m = resultText(inner.result).match(/wrote\s+([\d.]+)\s*(KB|B|bytes)/i);
        if (m) bytes = /kb/i.test(m[2]) ? parseFloat(m[1]) * 1024 : parseFloat(m[1]);
      }
      let adds: number | undefined, dels: number | undefined;
      const olds = (start as any)?.args?.old_string ?? (start as any)?.args?.oldText;
      const news = (start as any)?.args?.new_string ?? (start as any)?.args?.newText;
      if (typeof olds === "string" || typeof news === "string") {
        dels = String(olds || "").split("\n").length;
        adds = String(news || "").split("\n").length;
      }
      this.addRow({ id: nid(), kind: "file", text: `file:${cid}`, file: { name: fname, dir: dir || undefined, bytes, adds, dels, failed } }, true);
      return;
    }
  };

  private handleToolEnd = (inner: Frame) => {
    const cid = String(inner.toolCallId || "");
    if (String(inner.toolName || "") === "wait") {
      this.setRows((prev) => {
        const idx = prev.map((r, i) => (r.kind === "sub" ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
        if (idx < 0) return prev;
        return prev.map((r, i) =>
          i === idx && r.kind === "sub"
            ? { ...r, sub: { ...(r.sub || { key: "", desc: "" }), status: inner.isError ? "Failed" : "Done" } }
            : r
        );
      });
      this.toolFrames.delete(cid);
      return;
    }
    const started = this.toolStarts.get(cid);
    this.toolStarts.delete(cid);
    const ms = resultMs(inner.result) ?? (started ? now() - started : undefined);
    this.setRows((prev) =>
      prev.map((r) =>
        r.kind === "check" && r.streaming
          ? { ...r, items: (r.items || []).map((i) => (i.id === cid ? { ...i, done: true, failed: inner.isError === true, ms } : i)) }
          : r
      )
    );
    const lines = deployLines(inner.result);
    if (lines.length) this.addRow({ id: nid(), kind: "prog", text: lines.join("\n") });
    const cls = toolClass(String(this.toolFrames.get(cid)?.toolName || inner.toolName || ""));
    this.emitToolCard(inner, cid);
    if (cls === "subagent")
      this.upsertSub({
        id: cid,
        status: inner.isError ? "Failed" : /^task$/i.test(String(inner.toolName || "")) ? "Running" : "Done",
      });
  };

  // ---- live frames ----
  private handleLive(inner: Frame) {
    const t = inner.type || "";
    if (t === "agent_start") {
      this.markWorking();
      this.setStatus("On it…");
      if (!this.turnStartAt) this.turnStartAt = now();
      return;
    }
    if (t === "subagent_lifecycle" || t === "subagent_progress") {
      this.upsertSub(inner.payload || inner);
      return;
    }
    if (t === "extension_ui_request") {
      const method = String(inner.method || "");
      const reqId = String(inner.id || "");
      if (method === "cancel") {
        const target = String(inner.targetId || "");
        this.setRows((prev) =>
          prev.map((r) =>
            r.kind === "approval" && r.approval?.reqId === target && r.approval.state !== "done"
              ? { ...r, approval: { ...r.approval, state: "done" as const, resolved: "secondary" as const, doneLabel: "Dismissed" } }
              : r
          )
        );
      } else if (method === "confirm") {
        this.addRow({
          id: nid(),
          kind: "approval",
          approval: {
            reqId,
            title: String(inner.title || "Approve this action?"),
            preview: inner.message ? String(inner.message) : undefined,
            state: "pending",
          },
        });
      } else if (method === "setWidget" || method === "setTitle" || method === "setStatus") {
        // status widgets, not input dialogs
      } else if (method) {
        this.noteProg("The agent needs input on the laptop — this dialog isn't in the app yet");
      }
      return;
    }
    if (t === "tool_execution_start") {
      this.markWorking();
      if (!this.turnStartAt) this.turnStartAt = now();
      if (/rig_computer/i.test(String(inner.toolName || ""))) this.setComputerActive(true);
      this.handleToolStart(inner);
      if (toolClass(String(inner.toolName || "")) === "subagent") {
        const a = inner.args || {};
        const first = Array.isArray(a.tasks) ? a.tasks[0] : undefined;
        this.upsertSub({
          id: String(inner.toolCallId || nid()),
          description: first?.task ?? first?.name ?? a.prompt ?? a.task ?? a.description ?? a.assign,
          agent: first?.agent ?? a.agent ?? a.agentName,
          status: "Running",
        });
      }
    } else if (t === "tool_execution_end") {
      this.handleToolEnd(inner);
    } else if (t === "message_update") {
      const ev = inner.assistantMessageEvent;
      if (ev?.type === "text_delta") {
        const partial = typeof ev.partial === "string" ? ev.partial : null;
        this.streamBuf = partial ?? this.streamBuf + (ev.delta || "");
        this.flushStream();
      }
    } else if (t === "message_end") {
      const msg = inner.message || inner;
      if (msg?.role === "assistant") {
        const txt = messageText(msg).trim();
        const ok = scriptOkDetail(txt);
        const morphed = this.streamBuf.length > 0;
        if (ok) this.addCheckItem(ok);
        else if (txt) {
          this.turnActions += 1;
          const u = findPrUrl(txt);
          if (u) {
            this.prData.url = u;
            this.prData.at = now();
            this.patchPr();
          }
          this.addRow({ id: nid(), kind: "agent", text: txt, noEnter: morphed || undefined }, true);
        }
        this.streamBuf = "";
        this.flushStream(true);
      } else if (msg?.role === "user") {
        const txt = messageText(msg).trim();
        const idx = this.pendingUser.indexOf(txt);
        if (idx >= 0) this.pendingUser.splice(idx, 1);
        else if (txt) this.addRow({ id: nid(), kind: "user", text: txt }, true);
      } else if (msg?.role === "toolResult") {
        const row = shotRow(messageText(msg).trim()) || deliverRow(messageText(msg).trim());
        if (row) {
          if (row.shot) {
            this.prData.shots.add(row.shot);
            this.patchPr();
          }
          this.addRow(row, true);
        }
      }
    } else if (t === "prompt_result") {
      const st = inner.status || (inner.ok === false ? "error" : inner.ok === true ? "ok" : "");
      if (st === "aborted") this.settle("Stopped");
      else if (st === "error") this.settle(inner.error?.message || inner.error || "Something went wrong on the rig", true);
      else this.settle();
    } else if (t === "agent_end" || t === "session_settled") {
      this.settle();
    } else if (t === "auto_retry_start") {
      const n = inner.attempt;
      const why = String(inner.errorMessage || inner.error?.message || inner.message || inner.reason || "")
        .split("\n")[0]
        .slice(0, 80);
      this.addRowOnce({ id: nid(), kind: "event", text: `Retrying${n ? ` (attempt ${n})` : ""}${why ? ` — ${friendlyError(why)}` : ""}` });
    } else if (t === "auto_retry_end") {
      if (!inner.success)
        this.addRowOnce({ id: nid(), kind: "error", text: friendlyError(inner.finalError || "gave up") });
    }
    const act = activityFor(inner);
    if (act) {
      this.setStatus(act.label);
      if (t !== "agent_end" && t !== "session_settled") this.noteProg(act.label);
    }
  }

  // ---- replayed frames (subscribe replay + history pages) ----
  private handleReplay(inner: Frame, liveReplay = false) {
    const t = inner.type || "";
    if (liveReplay && t === "agent_start") {
      this.setStreaming(true);
      this.setStatus("On it…");
      return;
    }
    if (liveReplay && t === "tool_execution_start") this.setStreaming(true);
    if (t === "message_end") {
      const msg = inner.message || inner;
      const txt = messageText(msg).trim();
      if (!txt) return;
      if (msg?.role === "user") this.addRowOnce({ id: nid(), kind: "user", text: txt });
      else if (msg?.role === "assistant") {
        const ok = scriptOkDetail(txt);
        if (ok) this.addCheckItem(ok);
        else {
          const u = findPrUrl(txt);
          if (u && u !== this.prData.url) {
            this.prData.url = u;
            this.prData.at = now();
            this.patchPr();
          }
          this.addRowOnce({ id: nid(), kind: "agent", text: txt });
        }
      } else if (msg?.role === "toolResult") {
        const row = shotRow(txt) || deliverRow(txt);
        if (row) {
          if (row.shot) this.prData.shots.add(row.shot);
          this.addRowOnce(row);
        }
      }
    } else if (t === "tool_execution_start") {
      const item = checklistItem(inner);
      this.collectPr(inner);
      if (toolClass(String(inner.toolName || "")) === "subagent") {
        const a = inner.args || {};
        const first = Array.isArray(a.tasks) ? a.tasks[0] : undefined;
        this.upsertSub({
          id: String(inner.toolCallId || nid()),
          description: first?.task ?? first?.name ?? a.prompt ?? a.task ?? a.description ?? a.assign,
          agent: first?.agent ?? a.agent ?? a.agentName,
          status: "Done",
        });
      }
      if (item && String(inner.toolName || "") !== "wait") {
        this.toolFrames.set(item.id, inner);
        this.setRows((prev) => {
          let idx = -1;
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].kind === "user") break;
            if (prev[i].kind === "check") {
              idx = i;
              break;
            }
          }
          if (idx >= 0)
            return prev.map((r, i) =>
              i === idx && r.kind === "check"
                ? { ...r, items: (r.items || []).some((x) => x.id === item.id) ? r.items : [...(r.items || []), { ...item, done: true }] }
                : r
            );
          return [...prev, { id: nid(), kind: "check" as const, items: [{ ...item, done: true }] }].slice(-1600);
        });
      }
    } else if (t === "tool_execution_end") {
      const cid = String(inner.toolCallId || "");
      const cls = toolClass(String(this.toolFrames.get(cid)?.toolName || inner.toolName || ""));
      this.emitToolCard(inner, cid);
      if (cls === "subagent") this.upsertSub({ id: cid, status: inner.isError ? "Failed" : "Done" });
    } else if (t === "subagent_lifecycle" || t === "subagent_progress") {
      this.upsertSub(inner.payload || inner);
    } else if (t === "extension_ui_request" && inner.method === "confirm") {
      this.addRowOnce({
        id: nid(),
        kind: "approval",
        approval: {
          reqId: String(inner.id || ""),
          title: String(inner.title || "Approve this action?"),
          preview: inner.message ? String(inner.message) : undefined,
          doneLabel: "Resolved",
          state: "done",
        },
      });
    } else if (t === "prompt_result") {
      if (inner.status === "error")
        this.addRowOnce({ id: nid(), kind: "error", text: friendlyError(inner.error?.message || "Something went wrong on the rig") });
      else this.settle(inner.status === "aborted" ? "Stopped" : undefined);
    } else if (t === "agent_end" || t === "session_settled") {
      this.settle();
    } else if (t === "auto_retry_end") {
      if (!inner.success)
        this.addRowOnce({ id: nid(), kind: "error", text: friendlyError(inner.finalError || "gave up") });
    }
  }

  // ---- public API ----
  send(text: string, images?: Frame[]) {
    const message = text.trim();
    if (!message && !images?.length) return;
    if (!rig.connected) {
      this.settle("Can't reach the rig — send again in a moment", true);
      return;
    }
    const displayText = text || (images || []).map(() => `Attached image`).join("\n");
    this.addRow({ id: nid(), kind: "user", text: displayText });
    this.pendingUser.push(displayText);
    this.setStreaming(true);
    this.setStatus("On it…");
    this.turnStartAt = now();
    this.turnActions = 0;
    rig.prompt(this.sessionId, message, images);
  }

  stop() {
    try {
      rig.rpc(this.sessionId, { type: "abort" });
    } catch {}
  }

  loadOlder() {
    if (this.histInflight || this.historyExhausted() || !rig.connected || !(this.minSeqSeen > 1)) return;
    this.histInflight = true;
    this.setHistoryLoading(true);
    rig.trySend({ type: "session.history", sessionId: this.sessionId, before: this.minSeqSeen, limit: 160 });
  }

  respondApproval(reqId: string, confirmed: boolean) {
    if (!reqId) return;
    if (rig.connected) rig.rpc(this.sessionId, { type: "extension_ui_response", id: reqId, confirmed });
    this.setRows((prev) =>
      prev.map((r) =>
        r.kind === "approval" && r.approval?.reqId === reqId
          ? { ...r, approval: { ...r.approval, state: "done" as const, resolved: confirmed ? ("primary" as const) : ("secondary" as const) } }
          : r
      )
    );
  }

  maxSeq() {
    return this.maxSeqSeen === 0 ? 0 : this.maxSeqSeen;
  }
}

// engine cache — one per session, survives route navigation
const engines = new Map<string, ChatEngine>();
if (typeof window !== "undefined") (window as any).__engines = engines;
export function engineFor(sessionId: string): ChatEngine {
  let e = engines.get(sessionId);
  if (!e) {
    e = new ChatEngine(sessionId);
    engines.set(sessionId, e);
  }
  return e;
}
export function dropEngine(sessionId: string) {
  engines.get(sessionId)?.dispose();
  engines.delete(sessionId);
}
