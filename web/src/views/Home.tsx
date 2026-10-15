// Home — the workspace: inbox rail | thread | screen panel.
// Mobile (<900px): single surface; /home shows rail, /thread/:id shows thread.
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { app } from "../lib/store";
import { Inbox } from "../components/Inbox";
import { Thread } from "../components/Thread";
import { ContextPanel } from "../components/ContextPanel";
import { Composer } from "../components/Composer";
import { Buddy } from "../components/Buddy";
import { Drawer } from "../components/Drawer";

export default function Home() {
  const params = useParams();
  const nav = useNavigate();
  const [wide, setWide] = createSignal(matchMedia("(min-width: 900px)").matches);
  const mq = matchMedia("(min-width: 900px)");
  const onMq = () => setWide(mq.matches);
  mq.addEventListener("change", onMq);
  onCleanup(() => mq.removeEventListener("change", onMq));

  createEffect(() => {
    const id = params.id;
    if (id && id !== app.activeId()) app.setActive(id);
  });

  const threadPane = (
    <Show
      when={app.activeId()}
      fallback={
        <div class="thread thread--empty">
          <div class="thread__hero">
            <span class="inbox__emptytile">
              <Buddy k="remote" size={84} />
            </span>
            <h2>DevBot</h2>
            <p class="thread__herosub">It works on your real computer.</p>
            <Composer onSent={() => {}} placeholder="Ask anything — the rig does the work" />
          </div>
        </div>
      }
    >
      <Thread id={app.activeId()!} />
    </Show>
  );

  return (
    <div class="shell">
      <Drawer />
      <Show when={wide() || !params.id}>
        <aside class="rail">
          <Inbox onOpen={(id) => nav(`/thread/${id}`)} />
        </aside>
      </Show>
      <Show when={wide() || !!params.id}>
        <main class="mainpane">
          {wide() ? (
            threadPane
          ) : (
            <Show when={params.id} fallback={threadPane}>
              <Thread id={params.id!} />
            </Show>
          )}
        </main>
      </Show>
      <Show when={app.screenPanel()}>
        <aside class="ctxpane">
          <ContextPanel />
        </aside>
      </Show>
    </div>
  );
}
