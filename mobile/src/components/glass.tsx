import React from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { FadeInDown } from "react-native-reanimated";
import { ViewStyle } from "react-native";
import { T } from "../theme";

export function Screen({
  children,
  pad = 20,
  underTabs,
}: {
  children: React.ReactNode;
  pad?: number;
  underTabs?: boolean;
}) {
  return (
    <LinearGradient colors={[T.bgGradientTop, T.bgGradientBottom]} style={{ flex: 1 }}>
      <SafeAreaView
        style={{ flex: 1, paddingHorizontal: pad, paddingBottom: underTabs ? 96 : 0 }}
        edges={["top", "bottom"]}
      >
        {children}
      </SafeAreaView>
    </LinearGradient>
  );
}

export function Enter({
  children,
  delay = 0,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  style?: ViewStyle;
}) {
  return (
    <Animated.View
      entering={FadeInDown.delay(delay).springify().damping(18)}
      style={style}
    >
      {children}
    </Animated.View>
  );
}
