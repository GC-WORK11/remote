// __DEV__-only fixture: every thread row type with seeded data, no rig needed.
// Toggle chips at the top swap mode (cowork/code) and run state (live/settled).
import React, { useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { Screen } from "../components/glass";
import { Composer, Attachment } from "../components/composer";
import { ThreadRow, LiveTail, StatusDot, WorkingRow } from "../components/rows";
import { MiniDots, ShimmerText } from "../components/bubbles";
import { Buddy, buddyName } from "../components/mascot";
import { PRCard, ApprovalSheet } from "../components/cards";
import { Icon } from "../components/icon";
import { openMergeSheet, useMergePhase } from "../components/sheetbus";
import { SLASH_COMMANDS } from "./thread";
import { T, FONT, fw } from "../theme";
import type { Row } from "../useChat";
import type { Mode } from "../state";
import { useRig } from "../state";
import { sepLabel } from "../useChat";
import { PressScale } from "../components/pressable";

const MD = `The dev server is **up and healthy**. It restarted 3 minutes ago after the last crash, and I've verified both processes:

- \`vite\` — port 5173, 12 requests in the last minute
- \`api\` — healthy, p95 latency 84ms
- \`worker\` — *idle*, queue empty

The health endpoint answers in ~4ms:

\`\`\`ts
const res = await fetch("http://localhost:5173/health");
const { ok, uptime } = await res.json();
\`\`\`

| Surface | Status | p95 |
| --- | --- | --- |
| web | green | 41ms |
| api | green | 84ms |

> Restarting is safe — no in-flight requests.

- [x] web checked
- [ ] worker restart

Want me to tail the logs or restart the worker? Notes are in https://docs.google.com/document/d/board-deck-v5`;

// The shapes that used to render as literal-marker vomit: prose and list
// items sharing one paragraph, a mid-block heading, nested bullets, a rule,
// a numbered run with a lead-in — all without blank-line separation.
const MIXED_MD = `Done — here's what I found.
First the quick version:
- **daemon** — omprd is alive, pid 3668
- **sessions** — 3 active, 1 stopped
  - nested detail that should hang one level in
- **models** — qwen3.8-flash answering in ~2s
### The longer answer
1. The daemon multiplexes sessions over one socket
2. Each turn checkpoints the repo before touching it
---
And one caveat — the Windows lane still uses exec fallback for its terminal.`;

const LONG_MD = `## What changed

I went through the auth flow end to end and found three real problems, ordered by blast radius:

1. **Token refresh races** — two tabs could both refresh and rotate the same session, so the loser got a 401 mid-request. Now there's a single-flight mutex around the refresh call.
2. **Stale cookie reads** — the middleware read cookies once at module scope, so a rotated session silently kept the old token. Reads are per-request now.
3. **Logout left the socket open** — the WS reconnect loop never checked auth state. It now closes on \`session.ended\`.

## Verification

- 14/14 auth tests green locally
- Manually ran the rotate-then-request race 20× — no 401s
- Load-shed behaviour unchanged

The only follow-up worth doing is emitting a metric when the mutex actually serializes two refreshes — it'll tell us how often the race fires in production.`;

const now = Date.now();

// Deterministic calculator frame for the ObserveCard preview — keeps the
// fixture off the rig path entirely (no fetchShot without a daemon).
const SHOT_PNG = "data:image/png;base64,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";

// Ref anatomy — the conversation reads as turns: black sent bubbles, gray
// agent narration, one quiet action stamp, a working tail. The artifact
// showcase (file/term/shot/approvals/voice/video/builds) stays off by
// default behind the `cards` chip — every row type remains reachable for
// pixel work without the thread reading as card spam.
const COWORK_ROWS: Row[] = [
  { id: "s1", kind: "sep", text: sepLabel(now - 2 * 3600_000) },
  {
    id: "u1",
    kind: "user",
    text: "jam session recap please",
    at: now - 2 * 3600_000,
  },
  {
    id: "a1",
    kind: "agent",
    text: "Most of the session was about the new onboarding flow.",
    at: now - 2 * 3600_000 + 40_000,
  },
  {
    id: "a1b",
    kind: "agent",
    text: "The one open question is the empty states. Sarah thinks the current illustrations are off-brand, and most of the room agreed, but nobody decided what happens next.",
    at: now - 2 * 3600_000 + 41_000,
  },
  {
    id: "u2",
    kind: "user",
    text: "draft the notes in a new doc, and update the Sheets with all the next steps",
    at: now - 2 * 3600_000 + 60_000,
  },
  {
    id: "a2",
    kind: "agent",
    text: "Created a new Google Doc for notes, and updated the existing Sheets. Notes: https://docs.google.com/document/d/board-deck-v5",
    at: now - 2 * 3600_000 + 80_000,
  },
  { id: "p1", kind: "prog", text: "Worked 12s" },
];

const CODE_ROWS: Row[] = [
  { id: "s1", kind: "sep", text: sepLabel(now - 2 * 3600_000) },
  {
    id: "u1",
    kind: "user",
    text: "check whether the dev server is still running on my laptop",
    at: now - 2 * 3600_000,
  },
  {
    id: "a1",
    kind: "agent",
    text: MD,
    at: now - 2 * 3600_000 + 40_000,
  },
  { id: "s2", kind: "sep", text: sepLabel(now - 40_000) },
  { id: "u2", kind: "user", text: "nice — fix the flaky auth test while you're in there", at: now - 40_000 },
  {
    id: "a2i",
    kind: "agent",
    text: "Making sure I have the latest revision based on recent changes.",
    at: now - 39_000,
  },
  {
    id: "k2",
    kind: "check",
    items: [
      { id: "t1", label: "Read auth.ts", done: true },
      { id: "t2", label: "Ran test suite", done: true, ms: 12400 },
      { id: "t3", label: "Edited session.ts", done: true, ms: 6300 },
      { id: "t4", label: "Re-ran the suite", done: true, ms: 41000 },
    ],
    streaming: false,
  },
  {
    id: "a2j",
    kind: "agent",
    text: "Found the race — two refreshes could rotate the same session and the loser got a 401 mid-request.",
    at: now - 28_000,
  },
  { id: "a2", kind: "agent", text: LONG_MD, at: now - 25_000 },
  { id: "p1", kind: "prog", text: "Worked 16s" },
  {
    id: "a3",
    kind: "agent",
    text: "Green. Opened https://github.com/remote-rig/remote/pull/42 for the fix.",
    at: now - 10_000,
  },
];

// Card showcase — reachable via the `cards` chip only.
const CARD_ROWS: Row[] = [
  { id: "s3", kind: "sep", text: sepLabel(now - 5 * 60_000) },
  { id: "f1", kind: "file", file: { name: "auth.ts", dir: "src/session", adds: 48, dels: 12 } },
  {
    id: "t1",
    kind: "term",
    term: {
      cmd: "bun test src/session",
      out: "42 pass, 0 fail, 1 skip\nRan in 1.24s",
      ms: 1240,
    },
  },
  {
    id: "sh1",
    kind: "shot",
    shot: "screen-6f31aa.png",
    shotCaption: "Observed · Calculator · 12 + 7",
    shotUri: SHOT_PNG,
  },
  {
    id: "ap1",
    kind: "approval",
    approval: {
      title: "Send the deploy report to #releases?",
      preview:
        "Build bld_9f31ea finished green. Post the changelog summary and the .ipa link into #releases so QA picks it up.",
      primary: "Send it",
      secondary: "Not now",
    },
  },
  {
    id: "ap2",
    kind: "approval",
    approval: {
      title: "Delete the stale preview environment?",
      preview: "preview-84 has been idle for 12 days and still bills the project.",
      primary: "Delete it",
      secondary: "Keep",
      state: "done",
      doneLabel: "Approved",
    },
  },
  { id: "v1", kind: "voice", voice: { durationSec: 14 } },
  { id: "amix", kind: "agent", text: MIXED_MD, at: now - 60_000 },
  {
    id: "v2",
    kind: "video",
    video: {
      durationSec: 47,
      caption: "Screen recording · scroll-bounce bug",
    },
  },
  {
    id: "b2",
    kind: "build",
    build: {
      status: "success",
      id: "bld_9f31ea",
      url: "https://deploy.example.com/9f31ea",
      artifact: "Remote-1.4.0.ipa",
      size: "38.2 MB",
      durationSec: 65,
    },
  },
];

const LIVE_STREAM = `Almost done — the last shard is green now. Checking the diff once more before I hand it back…`;

export default function DevThread() {
  const { y } = useLocalSearchParams<{ y?: string }>();
  const [mode, setMode] = useState<Mode>("cowork");
  const [live, setLive] = useState(true);
  const [cards, setCards] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [sheetDone, setSheetDone] = useState<"primary" | "secondary" | null>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  React.useEffect(() => {
    // ?y=NNN scrolls the fixture for deterministic screenshot captures.
    const n = Number(y);
    if (Number.isFinite(n) && n > 0)
      setTimeout(() => scrollRef.current?.scrollTo({ y: n, animated: false }), 400);
  }, [y]);
  // Fixture clock for the job card — ticks while the "live" toggle is on.
  const [jobSec, setJobSec] = useState(0);
  const { setDrawerOpen } = useRig();
  React.useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setJobSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  const rows = useMemo(() => {
    const base = mode === "cowork" ? COWORK_ROWS : CODE_ROWS;
    const stamped = base.map((r) => ({ ...r, noEnter: true }));
    // Live mode: a real turn in flight — the check card goes live in code
    // (Codex-style open steps); cowork just tails "…is working".
    if (live && mode === "code")
      stamped.push({
        id: "klive",
        kind: "check",
        noEnter: true,
        streaming: true,
        items: [
          { id: "lv1", label: "Read auth.ts", done: true },
          { id: "lv2", label: "Ran test suite", done: true },
          { id: "lv3", label: "Editing session.ts", done: false },
        ],
      });
    if (cards) stamped.push(...CARD_ROWS.map((r) => ({ ...r, noEnter: true })));
    return stamped;
  }, [live, mode, cards]);
  const title = "remote";
  const repo = "remote-rig/remote";
  const buddyKey = "sess_dev_thread";

  if (!__DEV__) return <Redirect href="/" />;

  return (
    <Screen pad={16}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* header — same chrome as thread.tsx */}
        <View style={styles.chatTop}>
          <PressScale
            style={styles.circleBtn}
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/home"))}
          >
            <Icon name="chevron.left" android="arrow_back" color={T.ink} size={17} />
          </PressScale>
          <View style={styles.pillSlot}>
            <View style={styles.namePill}>
              <Buddy k={buddyKey} size={22} />
              <View style={{ marginLeft: 8, minWidth: 0, maxWidth: "78%" }}>
                <View style={styles.titleRow}>
                  <Text style={[FONT.head, { color: T.ink }]} numberOfLines={1}>
                    {title}
                  </Text>
                  {mode === "code" ? (
                    <Icon
                      name="chevron.down"
                      android="expand_more"
                      color={T.faint}
                      size={13}
                      weight="semibold"
                    />
                  ) : (
                    <StatusDot live={live} />
                  )}
                </View>
                {live ? (
                  <View style={styles.typingRow}>
                    <MiniDots />
                    <ShimmerText text="Reading files…" style={{ fontSize: 11 }} />
                  </View>
                ) : (
                  <Text style={[FONT.meta, { color: T.sub }]} numberOfLines={1}>
                    ~/code/remote
                  </Text>
                )}
              </View>
            </View>
          </View>
          <View style={styles.circleBtn}>
            <Icon name="display" android="desktop_windows" color={T.ink} size={17} />
          </View>
        </View>

        {mode === "code" ? (
          <View style={styles.branchChipRow}>
            <Icon
              name="arrow.triangle.branch"
              android="account_tree"
              color={T.faint}
              size={11}
            />
            <Text style={[FONT.meta, { color: T.faint }]} numberOfLines={1}>
              {repo} · Remote Control
            </Text>
          </View>
        ) : null}

        {/* fixture toggles */}
        <View style={styles.toggleRow}>
          {(["code", "cowork"] as Mode[]).map((m) => (
            <PressScale
              key={m}
              onPress={() => setMode(m)}
              style={[styles.toggle, mode === m && styles.toggleOn]}
            >
              <Text style={[FONT.tiny, { color: mode === m ? "#fff" : T.sub }]}>{m}</Text>
            </PressScale>
          ))}
          <PressScale
            onPress={() => setLive((v) => !v)}
            style={[styles.toggle, live && styles.toggleOn]}
          >
            <Text style={[FONT.tiny, { color: live ? "#fff" : T.sub }]}>
              {live ? "live" : "settled"}
            </Text>
          </PressScale>
          <PressScale
            onPress={() => setCards((v) => !v)}
            style={[styles.toggle, cards && styles.toggleOn]}
          >
            <Text style={[FONT.tiny, { color: cards ? "#fff" : T.sub }]}>cards</Text>
          </PressScale>
          <PressScale onPress={() => setDrawerOpen(true)} style={styles.toggle}>
            <Text style={[FONT.tiny, { color: T.sub }]}>drawer</Text>
          </PressScale>
          <PressScale
            onPress={() => {
              setSheetDone(null);
              setSheet((v) => !v);
            }}
            style={[styles.toggle, sheet && styles.toggleOn]}
          >
            <Text style={[FONT.tiny, { color: sheet ? "#fff" : T.sub }]}>sheet</Text>
          </PressScale>
        </View>

        {/* ScrollView (not FlatList): web VirtualizedList mis-positions rows
            before heights settle — a fixture needs deterministic layout. */}
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ paddingBottom: 14, paddingTop: 4 }}
          showsVerticalScrollIndicator={false}
        >
          {rows.length === 0 ? (
            <View style={styles.emptyWrap}>
              <View style={styles.emptyTile}>
                <Buddy k={buddyKey} size={84} />
              </View>
              <Text style={[FONT.head, { color: T.ink, marginTop: 16, fontSize: 15 }]}>
                {buddyName(buddyKey)}
              </Text>
            </View>
          ) : null}
          {rows.map((item, index) => (
            <ThreadRow
              key={item.id}
              row={item}
              rows={rows}
              index={index}
              buddyKey={buddyKey}
              mode={mode}
              ctx={mode === "cowork" ? "acme/web" : repo}
              streaming={live}
            />
          ))}
          {!live ? (
            <View style={{ marginTop: 10 }}>
              <PRCard
                title={title}
                url="https://github.com/remote-rig/remote/pull/42"
                branch={repo}
                checks={[
                  { label: "build", state: "passed" },
                  { label: "lint", state: "passed" },
                  { label: "typecheck", state: "passed" },
                ]}
                files={[
                  "src/session/auth.ts",
                  "src/app/home.tsx",
                  "src/components/cards.tsx",
                  "app.json",
                ]}
                onPress={() =>
                  router.push({
                    pathname: "/pr",
                    params: {
                      url: "https://github.com/remote-rig/remote/pull/42",
                      title: "Fix flaky auth test",
                      branch: repo,
                    },
                  })
                }
              />
            </View>
          ) : null}
          {live ? (
            <View style={{ marginTop: 8 }}>
              <WorkingRow
                buddyKey={buddyKey}
                name={buddyName(buddyKey)}
                status="Using the computer…"
                sec={jobSec}
              />
            </View>
          ) : null}
          <LiveTail
            streamText={live ? LIVE_STREAM : ""}
            streaming={live}
            buddyKey={buddyKey}
            mode={mode}
            afterRows={rows}
          />
        </ScrollView>

        {/* Fixture for the ref-4 dark approval sheet. */}
        <ApprovalSheet
          visible={sheet}
          title="place an order at www.ventureboardgames.com"
          preview={
            sheetDone
              ? `Decided: ${sheetDone}`
              : "VentureBoard Mini Chess — Noir, quantity 1: $85.00\n\nShipping: USPS First Class Package International, $34.00 (7 to 21 business days)."
          }
          primary="Allow"
          secondary="Deny"
          actor="Pip"
          ctx="acme/web"
          onDecide={(choice) => {
            setSheetDone(choice);
            setSheet(false);
          }}
          onReview={() => {}}
          onDismiss={() => setSheet(false)}
        />

        <View style={{ paddingTop: 4 }}>
          {mode === "code" && !live ? (
            <MergePill url="https://github.com/remote-rig/remote/pull/42" title={title} branch={repo} />
          ) : null}
          {live ? (
            <WorkingRow buddyKey={buddyKey} status="Reading files…" />
          ) : null}
          <Composer
            value={input}
            onChange={setInput}
            onSend={() => setInput("")}
            onStop={() => setLive(false)}
            streaming={live}
            attachments={attachments}
            onRemoveAttachment={(i) => setAttachments((a) => a.filter((_, j) => j !== i))}
            chips={[{ icon: "sparkles", android: "auto_awesome", label: "gemini-3-flash", onPress: () => {} }]}
            placeholder={
              mode === "cowork"
                ? `Ask ${title}`
                : live
                  ? "Ask to make changes"
                  : "Send follow-up"
            }
            slashCommands={mode === "code" ? SLASH_COMMANDS : undefined}
            split
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

