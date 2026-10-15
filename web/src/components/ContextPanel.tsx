// ContextPanel — live screen mirror in the right rail: watch stream,
// click/scroll/type injection, cursor, record toggle.
import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { rig, Frame } from "../lib/rig";
import { app } from "../lib/store";
import I from "./Icon";

interface Shot {
  b64: string;
  w: number;
  h: number;
  ms?: number;
}

export function ContextPanel() {
  const [shot, setShot] = createSignal<Shot | null>(null);
  const [cursor, setCursor] = createSignal<{ x: number; y: number } | null>(null);
  const [watching, setWatching] = createSignal(false);
  const [state, setState] = createSignal<any>(null);
  const [recording, setRecording] = createSignal<string | null>(null);
  const [typeText, setTypeText] = createSignal("");
  const [control, setControl] = createSignal(false);
  let box: HTMLDivElement | undefined;
  let off: (() => void) | null = null;

  const start = () => {
    off?.();
    off = rig.onFrame((f: Frame) => {
      if (f.type === "computer.state") setState(f);
      if (f.type === "computer.watching") setWatching(true);
      if (f.type === "computer.frame" || f.type === "computer.screenshot" || f.type === "computer.observe") {
        if (typeof f.imageBase64 === "string")
          setShot({ b64: f.imageBase64, w: f.width || 0, h: f.height || 0, ms: f.tookMs });
        if (f.cursor) setCursor({ x: f.cursor.x, y: f.cursor.y });
      }
      if (f.type === "computer.cursor" && typeof f.x === "number") setCursor({ x: f.x, y: f.y });
      if (f.type === "computer.unwatched" || f.type === "computer.watch_error") setWatching(false);
      if (f.type === "computer.recording" && f.id) setRecording(f.id);
      if (f.type === "computer.recorded" || f.type === "computer.record.finished") setRecording(null);
    });
    rig.trySend({ type: "computer.state" });
    rig.trySend({ type: "computer.screenshot", scale: 0.5 });
    rig.trySend({ type: "computer.watch", intervalMs: 400, threshold: 1, scale: 0.5, format: "jpg", quality: 55 });
    rig.trySend({ type: "computer.cursor" });
  };

  onMount(start);
  onCleanup(() => {
    off?.();
    rig.trySend({ type: "computer.unwatch" });
  });
  // wake on reopen
  createEffect(() => {
    if (app.screenPanel() && !off) start();
  });

  const shotPoint = (e: MouseEvent) => {
    const s = shot();
    if (!s || !box) return null;
    const r = box.getBoundingClientRect();
    const scale = Math.min(r.width / s.w, r.height / s.h);
    const dw = s.w * scale;
    const dh = s.h * scale;
    const ox = (r.width - dw) / 2;
    const oy = (r.height - dh) / 2;
    const x = Math.round((e.clientX - r.left - ox) / scale);
    const y = Math.round((e.clientY - r.top - oy) / scale);
    if (x < 0 || y < 0 || x > s.w || y > s.h) return null;
    return { x, y };
  };

  const click = (e: MouseEvent) => {
    if (!control()) return;
    const p = shotPoint(e);
    if (!p) return;
    rig.trySend({ type: "computer.click", x: p.x, y: p.y, shotW: shot()!.w, shotH: shot()!.h });
  };
  const wheel = (e: WheelEvent) => {
    if (!control()) return;
    const p = shotPoint(e as any);
    rig.trySend({
      type: "computer.scroll",
      direction: e.deltaY > 0 ? "down" : "up",
      times: Math.min(10, Math.max(1, Math.round(Math.abs(e.deltaY) / 100))),
      ...(p ? { x: p.x, y: p.y, shotW: shot()!.w, shotH: shot()!.h } : {}),
    });
    e.preventDefault();
  };
  const sendType = () => {
    if (!typeText()) return;
    rig.trySend({ type: "computer.type", text: typeText() });
    setTypeText("");
  };
  const toggleRec = () => {
    if (recording()) rig.trySend({ type: "computer.record.stop", id: recording() });
    else rig.trySend({ type: "computer.record.start", intervalMs: 400, scale: 0.5 });
  };

  const scale = () => {
    const s = shot();
    if (!s || !box) return 1;
    const r = box.getBoundingClientRect();
    return Math.min(r.width / s.w, r.height / s.h);
  };

  return (
    <div class="ctx">
      <div class="ctx__head">
        <span class="ctx__title">Screen</span>
        <span class={`pill ${watching() ? "pill--accent" : "pill--outline"}`}>
          {watching() ? "live" : "…"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          class={`circle-btn ${control() ? "circle-btn--live" : ""}`}
          title={control() ? "Control on — clicks reach the rig" : "Enable control"}
          onClick={() => setControl(!control())}
        >
          <I.cursorFallback size={15} />
        </button>
        <button class={`circle-btn ${recording() ? "circle-btn--rec" : ""}`} title="Record" onClick={toggleRec}>
          <I.rec size={12} />
        </button>
        <button class="circle-btn" title="Close" onClick={() => app.setScreenPanel(false)}>
          <I.x size={15} />
        </button>
      </div>
      <div
        ref={box}
        class={`ctx__screen ${control() ? "ctx__screen--control" : ""}`}
        onClick={click}
        onWheel={wheel}
      >
        <Show when={shot()} fallback={<div class="ctx__noscreen"><span class="spinner" /><p>Waiting for the rig's screen…</p></div>}>
          <img src={`data:image/jpeg;base64,${shot()!.b64}`} alt="rig screen" draggable={false} />
          <Show when={cursor()}>
            <span
              class="ctx__cursor"
              style={{
                left: `${(box!.getBoundingClientRect().width - shot()!.w * scale()) / 2 + cursor()!.x * scale() - 5}px`,
                top: `${(box!.getBoundingClientRect().height - shot()!.h * scale()) / 2 + cursor()!.y * scale() - 5}px`,
              }}
            />
          </Show>
        </Show>
      </div>
      <Show when={recording()}>
        <div class="ctx__rec"><I.rec size={10} /> recording</div>
      </Show>
      <Show when={control()}>
        <div class="ctx__typerow">
          <input
            value={typeText()}
            onInput={(e) => setTypeText(e.currentTarget.value)}
            placeholder="Type into the rig…"
            onKeyDown={(e) => e.key === "Enter" && sendType()}
          />
          <button class="btn-secondary" onClick={sendType} disabled={!typeText()}>
            Type
          </button>
        </div>
      </Show>
      <Show when={state()}>
        <div class="ctx__meta">
          {state()!.display ? `${state()!.display.width}×${state()!.display.height}` : ""}
          {state()!.input === false ? " · view-only (no input perms)" : ""}
        </div>
      </Show>
    </div>
  );
}
