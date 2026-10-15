// App shell — routes + 3-pane workspace + global sheets + boot/connect.
import { Route, useNavigate } from "@solidjs/router";
import { JSX, Show, createEffect, lazy, onMount } from "solid-js";
import { app } from "./lib/store";
import { rig } from "./lib/rig";
import Connect from "./views/Connect";
import Home from "./views/Home";
import { Sheets } from "./components/Sheets";
import I from "./components/Icon";

const Terminal = lazy(() => import("./views/Terminal"));
const Screen = lazy(() => import("./views/Screen"));
const Recordings = lazy(() => import("./views/Recordings"));
const Files = lazy(() => import("./views/Files"));
const FileView = lazy(() => import("./views/FileView"));
const Repos = lazy(() => import("./views/Repos"));
const Browser = lazy(() => import("./views/Browser"));
const Pr = lazy(() => import("./views/Pr"));

function FrameView(props: { children: JSX.Element }) {
  const nav = useNavigate();
  return (
    <div class="pageview">
      <header class="pageview__bar">
        <button class="circle-btn" onClick={() => nav("/home")} title="Back to inbox">
          <I.chevL size={17} />
        </button>
      </header>
      {props.children}
    </div>
  );
}

export default function App(props: { children?: JSX.Element }) {
  const nav = useNavigate();
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
      <Route path="/" component={Connect} />
      <Route path="/home" component={Home} />
      <Route path="/thread/:id" component={Home} />
      <Route path="/terminal" component={() => <FrameView><Terminal /></FrameView>} />
      <Route path="/screen" component={() => <FrameView><Screen /></FrameView>} />
      <Route path="/recordings" component={() => <FrameView><Recordings /></FrameView>} />
      <Route path="/files" component={() => <FrameView><Files /></FrameView>} />
      <Route path="/file" component={() => <FrameView><FileView /></FrameView>} />
      <Route path="/repos" component={() => <FrameView><Repos /></FrameView>} />
      <Route path="/browser" component={() => <FrameView><Browser /></FrameView>} />
      <Route path="/pr" component={() => <FrameView><Pr /></FrameView>} />
      {props.children}
      <Show when={app.toast()}>
        <div class="toast">{app.toast()}</div>
      </Show>
      <Sheets />
    </>
  );
}
