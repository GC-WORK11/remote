// Thread — the session view: virtualized transcript, streaming bubble,
// working row, approvals, composer, header actions.
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { VList } from "virtua/solid";
import { app, sessionTitle } from "../lib/store";
import { rig } from "../lib/rig";
import { engineFor, ChatEngine } from "../lib/chat";
import { RowView } from "./RowView";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { Buddy, buddyName } from "./Buddy";
import I from "./Icon";

export function Thread(props: { id: string }) {
  const engine = createMemo(() => engineFor(props.id));
  const session = createMemo(() => app.sessions.find((s) => s.id === props.id));
  const meta = createMemo(() => app.meta[props.id] || {});
  let scrollerRef: HTMLDivElement | undefined;
  const [atBottom, setAtBottom] = createSignal(true);

  const streaming = () => engine().streaming() || (!!meta().streaming && !meta().dead);

  // stick to bottom while reading live output
  const scrollBottom = (smooth = false) => {
    scrollerRef?.scrollTo({ top: scrollerRef.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  createEffect(() => {
    engine().rows.length;
    engine().streamText();
    if (atBottom()) queueMicrotask(() => scrollBottom());
  });
  const onScroll = () => {
    const el = scrollerRef;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
    if (el.scrollTop < 80) engine().loadOlder();
  };

  // mark read
  createEffect(() => {
    const ms = engine().maxSeq();
    if (ms && app.conn() === "connected")
      try {
        rig.sessionMeta(props.id, { lastReadSeq: ms });
      } catch {}
  });

  onMount(() => scrollBottom());

  return (
    <div class="thread">
      <header class="thread__bar">
        <button
          class="circle-btn thread__back"
          onClick={() => {
            location.hash = "#/home";
          }}
          title="Inbox"
        >
          <I.chevL size={17} />
        </button>
        <div class="thread__title" onClick={() => app.setSessionSheetId(props.id)}>
          <Buddy k={props.id} size={26} />
          <span class="thread__name">{session() ? sessionTitle(session()) : "…"}</span>
          <Show when={meta().model || engine().model()}>
            <span class="thread__model">{meta().model || engine().model()}</span>
          </Show>
        </div>
        <div class="thread__actions">
          <Show when={meta().hibernated}>
            <span class="pill pill--outline">asleep</span>
          </Show>
          <button class="circle-btn" title="Screen" onClick={() => app.setScreenPanel(!app.screenPanel())}>
            <I.screen size={16} />
          </button>
          <button class="circle-btn" title="Session" onClick={() => app.setSessionSheetId(props.id)}>
            <I.settings size={16} />
          </button>
        </div>
      </header>
      <div class="thread__scroll" ref={scrollerRef} onScroll={onScroll}>
        <Show when={engine().historyLoading()}>
          <div class="thread__histload">
            <span class="spinner" /> Loading earlier…
          </div>
        </Show>
        <VList class="thread__list" data={engine().rows}>
          {(row) => (
            <RowView row={row} respond={(id, ok) => engine().respondApproval(id, ok)} />
          )}
        </VList>
        <Show when={streaming()}>
          <Show
            when={engine().streamText()}
            fallback={
              <div class="workingrow">
                <Buddy k={props.id} size={20} />
                <span class="workingrow__label">
                  {buddyName(props.id)} is working
                </span>
                <span class="workingrow__detail">
                  {engine().status()}
                  {engine().workSec() ? ` · ${engine().workSec()}s` : ""}
                </span>
              </div>
            }
          >
            <div class="row-in row-agent">
              <div class="bubble bubble--agent bubble--live">
                <Markdown text={engine().streamText()} />
                <span class="caret" />
              </div>
            </div>
          </Show>
        </Show>
        <Show when={engine().computerActive()}>
          <button class="jobcard" onClick={() => app.setScreenPanel(true)}>
            <I.computer size={16} />
            <span>Working on the rig's screen — watch live</span>
            <I.chevR size={14} />
          </button>
        </Show>
      </div>
      <Show when={!atBottom()}>
        <button class="jumptolatest" onClick={() => scrollBottom(true)}>
          <I.chevD size={14} /> Latest
        </button>
      </Show>
      <Composer engine={engine()} placeholder="Message…" />
    </div>
  );
}
