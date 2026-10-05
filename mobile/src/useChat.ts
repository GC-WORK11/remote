// useSessionChat — the shared chat engine for both modes (Cowork + Code).
// Owns rows, streaming state, attachments, model picker, and the rpc wire.
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { rig, Frame } from "./rig";
import { cleanAgentText } from "./agentText";
import { useRig, messageText } from "./state";
import {
  activityFor,
  checklistItem,
  touchedPath,
  deployLines,
  resultMs,
  toolClass,
  commandOf,
  pathOf,
  resultText,
} from "./activity";
import { findPrUrl } from "./components/cards";
import { fmtMs } from "./components/bubbles";
import type { Attachment } from "./components/composer";
import type { ChecklistRow } from "./components/bubbles";

export interface Row {
  id: string;
  kind:
    | "sep"
    | "user"
    | "agent"
    | "check"
    | "event"
    | "error"
    | "shot"
    | "prog"
    | "term"
    | "file"
    | "sub"
    | "approval"
    | "voice"
    | "video"
    | "deliver"
    | "build";
  text?: string;
  images?: string[];
  at?: number;
  items?: ChecklistRow[];
  streaming?: boolean;
  /** Row was already on screen as the live tail — skip the entrance spring. */
  noEnter?: boolean;
  /** Archived observe/screenshot name under ~/.rig/shots (shot rows). */
  shot?: string;
  /** Caption line under a shot card — e.g. "Observed · Calculator +2". */
  shotCaption?: string;
  /** Optional resolved preview uri for the shot card thumbnail. */
  shotUri?: string;
  /** In-flight progress line — stamps its real elapsed when the phase ends. */
  live?: boolean;
  /** deliver rows: a file the agent handed to the phone (rig_deliver tool). */
  deliver?: { path: string; name: string; size?: number | null; caption?: string };
  /** term rows: the real command + output + wall time from the wire. */
  term?: { cmd: string; out: string; ms?: number; failed?: boolean };
  /** file rows: the real path + size/diff hints from write/edit args. */
  file?: { name: string; dir?: string; bytes?: number; adds?: number; dels?: number; failed?: boolean };
  /** sub rows: a delegated agent's live/terminal state. */
  sub?: { key: string; desc: string; status: string; agent?: string };
  /** approval rows: an action awaiting the user's confirm/deny. */
  approval?: {
    /** extension_ui_request id — the response must echo it back. */
    reqId?: string;
    title: string;
    preview?: string;
    primary?: string;
    secondary?: string;
    doneLabel?: string;
    state?: "pending" | "done";
    resolved?: "primary" | "secondary";
  };
  /** voice rows: a voice-note card — render-only, no audio pipeline yet. */
  voice?: { durationSec: number };
  /** video rows: a screen-recording clip card — render-only chrome. */
  video?: { uri?: string; durationSec?: number; caption?: string };
  /** build rows: a build/job card — running shimmer or finished summary. */
  build?: {
    status: "building" | "success" | "failed";
    id?: string;
    url?: string;
    artifact?: string;
    size?: string;
    durationSec?: number;
  };
}

let rowSeq = 0;
const nid = () => `r${++rowSeq}`;
const GAP_MS = 10 * 60 * 1000;
// Wall-clock for wire-side timing (settle stamps, turn elapsed). Module scope
// keeps it outside the component's purity-checked render scope.
const now = () => Date.now();

// TextEncoder is absent in RN Hermes — UTF-8 byte length by hand (surrogate
// pairs count as the 4 bytes they encode to, not 3+3).
const utf8Len = (s: string) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00) {
      n += 4;
      i++;
    } else n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return n;
};

// Grok-style separators: "Today 8:00 AM", "Yesterday 3:20 PM", "Mar 3 2:45 PM".
export function sepLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// Prompts sent before a session exists must survive navigation between
// screens — kept module-level, not per-hook.
// Queue a prompt that fires the moment the next session.started lands — the
// folder-picker flow stashes the composer's text here so the picker's
// session.new{cwd} still receives it.
let pendingPrompt: { message: string; images: Frame[] } | null = null;
// Wall-clock the queued prompt was stashed — a stale pendingPrompt must
// never fire into an unrelated session.started (wrong bot gets the text).
let pendingPromptAt = 0;
let pendingActiveId: string | null = null;
let sessionStartedHooked = false;
// last model the user picked — new sessions inherit it so they never boot
// into the provider-file default (a dead stub, etc.)
let preferredModel: string | null = null;
// The model pick should survive relaunches — a fresh session must never
// silently fall back to the daemon default (whose provider may be out of
// quota). Hydrate once from storage.
AsyncStorage.getItem("preferredModel").then((v) => {
  if (v && !preferredModel) preferredModel = v;
}).catch(() => {});
// Same for reasoning effort — new sessions fold it into the model spec
// (provider/model:level); live sessions get set_thinking_level over rpc.
let preferredEffort: string | null = null;
AsyncStorage.getItem("preferredEffort").then((v) => {
  if (v && !preferredEffort) preferredEffort = v;
}).catch(() => {});
// Agent runtime for the next session.new — "omp" fork by default;
// "claude" drives claude-code through the daemon's harness adapter.
let preferredHarness = "omp";
AsyncStorage.getItem("preferredHarness").then((v) => {
  if (v) preferredHarness = v;
}).catch(() => {});
export function getPreferredHarness() {
  return preferredHarness;
}
export function setPreferredHarness(h: string) {
  preferredHarness = h || "omp";
  AsyncStorage.setItem("preferredHarness", preferredHarness).catch(() => {});
}
let expectActiveNext = false;
// Wall-clock the expectation was armed. A session.new whose session.started
// never lands — socket died mid-send, daemon dropped the spawn, or the user
// backed out and opened a different thread — must not leave this armed:
// while it is, isExpectingNew() makes every thread render [] even though
// the transcript underneath rebuilt fine.
let expectActiveAt = 0;
// session.started normally lands inside a second of session.new — 25s of
// grace covers a slow spawn, not an abandoned flow.
const EXPECT_MS = 25 * 1000;
// True while a client-initiated session.new is in flight — the thread
// renders its empty state instead of the previous session's rows until
// session.started assigns the real id.
export function isExpectingNew() {
  if (expectActiveNext && now() - expectActiveAt > EXPECT_MS) expectActiveNext = false;
  return expectActiveNext;
}
// session.started can land after the thread screen already mounted —
// mounted hooks listen for the id landing instead of a one-shot read.
const pendingActiveWaiters = new Set<(sid: string) => void>();
function assignPendingActive(sid: string) {
  pendingActiveId = sid;
  pendingActiveWaiters.forEach((w) => w(sid));
}

