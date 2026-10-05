import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { router } from "expo-router";
// expo-notifications' JS entry eagerly requires the ExpoPushTokenManager
// native module — a dev client built before the package was added has no
// such module and the bare import crashes the whole app at boot. Resolve it
// lazily and degrade to no-ops so every other surface keeps working.
const Notifications: typeof import("expo-notifications") | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-notifications");
  } catch {
    return null;
  }
})();
/* eslint-disable import/first */
import { rig, Frame } from "./rig";
import { pokeMascots } from "./components/mascot";

// Turn-finished alerts — a banner in-app, a system notification when the
// phone is doing something else. Sound stays off; the dot carries the
// in-app signal.
Notifications?.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// PR evidence harvested from the live transcript while the thread is open —
// the url the agent announced, files it touched (mutating tool args), and
// archived observe frames. Absent keys mean "not on the wire", not zero.
export interface SessionPr {
  url?: string;
  at?: number;
  files?: string[];
  shots?: string[];
  checks?: { label: string; state: "waiting" | "passed" | "failed" }[];
}

export interface SessionMeta {
  preview?: string;
  dead?: boolean;
  previewAt?: number;
  streaming?: boolean;
  stalled?: boolean;
  done?: boolean;
  model?: string;
  pr?: SessionPr;
  hibernated?: boolean;
}

export type Mode = "cowork" | "code";

interface RigState {
  connected: boolean;
  authed: boolean;
  /** No longer a user-picked split — the inbox merges both kinds of bot.
   * Kept as the open thread's chrome hint: call sites setMode() from the
   * session's context (cwd → "code", none → "cowork") when it opens, so
   * thread.tsx rows/slash-set adapt per session. */
  mode: Mode;
  setMode: (m: Mode) => void;
  sessions: any[];
  active: string | null;
  setActive: (id: string | null) => void;
  lastSeqs: Record<string, number>;
  bumpSeq: (id: string, seq: number) => void;
  refreshSessions: () => void;
  hostInfo: any;
  /** rig.vitals reply — battery/uptime/load/disk/mem/net, fields null when
   * the host OS can't answer. Null until the first successful probe. */
  vitals: any;
  probeInfo: any;
  setProbeInfo: (i: any) => void;
  sessionMeta: Record<string, SessionMeta>;
  patchMeta: (id: string, m: Partial<SessionMeta>) => void;
  drawerOpen: boolean;
  setDrawerOpen: (v: boolean) => void;
  /** Unified new-bot sheet — the one "+" surface (computer context by
   * default, optional folder pick). Rendered by RemoteDrawer so it opens
   * over any route. */
  newSheet: boolean;
  setNewSheet: (v: boolean) => void;
  /** Live-screen bottom sheet — shot cards and the header monitor open it;
   * only renders the mirror while actually open. */
  screenSheet: boolean;
  setScreenSheet: (v: boolean) => void;
  disconnect: () => Promise<void>;
  resume: () => void;
  // Provider auth — the vault lives on the host; the phone brokers login.
  authProviders: any[];
  authEvents: any[];
  authLive: string | null;
  authSheet: boolean;
  setAuthSheet: (v: boolean) => void;
  authStart: (provider: string) => void;
}

const Ctx = createContext<RigState>(null as any);
export const useRig = () => useContext(Ctx);

// Inbox order: pinned threads hold the top, then newest activity first.
const sortSessions = (list: any[]) =>
  [...list].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const ta = Math.max(a.lastAt || 0, a.previewAt || 0, a.createdAt || 0);
    const tb = Math.max(b.lastAt || 0, b.previewAt || 0, b.createdAt || 0);
    return tb - ta;
  });