// The floating "Ready to merge" pill — same wiring as thread.tsx: green
// text + ✓ on dark gray, tap opens the merge sheet, then reads Merging/Merged.
function MergePill({
  url,
  title,
  branch,
}: {
  url: string;
  title: string;
  branch?: string;
}) {
  const phase = useMergePhase(url);
  if (phase !== "idle") {
    return (
      <View style={mergeStyles.row}>
        <View style={mergeStyles.done}>
          <Icon name="checkmark" android="check" color={T.ok} size={12} weight="bold" />
          <Text style={[FONT.small, { color: T.ok, ...fw("600") }]}>
            {phase === "merging" ? "Merging" : "Merged"}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View style={mergeStyles.row}>
      <PressScale
        onPress={() => openMergeSheet({ url, title, branch })}
        style={({ pressed }) => [mergeStyles.pill, pressed && { opacity: 0.8 }]}
        hitSlop={6}
      >
        <Icon name="checkmark" android="check" color={T.ok} size={12} weight="bold" />
        <Text style={[FONT.small, { color: T.ok, ...fw("600") }]}>
          Ready to merge
        </Text>
        <Icon name="chevron.up" android="expand_less" color="rgba(255,255,255,0.5)" size={11} />
      </PressScale>
    </View>
  );
}

const mergeStyles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "center", paddingBottom: 8 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#26262B",
    borderRadius: 18,
    paddingHorizontal: 14,
    height: 36,
  },
  done: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: T.okBg,
    borderRadius: 18,
    paddingHorizontal: 14,
    height: 36,
  },
});

const styles = StyleSheet.create({
  circleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: T.pillBg,
    alignItems: "center",
    justifyContent: "center",
  },
  chatTop: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  pillSlot: { flex: 1, alignItems: "center" },
  namePill: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: "100%",
    backgroundColor: "#FFFFFF",
    borderRadius: T.rPill,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 46,
    ...T.shadowTight,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  typingRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 1 },
  toggleRow: { flexDirection: "row", gap: 6, paddingVertical: 4 },
  toggle: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: T.rPill,
    backgroundColor: T.pillBg,
  },
  toggleOn: { backgroundColor: T.ink },
  branchChipRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingBottom: 2,
  },
  emptyWrap: { alignItems: "center", justifyContent: "center", paddingTop: 56, flex: 1 },
  emptyTile: {
    width: 104,
    height: 104,
    borderRadius: 26,
    backgroundColor: "#EFEDE9",
    alignItems: "center",
    justifyContent: "center",
  },
});