function hookSessionStarted() {
  if (sessionStartedHooked) return;
  sessionStartedHooked = true;
  rig.onFrame((f: Frame) => {
    if (f.type !== "session.started") return;
    const sid = (f.sessionId || f.id) as string | undefined;
    if (!sid) return;
    // A queued prompt that outlived its window is stale — firing it now
    // would deliver it into whichever session happened to start next.
    if (pendingPrompt && now() - pendingPromptAt > EXPECT_MS) pendingPrompt = null;
    // The folder picker starts sessions without a prompt — the thread must
    // still adopt the new session instead of staying on the previous one.
    if (isExpectingNew() && !pendingPrompt) {
      expectActiveNext = false;
      assignPendingActive(sid);
      return;
    }
    if (pendingPrompt) {
      const { message, images } = pendingPrompt;
      pendingPrompt = null;
      expectActiveNext = false;
      assignPendingActive(sid);
      rig.subscribe(sid, 0);
      rig.prompt(sid, message, images);
    }
  });
}

// "+" paths — every client-initiated session.new must mark the next
// session.started as the thread's active, else /thread renders the stale
// previous session. Also carries the user's model pick.
export function startPlainSession() {
  hookSessionStarted();
  expectActiveNext = true;
  expectActiveAt = now();
  const f: Frame = { type: "session.new" };
  if (preferredModel) f.model = preferredModel;
  if (preferredEffort) f.thinking = preferredEffort;
  if (preferredHarness !== "omp") f.harness = preferredHarness;
  // rig.send throws on a dead socket — disarm before swallowing or the flag
  // poisons every thread's render until the expiry kicks in.
  try {
    rig.send(f);
  } catch {
    expectActiveNext = false;
  }
}

// Create a session rooted at a real folder on the host — inherits the last
// model the user picked so a fresh project never boots the provider default.
export function startSessionWithCwd(cwd: string) {
  hookSessionStarted();
  expectActiveNext = true;
  expectActiveAt = now();
  const f: Frame = { type: "session.new", cwd };
  if (preferredModel) f.model = preferredModel;
  if (preferredEffort) f.thinking = preferredEffort;
  if (preferredHarness !== "omp") f.harness = preferredHarness;
  try {
    rig.send(f);
  } catch {
    expectActiveNext = false;
  }
}