// Pull display text out of an agent message frame's payload.
export function messageText(message: any): string {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b: any) => (b && b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function RigProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [lastSeqs, setLastSeqs] = useState<Record<string, number>>({});
  const [hostInfo, setHostInfo] = useState<any>(null);
  const [vitals, setVitals] = useState<any>(null);
  const [probeInfo, setProbeInfo] = useState<any>(null);
  const [sessionMeta, setSessionMeta] = useState<Record<string, SessionMeta>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newSheet, setNewSheet] = useState(false);
  const [screenSheet, setScreenSheet] = useState(false);
  const [mode, setMode] = useState<Mode>("cowork");
  const [authProviders, setAuthProviders] = useState<any[]>([]);
  const [authEvents, setAuthEvents] = useState<any[]>([]);
  const [authLive, setAuthLive] = useState<string | null>(null);
  const [authSheet, setAuthSheet] = useState(false);
  const metaRef = useRef(sessionMeta);
  useEffect(() => {
    metaRef.current = sessionMeta;
  }, [sessionMeta]);
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // ---- per-frame coalescing --------------------------------------------------
  // This provider's single context value means every setState re-renders all
  // consumers; a live stream emits tens of frames a second and a replay
  // thousands back-to-back. lastSeqs and patchMeta both fed that loop
  // per-frame — they now merge into pending refs and publish on a slow
  // cadence. Consumers (read receipts, badges, previews) are debounced or
  // purely visual, so a ≤200ms lag is invisible.
  const seqsPending = useRef<Record<string, number>>({});
  const seqsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSeqs = () => {
    seqsTimer.current = null;
    const pend = seqsPending.current;
    seqsPending.current = {};
    if (!Object.keys(pend).length) return;
    setLastSeqs((p) => {
      let next: Record<string, number> | null = null;
      for (const id in pend)
        if ((p[id] || 0) < pend[id]) (next ||= { ...p })[id] = pend[id];
      return next || p;
    });
  };
  const queueSeq = (id: string, seq: number) => {
    if ((seqsPending.current[id] || 0) < seq) seqsPending.current[id] = seq;
    if (!seqsTimer.current) seqsTimer.current = setTimeout(flushSeqs, 200);
  };

  const metaPending = useRef<Record<string, SessionMeta>>({});
  const metaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushMeta = () => {
    metaTimer.current = null;
    const pend = metaPending.current;
    metaPending.current = {};
    if (!Object.keys(pend).length) return;
    setSessionMeta((p) => {
      const next = { ...p };
      for (const id in pend) {
        const m = pend[id];
        next[id] = {
          ...next[id],
          ...m,
          // same one-level `pr` merge the immediate path did — two writers
          // (transcript harvest + checks poller) must not erase each other
          ...(m.pr ? { pr: { ...(next[id]?.pr || {}), ...m.pr } } : {}),
        };
      }
      return next;
    });
  };
  const patchMeta = (id: string, m: Partial<SessionMeta>) => {
    const p = metaPending.current[id];
    metaPending.current[id] = p
      ? {
          ...p,
          ...m,
          ...(p.pr || m.pr ? { pr: { ...(p.pr || {}), ...(m.pr || {}) } } : {}),
        }
      : { ...m };
    if (!metaTimer.current) metaTimer.current = setTimeout(flushMeta, 120);
  };
  useEffect(
    () => () => {
      if (seqsTimer.current) clearTimeout(seqsTimer.current);
      if (metaTimer.current) clearTimeout(metaTimer.current);
    },
    []
  );
  const notifAsked = useRef(false);
  useEffect(() => {
    if (!authed || notifAsked.current) return;
    notifAsked.current = true;
    Notifications?.requestPermissionsAsync().catch(() => {});
    if (Platform.OS === "android") {
      // API 26+ drops every notification without a channel — the settle
      // banner in session.busy would never surface.
      Notifications?.setNotificationChannelAsync("turns", {
        name: "Turn updates",
        importance: Notifications.AndroidImportance.DEFAULT,
      }).catch(() => {});
    }
  }, [authed]);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  // Sessions that already own a virtual desktop — don't re-claim on
  // reconnects/restarts, the daemon remembers across the socket drop.
  const spaceClaimed = useRef(new Set<string>());

  // A dropped socket used to kill the app until re-pair — reconnect with
  // backoff instead. useChat's [active, connected] effect re-subscribes on
  // the next _open, and replay dedupe keeps already-rendered rows single.
  const manualClose = useRef(false);
  const reconnecting = useRef(false);

  // Deliberate connects (pair screen, mount auto-connect) re-arm the loop
  // that disconnect() disarmed.
  const resume = () => {
    manualClose.current = false;
  };

  // Persist the open thread so a reload (web F5, native restart) lands back
  // in it instead of an empty composer.
  const setActivePersist = (id: string | null) => {
    setActive(id);
    if (id) patchMeta(id, { done: false });
    if (id) AsyncStorage.setItem("rigActive", id).catch(() => {});
    else AsyncStorage.removeItem("rigActive").catch(() => {});
  };

  const refreshSessions = () => {
    if (!rig.connected) return;
    try {
      rig.send({ type: "sessions.list" });
      rig.send({ type: "rig.status" });
      rig.authList();
      rig
        .vitals()
        .then((v) => {
          if (v.ok) setVitals(v);
        })
        .catch(() => {});
    } catch {}
  };

  // Vitals decay slower than the session list — keep them fresh on a slow
  // cadence while the socket is up so the drawer strip tracks the real box.
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => {
      rig
        .vitals()
        .then((v) => {
          if (v.ok) setVitals(v);
        })
        .catch(() => {});
    }, 45000);
    return () => clearInterval(t);
  }, [connected]);

  const authStart = (provider: string) => {
    try {
      rig.authLogin(provider);
    } catch {}
  };

  const disconnect = async () => {
    manualClose.current = true;
    try {
      await AsyncStorage.removeItem(`rigToken:${rig.host}`);
    } catch {}
    rig.token = null;
    rig.authed = false;
    rig.close();
    setActivePersist(null);
    setSessions([]);
    metaPending.current = {};
    seqsPending.current = {};
    setSessionMeta({});
    setLastSeqs({});
    setDrawerOpen(false);
  };

  // One reconnect loop shared by _closed and by a failed first connect —
  // a daemon restart used to strand the app on "Not connected" forever
  // because the loop only armed on a socket that had already opened.
  const startReconnect = () => {
    if (reconnecting.current || manualClose.current) return;
    reconnecting.current = true;
    let delay = 800;
    (async () => {
      while (!rig.connected && !manualClose.current) {
        await new Promise((r) => setTimeout(r, delay));
        if (rig.connected || manualClose.current) break;
        const h = await AsyncStorage.getItem("rigHost");
        const p =
          parseInt((await AsyncStorage.getItem("rigPort")) || "8790", 10) || 8790;
        if (!h) break;
        try {
          await rig.connect(h, p);
          rig.authed = true;
          setAuthed(true);
          refreshSessions();
        } catch {
          delay = Math.min(delay * 2, 8000);
        }
      }
      reconnecting.current = false;
    })();
  };

  // Auto-connect wherever the app mounts (deep links on web skip the pair
  // screen) — pairing itself stays on the index route. A refused first
  // attempt arms the same loop a dropped socket uses.
  useEffect(() => {
    (async () => {
      const h = await AsyncStorage.getItem("rigHost");
      const p = parseInt((await AsyncStorage.getItem("rigPort")) || "8790", 10) || 8790;
      if (!h) return;
      await rig.loadToken(h);
      if (!rig.token) return;
      if (rig.connected) {
        // Remount with a live socket (fast refresh / provider re-mount) —
        // no _open frame will fire again, so rehydrate from the socket as
        // it stands instead of stranding the inbox empty.
        setConnected(true);
        setAuthed(true);
        refreshSessions();
        return;
      }
      resume();
      try {
        await rig.connect(h, p);
        rig.authed = true;
      } catch {
        startReconnect();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const off = rig.onFrame((f: Frame) => {
      if (f.type === "_open") {
        setConnected(true);
        setAuthed(rig.authed);
        refreshSessions();
      }
      if (f.type === "paired") setAuthed(true);
      if (f.type === "_closed") {
        setConnected(false);
        setAuthed(false);
        setHostInfo(null);
        startReconnect();
      }
      if (f.type === "sessions.list") {
        const list = sortSessions(f.sessions || []);
        setSessions(list);
        // The daemon's list is authoritative — a bound session that isn't
        // in it died (restart, kill, exit); mark it so sends start fresh.
        // Its `busy` flag also reconciles the streaming pill after a
        // reconnect (a turn that settled while we were away stuck "Working…").
        const aid = activeRef.current;
        for (const s of list) {
          const sid = (s.id || s.sessionId) as string;
          const cur = metaRef.current[sid]?.streaming ?? false;
          if (sid && cur !== !!s.busy) patchMeta(sid, { streaming: !!s.busy });
        }
        if (aid && !list.some((s: any) => (s.id || s.sessionId) === aid))
          patchMeta(aid, { dead: true });
        // Restore the open thread after a reload — only when nothing is
        // active and the saved id is still a live session.
        if (!activeRef.current) {
          (async () => {
            const saved = await AsyncStorage.getItem("rigActive");
            if (saved && list.some((s: any) => (s.id || s.sessionId) === saved))
              setActive(saved);
          })();
        }
      }
      if (f.type === "error" && f.error === "unauthorized" && rig.token) {
        // Daemon rejected the stored device token (devices.json lost it —
        // reset, lock, test clobber). Without this the app sits "connected"
        // on a dead socket forever showing empty everything. Wipe and land
        // back on the pair screen; fresh pairs get a grace window so a stray
        // unauthorized on the old socket can't eat the new token.
        if (Date.now() - rig.tokenSetAt > 5000) {
          const host = rig.host;
          rig.token = null;
          rig.authed = false;
          manualClose.current = true;
          setAuthed(false);
          setConnected(false);
          AsyncStorage.removeItem(`rigToken:${host}`).catch(() => {});
          rig.close();
          try {
            router.replace("/");
          } catch {}
        }
      }
      if (f.type === "rig.status") setHostInfo(f);
      if (f.type === "auth.list") setAuthProviders(f.providers || []);
      if (f.type === "auth.started") {
        setAuthLive(f.provider as string);
        setAuthEvents([]);
      }
      if (f.type === "auth.event") {
        if (f.kind === "done") {
          setAuthLive(null);
          setAuthEvents((p) => [...p.slice(-40), f]);
        } else {
          setAuthEvents((p) => [...p.slice(-40), f]);
        }
      }
      if (f.type === "auth.changed") {
        try {
          rig.authList();
        } catch {}
      }
      if (f.type === "session.busy") {
        // Turn started/settled on ANY client — keep the inbox "Working…"
        // in sync without a sessions.list round trip. rpc settle frames are
        // subscriber-only, so this global broadcast is where the done dot
        // lands for sessions you aren't watching.
        const sid = f.sessionId as string;
        if (sid)
          patchMeta(sid, f.busy ? { streaming: true, done: false, hibernated: false }
                                : { streaming: false, done: activeRef.current !== sid });
        if (!f.busy && sid && activeRef.current !== sid) {
          const sess = sessionsRef.current.find((x: any) => (x.id || x.sessionId) === sid);
          const nm =
            String(sess?.title || "").trim() ||
            String(sess?.cwd || "").replace(/\/+$/, "").split("/").pop() ||
            "Agent";
          Notifications?.scheduleNotificationAsync({
            content: { title: `${nm} finished`, body: "Tap to read the reply." },
            trigger: null,
          }).catch(() => {});
        }
        refreshSessions();
      }
      if (f.type === "session.stalled") {
        // Daemon watchdog: busy + no emitted frame for 90s = wedged
        // provider stream. Advisory only — the turn itself is untouched.
        const sid = f.sessionId as string;
        if (sid) patchMeta(sid, { stalled: true });
      }
      if (f.type === "session.hibernated") {
        // Idle >15min — daemon retired the agent process to save RAM. The
        // session is asleep, not dead: next prompt lazily respawns it.
        const sid = f.sessionId as string;
        if (sid) patchMeta(sid, { hibernated: true, streaming: false });
      }
      if (f.type === "session.started") {
        // resumed sessions wake back up here — clears the sleeping badge
        const sid0 = (f.sessionId || f.id || (f.session && (f.session as any).id)) as string;
        if (sid0) patchMeta(sid0, { hibernated: false });
        refreshSessions();
        // Computer-context sessions get their own virtual desktop so
        // parallel bots never see each other's windows. Claim once per
        // session. `mode` tracks the last opened/created session's
        // context — creation call sites set it before session.new, so
        // cowork-context starts ("cowork") still claim here.
        const sid = (f.sessionId || f.id || (f.session && (f.session as any).id)) as string;
        if (modeRef.current === "cowork" && sid && !spaceClaimed.current.has(sid)) {
          spaceClaimed.current.add(sid);
          try {
            rig.send({ type: "computer.space", action: "new", sessionId: sid });
          } catch {}
        }
      }
      if (f.type === "session.exited") {
        const sid = (f.sessionId || f.id) as string;
        if (sid) patchMeta(sid, { dead: true });
        refreshSessions();
      }
      if (f.type === "session.deleted") {
        const sid = (f.sessionId || f.id) as string;
        if (sid) {
          patchMeta(sid, { dead: true });
          setSessions((p) => p.filter((s: any) => s.id !== sid));
        }
      }
      if (f.type === "session.meta") {
        // pin/hide/read bookkeeping — arrives as the caller's reply and as
        // a broadcast on every other device, so both stay in sync.
        const sid = f.sessionId as string;
        if (sid)
          setSessions((p) =>
            sortSessions(
              p.map((s: any) =>
                (s.id || s.sessionId) === sid
                  ? {
                      ...s,
                      pinned: !!f.pinned,
                      hidden: !!f.hidden,
                      lastReadSeq: f.lastReadSeq ?? s.lastReadSeq,
                    }
                  : s
              )
            )
          );
      }
      if (f.type === "session.renamed") {
        // Persona wire — user title wins over buddyName/sessionTitle.
        const sid = f.sessionId as string;
        const title = typeof f.title === "string" ? f.title : "";
        if (sid && title)
          setSessions((p) =>
            p.map((s: any) => (s.id === sid ? { ...s, title } : s))
          );
      }
      if (f.type === "schedule.fired") {
        // Routine-spawned sessions only broadcast schedule.fired
        // (session.started is starter-only) — refresh so the run lands
        // in the inbox like any session.
        refreshSessions();
      }
      if (f.type === "session.spawned") {
        // A child session was spawned (this client or another) — the new
        // row lands via sessions.list like any other session.
        refreshSessions();
      }
      if (f.type === "rpc" && typeof f.seq === "number") {
        const sid = f.sessionId as string;
        if (sid) {
          queueSeq(sid, f.seq);
          const inner = (f.frame || {}) as Frame;
          const t = inner.type;
          // A real frame means the stream is alive — clear the stall note.
          if (!f.replay && metaRef.current[sid]?.stalled)
            patchMeta(sid, { stalled: false });
          // Eyes in the roster glance at real work, not heartbeats.
          if (
            t === "tool_execution_start" ||
            t === "tool_execution_end" ||
            t === "message_end" ||
            (t === "message_update" && inner.assistantMessageEvent?.type === "text_delta")
          )
            pokeMascots();
          // Only live frames move the Working pill — a replayed turn that
          // died mid-flight (no settle ever landed) would stick it forever.
          if (!f.replay) {
            if (t === "agent_start" || t === "tool_execution_start") {
              if (!metaRef.current[sid]?.streaming) patchMeta(sid, { streaming: true, done: false });
            } else if (
              t === "prompt_result" ||
              t === "session_settled" ||
              t === "auto_retry_end" // a dead turn emits neither result nor settle
            ) {
              if (metaRef.current[sid]?.streaming)
                patchMeta(sid, { streaming: false, done: activeRef.current !== sid });
            }
          }
          // Live preview for the sessions list — only the agent's own words.
          if ((t === "message_end" || t === "message_start") && inner.message?.role === "assistant") {
            const txt = messageText(inner.message);
            if (txt.trim()) patchMeta(sid, { preview: txt.trim(), previewAt: Date.now() });
          }
        }
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read receipts: while a thread is on screen its newest frames count as
  // read — one trailing session.meta write 1.2s after the stream settles
  // down, so rapid live frames don't spam the wire.
  const readSent = useRef<Record<string, number>>({});
  useEffect(() => {
    const sid = active;
    if (!sid || !authed) return;
    const seq = lastSeqs[sid] || 0;
    // never send below the daemon's persisted mark — a restart replays the
    // ring from seq 1 and would otherwise drag lastReadSeq backwards
    const row = sessionsRef.current.find((s: any) => (s.id || s.sessionId) === sid);
    if (seq <= Math.max(readSent.current[sid] || 0, row?.lastReadSeq || 0)) return;
    readSent.current[sid] = seq;
    const t = setTimeout(() => {
      try {
        rig.send({ type: "session.meta", sessionId: sid, lastReadSeq: seq });
      } catch {}
    }, 1200);
    return () => clearTimeout(t);
  }, [active, lastSeqs, authed]);

  return (
    <Ctx.Provider
      value={{
        connected,
        authed,
        sessions,
        active,
        setActive: setActivePersist,
        lastSeqs,
        bumpSeq: queueSeq,
        refreshSessions,
        hostInfo,
        vitals,
        probeInfo,
        setProbeInfo,
        sessionMeta,
        patchMeta,
        mode,
        setMode,
        drawerOpen,
        setDrawerOpen,
        newSheet,
        setNewSheet,
        screenSheet,
        setScreenSheet,
        disconnect,
        resume,
        authProviders,
        authEvents,
        authLive,
        authSheet,
        setAuthSheet,
        authStart,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
