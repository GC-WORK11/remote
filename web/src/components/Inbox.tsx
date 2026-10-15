// Inbox — rig avatar, search toggle, session list. Mirrors the mobile
// home screen: 38px header circles, 44px buddy rows, hidden footer.
import { For, Show, createMemo, createSignal } from "solid-js";
import { app, sessionTitle, sessionPreview, Sess } from "../lib/store";
import { rig, tilde } from "../lib/rig";
import I from "./Icon";
import { Buddy } from "./Buddy";

function clockTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return hm;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  const days = (now.getTime() - d.getTime()) / 86400000;
  if (days < 6) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
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
  const unread = () => !!(m() as any).unread;
  const cwdLabel = () => {
    const c = s().cwd || "";
    if (!c) return "computer";
    const t = tilde(c);
    if (t === "~") return "~";
    return t.split("/").filter(Boolean).pop() || t;
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
        <Buddy k={s().id} size={44} />
      </span>
      <span class="inboxrow__body">
        <span class="inboxrow__top">
          <Show when={unread()}>
            <span class="inboxrow__unread" />
          </Show>
          <span class={`inboxrow__title ${unread() ? "inboxrow__title--bold" : ""}`}>
            {sessionTitle(s())}
          </span>
          <Show when={s().pinned}>
            <I.pin size={10} />
          </Show>
          <span class="inboxrow__time">
            {clockTime(Math.max(s().lastAt || 0, m().previewAt || 0, s().createdAt || 0))}
          </span>
        </span>
        <span class="inboxrow__sub">
          <span class={`dot dot--${dot()}`}>
            <Show when={dot() === "working"}>
              <i /><i /><i />
            </Show>
          </span>
          <span class="inboxrow__ctx">
            <Show when={s().cwd} fallback={<I.screen size={10} />}>
              <I.folder size={10} />
            </Show>
            {cwdLabel()}
          </span>
          <span class={`inboxrow__preview ${m().streaming ? "inboxrow__preview--live" : ""}`}>
            {m().streaming
              ? "Working…"
              : sessionPreview(m().preview) || sessionPreview(s().preview) || "No messages yet"}
          </span>
        </span>
      </span>
    </button>
  );
}

export function Inbox(props: { onOpen: (id: string) => void }) {
  const [searchOpen, setSearchOpen] = createSignal(false);
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
  const hiddenCount = createMemo(() => app.sessions.filter((s) => s.hidden).length);
  const host = () => app.hostInfo();
  const initial = () => (host()?.hostname || "R").slice(0, 1).toUpperCase();

  return (
    <div class="inbox">
      <div class="inbox__toolbar">
        <button
          class="inbox__avatbtn"
          title="Rig menu"
          onClick={() => app.setDrawerOpen(!app.drawerOpen())}
        >
          {initial()}
        </button>
        <span style={{ flex: 1 }} />
        <button
          class="circle-btn circle-btn--pill"
          title="Search"
          onClick={() => {
            setSearchOpen(!searchOpen());
            if (!searchOpen()) app.setQuery("");
          }}
        >
          <I.search size={16} />
        </button>
        <button class="circle-btn circle-btn--pill" title="New agent" onClick={() => app.setNewSheet(true)}>
          <I.plus size={19} />
        </button>
      </div>
      <Show when={searchOpen()}>
        <div class="inbox__searchrow">
          <I.search size={15} />
          <input
            placeholder="Search bots"
            value={app.query()}
            autofocus
            onInput={(e) => app.setQuery(e.currentTarget.value)}
          />
          <Show when={app.query()}>
            <button onClick={() => app.setQuery("")}>
              <I.x size={14} />
            </button>
          </Show>
        </div>
      </Show>
      <div class="inbox__list">
        <Show
          when={filtered().length}
          fallback={
            <div class="inbox__empty">
              <span class="inbox__emptytile">
                <Buddy k="remote" size={84} />
              </span>
              <p>No bots yet</p>
              <p class="inbox__emptysub">
                Tap + above — it works on your real computer,{"\n"}or pick a folder for repo work.
              </p>
            </div>
          }
        >
          <For each={filtered()}>{(s) => <Row s={s} onOpen={props.onOpen} />}</For>
        </Show>
      </div>
      <Show when={hiddenCount() && !app.showHidden()}>
        <button class="inbox__hiddenfoot" onClick={() => app.setShowHidden(true)}>
          <I.eye size={12} />
          {hiddenCount()} hidden thread{hiddenCount() === 1 ? "" : "s"} — tap to show
        </button>
      </Show>
      <Show when={app.showHidden() && hiddenCount()}>
        <button class="inbox__hiddenfoot" onClick={() => app.setShowHidden(false)}>
          <I.eyeOff size={12} />
          Hide hidden threads
        </button>
      </Show>
    </div>
  );
}
