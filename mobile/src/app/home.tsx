// Home — the merged inbox. One list of bots, no mode split: every session
// renders as a cowork-style row (buddy avatar, name, preview, timestamp,
// working/settled states) with a small context hint — the repo basename for
// folder-rooted sessions, "computer" for the rest. "+" opens the unified
// NewBotSheet (computer by default, optional folder pick); long-press keeps
// the session sheet; pinned/hidden/unread all carry over.
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  StyleSheet,
  Platform,
} from "react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import Animated from "react-native-reanimated";
import { Screen } from "../components/glass";
import { Buddy, buddyName } from "../components/mascot";
import { StatusMark, statusOf } from "../components/rows";
import { ShimmerText } from "../components/bubbles";
import { openSessionSheet } from "../components/sheetbus";
import { Icon } from "../components/icon";
import type { SFSymbol, AndroidSymbol } from "expo-symbols";
import { T, FONT, fw } from "../theme";
import { useEnterStyle } from "../motion";
import { useSessionChat, sessionTitle, cleanPreview } from "../useChat";
import { clockTime } from "../components/drawer";
import { useRig } from "../state";
import { PressScale } from "../components/pressable";

// Ticking timestamps — re-render just this label every 30s so "now" ages
// into "4m" without the row (or list) lifting a finger.
function TickTime({ ts }: { ts?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  // iMessage-style stamps ("8:41 AM" / "Yesterday" / weekday) — the Grok
  // inbox convention. ~11pt faint per spec.
  return <Text style={[FONT.meta, { color: T.faint }]}>{clockTime(ts)}</Text>;
}

// Staggered spring-in for list rows — driven transform (web-safe).
function EnterItem({
  index,
  style,
  children,
}: {
  index: number;
  style?: any;
  children: React.ReactNode;
}) {
  const s = useEnterStyle(Math.min(index, 9) * 34);
  return <Animated.View style={[style, s]}>{children}</Animated.View>;
}

// Per-row context hint — what working directory the bot sits in. A folder
// cwd shows its basename ("remote"); a cwd rooted at $HOME reads "~"; no
// cwd reads "computer". Same job the mode split used to do, per row.
function ctxLabel(cwd?: string): { icon: SFSymbol; android: AndroidSymbol; label: string } {
  const c = String(cwd || "").replace(/\/+$/, "");
  if (!c) return { icon: "display", android: "desktop_windows", label: "computer" };
  if (/^\/(Users|home)\/[^/]+$/.test(c))
    return { icon: "folder", android: "folder", label: "~" };
  return { icon: "folder", android: "folder", label: c.split("/").pop() || c };
}

const InboxRow = React.memo(function InboxRow({
  id,
  title,
  preview,
  ctx,
  streaming,
  stalled,
  dead,
  done,
  unread,
  pinned,
  harness,
  ts,
  index,
  onOpen,
  onHold,
}: {
  id: string;
  title: string;
  preview: string;
  ctx?: string;
  streaming?: boolean;
  stalled?: boolean;
  dead?: boolean;
  done?: boolean;
  unread?: boolean;
  pinned?: boolean;
  harness?: string;
  ts?: number;
  index: number;
  onOpen: (id: string) => void;
  onHold: (id: string, title: string) => void;
}) {
  const cx = ctxLabel(ctx);
  return (
    <PressScale
      onPress={() => onOpen(id)}
      onLongPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onHold(id, title);
      }}
      delayLongPress={450}
      // Spec: every row has a press state — rgba(0,0,0,.04) on the row.
      style={({ pressed }) => [
        { borderRadius: 16, marginHorizontal: -8, paddingHorizontal: 8 },
        pressed && { backgroundColor: "rgba(0,0,0,0.04)" },
      ]}
    >
      <EnterItem index={index} style={styles.inboxRow}>
        <Buddy k={id} size={44} />
        <View style={{ flex: 1 }}>
          <View style={styles.inboxTop}>
            {unread ? <View style={styles.unreadDot} /> : null}
            <Text
              style={[FONT.head, { color: T.ink, flex: 1, fontSize: 14 }, unread && fw("700")]}
              numberOfLines={1}
            >
              {title}
            </Text>
            {pinned ? (
              <View style={{ marginRight: 4 }}>
                <Icon name="pin.fill" android="push_pin" color={T.faint} size={10} />
              </View>
            ) : null}
            {harness && harness !== "omp" ? (
              <View style={styles.harnessTag}>
                <Text style={[FONT.tiny, { color: T.sub, fontSize: 9, ...fw("700") }]}>
                  {harness === "claude" ? "CC" : harness.slice(0, 2).toUpperCase()}
                </Text>
              </View>
            ) : null}
            <TickTime ts={ts} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
            {(() => {
              const st = statusOf({ streaming, stalled, dead, done, preview });
              return st !== "idle" ? <StatusMark state={st} size={8} /> : null;
            })()}
            {/* context hint — quiet glyph + label, then the preview */}
            <Icon name={cx.icon} android={cx.android} color={T.faint} size={10} />
            <Text style={[FONT.tiny, { color: T.faint, fontSize: 10.5 }]} numberOfLines={1}>
              {cx.label}
            </Text>
            {stalled ? (
              <ShimmerText
                text="Still working…"
                style={{ fontSize: 12.5, ...fw("500"), color: T.sub }}
              />
            ) : (
              <Text
                numberOfLines={1}
                style={[
                  FONT.small,
                  { flex: 1, fontSize: 12.5, color: streaming ? T.working : T.sub },
                ]}
              >
                {preview}
              </Text>
            )}
          </View>
        </View>
      </EnterItem>
    </PressScale>
  );
});

