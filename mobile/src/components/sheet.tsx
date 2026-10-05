// ScreenSheet — the "see what it's doing" view from the refs: slides up
// from the bottom over the thread, live-mirrors the rig's screen, taps
// forward as real clicks, and opens apps/URLs on the host. Deeper control
// lives one tap away on the full /screen route — this sheet is the glance.
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Modal,
  TextInput,
  LayoutChangeEvent,
  GestureResponderEvent,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./icon";
import { T, FONT, fw } from "../theme";
import { rig, Frame } from "../rig";
import { useRig } from "../state";
import { vitalsRows } from "../vitals";
import { PressScale } from "./pressable";

interface Shot {
  b64: string;
  w: number;
  h: number;
}

export function ScreenSheet() {
  const { screenSheet, setScreenSheet, connected, hostInfo, vitals } = useRig();
  const insets = useSafeAreaInsets();
  const [shot, setShot] = useState<Shot | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [url, setUrl] = useState("");
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 });

  // Watch only while the sheet is actually open — Modal children stay
  // mounted on some platforms once shown, so guard on screenSheet itself.
  useEffect(() => {
    if (!screenSheet || !connected) return;
    rig.trySend({ type: "computer.screenshot", scale: 0.45 });
    rig.trySend({ type: "computer.watch", intervalMs: 600, threshold: 1, scale: 0.45 });
    rig.trySend({ type: "computer.cursor" });
    const off = rig.onFrame((f: Frame) => {
      if (f.type === "computer.frame" || f.type === "computer.screenshot") {
        setShot({ b64: f.imageBase64, w: f.width, h: f.height });
        if (f.cursor) setCursor({ x: f.cursor.x, y: f.cursor.y });
      }
      if (f.type === "computer.cursor" && typeof f.x === "number")
        setCursor({ x: f.x, y: f.y });
    });
    return () => {
      off();
      rig.trySend({ type: "computer.unwatch" });
    };
  }, [screenSheet, connected]);

  const shotPoint = (lx: number, ly: number) => {
    if (!shot || !boxSize.w) return null;
    const scale = Math.min(boxSize.w / shot.w, boxSize.h / shot.h);
    const dispW = shot.w * scale;
    const dispH = shot.h * scale;
    const x = Math.round((lx - (boxSize.w - dispW) / 2) / scale);
    const y = Math.round((ly - (boxSize.h - dispH) / 2) / scale);
    if (x < 0 || y < 0 || x > shot.w || y > shot.h) return null;
    return { x, y };
  };

  const tapShot = (e: GestureResponderEvent) => {
    const p = shotPoint(e.nativeEvent.locationX, e.nativeEvent.locationY);
    if (p) rig.trySend({ type: "computer.click", x: p.x, y: p.y });
  };

  const openUrl = () => {
    const v = url.trim();
    if (!v) return;
    rig.hostOpen(/^https?:\/\//i.test(v) ? v : `https://${v}`, hostInfo?.os);
    setUrl("");
  };

  const goFull = () => {
    setScreenSheet(false);
    router.navigate("/screen" as any);
  };

  const cur = (() => {
    if (!cursor || !shot || !boxSize.w) return null;
    const scale = Math.min(boxSize.w / shot.w, boxSize.h / shot.h);
    const dispW = shot.w * scale;
    const dispH = shot.h * scale;
    const x = (boxSize.w - dispW) / 2 + cursor.x * scale;
    const y = (boxSize.h - dispH) / 2 + cursor.y * scale;
    if (x < 0 || y < 0 || x > boxSize.w || y > boxSize.h) return null;
    return { x, y };
  })();

  return (
    <Modal
      visible={screenSheet}
      transparent
      animationType="slide"
      onRequestClose={() => setScreenSheet(false)}
    >
      <KeyboardAvoidingView
        style={styles.back}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setScreenSheet(false)} />
        <View style={[styles.card, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.grabber} />
          <View style={styles.head}>
            <View style={styles.liveDot} />
            <Text style={[FONT.small, styles.title]} numberOfLines={1}>
              {hostInfo?.hostname || "Your computer"}
            </Text>
            <PressScale
              onPress={goFull}
              hitSlop={8}
              style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
            >
              <Icon name="arrow.up.left.and.arrow.down.right" android="open_in_full" color={T.sub} size={15} />
            </PressScale>
            <PressScale
              onPress={() => setScreenSheet(false)}
              hitSlop={8}
              style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
            >
              <Icon name="xmark" android="close" color={T.sub} size={16} />
            </PressScale>
          </View>

          {/* rig.vitals — the host's own health, only what it probed */}
          {connected ? (
            <View style={styles.vitalsCard}>
              {vitalsRows(vitals).length ? (
                vitalsRows(vitals).map((r) => (
                  <View key={r.label} style={styles.vitalsRow}>
                    <Icon name={r.icon as any} android={r.android as any} color={T.faint} size={12} />
                    <Text style={[FONT.tiny, { color: T.faint, width: 62 }]}>{r.label}</Text>
                    <Text style={[FONT.tiny, { color: T.ink, flex: 1, ...fw("600") }]} numberOfLines={1}>
                      {r.value}
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={[FONT.tiny, { color: T.faint }]}>
                  {vitals ? "No vitals reported by this rig" : "Probing host vitals…"}
                </Text>
              )}
            </View>
          ) : null}

          <PressScale
            onLayout={(e: LayoutChangeEvent) => {
              setBoxSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
            }}
            onPress={tapShot}
            style={styles.shotBox}
          >
            {shot ? (
              <Animated.Image
                key={shot.b64.slice(0, 32)}
                entering={FadeIn.duration(120)}
                source={{ uri: `data:image/jpeg;base64,${shot.b64}` }}
                style={StyleSheet.absoluteFill}
                resizeMode="contain"
              />
            ) : (
              <View style={styles.shotPh}>
                <Icon name="display" android="desktop_windows" color={T.faint} size={26} />
                <Text style={[FONT.tiny, { color: T.faint }]}>
                  {connected ? "Waking the mirror…" : "Not connected"}
                </Text>
              </View>
            )}
            {cur ? <View style={[styles.cursor, { left: cur.x - 7, top: cur.y - 7 }]} /> : null}
          </PressScale>

          <View style={styles.urlRow}>
            <Icon name="globe" android="language" color={T.faint} size={14} />
            <TextInput
              value={url}
              onChangeText={setUrl}
              onSubmitEditing={openUrl}
              placeholder="Open a site or app on the rig…"
              placeholderTextColor={T.faint}
              style={[FONT.small, styles.urlInput]}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
            />
            <PressScale
              onPress={openUrl}
              hitSlop={8}
              style={({ pressed }) => [styles.goBtn, pressed && { opacity: 0.7 }]}
            >
              <Icon name="arrow.up" android="arrow_upward" color="#fff" size={14} />
            </PressScale>
          </View>

          <PressScale
            onPress={goFull}
            style={({ pressed }) => [styles.takeOver, pressed && { opacity: 0.8 }]}
          >
            <Text style={[FONT.small, { color: "#fff", ...fw("700") }]}>
              Take over
            </Text>
            <Icon name="hand.point.up.left" android="touch_app" color="#fff" size={14} />
          </PressScale>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  back: { flex: 1, backgroundColor: "rgba(20,20,24,0.28)", justifyContent: "flex-end" },
  card: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingTop: 8,
    paddingHorizontal: 16,
    gap: 12,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -8 },
    elevation: 18,
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: T.hairline,
  },
  vitalsCard: {
    flexDirection: "column",
    gap: 5,
    backgroundColor: T.controlBg,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  vitalsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.ok },
  title: { flex: 1, color: T.ink, ...fw("700"), fontSize: 15 },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: T.controlBg,
    alignItems: "center",
    justifyContent: "center",
  },
  shotBox: {
    height: 300,
    borderRadius: 16,
    backgroundColor: "#101014",
    overflow: "hidden",
  },
  shotPh: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  cursor: {
    position: "absolute",
    width: 14,
    height: 14,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.9)",
    borderWidth: 2,
    borderColor: "rgba(0,0,0,0.55)",
  },
  urlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: T.controlBg,
    borderRadius: 999,
    paddingLeft: 13,
    paddingRight: 6,
    height: 42,
  },
  urlInput: { flex: 1, color: T.ink, fontSize: 13.5, paddingVertical: 0 },
  goBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: T.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  takeOver: {
    height: 46,
    borderRadius: 999,
    backgroundColor: T.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
});
