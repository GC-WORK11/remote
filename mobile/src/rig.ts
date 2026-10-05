// Real omprd protocol client — RFC6455 via RN's built-in WebSocket.
// Wire shapes from os-bridge/protocol.md — nothing faked.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

export type Frame = { type: string; [k: string]: any };
type Handler = (f: Frame) => void;

export interface RigInfo {
  version?: string;
  hostname?: string;
  sessions?: number;
}

export class RigClient {
  host = "127.0.0.1";
  port = 8790;
  token: string | null = null;
  // set when a token was just minted/saved — lets the app ignore a stray
  // "unauthorized" reply still landing on the old unauthed socket
  tokenSetAt = 0;
  ws: WebSocket | null = null;
  connected = false;
  authed = false;
  private handlers = new Set<Handler>();
  private frameWaiters = new Map<string, { resolve: (f: Frame) => void; timer: any }>();
  // The daemon rewrites request ids (omprd-N), so session.response frames are
  // correlated FIFO per (sessionId, command).
  private requestQueues = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void; timer: any }[]>();
  private fsWaiters = new Map<string, { resolve: (f: Frame) => void; timer: any }>();
  private fsSeq = 0;

  onFrame(h: Handler) {
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }

  private emit(f: Frame) {
    if (typeof window !== "undefined") {
      // debug log — bound it: an unbounded array grew by one entry per
      // streamed frame for the life of the page (megabytes on long sessions)
      const log = (((window as any).__rigLog ||= []) as string[]);
      log.push(f.type);
      if (log.length > 500) log.splice(0, log.length - 500);
    }
    // fsCall-minted ids (fs1, fs2…) correlate every correlated reply —
    // rig.fs.result, rig.pr.result, rig.vitals, sessions.tree,
    // session.spawned. Match by id alone: only fsCall mints this namespace,
    // so any frame echoing one of our ids is that call's reply.
    if (typeof f.id === "string") {
      const w = this.fsWaiters.get(f.id);
      if (w) {
        this.fsWaiters.delete(f.id);
        clearTimeout(w.timer);
        w.resolve(f);
      }
    }
    if (f.type === "session.response") {
      const inner = (f.frame || {}) as Frame;
      const key = `${f.sessionId}:${inner.command || ""}`;
      const q = this.requestQueues.get(key);
      const waiter = q?.shift();
      if (q && q.length === 0) this.requestQueues.delete(key);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(inner);
      }
    }
    const w = this.frameWaiters.get(f.type);
    if (w) {
      this.frameWaiters.delete(f.type);
      clearTimeout(w.timer);
      w.resolve(f);
    }
    this.handlers.forEach((h) => h(f));
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

  async probe(host: string, port: number): Promise<RigInfo | null> {
    try {
      const r = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${port}/`, { method: "GET" });
      return (await r.json()) as RigInfo;
    } catch {
      return null;
    }
  }

  async loadToken(host: string) {
    this.token = await AsyncStorage.getItem(`rigToken:${host}`);
  }
  async saveToken(host: string, t: string) {
    this.token = t;
    this.tokenSetAt = Date.now();
    // a minted token IS the paired state — callers used to flip it by hand
    this.authed = true;
    await AsyncStorage.setItem(`rigToken:${host}`, t);
  }

  markAuthed() {
    this.authed = true;
  }

  // Generation counter: only the newest connect() owns the socket. Stale
  // sockets (replaced or late-opening) are closed and their events dropped —
  // a leaked socket keeps receiving broadcasts and every frame lands twice.
  private connGen = 0;

  connect(host: string, port: number): Promise<void> {
    // A malformed host crashes the app on Android: RN's WebSocketModule
    // throws okhttp3 IllegalArgumentException on the native mqt_v_native
    // thread — uncatchable from JS, the whole process dies. Reject bad
    // input here so it surfaces as a normal connect error instead.
    const h0 = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    const hostOk = h0.includes(":")
      ? /^[0-9a-fA-F:.%]+$/.test(h0) // IPv6 (zone-id chars tolerated)
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
      // Token: header on native RN, ?token= on web (browsers can't set WS headers)
      const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      const url = `ws://${h}:${port}/ws${this.token ? `?token=${this.token}` : ""}`;
      const opts: any = this.token
        ? { headers: { Authorization: `Bearer ${this.token}` } }
        : undefined;
      // On web, extra constructor args produce a bogus Sec-WebSocket-Protocol
      // header the daemon won't echo — single-arg form there.
      const ws =
        Platform.OS === "web"
          ? new (WebSocket as any)(url)
          : new (WebSocket as any)(url, undefined, opts);
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
      ws.onmessage = (ev: any) => {
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      throw new Error("not connected");
    this.ws.send(JSON.stringify(obj));
  }

  // Fire-and-forget: drops silently while the socket is down instead of
  // throwing inside timers/effects during disconnect or restore.
  trySend(obj: Frame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  async pair(code: string, device: string): Promise<string> {
    // Pair failures arrive as {"type":"error"} — surfacing them turns a bad or
    // expired code into the daemon's sentence instead of a 10s timeout. The
    // unauthed socket also sees "unauthorized" noise from background
    // refreshes; every other error during pair is ours.
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
    await this.saveToken(this.host, token);
    return token;
  }

  sessionNew(cwd: string, model?: string) {
    const f: Frame = { type: "session.new", cwd };
    if (model) f.model = model;
    this.send(f);
  }
  sessionKill(sessionId: string) {
    this.send({ type: "session.kill", sessionId });
  }
  subscribe(sessionId: string, since: number) {
    this.send({ type: "session.subscribe", sessionId, since });
  }
  prompt(sessionId: string, message: string, images?: Frame[], id = `p${Date.now()}`) {
    const frame: Frame = { type: "prompt", id, message };
    if (images && images.length) frame.images = images;
    this.send({ type: "rpc", sessionId, frame });
    return id;
  }
  abortAll() {
    this.send({ type: "sessions.abortAll" });
  }
  rpc(sessionId: string, frame: Frame) {
    this.send({ type: "rpc", sessionId, frame });
  }

  // Daemon-correlated request — reply arrives privately as session.response.
  // Resolves with the inner response frame (type:"response", command, success, data|error).
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
        // _slim is a wire-only hint the daemon strips before omp sees it:
        // get_available_models returns ~500 models × ~2.5KB each (~1.2MB
        // over the wire + one big JSON.parse on the JS thread) while the
        // picker reads only identity/thinking fields — the slim form is
        // ~10× smaller. Other commands are untouched.
        const wire =
          frame.type === "get_available_models" ? { ...frame, _slim: true } : frame;
        this.send({ type: "session.request", sessionId, frame: wire });
      } catch (e) {
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }
  // ---- provider auth (vault lives on the host; phone brokers the flow) ----
  authList() {
    this.send({ type: "auth.list" });
  }
  authLogin(provider: string) {
    this.send({ type: "auth.login", provider });
  }
  authInput(text: string) {
    this.send({ type: "auth.input", text });
  }
  authCancel() {
    this.send({ type: "auth.cancel" });
  }
  // Open a URL/app on the host's own browser (loopback OAuth callbacks must
  // land on the laptop — the phone can't complete them itself). `os` comes
  // from rig.status so the right per-OS opener is used.
  hostOpen(target: string, os?: string) {
    const t = target.replace(/(["`$\\])/g, "\\$1");
    const command =
      os === "windows"
        ? `start "" "${t}"`
        : os === "linux"
          ? // xdg-open exit 0 is untrustworthy headless: it falls through to
            // w3m/lynx and reports success while opening nothing — so only
            // trust it when a real DE is running, else go straight to a
            // graphical browser binary (PATH may not cover $HOME/.local/bin)
            `if [ -n "\${XDG_CURRENT_DESKTOP:-}\${DESKTOP_SESSION:-}" ] && xdg-open "${t}" >/dev/null 2>&1; then exit 0; fi; for b in chromium chromium-browser google-chrome google-chrome-stable microsoft-edge brave firefox epiphany; do p="$(command -v "$b" 2>/dev/null)"; [ -z "$p" ] && [ -x "$HOME/.local/bin/$b" ] && p="$HOME/.local/bin/$b"; if [ -n "$p" ]; then nohup "$p" --new-window "${t}" >/dev/null 2>&1 & exit 0; fi; done; echo "hostOpen: no browser binary on rig" >&2; exit 3`
          : `open "${t}"`;
    this.send({ type: "rig.exec", command, timeoutMs: 10000 });
  }

  // ---- rig.fs — the laptop's real filesystem, browsable from the phone ----
  // ops: rig.fs.glob (shallow listing when pattern="*"), rig.fs.read,
  // rig.fs.write, rig.fs.grep. Replies arrive as rig.fs.result{id}.
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
  // Shallow listing of `path`: directories first, then files — both marked.
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
      String(a.path || "").localeCompare(String(b.path || ""), undefined, {
        sensitivity: "base",
      });
    dirs.sort(byName);
    files.sort(byName);
    return { dirs, files };
  }
  fsRead(path: string, maxBytes = 200 * 1024): Promise<Frame> {
    return this.fsCall("rig.fs.read", { path, maxBytes }, 20000);
  }
  async fsMkdir(path: string): Promise<Frame> {
    // mkdir via exec — runs on the host shell, honest errors come back as
    // the command's stderr. Quote for spaces/metachars.
    const q = `"${path.replace(/(["`$\\])/g, "\\$1")}"`;
    return this.exec(`mkdir -p ${q} && echo __OK__`, "", () => {}, 10000);
  }
  fsWrite(path: string, content: string, mkdirs = true): Promise<Frame> {
    return this.fsCall("rig.fs.write", { path, content, mkdirs }, 20000);
  }

  // ---- rig.pr.info — real PR state via the rig's `gh` CLI. ok:false when
  // gh isn't installed/authed on the laptop; screens keep their honest
  // empty state rather than inventing data.
  prInfo(url: string): Promise<Frame> {
    return this.fsCall("rig.pr.info", { url }, 20000);
  }

  // rig.pr.merge — real `gh pr merge` on the host (squash|merge|rebase,
  // optional --delete-branch). Reply carries gh's own output.
  prMerge(url: string, method: "squash" | "merge" | "rebase", deleteBranch = false): Promise<Frame> {
    return this.fsCall("rig.pr.merge", { url, method, deleteBranch }, 40000);
  }

  // rig.pr.checks — live CI rollup from `gh pr checks --json`:
  // {checks:[{name,state,bucket,…}], rollup:{pass,fail,pending,skipped,total,state}}
  prChecks(url: string): Promise<Frame> {
    return this.fsCall("rig.pr.checks", { url }, 30000);
  }

  // rig.pr.create — real `gh pr create` inside the given repo cwd. Reply
  // carries {ok, url, output}; gh's own stderr surfaces as error.
  prCreate(opts: { cwd: string; title?: string; body?: string; draft?: boolean; base?: string; head?: string; fill?: boolean }): Promise<Frame> {
    return this.fsCall("rig.pr.create", opts, 50000);
  }

  // rig.vitals — host health: {battery?, uptimeSec?, load?|cpuPct?, disk?,
  // mem?, net?} — every field independently null when the OS can't answer.
  vitals(): Promise<Frame> {
    return this.fsCall("rig.vitals", {}, 15000);
  }

  // session.spawn — child session under parentId (cwd inherited, prompt
  // delivered as its first turn). Reply: session.spawned {sessionId,parentId}.
  sessionSpawn(opts: { parentId: string; prompt?: string; title?: string; cwd?: string; sessionId?: string; [k: string]: unknown }): Promise<Frame> {
    return this.fsCall("session.spawn", opts, 30000);
  }

  // ---- rig.exec — native shell on the host; streams exec.output.chunk ----
  // Returns a final Frame with {code, out}. onChunk receives each decoded
  // chunk live (UTF-8 clean; binary arrives via chunkB64).
  exec(
    command: string,
    cwd: string,
    onChunk: (s: string) => void,
    ms = 60000
  ): Promise<Frame> {
    return new Promise((resolve, reject) => {
      let out = "";
      let myId = -1;
      const off = this.onFrame((f) => {
        if (f.type === "exec.started" && myId === -1) {
          myId = f.execId;
          return;
        }
        if (myId === -1 || f.execId !== myId) return;
        // exec.output: `chunk` is always a string (UTF-8 or U+FFFD-cleaned
        // preview); `chunkB64` rides alongside carrying the raw bytes.
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

  // ---- rig.term.* — interactive pty: one live shell on the laptop ----
  // open() resolves with the termId (or rejects when the daemon lacks the
  // backend — Windows returns an error frame); out chunks stream via
  // onFrame with type "term.out" (data is always UTF-8-clean text, dataB64
  // carries raw bytes when scrubbed). The caller owns close().
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

  // "what the agent saw" cards. Replies are matched by name; fetches run
  // one at a time so an out-of-order reply can't resolve the wrong wait.
  private shotChain: Promise<Frame | null> = Promise.resolve(null);
  fetchShot(name: string, ms = 12000): Promise<Frame | null> {
    const next = this.shotChain.then(() => this.#shotRound(name, ms));
    this.shotChain = next.then(
      () => null,
      () => null
    );
    return next;
  }
  async #shotRound(name: string, ms: number): Promise<Frame | null> {
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
