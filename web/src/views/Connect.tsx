// Connect — pair to a rig: manual host:port + 6-digit code, or paste a
// remote:// link. Same-origin (served by omprd --www) auto-probes the host.
import { createSignal, onMount } from "solid-js";
import { rig, parseRigUri } from "../lib/rig";
import { app } from "../lib/store";
import { Mascot } from "../components/Mascot";
import I from "../components/Icon";

export default function Connect() {
  const [host, setHost] = createSignal("");
  const [port, setPort] = createSignal("8790");
  const [code, setCode] = createSignal("");
  const [link, setLink] = createSignal("");
  const [phase, setPhase] = createSignal<"idle" | "connecting" | "pairing" | "error">("idle");
  const [err, setErr] = createSignal("");
  const [deviceName] = createSignal(`web-${navigator.platform || "browser"}`.slice(0, 24));

  onMount(async () => {
    // Served by omprd? The daemon exposes GET /diag JSON on the same origin.
    const same = await rig.probe(location.hostname, Number(location.port) || 8790);
    if (same?.ok) setHost(location.hostname);
    const saved = localStorage.getItem("rigHost");
    if (saved) setHost(saved);
    const sp = localStorage.getItem("rigPort");
    if (sp) setPort(sp);
    // returning device — token on file, straight in
    if (rig.token) {
      await connectWithToken();
    }
  });

  const fail = (m: string) => {
    setErr(m);
    setPhase("error");
  };

  async function connectWithToken() {
    setPhase("connecting");
    try {
      await rig.connect(host(), Number(port()) || 8790);
      app.resume();
      location.hash = "#/home";
    } catch (e: any) {
      fail(e?.message || "Can't reach the rig — check host/port");
    }
  }

  async function pairWithCode() {
    setPhase("pairing");
    try {
      await rig.connect(host(), Number(port()) || 8790);
      await rig.pair(code().trim(), deviceName());
      app.resume();
      app.setAuthed(true);
      location.hash = "#/home";
    } catch (e: any) {
      fail(e?.message || "Pairing failed — check the code on your rig");
    }
  }

  async function pairWithLink() {
    const p = parseRigUri(link());
    if (!p?.host) return fail("That doesn't look like a remote:// link");
    setHost(p.host);
    if (p.port) setPort(String(p.port));
    setPhase("connecting");
    try {
      await rig.connect(p.host, p.port || 8790);
      if (p.code) {
        setPhase("pairing");
        await rig.pair(p.code, deviceName());
        app.setAuthed(true);
      }
      app.resume();
      location.hash = "#/home";
    } catch (e: any) {
      fail(e?.message || "Can't connect to that link");
    }
  }

  return (
    <div class="connect">
      <div class="connect__card card">
        <Mascot size={92} color="gold" state={phase() === "pairing" ? "peek" : "idle"} />
        <h1>Remote</h1>
        <p class="connect__tag">Your laptop is the computer. This browser is the remote.</p>
        <div class="connect__form">
          <label>Rig address</label>
          <div class="connect__hostrow">
            <input
              value={host()}
              onInput={(e) => setHost(e.currentTarget.value.trim())}
              placeholder="100.x.y.z or laptop.local"
              autocomplete="off"
              spellcheck={false}
            />
            <input
              class="connect__port"
              value={port()}
              onInput={(e) => setPort(e.currentTarget.value.trim())}
              placeholder="8790"
              inputmode="numeric"
            />
          </div>
          <label>Pairing code <span class="connect__hint">(shown by <code>omprd --qr</code> or <code>ompr pair</code>)</span></label>
          <input
            value={code()}
            onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="6-digit code"
            inputmode="numeric"
            class="connect__code"
            onKeyDown={(e) => e.key === "Enter" && code().length >= 4 && pairWithCode()}
          />
          <button
            class="btn-primary"
            disabled={!host() || phase() === "connecting" || phase() === "pairing"}
            onClick={() => (code().length >= 4 ? pairWithCode() : connectWithToken())}
          >
            {phase() === "connecting" ? "Connecting…" : phase() === "pairing" ? "Pairing…" : code().length >= 4 ? "Pair" : "Connect"}
          </button>
          {err() && <p class="connect__err">{err()}</p>}
          <details class="connect__alt">
            <summary>Have a remote:// link?</summary>
            <textarea
              value={link()}
              onInput={(e) => setLink(e.currentTarget.value)}
              placeholder="remote://pair?host=100.x.y.z:8790#123456"
              rows={2}
            />
            <button class="btn-secondary" onClick={pairWithLink} disabled={!link().trim()}>
              Connect from link
            </button>
          </details>
        </div>
      </div>
    </div>
  );
}
