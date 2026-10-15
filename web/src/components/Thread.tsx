// Thread — the session view: virtualized transcript, streaming bubble,
// working row, approvals, composer, header actions.
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { VList } from "virtua/solid";
import { app, sessionTitle } from "../lib/store";
import { rig, tilde } from "../lib/rig";
import { engineFor, ChatEngine, Row, findPrUrl } from "../lib/chat";
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
  const [subsOpen, setSubsOpen] = createSignal(true);
  const children = createMemo(() => app.sessions.filter((s) => s.parentId === props.id));

  const streaming = () => engine().streaming() || (!!meta().streaming && !meta().dead);

  // mobile parity: prog/event/check filtered, consecutive agent rows merge
  const dispRows = createMemo(() => {
    const out: Row[] = [];
    for (const r of engine().rows) {
      if (r.kind === "prog" || r.kind === "event") continue;
      const last = out[out.length - 1];
      if (r.kind === "agent" && last?.kind === "agent" && !r.streaming && !last.streaming) {
        last.text = `${last.text || ""}\n\n${r.text || ""}`.trim();
        continue;
      }
      out.push(r.kind === "agent" ? { ...r } : r);
    }
    return out;
  });

  // PR surfaced in the transcript → footer card + merge pill
  const prUrl = createMemo(() => {
    const agents = dispRows().filter((r) => r.kind === "agent" && r.text);
    for (let i = agents.length - 1; i >= 0; i--) {
      const u = findPrUrl(agents[i].text!);
      if (u) return u;
    }
    return null;
  });

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
          class="circle-btn circle-btn--pill thread__back"
          onClick={() => {
            location.hash = "#/home";
          }}
          title="Inbox"
        >
          <I.chevL size={17} />
        </button>
        <button class="namepill" onClick={() => app.setSessionSheetId(props.id)}>
          <Buddy k={props.id} size={22} />
          <span class="namepill__col">
            <span class="namepill__title">
              {session() ? sessionTitle(session()!) : "…"}
              <Show when={streaming()}>
                <span class="namepill__dot" />
              </Show>
            </span>
            <span class="namepill__sub">
              {session() ? tilde(session()!.cwd) || "~/rig" : "~/rig"}
            </span>
          </span>
          <I.chevD size={13} />
        </button>
        <div class="thread__actions">
          <Show when={meta().hibernated}>
            <span class="pill pill--outline">asleep</span>
          </Show>
          <button class="circle-btn circle-btn--pill" title="Screen" onClick={() => app.setScreenPanel(!app.screenPanel())}>
            <I.screen size={16} />
          </button>
        </div>
      </header>
      <div class="toolstrip">
        <Show when={session()?.branch || session()?.cwd}>
          <span class="toolstrip__branch">
            <I.branch size={11} />
            {session()?.branch || tilde(session()?.cwd)}
          </span>
        </Show>
        <button class="toolpill" onClick={() => (location.hash = "#/files")}><I.folder size={12} />Files</button>
        <button class="toolpill" onClick={() => (location.hash = "#/terminal")}><I.terminal size={12} />Terminal</button>
        <button class="toolpill" onClick={() => (location.hash = "#/browser")}><I.globe size={12} />Browser</button>
        <button class="toolpill" onClick={() => (location.hash = "#/repos")}><I.book size={12} />Repos</button>
      </div>
      <Show when={children().length}>
        <div class="subagents">
          <button class="subagents__head" onClick={() => setSubsOpen(!subsOpen())}>
            <Show when={subsOpen()} fallback={<I.chevR size={11} />}>
              <I.chevD size={11} />
            </Show>
            <span>SUB-AGENTS · {children().length}</span>
            <span style={{ flex: 1 }} />
            <Show when={children().some((c) => app.meta[c.id]?.streaming || c.busy)}>
              <span class="subagents__busy" />
            </Show>
            <button
              class="subagents__add"
              title="New sub-agent"
              onClick={(e) => {
                e.stopPropagation();
                app.setSpawnParent(props.id);
              }}
            >
              <I.plus size={14} />
            </button>
          </button>
          <Show when={subsOpen()}>
            <For each={children()}>
              {(c) => {
                const cm = () => app.meta[c.id] || {};
                const st = () =>
                  cm().streaming || c.busy ? "Working" : cm().dead ? "Ended" : cm().done ? "Idle" : "Idle";
                return (
                  <button class="subrow" onClick={() => (location.hash = `#/thread/${c.id}`)}>
                    <Buddy k={c.id} size={22} />
                    <span class="subrow__body">
                      <span class="subrow__title">{sessionTitle(c)}</span>
                      <span class={`subrow__sub ${st() === "Working" ? "subrow__sub--live" : ""}`}>
                        {st()}
                      </span>
                    </span>
                    <span class="subrow__status">{st()}</span>
                  </button>
                );
              }}
            </For>
          </Show>
        </div>
      </Show>
      <div class="thread__scroll" ref={scrollerRef} onScroll={onScroll}>
        <Show when={engine().historyLoading()}>
          <div class="thread__histload">
            <span class="spinner" /> Loading earlier…
          </div>
        </Show>
        <VList class="thread__list" data={dispRows()}>
          {(row, i) => (
            <RowView
              row={row}
              prev={i() > 0 ? dispRows()[i() - 1] : undefined}
              next={i() < dispRows().length - 1 ? dispRows()[i() + 1] : undefined}
              respond={(id, ok) => engine().respondApproval(id, ok)}
            />
          )}
        </VList>
        <Show when={streaming()}>
          <Show
            when={engine().streamText()}
            fallback={
              <div class="workingrow">
                <span class="minidots">
                  <i /><i /><i />
                </span>
                <span class="workingrow__label workingrow__shimmer">
                  {buddyName(props.id)} is working
                  <Show when={engine().status()}> · {engine().status()}</Show>
                  <Show when={engine().workSec()}> · {engine().workSec()}s</Show>
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
      <Show when={prUrl()}>
        <div class="prfoot">
          <button
            class="prfoot__card"
            onClick={() => (location.hash = `#/pr?url=${encodeURIComponent(prUrl()!)}&sid=${props.id}`)}
          >
            <I.branch size={15} />
            <span class="prfoot__title">{prUrl()!.replace(/^https?:\/\//, "").split("/").slice(-3).join("/")}</span>
            <span class="prfoot__state">Open</span>
          </button>
          <button class="mergepill" onClick={() => app.setMergeSheetUrl(prUrl()!)}>
            <I.check size={12} /> Ready to merge <I.chevD size={11} style={{ transform: "rotate(180deg)" }} />
          </button>
        </div>
      </Show>
      <Composer engine={engine()} placeholder={session()?.cwd ? "Send follow-up" : `Ask ${buddyName(props.id)}`} />
    </div>
  );
}
