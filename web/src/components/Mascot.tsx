// Mascot — pre-rendered PNG buddies with CSS life. state drives the pose:
// idle floats, working jumps occasionally, sleepy rests, peek leans in.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { wireTick } from "../lib/store";

export type MascotState = "idle" | "working" | "sleepy" | "peek";

export function Mascot(props: {
  color?: "gold" | "lavender";
  size?: number;
  state?: MascotState;
}) {
  const color = () => props.color ?? "gold";
  const [burst, setBurst] = createSignal(false);
  let t: any;
  // Wire frames nudge the buddy — glance up for a moment.
  onMount(() => {
    let last = wireTick();
    const iv = setInterval(() => {
      if (wireTick() !== last) {
        last = wireTick();
        setBurst(true);
        clearTimeout(t);
        t = setTimeout(() => setBurst(false), 900);
      }
    }, 300);
    onCleanup(() => {
      clearInterval(iv);
      clearTimeout(t);
    });
  });
  const pose = () => {
    const s = props.state ?? "idle";
    if (s === "working" && burst()) return "jump";
    return s === "working" ? "idle" : s;
  };
  const src = () => `/mascots/mascot-${color()}-${pose()}.png`;
  return (
    <div
      class={`mascot mascot--${pose()}`}
      style={{ width: `${props.size ?? 96}px`, height: `${props.size ?? 96}px` }}
      aria-hidden="true"
    >
      <img src={src()} alt="" draggable={false} />
      <Show when={props.state === "working"}>
        <span class="mascot__halo" />
      </Show>
    </div>
  );
}

// deterministic buddy per agent/session — gold for even, lavender for odd
export function mascotColor(seed?: string): "gold" | "lavender" {
  if (!seed) return "gold";
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return h % 2 === 0 ? "gold" : "lavender";
}

// MascotAvatar — the Discord-style avatar column image: buddy head in a soft
// rounded tile. `working` gives it a live halo pulse.
export function MascotAvatar(props: { seed?: string; size?: number; working?: boolean }) {
  const sz = () => props.size ?? 34;
  return (
    <span
      class={`mavatar mavatar--${mascotColor(props.seed)} ${props.working ? "mavatar--working" : ""}`}
      style={{ width: `${sz()}px`, height: `${sz()}px` }}
      aria-hidden="true"
    >
      <img
        src={`/mascots/mascot-${mascotColor(props.seed)}-${props.working ? "peek" : "idle"}.png`}
        alt=""
        draggable={false}
      />
    </span>
  );
}
