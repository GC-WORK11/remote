// Shared motion primitives — real spring physics on the UI thread.
// Entrance animations are DRIVEN (shared-value opacity/transform), not the
// `entering` prop: entering renders position:absolute on web and collapses
// list rows. Driven styles animate identically on native and web.
import { useEffect } from "react";
import {
  useSharedValue,
  useAnimatedStyle,
  useReducedMotion,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";

// Row entrance spring — snappy but soft, no overshoot bounce.
export const SPRING_ENTER = { damping: 21, stiffness: 260, mass: 0.7 };

// Burst stagger: rows arriving together (replay, initial render) spring in
// as a wave — ≤40ms apart, capped so a long burst still lands as one wave
// instead of a stutter parade.
const STAGGER_MS = 34;
const MAX_SLOT = 9;
const BURST_QUIET_MS = 380;
let burstAt = 0;
let burstSlot = 0;

export function enterDelay(): number {
  const now = Date.now();
  if (now - burstAt > BURST_QUIET_MS) {
    burstAt = now;
    burstSlot = 0;
  }
  return Math.min(burstSlot++, MAX_SLOT) * STAGGER_MS;
}

// Fade+rise+unscale on mount. `animate=false` renders instantly (e.g. a row
// promoted from the live tail — it's already on screen, a second spring
// would read as a remount flash). Honors reduced-motion.
export function useEnterStyle(delay = 0, animate = true) {
  const reduced = useReducedMotion();
  const on = animate && !reduced;
  const p = useSharedValue(on ? 0 : 1);
  useEffect(() => {
    if (!on) {
      p.value = 1;
      return;
    }
    p.value = withDelay(delay, withSpring(1, SPRING_ENTER));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [
      { translateY: (1 - p.value) * 10 },
      { scale: 0.96 + p.value * 0.04 },
    ],
  }));
}

// Plain mount fade — for items appearing inside an already-mounted card.
export function useFadeInStyle(delay = 0, duration = 180) {
  const reduced = useReducedMotion();
  const p = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) return;
    p.value = withDelay(delay, withTiming(1, { duration }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [{ translateY: (1 - p.value) * 5 }],
  }));
}

// Reverse fade — mounts visible, animates out. Used for ghost overlays that
// crossfade one state into the next (thinking dots → streaming bubble).
export function useFadeOutStyle(duration = 180) {
  const p = useSharedValue(1);
  useEffect(() => {
    p.value = withTiming(0, { duration });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return useAnimatedStyle(() => ({ opacity: p.value }));
}
