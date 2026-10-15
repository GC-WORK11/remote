// Buddy — the flat-blob family, ported 1:1 from mobile/src/components/mascot.tsx.
// One solid organic silhouette + two white bead eyes leaning ~-12°. Per-session
// deterministic shape+color via buddyFor(key); persona names via buddyName(key).
// Eyes live on CSS: blink + a slow wander; wireTick dips them on rig activity.
import { JSX } from "solid-js";
import { wireTick } from "../lib/store";
import { createMemo } from "solid-js";

export type BuddyShape =
  | "cloud"
  | "triangle"
  | "circle"
  | "square"
  | "hexagon"
  | "pill"
  | "droplet"
  | "duo";

// Shape+color pairs pixel-sampled from the refs (mobile theme.ts). Index 0 is
// the DevBot hero: hot-pink rounded triangle.
export const BUDDY_ROSTER: { shape: BuddyShape; color: string }[] = [
  { shape: "triangle", color: "#FF5FB0" },
  { shape: "circle", color: "#A87EFE" },
  { shape: "square", color: "#141414" },
  { shape: "hexagon", color: "#FFAE38" },
  { shape: "pill", color: "#09C171" },
  { shape: "circle", color: "#1E8BF7" },
  { shape: "duo", color: "#FF8533" },
  { shape: "pill", color: "#EF2E90" },
  { shape: "triangle", color: "#14CC6E" },
  { shape: "circle", color: "#FF9F1E" },
  { shape: "square", color: "#FF8E24" },
  { shape: "droplet", color: "#1C8AFF" },
  { shape: "cloud", color: "#3D96F8" },
  { shape: "circle", color: "#F24FA7" },
];

export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function buddyFor(key: string): { shape: BuddyShape; color: string } {
  if (!key || key === "remote") return BUDDY_ROSTER[0];
  return BUDDY_ROSTER[hashStr(key) % BUDDY_ROSTER.length];
}

const BUDDY_NAMES = [
  "Bob", "Pip", "Dot", "Milo", "Nova", "Byte", "Zed", "Kit",
  "Juno", "Rex", "Faye", "Ono", "Ivy", "Lux", "Gus", "Tao",
];
export function buddyName(key: string): string {
  if (!key || key === "remote") return "DevBot";
  return BUDDY_NAMES[hashStr(key) % BUDDY_NAMES.length];
}

const SHAPES: Record<Exclude<BuddyShape, "duo">, string> = {
  triangle:
    "M50 5 C56 5 61 9 65 16 C75 32 84 52 91 70 C95 79 93 87 86 91 C79 95 66 97 50 97 C34 97 21 95 14 91 C7 87 5 79 9 70 C16 52 25 32 35 16 C39 9 44 5 50 5 Z",
  circle:
    "M52 4 C78 4 97 24 97 51 C97 77 77 97 50 97 C24 97 3 77 3 52 C3 26 26 4 52 4 Z",
  square:
    "M30 6 L71 6 C85 6 94 15 94 30 L94 70 C94 85 85 94 70 94 L29 94 C15 94 6 85 6 70 L6 31 C6 16 15 6 30 6 Z",
  hexagon:
    "M50 5 C54 5 58 6 62 9 L83 21 C89 24 93 30 93 38 L93 62 C93 70 89 76 83 79 L62 91 C54 96 46 96 38 91 L17 79 C11 76 7 70 7 62 L7 38 C7 30 11 24 17 21 L38 9 C42 6 46 5 50 5 Z",
  pill: "M28 28 C15 28 6 37 6 50 C6 63 15 72 28 72 L72 72 C85 72 94 63 94 50 C94 37 85 28 72 28 Z",
  droplet:
    "M50 5 C54 5 84 44 84 65 C84 84 69 96 50 96 C31 96 16 84 16 65 C16 44 46 5 50 5 Z",
  cloud:
    "M24 84 C12 84 4 74 4 62 C4 51 13 43 24 41 C26 27 40 18 54 21 C68 24 76 35 74 48 C86 48 96 57 96 68 C96 76 87 84 78 84 Z",
};

const DUO_SQUARE =
  "M19 17 L57 17 C68 17 75 24 75 35 L75 63 C75 74 68 81 57 81 L19 81 C10 81 5 74 5 63 L5 35 C5 24 10 17 19 17 Z";