export default function Home() {
  const c = useSessionChat();
  const { sessions, sessionMeta, setDrawerOpen, setActive, setMode, setNewSheet, authProviders, setAuthSheet, hostInfo } =
    useRig();

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const openThread = React.useCallback(
    (id: string) => {
      // Merged inbox: the thread's chrome follows the session's working
      // context, not a global toggle — folder cwd reads as a repo surface,
      // none as the computer. TODO(thread.tsx): derive this from the
      // session's own cwd there and drop the global `mode` hint entirely.
      const sess = sessions.find((s: any) => (s.id || s.sessionId) === id);
      setMode(sess?.cwd ? "code" : "cowork");
      setActive(id);
      router.navigate("/thread");
    },
    [setActive, setMode, sessions]
  );
  const holdSession = React.useCallback((id: string, title: string) => {
    openSessionSheet(id, title);
  }, []);

  const renderInbox = React.useCallback(
    ({ item: s, index }: { item: any; index: number }) => {
      const id = s.id || s.sessionId;
      const sm = id ? sessionMeta[id] : undefined;
      return (
        <InboxRow
          id={id || `b${index}`}
          // Rows name the agent persona (deterministic per session id),
          // but a user rename wins — session.title is the persona wire.
          title={(s?.title || "").trim() ? sessionTitle(s) : id ? buddyName(id) : sessionTitle(s)}
          preview={
            sm?.streaming
              ? "Working…"
              : cleanPreview(sm?.preview || s.preview || s.cwd || "New conversation")
          }
          ctx={s.cwd}
          streaming={sm?.streaming}
          stalled={sm?.stalled}
          dead={sm?.dead}
          done={sm?.done}
          // Unread = frames past the read mark, settled. lastReadSeq 0 means
          // "never opened since receipts shipped" — those read as seen so the
          // upgrade doesn't badge the whole inbox.
          unread={!!s.lastReadSeq && !sm?.streaming && (s.lastSeq || 0) > s.lastReadSeq}
          pinned={!!s.pinned}
          harness={s.harness}
          ts={sm?.previewAt || s.lastAt || s.createdAt}
          index={index}
          onOpen={openThread}
          onHold={holdSession}
        />
      );
    },
    [sessionMeta, openThread, holdSession]
  );

  const [showHidden, setShowHidden] = useState(false);
  const hiddenCount = React.useMemo(
    () => sessions.filter((s: any) => s.hidden).length,
    [sessions]
  );
  const filtered = React.useMemo(() => {
    const vis = showHidden ? sessions : sessions.filter((s: any) => !s.hidden);
    const q = query.trim().toLowerCase();
    if (!q) return vis;
    return vis.filter((s: any) => {
      const hay = `${sessionTitle(s)} ${s.cwd || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [sessions, query, showHidden]);

  // "+" — one create surface for every kind of bot: computer context by
  // default, a folder when the work lives in a repo. Rendered by the
  // drawer so the same sheet answers the drawer's "+" too.
  const newSession = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setNewSheet(true);
  }, [setNewSheet]);

  return (
    <Screen pad={16}>
      {/* header — Grok inbox: user avatar left (opens the drawer), ghost
          search + plus circles right. No other chrome. */}
      <View style={styles.topBar}>
        <PressScale
          onPress={() => {
            Haptics.selectionAsync();
            setDrawerOpen(true);
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open sidebar"
        >
          <View style={styles.avatarBtn}>
            <Text style={[FONT.small, { color: T.ink, ...fw("700") }]}>
              {(hostInfo?.hostname || "R")[0].toUpperCase()}
            </Text>
          </View>
        </PressScale>
        <View style={{ flex: 1 }} />
        <PressScale
          scale={0.86}
          onPress={() => {
            Haptics.selectionAsync();
            setSearchOpen((v) => !v);
            if (searchOpen) setQuery("");
          }}
          style={styles.circleBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Search"
        >
          <Icon name="magnifyingglass" android="search" color={T.ink} size={16} />
        </PressScale>
        <PressScale
          scale={0.86}
          onPress={newSession}
          style={styles.circleBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="New bot"
        >
          <Icon name="plus" android="add" color={T.ink} size={19} weight="medium" />
        </PressScale>
      </View>

      {searchOpen ? (
        <View style={styles.searchRow}>
          <Icon name="magnifyingglass" android="search" color={T.faint} size={15} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search bots"
            placeholderTextColor={T.faint}
            autoFocus
            style={[FONT.body, styles.searchInput]}
          />
          {query ? (
            <PressScale onPress={() => setQuery("")} hitSlop={8}>
              <Icon name="xmark.circle.fill" android="cancel" color={T.faint} size={16} />
            </PressScale>
          ) : null}
        </View>
      ) : null}

      <FlatList
        key="inbox"
        data={filtered}
        keyExtractor={(s: any, i) => s.id || s.sessionId || `s${i}`}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: 6 }}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={9}
        updateCellsBatchingPeriod={24}
        removeClippedSubviews={Platform.OS !== "web"}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <View style={styles.emptyTile}>
              <Buddy k="remote" size={84} />
            </View>
            <Text style={[FONT.head, { color: T.ink, marginTop: 16 }]}>No bots yet</Text>
            <Text style={[FONT.small, { color: T.sub, textAlign: "center", marginTop: 4 }]}>
              Tap + above — it works on your real computer,{"\n"}or pick a folder for repo work.
            </Text>
          </View>
        }
        ListFooterComponent={
          hiddenCount > 0 ? (
            <PressScale
              onPress={() => setShowHidden((v) => !v)}
              hitSlop={8}
              style={({ pressed }) => [styles.hiddenToggle, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Toggle hidden threads"
            >
              <Icon
                name={showHidden ? "eye.slash" : "eye"}
                android={showHidden ? "visibility_off" : "visibility"}
                color={T.faint}
                size={12}
              />
              <Text style={[FONT.meta, { color: T.faint }]}>
                {showHidden
                  ? "Hide hidden threads"
                  : `${hiddenCount} hidden thread${hiddenCount === 1 ? "" : "s"} — tap to show`}
              </Text>
            </PressScale>
          ) : null
        }
        renderItem={renderInbox}
      />

      {/* Inbox = list + the "+" affordance above — the composer lives
          inside threads. The connect card stays (auth CTA, not compose). */}
      <View style={styles.composerWrap}>
        {c.connected &&
        authProviders.length > 0 &&
        !authProviders.some((p: any) => p.authed) ? (
          <PressScale
            style={styles.connectCard}
            scale={0.98}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setAuthSheet(true);
            }}
          >
            <Icon name="key" android="vpn_key" color={T.ink} size={17} />
            <View style={{ flex: 1 }}>
              <Text style={[FONT.head, { color: T.ink, fontSize: 15 }]}>
                Add an account
              </Text>
              <Text style={[FONT.tiny, { color: T.sub, marginTop: 1 }]}>
                Codex, Claude, Command Code — sign in on your laptop.
              </Text>
            </View>
            <Icon name="chevron.right" android="chevron_right" color={T.faint} size={16} />
          </PressScale>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  connectCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: "rgba(255,255,255,0.85)",
    borderRadius: 20,
    paddingHorizontal: 15,
    paddingVertical: 13,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    ...T.shadowTight,
  },
  topBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  circleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: T.pillBg,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  inboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    paddingVertical: 13,
  },
  harnessTag: {
    marginRight: 4,
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 6,
    backgroundColor: T.fieldBg,
    justifyContent: "center",
    alignItems: "center",
  },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: T.link,
    marginRight: 6,
    alignSelf: "center",
  },
  hiddenToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    marginTop: 4,
  },
  inboxTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: T.pillBg,
    borderRadius: 14,
    paddingHorizontal: 12,
    height: 40,
    marginTop: 4,
    marginBottom: 2,
  },
  searchInput: { flex: 1, color: T.ink, paddingVertical: 0 },
  emptyWrap: { alignItems: "center", paddingTop: 90 },
  emptyTile: {
    width: 104,
    height: 104,
    borderRadius: 26,
    backgroundColor: "#EFEDE9",
    alignItems: "center",
    justifyContent: "center",
  },
  composerWrap: { paddingTop: 4 },
});
