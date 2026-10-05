// AsciiMeadow — a field of thin wildflowers in pixel cells. Slender sine
// stems carry tiny blossom crosses, sparse grass fringes the ground,
// light pools around each bloom, and pollen motes drift. Every cell is
// deterministic; light theme only — "flowers illuminating".
import React, { useEffect } from "react";
import { View, ViewStyle } from "react-native";
import Svg, { Rect } from "react-native-svg";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from "react-native-reanimated";

// rose-petal ramp: hot core → mid pink → blush edge; gold where light pools
const CORE = "#C93B6E";
const PETAL_IN = "#EF6FA4";
const PETAL = "#F79FBE";
const PETAL_HI = "#FBC4D9";
const GLOW = "#F9D9E4";
const CREAM = "#F3E8DC";
const STEM = "#5E9C5F";
const LEAF = "#7FBB80";
const SPARK = "#EFB85C";

const MC = { CORE, PETAL_IN, PETAL, PETAL_HI, GLOW, CREAM, STEM, LEAF, SPARK };

const MCOLS = 40;
const MROWS = 21;
const GROUND = 19;

type Flower = { x: number; top: number; hue: 0 | 1 | 2; lean: number; big?: boolean };
const FLOWERS: Flower[] = [
  { x: 4, top: 10, hue: 1, lean: -0.9 },
  { x: 11, top: 6, hue: 0, lean: 0.7, big: true },
  { x: 18, top: 9, hue: 2, lean: -0.4 },
  { x: 25, top: 5, hue: 1, lean: 0.5, big: true },
  { x: 31, top: 8, hue: 0, lean: -0.8 },
  { x: 37, top: 11, hue: 2, lean: 0.9 },
];

const HUES: [string, string][] = [
  [CORE, PETAL],
  [PETAL_IN, PETAL_HI],
  ["#E8A83E", "#F3CD8B"],
];

const GRASS_X = [1, 3, 8, 14, 16, 22, 29, 34, 38];

function meadowCells(): { x: number; y: number; c: string; glow?: boolean }[] {
  const grid: (string | null)[][] = Array.from({ length: MROWS }, () =>
    Array(MCOLS).fill(null)
  );
  const put = (x: number, y: number, c: string) => {
    const xi = Math.round(x);
    if (xi >= 0 && xi < MCOLS && y >= 0 && y < MROWS) grid[y][xi] = c;
  };
  for (const f of FLOWERS) {
    const [deep, light] = HUES[f.hue];
    // stem — thin sine from ground up to the bloom
    for (let y = f.top + 1; y <= GROUND; y++) {
      const xs = f.x + f.lean * Math.sin((y - f.top) * 0.55);
      put(xs, y, STEM);
    }
    // one small leaf off the stem, two-thirds down
    const leafY = Math.round(f.top + (GROUND - f.top) * 0.62);
    const leafX = f.x + f.lean * Math.sin((leafY - f.top) * 0.5);
    put(leafX + (f.lean >= 0 ? -1 : 1), leafY, LEAF);
    put(leafX + (f.lean >= 0 ? -2 : 2), leafY - 0, LEAF);
    // blossom — a cross of petal cells; big blooms get diagonals too
    put(f.x, f.top, deep);
    put(f.x - 1, f.top, light);
    put(f.x + 1, f.top, light);
    put(f.x, f.top - 1, light);
    put(f.x, f.top + 1, light);
    if (f.big) {
      put(f.x - 1, f.top - 1, light);
      put(f.x + 1, f.top - 1, light);
      put(f.x - 1, f.top + 1, deep);
      put(f.x + 1, f.top + 1, deep);
    }
  }
  // grass — short blades near the ground line
  for (const gx of GRASS_X) {
    const h = 1 + ((gx * 7) % 3);
    for (let d = 0; d < h; d++) put(gx + d * 0.45, GROUND - 1 - d, LEAF);
  }
  // glow — empty cell touching a blossom pools light
  const cells: { x: number; y: number; c: string; glow?: boolean }[] = [];
  for (let y = 0; y < MROWS; y++) {
    for (let x = 0; x < MCOLS; x++) {
      if (grid[y][x]) {
        cells.push({ x, y, c: grid[y][x]! });
        continue;
      }
      let nearBloom = false;
      for (const f of FLOWERS) {
        if (Math.abs(x - f.x) <= 2 && Math.abs(y - f.top) <= 2) {
          nearBloom = true;
          break;
        }
      }
      if (nearBloom) cells.push({ x, y, c: GLOW, glow: true });
      else if (y === GROUND + 1 && x % 3 === 0)
        cells.push({ x, y, c: CREAM });
    }
  }
  return cells;
}