const DUO_DROPLET =
  "M75 48 C77 48 92 66 92 77 C92 87 85 94 75 94 C65 94 58 87 58 77 C58 66 73 48 75 48 Z";
const DUO_BLUE = "#1C8AFF";

const EYE_POS: Record<BuddyShape, { x: number; y: number }[]> = {
  triangle: [{ x: 0.58, y: 0.43 }],
  circle: [{ x: 0.56, y: 0.33 }],
  square: [{ x: 0.55, y: 0.33 }],
  hexagon: [{ x: 0.55, y: 0.33 }],
  pill: [{ x: 0.55, y: 0.38 }],
  droplet: [{ x: 0.56, y: 0.5 }],
  cloud: [{ x: 0.55, y: 0.52 }],
  duo: [
    { x: 0.36, y: 0.44 },
    { x: 0.74, y: 0.72 },
  ],
};

function EyePair(props: { cx: number; cy: number; unit: number }) {
  const eyeW = () => props.unit * 0.085;
  const eyeH = () => props.unit * 0.21;
  const gap = () => props.unit * 0.09;
  const pairW = () => eyeW() * 2 + gap();
  const bead: JSX.CSSProperties = {
    width: `${eyeW()}px`,
    height: `${eyeH()}px`,
    "border-radius": `${eyeW() / 2}px`,
    background: "#FFFFFF",
    transform: "rotate(-12deg)",
  };
  return (
    <div
      class="buddy__eyeset"
      style={{
        position: "absolute",
        left: `${props.cx - pairW() / 2}px`,
        top: `${props.cy - eyeH() / 2}px`,
        width: `${pairW()}px`,
        height: `${eyeH()}px`,
        display: "flex",
        "justify-content": "space-between",
      }}
    >
      <div style={bead} />
      <div style={bead} />
    </div>
  );
}

// Mascot — parametric flat blob. eyes=true gives live bead eyes that blink,
// wander, and dip on rig activity (wireTick → buddy--glance on <html>).
export function Mascot(props: {
  shape: BuddyShape;
  color: string;
  size?: number;
  eyes?: boolean;
  seed?: string;
  style?: JSX.CSSProperties;
}) {
  const size = () => props.size ?? 52;
  // blink phase + wander period seeded per creature so they never sync
  const seedN = createMemo(() => hashStr(props.seed ?? `${props.shape}:${props.color}`));
  const positions = () => EYE_POS[props.shape];
  const unit = () => (props.shape === "duo" ? size() * 0.72 : size());
  return (
    <div
      class="buddy"
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        position: "relative",
        "flex-shrink": 0,
        ...props.style,
      }}
      aria-hidden="true"
    >
      <svg width={size()} height={size()} viewBox="0 0 100 100" style={{ display: "block" }}>
        {props.shape === "duo" ? (
          <>
            <g transform="rotate(-28 40 49)">
              <path d={DUO_SQUARE} fill={props.color} />
            </g>
            <g transform="rotate(28 75 71)">
              <path d={DUO_DROPLET} fill={DUO_BLUE} />
            </g>
          </>
        ) : (
          <path d={SHAPES[props.shape]} fill={props.color} />
        )}
      </svg>
      {props.eyes !== false ? (
        <div
          class="buddy__eyes"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: `${size()}px`,
            height: `${size()}px`,
            "pointer-events": "none",
            "animation-delay": `-${seedN() % 3800}ms`,
          }}
        >
          {positions().map((p) => (
            <EyePair cx={p.x * size()} cy={p.y * size()} unit={unit()} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Buddy — the roster pick for a session/persona key. `color`/`shape` pins the
// creature (brand call sites pin the cloud mark).
export function Buddy(props: {
  k: string;
  size?: number;
  color?: string;
  shape?: BuddyShape;
  eyes?: boolean;
  style?: JSX.CSSProperties;
}) {
  const pick = () =>
    props.shape || props.color
      ? { shape: (props.shape ?? "cloud") as BuddyShape, color: props.color ?? "#34A853" }
      : buddyFor(props.k);
  return (
    <Mascot
      shape={pick().shape}
      color={pick().color}
      size={props.size}
      eyes={props.eyes}
      seed={props.k}
      style={props.style}
    />
  );
}
