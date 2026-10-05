import React, { useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Dimensions,
  Platform,
  ScrollView,
  BackHandler,
  Animated as RNAnimated,
  Easing,
  PanResponder,
  TextInput,
  useWindowDimensions,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  interpolate,
  runOnJS,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassView } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { T, FONT, fw, tilde } from "../theme";
import { rig } from "../rig";
import { vitalsLine } from "../vitals";
import {
  startPlainSession,
  startSessionWithCwd,
  sessionTitle,
  cleanPreview,
  getPreferredHarness,
  setPreferredHarness,
} from "../useChat";
import { useRig } from "../state";
import { Icon } from "./icon";
import type { SFSymbol, AndroidSymbol } from "expo-symbols";
import { Buddy, buddyName } from "./mascot";
import { ConnDot, StatusMark, statusOf } from "./rows";
import { ShimmerText, Spinner } from "./bubbles";
import { openSessionSheet, openRoutinesSheet } from "./sheetbus";
import { PressScale } from "./pressable";

const { width: W } = Dimensions.get("window");
const DRAWER_W = Math.min(316, W * 0.84);
// Overshoot is clamped — the panel can never travel past its own edge.
const SPRING = { damping: 24, stiffness: 220, overshootClamping: true };

// iMessage-style inbox stamp: "8:41 AM" today, "Yesterday", weekday within
// the week, then short date — the Grok inbox rows' exact convention.
export function clockTime(t?: number) {
  if (!t) return "";
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay)
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayMs = 86400000;
  const y = new Date(now.getTime() - dayMs);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  if (now.getTime() - d.getTime() < 6 * dayMs)
    return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Inbox section header — T3 nightly: tiny muted label, optional shelf toggle.
