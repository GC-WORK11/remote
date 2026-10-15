// Browser — a window into whatever is served on the rig.
// Port of mobile/src/app/code/browser.tsx: same toUrl() normalization
// ("3000" → http://rig:3000), same iframe embed the mobile web build used,
// plus rig.hostOpen() to open the page on the rig's own display.
// Route: #/browser?url=…  — recents persist in localStorage.
import { createSignal, Show, For } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { rig } from "../lib/rig";
import { app } from "../lib/store";
import I from "../components/Icon";
import "./codeviews.css";

// "3000", ":3000", "localhost:3000", "example.com" → loadable http(s) URL
// rooted at the rig's own host. Explicit http(s):// URLs pass through.
function toUrl(input: string, rigHost: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const portOnly = s.match(/^:?(\d{2,5})$/);
  if (portOnly) return `http://${rigHost}:${portOnly[1]}`;
  s = s.replace(/^localhost:/, `${rigHost}:`).replace(/^127\.0\.0\.1:/, `${rigHost}:`);
  return `http://${s}`;
}

const RECENTS_KEY = "rigBrowserRecent";
const loadRecents = (): string[] => {
  try {
    const j = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(j) ? j.filter((x) => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
};

export default function Browser() {
  const [params] = useSearchParams();
  const host = rig.host || location.hostname;
  const [url, setUrl] = createSignal(
    toUrl(String((params as any).url || ""), host) || `http://${host}:3000`
  );
  const [bar, setBar] = createSignal(String((params as any).url || ""));
  const [loaded, setLoaded] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [recents, setRecents] = createSignal<string[]>(loadRecents());
  let frame: HTMLIFrameElement | undefined;
  const connected = () => app.conn() === "connected";

  const remember = (u: string) => {
    const next = [u, ...recents().filter((r) => r !== u)].slice(0, 8);
    setRecents(next);
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {}
  };

  const go = (raw?: string) => {
    const next = toUrl(raw ?? bar() ?? "", host) || toUrl(url(), host);
    if (!next) return;
    setLoaded(false);
    setFailed(false);
    setUrl(next);
    setBar(next.replace(/^https?:\/\//, ""));
    remember(next);
  };

  const reload = () => {
    setLoaded(false);
    setFailed(false);
    try {
      frame?.contentWindow?.location.reload();
    } catch {
      // cross-origin — re-assigning src reloads the frame anyway
      if (frame) frame.src = url();
    }
  };

  const openOnRig = () => {
    try {
      rig.hostOpen(url(), app.hostInfo()?.os);
      app.showToast("Opening on the rig's display…");
    } catch (e: any) {
      app.showToast(e?.message || "not connected");
    }
  };

  const copy = () => navigator.clipboard?.writeText(url()).then(() => app.showToast("URL copied")).catch(() => {});

  return (
    <div class="cv browserview">
      <div class="cv__bar">
        <div class="browser__addr">
          <I.globe size={13} />
          <input
            value={bar()}
            onInput={(e) => setBar(e.currentTarget.value)}
            placeholder={url().replace(/^https?:\/\//, "")}
            autocapitalize="none"
            autocomplete="off"
            autocorrect="off"
            spellcheck={false}
            inputmode="url"
            onKeyDown={(e) => e.key === "Enter" && go()}
          />
          <button class="cv__iconbtn" onClick={() => go()} title="Go" disabled={!bar().trim()}>
            <I.arrowR size={14} />
          </button>
        </div>
        <button class="circle-btn" title="Reload" onClick={reload}>
          <I.restart size={14} />
        </button>
        <button class="circle-btn" title="Copy URL" onClick={copy}>
          <I.copy size={14} />
        </button>
        <button class="circle-btn" title="Open on the rig's display" onClick={openOnRig} disabled={!connected()}>
          <I.computer size={15} />
        </button>
      </div>

      <Show when={recents().length > 1}>
        <div class="browser__recents">
          <For each={recents()}>
            {(r) => (
              <button class="browser__recent" onClick={() => go(r)} title={r}>
                <I.globe size={11} />
                {r.replace(/^https?:\/\//, "")}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="browser__web">
        <Show when={connected()}>
          <iframe
            ref={frame}
            src={url()}
            onLoad={() => setLoaded(true)}
            // browsers don't fire error reliably — the failed state is best-effort
            onError={() => {
              setLoaded(true);
              setFailed(true);
            }}
            title="rig browser"
            allow="clipboard-read; clipboard-write"
          />
        </Show>
        <Show when={connected() && !loaded()}>
          <div class="browser__cover">
            <span class="browser__dot" />
            <span>{url().replace(/^https?:\/\//, "")}</span>
          </div>
        </Show>
        <Show when={!connected() || failed()}>
          <div class="browser__cover">
            <I.globe size={26} />
            <span>{connected() ? "Couldn't reach that page" : "Not connected"}</span>
            <span class="cv__emptysub">
              {connected()
                ? "A port or address on the rig — e.g. 3000 or localhost:8080"
                : "Pair with your rig first"}
            </span>
          </div>
        </Show>
      </div>
    </div>
  );
}
