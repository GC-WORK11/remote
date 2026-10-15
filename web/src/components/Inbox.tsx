// Inbox rail — rig header, search, session list (pinned first), footer tools.
import { For, Show, createMemo } from "solid-js";
import { app, sessionTitle, sessionPreview, Sess } from "../lib/store";
import { rig, tilde } from "../lib/rig";
import I from "./Icon";
import { Buddy, buddyName } from "./Buddy";

function ago(ts?: number): string {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function Row(props: { s: Sess; onOpen: (id: string) => void }) {
  const s = () => props.s;
  const m = () => app.meta[s().id] || {};
  const dot = () => {
    if (m().dead) return "crashed";
    if (m().hibernated) return "sleeping";
    if (s().busy || m().streaming) return "working";
    if (m().done) return "done";
    if (m().stalled) return "attention";
    return "idle";
  };
  return (
    <button
      class={`inboxrow ${app.activeId() === s().id ? "inboxrow--active" : ""}`}
      onClick={() => props.onOpen(s().id)}
      onContextMenu={(e) => {
        e.preventDefault();
        app.setSessionSheetId(s().id);
      }}
    >
      <span class="inboxrow__avatar">
        <Buddy k={s().id} size={40} />
        <span class={`dot dot--${dot()} inboxrow__dot`}>
          <Show when={dot() === "working"}>
            <i /><i /><i />
          </Show>
        </span>
      </span>
      <span class="inboxrow__body">
        <span class="inboxrow__top">
          <span class="inboxrow__title">{sessionTitle(s())}</span>
          <span class="inboxrow__time">{ago(Math.max(s().lastAt || 0, m().previewAt || 0, s().createdAt || 0))}</span>
        </span>
        <span class="inboxrow__preview">
          {m().streaming
            ? "Working…"
            : sessionPreview(m().preview) || sessionPreview(s().preview) || tilde(s().cwd) || "No messages yet"}
        </span>
      </span>
      <Show when={s().pinned}>
        <span class="inboxrow__pin"><I.pin size={12} /></span>
      </Show>
    </button>
  );
}

export function Inbox(props: { onOpen: (id: string) => void }) {
  const filtered = createMemo(() => {
    const q = app.query().toLowerCase();
    const list = app.sessions.filter((s) => (app.showHidden() ? true : !s.hidden));
    if (!q) return list;
    return list.filter(
      (s) =>
        sessionTitle(s).toLowerCase().includes(q) ||
        (s.cwd || "").toLowerCase().includes(q) ||
        (app.meta[s.id]?.preview || s.preview || "").toLowerCase().includes(q)
    );
  });
  const host = () => app.hostInfo();
  const connLabel = () =>
    app.conn() === "connected" ? `${rig.host}:${rig.port}` : app.conn() === "connecting" ? "connecting…" : "offline";

  return (
    <div class="inbox">
      <div class="inbox__head">
        <button class="inbox__rig" onClick={() => app.setDrawerOpen(!app.drawerOpen())} title="Rig menu">
          <Buddy k="remote" shape="cloud" color="#3D96F8" size={32} />
          <span class="inbox__riginfo">
            <span class="inbox__rigname">{host()?.hostname || "Remote rig"}</span>
            <span class={`inbox__rigsub inbox__rigsub--${app.conn()}`}>{connLabel()}</span>
          </span>
        </button>
        <button class="circle-btn" title="New agent" onClick={() => app.setNewSheet(true)}>
          <I.plus size={17} />
        </button>
      </div>
      <div class="inbox__search">
        <I.search size={14} />
        <input
          placeholder="Search threads"
          value={app.query()}
          onInput={(e) => app.setQuery(e.currentTarget.value)}
        />
      </div>
      <div class="inbox__list">
        <Show
          when={filtered().length}
          fallback={
            <div class="inbox__empty">
              <Buddy k="remote" size={84} />
              <p>No threads yet.</p>
              <p class="inbox__emptysub">Tap + to start one — the rig does the work.</p>
            </div>
          }
        >
          <For each={filtered()}>{(s) => <Row s={s} onOpen={props.onOpen} />}</For>
        </Show>
      </div>
      <div class="inbox__foot">
        <button class="inbox__tool" onClick={() => (location.hash = "#/files")} title="Files">
          <I.folder size={16} />
        </button>
        <button class="inbox__tool" onClick={() => (location.hash = "#/terminal")} title="Terminal">
          <I.terminal size={16} />
        </button>
        <button class="inbox__tool" onClick={() => app.setScreenPanel(!app.screenPanel())} title="Screen">
          <I.screen size={16} />
        </button>
        <button class="inbox__tool" onClick={() => app.setRoutinesSheet(true)} title="Routines">
          <I.clock size={16} />
        </button>
        <button class="inbox__tool" onClick={() => app.setAuthSheet(true)} title="Accounts">
          <I.key size={16} />
        </button>
        <button
          class="inbox__tool"
          onClick={() => app.setTheme(app.theme() === "dark" ? "light" : "dark")}
          title="Theme"
        >
          <Show when={app.theme() === "dark"} fallback={<I.moon size={16} />}>
            <I.sun size={16} />
          </Show>
        </button>
      </div>
    </div>
  );
}
