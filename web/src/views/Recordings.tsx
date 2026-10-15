// Recordings — list + in-page playback of the rig's screen recordings.
// Port of mobile/src/app/recordings.tsx: computer.record.list for rows,
// computer.record.frames paged range fetches feed the <img> player.
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { rig, Frame } from "../lib/rig";
import { app } from "../lib/store";
import I from "../components/Icon";
import "./screen.css";

interface Rec {
  id: string;
  startedAt: number;
  durationMs: number;
  frames: number;
  dropped?: number;
  fps?: number;
  bytes?: number;
  width?: number;
  height?: number;
  live?: boolean;
  mp4?: boolean;
}
type RecFrame = { seq: number; t: number; b64: string };

const fmtClock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtSize = (b: number) =>
  b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;
const fmtDay = (t: number) => {
  const d = new Date(t);
  const hm = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
};

// recordFrames replies correlate by the RECORDING id (the request `id` arg is
// also the wire selector), so match f.id by hand instead of fsCall's minted id.
function fetchRecFrames(id: string, from: number, count: number): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timeout waiting frames"));
    }, 20000);
    const off = rig.onFrame((f: Frame) => {
      if (f.type === "computer.record.frames" && f.id === id) {
        clearTimeout(timer);
        off();
        resolve(f);
      } else if (f.type === "error" && f.id === id) {
        clearTimeout(timer);
        off();
        reject(new Error(String(f.error || "frames error")));
      }
    });
    try {
      rig.send({ type: "computer.record.frames", id, from, count });
    } catch (e) {
      clearTimeout(timer);
      off();
      reject(e);
    }
  });
}

const thumbCache = new Map<string, string>();
const thumbInflight = new Set<string>();

function Thumb(props: { id: string }) {
  const [b64, setB64] = createSignal<string | null>(thumbCache.get(props.id) || null);
  onMount(() => {
    if (b64() || thumbInflight.has(props.id)) return;
    thumbInflight.add(props.id);
    fetchRecFrames(props.id, 1, 1)
      .then((f) => {
        const fr = (f.frames || [])[0];
        if (fr?.imageBase64) {
          thumbCache.set(props.id, fr.imageBase64);
          setB64(fr.imageBase64);
        }
      })
      .catch(() => {})
      .finally(() => thumbInflight.delete(props.id));
  });
  return (
    <span class="recordings__thumb">
      <Show when={b64()} fallback={<I.camera size={16} />}>{<img src={`data:image/jpeg;base64,${b64()}`} alt="" />}</Show>
    </span>
  );
}

