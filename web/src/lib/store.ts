// Global app state — Solid port of mobile/src/state.tsx.
// One socket, one store: connection, sessions+meta, host info, prefs,
// reconnect loop, Web Notifications for turn finishes.
import { createSignal, createRoot } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { rig, Frame } from "./rig";

export type Mode = "cowork" | "code";
export type ConnState = "offline" | "connecting" | "connected" | "unauthorized";

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

export interface Sess {
  id: string;
  cwd?: string;
  pid?: number;
  lastSeq?: number;
  createdAt?: number;
  lastAt?: number;
  busy?: boolean;
  alive?: boolean;
  preview?: string;
  parentId?: string;
  title?: string;
  pinned?: boolean;
  hidden?: boolean;
  lastReadSeq?: number;
  branch?: string;
  harness?: string;
  [k: string]: any;
}

const LS = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

export function messageText(message: any): string {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c.map((b: any) => (b && b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
  return "";
}

export function sessionTitle(s: any): string {
  const t = typeof s?.title === "string" ? s.title.trim() : "";
  if (t) return t;
  const cwd = typeof s?.cwd === "string" ? s.cwd : "";
  if (cwd) return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
  return "Conversation";
}

// preview fields can arrive as objects from some harnesses — render text only
export function sessionPreview(v: any): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v.text === "string") return v.text;
  if (typeof v.message === "string") return v.message;
  return "";
}

const sortSessions = (list: Sess[]) =>
  [...list].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const ta = Math.max(a.lastAt || 0, (a as any).previewAt || 0, a.createdAt || 0);
    const tb = Math.max(b.lastAt || 0, (b as any).previewAt || 0, b.createdAt || 0);
    return tb - ta;
  });

// ---------------------------------------------------------------------------
// mascot glance bus — every wire frame nudges buddies (see mascot.tsx)
export const [wireTick, setWireTick] = createSignal(0);
let tickThrottle = 0;
function pokeWire() {
  const n = Date.now();
  if (n - tickThrottle > 1400) {
    tickThrottle = n;
    setWireTick(n);
  }
}

