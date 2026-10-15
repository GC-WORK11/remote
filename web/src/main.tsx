/* @refresh reload */
import { render } from "solid-js/web";
import { HashRouter, Route } from "@solidjs/router";
import { lazy } from "solid-js";
import App from "./App";
import Connect from "./views/Connect";
import Home from "./views/Home";
import "./styles.css";

import { useNavigate } from "@solidjs/router";
import { JSX } from "solid-js";
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
const framed = (C: () => JSX.Element) => () => (
  <FrameView>
    <C />
  </FrameView>
);

render(
  () => (
    <HashRouter root={App}>
      <Route path="/" component={Connect} />
      <Route path="/home" component={Home} />
      <Route path="/thread/:id" component={Home} />
      <Route path="/terminal" component={framed(Terminal)} />
      <Route path="/screen" component={framed(Screen)} />
      <Route path="/recordings" component={framed(Recordings)} />
      <Route path="/files" component={framed(Files)} />
      <Route path="/file" component={framed(FileView)} />
      <Route path="/repos" component={framed(Repos)} />
      <Route path="/browser" component={framed(Browser)} />
      <Route path="/pr" component={framed(Pr)} />
    </HashRouter>
  ),
  document.getElementById("root")!
);
