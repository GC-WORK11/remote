import React, { useState } from "react";
import {
  Pressable,
  PressableProps,
  PressableStateCallbackType,
  StyleProp,
  ViewStyle,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Grok/Cursor touch feel: the surface compresses a hair on contact and
// springs back — dead-opacity presses read cheap next to it. Works for
// object and ({pressed}) function styles.
//
// Reanimated's AnimatedPressable silently DROPS function styles — the
// pressable renders completely unstyled (no bg, no maxWidth, nothing).
// So we resolve the ({pressed}) => style signature ourselves via a JS
// pressed flag and always hand the animated component a static array.
export function PressScale({
  children,
  style,
  scale = 0.965,
  ...rest
}: PressableProps & { scale?: number }) {
  const s = useSharedValue(1);
  const [pressed, setPressed] = useState(false);
  const anim = useAnimatedStyle(() => ({
    transform: [{ scale: s.value }],
  }));
  const resolved =
    typeof style === "function"
      ? style({ pressed } as PressableStateCallbackType)
      : style;
  return (
    <AnimatedPressable
      android_ripple={{ color: "rgba(28,24,20,0.07)", borderless: false }}
      {...rest}
      style={[resolved as StyleProp<ViewStyle>, anim]}
      /* eslint-disable react-hooks/immutability -- shared-value writes are
         reanimated's event-thread primitive, not React state mutation */
      onPressIn={(e) => {
        s.value = withSpring(scale, { damping: 24, stiffness: 520, mass: 0.5 });
        setPressed(true);
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        s.value = withSpring(1, { damping: 15, stiffness: 420, mass: 0.5 });
        setPressed(false);
        rest.onPressOut?.(e);
      }}
      /* eslint-enable react-hooks/immutability */
    >
      {children}
    </AnimatedPressable>
  );
}
