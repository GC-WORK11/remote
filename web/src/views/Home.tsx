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
            <Buddy k="remote" size={110} />
            <h2>Your rig, from anywhere</h2>
            <p class="thread__herosub">Pick a thread — or just say what to do.</p>
            <Composer onSent={() => {}} placeholder="Ask anything — the rig does the work" />
          </div>
        </div>
      }
    >
      <Thread id={app.activeId()!} />
    </Show>
  );

  return (
    <div class={`shell ${app.drawerOpen() ? "shell--drawer" : ""}`}>
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
