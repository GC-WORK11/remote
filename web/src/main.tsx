/* @refresh reload */
import { render } from "solid-js/web";
import { HashRouter } from "@solidjs/router";
import App from "./App";
import "./styles.css";

render(() => <HashRouter root={App} />, document.getElementById("root")!);
