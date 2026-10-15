// Drawer — left slide-over: brand, grouped sessions, rig utilities,
// keep-awake toggle, footer with conn state + disconnect. Mobile parity.
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { app, sessionTitle, Sess } from "../lib/store";
import { rig } from "../lib/rig";
import I from "./Icon";
import { Buddy } from "./Buddy";

function timeGroup(s: Sess): string {
  const ts = Math.max(s.lastAt || 0, s.createdAt || 0);
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  const days = (now.getTime() - ts) / 86400000;
  if (days < 7) return "This week";
  return "Earlier";
}

function timeLabel(s: Sess): string {
  const ts = Math.max(s.lastAt || 0, s.createdAt || 0);
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function DRow(props: { s: Sess }) {
  const m = () => app.meta[props.s.id] || {};
  const dimmed = () => m().hibernated || m().dead;
  const status = () => {
    if (m().streaming || props.s.busy) return "Working";
    if (m().dead) return "Ended";
    if (m().hibernated) return "Asleep";
    if (m().done) return "Done";
    return "Idle";
  };
  return (
    <button
      class={`drawer__srow ${app.activeId() === props.s.id ? "drawer__srow--on" : ""} ${dimmed() ? "drawer__srow--dim" : ""}`}
      onClick={() => {
        location.hash = `#/thread/${props.s.id}`;
        app.setDrawerOpen(false);
      }}
    >
      <Buddy k={props.s.id} size={28} />
      <span class="drawer__sbody">
        <span class="drawer__stitle">{sessionTitle(props.s)}</span>
        <span class={`drawer__ssub ${status() === "Working" ? "drawer__ssub--live" : ""}`}>
          {status()}
        </span>
      </span>
      <span class="drawer__stime">{timeLabel(props.s)}</span>
    </button>
  );
}

function UtilRow(props: { icon: keyof typeof I; label: string; onClick: () => void }) {
  return (
    <button class="drawer__urow" onClick={props.onClick}>
      <span class="drawer__uicon">
        {(() => {
          const Cmp = I[props.icon] as any;
          return <Cmp size={15} />;
        })()}
      </span>
      <span class="drawer__ulabel">{props.label}</span>
      <I.chevR size={13} />
    </button>
  );
}

export function Drawer() {
  const [settledOpen, setSettledOpen] = createSignal(false);
  const [awake, setAwake] = createSignal(true);

  onMount(() => {
    rig.fsCall("rig.status", {}, 8000).then((r: any) => {
      if (typeof r?.keepAwake === "boolean") setAwake(r.keepAwake);
    }).catch(() => {});
  });

  const grouped = createMemo(() => {
    const order = ["Today", "Yesterday", "This week", "Earlier"];
    const live = app.sessions.filter((s) => {
      const m = app.meta[s.id] || {};
      return !(m.dead && !m.streaming) && !s.hidden;
    });
    const settled = app.sessions.filter((s) => {
      const m = app.meta[s.id] || {};
      return m.dead && !m.streaming;
    });
    const g: { label: string; items: Sess[] }[] = [];
    for (const l of order) {
      const items = live.filter((s) => timeGroup(s) === l);
      if (items.length) g.push({ label: l, items });
    }
    return { g, settled };
  });

  const signedIn = () => app.authProviders().filter((p: any) => p.signedIn || p.authed).length;
  const host = () => app.hostInfo();
  const vit = () => app.vitals();
  const vitLine = () => {
    const v = vit();
    if (!v) return "";
    const parts: string[] = [];
    if (v.battery != null) parts.push(`${Math.round(v.battery)}%`);
    if (v.memUsedPct != null) parts.push(`mem ${Math.round(v.memUsedPct)}%`);
    if (v.uptime != null) parts.push(`up ${Math.floor(v.uptime / 3600)}h`);
    return parts.join(" · ");
  };

  const toggleAwake = () => {
    const on = !awake();
    setAwake(on);
    rig.fsCall("rig.stayAwake", { on }, 10000).then((r: any) => {
      if (r?.held === false) setAwake(false);
    }).catch(() => setAwake(!on));
  };

  const close = () => app.setDrawerOpen(false);

  return (
    <Show when={app.drawerOpen()}>
      <div class="drawer__backdrop" onClick={close} />
      <aside class="drawer">
        <div class="drawer__brand">
          <Buddy k="remote" shape="cloud" color="#34A853" size={26} />
          <span class="drawer__name">Remote</span>
          <span style={{ flex: 1 }} />
          <button
            class="drawer__new"
            title="New agent"
            onClick={() => {
              close();
              app.setNewSheet(true);
            }}
          >
            <I.plus size={16} />
          </button>
        </div>
        <div class="drawer__scroll">
          <For each={grouped().g}>
            {(grp) => (
              <div class="drawer__grp">
                <div class="drawer__sechead">{grp.label}</div>
                <For each={grp.items}>{(s) => <DRow s={s} />}</For>
              </div>
            )}
          </For>
          <Show when={grouped().settled.length}>
            <div class="drawer__grp">
              <button class="drawer__sechead drawer__sechead--btn" onClick={() => setSettledOpen(!settledOpen())}>
                <Show when={settledOpen()} fallback={<I.chevR size={11} />}>
                  <I.chevD size={11} />
                </Show>
                Settled ({grouped().settled.length})
              </button>
              <Show when={settledOpen()}>
                <For each={grouped().settled}>{(s) => <DRow s={s} />}</For>
              </Show>
            </div>
          </Show>
          <div class="drawer__sec">
            <div class="drawer__sechead">Remote control</div>
            <UtilRow icon="screen" label="See your screen" onClick={() => { app.setScreenPanel(true); close(); }} />
            <UtilRow icon="movie" label="Recordings" onClick={() => { location.hash = "#/recordings"; close(); }} />
            <UtilRow icon="terminal" label="Terminal" onClick={() => { location.hash = "#/terminal"; close(); }} />
            <UtilRow icon="globe" label="Browser" onClick={() => { location.hash = "#/browser"; close(); }} />
            <UtilRow icon="book" label="GitHub" onClick={() => { location.hash = "#/repos"; close(); }} />
            <UtilRow icon="folder" label="Files" onClick={() => { location.hash = "#/files"; close(); }} />
          </div>
        </div>
        <div class="drawer__utils">
          <button class="drawer__urow" onClick={toggleAwake}>
            <span class="drawer__uicon"><I.battery size={15} /></span>
            <span class="drawer__ulabel">Keep laptop awake</span>
            <span class={`mtoggle ${awake() ? "mtoggle--on" : ""}`}>
              <i />
            </span>
          </button>
          <UtilRow icon="key" label="Accounts" onClick={() => { app.setAuthSheet(true); close(); }} />
          <UtilRow icon="clock" label="Routines" onClick={() => { app.setRoutinesSheet(true); close(); }} />
        </div>
        <div class="drawer__foot">
          <span class={`conndot conndot--${app.conn() === "connected" ? "ok" : "bad"}`} />
          <span class="drawer__hostav">{((host()?.hostname || "R")[0] || "R").toUpperCase()}</span>
          <span class="drawer__footbody">
            <span class="drawer__hostname">{host()?.hostname || `${rig.host}:${rig.port}`}</span>
            <Show when={vitLine()}>
              <span class="drawer__vitals">{vitLine()}</span>
            </Show>
          </span>
          <button class="drawer__disc" onClick={() => { close(); app.disconnect(); }}>
            <I.logout size={13} /> Disconnect
          </button>
        </div>
      </aside>
    </Show>
  );
}