export default function Recordings() {
  const nav = useNavigate();
  const [recs, setRecs] = createSignal<Rec[]>([]);
  const [openId, setOpenId] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [buf, setBuf] = createSignal<RecFrame[]>([]);
  const [idx, setIdx] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [dur, setDur] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  let nextFrom = 1;
  let fetching = false;
  let gen = 0;

  const refresh = () => {
    rig
      .recordList()
      .then((f) => setRecs(f.recordings || []))
      .catch(() => {});
  };

  createEffect(() => {
    if (app.conn() !== "connected") return;
    refresh();
    const off = rig.onFrame((f: Frame) => {
      if (f.type === "computer.recordings") setRecs(f.recordings || []);
      if (
        f.type === "computer.recorded" ||
        f.type === "computer.record.finished" ||
        (f.type === "ok" && f.for === "computer.record.delete")
      )
        refresh();
      if (f.type === "error") setErr(String(f.error || "error"));
    });
    const poll = setInterval(refresh, 5000); // live rows grow while recording
    onCleanup(() => {
      off();
      clearInterval(poll);
    });
  });

  const fetchRange = async (id: string, from: number, count = 60) => {
    if (fetching) return;
    fetching = true;
    const g = gen;
    try {
      const f = await fetchRecFrames(id, from, count);
      if (g !== gen || id !== openId()) return; // stale — scrub/close raced us
      const got: RecFrame[] = (f.frames || []).map((x: any) => ({ seq: x.seq, t: x.t, b64: x.imageBase64 }));
      setBuf((p) => [...p, ...got].sort((a, b) => a.seq - b.seq));
      setTotal(f.total || 0);
      nextFrom = f.nextFrom || nextFrom;
    } catch {
      setErr("Couldn't load frames — connection dropped?");
    } finally {
      fetching = false;
    }
  };

  const openRec = async (r: Rec) => {
    setErr(null);
    setOpenId(r.id);
    setPlaying(false);
    gen++;
    setIdx(0);
    setDur(r.durationMs || 0);
    setBuf([]);
    nextFrom = 1;
    setTotal(r.frames || 0);
    await fetchRange(r.id, 1, 60);
    setPlaying(true);
  };

  const closePlayer = () => {
    gen++;
    setOpenId(null);
    setPlaying(false);
    setBuf([]);
  };

  const del = (id: string) => {
    if (openId() === id) closePlayer();
    thumbCache.delete(id);
    rig.trySend({ type: "computer.record.delete", id });
  };

  const cur = () => buf()[idx()];
  const openMeta = () => recs().find((r) => r.id === openId());

  // transport — ~4 fps frame stepping; prefetch keeps ~15 frames buffered ahead
  createEffect(() => {
    if (!playing() || !openId()) return;
    const iv = setInterval(() => {
      if (idx() < buf().length - 1) setIdx(idx() + 1);
      else if (nextFrom <= total() && !fetching) fetchRange(openId()!, nextFrom);
      else if (!openMeta()?.live) setPlaying(false);
    }, 250);
    onCleanup(() => clearInterval(iv));
  });
  createEffect(() => {
    if (!openId()) return;
    if (buf().length - idx() < 15 && nextFrom <= total() && !fetching) fetchRange(openId()!, nextFrom);
  });

  const scrubToSeq = (seq: number) => {
    const i = buf().findIndex((f) => f.seq >= seq);
    if (i >= 0) {
      setIdx(i);
      return;
    }
    gen++; // drop any in-flight page — it belongs to the old playhead
    setBuf([]);
    setIdx(0);
    nextFrom = seq;
    if (openId()) fetchRange(openId()!, seq);
  };

  const togglePlay = () => {
    // at the end of a finished recording, play restarts from the top
    if (!playing() && total() > 0 && nextFrom > total() && idx() >= buf().length - 1 && !openMeta()?.live) {
      gen++;
      setBuf([]);
      setIdx(0);
      nextFrom = 1;
      fetchRange(openId()!, 1, 60);
    }
    setPlaying(!playing());
  };

  return (
    <div class="recordings">
      <div class="recordings__head">
        <div style={{ flex: 1, "min-width": 0 }}>
          <div class="recordings__title">Recordings</div>
          <div class="recordings__sub">{recs().length} on the rig</div>
        </div>
        <button class="recordings__refresh" onClick={refresh}>
          <I.restart size={14} />
          Refresh
        </button>
      </div>

      <Show when={err()}>
        <div class="recordings__err">{err()}</div>
      </Show>

      <Show when={openId()}>
        <div class="recordings__player">
          <div class="recordings__frame">
            <Show when={cur()} fallback={<div class="recordings__framewait">Loading frames…</div>}>
              <img src={`data:image/jpeg;base64,${cur()!.b64}`} alt="recording frame" />
            </Show>
            <Show when={openMeta()?.live}>
              <div class="recordings__livetag"><span class="dot" />Recording</div>
            </Show>
            <button class="recordings__close" onClick={closePlayer} title="Close player"><I.x size={14} /></button>
          </div>
          <div class="recordings__transport">
            <button class="recordings__play" onClick={togglePlay} title={playing() ? "Pause" : "Play"}>
              <Show when={playing()} fallback={<I.play size={15} />}><I.pause size={15} /></Show>
            </button>
            <input
              class="recordings__track" type="range" min={1} max={Math.max(1, total())}
              value={cur()?.seq ?? 1} onInput={(e) => scrubToSeq(+e.currentTarget.value)}
            />
            <span class="recordings__time">{cur()?.seq ?? 0}/{total()} · {fmtClock(cur()?.t ?? 0)}/{fmtClock(dur())}</span>
          </div>
          <div class="recordings__metarow">
            <span class="recordings__metatext">
              {openMeta()
                ? `${fmtDay(openMeta()!.startedAt)} · ${openMeta()!.frames} frames · ${(openMeta()!.fps ?? 0).toFixed(1)} fps · ${fmtSize(openMeta()!.bytes || 0)}${buf().length < total() ? ` · buffered ${buf().length}/${total()}` : ""}`
                : ""}
            </span>
            <button class="recordings__pbtn" title="Live screen" onClick={() => nav("/screen")}><I.screen size={15} /></button>
            <button class="recordings__pbtn recordings__pbtn--bad" title="Delete" onClick={() => del(openId()!)}><I.trash size={15} /></button>
          </div>
        </div>
      </Show>

      <div class="recordings__list">
        <For each={recs()}>
          {(r) => (
            <button class={`recordings__row ${openId() === r.id ? "recordings__row--open" : ""}`} onClick={() => openRec(r)}>
              <Thumb id={r.id} />
              <span style={{ flex: 1, "min-width": 0 }}>
                <span class="recordings__name">{fmtClock(r.durationMs)} · {fmtSize(r.bytes || 0)}</span>
                <span class="recordings__rowsub">
                  {fmtDay(r.startedAt)} · {r.frames} frames · {(r.fps ?? 0).toFixed(1)} fps
                  {r.width ? ` · ${r.width}×${r.height}` : ""}
                </span>
              </span>
              <Show
                when={r.live}
                fallback={
                  <span class="recordings__del" title="Delete recording" onClick={(e) => { e.stopPropagation(); del(r.id); }}>
                    <I.trash size={16} />
                  </span>
                }
              >
                <span class="recordings__reclive"><span class="dot" />REC</span>
              </Show>
            </button>
          )}
        </For>
        <Show when={!recs().length}>
          <div class="recordings__empty">
            <I.camera size={30} />
            <div>No recordings yet.<br />Hit the record button on the Screen view.</div>
          </div>
        </Show>
      </div>
    </div>
  );
}
