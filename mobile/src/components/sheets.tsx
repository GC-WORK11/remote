// Global bottom-sheets — browser sheet + workspace-status (slide-to-merge).
// The bus lives in sheetbus.ts (leaf module); <GlobalSheets/> mounts once
// in _layout. Spec: 28pt top radius, 36×4 grabber, dimmed backdrop, X
// close, swipe-down dismisses, sheets never stack (one slot at a time).
//
// The sheets are absolute-fill overlays, NOT <Modal>: PanResponder (and the
// whole responder system) does not fire inside RN-web's Modal portal, and
// this app's iOS build shows the same failure inside native Modal. A plain
// absolutely-positioned view gets gestures everywhere.
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  PanResponder,
  Animated,
  Easing,
  Platform,
  Linking,
  BackHandler,
  ScrollView,
  TextInput,
  Switch,
  useWindowDimensions,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./icon";
import { ShimmerText } from "./bubbles";
import { T, FONT, fw, tilde } from "../theme";
import { rig } from "../rig";
import { useRig } from "../state";
import {
  subscribeSheet,
  sheetSnap,
  closeSheet,
  setMergePhase,
  useMergePhase,
  openChangesSheet,
  gitCall,
  rigCall,
} from "./sheetbus";
import type { MergeTarget } from "./sheetbus";
import { NativeWebView } from "./webview-loader";
import { PressScale } from "./pressable";

export function GlobalSheets() {
  const sheet = useSyncExternalStore(subscribeSheet, sheetSnap, () => null);
  if (!sheet) return null;
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {sheet.kind === "browser" ? (
        <BrowserSheet key={sheet.url} url={sheet.url} />
      ) : sheet.kind === "merge" ? (
        <MergeSheet key={sheet.url} sheet={sheet} />
      ) : sheet.kind === "session" ? (
        <SessionSheet key={sheet.sessionId} sessionId={sheet.sessionId} title={sheet.title} />
      ) : sheet.kind === "changes" ? (
        <ChangesSheet key={sheet.sessionId} sessionId={sheet.sessionId} title={sheet.title} />
      ) : sheet.kind === "spawn" ? (
        <SpawnSheet key={sheet.parentId} parentId={sheet.parentId} />
      ) : (
        <RoutinesSheet />
      )}
    </View>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function prNumberOf(url: string): string | null {
  const m = url.match(/\/(?:pull|merge_requests|-\/merge_requests)\/(\d+)/i);
  return m ? `#${m[1]}` : null;
}

// Slides the card up on mount + dims the backdrop; Android back = dismiss.
function useSheetEnter(onClose: () => void) {
  const [enter] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [enter]);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);
  return enter;
}

// ---------------------------------------------------------------------------
// BrowserSheet — Cursor Mobile's in-app browser: near-full-height sheet,
// grabber, X close, lock + host bar, external-open shortcut. Tap-only
// trigger; loads lazily when summoned.
// ---------------------------------------------------------------------------

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

