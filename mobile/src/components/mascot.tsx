// Mascots — the flat-blob family from the refs: each persona is ONE solid
// organic silhouette in ONE flat color wearing two white bead eyes. The
// eyes sit in the blob's upper third, nudged right of center, and both
// lean the same way (~12° tops to the left — the Grok-bot glance, not a
// symmetric V). No gradients, no outlines, no shadows — pure flat vector.
//
// The eyes stay live: they blink on a per-creature rhythm, wander a slow
// path, and glance toward real rig activity (pokeMascots) — subtle flat
// translation only, never a 3D tilt.
import React, { useEffect } from "react";
import { View, ViewStyle } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  makeMutable,
  withRepeat,
  withTiming,
  withSequence,
  withDelay,
  Easing,
} from "react-native-reanimated";
import { BUDDY_ROSTER, BuddyShape } from "../theme";

// Activity glance — a process-wide shared value every Buddy eye pair reads.
// The rig layer pokes it on real frames (tool calls, text deltas, new
// messages) so eyes dip toward the latest activity like the bots noticed.
// UI-thread only: reads happen inside animated styles, no React re-renders.
export const rigGlance = makeMutable(0);
let lastPoke = 0;
export function pokeMascots() {
  const now = Date.now();
  if (now - lastPoke < 1400) return;
  lastPoke = now;
  rigGlance.value = withSequence(
    withTiming(1, { duration: 320, easing: Easing.out(Easing.ease) }),
    withDelay(700, withTiming(0, { duration: 800, easing: Easing.inOut(Easing.ease) }))
  );
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// ---------------------------------------------------------------------------
// Buddy — deterministic shape+color per key (session id). One creature for
// every agent everywhere — the pair is what tells sessions apart. The
// "remote" key (brand-new threads, hero spots) always gets the pink
// rounded-triangle — the DevBot hero from the refs.
// ---------------------------------------------------------------------------
export function buddyFor(key: string): { shape: BuddyShape; color: string } {
  if (!key || key === "remote") return BUDDY_ROSTER[0];
  const h = hashStr(key);
  return BUDDY_ROSTER[h % BUDDY_ROSTER.length];
}

// Persona names — the "Bob/DevBot/Deckster is working" style from the refs.
// Deterministic per session so a thread's buddy keeps its identity.
const BUDDY_NAMES = [
  "Bob", "Pip", "Dot", "Milo", "Nova", "Byte", "Zed", "Kit",
  "Juno", "Rex", "Faye", "Ono", "Ivy", "Lux", "Gus", "Tao",
];
export function buddyName(key: string): string {
  if (!key || key === "remote") return "DevBot";
  return BUDDY_NAMES[hashStr(key) % BUDDY_NAMES.length];
}

// Flat organic silhouettes in a 100×100 box — hand-drawn feel: corners
// heavily rounded, sides slightly uneven, nothing perfectly geometric.
// `cloud` stays the brand mark (pinned-color call sites); `duo` is the
// orange square + blue drop composite from the refs.
const SHAPES: Record<Exclude<BuddyShape, "duo">, string> = {
  // rounded triangle — convex sides, base sags in the middle (guitar pick)
  triangle:
    "M50 5 C56 5 61 9 65 16 C75 32 84 52 91 70 C95 79 93 87 86 91 C79 95 66 97 50 97 C34 97 21 95 14 91 C7 87 5 79 9 70 C16 52 25 32 35 16 C39 9 44 5 50 5 Z",
  // near-circle, bottom-left a touch fuller
  circle:
    "M52 4 C78 4 97 24 97 51 C97 77 77 97 50 97 C24 97 3 77 3 52 C3 26 26 4 52 4 Z",
  // rounded square
  square:
    "M30 6 L71 6 C85 6 94 15 94 30 L94 70 C94 85 85 94 70 94 L29 94 C15 94 6 85 6 70 L6 31 C6 16 15 6 30 6 Z",
  // pointy-top hexagon, corners rounded
  hexagon:
    "M50 5 C54 5 58 6 62 9 L83 21 C89 24 93 30 93 38 L93 62 C93 70 89 76 83 79 L62 91 C54 96 46 96 38 91 L17 79 C11 76 7 70 7 62 L7 38 C7 30 11 24 17 21 L38 9 C42 6 46 5 50 5 Z",
  // wide stadium capsule (~2:1 like the ref's green pill)
  pill:
    "M28 28 C15 28 6 37 6 50 C6 63 15 72 28 72 L72 72 C85 72 94 63 94 50 C94 37 85 28 72 28 Z",
  // fat teardrop
  droplet:
    "M50 5 C54 5 84 44 84 65 C84 84 69 96 50 96 C31 96 16 84 16 65 C16 44 46 5 50 5 Z",
  // three-hump cloud — the brand mark
  cloud:
    "M24 84 C12 84 4 74 4 62 C4 51 13 43 24 41 C26 27 40 18 54 21 C68 24 76 35 74 48 C86 48 96 57 96 68 C96 76 87 84 78 84 Z",
};

// The duo: a rounded square spun ~30° carrying a fat blue droplet tilted
// up-right — both sub-creatures wear their own bead pair.
const DUO_SQUARE =
  "M19 17 L57 17 C68 17 75 24 75 35 L75 63 C75 74 68 81 57 81 L19 81 C10 81 5 74 5 63 L5 35 C5 24 10 17 19 17 Z";
const DUO_DROPLET =
  "M75 48 C77 48 92 66 92 77 C92 87 85 94 75 94 C65 94 58 87 58 77 C58 66 73 48 75 48 Z";
const DUO_BLUE = "#1C8AFF";

// Where each shape's eye PAIR centers, as a fraction of the frame — upper
// third, right of the blob's midline (measured off the refs). The duo
// wears one pair on its square and one on the droplet.
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

const EYE_TILT = "-12deg"; // both beads lean the same way — top left
const EYE_WHITE = "#FFFFFF";

// One bead pair at (cx, cy): two white rounded pills, small gap between.
function EyePair({
  cx,
  cy,
  unit,
}: {
  cx: number;
  cy: number;
  unit: number;
}) {
  const eyeW = unit * 0.085;
  const eyeH = unit * 0.21;
  const gap = unit * 0.09; // inner edge gap between the two beads
  const pairW = eyeW * 2 + gap;
  const bead = {
    width: eyeW,
    height: eyeH,
    borderRadius: eyeW / 2,
    backgroundColor: EYE_WHITE,
    transform: [{ rotate: EYE_TILT }],
  };
  return (
    <View
      style={{
        position: "absolute",
        left: cx - pairW / 2,
        top: cy - eyeH / 2,
        width: pairW,
        height: eyeH,
        flexDirection: "row",
        justifyContent: "space-between",
      }}
    >
      <View style={bead} />
      <View style={bead} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Mascot — parametric flat blob: one shape, one color, live bead eyes.
// ---------------------------------------------------------------------------
export function Mascot({
  shape,
  color,
  size = 52,
  eyes = true,
  seed,
  style,
}: {
  shape: BuddyShape;
  color: string;
  size?: number;
  /** Draw the bead eyes (default true). */
  eyes?: boolean;
  /** Seed for the blink/wander phase — defaults to the creature itself. */
  seed?: string;
  style?: ViewStyle;
}) {
  const drift = useSharedValue(0);
  const gaze = useSharedValue(0);
  const blink = useSharedValue(1);
  const bob = useSharedValue(0);
  useEffect(() => {
    const s = hashStr(seed ?? `${shape}:${color}`);
    blink.value = withRepeat(
      withSequence(
        withDelay(s % 2000, withTiming(1, { duration: 1800 })),
        withTiming(0.08, { duration: 80 }),
        withTiming(1, { duration: 110 })
      ),
      -1,
      false
    );
    drift.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2400 }),
        withTiming(-1, { duration: 2600 })
      ),
      -1,
      true
    );
    // wandering gaze — the beads roam gently on a Lissajous (two
    // incommensurate periods so the path never visibly repeats), then dart
    // toward rig activity when the rig pokes them.
    gaze.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1400 + (s % 700), easing: Easing.inOut(Easing.sin) }),
        withTiming(-0.7, { duration: 1700, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.35, { duration: 1500 + (s % 400), easing: Easing.inOut(Easing.sin) }),
        withTiming(-1, { duration: 1900, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 1600, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
    bob.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2100, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 2100, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );
  }, [seed, shape, color]); // eslint-disable-line react-hooks/exhaustive-deps
  const eyeStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: drift.value * size * 0.018 + gaze.value * size * 0.02 },
      { translateY: rigGlance.value * size * 0.04 },
      { scaleY: blink.value },
    ],
  }));
  const bodyStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -bob.value * size * 0.035 }],
  }));

  const positions = EYE_POS[shape];
  // Sub-creatures in the duo get smaller beads.
  const unit = shape === "duo" ? size * 0.72 : size;

  return (
    <Animated.View style={[{ width: size, height: size }, bodyStyle, style]}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        {shape === "duo" ? (
          <>
            <G transform="rotate(-28 40 49)">
              <Path d={DUO_SQUARE} fill={color} />
            </G>
            <G transform="rotate(28 75 71)">
              <Path d={DUO_DROPLET} fill={DUO_BLUE} />
            </G>
          </>
        ) : (
          <Path d={SHAPES[shape]} fill={color} />
        )}
      </Svg>
      {eyes ? (
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", left: 0, top: 0, width: size, height: size }, eyeStyle]}
        >
          {positions.map((p, i) => (
            <EyePair key={i} cx={p.x * size} cy={p.y * size} unit={unit} />
          ))}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Buddy — the roster pick for a session/persona key. Passing `color` (or
// `shape`) pins the creature: brand call sites pin the cloud.
// ---------------------------------------------------------------------------
export function Buddy({
  k,
  size = 52,
  color,
  shape,
  eyes,
  style,
}: {
  k: string;
  size?: number;
  /** Pin a brand color — renders the cloud glyph (our brand mark). */
  color?: string;
  /** Pin a silhouette explicitly. */
  shape?: BuddyShape;
  eyes?: boolean;
  style?: ViewStyle;
}) {
  const pick =
    shape || color
      ? { shape: (shape ?? "cloud") as BuddyShape, color: color ?? "#34A853" }
      : buddyFor(k);
  return <Mascot shape={pick.shape} color={pick.color} size={size} eyes={eyes} seed={k} style={style} />;
}
