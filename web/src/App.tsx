// App shell — boot/connect + global sheets; routes live in main.tsx.
import { useNavigate } from "@solidjs/router";
import { JSX, Show, createEffect, onMount } from "solid-js";
import { app, wireTick } from "./lib/store";
import { rig } from "./lib/rig";
import { Sheets } from "./components/Sheets";

export default function App(props: { children?: JSX.Element }) {
  const nav = useNavigate();
  // rig activity dips every buddy's gaze — the bots "noticed"
  let glanceT: any;
  createEffect(() => {
    if (wireTick() === 0) return;
    document.documentElement.classList.add("buddy-glance");
    clearTimeout(glanceT);
    glanceT = setTimeout(() => document.documentElement.classList.remove("buddy-glance"), 900);
  });
  onMount(async () => {
    const h = localStorage.getItem("rigHost");
    const p = parseInt(localStorage.getItem("rigPort") || "8790", 10) || 8790;
    // /?host=&port= deep-link, or remembered host — auto-connect
    const q = new URLSearchParams(location.search);
    const qh = q.get("host") || h || (location.port === "8790" ? location.hostname : null);
    if (qh) {
      await rig.loadToken(qh);
      if (rig.token) {
        app.resume();
        app.setConn("connecting");
        try {
          await rig.connect(qh, Number(q.get("port")) || p);
          rig.authed = true;
          app.setAuthed(true);
          app.setConn("connected");
          if (location.hash === "" || location.hash === "#/") nav("/home", { replace: true });
          return;
        } catch {}
      }
    }
    if (location.hash === "" || location.hash === "#/") nav("/", { replace: true });
  });

  return (
    <>
      {props.children}
      <Show when={app.toast()}>
        <div class="toast">{app.toast()}</div>
      </Show>
      <Sheets />
    </>
  );
}
