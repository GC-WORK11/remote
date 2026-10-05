import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Modal,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import { Screen, Enter } from "../components/glass";
import { T, FONT, fw } from "../theme";
import { rig } from "../rig";
import { useRig } from "../state";
import { Icon } from "../components/icon";
import { Buddy } from "../components/mascot";
import { AsciiMeadow } from "../components/ascii";
import { PressScale } from "../components/pressable";
import { ShimmerText } from "../components/bubbles";

type Step = "host" | "pair";

// The scanner's sweep — a soft light line breathing up and down the reticle.
function ScanLine() {
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1900, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 1900, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value * 196 }],
    opacity: 0.5 + 0.4 * Math.sin(y.value * Math.PI),
  }));
  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          left: 14,
          right: 14,
          top: 12,
          height: 3,
          borderRadius: 2,
          backgroundColor: "rgba(255,255,255,0.9)",
          shadowColor: "#fff",
          shadowOpacity: 0.8,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 0 },
        },
        style,
      ]}
    />
  );
}

export default function Connect() {
  const { resume } = useRig();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("8790");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>("host");
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState(false);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  // Parsed pairing link awaiting the "Found {host}" confirm — the spec's
  // paste flow shows what was found before it connects.
  const [found, setFound] = useState<{ host: string; port: number; code?: string; token?: string } | null>(null);
  // The boot splash — covers the saved-device auto-connect so launch is
  // garden → app, never garden → flash → app.
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let dead = false;
    const t0 = Date.now();
    // Hold the garden a beat — the bloom entrance must read even when
    // storage answers instantly (the splash is the app's brand moment).
    const settle = () => {
      const wait = Math.max(0, 1150 - (Date.now() - t0));
      setTimeout(() => !dead && setBooting(false), wait);
    };
    (async () => {
      const h = await AsyncStorage.getItem("rigHost");
      if (h) setHost(h);
      const savedPort = await AsyncStorage.getItem("rigPort");
      if (savedPort) setPort(savedPort);
      const p = parseInt(savedPort || port, 10) || 8790;
      await rig.loadToken(h || host);
      if (!rig.token || dead) {
        settle();
        return;
      }
      // saved device — auto-connect
      try {
        const info = await rig.probe(h || host, p);
        if (info) setInfo(info);
        resume();
        await rig.connect(h || host, p);
        rig.markAuthed();
        if (!dead) router.replace("/home");
      } catch {
        settle();
      }
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fail = (e: any) => {
    setErr(String(e?.message || e));
    setBusy(false);
  };

  const go = async () => {
    // A remote:// link (or ompr pair JSON) pasted into the address field
    // takes the same route as the paste/scan buttons — never feed it to
    // the socket builder as a hostname.
    const pasted = parseRigUri(host.trim());
    if (pasted) {
      if (pasted.token) return connectToken(pasted.host, pasted.port, pasted.token);
      return doPair(pasted.code, pasted.host, pasted.port);
    }
    setBusy(true);
    setErr("");
    try {
      const p = parseInt(port, 10) || 8790;
      const probe = await rig.probe(host.trim(), p);
      setInfo(probe);
      await rig.loadToken(host.trim());
      resume();
      await rig.connect(host.trim(), p);
      await AsyncStorage.setItem("rigHost", host.trim());
      await AsyncStorage.setItem("rigPort", String(p));
      if (rig.token) {
        rig.markAuthed();
        setBusy(false);
        router.replace("/home");
        return;
      }
      setStep("pair");
      setBusy(false);
    } catch (e) {
      fail(e);
    }
  };

  // Pairing payloads the rig can print: {"url":"ws://h:p/ws","code":"123456"}
  // from `ompr pair`, the remote://pair?url=…&code=… link, and the daemon's
  // `remote://host:port#fragment` URI where the fragment is a pair code
  // (short, digits) or an already-minted device token (everything else).
  const parseRigUri = (data: string):
    | { host: string; port: number; code?: string; token?: string }
    | null => {
    let url: string | undefined;
    let scanned: string | undefined;
    try {
      const j = JSON.parse(data);
      url = j.url;
      scanned = j.code != null ? String(j.code) : undefined;
    } catch {
      let m = /^remote:\/\/pair\?(.*)$/.exec(data);
      if (m) {
        const q = new URLSearchParams(m[1]);
        url = q.get("url") || undefined;
        scanned = q.get("code") || undefined;
      } else {
        // host is a name/IPv4, or a bracketed IPv6 literal ([fe80::1])
        m = /^remote:\/\/(\[[0-9a-fA-F:.]+\]|[^:/\s#]+)(?::(\d+))?#(.+)$/.exec(data);
        if (m) {
          const h = m[1];
          url = `ws://${h.includes(":") && !h.startsWith("[") ? `[${h}]` : h}:${m[2] || "8790"}`;
          const frag = decodeURIComponent(m[3]);
          // a short all-digit fragment is a pending pair code; longer is a token
          if (/^\d{4,8}$/.test(frag)) scanned = frag;
          else return { host: h, port: parseInt(m[2] || "8790", 10), token: frag };
        }
      }
    }
    const hp = url ? /wss?:\/\/(\[[0-9a-fA-F:.]+\]|[^:/]+)(?::(\d+))?/.exec(url) : null;
    if (!hp) return null;
    return { host: hp[1], port: parseInt(hp[2] || "8790", 10), code: scanned };
  };

  const doPair = async (codeIn?: string, hostIn?: string, portIn?: number) => {
    const pasted = parseRigUri(codeIn ?? code);
    if (pasted) {
      if (pasted.token) return connectToken(pasted.host, pasted.port, pasted.token);
      return doPair(pasted.code, pasted.host, pasted.port);
    }
    const codeVal = (codeIn ?? code).trim();
    const hostVal = (hostIn ?? host).trim();
    const portVal = portIn ?? (parseInt(port, 10) || 8790);
    setBusy(true);
    setErr("");
    try {
      resume();
      // pairing rides the unauthenticated socket — open it first when the
      // QR path skipped the manual host→connect step
      if (!rig.connected) await rig.connect(hostVal, portVal);
      await rig.pair(codeVal, Platform.OS === "web" ? "Remote web" : `Remote ${Platform.OS}`);
      rig.close();
      resume();
      await AsyncStorage.setItem("rigHost", hostVal);
      await AsyncStorage.setItem("rigPort", String(portVal));
      await rig.connect(hostVal, portVal);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setBusy(false);
      router.replace("/home");
    } catch (e) {
      fail(e);
    }
  };

  // token path — the fragment was a device token, not a pair code: save
  // it per-host and ride the authenticated socket straight to /home
  const connectToken = async (hostVal: string, portVal: number, token: string) => {
    setBusy(true);
    setErr("");
    try {
      resume();
      await rig.loadToken(hostVal);
      await rig.saveToken(hostVal, token);
      await AsyncStorage.setItem("rigHost", hostVal);
      await AsyncStorage.setItem("rigPort", String(portVal));
      await rig.connect(hostVal, portVal);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setBusy(false);
      router.replace("/home");
    } catch (e) {
      fail(e);
    }
  };

  // `ompr pair` prints a QR carrying {"url":"ws://ip:port/ws","code":"123456"};
  // `omprd --qr` prints remote://host:port#code-or-token — both land here.
  const onScan = ({ data }: { data: string }) => {
    setScanning(false);
    const p = parseRigUri(data);
    if (!p || (!p.code && !p.token)) {
      setErr("That QR isn't from Remote — scan the one in your computer's terminal.");
      return;
    }
    setHost(p.host);
    setPort(String(p.port));
    if (p.code) setCode(p.code);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (p.token) connectToken(p.host, p.port, p.token);
    else doPair(p.code, p.host, p.port);
  };

  // Paste → parse → "Found {host}" confirm card → Connect. The link never
  // touches the socket until the user confirms the parsed host. Clipboard
  // denials land on the friendly line, not the crash overlay.
  const pasteLink = async () => {
    let text = "";
    try {
      text = await Clipboard.getStringAsync();
    } catch {
      setErr("Couldn't read the clipboard — paste the link into the address field instead.");
      return;
    }
    const p = parseRigUri(text.trim());
    if (!p) {
      setErr("Clipboard doesn't hold a pairing link — copy the link the terminal printed.");
      return;
    }
    setErr("");
    setFound(p);
    Haptics.selectionAsync();
  };

  const connectFound = async () => {
    if (!found) return;
    const p = found;
    setFound(null);
    setHost(p.host);
    setPort(String(p.port));
    if (p.code) setCode(p.code);
    if (p.token) return connectToken(p.host, p.port, p.token);
    if (p.code) return doPair(p.code, p.host, p.port);
    return doPair(undefined, p.host, p.port);
  };

  const openScanner = async () => {
    if (!camPerm?.granted) {
      const p = await requestCamPerm();
      if (!p.granted) {
        setErr("Remote needs camera access to scan the QR code.");
        return;
      }
    }
    setErr("");
    setScanning(true);
  };

  return (
    <Screen>
      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={scanning ? onScan : undefined}
          />
          {/* corner-bracket reticle — the aesthetic scanner frame */}
          <View style={styles.scanReticle} pointerEvents="none">
            {(
              [
                { left: 0, top: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 20 },
                { right: 0, top: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 20 },
                { left: 0, bottom: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 20 },
                { right: 0, bottom: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 20 },
              ] as const
            ).map((c, i) => (
              <View key={i} style={[{ position: "absolute", width: 44, height: 44, borderColor: "rgba(255,255,255,0.95)" }, c]} />
            ))}
            <ScanLine />
          </View>
          <PressScale style={styles.scanClose} onPress={() => setScanning(false)} hitSlop={10}>
            <Icon name="xmark" android="close" color="#fff" size={22} />
          </PressScale>
          <Text style={styles.scanHint}>Point at the QR in your terminal</Text>
        </View>
      </Modal>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {booting ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <AsciiMeadow width={230} />
            <Buddy k="remote" color="#34A853" size={76} style={{ marginTop: 18 }} />
            <Text style={[FONT.hero, { color: T.ink, marginTop: 12 }]}>Remote</Text>
            <View style={{ marginTop: 8 }}>
              <ShimmerText text="Waking your rig…" style={{ fontSize: 13 }} />
            </View>
          </View>
        ) : (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <Enter style={{ alignItems: "center" }}>
            {/* the thin ASCII flower — pixel bloom with the brand cloud
                tucked in its corner */}
            <View style={styles.bloomCard}>
              <AsciiMeadow width={252} />
              <View style={styles.bloomBuddy}>
                <Buddy k="remote" color="#34A853" size={30} />
              </View>
            </View>
            {__DEV__ ? (
              <PressScale
                onLongPress={() => router.push("/dev-thread")}
                delayLongPress={450}
                accessibilityLabel="Remote"
              >
                <Text style={[FONT.hero, { color: T.ink, marginTop: 14 }]}>Remote</Text>
              </PressScale>
            ) : (
              <Text style={[FONT.hero, { color: T.ink, marginTop: 14 }]}>Remote</Text>
            )}
            <Text
              style={[
                FONT.body,
                {
                  color: T.sub,
                  marginTop: 10,
                  textAlign: "center",
                  lineHeight: 23,
                  letterSpacing: -0.12,
                },
              ]}
            >
              Your computer does the work.{"\n"}This is the remote.
            </Text>
          </Enter>

          <Enter delay={120} style={{ marginTop: 38, alignSelf: "stretch" }}>
            {/* Grok landing anatomy: one black pill, a white secondary,
                a quiet text link — no card, no form. */}
            <View style={styles.ctaCol}>
              {step === "host" && !found && (
                <>
                  <Text style={[FONT.small, { color: T.sub, textAlign: "center" }]}>
                    It shows in the terminal where Remote is running.
                  </Text>
                  {/* Spec: paste-the-link is the primary black pill —
                      everywhere, not just web. */}
                  <PressScale
                    disabled={busy}
                    onPress={pasteLink}
                    style={({ pressed }) => [
                      styles.heroBtn,
                      busy && { backgroundColor: "#C9C9CE" },
                      pressed && { opacity: 0.9, transform: [{ scale: 0.98 }] },
                    ]}
                  >
                    <Icon name="link" android="link" color="#fff" size={17} />
                    <Text style={[FONT.head, { color: "#fff", flex: 1 }]}>
                      Paste the link
                    </Text>
                    <Icon name="arrow.right" android="arrow_forward" color="rgba(255,255,255,0.7)" size={15} />
                  </PressScale>
                  {Platform.OS !== "web" ? (
                    <PressScale
                      disabled={busy}
                      onPress={openScanner}
                      style={({ pressed }) => [
                        styles.ghostBtn,
                        pressed && { opacity: 0.7, transform: [{ scale: 0.99 }] },
                      ]}
                    >
                      <Icon name="camera.viewfinder" android="photo_camera" color={T.ink} size={17} />
                      <Text style={[FONT.small, { color: T.ink, ...fw("600"), flex: 1 }]}>
                        Scan the QR instead
                      </Text>
                    </PressScale>
                  ) : null}
                  <PressScale
                    disabled={busy}
                    onPress={() => setManual((v) => !v)}
                    style={({ pressed }) => [styles.quietLink, pressed && { opacity: 0.6 }]}
                  >
                    <Text style={[FONT.small, { color: T.faint, ...fw("600") }]}>
                      {manual ? "Hide the address" : "Type the address yourself"}
                    </Text>
                  </PressScale>
                  {manual ? (
                    <>
                      {/* One joined pill — address : port + a black send
                          circle, not a two-box form. */}
                      <View style={styles.addrPill}>
                        <TextInput
                          value={host}
                          onChangeText={setHost}
                          placeholder="192.168.1.20"
                          placeholderTextColor={T.placeholder}
                          autoCapitalize="none"
                          autoCorrect={false}
                          keyboardType="url"
                          style={styles.addrHost}
                        />
                        <Text style={{ color: T.faint, fontSize: 15 }}>:</Text>
                        <TextInput
                          value={port}
                          onChangeText={setPort}
                          placeholder="8790"
                          placeholderTextColor={T.placeholder}
                          keyboardType="number-pad"
                          style={styles.addrPort}
                        />
                        <PressScale
                          disabled={busy || !host.trim()}
                          onPress={() => {
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                            go();
                          }}
                          style={({ pressed }) => [
                            styles.goCircle,
                            (!host.trim() || busy) && { backgroundColor: "#C9C9CE" },
                            pressed && { transform: [{ scale: 0.94 }] },
                          ]}
                          accessibilityRole="button"
                          accessibilityLabel="Connect"
                        >
                          <Icon name="arrow.up" android="arrow_upward" color="#fff" size={15} />
                        </PressScale>
                      </View>
                      {info ? (
                        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}>
                          <View style={styles.okDot} />
                          <Text style={[FONT.small, { color: T.sub }]}>
                            {`Found ${info.hostname || "your computer"}`}
                            {info.sessions != null ? ` · ${info.sessions} conversations saved` : ""}
                          </Text>
                        </View>
                      ) : null}
                    </>
                  ) : null}
                </>
              )}
              {/* "Found {host}" — parsed confirmation before connecting. */}
              {step === "host" && found ? (
                <View style={styles.foundCard}>
                  <View style={styles.okDot} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[FONT.head, { color: T.ink, fontSize: 15 }]} numberOfLines={1}>
                      Found {found.host.replace(/^\[|\]$/g, "")}
                    </Text>
                    <Text style={[FONT.tiny, { color: T.sub, marginTop: 1 }]}>
                      {found.token
                        ? "Signed-in link — connects right away"
                        : found.code
                          ? `Pair code ${found.code} · port ${found.port}`
                          : `Port ${found.port} — you'll pair next`}
                    </Text>
                  </View>
                  <PressScale
                    disabled={busy}
                    onPress={connectFound}
                    style={({ pressed }) => [styles.foundGo, pressed && { opacity: 0.85 }]}
                    accessibilityRole="button"
                    accessibilityLabel="Connect"
                  >
                    <Text style={[FONT.small, { color: "#fff", ...fw("700") }]}>
                      {busy ? "Connecting…" : "Connect"}
                    </Text>
                  </PressScale>
                  <PressScale
                    onPress={() => setFound(null)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss"
                  >
                    <Icon name="xmark" android="close" color={T.faint} size={15} />
                  </PressScale>
                </View>
              ) : null}

              {step === "pair" && (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 }}>
                    <Icon name="lock.shield" android="verified_user" color={T.ink} size={16} />
                    <Text style={[FONT.small, { color: T.sub, flex: 1 }]}>
                      Type the code shown on your computer — it&apos;s in the
                      terminal where Remote is running.
                    </Text>
                  </View>
                  <TextInput
                    value={code}
                    onChangeText={(t) => {
                      setCode(t);
                      if (/^\d{6}$/.test(t.trim()) && !busy) doPair(t.trim());
                    }}
                    placeholder="6-digit code"
                    placeholderTextColor={T.placeholder}
                    keyboardType="number-pad"
                    autoFocus
                    style={styles.codePill}
                  />
                  <PressScale
                    disabled={busy || code.trim().length < 4}
                    onPress={() => doPair()}
                    style={({ pressed }) => [
                      styles.heroBtn,
                      (busy || code.trim().length < 4) && { backgroundColor: "#C9C9CE" },
                      pressed && { transform: [{ scale: 0.98 }] },
                    ]}
                  >
                    <Text style={[FONT.head, { color: "#fff", flex: 1 }]}>
                      {busy ? "Pairing…" : "Pair"}
                    </Text>
                    <Icon name="arrow.right" android="arrow_forward" color="rgba(255,255,255,0.7)" size={15} />
                  </PressScale>
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    {Platform.OS !== "web" ? (
                      <PressScale
                        disabled={busy}
                        onPress={openScanner}
                        style={({ pressed }) => [
                          styles.ghostBtn,
                          { flex: 1 },
                          pressed && { opacity: 0.7 },
                        ]}
                      >
                        <Icon name="camera.viewfinder" android="photo_camera" color={T.ink} size={16} />
                        <Text style={[FONT.small, { color: T.ink, ...fw("600") }]}>
                          Scan QR
                        </Text>
                      </PressScale>
                    ) : null}
                    <PressScale
                      disabled={busy}
                      onPress={pasteLink}
                      style={({ pressed }) => [
                        styles.ghostBtn,
                        { flex: 1 },
                        pressed && { opacity: 0.7 },
                      ]}
                    >
                      <Icon name="link" android="link" color={T.ink} size={16} />
                      <Text style={[FONT.small, { color: T.ink, ...fw("600") }]}>
                        Paste link
                      </Text>
                    </PressScale>
                  </View>
                </>
              )}
              {err ? (
                <Text style={[FONT.small, { color: T.bad, textAlign: "center", marginTop: 2 }]}>
                  {err}
                </Text>
              ) : null}
            </View>
          </Enter>

          <Enter delay={240} style={{ marginTop: 24 }}>
            <Text style={[FONT.small, { color: T.faint, textAlign: "center" }]}>
              Straight to your computer — nothing in between.
            </Text>
          </Enter>
        </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bloomCard: {
    backgroundColor: "#FDF3F0",
    borderRadius: 26,
    paddingVertical: 18,
    paddingHorizontal: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#F0D8D2",
    alignItems: "center",
    ...T.shadowTight,
  },
  bloomBuddy: {
    position: "absolute",
    right: 10,
    bottom: 10,
  },
  ctaCol: {
    gap: 13,
    alignSelf: "stretch",
    paddingHorizontal: 10,
  },
  // Grok landing CTA — one fat black pill, soft drop shadow.
  heroBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderRadius: 27,
    height: 54,
    paddingHorizontal: 20,
    backgroundColor: "#0B0B0E",
    ...T.shadowFloat,
  },
  // The secondary — quiet soft-gray pill, clearly under the black CTA.
  ghostBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: T.rPill,
    paddingVertical: 13,
    paddingHorizontal: 16,
    backgroundColor: T.fieldBg,
  },
  quietLink: { alignItems: "center", paddingVertical: 4 },
  // The manual path — a single joined pill (address : port + send circle)
  // so the rig address never looks like a form.
  addrPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "#FFFFFF",
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    paddingLeft: 17,
    paddingRight: 6,
    paddingVertical: 6,
    ...T.shadowTight,
  },
  addrHost: { flex: 1, fontSize: 15, color: T.ink, paddingVertical: 9, ...fw("400") },
  addrPort: { width: 50, fontSize: 15, color: T.ink, paddingVertical: 9, ...fw("400") },
  goCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#0B0B0E",
    alignItems: "center",
    justifyContent: "center",
  },
  codePill: {
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    height: 62,
    ...FONT.mono,
    fontSize: 24,
    letterSpacing: 9,
    textAlign: "center",
    color: T.ink,
    ...T.shadowTight,
  },
  scanReticle: {
    position: "absolute",
    alignSelf: "center",
    top: "28%",
    width: 230,
    height: 230,
  },
  scanClose: {
    position: "absolute",
    top: 60,
    right: 24,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  scanHint: {
    position: "absolute",
    bottom: 90,
    alignSelf: "center",
    color: "rgba(255,255,255,0.9)",
    fontSize: 14,
  },
  okDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.ok },
  foundCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...T.shadowTight,
  },
  foundGo: {
    backgroundColor: "#0B0B0E",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
});
