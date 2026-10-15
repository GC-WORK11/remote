// Real omprd protocol client — RFC6455 via the browser's WebSocket.
// Port of mobile/src/rig.ts — same wire shapes, same correlation rules.
// Web deltas: localStorage instead of AsyncStorage, ?token= auth (JS can't
// set WS headers), same-origin default when the daemon serves this app.

export type Frame = { type: string; [k: string]: any };
type Handler = (f: Frame) => void;

export interface RigInfo {
  name?: string;
  version?: string;
  hostname?: string;
  uptimeMs?: number;
  sessions?: number;
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

export class RigClient {
  host = location.hostname || "127.0.0.1";
  port = Number(location.port) || 8790;
  sameOrigin = true; // served by omprd itself → ws to location.host
  token: string | null = null;
  tokenSetAt = 0;
  ws: WebSocket | null = null;
  connected = false;
  authed = false;
  private handlers = new Set<Handler>();
  private frameWaiters = new Map<string, { resolve: (f: Frame) => void; timer: any }>();
  // session.request replies arrive as session.response — daemon rewrites ids
  // (omprd-N), so correlation falls back to FIFO per (sessionId, command).
  private requestQueues = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void; timer: any }[]>();
  private fsWaiters = new Map<string, { resolve: (f: Frame) => void; timer: any }>();
  private fsSeq = 0;
  private connGen = 0;

  onFrame(h: Handler) {
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }

  private emit(f: Frame) {
    const log = ((window as any).__rigLog ||= [] as string[]);
    log.push(f.type);
    if (log.length > 500) log.splice(0, log.length - 500);
    if (typeof f.id === "string") {
      const w = this.fsWaiters.get(f.id);
      if (w) {
        this.fsWaiters.delete(f.id);
        clearTimeout(w.timer);
        w.resolve(f);
      }
    }
    // Some replies keep domain data in `id` (window/recording ids) and echo
    // the caller's id as reqId instead — treat reqId the same for waiters.
    if (typeof f.reqId === "string") {
      const w = this.fsWaiters.get(f.reqId);
      if (w) {
        this.fsWaiters.delete(f.reqId);
        clearTimeout(w.timer);
        w.resolve(f);
      }
    }
    if (f.type === "session.response") {
      const inner = (f.frame || {}) as Frame;
      // daemon echoes the caller id → exact-match fast path
      const byId = typeof f.id === "string" ? this.fsWaiters.get(f.id) : undefined;
      if (byId) {
        this.fsWaiters.delete(f.id);
        clearTimeout(byId.timer);
        byId.resolve(inner);
      } else {
        const key = `${f.sessionId}:${inner.command || ""}`;
        const q = this.requestQueues.get(key);
        const waiter = q?.shift();
        if (q && q.length === 0) this.requestQueues.delete(key);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(inner);
        }
      }
    }
    const w = this.frameWaiters.get(f.type);
    if (w) {
      this.frameWaiters.delete(f.type);
      clearTimeout(w.timer);
      w.resolve(f);
    }
    this.handlers.forEach((h) => {
      try {
        h(f);
      } catch (err) {
        ((window as any).__herr ||= []).push(`${f.type}: ${String((err as any)?.stack || err)}`);
      }
    });
  }

  waitFor(type: string, ms = 15000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.frameWaiters.delete(type);
        reject(new Error(`timeout waiting ${type}`));
      }, ms);
      this.frameWaiters.set(type, { resolve, timer });
    });
  }

  // Probe the rig. When we're served by omprd itself the JSON blob lives at
  // /diag (GET / returns this app for browsers); for a remote host hit /.
  async probe(host: string, port: number): Promise<RigInfo | null> {
    const urls =
      this.sameOrigin
        ? ["/diag", "/"]
        : [`http://${host.includes(":") ? `[${host}]` : host}:${port}/diag`, `http://${host.includes(":") ? `[${host}]` : host}:${port}/`];
    for (const u of urls) {
      try {
        const r = await fetch(u, { method: "GET", headers: { Accept: "application/json" } });
        const j = (await r.json()) as RigInfo;
        if (j && (j.name === "omprd" || j.version)) return j;
      } catch {}
    }
    return null;
  }

  async loadToken(host: string) {
    this.token = LS.get(`rigToken:${host}`);
    // keep the legacy single-slot too
    if (!this.token) this.token = LS.get("rigToken");
  }
  saveToken(host: string, t: string) {
    this.token = t;
    this.tokenSetAt = Date.now();
    this.authed = true;
    LS.set(`rigToken:${host}`, t);
    LS.set("rigToken", t);
  }
  clearToken() {
    LS.del(`rigToken:${this.host}`);
    LS.del("rigToken");
    this.token = null;
    this.authed = false;
  }

  markAuthed() {
    this.authed = true;
  }

  wsUrl(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    if (this.sameOrigin) {
      return `${proto}//${location.host}/ws${this.token ? `?token=${this.token}` : ""}`;
    }
    const h = this.host.includes(":") && !this.host.startsWith("[") ? `[${this.host}]` : this.host;
    return `${proto}//${h}:${this.port}/ws${this.token ? `?token=${this.token}` : ""}`;
  }

  connect(host: string, port: number): Promise<void> {
    const h0 = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    const hostOk = this.sameOrigin
      ? true
      : h0.includes(":")
        ? /^[0-9a-fA-F:.%]+$/.test(h0)
        : h0.length > 0 &&
          h0.length <= 253 &&
          h0.split(".").every((l) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l));
    if (!hostOk || !Number.isInteger(port) || port < 1 || port > 65535) {
      return Promise.reject(new Error("Bad rig address — check the host and port"));
    }
    return new Promise((resolve, reject) => {
      const gen = ++this.connGen;
      this.host = host;
      this.port = port;
      const stale = this.ws;
      this.ws = null;
      if (stale) {
        stale.onopen = null;
        stale.onmessage = null;
        stale.onerror = null;
        stale.onclose = null;
        try {
          stale.close();
        } catch {}
      }
      const ws = new WebSocket(this.wsUrl());
      let settled = false;
      ws.onopen = () => {
        if (gen !== this.connGen) {
          try {
            ws.close();
          } catch {}
          return;
        }
        settled = true;
        this.connected = true;
        this.ws = ws;
        this.emit({ type: "_open" });
        resolve();
      };
      ws.onerror = (e: any) => {
        if (!settled) {
          settled = true;
          reject(new Error(e?.message || "ws error"));
        }
      };
      ws.onclose = () => {
        if (gen !== this.connGen) return;
        this.connected = false;
        if (this.ws === ws) this.ws = null;
        this.emit({ type: "_closed" });
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (gen !== this.connGen) return;
        try {
          const f = JSON.parse(String(ev.data));
          this.emit(f);
        } catch {}
      };
      setTimeout(() => {
        if (!settled) {
          settled = true;
          if (gen === this.connGen) {
            try {
              ws.close();
            } catch {}
          }
          reject(new Error("connect timeout"));
        }
      }, 8000);
    });
  }

  close() {
    this.connGen++;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
  }

  send(obj: Frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("not connected");
    this.ws.send(JSON.stringify(obj));
  }

  trySend(obj: Frame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  async pair(code: string, device: string): Promise<string> {
    const m = await new Promise<Frame>((resolve, reject) => {
      let timer: any;
      const off = this.onFrame((f) => {
        if (f.type === "paired") {
          clearTimeout(timer);
          off();
          resolve(f);
        } else if (f.type === "error" && f.error !== "unauthorized") {
          clearTimeout(timer);
          off();
          reject(new Error(String(f.error || "pairing failed")));
        }
      });
      timer = setTimeout(() => {
        off();
        reject(new Error("timeout waiting paired"));
      }, 10000);
      try {
        this.send({ type: "pair", code: code.trim(), device });
      } catch (e) {
        clearTimeout(timer);
        off();
        reject(e);
      }
    });
    const token = m.token as string;
    this.saveToken(this.host, token);
    return token;
  }

  // ---- sessions ----
  sessionNew(opts: { sessionId?: string; cwd?: string; model?: string; thinking?: string; yolo?: boolean; harness?: string; harnessBin?: string; tools?: string }) {
    this.send({ type: "session.new", ...opts });
  }
  sessionKill(sessionId: string) {
    this.send({ type: "session.kill", sessionId });
  }
  sessionDelete(sessionId: string) {
    this.send({ type: "session.delete", sessionId });
  }
  sessionRename(sessionId: string, title: string) {
    this.send({ type: "session.rename", sessionId, title });
  }
  sessionMeta(sessionId: string, meta: { pinned?: boolean; hidden?: boolean; lastReadSeq?: number }) {
    this.send({ type: "session.meta", sessionId, ...meta });
  }
  sessionHistory(sessionId: string, before: number, limit = 160) {
    this.send({ type: "session.history", sessionId, before, limit });
  }
  subscribe(sessionId: string, since: number) {
    this.send({ type: "session.subscribe", sessionId, since });
  }
  sessionsList() {
    this.send({ type: "sessions.list" });
  }
  abortAll() {
    this.send({ type: "sessions.abortAll" });
  }
  rpc(sessionId: string, frame: Frame) {
    this.send({ type: "rpc", sessionId, frame });
  }
  prompt(sessionId: string, message: string, images?: Frame[], id = `p${Date.now()}`) {
    const frame: Frame = { type: "prompt", id, message };
    if (images && images.length) frame.images = images;
    this.send({ type: "rpc", sessionId, frame });
    return id;
  }
  request(sessionId: string, frame: Frame, ms = 15000): Promise<Frame> {
    const key = `${sessionId}:${frame.type || ""}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const q = this.requestQueues.get(key) || [];
        this.requestQueues.set(
          key,
          q.filter((w) => w.resolve !== resolve)
        );
        reject(new Error(`timeout waiting ${frame.type}`));
      }, ms);
      const q = this.requestQueues.get(key) || [];
      q.push({ resolve, reject, timer });
      this.requestQueues.set(key, q);
      try {
        const wire = frame.type === "get_available_models" ? { ...frame, _slim: true } : frame;
        this.send({ type: "session.request", sessionId, frame: wire });
      } catch (e) {
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  // ---- provider auth broker ----
  authList() {
    this.send({ type: "auth.list" });
  }
  authLogin(provider: string, key?: string) {
    const f: Frame = { type: "auth.login", provider };
    if (key) f.key = key;
    this.send(f);
  }
  authInput(text: string) {
    this.send({ type: "auth.input", text });
  }
  authCancel() {
    this.send({ type: "auth.cancel" });
  }

  hostOpen(target: string, os?: string) {
    const t = target.replace(/(["`$\\])/g, "\\$1");
    const command =
      os === "windows"
        ? `start "" "${t}"`
        : os === "linux"
          ? `if [ -n "\${XDG_CURRENT_DESKTOP:-}\${DESKTOP_SESSION:-}" ] && xdg-open "${t}" >/dev/null 2>&1; then exit 0; fi; for b in chromium chromium-browser google-chrome google-chrome-stable microsoft-edge brave firefox epiphany; do p="$(command -v "$b" 2>/dev/null)"; [ -z "$p" ] && [ -x "$HOME/.local/bin/$b" ] && p="$HOME/.local/bin/$b"; if [ -n "$p" ]; then nohup "$p" --new-window "${t}" >/dev/null 2>&1 & exit 0; fi; done; echo "hostOpen: no browser binary on rig" >&2; exit 3`
          : `open "${t}"`;
    this.send({ type: "rig.exec", command, timeoutMs: 10000 });
  }

  // ---- fsCall-minted ids correlate any reply echoing `id`/`reqId` ----
  fsCall(op: string, args: { [k: string]: unknown }, ms = 15000): Promise<Frame> {
    const id = `fs${++this.fsSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fsWaiters.delete(id);
        reject(new Error(`timeout waiting ${op}`));
      }, ms);
      this.fsWaiters.set(id, { resolve, timer });
      try {
        this.send({ type: op, id, ...args });
      } catch (e) {
        this.fsWaiters.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  async fsList(path: string, ms = 15000): Promise<{ dirs: Frame[]; files: Frame[] }> {
    const r = await this.fsCall(
      "rig.fs.glob",
      { pattern: "*", cwd: path, filesOnly: false, maxResults: 1500 },
      ms
    );
    const matches: Frame[] = Array.isArray(r.matches) ? r.matches : [];
    const dirs = matches.filter((x) => x.dir);
    const files = matches.filter((x) => !x.dir);
    const byName = (a: Frame, b: Frame) =>
      String(a.path || "").localeCompare(String(b.path || ""), undefined, { sensitivity: "base" });
    dirs.sort(byName);
    files.sort(byName);
    return { dirs, files };
  }
  fsRead(path: string, maxBytes = 200 * 1024): Promise<Frame> {
    return this.fsCall("rig.fs.read", { path, maxBytes }, 20000);
  }
  fsWrite(path: string, content: string, mkdirs = true): Promise<Frame> {
    return this.fsCall("rig.fs.write", { path, content, mkdirs }, 20000);
  }
  fsMkdir(path: string): Promise<Frame> {
    const q = `"${path.replace(/(["`$\\])/g, "\\$1")}"`;
    return this.exec(`mkdir -p ${q} && echo __OK__`, "", () => {}, 10000);
  }
  fsStat(path: string, cwd?: string): Promise<Frame> {
    const a: any = { path };
    if (cwd) a.cwd = cwd;
    return this.fsCall("rig.fs.stat", a, 10000);
  }

  prInfo(url: string): Promise<Frame> {
    return this.fsCall("rig.pr.info", { url }, 20000);
  }
  prMerge(url: string, method: "squash" | "merge" | "rebase", deleteBranch = false): Promise<Frame> {
    return this.fsCall("rig.pr.merge", { url, method, deleteBranch }, 40000);
  }
  prChecks(url: string): Promise<Frame> {
    return this.fsCall("rig.pr.checks", { url }, 30000);
  }
  prCreate(opts: { cwd: string; title?: string; body?: string; draft?: boolean; base?: string; head?: string; fill?: boolean }): Promise<Frame> {
    return this.fsCall("rig.pr.create", opts, 50000);
  }
  gitStatus(cwdOrSid: { sessionId?: string; cwd?: string }): Promise<Frame> {
    return this.fsCall("rig.git.status", cwdOrSid, 15000);
  }
  gitDiff(cwdOrSid: { sessionId?: string; cwd?: string }, path?: string, staged?: boolean): Promise<Frame> {
    const a: any = { ...cwdOrSid };
    if (path) a.path = path;
    if (staged) a.staged = true;
    return this.fsCall("rig.git.diff", a, 20000);
  }
  checkpointList(sessionId: string): Promise<Frame> {
    return this.fsCall("rig.checkpoint.list", { sessionId }, 15000);
  }
  checkpointRestore(sessionId: string, ref: string, confirm = false): Promise<Frame> {
    return this.fsCall("rig.checkpoint.restore", { sessionId, ref, confirm }, 30000);
  }
  checkpointCreate(sessionId: string, label?: string): Promise<Frame> {
    return this.fsCall("rig.checkpoint.create", { sessionId, label }, 20000);
  }

  vitals(): Promise<Frame> {
    return this.fsCall("rig.vitals", {}, 15000);
  }
  rigStatus(): Promise<Frame> {
    return this.fsCall("rig.status", {}, 10000);
  }
  rigUsage(): Promise<Frame> {
    return this.fsCall("rig.usage", {}, 15000);
  }
  rigModels(): Promise<Frame> {
    return this.fsCall("rig.models", {}, 15000);
  }
  stayAwake(on: boolean, persistent = true): Promise<Frame> {
    return this.fsCall("rig.stayAwake", { on, persistent }, 20000);
  }

  sessionSpawn(opts: { parentId: string; prompt?: string; title?: string; cwd?: string; sessionId?: string; [k: string]: unknown }): Promise<Frame> {
    return this.fsCall("session.spawn", opts, 30000);
  }
  sessionWait(sessionId: string, timeoutMs = 300000): Promise<Frame> {
    return this.fsCall("session.wait", { sessionId, timeoutMs }, timeoutMs + 15000);
  }
  sessionsTree(): Promise<Frame> {
    return this.fsCall("sessions.tree", {}, 15000);
  }

  scheduleList(): Promise<Frame> {
    return this.fsCall("rig.schedule.list", {}, 15000);
  }
  scheduleAdd(o: { prompt: string; cwd?: string; everySec: number; model?: string; delaySec?: number }): Promise<Frame> {
    return this.fsCall("rig.schedule.add", o, 15000);
  }
  scheduleEnable(jobId: string, enabled: boolean): Promise<Frame> {
    return this.fsCall("rig.schedule.enable", { jobId, enabled }, 15000);
  }
  scheduleRemove(jobId: string): Promise<Frame> {
    return this.fsCall("rig.schedule.remove", { jobId }, 15000);
  }

  // ---- rig.exec ----
  exec(command: string, cwd: string, onChunk: (s: string) => void, ms = 60000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      let out = "";
      let myId = -1;
      const off = this.onFrame((f) => {
        if (f.type === "exec.started" && myId === -1) {
          myId = f.execId;
          return;
        }
        if (myId === -1 || f.execId !== myId) return;
        if (f.type === "exec.output" && typeof f.chunk === "string") {
          out += f.chunk;
          onChunk(f.chunk);
        } else if (f.type === "exec.done") {
          off();
          clearTimeout(timer);
          resolve({ ...f, out });
        } else if (f.type === "error" && f.execId === myId) {
          off();
          clearTimeout(timer);
          reject(new Error(String(f.error)));
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error("exec timeout"));
      }, ms + 15000);
      try {
        const f: Frame = { type: "rig.exec", command, timeoutMs: ms };
        if (cwd) f.cwd = cwd;
        this.send(f);
      } catch (e) {
        off();
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  // ---- rig.term.* (posix pty) ----
  termOpen(cwd: string, cols = 120, rows = 32): Promise<number> {
    return new Promise((resolve, reject) => {
      const off = this.onFrame((f) => {
        if (f.type === "term.opened") {
          off();
          clearTimeout(timer);
          resolve(f.termId);
        } else if (f.type === "error" && String(f.error || "").includes("term")) {
          off();
          clearTimeout(timer);
          reject(new Error(String(f.error)));
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error("term.open timeout"));
      }, 12000);
      try {
        const f: Frame = { type: "rig.term.open", cols, rows };
        if (cwd) f.cwd = cwd;
        this.send(f);
      } catch (e) {
        off();
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }
  termIn(termId: number, data: string) {
    this.send({ type: "rig.term.in", termId, data });
  }
  termResize(termId: number, cols: number, rows: number) {
    this.send({ type: "rig.term.resize", termId, cols, rows });
  }
  termClose(termId: number) {
    this.send({ type: "rig.term.close", termId });
  }

  // ---- computer.* helpers ----
  computerCall(op: string, args: { [k: string]: unknown } = {}, ms = 15000): Promise<Frame> {
    return this.fsCall(op, args, ms);
  }
  watch(intervalMs = 250, scale = 0.45, threshold = 1) {
    this.send({ type: "computer.watch", intervalMs, threshold, scale, format: "jpg", quality: 60 });
  }
  unwatch(watchId?: string) {
    const f: Frame = { type: "computer.unwatch" };
    if (watchId) f.watchId = watchId;
    this.send(f);
  }
  recordList(): Promise<Frame> {
    return this.fsCall("computer.record.list", {}, 15000);
  }
  recordFrames(id: string, from = 1, count = 60): Promise<Frame> {
    // `id` on the wire is fsCall's correlation id — the recording goes under
    // `recordingId` so the two can't collide.
    return this.fsCall("computer.record.frames", { recordingId: id, from, count }, 20000);
  }
  recordStart(opts: { intervalMs?: number; scale?: number; quality?: number; maxDurationMs?: number } = {}): Promise<Frame> {
    return this.fsCall("computer.record.start", opts, 15000);
  }
  recordStop(id?: string): Promise<Frame> {
    return this.fsCall("computer.record.stop", id ? { recordingId: id } : {}, 20000);
  }
  recordDelete(id: string): Promise<Frame> {
    return this.fsCall("computer.record.delete", { recordingId: id }, 15000);
  }

  // serialized shot_file fetches — replies matched by name
  private shotChain: Promise<Frame | null> = Promise.resolve(null);
  fetchShot(name: string, ms = 12000): Promise<Frame | null> {
    const next = this.shotChain.then(() => this.shotRound(name, ms));
    this.shotChain = next.then(
      () => null,
      () => null
    );
    return next;
  }
  private async shotRound(name: string, ms: number): Promise<Frame | null> {
    const deadline = Date.now() + ms;
    try {
      for (;;) {
        const wait = this.waitFor("computer.shot_file", Math.max(1, deadline - Date.now()));
        try {
          this.send({ type: "computer.shot_file", name });
        } catch {
          return null;
        }
        const f = await wait;
        if (f.name === name && typeof f.imageBase64 === "string") return f;
        if (Date.now() >= deadline) return null;
      }
    } catch {
      return null;
    }
  }
}

export const rig = new RigClient();

// ---- remote:// URI parsing (paste-link flow) ----
export interface ParsedLink {
  host?: string;
  port?: number;
  code?: string;
  token?: string;
}
export function parseRigUri(text: string): ParsedLink | null {
  const t = (text || "").trim();
  if (!t) return null;
  try {
    if (t.startsWith("{")) {
      const j = JSON.parse(t);
      if (j.url) {
        const m = String(j.url).match(/^wss?:\/\/(\[[0-9a-fA-F:]+\]|[^/:\s]+)(?::(\d+))?/);
        if (m) {
          return {
            host: m[1].replace(/^\[|\]$/g, ""),
            port: m[2] ? Number(m[2]) : 8790,
            code: j.code ? String(j.code) : undefined,
            token: j.token ? String(j.token) : undefined,
          };
        }
      }
    }
  } catch {}
  const m = t.match(/^remote:\/\/(?:pair\?.*)?(\[[0-9a-fA-F:]+\]|[^/#?\s]+)?(?::(\d+))?.*#(.+)$/);
  if (m) {
    const frag = m[3];
    const out: ParsedLink = {};
    if (m[1]) out.host = m[1].replace(/^\[|\]$/g, "");
    if (m[2]) out.port = Number(m[2]);
    if (/^\d{4,8}$/.test(frag)) out.code = frag;
    else out.token = frag;
    return out;
  }
  // bare host:port
  const hp = t.match(/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (hp) {
    return { host: hp[1].replace(/^\[|\]$/g, ""), port: hp[2] ? Number(hp[2]) : 8790 };
  }
  return null;
}

export function tilde(cwd?: string): string {
  const p = (cwd || "").replace(/\/+$/, "");
  const m = p.match(/^\/(Users|home)\/[^/]+/);
  return m ? "~" + p.slice(m[0].length) : p;
}
