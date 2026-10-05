// Sheet bus — one slot, sheets never stack. Leaf module (no component
// imports) so bubbles/markdown/cards can summon sheets without cycles.
// Sheets never stack and never auto-open: every entry point is a tap.
import { useSyncExternalStore } from "react";
import { rig } from "../rig";

export interface MergeTarget {
  url: string;
  title?: string;
  branch?: string;
  author?: string;
}

export type SheetState =
  | { kind: "browser"; url: string }
  | ({ kind: "merge" } & MergeTarget)
  | { kind: "session"; sessionId: string; title: string }
  | { kind: "changes"; sessionId: string; title: string }
  | { kind: "routines" }
  | { kind: "spawn"; parentId: string };

let current: SheetState | null = null;
const sheetSubs = new Set<() => void>();
function emitSheet() {
  sheetSubs.forEach((f) => f());
}
export function subscribeSheet(f: () => void) {
  sheetSubs.add(f);
  return () => {
    sheetSubs.delete(f);
  };
}
export const sheetSnap = () => current;
export function setSheet(s: SheetState | null) {
  current = s;
  emitSheet();
}

export function openBrowserSheet(url: string) {
  setSheet({ kind: "browser", url });
}
export function openMergeSheet(pr: MergeTarget) {
  setSheet({ kind: "merge", ...pr });
}
/** Long-press a session row → action sheet (changes / delete). */
export function openSessionSheet(sessionId: string, title: string) {
  setSheet({ kind: "session", sessionId, title });
}
export function openChangesSheet(sessionId: string, title: string) {
  setSheet({ kind: "changes", sessionId, title });
}
export function openRoutinesSheet() {
  setSheet({ kind: "routines" });
}
/** The "+" in a thread's SUB-AGENTS head → proper spawn surface. */
export function openSpawnSheet(parentId: string) {
  setSheet({ kind: "spawn", parentId });
}
/** Every tap-through-to-web lands here — tap only, never auto-open. */
export function openLink(url: string) {
  openBrowserSheet(url);
}
export function closeSheet() {
  setSheet(null);
}

// Merge lifecycle per PR url — the PRCard re-reads it and morphs its status
// row ("Ready to merge" → "Merging" shimmer → "Merged").
export type MergePhase = "idle" | "merging" | "merged";
const mergePhases = new Map<string, MergePhase>();
const mergeSubs = new Set<() => void>();
function emitMerge() {
  mergeSubs.forEach((f) => f());
}
function subscribeMerge(f: () => void) {
  mergeSubs.add(f);
  return () => {
    mergeSubs.delete(f);
  };
}
function mergePhaseOf(url: string): MergePhase {
  return mergePhases.get(url) || "idle";
}
export function setMergePhase(url: string, p: MergePhase) {
  mergePhases.set(url, p);
  emitMerge();
}
export function useMergePhase(url?: string): MergePhase {
  return useSyncExternalStore(subscribeMerge, () => mergePhaseOf(url || ""), () => "idle");
}

// ---------------------------------------------------------------------------
// rig.git.* calls — `rig.git.result` replies echo the request `id` but aren't
// routed through rig.ts' fsWaiters, so we demux them here on our own onFrame
// hook (installed once, lazily). Sheets/cards await the matching id only.
// ---------------------------------------------------------------------------
let gitSeq = 0;
const gitWaiters = new Map<
  string,
  { resolve: (f: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
let gitHooked = false;
function ensureGitHook() {
  if (gitHooked) return;
  gitHooked = true;
  rig.onFrame((f: any) => {
    if (f?.type === "error" && /scope|lacks/i.test(String(f.error || ""))) {
      // A scope-denied op replies {type:"error"} with no id — a denied token
      // denies everything pending, so fail the whole queue fast.
      for (const [id, w] of [...gitWaiters]) {
        gitWaiters.delete(id);
        clearTimeout(w.timer);
        w.reject(new Error(String(f.error)));
      }
      return;
    }
    if ((f?.type !== "rig.git.result" && f?.type !== "rig.checkpoint.result") || typeof f.id !== "string") return;
    const w = gitWaiters.get(f.id);
    if (w) {
      gitWaiters.delete(f.id);
      clearTimeout(w.timer);
      w.resolve(f);
    }
  });
}
type GitOp = "rig.git.status" | "rig.git.diff";
type CpOp = "rig.checkpoint.create" | "rig.checkpoint.list" | "rig.checkpoint.restore";
/** `rig.git.*` / `rig.checkpoint.*` — resolves the daemon's id-correlated result. */
export function gitCall(op: GitOp | CpOp, args: { [k: string]: unknown }, ms = 12000): Promise<any> {
  ensureGitHook();
  const id = `git${++gitSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      gitWaiters.delete(id);
      reject(new Error(`timeout waiting ${op}`));
    }, ms);
    gitWaiters.set(id, { resolve, reject, timer });
    try {
      rig.send({ type: op, id, ...args });
    } catch (e) {
      gitWaiters.delete(id);
      clearTimeout(timer);
      reject(e as Error);
    }
  });
}

// ---------------------------------------------------------------------------
// rigCall — FIFO-correlated calls for wire ops whose replies carry no `id`
// (rig.schedule.* answer rig.schedule.list/added or a generic {type:"ok",
// for:"<op>"}, and scope denials answer {type:"error"}). Requests+replies are
// ordered on the one socket, so the first pending waiter owns the next reply
// frame. Broadcasts (schedule.fired, session.*) never match the reply set.
// ---------------------------------------------------------------------------
interface RigWaiter {
  op: string;
  replyTypes: string[];
  resolve: (f: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const rigQueue: RigWaiter[] = [];
let rigHooked = false;
function ensureRigHook() {
  if (rigHooked) return;
  rigHooked = true;
  rig.onFrame((f: any) => {
    const head = rigQueue[0];
    if (!head) return;
    const isReply =
      (f?.type && head.replyTypes.includes(f.type)) ||
      (f?.type === "ok" && f.for === head.op) ||
      f?.type === "error";
    if (!isReply) return;
    rigQueue.shift();
    clearTimeout(head.timer);
    if (f.type === "error") head.reject(new Error(String(f.error || `${head.op} failed`)));
    else head.resolve(f);
  });
}
/** Fire-and-reply for ops without id-correlated replies (rig.schedule.*). */
export function rigCall(
  op: string,
  args: { [k: string]: unknown },
  replyTypes: string[],
  ms = 12000
): Promise<any> {
  ensureRigHook();
  let waiter!: RigWaiter;
  const p = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = rigQueue.indexOf(waiter);
      if (i >= 0) rigQueue.splice(i, 1);
      reject(new Error(`timeout waiting ${op}`));
    }, ms);
    waiter = { op, replyTypes, resolve, reject, timer };
    rigQueue.push(waiter);
    try {
      rig.send({ type: op, ...args });
    } catch (e) {
      const i = rigQueue.indexOf(waiter);
      if (i >= 0) rigQueue.splice(i, 1);
      clearTimeout(timer);
      reject(e as Error);
    }
  });
  return p;
}
