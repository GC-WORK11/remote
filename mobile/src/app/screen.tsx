import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Image,
  StyleSheet,
  ScrollView,
  LayoutChangeEvent,
  GestureResponderEvent,
  TextInput,
  Platform,
  Pressable,
} from "react-native";
import * as Haptics from "expo-haptics";
import { GlassView } from "expo-glass-effect";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, runOnJS, useSharedValue } from "react-native-reanimated";
import { router } from "expo-router";
import { Screen } from "../components/glass";
import { Header } from "../components/header";
import { Icon } from "../components/icon";
import { T, FONT, fw } from "../theme";
import { rig, Frame } from "../rig";
import { useRig } from "../state";
import { PressScale } from "../components/pressable";

interface Shot {
  b64: string;
  w: number;
  h: number;
  ms?: number;
}

export default function Computer() {
  const { connected, hostInfo } = useRig();
  const [state, setState] = useState<any>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [windows, setWindows] = useState<any[]>([]);
  const [watchId, setWatchId] = useState<string | null>(null);
  const [watchDisp, setWatchDisp] = useState<string | null>(null);
  const [inputErr, setInputErr] = useState<string | null>(null);
  const [controlling, setControlling] = useState(false);
  const [typeText, setTypeText] = useState("");
  const [fps, setFps] = useState(0);
  const [recId, setRecId] = useState<string | null>(null);
  const [recElapsed, setRecElapsed] = useState(0);
  const recStart = useRef(0);
  const box = useRef({ w: 0, h: 0 });
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 });
  const frames = useRef(0);

  useEffect(() => {
    if (!connected) return;
    rig.trySend({ type: "computer.state" });
    rig.trySend({ type: "computer.screenshot", scale: 0.45 });
    rig.trySend({ type: "computer.watch", intervalMs: 250, threshold: 1, scale: 0.45 });
    rig.trySend({ type: "computer.record.list" }); // adopt a recording in progress
    const poll = setInterval(() => {
      rig.trySend({ type: "computer.cursor" });
    }, 2500);
    const winPoll = setInterval(() => {
      rig.trySend({ type: "computer.windows" });
    }, 8000);
    const meter = setInterval(() => {
      setFps(frames.current);
      frames.current = 0;
    }, 1000);
    const off = rig.onFrame((f: Frame) => {
      if (f.type === "computer.state") {
        setState(f);
        if (f.display) setWatchDisp(f.display);
      }
      if (f.type === "computer.watching") {
        setWatchId(f.watchId);
        if (f.display) setWatchDisp(f.display);
      }
      // input replies are per-client — ok:false means the tap/type didn't land
      if (f.type === "ok" && typeof f.action === "string") {
        setInputErr(
          f.ok === false ? f.detail || f.error || "input didn't land" : null,
        );
      }
      if (f.type === "computer.frame") {
        frames.current++;
        setShot({ b64: f.imageBase64, w: f.width, h: f.height, ms: f.tookMs });
        if (f.cursor) setCursor({ x: f.cursor.x, y: f.cursor.y });
      }
      if (f.type === "computer.screenshot" || f.type === "computer.observe") {
        setShot({ b64: f.imageBase64, w: f.width, h: f.height, ms: f.tookMs });
        if (f.windows) setWindows(f.windows);
        if (f.cursor) setCursor({ x: f.cursor.x, y: f.cursor.y });
      }
      if (f.type === "computer.windows") setWindows(f.windows || []);
      if (f.type === "computer.cursor" && typeof f.x === "number")
        setCursor({ x: f.x, y: f.y });
      if (f.type === "computer.unwatched" || f.type === "computer.watch_error")
        setWatchId(null);
      // start ack has no `path`/`format` — get/meta and mp4 replies do
      if (f.type === "computer.recording" && !f.path && !f.format) {
        recStart.current = f.startedAt || Date.now();
        setRecId(f.id);
        setRecElapsed(0);
      }
      if (f.type === "computer.recorded" || f.type === "computer.record.finished")
        setRecId(null);
      if (f.type === "computer.recordings") {
        const live = (f.recordings || []).find((r: any) => r.live);
        if (live) {
          recStart.current = live.startedAt;
          setRecId(live.id);
          setRecElapsed(Math.max(0, Date.now() - live.startedAt));
        }
      }
      if (f.type === "error" && f.recordingId) setRecId(f.recordingId); // "already recording" — adopt it
    });
    return () => {
      off();
      clearInterval(poll);
      clearInterval(winPoll);
      clearInterval(meter);
      rig.trySend({ type: "computer.unwatch" });
    };
  }, [connected]);

  const shotPoint = (lx: number, ly: number) => {
    if (!shot || !box.current.w) return null;
    const scale = Math.min(box.current.w / shot.w, box.current.h / shot.h);
    const dispW = shot.w * scale;
    const dispH = shot.h * scale;
    const ox = (box.current.w - dispW) / 2;
    const oy = (box.current.h - dispH) / 2;
    const x = Math.round((lx - ox) / scale);
    const y = Math.round((ly - oy) / scale);
    if (x < 0 || y < 0 || x > shot.w || y > shot.h) return null;
    return { x, y };
  };

  // elapsed ticker for the REC pill — reset happens in the frame handler
  useEffect(() => {
    if (!recId) return;
    const iv = setInterval(
      () => setRecElapsed(Math.max(0, Date.now() - recStart.current)),
      500
    );
    return () => clearInterval(iv);
  }, [recId]);

  const toggleRec = () => {
    Haptics.impactAsync(
      recId ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light
    );
    rig.trySend(
      recId
        ? { type: "computer.record.stop", id: recId }
        : { type: "computer.record.start", intervalMs: 250, scale: 0.5 }
    );
  };

  const fmtRec = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const tapShot = (e: GestureResponderEvent) => {
    if (!controlling) return;
    const p = shotPoint(e.nativeEvent.locationX, e.nativeEvent.locationY);
    if (!p) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    rig.trySend({
      type: "computer.click",
      x: p.x,
      y: p.y,
      shotW: shot!.w,
      shotH: shot!.h,
      ...(watchDisp ? { display: watchDisp } : {}),
    });
  };

  // Drag on the live view scrolls the remote display — flick up = scroll down.
  const scrollBudget = useSharedValue(0);
  const lastTy = useSharedValue(0);
  const sendScroll = (dir: "up" | "down", lx: number, ly: number) => {
    const p = shotPoint(lx, ly);
    rig.trySend({
      type: "computer.scroll",
      direction: dir,
      times: 1,
      ...(watchDisp ? { display: watchDisp } : {}),
      ...(p ? { x: p.x, y: p.y, shotW: shot!.w, shotH: shot!.h } : {}),
    });
  };
  /* eslint-disable react-hooks/refs -- RNGH gesture callbacks run on the gesture thread; shared values are the correct primitive */
  const pan = Gesture.Pan()
    .enabled(controlling)
    .minDistance(18)
    .onStart(() => {
      lastTy.value = 0;
      scrollBudget.value = 0;
    })
    .onUpdate((e) => {
      scrollBudget.value += e.translationY - lastTy.value;
      lastTy.value = e.translationY;
      const TICK = 28;
      while (Math.abs(scrollBudget.value) > TICK) {
        const dir = scrollBudget.value < 0 ? "down" : "up";
        scrollBudget.value += dir === "down" ? TICK : -TICK;
        runOnJS(sendScroll)(dir, e.x, e.y);
      }
    });
  /* eslint-enable react-hooks/refs */

  const permsOk = state?.perms ? state.perms.capture && state.perms.inject : null;
  const res = state?.resolution;

  return (
    <Screen pad={14}>
      <Header
        title="Screen"
        subtitle={
          hostInfo?.hostname
            ? `${hostInfo.hostname} · ${state?.backend || "native"} display`
            : "live rig display"
        }
        right={
          watchId ? (
            <View style={styles.livePill}>
              <View style={styles.liveDot} />
              <Text style={[FONT.pill, { color: T.ok }]}>Live</Text>
            </View>
          ) : (
            <View style={[styles.livePill, { backgroundColor: T.controlBg }]}>
              <Text style={[FONT.pill, { color: T.sub }]}>Paused</Text>
            </View>
          )
        }
      />

      {/* Screen — full-bleed live view, tap forwards clicks while controlling */}
      <Animated.View entering={FadeIn.duration(300)} style={styles.screenCard}>
        <GestureDetector gesture={pan}>
        <Pressable
          onPress={tapShot}
          onLayout={(e: LayoutChangeEvent) => {
            const dims = {
              w: e.nativeEvent.layout.width,
              h: e.nativeEvent.layout.height,
            };
            box.current = dims;
            setBoxSize(dims);
          }}
          style={StyleSheet.absoluteFill}
        >
          {shot ? (
            <Image
              source={{ uri: `data:image/jpeg;base64,${shot.b64}` }}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.noFrame]}>
              <Icon name="desktopcomputer" android="computer" color={T.faint} size={34} />
              <Text style={[FONT.small, { color: T.sub, marginTop: 10 }]}>
                Connecting to the rig’s display…
              </Text>
              {permsOk === false ? (
                <Text style={[FONT.tiny, { color: T.warn, marginTop: 6, textAlign: "center" }]}>
                  Screen Recording / Accessibility permission missing on the host
                </Text>
              ) : null}
            </View>
          )}
          {shot && cursor
            ? (() => {
                const scale = Math.min(boxSize.w / shot.w, boxSize.h / shot.h);
                const ox = (boxSize.w - shot.w * scale) / 2;
                const oy = (boxSize.h - shot.h * scale) / 2;
                return (
                  <View
                    style={[
                      styles.cursorDot,
                      { left: ox + cursor.x * scale - 5, top: oy + cursor.y * scale - 5 },
                    ]}
                  />
                );
              })()
            : null}
        </Pressable>
        </GestureDetector>

        {/* Status overlay */}
        <View pointerEvents="none" style={styles.statusOverlay}>
          <View style={styles.statusChip}>
            {Platform.OS === "ios" ? (
              <GlassView
                style={StyleSheet.absoluteFill}
                glassEffectStyle="regular"
                tintColor="rgba(255,255,255,0.75)"
              />
            ) : null}
            <View
              style={[
                styles.chipDot,
                { backgroundColor: controlling ? T.warn : T.ok },
              ]}
            />
            <Text style={[FONT.pill, { color: T.ink }]}>
              {controlling ? "You’re in control" : "omp has control"}
            </Text>
          </View>
        </View>

        {/* REC indicator — visible in both modes, tap to stop */}
        {recId ? (
          <View pointerEvents="box-none" style={styles.recOverlay}>
            <PressScale onPress={toggleRec} style={styles.recChip} hitSlop={6}>
              <View style={styles.recChipDot} />
              <Text style={[FONT.pill, { color: "#fff" }]}>{fmtRec(recElapsed)}</Text>
              <Icon name="stop.fill" android="stop" color="#fff" size={11} />
            </PressScale>
          </View>
        ) : null}
      </Animated.View>

      {/* Two-state control */}
      <View style={styles.controlRow}>
        {controlling ? (
          <>
            <PressScale
              onPress={() => {
                Haptics.selectionAsync();
                setControlling(false);
              }}
              style={[styles.controlPill, { backgroundColor: T.ink }]}
            >
              <Icon name="hand.raised.fill" android="pan_tool" color="#fff" size={14} />
              <Text style={[FONT.small, { color: "#fff", ...fw("600") }]}>I’m done</Text>
            </PressScale>
            <View style={styles.typedRow}>
              <TextInput
                value={typeText}
                onChangeText={setTypeText}
                placeholder="type into the rig…"
                placeholderTextColor={T.placeholder}
                style={styles.typedInput}
                returnKeyType="send"
                onSubmitEditing={() => {
                  if (typeText) {
                    rig.trySend({
                      type: "computer.type",
                      text: typeText,
                      ...(watchDisp ? { display: watchDisp } : {}),
                    });
                    setTypeText("");
                  }
                }}
              />
              <PressScale
                onPress={() => {
                  if (typeText) {
                    rig.trySend({
                      type: "computer.type",
                      text: typeText,
                      ...(watchDisp ? { display: watchDisp } : {}),
                    });
                    setTypeText("");
                  }
                }}
                hitSlop={8}
              >
                <Icon name="keyboard" android="keyboard" color={T.sub} size={18} />
              </PressScale>
            </View>
          </>
        ) : (
          <>
            <View style={{ flex: 1 }}>
              <Text style={[FONT.small, { color: T.sub }]} numberOfLines={1}>
                {state?.hostname || hostInfo?.hostname || "rig"}
                {res
                  ? ` · ${res.width || res[0] || "?"}×${res.height || res[1] || "?"}`
                  : ""}
                {cursor ? ` · ptr ${cursor.x},${cursor.y}` : ""}
                {fps > 0 ? ` · ${fps}f/s` : ""}
              </Text>
            </View>
            <PressScale
              onPress={() => {
                Haptics.selectionAsync();
                router.push("/recordings");
              }}
              style={styles.iconBtn}
              hitSlop={6}
            >
              <Icon name="film" android="movie" color={T.sub} size={16} />
            </PressScale>
            <PressScale
              onPress={toggleRec}
              style={[styles.recPill, recId ? styles.recPillOn : undefined]}
              hitSlop={6}
            >
              {recId ? (
                <>
                  <View style={styles.recDot} />
                  <Text style={[FONT.small, { color: T.bad, ...fw("700") }]}>
                    {fmtRec(recElapsed)}
                  </Text>
                  <Icon name="stop.fill" android="stop" color={T.bad} size={13} />
                </>
              ) : (
                <Icon
                  name="record.circle"
                  android="fiber_manual_record"
                  color={T.bad}
                  size={18}
                />
              )}
            </PressScale>
            <PressScale
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setControlling(true);
              }}
              style={[styles.controlPill, { backgroundColor: "#0B0B0E" }]}
            >
              <Icon name="cursorarrow.rays" android="ads_click" color="#fff" size={14} />
              <Text style={[FONT.small, { color: "#fff", ...fw("600") }]}>Take over</Text>
            </PressScale>
          </>
        )}
      </View>

      {inputErr ? (
        <Text style={[FONT.tiny, { color: T.bad, marginTop: 6 }]} numberOfLines={2}>
          {inputErr}
        </Text>
      ) : null}

      {/* Windows — proof it's a real machine */}
      {windows.length ? (
        <View style={styles.winCard}>
          <Text style={[FONT.tiny, { color: T.faint, letterSpacing: 1, paddingBottom: 6 }]}>
            WINDOWS ON THE RIG · {windows.length}
          </Text>
          <ScrollView
            style={{ maxHeight: 130 }}
            showsVerticalScrollIndicator={false}
          >
            {windows.slice(0, 12).map((w, i) => (
              <PressScale
                key={i}
                onPress={() =>
                  controlling &&
                  rig.trySend({ type: "computer.window.activate", id: w.id })
                }
                style={({ pressed }) => [
                  styles.winRow,
                  pressed && { backgroundColor: T.controlBg },
                ]}
              >
                <View
                  style={[
                    styles.winDot,
                    { backgroundColor: w.active ? T.ok : "rgba(0,0,0,0.18)" },
                  ]}
                />
                <Text
                  style={[FONT.small, { color: w.active ? T.ink : T.sub, flex: 1 }]}
                  numberOfLines={1}
                >
                  {w.title || "(untitled)"}
                </Text>
                <Text style={[FONT.tiny, { color: T.faint }]}>
                  {w.w}×{w.h}
                </Text>
              </PressScale>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: T.rPill,
    backgroundColor: "rgba(31,168,92,0.10)",
  },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.ok },
  screenCard: {
    flex: 1,
    minHeight: 220,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "#141417",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    ...T.shadow,
  },
  noFrame: { alignItems: "center", justifyContent: "center" },
  cursorDot: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#0B0B0E",
    borderWidth: 1.5,
    borderColor: "#fff",
  },
  statusOverlay: { position: "absolute", top: 10, left: 10 },
  recOverlay: { position: "absolute", top: 10, right: 10 },
  recChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: T.rPill,
    backgroundColor: "rgba(224,62,62,0.88)",
  },
  recChipDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#fff" },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.cardBg,
    borderWidth: StyleSheet.hairlineWidth * 1.5,
    borderColor: T.hairline,
  },
  recPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 36,
    height: 36,
    justifyContent: "center",
    paddingHorizontal: 9,
    borderRadius: T.rPill,
    backgroundColor: T.cardBg,
    borderWidth: StyleSheet.hairlineWidth * 1.5,
    borderColor: T.hairline,
  },
  recPillOn: { backgroundColor: "rgba(224,62,62,0.09)", borderColor: "rgba(224,62,62,0.3)" },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: T.bad },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: T.rPill,
    overflow: "hidden",
    backgroundColor: Platform.OS === "ios" ? "transparent" : "rgba(255,255,255,0.85)",
  },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  controlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: T.rPill,
  },
  typedRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: T.cardBg,
    borderRadius: T.rPill,
    borderWidth: StyleSheet.hairlineWidth * 1.5,
    borderColor: T.hairline,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  typedInput: { flex: 1, fontSize: 13.5, color: T.ink, paddingVertical: 0 },
  winCard: {
    backgroundColor: T.cardBg,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
  },
  winRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRadius: 8,
  },
  winDot: { width: 6, height: 6, borderRadius: 3 },
});