// One-line preview text for inbox rows — strip code ticks/markdown so a
// reply like "Done — created `x.md`" reads clean next to the timestamp.
export function cleanPreview(t?: string): string {
  return cleanAgentText(String(t || ""))
    .replace(/^SCRIPT-OK:\s*ran\s+\d+\s+action\(s\):\s*/i, "")
    .replace(/^#{1,4}\s+/gm, "")
    .replace(/^[-*•+>]\s+/gm, "")
    .replace(/^\d+[.)]\s+/gm, "")
    .replace(/[`*_~#\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// The stub provider narrates tool actions as assistant prose
// ("SCRIPT-OK: ran 1 action(s): write x.txt"). That reads like debug
// output as a bubble — convert to a checklist line instead.
function scriptOkDetail(txt: string): string | null {
  const m = txt.match(/^SCRIPT-OK:\s*ran\s+\d+\s+action\(s\):\s*(.+)$/is);
  return m ? m[1].replace(/[.\s]+$/, "").trim() : null;
}

// Provider failures arrive as raw API dumps ("Google API error (429): You
// exceeded your current quota… https://ai.google.dev/…"). The thread shows
// one plain sentence instead — full detail stays in the daemon log.
export function friendlyError(raw?: string): string {
  const m = String(raw || "").replace(/\s+/g, " ").trim();
  if (!m) return "Something went wrong on the rig";
  if (/\b429\b|quota|rate.?limit|resource.?exhausted/i.test(m))
    return "That model is out of quota — switch model or try again later";
  if (/thinking level is not supported|reasoning.*not supported|effort.*not supported/i.test(m))
    return "That reasoning level isn't supported by this model";
  if (/\b401\b|unauthorized|invalid api key|authentication/i.test(m))
    return "The provider rejected our login — reconnect it in Providers";
  if (/\b403\b|forbidden|permission/i.test(m))
    return "The provider denied access — check the connected subscription";
  if (/\b400\b|bad request|invalid/i.test(m) && /model|param|argument|field/i.test(m))
    return "The provider rejected that request — try a different model";
  if (/\b404\b|not found|no such model/i.test(m))
    return "That model isn't available on this provider";
  if (/\b5\d\d\b|overloaded|unavailable|timeout|timed out|econn|socket|fetch failed/i.test(m))
    return "The provider isn't responding — try again in a moment";
  if (/gave up|retry|retries/i.test(m))
    return "The provider kept failing after retries — try again or switch model";
  return m.split("\n")[0].slice(0, 160);
}

// rig_computer observe/screenshot results arrive as a JSON text blob on the
// tool message. The image bytes go straight to the model — what survives in
// history is the metadata + the archived shot path, which is enough for the
// app to render the "what the agent saw" card via computer.shot_file.
function shotRow(txt: string): Row | null {
  if (!txt.startsWith("{") || !txt.includes("computer.")) return null;
  try {
    const j = JSON.parse(txt) as any;
    if (j?.type !== "computer.observe" && j?.type !== "computer.screenshot")
      return null;
    const savedTo = typeof j.savedTo === "string" ? j.savedTo : "";
    const name = savedTo.split("/").pop() || "";
    if (!name) return null;
    const wins = Array.isArray(j.windows) ? (j.windows as any[]) : [];
    const titled = wins.filter((w) => typeof w?.title === "string" && w.title);
    const active = titled.find((w) => w?.active)?.title || titled[0]?.title || "";
    const short = String(active).split("—")[0].split(" - ")[0].trim().slice(0, 28);
    const caption =
      j.type === "computer.screenshot"
        ? "Screenshot"
        : `Observed${short ? ` · ${short}` : ""}${
            titled.length > 1 && titled.length <= 6 ? ` +${titled.length - 1}` : ""
          }`;
    return { id: nid(), kind: "shot", shot: name, shotCaption: caption };
  } catch {
    return null;
  }
}

// rig_deliver results arrive as a JSON text blob on the tool message — the
// {"type":"rig.deliver"} marker rides the same channel as observe shots.
// The path is daemon-side; the card downloads it on tap via rig.fs.read.
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

export function sessionTitle(s: any): string {
  // Grok-style: thread named after its first prompt (daemon captures it);
  // cwd basename is the fallback for sessions that predate titles.
  const t = (s?.title || "").trim();
  if (t) return t;
  const cwd = s?.cwd || "";
  if (cwd) return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
  return "Conversation";
}

export function useSessionChat() {
  const { active, sessions, sessionMeta, patchMeta, connected, setActive, hostInfo } = useRig();
  const [rows, setRows] = useState<Row[]>([]);
  const rowsRef = useRef<Row[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  });
  // Deep-history paging (session.history): page frames append through the
  // normal replay path, then the ack rotates them ahead of current rows.
  const minSeqSeen = useRef(Infinity);
  const maxSeqSeen = useRef(0);
  const lastSubscribed = useRef<string | null>(null);
  const histCut = useRef<number | null>(null);
  const histInflight = useRef(false);
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("On it…");
  const [streamText, setStreamText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [modelSheet, setModelSheet] = useState(false);
  const [models, setModels] = useState<any[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const pendingUser = useRef<string[]>([]);
  const streamBuf = useRef("");
  // Deltas arrive per token — committing each to state re-parses the whole
  // markdown tail dozens of times a second (the visible "slop"). Batch them
  // and flush at ~12fps; the buffer itself stays lossless.
  const streamTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushStream = (now = false) => {
    if (streamTimer.current) {
      clearTimeout(streamTimer.current);
      streamTimer.current = null;
    }
    if (now) {
      setStreamText(streamBuf.current);
      return;
    }
    streamTimer.current = setTimeout(() => {
      streamTimer.current = null;
      setStreamText(streamBuf.current);
    }, 80);
  };
  // RN controlled-input race: after send() clears the field, a queued
  // onChangeText can arrive carrying the pre-clear text and resurrect it.
  const justSent = useRef<{ raw: string; at: number } | null>(null);
  const onInput = (t: string) => {
    const s = justSent.current;
    if (s) {
      const dt = Date.now() - s.at;
      // A stale full-field replay (composition commit, autocorrect sync)
      // can land deep into the turn — drop exact replays for 30s, prefix
      // replays only inside the original 3.5s burst window.
      const full = t === s.raw || t.trim() === s.raw.trim();
      if ((full && dt < 30000) || (s.raw.startsWith(t) && dt < 3500)) return;
    }
    justSent.current = null;
    setInput(t);
  };
  // The turn's real clock — drives the WorkingRow seconds and the job
  // card's progress bar + time pill (no daemon progress channel exists).
  const [workSec, setWorkSec] = useState(0);
  const workStart = useRef(0);
  // True once a rig_computer tool runs in the live turn — the job card
  // surfaces immediately for computer-use work, after a few seconds for
  // anything else long-running.
  const [computerActive, setComputerActive] = useState(false);

  // Live-only timing: tool starts are stamped on arrival so settle time can
  // be shown per checklist item — replayed frames have no clocks, no stamp.
  const toolStarts = useRef(new Map<string, number>());
  // Start args survive to tool_execution_end so term/file cards render the
  // REAL command and path — never a re-derived approximation.
  const toolFrames = useRef(new Map<string, Frame>());
  const turnStartAt = useRef(0);
  const turnActions = useRef(0);
  // The one open mid-turn progress line — "Waiting for Checks", "Running
  // tests in the background". One per distinct status sentence; it stamps
  // `· Ns` when the next sentence (or the settle) closes it.
  const progLine = useRef<{ id: string; label: string; start: number } | null>(null);
  // PR evidence for this session's pr view — rebuilt from the transcript.
  const prData = useRef<{ url?: string; at?: number; files: Set<string>; shots: Set<string> }>({
    files: new Set(),
    shots: new Set(),
  });

  const patchPr = () => {
    const d = prData.current;
    if (!active || (!d.url && !d.files.size && !d.shots.size)) return;
    patchMeta(active, {
      pr: { url: d.url, at: d.at, files: [...d.files], shots: [...d.shots] },
    });
  };

  const collectPr = (inner: Frame) => {
    const p = touchedPath(inner);
    if (p && !prData.current.files.has(p)) {
      prData.current.files.add(p);
      patchPr();
    }
  };

  useEffect(() => {
    if (!streaming) return;
    if (!workStart.current) workStart.current = Date.now();
    const t = setInterval(
      () => setWorkSec(Math.max(1, Math.floor((Date.now() - workStart.current) / 1000))),
      1000
    );
    return () => clearInterval(t);
  }, [streaming]);

  const session = sessions.find((s) => (s.id || s.sessionId) === active);
  const meta = active ? sessionMeta[active] : undefined;

  // dedupeLast: live and replayed frames can both describe the same turn —
  // drop a row identical to the one right before it. Consecutive-only, so a
  // legit repeated message ("READY" twice in a thread) still renders.
  const addRow = (r: Row, dedupeLast = false) => {
    r = { ...r, at: r.at ?? Date.now() };
    setRows((prev) => {
      const last = prev[prev.length - 1];
      if (dedupeLast && last && last.kind === r.kind && last.text === r.text) return prev;
      const next = [...prev];
      const lastMsg = [...next].reverse().find((x) => x.kind !== "sep" && x.at);
      if (r.at && (!lastMsg || r.at - (lastMsg.at || 0) > GAP_MS)) {
        next.push({ id: nid(), kind: "sep", text: sepLabel(r.at) });
      }
      next.push(r);
      return next.slice(-1600);
    });
  };

  const handleToolStart = (inner: Frame) => {
    // `wait` is coordination plumbing, not work — fold it into the open
    // delegation card instead of a checklist row or a "work" card.
    if (String(inner.toolName || "") === "wait") {
      setRows((prev) => {
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
    toolStarts.current.set(item.id, Date.now());
    toolFrames.current.set(item.id, inner);
    turnActions.current += 1;
    collectPr(inner);
    setRows((prev) => {
      // One action card per turn — the last check row after the user's
      // prompt is this turn's card whether it's still streaming or a
      // narration row settled it. Tools re-opening a closed card flip it
      // back to Working instead of stacking a second card.
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
      const row: Row = {
        id: nid(),
        kind: "check",
        streaming: true,
        items: [{ ...item, done: false }],
      };
      return [...prev, row].slice(-1600);
    });
  };

  const handleToolEnd = (inner: Frame) => {
    const cid = String(inner.toolCallId || "");
    // A `wait` result is when the spawned job actually settles — flip the open
    // delegation card from Running/Waiting to its real outcome.
    if (String(inner.toolName || "") === "wait") {
      setRows((prev) => {
        const idx = prev.map((r, i) => (r.kind === "sub" ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
        if (idx < 0) return prev;
        return prev.map((r, i) =>
          i === idx && r.kind === "sub"
            ? { ...r, sub: { ...(r.sub || { key: "", desc: "" }), status: inner.isError ? "Failed" : "Done" } }
            : r
        );
      });
      toolFrames.current.delete(cid);
      return;
    }
    const started = toolStarts.current.get(cid);
    toolStarts.current.delete(cid);
    const ms = resultMs(inner.result) ?? (started ? now() - started : undefined);
    setRows((prev) =>
      prev.map((r) =>
        r.kind === "check" && r.streaming
          ? {
              ...r,
              items: (r.items || []).map((i) =>
                i.id === cid
                  ? { ...i, done: true, failed: inner.isError === true, ms }
                  : i
              ),
            }
          : r
      )
    );
    // Deploy-ish results narrate themselves — "Build ID: …", "Status: …",
    // "Run: https://…" lines ride the turn as small gray mono rows.
    const lines = deployLines(inner.result);
    if (lines.length) addRow({ id: nid(), kind: "prog", text: lines.join("\n") });
    const cls = toolClass(
      String(toolFrames.current.get(cid)?.toolName || inner.toolName || "")
    );
    emitToolCard(inner, cid);
    if (cls === "subagent")
      // A `task` end is the *spawn* ack ("Spawned agent…"), not completion —
      // the job settles via `wait` or a lifecycle frame, so keep it Running.
      upsertSub({
        id: cid,
        status: inner.isError
          ? "Failed"
          : /^task$/i.test(String(inner.toolName || ""))
            ? "Running"
            : "Done",
      });
  };

  // The result card that makes a tool call undeniable: terminal output as a
  // dark card, file writes/edits as file chips, subagent spawns as
  // delegation cards — all sourced from the real args + result on the wire.
  // Read/search/computer classes stay checklist-only (shots and prose
  // already narrate them).
  const emitToolCard = (inner: Frame, cid: string) => {
    const start = toolFrames.current.get(cid);
    toolFrames.current.delete(cid);
    const name = String(start?.toolName || inner.toolName || "");
    const cls = toolClass(name);
    const failed = inner.isError === true;

    if (cls === "term") {
      const cmd = start ? commandOf(start) : "";
      if (!cmd) return;
      const out = resultText(inner.result).replace(/\s*\n?Wall time:.*/is, "");
      const capped = out.trim().length > 12000 ? `${out.slice(0, 12000)}\n…` : out;
      // text doubles as the dedupe key for a replayed tail re-emitting the
      // same card — RowView renders the card fields, never the key.
      addRow(
        {
          id: nid(),
          kind: "term",
          text: `term:${cid}`,
          term: { cmd, out: capped, ms: resultMs(inner.result), failed },
        },
        true
      );
      return;
    }

    if (cls === "file") {
      const raw = pathOf(start || inner) || String(inner.result?.details?.resolvedPath || "");
      if (!raw) return;
      const resolved = String(inner.result?.details?.resolvedPath || raw);
      const clean = resolved.replace(/\/+$/, "");
      const fname = clean.split("/").pop() || clean;
      const dir = clean.slice(0, clean.length - fname.length).replace(/\/$/, "");
      // Bytes: the args' content length, else parse "wrote N bytes".
      let bytes: number | undefined;
      const c = start?.args?.content;
      if (typeof c === "string" && c.length) bytes = utf8Len(c);
      if (bytes == null) {
        const m = resultText(inner.result).match(/wrote\s+([\d.]+)\s*(KB|B|bytes)/i);
        if (m) bytes = /kb/i.test(m[2]) ? parseFloat(m[1]) * 1024 : parseFloat(m[1]);
      }
      // Edit-style args carry old/new strings — a real +/- diff pill.
      let adds: number | undefined, dels: number | undefined;
      const olds = start?.args?.old_string ?? start?.args?.oldText;
      const news = start?.args?.new_string ?? start?.args?.newText;
      if (typeof olds === "string" || typeof news === "string") {
        dels = String(olds || "").split("\n").length;
        adds = String(news || "").split("\n").length;
      }
      addRow(
        {
          id: nid(),
          kind: "file",
          text: `file:${cid}`,
          file: { name: fname, dir: dir || undefined, bytes, adds, dels, failed },
        },
        true
      );
      return;
    }
  };

  // Delegation cards keyed by the subagent id (or the task toolCallId that
  // spawned it — lifecycle frames carry it as parentToolCallId): a fresh
  // frame upserts the same card instead of stacking duplicates.
  const upsertSub = (p: any) => {
    const key = String(p.parentToolCallId || p.id || p.toolCallId || "");
    if (!key) return;
    const hasDesc = Boolean(
      p.description ?? p.task ?? p.assignment ?? p.prompt
    );
    const desc = String(
      p.description ?? p.task ?? p.assignment ?? p.prompt ?? "Delegated task"
    ).slice(0, 180);
    const status = String(p.status || "Running");
    const agent = p.agent ? String(p.agent) : undefined;
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.kind === "sub" && r.sub?.key === key);
      if (idx >= 0)
        return prev.map((r, i) =>
          i === idx
            ? {
                ...r,
                sub: {
                  key,
                  // status-only frames (tool end, wait settle) must not wipe
                  // the description the spawn frame supplied.
                  desc: hasDesc ? desc : r.sub?.desc || desc,
                  status,
                  agent: agent ?? r.sub?.agent,
                },
              }
            : r
        );
      const next = [...prev];
      const lastMsg = [...next].reverse().find((x) => x.kind !== "sep" && x.at);
      const at = Date.now();
      if (!lastMsg || at - (lastMsg.at || 0) > GAP_MS)
        next.push({ id: nid(), kind: "sep", text: sepLabel(at) });
      next.push({ id: nid(), kind: "sub", at, sub: { key, desc, status, agent } });
      return next.slice(-1600);
    });
  };

  const closeChecklist = () => {
    setRows((prev) =>
      prev.map((r) => (r.kind === "check" && r.streaming ? { ...r, streaming: false } : r))
    );
  };

  // Close the open progress line with its real elapsed, then (when a new
  // sentence follows) open the next one — one row per phase, not a stream.
  const noteProg = (label: string) => {
    if (progLine.current?.label === label) return;
    const t = now();
    const prev = progLine.current;
    const rowId = nid();
    progLine.current = { id: rowId, label, start: t };
    setRows((rows) => {
      const next = prev
        ? rows.map((r) =>
            r.id === prev.id
              ? {
                  ...r,
                  text: `${prev.label.replace(/…+\s*$/, "").trim()} · ${fmtMs(t - prev.start)}`,
                  live: false,
                }
              : r
          )
        : [...rows];
      next.push({ id: rowId, kind: "prog", text: label, live: true, at: t });
      return next.slice(-1600);
    });
  };

  const stampProgLine = () => {
    const prev = progLine.current;
    if (!prev) return;
    progLine.current = null;
    const text = `${prev.label.replace(/…+\s*$/, "").trim()} · ${fmtMs(now() - prev.start)}`;
    setRows((rows) =>
      rows.map((r) => (r.id === prev.id ? { ...r, text, live: false } : r))
    );
  };

  const settle = (label?: string, isErr = false) => {
    setStreaming(false);
    streamBuf.current = "";
    flushStream(true);
    setWorkSec(0);
    workStart.current = 0;
    setComputerActive(false);
    closeChecklist();
    // Jobs auto-deliver without a `wait` call — when the agent idles, any
    // still-open delegation card settles with it.
    setRows((prev) =>
      prev.map((r) => {
        if (r.kind === "sub" && /running|waiting/i.test(r.sub?.status || ""))
          return { ...r, sub: { ...(r.sub || { key: "", desc: "" }), status: "Done" } };
        // A pending approval the turn ended without can never be answered —
        // show it resolved, not a live button on a dead request.
        if (r.kind === "approval" && r.approval?.state === "pending")
          return {
            ...r,
            approval: {
              ...r.approval,
              state: "done" as const,
              resolved: "secondary" as const,
              doneLabel: "Dismissed",
            },
          };
        return r;
      })
    );
    stampProgLine();
    // "Worked 16s" — the settle stamp from the code refs. Only a real,
    // measured live turn earns one: errors/stops and replays don't.
    if (!isErr && turnStartAt.current && turnActions.current > 0) {
      addRow({
        id: nid(),
        kind: "prog",
        text: `Worked ${fmtMs(now() - turnStartAt.current)}`,
      });
    }
    turnStartAt.current = 0;
    turnActions.current = 0;
    if (label)
      // Errors can arrive as multi-line payloads — the thread shows one
      // friendly line, never a raw dump.
      addRowOnce({
        id: nid(),
        kind: isErr ? "error" : "event",
        text: isErr ? friendlyError(label) : label.split("\n")[0].slice(0, 200),
      });
  };

  // A done action joins the turn's action card instead of opening a new
  // one — "Done · 3 actions", not three "Done · 1 action" cards. The card
  // can sit anywhere after the user's prompt (narration lands between
  // beats); the boundary is the last user row, not the last row period.
  const addCheckItem = (label: string) => {
    setRows((prev) => {
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
          i === cIdx
            ? { ...r, items: [...items, { id: nid(), label, done: true }] }
            : r
        );
      }
      const at = Date.now();
      const next = [...prev];
      const lastMsg = [...next].reverse().find((x) => x.kind !== "sep" && x.at);
      if (!lastMsg || at - (lastMsg.at || 0) > GAP_MS)
        next.push({ id: nid(), kind: "sep", text: sepLabel(at) });
      next.push({
        id: nid(),
        kind: "check",
        at,
        items: [{ id: nid(), label, done: true }],
      });
      return next.slice(-1600);
    });
  };

  function handleLive(inner: Frame) {
    const t = inner.type || "";
    if (t === "agent_start") {
      setStreaming(true);
      setStatus("On it…");
      if (!turnStartAt.current) turnStartAt.current = now();
      return;
    }
    if (t === "subagent_lifecycle" || t === "subagent_progress") {
      upsertSub(inner.payload || inner);
      return;
    }
    if (t === "extension_ui_request") {
      // Extension dialogs arrive as side-channel frames: confirm asks become
      // approval cards, a cancel resolves its card, richer dialogs (select,
      // input, editor, ask) get one honest line — never a fake UI.
      const method = String(inner.method || "");
      const reqId = String(inner.id || "");
      if (method === "cancel") {
        const target = String(inner.targetId || "");
        setRows((prev) =>
          prev.map((r) =>
            r.kind === "approval" && r.approval?.reqId === target && r.approval.state !== "done"
              ? { ...r, approval: { ...r.approval, state: "done" as const, resolved: "secondary" as const, doneLabel: "Dismissed" } }
              : r
          )
        );
      } else if (method === "confirm") {
        addRow({
          id: nid(),
          kind: "approval",
          approval: {
            reqId,
            title: String(inner.title || "Approve this action?"),
            preview: inner.message ? String(inner.message) : undefined,
            primary: "Approve",
            secondary: "Decline",
            state: "pending",
          },
        });
      } else if (method === "setWidget" || method === "setTitle" || method === "setStatus") {
        // Status widgets (auto-retry spinners, research HUD) aren't input
        // dialogs — retry UX already comes from auto_retry_start frames.
      } else if (method) {
        noteProg("The agent needs input on the laptop — this dialog isn't in the app yet");
      }
      return;
    }
    if (t === "tool_execution_start") {
      setStreaming(true);
      if (!turnStartAt.current) turnStartAt.current = now();
      if (/rig_computer/i.test(String(inner.toolName || ""))) setComputerActive(true);
      handleToolStart(inner);
      // The task tool IS the delegation card — subagent_lifecycle frames
      // update it later via parentToolCallId when subscribed that deep.
      if (toolClass(String(inner.toolName || "")) === "subagent") {
        const a = inner.args || {};
        // omp's task tool carries {context, tasks:[{name,agent,task}]} — the
        // readable label lives in the first task entry.
        const first = Array.isArray(a.tasks) ? a.tasks[0] : undefined;
        upsertSub({
          id: String(inner.toolCallId || nid()),
          description: first?.task ?? first?.name ?? a.prompt ?? a.task ?? a.description ?? a.assign,
          agent: first?.agent ?? a.agent ?? a.agentName,
          status: "Running",
        });
      }
    } else if (t === "tool_execution_end") {
      handleToolEnd(inner);
    } else if (t === "message_update") {
      const ev = inner.assistantMessageEvent;
      if (ev?.type === "text_delta") {
        const partial = typeof ev.partial === "string" ? ev.partial : null;
        streamBuf.current = partial ?? streamBuf.current + (ev.delta || "");
        flushStream();
      }
    } else if (t === "message_end") {
      const msg = inner.message || inner;
      if (msg?.role === "assistant") {
        const txt = messageText(msg).trim();
        const ok = scriptOkDetail(txt);
        // The text was already visible as the live tail — the committed row
        // swaps into the same slot, so it must not spring in again.
        const morphed = streamBuf.current.length > 0;
        if (ok) addCheckItem(ok);
        else if (txt) {
          turnActions.current += 1;
          const u = findPrUrl(txt);
          if (u) {
            prData.current.url = u;
            prData.current.at = now();
            patchPr();
          }
          addRow(
            { id: nid(), kind: "agent", text: txt, noEnter: morphed || undefined },
            true
          );
        }
        streamBuf.current = "";
        flushStream(true);
      } else if (msg?.role === "user") {
        const txt = messageText(msg).trim();
        const idx = pendingUser.current.indexOf(txt);
        if (idx >= 0) pendingUser.current.splice(idx, 1);
        else if (txt)
          addRow({ id: nid(), kind: "user", text: txt }, true);
      } else if (msg?.role === "toolResult") {
        const row =
          shotRow(messageText(msg).trim()) || deliverRow(messageText(msg).trim());
        if (row) {
          if (row.shot) {
            prData.current.shots.add(row.shot);
            patchPr();
          }
          addRow(row, true);
        }
      }
    } else if (t === "prompt_result") {
      const st = inner.status || "";
      if (st === "aborted") settle("Stopped");
      else if (st === "error")
        settle(inner.error?.message || "Something went wrong on the rig", true);
      else settle();
    } else if (t === "agent_end" || t === "session_settled") {
      settle();
    } else if (t === "auto_retry_start") {
      // Provider retry storm (quota/rate-limit) — without this the thread
      // sits on "On it…" forever with no signal.
      const n = inner.attempt;
      const why = String(
        inner.errorMessage ||
          inner.error?.message ||
          inner.message ||
          inner.reason ||
          ""
      )
        .split("\n")[0]
        .slice(0, 80);
      addRowOnce({
        id: nid(),
        kind: "event",
        text: `Retrying${n ? ` (attempt ${n})` : ""}${why ? ` — ${friendlyError(why)}` : ""}`,
      });
    } else if (t === "auto_retry_end") {
      if (!inner.success) {
        addRowOnce({
          id: nid(),
          kind: "error",
          text: friendlyError(inner.finalError || "gave up"),
        });
      }
    }
    const act = activityFor(inner);
    if (act) {
      setStatus(act.label);
      if (inner.type !== "agent_end" && inner.type !== "session_settled")
        noteProg(act.label);
    }
  }

  const rowKey = (r: Row) =>
    `${r.kind}:${r.text ?? r.shot ?? r.deliver?.name ?? r.file?.name ?? ""}`;

  // Fetch the page of transcript lines older than everything rendered —
  // daemon seqs are .jsonl line numbers, so `before` is the oldest seq seen.
  const loadOlder = () => {
    if (
      histInflight.current ||
      historyExhausted ||
      !active ||
      !rig.connected ||
      !(minSeqSeen.current > 1)
    )
      return;
    histInflight.current = true;
    setHistoryLoading(true);
    rig.trySend({
      type: "session.history",
      sessionId: active,
      before: minSeqSeen.current,
      limit: 160,
    });
  };

  // Replayed history must never duplicate rows already rendered live (a
  // re-subscribe after a turn replays the transcript it already has).
  const addRowOnce = (r: Row) => {
    r = { ...r, at: r.at ?? Date.now() };
    setRows((prev) => {
      // status-ish rows (event/error) dedupe on text alone — the same
      // failure surfaces as both a "Gave up" event and an error settle
      if (r.kind === "event" || r.kind === "error") {
        if (
          prev.some(
            (x) => (x.kind === "event" || x.kind === "error") && x.text === r.text
          )
        )
          return prev;
      } else if (r.kind === "shot") {
        if (prev.some((x) => x.kind === "shot" && x.shot === r.shot))
          return prev;
      } else if (prev.some((x) => x.kind === r.kind && x.text === r.text))
        return prev;
      const next = [...prev];
      const lastMsg = [...next].reverse().find((x) => x.kind !== "sep" && x.at);
      if (r.at && (!lastMsg || r.at - (lastMsg.at || 0) > GAP_MS)) {
        next.push({ id: nid(), kind: "sep", text: sepLabel(r.at) });
      }
      next.push(r);
      return next.slice(-1600);
    });
  };

  // `liveReplay` marks subscribe-replay frames (vs session.history pages —
  // those page OLD turns and must never touch the live streaming flag).
  function handleReplay(inner: Frame, liveReplay = false) {
    const t = inner.type || "";
    // A turn still in flight when the thread remounts replays its start
    // frames — latch streaming or the re-entered thread reads idle (no
    // WorkingRow, composer not in send-state) until the next live frame
    // lands. Settled turns self-correct: their prompt_result/agent_end
    // replays right after and calls settle().
    if (liveReplay && t === "agent_start") {
      setStreaming(true);
      setStatus("On it…");
      return;
    }
    if (liveReplay && t === "tool_execution_start") setStreaming(true);
    if (t === "message_end") {
      const msg = inner.message || inner;
      const txt = messageText(msg).trim();
      if (!txt) return;
      if (msg?.role === "user")
        addRowOnce({ id: nid(), kind: "user", text: txt });
      else if (msg?.role === "assistant") {
        const ok = scriptOkDetail(txt);
        if (ok) addCheckItem(ok);
        else {
          const u = findPrUrl(txt);
          if (u && u !== prData.current.url) {
            prData.current.url = u;
            prData.current.at = Date.now();
            patchPr();
          }
          addRowOnce({ id: nid(), kind: "agent", text: txt });
        }
      } else if (msg?.role === "toolResult") {
        const row = shotRow(txt) || deliverRow(txt);
        if (row) {
          if (row.shot) prData.current.shots.add(row.shot);
          addRowOnce(row);
        }
      }
    } else if (t === "tool_execution_start") {
      const item = checklistItem(inner);
      collectPr(inner);
      if (toolClass(String(inner.toolName || "")) === "subagent") {
        const a = inner.args || {};
        const first = Array.isArray(a.tasks) ? a.tasks[0] : undefined;
        upsertSub({
          id: String(inner.toolCallId || nid()),
          description: first?.task ?? first?.name ?? a.prompt ?? a.task ?? a.description ?? a.assign,
          agent: first?.agent ?? a.agent ?? a.agentName,
          status: "Done",
        });
      }
      // `wait` is coordination plumbing — no checklist row (matches live).
      if (item && String(inner.toolName || "") !== "wait") {
        // Replayed ends carry their own result.details.wallTimeMs — stash
        // the start frame so term/file cards rebuild identically to live.
        toolFrames.current.set(item.id, inner);
        setRows((prev) => {
          // merge into the turn's action card — the last check row after
          // the user's prompt — so a turn replays as one "Done · N
          // actions" card even with narration rows in between, not N cards
          let idx = -1;
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].kind === "user") break;
            if (prev[i].kind === "check") {
              idx = i;
              break;
            }
          }
          if (idx >= 0) {
            return prev.map((r, i) =>
              i === idx && r.kind === "check"
                ? {
                    ...r,
                    items: (r.items || []).some((x) => x.id === item.id)
                      ? r.items
                      : [...(r.items || []), { ...item, done: true }],
                  }
                : r
            );
          }
          return [
            ...prev,
            { id: nid(), kind: "check" as const, items: [{ ...item, done: true }] },
          ].slice(-1600);
        });
      }
    } else if (t === "tool_execution_end") {
      const cid = String(inner.toolCallId || "");
      const cls = toolClass(
        String(toolFrames.current.get(cid)?.toolName || inner.toolName || "")
      );
      emitToolCard(inner, cid);
      if (cls === "subagent")
        upsertSub({ id: cid, status: inner.isError ? "Failed" : "Done" });
    } else if (t === "subagent_lifecycle" || t === "subagent_progress") {
      upsertSub(inner.payload || inner);
    } else if (t === "extension_ui_request" && inner.method === "confirm") {
      // History shows what was asked, already settled.
      addRowOnce({
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
      // Terminal failure must survive replays too — otherwise a dead turn
      // replays as just the user's message and reads like it's still running.
      if (inner.status === "error") {
        addRowOnce({
          id: nid(),
          kind: "error",
          text: friendlyError(inner.error?.message || "Something went wrong on the rig"),
        });
      } else settle(inner.status === "aborted" ? "Stopped" : undefined);
    } else if (t === "agent_end" || t === "session_settled") {
      // A turn that settled while the socket was down replays these — without
      // them the resubscribed thread sits on "Working" forever.
      settle();
    } else if (t === "auto_retry_end") {
      // Keep the terminal failure visible across reloads — otherwise a dead
      // turn replays as just the user's message with no trace.
      if (!inner.success) {
        addRowOnce({
          id: nid(),
          kind: "error",
          text: friendlyError(inner.finalError || "gave up"),
        });
      }
    }
  }

  useEffect(() => {
    hookSessionStarted();
    const waiter = (sid: string) => {
      if (pendingActiveId !== sid) return;
      pendingActiveId = null;
      setActive(sid);
    };
    pendingActiveWaiters.add(waiter);
    if (pendingActiveId) {
      const sid = pendingActiveId;
      pendingActiveId = null;
      setActive(sid);
    }
    // A "+" expectation still armed seconds after the user landed on a real
    // thread is stale — the spawn either died or belongs to a flow they
    // abandoned. Clear it so a late session.started can't hijack this
    // thread's session, and so isExpectingNew stops blanking its rows.
    if (
      active &&
      !pendingActiveId &&
      !pendingPrompt &&
      expectActiveNext &&
      now() - expectActiveAt > 4000
    )
      expectActiveNext = false;
    // Replay arrives as a stream — resetting rows mid-stream wiped turns
    // (the list ended up showing only the tail of history). Buffer replayed
    // frames until session.subscribed, then rebuild once.
    const replayBuf = { current: [] as Frame[] | null };
    replayBuf.current = [];
    // Daemon truncates a replay burst when the client drains too slowly
    // ("replay truncated: client too slow — resubscribe to continue"). The
    // resubscribe resumes after the highest seq already received instead of
    // settling for a partial transcript — rows keep batching either way.
    let replayMaxSeq = 0;
    let replayRetries = 0;
    const resubscribe = () => {
      flush();
      if (replayRetries++ >= 5 || !rig.connected || !active) return;
      replayBuf.current = [];
      rig.subscribe(active, replayMaxSeq);
    };
    const flush = () => {
      const buf = replayBuf.current;
      if (!buf) return;
      replayBuf.current = null;
      // Per-frame isolation: one malformed frame must never abort the
      // rebuild — a throw mid-loop leaves the thread permanently blank.
      for (const inner of buf) {
        try {
          handleReplay(inner, true);
        } catch {}
      }
    };
    // session.subscribed is the happy-path flush gate, but it can be lost —
    // a truncated replay (client too slow), a dropped socket mid-replay — so
    // the buffer also flushes on a replay error or once the stream goes quiet.
    let quietT: ReturnType<typeof setTimeout> | null = null;
    const armQuiet = () => {
      if (quietT) clearTimeout(quietT);
      quietT = setTimeout(flush, 1200);
    };
    const off = rig.onFrame((f: Frame) => {
      if (f.type === "session.subscribed" && f.sessionId === active) {
        if (quietT) {
          clearTimeout(quietT);
          quietT = null;
        }
        flush();
        return;
      }
      if (f.type === "error" && f.sessionId === active) {
        if (/replay truncated/i.test(String(f.error || f.message || ""))) {
          resubscribe();
          return;
        }
        if (replayBuf.current?.length) {
          flush();
          return;
        }
      }
      if (f.type === "session.history" && f.sessionId === active) {
        // Page complete — rotate the rows it appended ahead of current rows,
        // deduped against what already rendered.
        const cut = histCut.current ?? rowsRef.current.length;
        histCut.current = null;
        histInflight.current = false;
        setHistoryLoading(false);
        setHistoryExhausted(!!f.exhausted);
        setRows((prev) => {
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
        return;
      }
      if (f.type !== "rpc" || f.sessionId !== active) return;
      const inner = (f.frame || {}) as Frame;
      if (typeof f.seq === "number") {
        if (f.seq < minSeqSeen.current) minSeqSeen.current = f.seq;
        if (f.seq > maxSeqSeen.current) maxSeqSeen.current = f.seq;
      }
      if (f.history) {
        if (histCut.current === null) histCut.current = rowsRef.current.length;
        try {
          handleReplay(inner);
        } catch {}
        return;
      }
      if (f.replay && typeof f.seq === "number" && f.seq > replayMaxSeq)
        replayMaxSeq = f.seq;
      if (f.replay && replayBuf.current) {
        replayBuf.current.push(inner);
        armQuiet();
      } else
        try {
          if (f.replay) handleReplay(inner, true);
          else handleLive(inner);
        } catch {}
    });
    // The socket dropped: wiping rows here leaves a permanently blank
    // thread when the daemon never comes back — no replay will arrive. Keep
    // the last-known transcript; if the rig is still down after a grace
    // beat, settle the dead turn into a sentence, not a stuck "Working…".
    let lostT: any;
    if (!connected)
      lostT = setTimeout(() => {
        // "reconnect" trips friendlyError's econn→provider mapping — word
        // it so the rig, not the provider, takes the blame.
        if (!rig.connected) settle("Lost the link to your rig — trying again in a moment", true);
      }, 1500);
    // A socket flap re-runs this effect — wiping rows there loses the
    // optimistic user row forever (transcript replay can lag the prompt, so
    // the wipe survives until remount). Same session → keep rows and resume
    // replay after the last seq seen; addRowOnce dedupes any overlap. A real
    // session switch still wipes and replays from 0.
    const sameSession = !!active && lastSubscribed.current === active;
    lastSubscribed.current = active ?? null;
    // Microtask: drains before any ws frame can arrive, so this reset still
    // lands ahead of the buffered replay flush on session.subscribed.
    Promise.resolve().then(() => {
      if (!connected) return;
      if (!sameSession) {
        setRows([]);
        setStreaming(false);
        setModel(null);
        toolStarts.current.clear();
        turnStartAt.current = 0;
        turnActions.current = 0;
        progLine.current = null;
        prData.current = { files: new Set(), shots: new Set() };
        minSeqSeen.current = Infinity;
        maxSeqSeen.current = 0;
        histCut.current = null;
        setHistoryExhausted(false);
      }
      // Either way: drop the stale stream tail (the next delta re-syncs) and
      // unstick a history page that died with the socket.
      streamBuf.current = "";
      flushStream(true);
      histInflight.current = false;
      setHistoryLoading(false);
    });
    let subRetryT: ReturnType<typeof setTimeout> | null = null;
    let subRetries = 0;
    const subscribeNow = () => {
      if (!active || !rig.connected || subRetries > 8) return;
      try {
        rig.subscribe(active, sameSession ? maxSeqSeen.current : 0);
      } catch {
        // rig.connected can read true while the swapped-in socket is still
        // CONNECTING (connect() clears the stale close handler first) — a
        // throwing send inside an effect has no boundary and a dropped
        // subscribe leaves the thread blank until the next reconnect.
        subRetries += 1;
        subRetryT = setTimeout(subscribeNow, 800);
      }
    };
    if (active && rig.connected) {
      subscribeNow();
      rig
        .request(active, { type: "get_state" }, 8000)
        .then((r) => {
          const m = r?.data?.model;
          const label = typeof m === "string" ? m : m?.id || m?.modelId;
          if (label) {
            setModel(String(label));
            patchMeta(active, { model: String(label) });
          }
        })
        .catch(() => {});
    }
    return () => {
      off();
      pendingActiveWaiters.delete(waiter);
      if (lostT) clearTimeout(lostT);
      if (quietT) clearTimeout(quietT);
      if (subRetryT) clearTimeout(subRetryT);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, connected]);

  useEffect(() => {
    const off = rig.onFrame((f: Frame) => {
      if (f.type !== "error") return;
      if (pendingPrompt) {
        pendingPrompt = null;
        settle(f.error || f.message || "Couldn't start a session", true);
        return;
      }
      // rpc/subscribe to a session the daemon forgot (restart, kill, exit)
      // — mark it dead so the next send starts a fresh one instead of
      // hanging on "On it…" forever.
      if (/no such session/i.test(String(f.error || f.message || ""))) {
        if (active) patchMeta(active, { dead: true });
        settle("Session ended — the rig restarted it", true);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const send = () => {
    const text = input.trim();
    if ((!text && !attachments.length) || streaming) return;
    if (!rig.connected) {
      // Offline sends used to throw inside rig.send — keep the typed text
      // and say why nothing went out.
      settle("Can't reach the rig — send again in a moment", true);
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    let message = text;
    const files = attachments.filter((a) => a.kind === "file");
    const images = attachments
      .filter((a) => a.kind === "image" && a.data)
      .map((a) => ({ type: "image", data: a.data!, mimeType: a.mimeType || "image/jpeg" }));
    if (files.length) {
      const bundled = files
        .map((f) => `[Attached: ${f.name}]\n${(f.text || "").slice(0, 40000)}`)
        .join("\n\n");
      message = `${message || "See attached."}\n\n${bundled}`;
    }
    const displayText = text || attachments.map((a) => `Attached ${a.name}`).join("\n");
    addRow({
      id: nid(),
      kind: "user",
      text: displayText,
      images: attachments.filter((a) => a.kind === "image" && a.uri).map((a) => a.uri!),
    });
    pendingUser.current.push(displayText);
    justSent.current = { raw: input, at: Date.now() };
    setInput("");
    setAttachments([]);
    setStreaming(true);
    setStatus("On it…");
    turnStartAt.current = Date.now();
    turnActions.current = 0;
    if (!active || meta?.dead) {
      // Dead binding (daemon restarted / session exited): start a fresh
      // session with the same prompt instead of firing into the void.
      hookSessionStarted();
      pendingPrompt = { message, images };
      pendingPromptAt = now();
      setStatus(active ? "Session ended — starting a new one…" : "Starting a session…");
      if (active) setActive(null);
      try {
        const f: Frame = { type: "session.new" };
        if (preferredModel) f.model = preferredModel;
        rig.send(f);
      } catch {
        pendingPrompt = null;
        settle("Couldn't reach the rig", true);
      }
      return;
    }
    rig.prompt(active, message, images);
  };

  // One action per "+" sheet row — the composer's AttachSheet owns the UI.
  const pickPhoto = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({
      base64: true,
      quality: 0.8,
      allowsMultipleSelection: true,
      selectionLimit: 4,
    });
    if (r.canceled) return;
    setAttachments((prev) => [
      ...prev,
      ...r.assets.map((a, i) => ({
        kind: "image" as const,
        uri: a.uri,
        name: a.fileName || `photo-${i + 1}.jpg`,
        mimeType: a.mimeType || "image/jpeg",
        data: a.base64 || undefined,
      })),
    ]);
  };

  const pickCamera = async () => {
    if (Platform.OS === "web") return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const r = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.8 });
    if (r.canceled) return;
    const a = r.assets[0];
    setAttachments((prev) => [
      ...prev,
      {
        kind: "image" as const,
        uri: a.uri,
        name: a.fileName || "photo.jpg",
        mimeType: a.mimeType || "image/jpeg",
        data: a.base64 || undefined,
      },
    ]);
  };

  const pickFile = async () => {
    const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (r.canceled) return;
    const a = r.assets[0];
    let text = "";
    try {
      const f = new File(a.uri);
      if ((a.size || 0) < 200_000) text = await f.text();
    } catch {}
    setAttachments((prev) => [
      ...prev,
      { kind: "file" as const, name: a.name || "file", mimeType: a.mimeType, text },
    ]);
  };

  const openModels = () => {
    if (!active) return;
    setModelSheet(true);
    Promise.all([
      rig.request(active, { type: "get_available_models" }, 10000),
      rig.request(active, { type: "get_login_providers" }, 10000).catch(() => null),
    ])
      .then(([r, lp]) => {
        const all = r?.data?.models || [];
        // Only offer models the host can actually run — omp's catalog lists
        // every bundled provider (bedrock, vertex, …) whether or not the
        // laptop has credentials; picking one 404s the turn. Credentialed =
        // OAuth-authenticated login providers UNION the apiKey providers the
        // daemon saw in models.yml (rig.status.providers).
        const authed: string[] = (lp?.data?.providers || [])
          .filter((p: any) => p.authenticated)
          .map((p: any) => p.id);
        const configured: string[] = Array.isArray(hostInfo?.providers)
          ? hostInfo.providers
          : [];
        const ok = new Set([...authed, ...configured]);
        setModels(
          ok.size ? all.filter((m: any) => ok.has(m.provider || m.providerId)) : all,
        );
      })
      .catch(() => setModels([]));
  };

  const pickModel = (m: any) => {
    const provider = m.provider || m.providerId || "";
    const modelId = m.modelId || m.id || "";
    rig.rpc(active!, { type: "set_model", provider, modelId });
    preferredModel = provider ? `${provider}/${modelId}` : modelId || null;
    if (preferredModel)
      AsyncStorage.setItem("preferredModel", preferredModel).catch(() => {});
    const label = m.name || modelId;
    setModel(label);
    if (active) patchMeta(active, { model: label });
    setModelSheet(false);
  };

  const stop = () => {
    if (active) rig.rpc(active, { type: "abort" });
    else rig.abortAll();
  };

  // Reasoning effort — persisted like the model pick; applies live through
  // set_thinking_level and to the next session.new via `thinking`.
  const [effort, setEffortState] = useState("low");
  useEffect(() => {
    AsyncStorage.getItem("preferredEffort")
      .then((v) => {
        if (v) {
          preferredEffort = v;
          setEffortState(v);
        }
      })
      .catch(() => {});
  }, []);
  const setEffort = (level: string) => {
    setEffortState(level);
    preferredEffort = level;
    AsyncStorage.setItem("preferredEffort", level).catch(() => {});
    if (active && rig.connected)
      rig.rpc(active, { type: "set_thinking_level", level });
  };

  const respondApproval = (reqId: string, confirmed: boolean) => {
    if (!reqId) return;
    if (active && rig.connected)
      rig.rpc(active, { type: "extension_ui_response", id: reqId, confirmed });
    setRows((prev) =>
      prev.map((r) =>
        r.kind === "approval" && r.approval?.reqId === reqId
          ? {
              ...r,
              approval: {
                ...r.approval,
                state: "done" as const,
                resolved: confirmed ? ("primary" as const) : ("secondary" as const),
              },
            }
          : r
      )
    );
  };

  return {
    rows,
    input,
    setInput,
    onInput,
    // Hook-local streaming latches off live/replayed turn frames; a thread
    // re-entered mid-turn may replay a ring tail that starts *after* the
    // agent_start, so also trust the daemon's busy flag (reconciled into
    // meta.streaming by sessions.list + session.busy broadcasts). Dead
    // sessions never read as working.
    streaming: streaming || (!!meta?.streaming && !meta?.dead),
    status,
    streamText,
    workSec,
    computerActive,
    attachments,
    setAttachments,
    modelSheet,
    setModelSheet,
    models,
    model,
    session,
    meta,
    active,
    connected,
    send,
    stop,
    loadOlder,
    historyLoading,
    historyExhausted,
    respondApproval,
    pickPhoto,
    pickCamera,
    pickFile,
    openModels,
    pickModel,
    effort,
    setEffort,
  };
}
