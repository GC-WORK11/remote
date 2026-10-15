// Screen — full-page live rig display: computer.watch stream, click/scroll/
// type/key injection while "in control", remote cursor overlay, window strip,
// record toggle. Port of mobile/src/app/screen.tsx.
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { rig, Frame } from "../lib/rig";
import { app } from "../lib/store";
import I from "../components/Icon";
import "./screen.css";

type Shot = { b64: string; w: number; h: number; ms?: number };

const fmtRec = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function Screen() {
  const nav = useNavigate();
  const [state, setState] = createSignal<any>(null);
  const [shot, setShot] = createSignal<Shot | null>(null);
  const [cursor, setCursor] = createSignal<{ x: number; y: number } | null>(null);
  const [windows, setWindows] = createSignal<any[]>([]);
  const [watchId, setWatchId] = createSignal<string | null>(null);
  const [watchDisp, setWatchDisp] = createSignal<string | null>(null);
  const [inputErr, setInputErr] = createSignal<string | null>(null);
  const [controlling, setControlling] = createSignal(false);
  const [typeText, setTypeText] = createSignal("");
  const [fps, setFps] = createSignal(0);
  const [recId, setRecId] = createSignal<string | null>(null);
  const [recElapsed, setRecElapsed] = createSignal(0);
  const [box, setBox] = createSignal({ w: 0, h: 0 });
  let recStart = 0;
  let frames = 0;
  let stage: HTMLDivElement | undefined;
  let wheelAcc = 0;
  let lastWheel = 0;

  const disp = () => (watchDisp() ? { display: watchDisp() } : {});
  const takeShot = (f: Frame) => {
    setShot({ b64: f.imageBase64, w: f.width, h: f.height, ms: f.tookMs });
    if (f.windows) setWindows(f.windows);
    if (f.cursor) setCursor({ x: f.cursor.x, y: f.cursor.y });
  };

  createEffect(() => {
    if (app.conn() !== "connected") return;
    rig.trySend({ type: "computer.state" });
    rig.trySend({ type: "computer.screenshot", scale: 0.6 });
    rig.trySend({ type: "computer.watch", intervalMs: 250, threshold: 1, scale: 0.6, format: "jpg", quality: 60 });
    rig.trySend({ type: "computer.record.list" }); // adopt a recording in progress
    rig.trySend({ type: "computer.windows" });
    const poll = setInterval(() => rig.trySend({ type: "computer.cursor" }), 2500);
    const winPoll = setInterval(() => rig.trySend({ type: "computer.windows" }), 8000);
    const meter = setInterval(() => {
      setFps(frames);
      frames = 0;
    }, 1000);
    const off = rig.onFrame((f: Frame) => {
      if (f.type === "computer.state") {
        setState(f);
        if (f.display) setWatchDisp(f.display);
      }
      if (f.type === "computer.watching") {
        setWatchId(f.watchId);
        if (f.display) setWatchDisp(f.display);
      }
      // input replies are per-client — ok:false means the tap/type didn't land
      if (f.type === "ok" && typeof f.action === "string")
        setInputErr(f.ok === false ? f.detail || f.error || "input didn't land" : null);
      if (f.type === "computer.frame") frames++;
      if (f.type === "computer.frame" || f.type === "computer.screenshot" || f.type === "computer.observe") takeShot(f);
      if (f.type === "computer.windows") setWindows(f.windows || []);
      if (f.type === "computer.cursor" && typeof f.x === "number") setCursor({ x: f.x, y: f.y });
      if (f.type === "computer.unwatched" || f.type === "computer.watch_error") setWatchId(null);
      // start ack has no `path`/`format` — get/meta and mp4 replies do
      if (f.type === "computer.recording" && !f.path && !f.format) {
        recStart = f.startedAt || Date.now();
        setRecId(f.id);
        setRecElapsed(0);
      }
      if (f.type === "computer.recorded" || f.type === "computer.record.finished") setRecId(null);
      if (f.type === "computer.recordings") {
        const live = (f.recordings || []).find((r: any) => r.live);
        if (live) {
          recStart = live.startedAt;
          setRecId(live.id);
          setRecElapsed(Math.max(0, Date.now() - live.startedAt));
        }
      }
      // "already recording" error — adopt the in-flight recording
      if (f.type === "error" && f.recordingId) {
        if (!recStart) recStart = Date.now();
        setRecId(f.recordingId);
      }
    });
    onCleanup(() => {
      off();
      clearInterval(poll);
      clearInterval(winPoll);
      clearInterval(meter);
      rig.trySend({ type: "computer.unwatch" });
    });
  });

  // non-passive wheel listener + stage size for letterbox math / cursor overlay
  onMount(() => {
    const el = stage!;
    const size = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(size);
    ro.observe(el);
    size();
    onCleanup(() => {
      el.removeEventListener("wheel", onWheel);
      ro.disconnect();
    });
  });

  // elapsed ticker for the REC pill — reset happens in the frame handler
  createEffect(() => {
    if (!recId()) return;
    const iv = setInterval(() => setRecElapsed(Math.max(0, Date.now() - recStart)), 500);
    onCleanup(() => clearInterval(iv));
  });

  // map a stage-local point into shot pixels, accounting for letterbox offsets
  const shotPoint = (lx: number, ly: number) => {
    const s = shot();
    const r = stage?.getBoundingClientRect();
    if (!s || !r || !r.width) return null;
    const k = Math.min(r.width / s.w, r.height / s.h);
    const x = Math.round((lx - (r.width - s.w * k) / 2) / k);
    const y = Math.round((ly - (r.height - s.h * k) / 2) / k);
    if (x < 0 || y < 0 || x > s.w || y > s.h) return null;
    return { x, y };
  };
  const stagePoint = (e: MouseEvent | WheelEvent) => {
    const r = stage?.getBoundingClientRect();
    return r ? shotPoint(e.clientX - r.left, e.clientY - r.top) : null;
  };

  const cursorPos = () => {
    const s = shot();
    const c = cursor();
    const b = box();
    if (!s || !c || !b.w) return null;
    const k = Math.min(b.w / s.w, b.h / s.h);
    return { left: `${(b.w - s.w * k) / 2 + c.x * k - 5}px`, top: `${(b.h - s.h * k) / 2 + c.y * k - 5}px` };
  };

  const tapShot = (e: MouseEvent) => {
    if (!controlling()) return;
    const p = stagePoint(e);
    if (!p) return;
    rig.trySend({ type: "computer.click", x: p.x, y: p.y, shotW: shot()!.w, shotH: shot()!.h, ...disp() });
  };

  // wheel → remote scroll, throttled to ~80 ms like the mobile pan ticks
  const sendScroll = (dir: "up" | "down", e: WheelEvent) => {
    const p = stagePoint(e);
    rig.trySend({
      type: "computer.scroll",
      direction: dir,
      times: 1,
      ...disp(),
      ...(p ? { x: p.x, y: p.y, shotW: shot()!.w, shotH: shot()!.h } : {}),
    });
  };
  const onWheel = (e: WheelEvent) => {
    if (!controlling()) return;
    e.preventDefault();
    wheelAcc += e.deltaY;
    const now = Date.now();
    if (now - lastWheel < 80 || wheelAcc === 0) return;
    lastWheel = now;
    sendScroll(wheelAcc > 0 ? "down" : "up", e);
    wheelAcc = 0;
  };

  const sendType = () => {
    const t = typeText();
    if (!t) return;
    rig.trySend({ type: "computer.type", text: t, ...disp() });
    setTypeText("");
  };
  const sendKey = (combo: string) => rig.trySend({ type: "computer.key", combo, ...disp() });

  const toggleRec = () => {
    rig.trySend(
      recId()
        ? { type: "computer.record.stop", id: recId() }
        : { type: "computer.record.start", intervalMs: 250, scale: 0.5 }
    );
  };

  const permsOk = () => (state()?.perms ? state().perms.capture && state().perms.inject : null);
  const metaLine = () => {
    const r = state()?.resolution;
    const c = cursor();
    return (
      (state()?.hostname || app.hostInfo()?.hostname || "rig") +
      (r ? ` · ${r.width || r[0] || "?"}×${r.height || r[1] || "?"}` : "") +
      (c ? ` · ptr ${c.x},${c.y}` : "") +
      (fps() > 0 ? ` · ${fps()}f/s` : "")
    );
  };

  return (
    <div class="screenview">
      <div class="screenview__head">
        <div class="screenview__titles">
          <div class="screenview__title">Screen</div>
          <div class="screenview__sub">
            {app.hostInfo()?.hostname ? `${app.hostInfo()!.hostname} · ${state()?.backend || "native"} display` : "live rig display"}
          </div>
        </div>
        <span class={`screenview__live ${watchId() ? "" : "screenview__live--off"}`}>
          <Show when={watchId()}>
            <span class="screenview__livedot" />
          </Show>
          {watchId() ? "Live" : "Paused"}
        </span>
      </div>

      {/* Stage — letterboxed live view; clicks/wheel forward while controlling */}
      <div ref={stage} class={`screenview__stage ${controlling() ? "screenview__stage--ctrl" : ""}`} onClick={tapShot}>
        <Show
          when={shot()}
          fallback={
            <div class="screenview__wait">
              <I.screen size={34} />
              <div>Connecting to the rig's display…</div>
              <Show when={permsOk() === false}>
                <div class="screenview__waitwarn">Screen Recording / Accessibility permission missing on the host</div>
              </Show>
            </div>
          }
        >
          <img src={`data:image/jpeg;base64,${shot()!.b64}`} alt="rig screen" draggable={false} />
        </Show>
        <Show when={cursorPos()}>
          <span class="screenview__cursor" style={cursorPos()!} />
        </Show>
        <div class={`screenview__status ${controlling() ? "screenview__status--ctrl" : ""}`}>
          <span class="screenview__statusdot" />
          {controlling() ? "You're in control" : "omp has control"}
        </div>
        <Show when={recId()}>
          <button class="screenview__recchip" onClick={toggleRec} title="Stop recording">
            <span class="dot" />{fmtRec(recElapsed())}<span class="screenview__stopsq" />
          </button>
        </Show>
      </div>

      <div class="screenview__controls">
        <Show
          when={controlling()}
          fallback={
            <>
              <div class="screenview__meta">{metaLine()}</div>
              <button class="screenview__iconbtn" title="Recordings" onClick={() => nav("/recordings")}><I.play size={16} /></button>
              <button class={`screenview__recpill ${recId() ? "screenview__recpill--on" : ""}`} title={recId() ? "Stop recording" : "Start recording"} onClick={toggleRec}>
                <Show when={recId()} fallback={<I.rec size={14} />}>
                  <span class="dot" />{fmtRec(recElapsed())}<I.stop size={11} />
                </Show>
              </button>
              <button class="screenview__takeover" onClick={() => setControlling(true)}>
                <I.cursorFallback size={14} />Take over
              </button>
            </>
          }
        >
          <button class="screenview__takeover" onClick={() => setControlling(false)}>
            <I.x size={13} />I'm done
          </button>
          <div class="screenview__typerow">
            <input
              value={typeText()}
              onInput={(e) => setTypeText(e.currentTarget.value)}
              placeholder="type into the rig…"
              onKeyDown={(e) => e.key === "Enter" && sendType()}
            />
            <button class="screenview__send" title="Type into the rig" onClick={sendType}><I.zap size={16} /></button>
          </div>
          <button class="screenview__keybtn" onClick={() => sendKey("Return")}>Enter</button>
          <button class="screenview__keybtn" onClick={() => sendKey("Escape")}>Esc</button>
          <button class="screenview__keybtn" onClick={() => sendKey("Tab")}>Tab</button>
        </Show>
      </div>

      <Show when={inputErr()}>
        <p class="screenview__err">{inputErr()}</p>
      </Show>

      <Show when={windows().length}>
        <div class="screenview__wins">
          <div class="screenview__winslabel">WINDOWS ON THE RIG · {windows().length}</div>
          <div class="screenview__winlist">
            <For each={windows().slice(0, 12)}>
              {(w) => (
                <button
                  class={`screenview__win ${w.active ? "screenview__win--active" : ""}`}
                  title={controlling() ? "Focus on the rig" : w.title || "(untitled)"}
                  onClick={() => controlling() && rig.trySend({ type: "computer.window.activate", id: w.id })}
                >
                  <span class="screenview__windot" />
                  <span class="screenview__wintitle">{w.title || "(untitled)"}</span>
                  <span class="screenview__windims">{w.w}×{w.h}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
