import React from "react";
import { View, Text, StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import { T, FONT } from "../theme";
import { Icon } from "./icon";
import { useRig } from "../state";
import { PressScale } from "./pressable";

export function Header({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  const { setDrawerOpen } = useRig();
  return (
    <View style={styles.wrap}>
      <PressScale
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          setDrawerOpen(true);
        }}
        style={styles.menu}
        hitSlop={8}
      >
        <Icon name="line.3.horizontal" android="menu" color={T.ink} size={20} weight="medium" />
      </PressScale>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[FONT.title, { color: T.ink }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[FONT.tiny, { color: T.sub, marginTop: 1 }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingTop: 10,
    paddingBottom: 12,
  },
  menu: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.surfaceStrong,
    borderWidth: StyleSheet.hairlineWidth * 1.5,
    borderColor: T.hairline,
  },
});
