// Terminal — real pty shells on the rig, xterm.js front-end.
// Port of mobile/src/app/code/terminal.tsx wire semantics: rig.term.open →
// term.out frames stream in → rig.term.in carries keystrokes back out.
// Multi-tab; each tab owns one xterm + one daemon pty (termId).
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { rig, Frame } from "../lib/rig";
import { app } from "../lib/store";
import I from "../components/Icon";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

type XTerm = import("@xterm/xterm").Terminal;
type Fit = import("@xterm/addon-fit").FitAddon;
type Live = { term: XTerm; fit: Fit; ro: ResizeObserver | null; termId: number | null; subs: { dispose(): void }[] };
type Tab = { key: number; label: string; cwd: string };

// Dark palette keyed off the app's code card (#16161a / #e8e6e3).
const THEME = {
  background: "#16161a", foreground: "#e8e6e3", cursor: "#e8e6e3", cursorAccent: "#16161a",
  selectionBackground: "rgba(255,255,255,.18)",
  black: "#16161a", red: "#e03e3e", green: "#1ba672", yellow: "#e87b1c",
  blue: "#3478f6", magenta: "#a02b6a", cyan: "#38a9f8", white: "#e8e6e3",
  brightBlack: "#6e6960", brightRed: "#ff6b5e", brightGreen: "#34c98e", brightYellow: "#f5a623",
  brightBlue: "#5a92ff", brightMagenta: "#c76bd8", brightCyan: "#5cc5ff", brightWhite: "#ffffff",
};

// Lazily-loaded module ctors (kept off the critical path — see onMount).
let XC: (typeof import("@xterm/xterm"))["Terminal"] | null = null;
let FC: (typeof import("@xterm/addon-fit"))["FitAddon"] | null = null;
let GC: (typeof import("@xterm/addon-webgl"))["WebglAddon"] | null = null;
let seq = 0;
// term.opened replies carry no request id — serialize opens so concurrent
// spawns can't cross-resolve (same caveat as rig.termOpen on mobile).
let spawnChain: Promise<unknown> = Promise.resolve();
const silence = (fn: () => void) => { try { fn(); } catch {} };