function createAppStore() {
  const [conn, setConn] = createSignal<ConnState>("offline");
  const [authed, setAuthed] = createSignal(false);
  const [sessions, setSessions] = createStore<Sess[]>([]);
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [hostInfo, setHostInfo] = createSignal<any>(null);
  const [vitals, setVitals] = createSignal<any>(null);
  const [meta, setMeta] = createStore<Record<string, SessionMeta>>({});
  const [authProviders, setAuthProviders] = createSignal<any[]>([]);
  const [authEvents, setAuthEvents] = createSignal<Frame[]>([]);
  const [authLive, setAuthLive] = createSignal<string | null>(null);
  const [lastSeqs, setLastSeqs] = createStore<Record<string, number>>({});

  // ui state
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [screenPanel, setScreenPanel] = createSignal(false); // right context panel
  const [newSheet, setNewSheet] = createSignal(false);
  const [authSheet, setAuthSheet] = createSignal(false);
  const [sessionSheetId, setSessionSheetId] = createSignal<string | null>(null);
  const [spawnParent, setSpawnParent] = createSignal<string | null>(null);
  const [routinesSheet, setRoutinesSheet] = createSignal(false);
  const [changesFor, setChangesFor] = createSignal<string | null>(null);
  const [mergeSheetUrl, setMergeSheetUrl] = createSignal<string | null>(null);
  const [modelSheet, setModelSheet] = createSignal(false);
  const [showHidden, setShowHidden] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [mode, setMode] = createSignal<Mode>("cowork");
  const [toast, setToast] = createSignal<string | null>(null);
  let toastT: any;
  const showToast = (t: string, ms = 3200) => {
    setToast(t);
    clearTimeout(toastT);
    toastT = setTimeout(() => setToast(null), ms);
  };

  // prefs
  const [preferredModel, setPreferredModelSig] = createSignal<string>(LS.get("preferredModel") || "");
  const [preferredEffort, setPreferredEffortSig] = createSignal<string>(LS.get("preferredEffort") || "low");
  const [preferredHarness, setPreferredHarnessSig] = createSignal<string>(LS.get("preferredHarness") || "omp");
  const [theme, setThemeSig] = createSignal<string>(LS.get("theme") || "light");
  const setTheme = (t: string) => {
    setThemeSig(t);
    LS.set("theme", t);
    document.documentElement.dataset.theme = t === "dark" ? "dark" : "";
  };
  if (LS.get("theme") === "dark") document.documentElement.dataset.theme = "dark";
  const setPreferredModel = (m: string) => {
    setPreferredModelSig(m);
    LS.set("preferredModel", m);
  };
  const setPreferredEffort = (e: string) => {
    setPreferredEffortSig(e);
    LS.set("preferredEffort", e);
  };
  const setPreferredHarness = (h: string) => {
    setPreferredHarnessSig(h);
    LS.set("preferredHarness", h);
  };

  const spaceClaimed = new Set<string>();
  const manualClose = { current: false };
  const reconnecting = { current: false };

  const patchMeta = (id: string, m: Partial<SessionMeta>) => {
    setMeta(id, (prev) => ({
      ...(prev || {}),
      ...m,
      ...(m.pr ? { pr: { ...(prev?.pr || {}), ...m.pr } } : {}),
    }));
  };

  const notify = (title: string, body = "") => {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden)
        new Notification(title, { body });
    } catch {}
  };
  const askNotifPerm = () => {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default")
        Notification.requestPermission().catch(() => {});
    } catch {}
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

  const setActive = (id: string | null) => {
    setActiveId(id);
    if (id) {
      patchMeta(id, { done: false });
      LS.set("rigActive", id);
      const s = sessions.find((x) => x.id === id);
      setMode(s && s.cwd ? "code" : "cowork");
    } else LS.del("rigActive");
  };

  const disconnect = () => {
    manualClose.current = true;
    rig.clearToken();
    rig.close();
    setActiveId(null);
    setSessions([]);
    setConn("offline");
    setAuthed(false);
  };

  const startReconnect = () => {
    if (reconnecting.current || manualClose.current) return;
    reconnecting.current = true;
    let delay = 800;
    (async () => {
      while (!rig.connected && !manualClose.current) {
        await new Promise((r) => setTimeout(r, delay));
        if (rig.connected || manualClose.current) break;
        try {
          await rig.connect(rig.host, rig.port);
          rig.authed = true;
          setAuthed(true);
          setConn("connected");
          refreshSessions();
        } catch {
          delay = Math.min(delay * 2, 8000);
        }
      }
      reconnecting.current = false;
    })();
  };

  // wire events → store
  rig.onFrame((f: Frame) => {
    pokeWire();
    if (f.type === "_open") {
      setConn("connected");
      setAuthed(rig.authed);
      refreshSessions();
      askNotifPerm();
    } else if (f.type === "paired") {
      setAuthed(true);
    } else if (f.type === "_closed") {
      setConn("offline");
      setAuthed(false);
      setHostInfo(null);
      startReconnect();
    } else if (f.type === "sessions.list") {
      const list = sortSessions((f.sessions || []) as Sess[]);
      setSessions(list);
      const aid = activeId();
      for (const s of list) {
        const cur = meta[s.id]?.streaming ?? false;
        if (cur !== !!s.busy) patchMeta(s.id, { streaming: !!s.busy });
      }
      if (aid && !list.some((s) => s.id === aid)) patchMeta(aid, { dead: true });
      if (!activeId()) {
        const saved = LS.get("rigActive");
        if (saved && list.some((s) => s.id === saved)) setActive(saved);
      }
    } else if (f.type === "error" && f.error === "unauthorized" && rig.token) {
      if (Date.now() - rig.tokenSetAt > 5000) {
        rig.clearToken();
        manualClose.current = true;
        rig.close();
        setAuthed(false);
        setConn("unauthorized");
        location.hash = "#/";
        location.reload();
      }
    } else if (f.type === "rig.status") {
      setHostInfo(f);
    } else if (f.type === "auth.list") {
      setAuthProviders(f.providers || []);
    } else if (f.type === "auth.started") {
      setAuthLive(f.provider as string);
      setAuthEvents([]);
    } else if (f.type === "auth.event") {
      if (f.kind === "done") setAuthLive(null);
      setAuthEvents((p) => [...p.slice(-40), f]);
    } else if (f.type === "auth.changed") {
      try {
        rig.authList();
      } catch {}
    } else if (f.type === "session.busy") {
      const sid = f.sessionId as string;
      if (sid)
        patchMeta(
          sid,
          f.busy ? { streaming: true, done: false, hibernated: false } : { streaming: false, done: activeId() !== sid }
        );
      if (!f.busy && sid && activeId() !== sid) {
        const sess = sessions.find((x) => x.id === sid);
        notify(`${sess ? sessionTitle(sess) : "Agent"} finished`, "Tap to read the reply.");
      }
      refreshSessions();
    } else if (f.type === "session.stalled") {
      if (f.sessionId) patchMeta(f.sessionId, { stalled: true });
    } else if (f.type === "session.hibernated") {
      if (f.sessionId) patchMeta(f.sessionId, { hibernated: true, streaming: false });
    } else if (f.type === "session.started") {
      const sid = (f.sessionId || f.id || f.session?.id) as string;
      if (sid) patchMeta(sid, { hibernated: false });
      refreshSessions();
      if (mode() === "cowork" && sid && !spaceClaimed.has(sid)) {
        spaceClaimed.add(sid);
        try {
          rig.send({ type: "computer.space", action: "new", sessionId: sid });
        } catch {}
      }
    } else if (f.type === "session.exited") {
      const sid = (f.sessionId || f.id) as string;
      if (sid) patchMeta(sid, { dead: true });
      refreshSessions();
    } else if (f.type === "session.deleted") {
      const sid = (f.sessionId || f.id) as string;
      if (sid) {
        patchMeta(sid, { dead: true });
        setSessions((p) => p.filter((s) => s.id !== sid));
      }
    } else if (f.type === "session.meta") {
      const sid = f.sessionId as string;
      if (sid) {
        setSessions(
          produce((list) => {
            const s = list.find((x) => x.id === sid);
            if (s) {
              if (f.pinned !== undefined) s.pinned = f.pinned;
              if (f.hidden !== undefined) s.hidden = f.hidden;
              if (f.lastReadSeq !== undefined) s.lastReadSeq = f.lastReadSeq;
            }
          })
        );
      }
    } else if (f.type === "session.renamed") {
      const sid = f.sessionId as string;
      if (sid)
        setSessions(
          produce((list) => {
            const s = list.find((x) => x.id === sid);
            if (s) s.title = f.title;
          })
        );
    } else if (f.type === "session.spawned") {
      refreshSessions();
    } else if (f.type === "schedule.fired" || f.type === "session.autoCompact") {
      refreshSessions();
    } else if (f.type === "rpc" && typeof f.seq === "number") {
      const sid = f.sessionId as string;
      if (sid && (lastSeqs[sid] || 0) < f.seq) setLastSeqs(sid, f.seq);
    }
  });

  return {
    // connection
    conn,
    setConn,
    authed,
    setAuthed,
    rig,
    startReconnect,
    manualClose,
    resume: () => {
      manualClose.current = false;
    },
    disconnect,
    refreshSessions,
    // data
    sessions,
    setSessions,
    sortSessions,
    activeId,
    setActive,
    meta,
    patchMeta,
    hostInfo,
    vitals,
    lastSeqs,
    // auth broker
    authProviders,
    authEvents,
    authLive,
    authStart: (p: string) => {
      try {
        rig.authLogin(p);
      } catch {}
    },
    // ui
    drawerOpen,
    setDrawerOpen,
    screenPanel,
    setScreenPanel,
    newSheet,
    setNewSheet,
    authSheet,
    setAuthSheet,
    sessionSheetId,
    setSessionSheetId,
    spawnParent,
    setSpawnParent,
    routinesSheet,
    setRoutinesSheet,
    changesFor,
    setChangesFor,
    mergeSheetUrl,
    setMergeSheetUrl,
    modelSheet,
    setModelSheet,
    showHidden,
    setShowHidden,
    query,
    setQuery,
    mode,
    setMode,
    toast,
    showToast,
    // prefs
    preferredModel,
    setPreferredModel,
    preferredEffort,
    setPreferredEffort,
    preferredHarness,
    setPreferredHarness,
    theme,
    setTheme,
  };
}

export const app = createRoot(createAppStore);
export type AppStore = ReturnType<typeof createAppStore>;