function SectionHead({
  label,
  count,
  expanded,
  onToggle,
}: {
  label: string;
  count?: number;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const body = (
    <View style={styles.sectionHead}>
      <Text style={[FONT.meta, styles.sectionLabel]}>
        {label}
        {count != null ? ` (${count})` : ""}
      </Text>
      {onToggle ? (
        <Icon
          name={expanded ? "chevron.down" : "chevron.right"}
          android={expanded ? "expand_more" : "chevron_right"}
          color={T.faint}
          size={11}
        />
      ) : null}
    </View>
  );
  return onToggle ? (
    <PressScale onPress={onToggle} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${label} section`}>
      {body}
    </PressScale>
  ) : (
    body
  );
}

// ChatGPT-style time groups for the cowork inbox.
function timeGroup(t?: number): string {
  if (!t) return "Earlier";
  const now = new Date();
  const d = new Date(t);
  if (d.toDateString() === now.toDateString()) return "Today";
  const dayMs = 86400000;
  if (d.toDateString() === new Date(now.getTime() - dayMs).toDateString()) return "Yesterday";
  if (now.getTime() - t < 6 * dayMs) return "This week";
  return "Earlier";
}
const GROUP_ORDER = ["Today", "Yesterday", "This week", "Earlier"];

function UtilityRow({
  icon,
  android,
  label,
  right,
  onPress,
}: {
  icon: SFSymbol;
  android: AndroidSymbol;
  label: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  return (
    <PressScale
      onPress={() => {
        Haptics.selectionAsync();
        onPress?.();
      }}
      style={({ pressed }) => [styles.utilRow, pressed && { backgroundColor: "rgba(0,0,0,0.035)" }]}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon name={icon} android={android} color={T.sub} size={15} />
      <Text style={[FONT.small, { color: T.ink, ...fw("500"), flex: 1 }]}>
        {label}
      </Text>
      {right ?? <Icon name="chevron.right" android="chevron_right" color={T.faint} size={13} />}
    </PressScale>
  );
}

export function RemoteDrawer() {
  const {
    drawerOpen,
    setDrawerOpen,
    connected,
    hostInfo,
    sessions,
    sessionMeta,
    active,
    setActive,
    setMode,
    disconnect,
    authProviders,
    setAuthSheet,
    newSheet,
    setNewSheet,
    vitals,
  } = useRig();
  const insets = useSafeAreaInsets();
  const [pendingAwake, setPendingAwake] = React.useState<boolean | null>(null);
  const [lidHint, setLidHint] = React.useState<string | null>(null);
  const daemonAwake = hostInfo?.keepawake?.held === true;
  const stayAwake = pendingAwake ?? daemonAwake;
  const progress = useSharedValue(0);
  const [mounted, setMounted] = React.useState(false);

  useEffect(() => {
    if (drawerOpen) {
      Promise.resolve().then(() => {
        setMounted(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      });
    }
    progress.value = withSpring(drawerOpen ? 1 : 0, SPRING, (fin) => {
      if (fin && !drawerOpen) runOnJS(setMounted)(false);
    });
  }, [drawerOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Android: hardware back dismisses the drawer instead of popping the
  // route underneath it (the left-edge open gesture is unreachable under
  // gesture nav anyway — the system's back zone claims those swipes).
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!drawerOpen) return false;
      setDrawerOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [drawerOpen, setDrawerOpen]);

  const setOpen = (v: boolean) => setDrawerOpen(v);
  const close = () => setDrawerOpen(false);
  const show = () => setMounted(true);

  const makePan = (dir: "open" | "close") =>
    Gesture.Pan()
      .activeOffsetX(dir === "open" ? 8 : -8)
      .onStart(() => {
        runOnJS(show)();
      })
      .onUpdate((e) => {
        const next =
          dir === "open"
            ? Math.max(0, Math.min(1, e.translationX / DRAWER_W))
            : Math.max(0, Math.min(1, 1 + e.translationX / DRAWER_W));
        progress.value = next;
      })
      .onEnd((e) => {
        const v = e.velocityX;
        const shouldOpen =
          dir === "open" ? v > 350 || progress.value > 0.45 : v < -350 ? false : progress.value > 0.55;
        progress.value = withSpring(shouldOpen ? 1 : 0, SPRING, (fin) => {
          if (fin && !shouldOpen) runOnJS(setMounted)(false);
        });
        runOnJS(setOpen)(shouldOpen);
      });

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(progress.value, [0, 1], [-DRAWER_W, 0]) }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.value * 0.36,
  }));

  const openSession = (s: any, id: string) => {
    Haptics.selectionAsync();
    // One inbox, one kind of bot — the thread's chrome follows the
    // session's own working context (folder cwd = repo surface, none =
    // computer). TODO(thread.tsx): derive this from session.cwd there
    // and drop the global `mode` hint entirely.
    setMode(s?.cwd ? "code" : "cowork");
    setActive(id);
    close();
    router.navigate("/thread");
  };

  const [shelfOpen, setShelfOpen] = React.useState(false);

  // Single-panel sidebar (Grok/Codex anatomy — one column, no icon rail).
  const content = (
    <View style={styles.panelRow}>
      <View style={[styles.inner, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 10 }]}>
        <View style={styles.brand}>
          <Buddy k="remote" color="#34A853" size={26} />
          <Text style={[FONT.title, { color: T.ink, fontSize: 19, flex: 1 }]}>Remote</Text>
          <PressScale
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              close();
              setNewSheet(true);
            }}
            style={styles.newBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="New bot"
          >
            <Icon name="plus" android="add" color={T.ink} size={16} weight="medium" />
          </PressScale>
        </View>

        {/* Inbox — T3 nightly anatomy: live sessions time-grouped on top
            (one kind of bot — a folder cwd is just working context, not a
            different mode), a collapsed Settled shelf under, utility
            groups at the foot. Row = [buddy | title · status | time]. */}
        {(() => {
          const sess = sessions.map((s: any, i: number) => {
            const id = s.id || s.sessionId || `s${i}`;
            const sm = sessionMeta?.[id];
            return { s, id, sm, ts: sm?.previewAt || s.lastAt || s.createdAt };
          });
          const live = sess.filter((r) => !r.sm?.dead);
          const settled = sess.filter((r) => r.sm?.dead);
          // Devin nested-tree convention: a session whose parent is in the
          // visible list renders indented under it, not as a flat sibling.
          const liveIds = new Set(live.map((r) => r.id));
          const kidsOf = new Map<string, (typeof sess)[number][]>();
          const tops = live.filter((r) => {
            const p = r.s.parentId;
            if (!p || !liveIds.has(p)) return true;
            const a = kidsOf.get(p) || [];
            a.push(r);
            kidsOf.set(p, a);
            return false;
          });
          const subline = (r: (typeof sess)[number]) => {
            if (r.sm?.streaming) return "Working…";
            if (r.sm?.hibernated) return "Sleeping";
            if (r.sm?.dead) return "Ended";
            return cleanPreview(r.sm?.preview || r.s.preview || r.s.cwd || "") || "New thread";
          };
          const row = (r: (typeof sess)[number], dim: boolean, depth = 0) => {
            const on = r.id === active;
            // One kind of bot: persona name (or a user rename) no matter
            // the cwd — the folder shows in the subline when there's no
            // better preview.
            const title = (r.s?.title || "").trim()
              ? sessionTitle(r.s)
              : r.s.id || r.s.sessionId
                ? buddyName(r.id)
                : sessionTitle(r.s);
            return (
              <PressScale
                key={r.id}
                onPress={() => openSession(r.s, r.id)}
                onLongPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  openSessionSheet(
                    r.id,
                    r.s.id || r.s.sessionId ? buddyName(r.id) : sessionTitle(r.s),
                  );
                }}
                delayLongPress={450}
                style={[
                  styles.recentRow,
                  depth > 0 && { marginLeft: 27, paddingVertical: 5 },
                  on && { backgroundColor: "rgba(0,0,0,0.05)" },
                  dim && { opacity: 0.5 },
                ]}
              >
                <Buddy k={r.id} size={depth > 0 ? 22 : 28} />
                <View style={styles.recentBody}>
                  <Text
                    style={[
                      FONT.small,
                      { color: T.ink, fontWeight: on ? "700" : "500", fontSize: 13.5 },
                    ]}
                    numberOfLines={1}
                  >
                    {title}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 }}>
                    {statusOf(r.sm) !== "idle" && statusOf(r.sm) !== "done" ? (
                      <StatusMark state={statusOf(r.sm)} size={8} />
                    ) : null}
                    {r.sm?.stalled ? (
                      <ShimmerText
                        text="Still working…"
                        style={{ fontSize: 11, ...fw("500"), color: T.sub }}
                      />
                    ) : (
                      <Text
                        numberOfLines={1}
                        style={[
                          FONT.tiny,
                          {
                            flex: 1,
                            color: r.sm?.streaming ? T.working : r.sm?.hibernated || r.sm?.dead ? T.faint : T.sub,
                          },
                        ]}
                      >
                        {subline(r)}
                      </Text>
                    )}
                  </View>
                </View>
                <Text style={[FONT.meta, { color: T.faint, alignSelf: "flex-start", marginTop: 3 }]}>
                  {clockTime(r.ts)}
                </Text>
              </PressScale>
            );
          };
          return (
            <View style={styles.recentWrap}>
              <ScrollView style={styles.recentList} showsVerticalScrollIndicator={false} bounces={false}>
                {GROUP_ORDER.map((g) => {
                  const items = tops.filter((r) => timeGroup(r.ts) === g);
                  if (!items.length) return null;
                  return (
                    <View key={g}>
                      <SectionHead label={g} />
                      {items.map((r) => (
                        <View key={r.id}>
                          {row(r, !!r.sm?.hibernated)}
                          {(kidsOf.get(r.id) || []).map((k) => row(k, !!k.sm?.hibernated, 1))}
                        </View>
                      ))}
                    </View>
                  );
                })}
                {settled.length ? (
                  <>
                    <SectionHead
                      label="Settled"
                      count={settled.length}
                      expanded={shelfOpen}
                      onToggle={() => {
                        Haptics.selectionAsync();
                        setShelfOpen(!shelfOpen);
                      }}
                    />
                    {shelfOpen ? settled.map((r) => row(r, true)) : null}
                  </>
                ) : null}
              </ScrollView>
              {connected ? (
                <View style={styles.remoteGroup}>
                  <SectionHead label="Remote Control" />
                  <UtilityRow
                    icon="display"
                    android="desktop_windows"
                    label="See your screen"
                    onPress={() => {
                      close();
                      router.navigate("/screen");
                    }}
                  />
                  <UtilityRow
                    icon="film"
                    android="movie"
                    label="Recordings"
                    onPress={() => {
                      close();
                      router.navigate("/recordings");
                    }}
                  />
                  <UtilityRow
                    icon="apple.terminal"
                    android="terminal"
                    label="Terminal"
                    onPress={() => {
                      close();
                      router.navigate("/code/terminal");
                    }}
                  />
                  <UtilityRow
                    icon="globe"
                    android="language"
                    label="Browser"
                    onPress={() => {
                      close();
                      router.navigate("/code/browser");
                    }}
                  />
                  <UtilityRow
                    icon="book.closed"
                    android="menu_book"
                    label="GitHub"
                    onPress={() => {
                      close();
                      router.navigate("/code/repos");
                    }}
                  />
                </View>
              ) : null}
            </View>
          );
        })()}

        <View style={{ flex: 1 }} />

        {/* Utilities — compact hairline rows, small glyphs */}
        <View style={styles.utilGroup}>
          {connected ? (
            <UtilityRow
              icon={stayAwake ? "moon.zzz.fill" : "moon"}
              android={stayAwake ? "bedtime" : "bedtime_off"}
              label="Keep laptop awake"
              onPress={() => {
                const next = !stayAwake;
                try {
                  rig.send({ type: "rig.stayAwake", on: next, persistent: true });
                  rig.send({ type: "rig.status" });
                  setPendingAwake(next);
                  setTimeout(() => setPendingAwake(null), 1000);
                  rig
                    .waitFor("rig.stayAwake", 4000)
                    .then((f: any) => {
                      const lid = f?.lidClose;
                      setLidHint(
                        lid && lid.attempted && !lid.ok && lid.needsPrivilege && lid.command
                          ? String(lid.command)
                          : null,
                      );
                    })
                    .catch(() => {});
                } catch {
                  setPendingAwake(null);
                }
              }}
              right={
                <View style={[styles.miniTrack, stayAwake && styles.miniTrackOn]}>
                  <View style={[styles.miniThumb, stayAwake && { alignSelf: "flex-end" }]} />
                </View>
              }
            />
          ) : null}
          {lidHint ? (
            <Text style={[FONT.tiny, { color: T.warn, paddingHorizontal: 10, paddingBottom: 6 }]}>
              Lid still sleeps — run once on the laptop: {lidHint}
            </Text>
          ) : null}
          {connected ? (
            <UtilityRow
              icon="key"
              android="vpn_key"
              label="Accounts"
              onPress={() => setAuthSheet(true)}
              right={
                <Text style={[FONT.tiny, { color: T.faint }]}>
                  {authProviders.filter((p: any) => p.authed).length || "none"} signed in
                </Text>
              }
            />
          ) : null}
          {/* screen/recordings/terminal shortcuts live in the REMOTE
              CONTROL group above — one merged list, no per-mode split */}
          {connected ? (
            <UtilityRow
              icon="clock.arrow.circlepath"
              android="schedule"
              label="Routines"
              onPress={() => {
                close();
                openRoutinesSheet();
              }}
            />
          ) : null}
        </View>

        {/* Footer — quiet disconnect left, version right. No disc, no logo. */}
        <View style={styles.footer}>
          <ConnDot connected={connected} />
          <View style={styles.footAvatar}>
            <Text style={[FONT.tiny, { color: T.ink, ...fw("700") }]}>
              {(hostInfo?.hostname || "R")[0].toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[FONT.small, { color: T.sub, ...fw("600") }]} numberOfLines={1}>
              {hostInfo?.hostname || "Remote"}
            </Text>
            {/* rig.vitals strip — only what the host actually probed */}
            {connected && vitals ? (
              <Text style={[FONT.tiny, { color: T.faint, fontSize: 9.5 }]} numberOfLines={1}>
                {vitalsLine(vitals)}
              </Text>
            ) : null}
          </View>
          <PressScale
            onPress={async () => {
              await disconnect();
              router.replace("/");
            }}
            style={({ pressed }) => [styles.disconnectRow, pressed && { opacity: 0.55 }]}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Disconnect"
          >
            <Icon name="arrow.right.square" android="logout" color={T.sub} size={14} />
            <Text style={[FONT.small, { color: T.sub, ...fw("600"), fontSize: 12.5 }]}>
              Disconnect
            </Text>
          </PressScale>
        </View>
      </View>
    </View>
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {!drawerOpen ? (
        <GestureDetector gesture={makePan("open")}>
          <View style={styles.edgeStrip} />
        </GestureDetector>
      ) : null}
      {mounted ? (
        <>
          <GestureDetector gesture={makePan("close")}>
            <Animated.View
              style={[StyleSheet.absoluteFill, { backgroundColor: "#161513" }, backdropStyle]}
            >
              <Pressable style={StyleSheet.absoluteFill} onPress={close} />
            </Animated.View>
          </GestureDetector>
          <Animated.View style={[styles.panel, drawerStyle, { width: DRAWER_W }]}>
            {Platform.OS === "ios" ? (
              <View style={StyleSheet.absoluteFill}>
                <GlassView
                  style={StyleSheet.absoluteFill}
                  glassEffectStyle="regular"
                  tintColor="rgba(255,255,255,0.94)"
                />
              </View>
            ) : (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: "#FBFAF8" }]} />
            )}
            {content}
          </Animated.View>
        </>
      ) : null}
      {/* The one "+" surface — mounts only while open so the rise plays
          every time; sits above the drawer panel itself. */}
      {newSheet ? <NewBotSheet /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// NewBotSheet — the merged-inbox "+" surface. One kind of bot, one create
// flow: "On your computer" is the default (computer context, no folder);
// "Open a folder" / "New project" root the bot in a directory for repo
// work. Anatomy mirrors the old BuildSheet — light card, grabber, X.
// ---------------------------------------------------------------------------
function NewBotSheet() {
  const { setNewSheet, setMode } = useRig();
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const [enter] = React.useState(() => new RNAnimated.Value(0));
  const [drag] = React.useState(() => new RNAnimated.Value(0));
  const [home, setHome] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [harness, setHarness] = React.useState(getPreferredHarness());

  const close = React.useCallback(() => setNewSheet(false), [setNewSheet]);

  // Mount = open. Rise in, resolve $HOME for the new-project hint, and
  // Android back dismisses — same contract as the global sheets.
  useEffect(() => {
    RNAnimated.timing(enter, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    rig
      .exec("echo $HOME", "", () => {}, 8000)
      .then((f: any) => {
        const h = String(f.out || "").trim();
        if (h.startsWith("/")) setHome(h);
      })
      .catch(() => {});
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [enter, close]);

  const [pan] = React.useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.4,
      onPanResponderMove: (_e, g) => {
        drag.setValue(Math.max(0, g.dy));
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 140 || g.vy > 0.9) {
          RNAnimated.timing(drag, { toValue: 900, duration: 180, useNativeDriver: true }).start(() =>
            close()
          );
        } else {
          RNAnimated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        }
      },
      onPanResponderTerminate: () => {
        RNAnimated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
      },
    })
  );

  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [dims.height, 0] });
  const cardY = RNAnimated.add(drag, rise);
  const safeName = name.trim().replace(/^\.+/, "").replace(/[\\/]/g, "-");

  // Default: computer context — no folder, the bot drives the machine.
  const startComputer = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    close();
    setMode("cowork");
    try {
      startPlainSession();
    } catch {}
    router.navigate("/thread");
  };

  // Folder context — the work lives in a repo; the picker lands the
  // session's cwd itself (folders.tsx sets the mode hint there).
  const pickFolder = () => {
    Haptics.selectionAsync();
    close();
    router.navigate("/code/folders");
  };

  const create = async () => {
    if (!safeName || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const base = home || `~`;
      const path = `${base.replace(/\/+$/, "")}/${safeName}`;
      await rig.fsMkdir(path);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      close();
      setMode("code");
      try {
        startSessionWithCwd(path);
      } catch {}
      router.navigate("/thread");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create that folder");
      setBusy(false);
    }
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <RNAnimated.View
        style={[styles.nbBack, { opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </RNAnimated.View>
      <RNAnimated.View
        style={[
          styles.nbCard,
          { paddingBottom: Math.max(insets.bottom, 14), transform: [{ translateY: cardY }] },
        ]}
      >
        <View {...pan.panHandlers}>
          <View style={styles.nbGrabber} />
          <View style={styles.nbHead}>
            <Text style={[FONT.head, { color: T.ink, fontSize: 17, flex: 1 }]}>New bot</Text>
            <PressScale
              onPress={close}
              hitSlop={8}
              style={({ pressed }) => [styles.nbClose, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Icon name="xmark" android="close" color={T.sub} size={15} />
            </PressScale>
          </View>
        </View>

        {/* default context — the whole machine */}
        <PressScale
          onPress={startComputer}
          style={({ pressed }) => [styles.nbOpt, pressed && { backgroundColor: "rgba(0,0,0,0.03)" }]}
        >
          <View style={styles.nbTile}>
            <Icon name="display" android="desktop_windows" color={T.ink} size={17} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[FONT.small, { color: T.ink, ...fw("700"), fontSize: 14.5 }]}>
              On your computer
            </Text>
            <Text style={[FONT.tiny, { color: T.sub, marginTop: 1 }]} numberOfLines={1}>
              No folder — it uses the screen, files and apps
            </Text>
          </View>
          <Icon name="chevron.right" android="chevron_right" color={T.faint} size={14} />
        </PressScale>

        <PressScale
          onPress={pickFolder}
          style={({ pressed }) => [styles.nbOpt, pressed && { backgroundColor: "rgba(0,0,0,0.03)" }]}
        >
          <View style={styles.nbTile}>
            <Icon name="folder" android="folder" color={T.ink} size={17} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[FONT.small, { color: T.ink, ...fw("700"), fontSize: 14.5 }]}>
              Open a folder
            </Text>
            <Text style={[FONT.tiny, { color: T.sub, marginTop: 1 }]} numberOfLines={1}>
              Work inside one directory on the laptop
            </Text>
          </View>
          <Icon name="chevron.right" android="chevron_right" color={T.faint} size={14} />
        </PressScale>

        <View style={styles.nbOpt}>
          <View style={styles.nbTile}>
            <Icon name="sparkles" android="auto_awesome" color={T.ink} size={16} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[FONT.small, { color: T.ink, ...fw("700"), fontSize: 14.5 }]}>
              New project
            </Text>
            <Text style={[FONT.tiny, { color: T.sub, marginTop: 1 }]} numberOfLines={1}>
              Creates {home ? `${tilde(home)}/${safeName || "…"}` : "a fresh folder"}
            </Text>
          </View>
        </View>
        <View style={styles.nbNameRow}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="project name"
            placeholderTextColor={T.faint}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={create}
            style={[FONT.small, styles.nbNameInput]}
          />
          <PressScale
            onPress={create}
            disabled={!safeName || busy}
            style={({ pressed }) => [
              styles.nbGo,
              (!safeName || busy) && { opacity: 0.45 },
              pressed && { opacity: 0.85 },
            ]}
          >
            {busy ? (
              <Spinner size={11} color="#FFF" />
            ) : (
              <Text style={[FONT.pill, { color: "#FFF" }]}>Create</Text>
            )}
          </PressScale>
        </View>
        {err ? (
          <Text style={[FONT.tiny, { color: T.bad, paddingHorizontal: 14, marginTop: 6 }]}>
            {err}
          </Text>
        ) : null}

        {/* Engine — which agent runtime the daemon spawns. Sticks like the
            model pick: every new bot inherits the last choice. */}
        <View style={styles.nbEngineRow}>
          <Text style={[FONT.tiny, { color: T.sub, marginRight: 8 }]}>Engine</Text>
          {(
            [
              { id: "omp", label: "Remote agent" },
              { id: "claude", label: "Claude Code" },
            ] as const
          ).map((e) => {
            const on = harness === e.id;
            return (
              <PressScale
                key={e.id}
                onPress={() => {
                  Haptics.selectionAsync();
                  setHarness(e.id);
                  setPreferredHarness(e.id);
                }}
                style={[styles.nbEnginePill, on && styles.nbEnginePillOn]}
                accessibilityRole="button"
                accessibilityLabel={`Use ${e.label}`}
              >
                <Text
                  style={[
                    FONT.tiny,
                    { color: on ? "#FFF" : T.sub, ...fw(on ? "700" : "500") },
                  ]}
                >
                  {e.label}
                </Text>
              </PressScale>
            );
          })}
        </View>
      </RNAnimated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  edgeStrip: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 26,
  },
  panel: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderTopRightRadius: 26,
    borderBottomRightRadius: 26,
    overflow: "hidden",
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
  },
  panelRow: { flex: 1, flexDirection: "row" },
  newBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  inner: { flex: 1, paddingHorizontal: 16 },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingBottom: 16,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    paddingTop: 10,
    paddingBottom: 5,
  },
  sectionLabel: {
    color: T.faint,
    letterSpacing: 0.8,
    ...fw("700"),
    fontSize: 10,
    textTransform: "uppercase",
  },
  recentWrap: { flexShrink: 1, minHeight: 0 },
  recentList: { flexShrink: 1 },
  remoteGroup: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.hairline,
    paddingTop: 8,
  },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRadius: 10,
  },
  recentBody: { flex: 1, minWidth: 0 },
  utilGroup: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.hairline,
    paddingTop: 8,
    paddingBottom: 6,
  },
  utilRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 6,
    borderRadius: 10,
    marginHorizontal: -4,
  },
  miniTrack: {
    width: 34,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.12)",
    padding: 2,
    justifyContent: "center",
  },
  miniTrackOn: { backgroundColor: T.ink },
  miniThumb: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#FFF",
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.hairline,
  },
  footAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  disconnectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  // ---- new-bot sheet — light card over a dimmed backdrop (BuildSheet cut)
  nbBack: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(20,20,24,0.28)",
  },
  nbCard: {
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
  },
  nbGrabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2.5,
    backgroundColor: T.hairlineStrong,
    marginTop: 9,
    marginBottom: 10,
  },
  nbHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  nbClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: T.controlBg,
    alignItems: "center",
    justifyContent: "center",
  },
  nbOpt: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 14,
  },
  nbTile: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: T.controlBg,
    alignItems: "center",
    justifyContent: "center",
  },
  nbNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 24,
    marginTop: 2,
    marginBottom: 6,
    paddingLeft: 12,
    backgroundColor: T.fieldBg,
    borderRadius: 14,
    height: 44,
  },
  nbNameInput: { flex: 1, color: T.ink, fontSize: 14.5 },
  nbGo: {
    backgroundColor: T.ink,
    borderRadius: 11,
    paddingHorizontal: 15,
    alignItems: "center",
    justifyContent: "center",
    height: 34,
    marginRight: 5,
    minWidth: 62,
  },
  nbEngineRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 24,
    marginTop: 10,
    marginBottom: 4,
    gap: 6,
  },
  nbEnginePill: {
    paddingHorizontal: 12,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.fieldBg,
  },
  nbEnginePillOn: { backgroundColor: T.ink },
});