export default function Terminal() {
  const [ready, setReady] = createSignal(false);
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [active, setActive] = createSignal(0);
  const [cwdSel, setCwdSel] = createSignal("");
  const [customCwd, setCustomCwd] = createSignal("");
  const live = new Map<number, Live>();

  const activeCwd = () => app.sessions.find((s) => s.id === app.activeId())?.cwd || "";
  const sessionCwds = () => [...new Set(app.sessions.map((s) => s.cwd).filter(Boolean) as string[])];
  const pickCwd = () => (cwdSel() === "__custom" ? customCwd().trim() : cwdSel()) || activeCwd() || "~";
  const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
  const note = (L: Live, s: string) => L.term.write(`\r\n\x1b[2m[${s}]\x1b[0m\r\n`);

  onMount(async () => {
    try {
      XC = (await import("@xterm/xterm")).Terminal;
      FC = (await import("@xterm/addon-fit")).FitAddon;
      try { GC = (await import("@xterm/addon-webgl")).WebglAddon; } catch {} // GPU renderer optional
      setReady(true);
      openTab();
    } catch {
      app.showToast("terminal failed to load");
    }
  });

  const spawn = (key: number) => {
    spawnChain = spawnChain.then(async () => {
      const L = live.get(key);
      if (!L) return;
      if (!rig.connected) return L.term.write("\x1b[2mwaiting for connection…\x1b[0m\r\n");
      const t = tabs().find((x) => x.key === key);
      try {
        const id = await rig.termOpen(t?.cwd || "", L.term.cols || 120, L.term.rows || 32);
        const cur = live.get(key);
        if (!cur || !rig.connected) return silence(() => rig.termClose(id));
        cur.termId = id;
      } catch (e) {
        L.term.write(`\x1b[31mterm.open failed: ${e instanceof Error ? e.message : "error"}\x1b[0m\r\n`);
      }
    });
  };

  const mountTab = (key: number, el: HTMLDivElement) => {
    if (!XC || !FC || live.has(key)) return;
    const term = new XC({
      theme: THEME,
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FC();
    term.loadAddon(fit);
    term.open(el);
    if (GC) silence(() => term.loadAddon(new GC!())); // else stay on DOM renderer
    silence(() => fit.fit());
    const L: Live = { term, fit, ro: null, termId: null, subs: [] };
    L.subs.push(
      term.onData((d) => { if (L.termId != null) silence(() => rig.termIn(L.termId!, d)); }),
      term.onResize(({ cols, rows }) => { if (L.termId != null) silence(() => rig.termResize(L.termId!, cols, rows)); })
    );
    L.ro = new ResizeObserver(() => silence(() => fit.fit()));
    L.ro.observe(el);
    live.set(key, L);
    spawn(key);
  };

  const disposeTab = (key: number) => {
    const L = live.get(key);
    if (!L) return;
    live.delete(key);
    if (L.termId != null) silence(() => rig.termClose(L.termId!));
    L.ro?.disconnect();
    L.subs.forEach((d) => d.dispose());
    L.term.dispose();
  };

  const openTab = (cwd?: string) => {
    if (!ready()) return app.showToast("terminal still loading");
    const dir = cwd ?? pickCwd();
    const key = ++seq;
    setActive(key); // first, so the div mounts visible and fit() measures real size
    setTabs((t) => [...t, { key, label: `${key} · ${base(dir) || "shell"}`, cwd: dir }]);
  };

  const closeTab = (key: number) => {
    const i = tabs().findIndex((x) => x.key === key);
    disposeTab(key);
    setTabs((t) => t.filter((x) => x.key !== key));
    const rest = tabs();
    if (active() === key && rest.length) setActive(rest[Math.max(0, i - 1)]?.key ?? rest[0].key);
  };

  // wire frames → the xterm owning that termId
  const off = rig.onFrame((f: Frame) => {
    if (f.type !== "term.out" && f.type !== "term.exit" && f.type !== "term.closed") return;
    for (const [, L] of live) {
      if (L.termId !== f.termId) continue;
      if (f.type === "term.out") L.term.write(String(f.data ?? ""));
      else {
        L.termId = null;
        note(L, `shell exited${f.code != null ? ` · code ${f.code}` : ""}`);
      }
      break;
    }
  });

  // reconnect-on-drop: daemon ptys die with the socket — reopen every tab.
  let wasConn = rig.connected;
  createEffect(() => {
    const c = app.conn() === "connected";
    if (c === wasConn) return;
    wasConn = c;
    for (const [k, L] of live) {
      if (L.termId != null) silence(() => rig.termClose(L.termId!));
      L.termId = null;
      note(L, c ? "reconnected — restarting shell" : "connection lost");
      if (c) spawn(k);
    }
  });

  // newly visible tab → refit against real pixels + grab focus
  createEffect(() => {
    const k = active();
    requestAnimationFrame(() => {
      const L = live.get(k);
      if (!L) return;
      silence(() => L.fit.fit());
      L.term.focus();
    });
  });

  onCleanup(() => {
    off();
    for (const k of [...live.keys()]) disposeTab(k);
  });

  return (
    <div class="termview">
      <div class="termview__bar">
        <div class="termview__tabs">
          <For each={tabs()}>
            {(t) => (
              <button
                class="termview__tab"
                classList={{ "termview__tab--on": t.key === active() }}
                onClick={() => setActive(t.key)}
                title={t.cwd}
              >
                <I.terminal size={12} />
                <span class="termview__tabname">{t.label}</span>
                <span
                  class="termview__tabx"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.key);
                  }}
                >
                  <I.x size={11} />
                </span>
              </button>
            )}
          </For>
          <button class="termview__iconbtn" onClick={() => openTab()} title="New terminal">
            <I.plus size={15} />
          </button>
        </div>
        <div class="termview__cwd">
          <I.folder size={13} />
          <select value={cwdSel()} onChange={(e) => setCwdSel(e.currentTarget.value)} title="cwd for new terminals">
            <option value="">{activeCwd() ? `session · ${activeCwd()}` : "home · ~"}</option>
            <For each={sessionCwds()}>{(c) => <option value={c}>{c}</option>}</For>
            <option value="__custom">custom path…</option>
          </select>
          <Show when={cwdSel() === "__custom"}>
            <input
              value={customCwd()}
              onInput={(e) => setCustomCwd(e.currentTarget.value)}
              placeholder="/path/to/dir"
              spellcheck={false}
            />
          </Show>
        </div>
        <span class="termview__conn" classList={{ "termview__conn--on": app.conn() === "connected" }}>
          {app.conn() === "connected" ? "live" : app.conn()}
        </span>
      </div>
      <div class="termview__body">
        <For each={tabs()}>
          {(t) => (
            <div
              class="termview__term"
              style={{ display: t.key === active() ? "block" : "none" }}
              ref={(el) => mountTab(t.key, el)}
            />
          )}
        </For>
        <Show when={!ready()}>
          <div class="termview__empty">
            <span class="spinner" />
          </div>
        </Show>
        <Show when={ready() && tabs().length === 0}>
          <div class="termview__empty">
            <I.terminal size={26} />
            <p>No terminals</p>
            <button class="pill pill--ink" onClick={() => openTab()}>
              New terminal
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
