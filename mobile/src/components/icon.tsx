import React from "react";
import { Text } from "react-native";
import { SymbolView, SymbolViewProps, SFSymbol, AndroidSymbol } from "expo-symbols";

// Thin wrapper: SF Symbols on iOS, Material symbol names elsewhere.
export function Icon({
  name,
  android,
  color,
  size = 20,
  weight = "regular",
}: {
  name: SFSymbol;
  android?: AndroidSymbol;
  color: string;
  size?: number;
  weight?: SymbolViewProps["weight"];
}) {
  return (
    <SymbolView
      name={android ? { ios: name, android, web: android } : name}
      tintColor={color}
      size={size}
      weight={weight}
      resizeMode="scaleAspectFit"
      fallback={<Text style={{ color, fontSize: size }}>●</Text>}
    />
  );
}