const MCELLS = meadowCells();
// pollen motes drift together on the breeze (one shared anim)
const POLLEN: { x: number; y: number }[] = [
  { x: 7, y: 4 },
  { x: 15, y: 2 },
  { x: 22, y: 5 },
  { x: 30, y: 2 },
  { x: 35, y: 6 },
  { x: 3, y: 7 },
];

/** A field of thin pixel wildflowers — the welcome screen's bloom. */
export function AsciiMeadow({
  width,
  style,
}: {
  width: number;
  style?: ViewStyle;
}) {
  const cell = width / MCOLS;
  const h = cell * MROWS;
  const enter = useSharedValue(0);
  const breathe = useSharedValue(0.4);
  const drift = useSharedValue(0);
  useEffect(() => {
    enter.value = withTiming(1, { duration: 1200, easing: Easing.out(Easing.cubic) });
    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.35, { duration: 2800, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );
    drift.value = withRepeat(
      withTiming(1, { duration: 5200, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const enterStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [
      { scale: 0.9 + enter.value * 0.1 },
      { translateY: (1 - enter.value) * 12 },
    ],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: (0.4 + breathe.value * 0.6) * enter.value,
  }));
  const pollenStyle = useAnimatedStyle(() => ({
    opacity: 0.45 + 0.55 * Math.sin(drift.value * Math.PI * 2),
    transform: [
      { translateX: Math.sin(drift.value * Math.PI * 2) * 3 },
      { translateY: -drift.value * 6 * enter.value },
    ],
  }));
  return (
    <View style={[{ width, height: h }, style]}>
      <Animated.View
        style={[{ position: "absolute", left: 0, top: 0, width, height: h }, enterStyle]}
      >
        <Svg width={width} height={h}>
          {MCELLS.filter((cl) => !cl.glow).map((cl, i) => (
            <Rect
              key={i}
              x={cl.x * cell + cell * 0.1}
              y={cl.y * cell + cell * 0.1}
              width={cell * 0.8}
              height={cell * 0.8}
              rx={cell * 0.2}
              fill={cl.c}
            />
          ))}
        </Svg>
      </Animated.View>
      {/* light pooling at the blooms */}
      <Animated.View
        pointerEvents="none"
        style={[{ position: "absolute", left: 0, top: 0, width, height: h }, glowStyle]}
      >
        <Svg width={width} height={h}>
          {MCELLS.filter((cl) => cl.glow).map((cl, i) => (
            <Rect
              key={i}
              x={cl.x * cell + cell * 0.06}
              y={cl.y * cell + cell * 0.06}
              width={cell * 0.88}
              height={cell * 0.88}
              rx={cell * 0.24}
              fill={MC.GLOW}
            />
          ))}
        </Svg>
      </Animated.View>
      {/* drifting pollen motes */}
      <Animated.View
        pointerEvents="none"
        style={[{ position: "absolute", left: 0, top: 0, width, height: h }, pollenStyle]}
      >
        <Svg width={width} height={h}>
          {POLLEN.map((s, i) => (
            <Rect
              key={i}
              x={s.x * cell + cell * 0.25}
              y={s.y * cell + cell * 0.25}
              width={cell * 0.5}
              height={cell * 0.5}
              rx={cell * 0.25}
              fill={SPARK}
              opacity={0.9}
            />
          ))}
        </Svg>
      </Animated.View>
    </View>
  );
}

