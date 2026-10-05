import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  Linking,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { T, FONT, fw } from "../theme";
import { Icon } from "./icon";
import { rig } from "../rig";
import { useRig } from "../state";
import { MiniCheck, Spinner } from "./bubbles";
import { PressScale } from "./pressable";

const SPRING = { damping: 26, stiffness: 220, overshootClamping: false };

// Provider auth sheet — the vault lives on the host (omp agent.db / broker).
// Phone brokers the flow: catalog + authed flags via auth.list, a live login
// child whose stdout streams as auth.event (URL → open on host OR on phone for
// device/paste flows, paste answers via auth.input, cancel via auth.cancel).
export function AuthSheet() {
  const {
    authSheet,
    setAuthSheet,
    authProviders,
    authEvents,
    authLive,
    authStart,
    hostInfo,
  } = useRig();
  const insets = useSafeAreaInsets();
  const [paste, setPaste] = useState("");
  const progress = useSharedValue(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (authSheet) {
      // Deferred so the sheet mounts before the spring runs (same pattern
      // as the drawer — direct setState in the effect trips the lint gate).
      Promise.resolve().then(() => {
        setMounted(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      });
    }
    progress.value = authSheet ? withSpring(1, SPRING) : withTiming(0, { duration: 160 });
    if (!authSheet) {
      const t = setTimeout(() => setMounted(false), 200);
      return () => clearTimeout(t);
    }
  }, [authSheet]); // eslint-disable-line react-hooks/exhaustive-deps

  const bgStyle = useAnimatedStyle(() => ({ opacity: progress.value * 0.32 }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(progress.value, [0, 1], [560, 0]) }],
  }));

  const connected = useMemo(() => authProviders.filter((p) => p.authed), [authProviders]);
  const others = useMemo(() => {
    // Subscription providers people actually bring first — commandcode is
    // a first-class subscription (not a Codex/Claude alias).
    const top = ["commandcode", "openai-codex", "anthropic", "google", "gemini", "openrouter"];
    const rank = (id: string) => {
      const i = top.indexOf(id);
      return i < 0 ? top.length : i;
    };
    return authProviders
      .filter((p) => !p.authed)
      .slice()
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  }, [authProviders]);
  const lastUrl = useMemo(() => {
    for (let i = authEvents.length - 1; i >= 0; i--) if (authEvents[i].url) return authEvents[i].url;
    return null;
  }, [authEvents]);
  const done = useMemo(() => {
    const d = [...authEvents].reverse().find((e) => e.kind === "done");
    return authLive ? null : d || null;
  }, [authEvents, authLive]);
  const tail = useMemo(() => authEvents.filter((e) => e.kind !== "done").slice(-4), [authEvents]);
  const lastPrompt = useMemo(() => {
    const p = [...authEvents].reverse().find((e) => e.kind === "prompt" || e.kind === "done");
    return p?.kind === "prompt" && p.text ? p.text.replace(/:$/, "").trim() : null;
  }, [authEvents]);

  const close = () => setAuthSheet(false);

  const Row = ({ p }: { p: any }) => (
    <PressScale
      disabled={!!authLive || p.authed}
      onPress={() => {
        Haptics.selectionAsync();
        setPaste("");
        authStart(p.id);
      }}
      style={({ pressed }) => [styles.prow, pressed && !authLive && !p.authed && { opacity: 0.7 }]}
    >
      {p.authed ? (
        <MiniCheck size={15} />
      ) : authLive === p.id ? (
        <Spinner size={13} />
      ) : (
        <View style={styles.pdot} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[FONT.body, { color: T.ink, fontSize: 15 }]} numberOfLines={1}>
          {p.id}
        </Text>
        <Text style={[FONT.tiny, { color: T.faint }]} numberOfLines={1}>
          {p.label}
        </Text>
      </View>
      {p.authed ? (
        <Text style={[FONT.tiny, { color: T.ok, ...fw("600") }]}>in</Text>
      ) : null}
    </PressScale>
  );

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* backdrop */}
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "#221a10" }, bgStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>
      {/* bottom sheet */}
      <Animated.View
        style={[styles.sheet, sheetStyle, { paddingBottom: insets.bottom + 18 }]}
      >
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.grabber} />
          <Text style={[FONT.tiny, styles.sheetLabel]}>SIGN IN</Text>

          {/* live login card — streams the host's login stdout */}
          {authLive || done ? (
            <View style={styles.liveCard}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                {authLive ? <Spinner size={13} /> : <MiniCheck ok={!!done?.ok} size={15} />}
                <Text style={[FONT.small, { color: T.ink, ...fw("700"), flex: 1 }]}>
                  {authLive ? `Signing in — ${authLive}` : done?.ok ? "Signed in" : "Not signed in"}
                </Text>
                {authLive ? (
                  <PressScale hitSlop={8} onPress={() => rig.authCancel()}>
                    <Text style={[FONT.tiny, { color: T.bad, ...fw("600") }]}>cancel</Text>
                  </PressScale>
                ) : null}
              </View>

              {lastUrl ? (
                <View style={styles.urlRow}>
                  <PressScale
                    style={styles.urlBtn}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      // Loopback OAuth callbacks must land on the rig's own
                      // browser — open it there, per-OS opener.
                      try {
                        rig.hostOpen(lastUrl, hostInfo?.os);
                      } catch {}
                    }}
                  >
                    <Icon name="safari" android="open_in_new" color="#fff" size={13} />
                    <Text style={[FONT.small, { color: "#fff", ...fw("700"), fontSize: 13 }]}>
                      Open on laptop
                    </Text>
                  </PressScale>
                  <PressScale
                    style={styles.urlBtnGhost}
                    onPress={() => Linking.openURL(lastUrl).catch(() => {})}
                  >
                    <Text style={[FONT.small, { color: T.ink, ...fw("700"), fontSize: 13 }]}>
                      Open on phone
                    </Text>
                  </PressScale>
                </View>
              ) : null}

              {tail.map((e, i) => {
                // login children sometimes echo a JSON error body inline —
                // keep the prose, drop the blob.
                const raw = String(e.text || e.url || "");
                const t = raw.includes(": {") ? raw.slice(0, raw.indexOf(": {")) : raw;
                // the buttons above already say "open the page" — skip that line
                if (/^open this url/i.test(t.trim())) return null;
                return (
                  <Text key={i} style={[FONT.tiny, { color: T.sub, marginTop: 4 }]} numberOfLines={2}>
                    {t}
                  </Text>
                );
              })}

              {authLive ? (
                <View style={styles.pasteRow}>
                  <TextInput
                    value={paste}
                    onChangeText={setPaste}
                    placeholder={lastPrompt || "Paste code / redirect URL"}
                    placeholderTextColor={T.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.pasteInput}
                  />
                  <PressScale
                    disabled={!paste.trim()}
                    onPress={() => {
                      rig.authInput(paste.trim());
                      setPaste("");
                    }}
                    style={({ pressed }) => [
                      styles.pasteSend,
                      (pressed || !paste.trim()) && { opacity: 0.5 },
                    ]}
                  >
                    <Icon name="arrow.up" android="arrow_upward" color="#fff" size={14} />
                  </PressScale>
                </View>
              ) : null}
            </View>
          ) : null}

          <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
            {connected.length ? (
              <Text style={[FONT.tiny, styles.groupLabel]}>SIGNED IN</Text>
            ) : null}
            {connected.map((p) => (
              <Row key={p.id} p={p} />
            ))}
            {others.length ? <Text style={[FONT.tiny, styles.groupLabel]}>ADD</Text> : null}
            {others.map((p) => (
              <Row key={p.id} p={p} />
            ))}
            {!authProviders.length ? (
              <Text
                style={[FONT.small, { color: T.faint, paddingVertical: 18, textAlign: "center" }]}
              >
                Loading…
              </Text>
            ) : null}
          </ScrollView>
          <Text style={[FONT.tiny, { color: T.faint, paddingTop: 8 }]}>
            Keys never leave your laptop.
          </Text>
        </KeyboardAvoidingView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#F8F7F4",
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 18,
    paddingTop: 10,
    ...T.shadowTight,
  },
  grabber: {
    alignSelf: "center",
    width: 38,
    height: 4.5,
    borderRadius: 3,
    backgroundColor: T.hairlineStrong,
    marginBottom: 12,
  },
  sheetLabel: { color: T.faint, letterSpacing: 1.2, paddingBottom: 10 },
  groupLabel: { color: T.faint, letterSpacing: 1.1, paddingTop: 12, paddingBottom: 5 },
  prow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: 12,
  },
  pdot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: T.hairlineStrong,
    marginHorizontal: 3,
  },
  liveCard: {
    backgroundColor: T.cardBgTint,
    borderRadius: 16,
    padding: 12,
    gap: 4,
    marginBottom: 6,
  },
  urlRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  urlBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: T.ink,
    borderRadius: 20,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  urlBtnGhost: {
    borderRadius: 20,
    paddingHorizontal: 13,
    paddingVertical: 8,
    backgroundColor: T.controlBg,
    justifyContent: "center",
  },
  pasteRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 9 },
  pasteInput: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13.5,
    color: T.ink,
    ...fw("400"),
  },
  pasteSend: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: T.ink,
    alignItems: "center",
    justifyContent: "center",
  },
});
