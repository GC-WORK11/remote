// Browser — the phone's window into whatever is served on the rig.
// The rig answers on its own address (Tailscale or LAN), so dev servers,
// dashboards and docs running on the laptop are reachable directly — type
// a port or a full URL, it just loads.
import React, { useCallback, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Screen } from "../../components/glass";
import { Icon } from "../../components/icon";
import { NativeWebView } from "../../components/webview-loader";
import { T, FONT, fw } from "../../theme";
import { rig } from "../../rig";
import { useRig } from "../../state";
import { PressScale } from "../../components/pressable";

function IFrame({ url, onLoad }: { url: string; onLoad: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const uce = require("react-native-web").unstable_createElement;
  return uce("iframe", {
    src: url,
    onLoad,
    style: {
      border: "none",
      width: "100%",
      height: "100%",
      flex: 1,
      backgroundColor: "#FFFFFF",
    },
  });
}

// "3000", ":3000", "localhost:3000", "example.com" → a loadable http(s) URL
// rooted at the rig's own host. Explicit http(s):// URLs pass through.
function toUrl(input: string, rigHost: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const portOnly = s.match(/^:?(\d{2,5})$/);
  if (portOnly) return `http://${rigHost}:${portOnly[1]}`;
  s = s.replace(/^localhost:/, `${rigHost}:`).replace(/^127\.0\.0\.1:/, `${rigHost}:`);
  return `http://${s}`;
}

export default function Browser() {
  const { connected } = useRig();
  const params = useLocalSearchParams<{ url?: string }>();
  const host = rig.host === "127.0.0.1" ? "127.0.0.1" : rig.host;
  const [url, setUrl] = useState(() => toUrl(params.url || "", host) || `http://${host}:3000`);
  const [bar, setBar] = useState(() => (params.url ? String(params.url) : ""));
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const webRef = useRef<any>(null);

  const go = useCallback(() => {
    const next = toUrl(bar || url, host);
    if (!next) return;
    setLoaded(false);
    setFailed(false);
    setUrl(next);
  }, [bar, url, host]);

  return (
    <Screen pad={0}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={styles.topBar}>
          <PressScale
            onPress={() => (router.canGoBack() ? router.back() : router.navigate("/home"))}
            style={styles.circleBtn}
            hitSlop={8}
            accessibilityLabel="Back"
          >
            <Icon name="chevron.left" android="arrow_back" color={T.ink} size={16} />
          </PressScale>
          <View style={styles.addrPill}>
            <Icon name="globe" android="language" color={T.faint} size={12} />
            <TextInput
              value={bar}
              onChangeText={setBar}
              placeholder={url.replace(/^https?:\/\//, "")}
              placeholderTextColor={T.faint}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={go}
              style={[FONT.small, styles.addr, { color: T.ink }]}
            />
            <PressScale onPress={go} hitSlop={8} accessibilityLabel="Go">
              <Icon name="arrow.forward" android="arrow_forward" color={T.ink} size={14} />
            </PressScale>
          </View>
          <PressScale
            onPress={() => {
              setLoaded(false);
              setFailed(false);
              webRef.current?.reload?.();
            }}
            style={styles.circleBtn}
            hitSlop={8}
            accessibilityLabel="Reload"
          >
            <Icon name="arrow.clockwise" android="refresh" color={T.sub} size={14} />
          </PressScale>
        </View>

        <View style={styles.web}>
          {connected ? (
            Platform.OS === "web" ? (
              <IFrame url={url} onLoad={() => setLoaded(true)} />
            ) : NativeWebView ? (
              <NativeWebView
                ref={webRef}
                source={{ uri: url }}
                style={{ flex: 1, backgroundColor: "#FFFFFF" }}
                onLoadEnd={() => setLoaded(true)}
                onError={() => {
                  setLoaded(true);
                  setFailed(true);
                }}
                sharedCookiesEnabled
              />
            ) : null
          ) : null}
          {!loaded && connected ? (
            <View style={styles.center}>
              <View style={styles.dot} />
              <Text style={[FONT.small, { color: T.faint }]} numberOfLines={1}>
                {url.replace(/^https?:\/\//, "")}
              </Text>
            </View>
          ) : null}
          {failed || !connected ? (
            <View style={styles.center}>
              <Icon name="wifi.exclamationmark" android="wifi_off" color={T.faint} size={26} />
              <Text style={[FONT.small, { color: T.sub, marginTop: 10 }]}>
                {connected ? "Couldn't reach that page" : "Not connected"}
              </Text>
              <Text style={[FONT.tiny, { color: T.faint, marginTop: 4, textAlign: "center" }]}>
                {connected
                  ? "Port or address on your computer — e.g. 3000 or localhost:8080"
                  : "Pair with your computer first"}
              </Text>
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: T.hairline,
  },
  circleBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: T.pillBg,
    alignItems: "center",
    justifyContent: "center",
  },
  addrPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: T.pillBg,
  },
  addr: { flex: 1, padding: 0, fontSize: 14, color: T.ink, ...fw("400") },
  web: { flex: 1, backgroundColor: T.surfaceSoft },
  center: {
    ...(StyleSheet.absoluteFill as object),
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    backgroundColor: T.surfaceSoft,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: T.working,
    marginBottom: 10,
  },
});