function BrowserSheet({ url }: { url: string }) {
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const enter = useSheetEnter(closeSheet);
  const [drag] = useState(() => new Animated.Value(0));
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const host = hostOf(url);
  const sheetH = Math.max(340, Math.round(dims.height - Math.max(insets.top, 24) - 34));

  const [pan] = useState(() =>
    PanResponder.create({  // drag strip — swipe-down dismisses (spec)
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.4,
      onPanResponderMove: (_e, g) => {
        drag.setValue(Math.max(0, g.dy));
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 140 || g.vy > 0.9) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          Animated.timing(drag, { toValue: 900, duration: 180, useNativeDriver: true }).start(() =>
            closeSheet()
          );
        } else {
          Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
      },
    })
  );

  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [sheetH, 0] });
  const cardY = Animated.add(drag, rise);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[styles.back, { opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
      </Animated.View>
      <Animated.View
        style={[
          styles.browserCard,
          { height: sheetH, paddingBottom: Math.max(insets.bottom, 10), transform: [{ translateY: cardY }] },
        ]}
      >
        {/* header strip is the drag zone — the WebView keeps its own gestures */}
        <View {...pan.panHandlers}>
          <View style={styles.grabber} />
          <View style={styles.browHead}>
            <PressScale
              onPress={closeSheet}
              hitSlop={8}
              style={({ pressed }) => [styles.circleBtn, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Icon name="xmark" android="close" color={T.sub} size={15} />
            </PressScale>
            <View style={styles.hostBar}>
              <Icon name="lock.fill" android="lock" color={T.faint} size={11} />
              <Text style={[FONT.small, styles.hostText]} numberOfLines={1}>
                {host}
              </Text>
            </View>
            <PressScale
              onPress={() => Linking.openURL(url).catch(() => {})}
              hitSlop={8}
              style={({ pressed }) => [styles.circleBtn, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Open in browser"
            >
              <Icon name="arrow.up.right" android="open_in_new" color={T.sub} size={14} />
            </PressScale>
          </View>
        </View>

        <View style={styles.webBox}>
          {Platform.OS === "web" ? (
            <IFrame url={url} onLoad={() => setLoaded(true)} />
          ) : failed ? null : (
            <NativeWebView
              source={{ uri: url }}
              style={{ flex: 1, backgroundColor: "#FFFFFF" }}
              onLoadEnd={() => setLoaded(true)}
              onError={() => {
                setLoaded(true);
                setFailed(true);
              }}
              sharedCookiesEnabled
            />
          )}
          {!loaded ? (
            <View style={styles.webLoading}>
              <View style={styles.webLoadingDot} />
              <Text style={[FONT.small, { color: T.faint }]}>Loading {host}…</Text>
            </View>
          ) : null}
          {failed || (Platform.OS === "web" && loaded) ? (
            <PressScale
              onPress={() => Linking.openURL(url).catch(() => {})}
              style={({ pressed }) => [styles.webFailBar, pressed && { opacity: 0.75 }]}
            >
              <Text style={[FONT.tiny, { color: T.faint, flex: 1 }]} numberOfLines={1}>
                {failed
                  ? `${host} couldn't load in the sheet —`
                  : `${host} may block embedded views —`}
              </Text>
              <Text style={[FONT.tiny, { color: T.ink, ...fw("700") }]}>Open ↗</Text>
            </PressScale>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// MergeSheet — Cursor's workspace-status sheet, dark half-sheet: Status /
// Description / Author / Branch / Pull-request rows + the slide-to-merge
// capsule at the bottom. Slide fires rig.pr.merge (squash + delete branch);
// gh's own error surfaces inline when the host can't merge.
// ---------------------------------------------------------------------------

function MergeSheet({ sheet }: { sheet: MergeTarget }) {
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const enter = useSheetEnter(closeSheet);
  const [drag] = useState(() => new Animated.Value(0));
  const phase = useMergePhase(sheet.url);
  const [slid, setSlid] = useState(false);
  const [mergeErr, setMergeErr] = useState<string | null>(null);
  const prNum = prNumberOf(sheet.url);
  const host = hostOf(sheet.url);

  const finish = () => {
    setSlid(true);
    setMergeErr(null);
    // Real merge — rig.pr.merge runs the host's authed `gh pr merge`.
    // Squash + delete branch is the modern default; the ok:false reply
    // carries gh's own stderr verbatim and we surface it honestly.
    setMergePhase(sheet.url, "merging");
    rig
      .fsCall("rig.pr.merge", { url: sheet.url, method: "squash", deleteBranch: true }, 45000)
      .then((r: any) => {
        if (r?.ok) {
          setMergePhase(sheet.url, "merged");
          setTimeout(closeSheet, 700);
        } else {
          setMergePhase(sheet.url, "idle");
          setSlid(false);
          setMergeErr(String(r?.error || "gh refused the merge"));
        }
      })
      .catch((e: Error) => {
        setMergePhase(sheet.url, "idle");
        setSlid(false);
        setMergeErr(e?.message || "Merge request timed out");
      });
  };

  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.4,
      onPanResponderMove: (_e, g) => {
        drag.setValue(Math.max(0, g.dy));
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 140 || g.vy > 0.9) {
          Animated.timing(drag, { toValue: 900, duration: 180, useNativeDriver: true }).start(() =>
            closeSheet()
          );
        } else {
          Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
      },
    })
  );

  const statusText =
    phase === "merged" ? "Merged" : phase === "merging" || slid ? "Merging…" : "Ready to merge";

  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [dims.height, 0] });
  const cardY = Animated.add(drag, rise);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[styles.back, { opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
      </Animated.View>
      <Animated.View
        style={[
          styles.mergeCard,
          { paddingBottom: Math.max(insets.bottom, 14), transform: [{ translateY: cardY }] },
        ]}
      >
        <View {...pan.panHandlers}>
          <View style={styles.mGrabber} />
          <View style={styles.mergeHead}>
            <Text style={[FONT.small, styles.mergeTitle]}>Workspace status</Text>
            <PressScale
              onPress={closeSheet}
              hitSlop={8}
              style={({ pressed }) => [styles.mCircleBtn, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Icon name="xmark" android="close" color="rgba(255,255,255,0.62)" size={15} />
            </PressScale>
          </View>
        </View>

        <View style={styles.mrow}>
          <Text style={[FONT.small, styles.mlabel]}>Status</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {phase === "merged" ? (
              <View style={styles.okDot}>
                <Icon name="checkmark" android="check" color="#fff" size={9} />
              </View>
            ) : null}
            <Text
              style={[
                FONT.small,
                { ...fw("700"), color: phase === "merging" || slid ? "rgba(255,255,255,0.6)" : T.ok },
              ]}
            >
              {statusText}
            </Text>
          </View>
        </View>
        {sheet.title ? (
          <View style={styles.mrow}>
            <Text style={[FONT.small, styles.mlabel]}>Description</Text>
            <Text numberOfLines={2} style={[FONT.small, styles.mvalue]}>
              {sheet.title}
            </Text>
          </View>
        ) : null}
        {sheet.author ? (
          <View style={styles.mrow}>
            <Text style={[FONT.small, styles.mlabel]}>Author</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
              <View style={styles.authorDot}>
                <Text style={{ color: "#fff", fontSize: 9.5, ...fw("800") }}>
                  {(sheet.author.replace(/^@/, "")[0] || "?").toUpperCase()}
                </Text>
              </View>
              <Text style={[FONT.small, styles.mvalue]}>{sheet.author}</Text>
            </View>
          </View>
        ) : null}
        {sheet.branch ? (
          <View style={styles.mrow}>
            <Text style={[FONT.small, styles.mlabel]}>Branch</Text>
            <Text numberOfLines={1} style={[FONT.mono, { color: "#F2F1EE", fontSize: 12, flexShrink: 1 }]}>
              {sheet.branch}
            </Text>
          </View>
        ) : null}
        <PressScale
          style={({ pressed }) => [styles.mrow, pressed && { opacity: 0.7 }]}
          onPress={() => Linking.openURL(sheet.url).catch(() => {})}
        >
          <Text style={[FONT.small, styles.mlabel]}>Pull request</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={[FONT.small, styles.mvalue]}>{prNum || host}</Text>
            <Icon name="arrow.up.right" android="open_in_new" color="rgba(255,255,255,0.4)" size={11} />
          </View>
        </PressScale>

        {mergeErr ? (
          <Text style={[FONT.tiny, styles.mergeErr]} numberOfLines={3}>
            {mergeErr}
          </Text>
        ) : null}
        {phase === "merged" ? (
          <View style={styles.mergedPill}>
            <View style={styles.okDot}>
              <Icon name="checkmark" android="check" color="#fff" size={9} />
            </View>
            <Text style={[FONT.head, { color: T.ok, fontSize: 15 }]}>Merged</Text>
          </View>
        ) : slid || phase === "merging" ? (
          <View style={styles.slideTrack}>
            <ShimmerText text="Merging" style={{ fontSize: 13.5, ...fw("700"), color: T.ok }} />
          </View>
        ) : (
          <SlideToMerge onDone={finish} />
        )}
      </Animated.View>
    </View>
  );
}

// The slider — a capsule track, green thumb with →, label fades as the thumb
// travels; release past ~80% completes. Module singleton: one MergeSheet can
// be on screen at a time (one sheet slot), so the gesture machinery lives
// outside React — the compiler forbids useState-value mutation and ref reads
// inside lazy initializers.
const SLIDE_THUMB = 52;
const slide = (() => {
  const dx = new Animated.Value(0);
  const done = { fn: null as null | (() => void) };
  const track = { w: 0 };
  const max = () => Math.max(1, track.w - SLIDE_THUMB - 10);
  const slideTo = (x: number) => {
    dx.setValue(Math.max(0, Math.min(x, max())));
  };
  const releaseAt = (x: number) => {
    if (x > max() * 0.8) {
      Animated.timing(dx, { toValue: max(), duration: 130, useNativeDriver: false }).start(() =>
        done.fn?.()
      );
    } else {
      Animated.spring(dx, { toValue: 0, useNativeDriver: false, bounciness: 8 }).start();
    }
  };
  const cancel = () => {
    Animated.spring(dx, { toValue: 0, useNativeDriver: false }).start();
  };
  const pan = PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) =>
      Math.abs(g.dx) > 4 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderGrant: () => {
      Haptics.selectionAsync();
    },
    onPanResponderMove: (_e, g) => {
      slideTo(g.dx);
    },
    onPanResponderRelease: (_e, g) => {
      releaseAt(g.dx);
    },
    onPanResponderTerminate: cancel,
  });
  return { dx, pan, done, track };
})();

function SlideToMerge({ onDone }: { onDone: () => void }) {
  return Platform.OS === "web" ? (
    <SlideToMergeWeb onDone={onDone} />
  ) : (
    <SlideToMergePan onDone={onDone} />
  );
}

// Web: RN-web's pointer→responder bridge doesn't cancel native text
// selection, so PanResponder loses the drag to the browser. Drive the thumb
// with real DOM pointer events (setPointerCapture) on a raw div instead.
function DomThumb({
  x,
  onGrant,
  onMove,
  onRelease,
}: {
  x: number;
  onGrant: (clientX: number) => void;
  onMove: (clientX: number) => void;
  onRelease: (clientX: number) => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const uce = require("react-native-web").unstable_createElement;
  return uce("div", {
    onPointerDown: (e: any) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      onGrant(e.clientX);
    },
    onPointerMove: (e: any) => {
      if (e.buttons || e.currentTarget.hasPointerCapture?.(e.pointerId)) onMove(e.clientX);
    },
    onPointerUp: (e: any) => onRelease(e.clientX),
    onPointerCancel: () => onRelease(-1e9),
    style: {
      position: "absolute",
      left: x + 5,
      top: 5,
      width: SLIDE_THUMB,
      height: SLIDE_THUMB,
      borderRadius: SLIDE_THUMB / 2,
      backgroundColor: "#1BA672",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "#fff",
      fontSize: 20,
      ...fw("800"),
      cursor: "grab",
      touchAction: "none",
      userSelect: "none",
      zIndex: 2,
    },
    children: "✓",
  });
}

function SlideToMergeWeb({ onDone }: { onDone: () => void }) {
  const [x, setX] = useState(0);
  const [trackW, setTrackW] = useState(0);
  const startX = useRef(0);
  const cur = useRef(0);
  const done = useRef(false);
  const max = Math.max(1, trackW - SLIDE_THUMB - 10);

  const move = (clientX: number) => {
    if (done.current) return;
    const v = Math.max(0, Math.min(clientX - startX.current, max));
    cur.current = v;
    setX(v);
  };
  const release = (clientX: number) => {
    if (done.current) return;
    const v = clientX === -1e9 ? 0 : cur.current;
    if (v > max * 0.8) {
      done.current = true;
      cur.current = max;
      setX(max);
      onDone();
    } else {
      cur.current = 0;
      setX(0);
    }
  };

  return (
    <View
      style={styles.slideTrack}
      onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
    >
      <View
        style={[
          styles.slideFill,
          { width: x + SLIDE_THUMB + 10 },
        ]}
      />
      <Text
        style={[
          styles.slideLabel,
          { opacity: Math.max(0, 1 - x / 70), userSelect: "none" as never },
        ]}
      >
        Slide to merge
      </Text>
      <DomThumb
        x={x}
        onGrant={(cx) => {
          startX.current = cx;
        }}
        onMove={move}
        onRelease={(cx) => {
          move(cx);
          release(cx);
        }}
      />
    </View>
  );
}

function SlideToMergePan({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    slide.done.fn = onDone;
    slide.dx.setValue(0); // fresh slide each mount
  }); // every render — onDone may be a fresh closure
  const THUMB = SLIDE_THUMB;

  const fillW = Animated.add(slide.dx, THUMB + 10);
  const labelS = {
    opacity: slide.dx.interpolate({
      inputRange: [0, 70],
      outputRange: [1, 0],
      extrapolate: "clamp",
    }),
  };
  return (
    <View
      style={styles.slideTrack}
      {...slide.pan.panHandlers}
      onLayout={(e) => {
        slide.track.w = e.nativeEvent.layout.width;
      }}
    >
      <Animated.View style={[styles.slideFill, { width: fillW }]} />
      <Animated.Text style={[styles.slideLabel, labelS]}>Slide to merge</Animated.Text>
      <Animated.View
        style={[styles.slideThumb, { width: THUMB, transform: [{ translateX: slide.dx }] }]}
      >
        <Icon name="checkmark" android="check" color="#fff" size={19} weight="bold" />
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// SessionSheet — the long-press sheet on a session row/card. Actions: View
// changes (rig.git.* → ChangesSheet) and Delete session (session.delete),
// which asks once in place. Deletion is real and daemon-wide — the
// session.deleted broadcast drops every row itself.
// ---------------------------------------------------------------------------

// SpawnSheet — the manual sub-agent surface (research: docs/SUBAGENT-UX.md).
// One anchored control in the thread head opens this; the child inherits the
// parent's cwd on the wire (session.spawn) so we show it, not offer a picker.
function SpawnSheet({ parentId }: { parentId: string }) {
  const insets = useSafeAreaInsets();
  const enter = useSheetEnter(closeSheet);
  const { sessions } = useRig();
  const parent = sessions.find((s: any) => (s.id || s.sessionId) === parentId);
  const cwd = parent?.cwd ? tilde(String(parent.cwd)) : "";
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const spawn = () => {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    setErr("");
    rig
      .sessionSpawn({ parentId, prompt: p })
      .then(() => closeSheet())
      .catch((e) => {
        setErr(String((e as Error)?.message || e));
        setBusy(false);
      });
  };

  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [300, 0] });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[styles.back, { opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
      </Animated.View>
      <Animated.View
        style={[
          styles.actionCard,
          { paddingBottom: Math.max(insets.bottom, 14), transform: [{ translateY: rise }] },
        ]}
      >
        <View style={styles.grabber} />
        <Text style={[FONT.head, { color: T.ink, fontSize: 16, marginTop: 10 }]}>New sub-agent</Text>
        {cwd ? (
          <Text style={[FONT.tiny, { color: T.faint, marginTop: 3 }]} numberOfLines={1}>
            Runs in {cwd}
          </Text>
        ) : null}
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should the sub-agent do?"
          placeholderTextColor={T.faint}
          autoFocus
          multiline
          maxLength={4000}
          editable={!busy}
          style={[styles.renameInput, { height: 84, textAlignVertical: "top", paddingTop: 10 }]}
        />
        {err ? (
          <Text style={[FONT.tiny, { color: T.bad, marginTop: 4 }]} numberOfLines={3}>
            {err}
          </Text>
        ) : null}
        <View style={styles.actionBtnRow}>
          <PressScale
            onPress={closeSheet}
            style={({ pressed }) => [styles.actionBtn, styles.actionBtnGhost, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={[FONT.head, { color: T.ink, fontSize: 14.5 }]}>Cancel</Text>
          </PressScale>
          <PressScale
            onPress={spawn}
            disabled={!prompt.trim() || busy}
            style={({ pressed }) => [
              styles.actionBtn,
              styles.actionBtnDark,
              (!prompt.trim() || busy) && { opacity: 0.45 },
              pressed && { opacity: 0.8 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Start sub-agent"
          >
            <Text style={[FONT.head, { color: "#fff", fontSize: 14.5 }]}>
              {busy ? "Spawning…" : "Start"}
            </Text>
          </PressScale>
        </View>
      </Animated.View>
    </View>
  );
}

function SessionSheet({ sessionId, title }: { sessionId: string; title: string }) {
  const insets = useSafeAreaInsets();
  const enter = useSheetEnter(closeSheet);
  const { sessions } = useRig();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(title);
  const [usage, setUsage] = useState<null | "loading" | any>(null);
  // rig.pr.create — `gh pr create --fill` in the session's own cwd; the
  // reply shows the real URL gh printed or its stderr verbatim.
  const [pr, setPr] = useState<null | "loading" | { url?: string; error?: string }>(null);
  const sess = sessions.find(
    (s: any) => (s.id || s.sessionId) === sessionId
  ) as any;
  const sessCwd = sess?.cwd;
  const sessPinned = !!sess?.pinned;
  const sessHidden = !!sess?.hidden;

  // session.meta — daemon persists + rebroadcasts, so the change lands on
  // every device; the sheet just collapses.
  const setMeta = (patch: Record<string, unknown>) => {
    try {
      rig.send({ type: "session.meta", sessionId, ...patch });
    } catch {}
    setTimeout(closeSheet, 200);
  };

  const loadUsage = () => {
    setUsage("loading");
    rigCall("rig.usage", {}, ["rig.usage"], 15000)
      .then((r) => setUsage(r))
      .catch((e: Error) => setUsage({ error: e?.message || "rig unreachable" }));
  };

  const openPr = () => {
    if (!sessCwd) {
      setPr({ error: "This session has no working directory yet" });
      return;
    }
    setPr("loading");
    rig
      .prCreate({ cwd: sessCwd, fill: true })
      .then((f) => {
        if (f.ok && f.url) setPr({ url: String(f.url) });
        else
          setPr({
            error: String(f.error || f.output || "gh pr create failed").slice(0, 240),
          });
      })
      .catch((e: Error) => setPr({ error: e?.message || "rig unreachable" }));
  };

  const doDelete = () => {
    setDeleting(true);
    try {
      rig.send({ type: "session.delete", sessionId });
    } catch {}
    // The session.deleted broadcast updates every list; just collapse.
    setTimeout(closeSheet, 250);
  };

  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [300, 0] });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[styles.back, { opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
      </Animated.View>
      <Animated.View
        style={[
          styles.actionCard,
          { paddingBottom: Math.max(insets.bottom, 14), transform: [{ translateY: rise }] },
        ]}
      >
        <View style={styles.grabber} />
        {renaming ? (
          <>
            <Text style={[FONT.head, { color: T.ink, fontSize: 16, marginTop: 10 }]}>
              Rename
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Name this thread"
              placeholderTextColor={T.faint}
              autoFocus
              maxLength={120}
              returnKeyType="done"
              onSubmitEditing={() => {
                const t = name.trim();
                if (!t) return;
                try {
                  rig.send({ type: "session.rename", sessionId, title: t });
                } catch {}
                // session.renamed broadcast updates every row.
                setTimeout(closeSheet, 200);
              }}
              style={styles.renameInput}
            />
            <View style={styles.actionBtnRow}>
              <PressScale
                onPress={() => setRenaming(false)}
                style={({ pressed }) => [styles.actionBtn, styles.actionBtnGhost, pressed && { opacity: 0.7 }]}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={[FONT.head, { color: T.ink, fontSize: 14.5 }]}>Cancel</Text>
              </PressScale>
              <PressScale
                onPress={() => {
                  const t = name.trim();
                  if (!t) return;
                  try {
                    rig.send({ type: "session.rename", sessionId, title: t });
                  } catch {}
                  setTimeout(closeSheet, 200);
                }}
                style={({ pressed }) => [styles.actionBtn, styles.actionBtnDark, pressed && { opacity: 0.8 }]}
                accessibilityRole="button"
                accessibilityLabel="Save name"
              >
                <Text style={[FONT.head, { color: "#fff", fontSize: 14.5 }]}>Save</Text>
              </PressScale>
            </View>
          </>
        ) : usage !== null ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10 }}>
              <PressScale
                onPress={() => setUsage(null)}
                hitSlop={10}
                style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityLabel="Back"
              >
                <Icon name="chevron.left" android="chevron_left" color={T.ink} size={16} />
              </PressScale>
              <Text style={[FONT.head, { color: T.ink, fontSize: 16, marginLeft: 6 }]}>Usage</Text>
            </View>
            {usage === "loading" ? (
              <View style={{ paddingVertical: 26, alignItems: "center" }}>
                <ShimmerText text="Reading token ledger" style={{ fontSize: 12, ...fw("600"), color: T.faint }} />
              </View>
            ) : usage?.error ? (
              <Text style={[FONT.tiny, { color: T.sub, marginTop: 12, textAlign: "center" }]} numberOfLines={3}>
                {String(usage.error)}
              </Text>
            ) : (
              (() => {
                const row = Array.isArray(usage?.sessions)
                  ? usage.sessions.find((s: any) => s.sessionId === sessionId)
                  : null;
                const tok = Number(row?.tokens ?? -1);
                const peak = Number(row?.peakTokens ?? -1);
                const win = Number(row?.contextWindow ?? -1);
                const hit = Number(row?.cache?.hitPct ?? 0);
                const pct = tok > 0 && win > 0 ? Math.min(100, Math.round((100 * tok) / win)) : 0;
                const fmt = (n: number) => (n < 0 ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
                return (
                  <View style={{ marginTop: 14 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
                      <Text style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 14 }]}>Context</Text>
                      <Text style={[FONT.meta, { color: T.sub }]}>
                        {fmt(tok)}{win > 0 ? ` / ${fmt(win)}` : ""}
                      </Text>
                    </View>
                    <View style={{ height: 6, borderRadius: 3, backgroundColor: "rgba(0,0,0,0.07)", marginTop: 8, overflow: "hidden" }}>
                      <View style={{ width: `${Math.max(2, pct)}%`, height: 6, borderRadius: 3, backgroundColor: pct > 80 ? "#D64545" : "#1C1B1A" }} />
                    </View>
                    <View style={{ flexDirection: "row", marginTop: 14, gap: 10 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={[FONT.meta, { color: T.faint }]}>Peak</Text>
                        <Text style={[FONT.small, { color: T.ink, ...fw("700"), fontSize: 15 }]}>{fmt(peak)}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[FONT.meta, { color: T.faint }]}>Cache hit</Text>
                        <Text style={[FONT.small, { color: T.ink, ...fw("700"), fontSize: 15 }]}>
                          {hit > 0 ? `${Math.round(hit)}%` : "—"}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[FONT.meta, { color: T.faint }]}>Fleet live</Text>
                        <Text style={[FONT.small, { color: T.ink, ...fw("700"), fontSize: 15 }]}>
                          {fmt(Number(usage?.tokensLive ?? -1))}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })()
            )}
          </>
        ) : pr !== null ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10 }}>
              <PressScale
                onPress={() => setPr(null)}
                hitSlop={10}
                style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityLabel="Back"
              >
                <Icon name="chevron.left" android="chevron_left" color={T.ink} size={16} />
              </PressScale>
              <Text style={[FONT.head, { color: T.ink, fontSize: 16, marginLeft: 6 }]}>
                Pull request
              </Text>
            </View>
            {pr === "loading" ? (
              <View style={{ paddingVertical: 26, alignItems: "center" }}>
                <ShimmerText text="Running gh pr create" style={{ fontSize: 12, ...fw("600"), color: T.faint }} />
              </View>
            ) : pr.url ? (
              <View style={{ marginTop: 14, alignItems: "center" }}>
                <Icon name="checkmark.circle" android="check_circle" color={T.ok} size={26} />
                <PressScale onPress={() => Linking.openURL(pr.url!)} hitSlop={6}>
                  <Text
                    style={[FONT.small, { color: T.link, marginTop: 10, ...fw("600"), textAlign: "center" }]}
                    numberOfLines={2}
                  >
                    {pr.url}
                  </Text>
                </PressScale>
              </View>
            ) : (
              <Text
                style={[FONT.tiny, { color: T.sub, marginTop: 14, textAlign: "center" }]}
                numberOfLines={4}
              >
                {pr.error || "gh pr create failed"}
              </Text>
            )}
          </>
        ) : confirming ? (
          <>
            <Text style={[FONT.head, { color: T.ink, fontSize: 16, marginTop: 10, textAlign: "center" }]}>
              Delete {title}?
            </Text>
            <Text style={[FONT.small, { color: T.sub, marginTop: 6, textAlign: "center" }]}>
              Ends the session and erases it from the rig. This can’t be undone.
            </Text>
            <View style={styles.actionBtnRow}>
              <PressScale
                onPress={() => setConfirming(false)}
                style={({ pressed }) => [styles.actionBtn, styles.actionBtnGhost, pressed && { opacity: 0.7 }]}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={[FONT.head, { color: T.ink, fontSize: 14.5 }]}>Cancel</Text>
              </PressScale>
              <PressScale
                onPress={doDelete}
                style={({ pressed }) => [styles.actionBtn, styles.actionBtnDanger, pressed && { opacity: 0.8 }]}
                accessibilityRole="button"
                accessibilityLabel="Delete session"
              >
                {deleting ? (
                  <ShimmerText text="Deleting" style={{ fontSize: 14.5, ...fw("700"), color: "#fff" }} />
                ) : (
                  <Text style={[FONT.head, { color: "#fff", fontSize: 14.5 }]}>Delete</Text>
                )}
              </PressScale>
            </View>
          </>
        ) : (
          <>
            <Text style={[FONT.head, { color: T.ink, fontSize: 16, marginTop: 10 }]} numberOfLines={1}>
              {title}
            </Text>
            <PressScale
              onPress={() => {
                setName(title);
                setRenaming(true);
              }}
              style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: "rgba(0,0,0,0.04)" }]}
              accessibilityRole="button"
              accessibilityLabel="Rename session"
            >
              <Icon name="pencil" android="edit" color={T.ink} size={15} />
              <Text style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 14.5, flex: 1 }]}>
                Rename
              </Text>
              <Icon name="chevron.right" android="chevron_right" color={T.faint} size={12} />
            </PressScale>
            <PressScale
              onPress={() => setMeta({ pinned: !sessPinned })}
              style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: "rgba(0,0,0,0.04)" }]}
              accessibilityRole="button"
              accessibilityLabel={sessPinned ? "Unpin thread" : "Pin thread"}
            >
              <Icon name={sessPinned ? "pin.slash" : "pin.fill"} android="push_pin" color={T.ink} size={15} />
              <Text style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 14.5, flex: 1 }]}>
                {sessPinned ? "Unpin from top" : "Pin to top"}
              </Text>
              <Icon name="chevron.right" android="chevron_right" color={T.faint} size={12} />
            </PressScale>
            <PressScale
              onPress={() => setMeta({ hidden: !sessHidden })}
              style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: "rgba(0,0,0,0.04)" }]}
              accessibilityRole="button"
              accessibilityLabel={sessHidden ? "Unhide thread" : "Hide thread"}
            >
              <Icon
                name={sessHidden ? "eye" : "eye.slash"}
                android={sessHidden ? "visibility" : "visibility_off"}
                color={T.ink}
                size={15}
              />
              <Text style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 14.5, flex: 1 }]}>
                {sessHidden ? "Unhide from inbox" : "Hide from inbox"}
              </Text>
              <Icon name="chevron.right" android="chevron_right" color={T.faint} size={12} />
            </PressScale>
            <PressScale
              onPress={() => openChangesSheet(sessionId, title)}
              style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: "rgba(0,0,0,0.04)" }]}
              accessibilityRole="button"
              accessibilityLabel="View changes"
            >
              <Icon name="arrow.triangle.branch" android="account_tree" color={T.ink} size={15} />
              <Text style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 14.5, flex: 1 }]}>
                View changes
              </Text>
              <Icon name="chevron.right" android="chevron_right" color={T.faint} size={12} />
            </PressScale>
            <PressScale
              onPress={loadUsage}
              style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: "rgba(0,0,0,0.04)" }]}
              accessibilityRole="button"
              accessibilityLabel="Usage"
            >
              <Icon name="chart.bar" android="bar_chart" color={T.ink} size={15} />
              <Text style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 14.5, flex: 1 }]}>
                Usage
              </Text>
              <Icon name="chevron.right" android="chevron_right" color={T.faint} size={12} />
            </PressScale>
            {sessCwd ? (
              <PressScale
                onPress={openPr}
                style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: "rgba(0,0,0,0.04)" }]}
                accessibilityRole="button"
                accessibilityLabel="Open pull request"
              >
                <Icon name="arrow.triangle.pull" android="call_merge" color={T.ink} size={15} />
                <Text style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 14.5, flex: 1 }]}>
                  Open pull request
                </Text>
                <Icon name="chevron.right" android="chevron_right" color={T.faint} size={12} />
              </PressScale>
            ) : null}
            <PressScale
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                setConfirming(true);
              }}
              style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: "rgba(0,0,0,0.04)" }]}
              accessibilityRole="button"
              accessibilityLabel="Delete session"
            >
              <Icon name="trash" android="delete" color="#D64545" size={15} />
              <Text style={[FONT.small, { color: "#D64545", ...fw("600"), fontSize: 14.5, flex: 1 }]}>
                Delete session
              </Text>
            </PressScale>
            <PressScale
              onPress={closeSheet}
              style={({ pressed }) => [styles.actionRow, { justifyContent: "center" }, pressed && { opacity: 0.7 }]}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={[FONT.small, { color: T.sub, ...fw("600"), fontSize: 14.5 }]}>Cancel</Text>
            </PressScale>
          </>
        )}
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// ChangesSheet — the code-mode "Changes" surface over rig.git.status +
// rig.git.diff: status letter + path rows on top, the selected file's real
// patch in a mono pane below. Non-repo sessions get git's own error verbatim.
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<string, string> = {
  M: "#B07A4B",
  A: T.ok,
  D: "#E8453C",
  R: "#3B8BFF",
  "?": "#9A948C",
};
const DIFF_CAP = 40000;

function ChangesSheet({ sessionId, title }: { sessionId: string; title: string }) {
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const enter = useSheetEnter(closeSheet);
  const [status, setStatus] = useState<any | null>(null); // rig.git.result
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<any | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [tab, setTab] = useState<"files" | "cps">("files");
  const [cps, setCps] = useState<any[] | null>(null);
  const [cpSel, setCpSel] = useState<string | null>(null);
  const [cpDry, setCpDry] = useState<any | null>(null);
  const [cpBusy, setCpBusy] = useState(false);

  const loadCps = React.useCallback(() => {
    gitCall("rig.checkpoint.list", { sessionId })
      .then((r) => setCps(r?.ok && Array.isArray(r.checkpoints) ? r.checkpoints : []))
      .catch(() => setCps([]));
  }, [sessionId]);

  useEffect(() => {
    let live = true;
    gitCall("rig.git.status", { sessionId })
      .then((r) => live && setStatus(r))
      .catch((e: Error) => live && setStatus({ ok: false, error: e?.message || "rig unreachable" }));
    return () => {
      live = false;
    };
  }, [sessionId]);

  const pick = (path: string) => {
    setSel(path);
    setDiffLoading(true);
    gitCall("rig.git.diff", { sessionId, path }, 20000)
      .then((r) => setDiff(r))
      .catch((e: Error) => setDiff({ ok: false, error: e?.message || "rig unreachable" }))
      .finally(() => setDiffLoading(false));
  };

  const pickCp = (ref: string) => {
    setCpSel(ref);
    setCpDry(null);
    gitCall("rig.checkpoint.restore", { sessionId, ref })
      .then((r) => setCpDry(r))
      .catch((e: Error) => setCpDry({ ok: false, error: e?.message || "rig unreachable" }));
  };

  const restoreCp = () => {
    if (!cpSel || cpBusy) return;
    setCpBusy(true);
    gitCall("rig.checkpoint.restore", { sessionId, ref: cpSel, confirm: true }, 30000)
      .then(() => {
        setCpSel(null);
        setCpDry(null);
        setStatus(null);
        gitCall("rig.git.status", { sessionId }).then((r) => setStatus(r)).catch(() => {});
        loadCps();
      })
      .catch((e: Error) => setCpDry({ ok: false, error: e?.message || "restore failed" }))
      .finally(() => setCpBusy(false));
  };

  const files: any[] = status?.ok && Array.isArray(status.files) ? status.files : [];
  const statText = (diff?.stat || "").trim();
  const patch = typeof diff?.diff === "string" ? diff.diff : "";
  const sheetH = Math.max(340, Math.round(dims.height - Math.max(insets.top, 24) - 34));
  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [sheetH, 0] });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[styles.back, { opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
      </Animated.View>
      <Animated.View
        style={[
          styles.browserCard,
          { height: sheetH, paddingBottom: Math.max(insets.bottom, 10), transform: [{ translateY: rise }] },
        ]}
      >
        <View style={styles.grabber} />
        <View style={styles.browHead}>
          <View style={{ flex: 1 }}>
            <Text style={[FONT.small, { color: T.ink, ...fw("700"), fontSize: 15 }]} numberOfLines={1}>
              Changes · {title}
            </Text>
            <Text style={[FONT.meta, { color: T.faint, marginTop: 1 }]} numberOfLines={1}>
              {status === null
                ? "Reading the workspace…"
                : status.ok
                  ? `${status.branch || "detached"} · ${files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "clean"}`
                  : "Not a repo"}
            </Text>
          </View>
          <PressScale
            onPress={closeSheet}
            hitSlop={8}
            style={({ pressed }) => [styles.circleBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Icon name="xmark" android="close" color={T.sub} size={15} />
          </PressScale>
        </View>

        {status?.ok ? (
          <View style={styles.segRow}>
            {([
              { k: "files", label: "Files" },
              { k: "cps", label: "Checkpoints" },
            ] as const).map((t) => {
              const on = tab === t.k;
              return (
                <PressScale
                  key={t.k}
                  onPress={() => {
                    setTab(t.k);
                    if (t.k === "cps" && cps === null) loadCps();
                  }}
                  style={[styles.segPill, on && styles.segPillOn]}
                  hitSlop={4}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.label} tab`}
                >
                  <Text style={[FONT.meta, { color: on ? T.ink : T.faint, fontWeight: on ? "700" : "500" }]}>
                    {t.label}
                  </Text>
                </PressScale>
              );
            })}
          </View>
        ) : null}

        {tab === "cps" ? (
          <>
            <ScrollView style={styles.changeList} showsVerticalScrollIndicator={false} bounces={false}>
              {cps === null ? (
                <View style={styles.changesCenter}>
                  <ShimmerText text="Reading checkpoints" style={{ fontSize: 12, ...fw("600"), color: T.faint }} />
                </View>
              ) : cps.length === 0 ? (
                <View style={styles.changesCenter}>
                  <Text style={[FONT.tiny, { color: T.faint, textAlign: "center" }]} numberOfLines={3}>
                    No checkpoints yet — one lands here every time a turn ends in this workspace.
                  </Text>
                </View>
              ) : (
                cps.map((cp: any) => {
                  const n = String(cp.ref || "").split("/").pop();
                  const on = cpSel === cp.ref;
                  return (
                    <PressScale
                      key={cp.ref}
                      onPress={() => pickCp(cp.ref)}
                      style={({ pressed }) => [
                        styles.changeRow,
                        (pressed || on) && { backgroundColor: "rgba(0,0,0,0.04)" },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`Checkpoint ${n}`}
                    >
                      <View style={[styles.statusBadge, { borderColor: "#7B6FD0" }]}>
                        <Text style={[FONT.mono, { fontSize: 10, ...fw("700"), color: "#7B6FD0" }]}>
                          {n}
                        </Text>
                      </View>
                      <Text style={[FONT.small, { color: T.ink, fontSize: 13, flex: 1 }]} numberOfLines={1}>
                        {cp.label && cp.label !== "checkpoint" ? cp.label : "Turn snapshot"}
                      </Text>
                      <Text style={[FONT.meta, { color: T.faint }]}>{fmtAgo(Number(cp.ts || 0) * 1000)}</Text>
                    </PressScale>
                  );
                })
              )}
            </ScrollView>
            <View style={styles.diffPane}>
              {cpSel === null ? (
                <View style={styles.changesCenter}>
                  <Text style={[FONT.tiny, { color: T.faint }]}>Tap a checkpoint to preview a rewind.</Text>
                </View>
              ) : cpDry === null ? (
                <View style={styles.changesCenter}>
                  <ShimmerText text="Previewing rewind" style={{ fontSize: 12, ...fw("600"), color: T.faint }} />
                </View>
              ) : !cpDry.ok ? (
                <View style={styles.changesCenter}>
                  <Text style={[FONT.tiny, { color: T.sub, textAlign: "center" }]} numberOfLines={3}>
                    {cpDry.error || "Preview unavailable."}
                  </Text>
                </View>
              ) : (
                <ScrollView bounces={false} showsVerticalScrollIndicator>
                  <Text style={[FONT.meta, { color: T.faint, marginBottom: 6 }]}>
                    Rewinding to {String(cpSel).split("/").pop()} will:
                  </Text>
                  {String(cpDry.wouldChange || "").trim() ? (
                    <Text style={[FONT.mono, { fontSize: 10.5, color: T.ink, lineHeight: 14 }]} selectable>
                      {String(cpDry.wouldChange).trim()}
                    </Text>
                  ) : null}
                  {String(cpDry.wouldRemove || "").trim() ? (
                    <Text style={[FONT.mono, { fontSize: 10.5, color: "#E8453C", lineHeight: 14, marginTop: 4 }]} selectable>
                      {String(cpDry.wouldRemove).trim()}
                    </Text>
                  ) : null}
                  {!String(cpDry.wouldChange || "").trim() && !String(cpDry.wouldRemove || "").trim() ? (
                    <Text style={[FONT.tiny, { color: T.faint }]}>Nothing differs — the workspace already matches.</Text>
                  ) : null}
                  <PressScale
                    onPress={restoreCp}
                    disabled={cpBusy}
                    style={({ pressed }) => [
                      styles.restoreBtn,
                      (pressed || cpBusy) && { opacity: 0.65 },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Restore this checkpoint"
                  >
                    <Text style={[FONT.small, { color: "#fff", ...fw("700"), fontSize: 13 }]}>
                      {cpBusy ? "Restoring…" : "Restore this snapshot"}
                    </Text>
                  </PressScale>
                </ScrollView>
              )}
            </View>
          </>
        ) : status === null ? (
          <View style={styles.changesCenter}>
            <ShimmerText text="Reading the workspace" style={{ fontSize: 13, ...fw("600"), color: T.faint }} />
          </View>
        ) : !status.ok ? (
          <View style={styles.changesCenter}>
            <Text style={[FONT.small, { color: T.sub, textAlign: "center" }]} numberOfLines={4}>
              {status.notRepo
                ? "This workspace isn’t a git repository — Changes need a folder under git."
                : status.error || "This workspace isn’t a git repository."}
            </Text>
          </View>
        ) : files.length === 0 ? (
          <View style={styles.changesCenter}>
            <View style={styles.okDotBig}>
              <Icon name="checkmark" android="check" color="#fff" size={13} weight="bold" />
            </View>
            <Text style={[FONT.small, { color: T.sub, marginTop: 8 }]}>Clean — nothing uncommitted.</Text>
          </View>
        ) : (
          <>
            <ScrollView
              style={styles.changeList}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              {files.map((f: any) => {
                const letter = f.staged ? f.status[0] : f.status[1] !== " " ? f.status[1] : f.status[0];
                const key = f.status === "??" ? "?" : letter;
                const on = sel === f.path;
                return (
                  <PressScale
                    key={f.path}
                    onPress={() => pick(f.path)}
                    style={({ pressed }) => [
                      styles.changeRow,
                      (pressed || on) && { backgroundColor: "rgba(0,0,0,0.04)" },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`View diff for ${f.path}`}
                  >
                    <View style={[styles.statusBadge, { borderColor: STATUS_COLOR[key] || T.faint }]}>
                      <Text
                        style={[
                          FONT.mono,
                          { fontSize: 10, ...fw("700"), color: STATUS_COLOR[key] || T.faint },
                        ]}
                      >
                        {key}
                      </Text>
                    </View>
                    <Text style={[FONT.small, { color: T.ink, fontSize: 13, flex: 1 }]} numberOfLines={1}>
                      {f.path}
                    </Text>
                    {f.staged ? <Text style={[FONT.meta, { color: T.faint }]}>staged</Text> : null}
                  </PressScale>
                );
              })}
            </ScrollView>
            <View style={styles.diffPane}>
              {sel === null ? (
                <View style={styles.changesCenter}>
                  <Text style={[FONT.tiny, { color: T.faint }]}>Tap a file for its patch.</Text>
                </View>
              ) : diffLoading ? (
                <View style={styles.changesCenter}>
                  <ShimmerText text={`Diffing ${sel}`} style={{ fontSize: 12, ...fw("600"), color: T.faint }} />
                </View>
              ) : !diff?.ok ? (
                <View style={styles.changesCenter}>
                  <Text style={[FONT.tiny, { color: T.sub, textAlign: "center" }]} numberOfLines={3}>
                    {diff?.error || "Diff unavailable."}
                  </Text>
                </View>
              ) : (
                <ScrollView bounces={false} showsVerticalScrollIndicator>
                  {statText ? (
                    <Text style={[FONT.meta, { color: T.faint, marginBottom: 6 }]} numberOfLines={2}>
                      {statText}
                    </Text>
                  ) : null}
                  <Text style={[FONT.mono, { fontSize: 10.5, color: T.ink, lineHeight: 14 }]} selectable>
                    {patch.length > DIFF_CAP ? `${patch.slice(0, DIFF_CAP)}\n… diff truncated` : patch || "(empty diff)"}
                  </Text>
                </ScrollView>
              )}
            </View>
          </>
        )}
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// RoutinesSheet — rig.schedule.* surface: recurring prompts that spawn real
// sessions on the host. Rows show interval + next run + a firing dot; the
// Switch toggles rig.schedule.enable, long-press removes, "+ New routine"
// adds {prompt,cwd,everySec}. A fired job is just a session — it lands in
// the inbox through session.started like any other.
// ---------------------------------------------------------------------------

const INTERVALS: { label: string; sec: number }[] = [
  { label: "15m", sec: 900 },
  { label: "1h", sec: 3600 },
  { label: "6h", sec: 21600 },
  { label: "1d", sec: 86400 },
];
function fmtEvery(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}
function fmtNext(ms: number): string {
  const d = ms - Date.now();
  if (d <= 0) return "soon";
  if (d < 60_000) return `in ${Math.max(1, Math.round(d / 1000))}s`;
  if (d < 3_600_000) return `in ${Math.round(d / 60000)}m`;
  if (d < 86_400_000) return `in ${Math.round(d / 3_600_000)}h`;
  return `in ${Math.round(d / 86_400_000)}d`;
}
function fmtAgo(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.max(1, Math.round(d / 1000))}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

function RoutinesSheet() {
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const enter = useSheetEnter(closeSheet);
  const { sessions } = useRig();
  const [jobs, setJobs] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [every, setEvery] = useState(3600);
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [, tick] = useState(0); // re-render "in Xm" labels

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const refresh = React.useCallback(() => {
    rigCall("rig.schedule.list", {}, ["rig.schedule.list"])
      .then((r) => {
        setErr(null);
        setJobs(Array.isArray(r?.jobs) ? r.jobs : []);
      })
      .catch((e: Error) => {
        setJobs([]);
        setErr(e?.message || "rig unreachable");
      });
  }, []);
  useEffect(refresh, [refresh]);

  const defaultCwd = String(sessions?.[0]?.cwd || "");

  const sheetH = Math.max(340, Math.round(dims.height - Math.max(insets.top, 24) - 34));
  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [sheetH, 0] });

  const add = () => {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    setErr(null);
    rigCall(
      "rig.schedule.add",
      { prompt: p, cwd: cwd.trim(), everySec: every },
      ["rig.schedule.added"]
    )
      .then(() => {
        setPrompt("");
        setAdding(false);
        refresh();
      })
      .catch((e: Error) => setErr(e?.message || "add failed"))
      .finally(() => setBusy(false));
  };
  const toggle = (j: any) => {
    rigCall("rig.schedule.enable", { jobId: j.id, enabled: !j.enabled }, ["ok"])
      .then(refresh)
      .catch((e: Error) => setErr(e?.message || "toggle failed"));
  };
  const remove = (id: string) => {
    rigCall("rig.schedule.remove", { jobId: id }, ["ok"])
      .then(() => {
        setConfirmId(null);
        refresh();
      })
      .catch((e: Error) => {
        setConfirmId(null);
        setErr(e?.message || "remove failed");
      });
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[styles.back, { opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
      </Animated.View>
      <Animated.View
        style={[
          styles.browserCard,
          { height: sheetH, paddingBottom: Math.max(insets.bottom, 10), transform: [{ translateY: rise }] },
        ]}
      >
        <View style={styles.grabber} />
        <View style={styles.browHead}>
          <View style={{ flex: 1 }}>
            <Text style={[FONT.small, { color: T.ink, ...fw("700"), fontSize: 15 }]}>
              Routines
            </Text>
            <Text style={[FONT.meta, { color: T.faint, marginTop: 1 }]} numberOfLines={1}>
              Scheduled prompts — each run spawns a real session
            </Text>
          </View>
          <PressScale
            onPress={closeSheet}
            hitSlop={8}
            style={({ pressed }) => [styles.circleBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Icon name="xmark" android="close" color={T.sub} size={15} />
          </PressScale>
        </View>

        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} bounces={false}>
          {jobs === null ? (
            <View style={[styles.changesCenter, { flex: 0, paddingVertical: 40 }]}>
              <ShimmerText text="Reading routines" style={{ fontSize: 13, ...fw("600"), color: T.faint }} />
            </View>
          ) : jobs.length === 0 && !err ? (
            <View style={[styles.changesCenter, { flex: 0, paddingVertical: 30 }]}>
              <Text style={[FONT.small, { color: T.sub, textAlign: "center" }]}>
                No routines yet. A routine sends a prompt on an interval — its
                run lands in your inbox like any session.
              </Text>
            </View>
          ) : (
            jobs.map((j: any) => {
              const confirming = confirmId === j.id;
              return (
                <PressScale
                  key={j.id}
                  onLongPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setConfirmId(confirming ? null : j.id);
                  }}
                  delayLongPress={450}
                  style={({ pressed }) => [styles.jobRow, pressed && { backgroundColor: "rgba(0,0,0,0.03)" }]}
                  accessibilityLabel={`Routine ${j.prompt}`}
                >
                  {confirming ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                      <Text style={[FONT.small, { color: T.ink, flex: 1, fontSize: 13.5 }]} numberOfLines={1}>
                        Remove this routine?
                      </Text>
                      <PressScale
                        onPress={() => setConfirmId(null)}
                        style={({ pressed }) => [styles.jobBtn, styles.jobBtnGhost, pressed && { opacity: 0.7 }]}
                        accessibilityRole="button"
                        accessibilityLabel="Keep routine"
                      >
                        <Text style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 12.5 }]}>Keep</Text>
                      </PressScale>
                      <PressScale
                        onPress={() => remove(j.id)}
                        style={({ pressed }) => [styles.jobBtn, styles.jobBtnDanger, pressed && { opacity: 0.8 }]}
                        accessibilityRole="button"
                        accessibilityLabel="Remove routine"
                      >
                        <Text style={[FONT.small, { color: "#fff", ...fw("700"), fontSize: 12.5 }]}>Remove</Text>
                      </PressScale>
                    </View>
                  ) : (
                    <>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                          {j.firing ? <View style={styles.jobFireDot} /> : null}
                          <Text
                            style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 13.5, flex: 1 }]}
                            numberOfLines={2}
                          >
                            {j.prompt}
                          </Text>
                        </View>
                        <Text style={[FONT.meta, { color: T.faint, marginTop: 3 }]} numberOfLines={1}>
                          every {fmtEvery(j.everySec || 0)}
                          {j.enabled ? ` · next ${fmtNext(j.nextRunMs || 0)}` : " · off"}
                          {j.lastRunMs ? ` · ran ${fmtAgo(j.lastRunMs)}` : ""}
                        </Text>
                      </View>
                      <Switch
                        value={!!j.enabled}
                        onValueChange={() => toggle(j)}
                        trackColor={{ false: T.hairline, true: T.ok }}
                        thumbColor="#fff"
                      />
                    </>
                  )}
                </PressScale>
              );
            })
          )}
          {err ? (
            <Text style={[FONT.tiny, { color: "#C24646", marginHorizontal: 16, marginTop: 8 }]} numberOfLines={3}>
              {err}
            </Text>
          ) : null}
        </ScrollView>

        {adding ? (
          <View style={styles.jobForm}>
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder="Prompt to run on a schedule"
              placeholderTextColor={T.faint}
              multiline
              style={styles.jobPromptInput}
            />
            <TextInput
              value={cwd}
              onChangeText={setCwd}
              placeholder="Working directory"
              placeholderTextColor={T.faint}
              style={styles.jobCwdInput}
            />
            <View style={styles.jobChips}>
              {INTERVALS.map((it) => (
                <PressScale
                  key={it.sec}
                  onPress={() => setEvery(it.sec)}
                  style={[styles.jobChip, every === it.sec && styles.jobChipOn]}
                  accessibilityRole="button"
                  accessibilityLabel={`Every ${it.label}`}
                >
                  <Text
                    style={[
                      FONT.small,
                      { fontSize: 12.5, ...fw("600"), color: every === it.sec ? "#fff" : T.sub },
                    ]}
                  >
                    {it.label}
                  </Text>
                </PressScale>
              ))}
              <View style={{ flex: 1 }} />
              <PressScale
                onPress={() => {
                  setAdding(false);
                  setPrompt("");
                }}
                style={({ pressed }) => [styles.jobBtn, styles.jobBtnGhost, pressed && { opacity: 0.7 }]}
                accessibilityRole="button"
                accessibilityLabel="Cancel routine"
              >
                <Text style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 12.5 }]}>Cancel</Text>
              </PressScale>
              <PressScale
                onPress={add}
                style={({ pressed }) => [
                  styles.jobBtn,
                  { backgroundColor: prompt.trim() ? T.ink : T.controlBg },
                  pressed && { opacity: 0.85 },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Add routine"
              >
                {busy ? (
                  <ShimmerText text="Adding" style={{ fontSize: 12.5, ...fw("700"), color: "#fff" }} />
                ) : (
                  <Text
                    style={[
                      FONT.small,
                      { ...fw("700"), fontSize: 12.5, color: prompt.trim() ? "#fff" : T.faint },
                    ]}
                  >
                    Add
                  </Text>
                )}
              </PressScale>
            </View>
          </View>
        ) : (
          <PressScale
            onPress={() => {
              if (!cwd) setCwd(defaultCwd);
              setAdding(true);
            }}
            style={({ pressed }) => [styles.newRoutineBtn, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel="New routine"
          >
            <Icon name="plus" android="add" color="#fff" size={15} weight="bold" />
            <Text style={[FONT.small, { color: "#fff", ...fw("700"), fontSize: 14 }]}>New routine</Text>
          </PressScale>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  back: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(20,20,24,0.28)" },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2.5,
    backgroundColor: T.hairlineStrong,
    marginTop: 9,
    marginBottom: 10,
  },
  circleBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: T.controlBg,
    alignItems: "center",
    justifyContent: "center",
  },
  // ---- browser sheet
  browserCard: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: T.rSheet,
    borderTopRightRadius: T.rSheet,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -8 },
    elevation: 18,
    overflow: "hidden",
  },
  browHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  hostBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: T.controlBg,
    borderRadius: 999,
    paddingHorizontal: 12,
    height: 34,
    minWidth: 0,
  },
  hostText: { color: T.inkSoft, ...fw("600"), fontSize: 13, flexShrink: 1 },
  webBox: {
    flex: 1,
    marginHorizontal: 10,
    marginTop: 2,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    backgroundColor: "#FFFFFF",
  },
  webLoading: {
    ...StyleSheet.absoluteFill,
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "#FFFFFF",
  },
  webLoadingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: T.faint,
  },
  webFailBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: "rgba(251,250,248,0.97)",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.hairline,
  },
  // ---- merge sheet (dark, per the Cursor mobile merge flow)
  mergeCard: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#1B1B1E",
    borderTopLeftRadius: T.rSheet,
    borderTopRightRadius: T.rSheet,
    paddingHorizontal: 18,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -8 },
    elevation: 18,
  },
  mGrabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2.5,
    backgroundColor: "rgba(255,255,255,0.22)",
    marginTop: 9,
    marginBottom: 10,
  },
  mCircleBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.09)",
    alignItems: "center",
    justifyContent: "center",
  },
  mergeHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  mergeTitle: { color: "rgba(255,255,255,0.55)", ...fw("600"), paddingLeft: 2 },
  mergeEyebrow: { color: T.faint, letterSpacing: 0.9, ...fw("700") },
  mrow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.09)",
  },
  mlabel: { color: "rgba(255,255,255,0.45)", ...fw("600") },
  mvalue: { color: "#F2F1EE", ...fw("600"), flexShrink: 1, textAlign: "right" },
  okDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: T.ok,
    alignItems: "center",
    justifyContent: "center",
  },
  authorDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  // ---- slide-to-merge
  slideTrack: {
    marginTop: 10,
    height: 62,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.09)",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  slideFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(27,166,114,0.32)",
    borderTopRightRadius: 999,
    borderBottomRightRadius: 999,
  },
  slideLabel: {
    fontSize: 14,
    ...fw("700"),
    color: "rgba(255,255,255,0.78)",
    letterSpacing: 0.1,
  },
  slideThumb: {
    position: "absolute",
    left: 5,
    height: 52,
    borderRadius: 26,
    backgroundColor: T.ok,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "rgba(27,166,114,1)",
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  mergedPill: {
    marginTop: 10,
    height: 62,
    borderRadius: 999,
    backgroundColor: "rgba(27,166,114,0.18)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  mergeErr: {
    color: "#F29B9B",
    marginTop: 10,
    lineHeight: 16,
  },
  // ---- session action sheet (light, compact)
  actionCard: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 0,
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: T.rSheet,
    borderTopRightRadius: T.rSheet,
    paddingHorizontal: 16,
    shadowColor: "#000",
    shadowOpacity: 0.16,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -6 },
    elevation: 16,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 46,
    marginTop: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  actionBtnRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
  },
  actionBtn: {
    flex: 1,
    height: 46,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  actionBtnGhost: {
    backgroundColor: T.controlBg,
  },
  actionBtnDanger: {
    backgroundColor: "#D64545",
  },
  // ---- changes sheet
  changesCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  okDotBig: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: T.ok,
    alignItems: "center",
    justifyContent: "center",
  },
  changeList: {
    flexGrow: 0,
    maxHeight: 220,
    marginHorizontal: 10,
    marginTop: 2,
  },
  changeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: 40,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  statusBadge: {
    width: 19,
    height: 19,
    borderRadius: 5,
    borderWidth: 1.2,
    alignItems: "center",
    justifyContent: "center",
  },
  diffPane: {
    flex: 1,
    marginHorizontal: 10,
    marginTop: 6,
    marginBottom: 4,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    backgroundColor: "#FBFAF8",
    padding: 10,
  },
  segRow: {
    flexDirection: "row",
    alignSelf: "center",
    gap: 4,
    borderRadius: 11,
    padding: 3,
    marginTop: 2,
    marginBottom: 4,
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  segPill: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  segPillOn: {
    backgroundColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  restoreBtn: {
    marginTop: 12,
    alignSelf: "stretch",
    alignItems: "center",
    borderRadius: 12,
    paddingVertical: 10,
    backgroundColor: "#1C1B1A",
  },
  // ---- routines sheet
  renameInput: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    backgroundColor: "#FBFAF8",
    paddingHorizontal: 12,
    height: 44,
    fontSize: 14.5,
    color: T.ink,
  },
  actionBtnDark: {
    backgroundColor: T.ink,
  },
  jobRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 52,
    borderRadius: 12,
    marginHorizontal: 6,
  },
  jobFireDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: T.working,
  },
  jobBtn: {
    height: 36,
    borderRadius: 999,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  jobBtnGhost: {
    backgroundColor: T.controlBg,
  },
  jobBtnDanger: {
    backgroundColor: "#D64545",
  },
  jobForm: {
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    backgroundColor: "#FBFAF8",
    padding: 10,
    gap: 8,
  },
  jobPromptInput: {
    minHeight: 40,
    fontSize: 13.5,
    color: T.ink,
    paddingHorizontal: 4,
    textAlignVertical: "top",
  },
  jobCwdInput: {
    height: 34,
    fontSize: 12,
    color: T.sub,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.hairline,
  },
  jobChips: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  jobChip: {
    height: 30,
    borderRadius: 999,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.controlBg,
  },
  jobChipOn: {
    backgroundColor: T.ink,
  },
  newRoutineBtn: {
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    height: 46,
    borderRadius: 999,
    backgroundColor: T.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
});
