// Row layout for the thread: Grok-style runs — agent-side bubbles sit
// flush-left (no per-row avatar; the buddy lives in the header pill and
// the "X is working" row), user bubbles stay right and tailless until the
// last of their run. Shared by thread.tsx and the __DEV__ fixture
// (dev-thread.tsx) so pixel work lands in one place.
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, ViewStyle } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withSpring,
  withDelay,
  interpolate,
  interpolateColor,
  Easing,
} from "react-native-reanimated";
import {
  SentBubble,
  TimeSeparator,
  ToolCard,
  AgentShell,
  ShimmerText,
  ProgLines,
  BeatLine,
  BeatText,
  fmtMs,
  AgentBubble,
  Spinner,
  MiniDots,
} from "./bubbles";
import {
  PRChip,
  LinkCard,
  ObserveCard,
  DeliverCard,
  ApprovalCard,
  VoiceCard,
  VideoCard,
  BuildCard,
  findPrUrl,
  findLinks,
} from "./cards";
import { RichText } from "./markdown";
import { buddyName } from "./mascot";
import { Icon } from "./icon";
import { T, FONT, fw } from "../theme";
import { liveTailText } from "../agentText";
import { finishedAgo } from "../reltime";
import { enterDelay, useEnterStyle, useFadeInStyle } from "../motion";
import type { Row } from "../useChat";
import type { Mode } from "../state";
import { PressScale } from "./pressable";

export function side(kind?: string): "user" | "agent" | "none" {
  if (kind === "user") return "user";
  if (kind === "sep") return "none";
  return "agent";
}

function prevRow(rows: Row[], index: number) {
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i].kind !== "sep") return rows[i];
  }
  return undefined;
}
function nextRow(rows: Row[], index: number) {
  for (let i = index + 1; i < rows.length; i++) {
    if (rows[i].kind !== "sep") return rows[i];
  }
  return undefined;
}

// Every row springs in on mount — scale .96→1, +10→0 translate, fade —
// staggered across a burst (see motion.ts). Driven styles keep it real on
// web where `entering` animations collapse list layout.
function EnterRow({
  animate,
  style,
  children,
}: {
  animate: boolean;
  style?: ViewStyle;
  children: React.ReactNode;
}) {
  // Delay slot claimed lazily on mount — a burst of rows mounts together so
  // consecutive mounts get consecutive slots (34ms apart, capped at 9).
  const [delay] = useState(() => (animate ? enterDelay() : 0));
  const s = useEnterStyle(delay, animate);
  return <Animated.View style={[style, s]}>{children}</Animated.View>;
}

// Code mode reads as turns, not rows — each agent turn opens with a quiet
// status line ("Working" / "Finished 6m"), then the flat beats. No title
// echo: the sent bubble already carries the prompt.
function TurnHead({
  title,
  live,
  at,
}: {
  title: string;
  live?: boolean;
  at?: number;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {live ? <StatusDot live /> : null}
      <Text style={[FONT.small, { color: live ? T.working : T.faint }]}>
        {live ? "Working" : finishedAgo(at) || "Finished"}
      </Text>
    </View>
  );
}

// Interim narration inside a code turn ("Let me check X", "Got it — now Y")
// is activity, not the answer. Render it as a quiet beat line; the turn's
// final agent row carries the full SummaryText weight.
function InterimText({ text }: { text: string }) {
  return (
    <Text
      style={[FONT.small, { color: T.faint, fontSize: 13, lineHeight: 18 }]}
    >
      {firstParaClean(text)}
    </Text>
  );
}

// Interim beats read as quiet narration — heading/list markers on the first
// line are plumbing noise here, strip them rather than leaking `##`/`- `.
function firstParaClean(t: string): string {
  const i = t.indexOf("\n\n");
  const p = i < 0 ? t : t.slice(0, i);
  return p
    .replace(/^#{1,4}\s+/gm, "")
    .replace(/^[-*•+]\s+/gm, "")
    .replace(/^\d+[.)]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1");
}

// Long agent text folds under a "Summary" disclosure — the settled-turn
// collapsible from the Cursor thread. Plain canvas text either way.
function SummaryText({ text, last }: { text: string; last?: boolean }) {
  const [open, setOpen] = useState(false);
  const COLLAPSE_AT = 620;
  if (text.length <= COLLAPSE_AT || open)
    return (
      <View style={{ gap: 5 }}>
        <RichText text={text} last={last} flat />
        {text.length > COLLAPSE_AT ? (
          <SummaryToggle open onPress={() => setOpen(false)} />
        ) : null}
      </View>
    );
  const head = text.slice(0, COLLAPSE_AT).replace(/\s\S*$/, "");
  return (
    <View style={{ gap: 5 }}>
      <RichText text={`${head}…`} last={last} flat />
      <SummaryToggle open={false} onPress={() => setOpen(true)} />
    </View>
  );
}

function SummaryToggle({
  open,
  onPress,
}: {
  open: boolean;
  onPress: () => void;
}) {
  return (
    <PressScale
      onPress={onPress}
      hitSlop={6}
      style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
    >
      <Text style={[FONT.small, { color: T.sub, ...fw("600") }]}>Summary</Text>
      <Icon
        name={open ? "chevron.up" : "chevron.down"}
        android={open ? "expand_less" : "expand_more"}
        color={T.faint}
        size={12}
      />
    </PressScale>
  );
}

// Memoized body of a thread row — FlatList re-renders visible cells on every
// data change; stable props let scrolled-back and untouched rows skip work.
// `prev`/`next` are the neighboring non-separator rows (undefined at edges).
export const RowView = React.memo(function RowView({
  row,
  prev,
  next,
  mode,
  firstUser,
  ctx,
  reactCard,
  turn,
  transientFailed,
  prUrl,
  onShot,
  onApproval,
}: {
  row: Row;
  prev?: Row;
  next?: Row;
  mode?: Mode;
  /** true only for the first user message in the thread — carries the
   * "Messaged · ctx · Project" meta line from the cowork refs. */
  firstUser?: boolean;
  ctx?: string;
  /** The last link card in the thread gets the 👍 react circle (ref 7). */
  reactCard?: boolean;
  /** Present only on the first agent-side row of a code turn. */
  turn?: { title: string; live?: boolean; at?: number };
  /** A failed beat that the turn went on to recover from — plumbing noise,
   * not an outcome; only terminal failures render. */
  transientFailed?: boolean;
  /** The thread's own PR (session meta) — the footer card already surfaces
   * it, so an inline PRChip for the same URL is duplicated chrome. */
  prUrl?: string;
  /** Tap on a screenshot card — opens the live screen sheet. */
  onShot?: () => void;
  /** Decision on an approval card — sends the rpc dialog response. */
  onApproval?: (row: Row, choice: "primary" | "secondary") => void;
}) {
  const mine = side(row.kind);
  const sameRun = !!prev && side(prev.kind) === mine;
  // Spec gap grid: 4pt inside a run, 16pt across senders.
  const gapStyle: ViewStyle = {
    marginTop: !prev ? 0 : sameRun ? 4 : 16,
  };
  const animate = !row.noEnter;
  const head = turn ? <TurnHead {...turn} /> : null;

  if (row.kind === "sep") {
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <TimeSeparator label={row.text!} />
      </EnterRow>
    );
  }

  if (row.kind === "user") {
    return (
      <EnterRow animate={animate} style={gapStyle}>
        {/* Shrink column hugging the right edge: the meta line starts at the
            sent bubble's left corner, like ref 1 — not flush-right, not
            flush-left under the agent column. */}
        <View style={{ alignSelf: "flex-end", maxWidth: "78%", alignItems: "flex-end" }}>
          <SentBubble text={row.text!} images={row.images} last={next?.kind !== "user"} />
          {mode === "cowork" && firstUser ? (
            // Ref 1: "Messaged ⌁ acme/web [Project]" — a quiet provenance
            // line under the first user message, cowork only.
            <View style={metaRow}>
              <Text style={[FONT.tiny, { color: T.faint }]} numberOfLines={1}>
                Messaged
              </Text>
              <Icon name="cube" android="deployed_code" color={T.inkSoft} size={10.5} />
              <Text style={[FONT.tiny, { color: T.faint }]} numberOfLines={1}>
                {ctx || "your computer"}
              </Text>
              <View style={metaChip}>
                <Text style={[FONT.tiny, { fontSize: 10, ...fw("700"), color: "#6A5AE0" }]}>
                  Project
                </Text>
              </View>
            </View>
          ) : null}
        </View>
      </EnterRow>
    );
  }

  // agent-side rows sit flush-left — the refs carry no per-row avatar.
  const first = !sameRun;

  if (row.kind === "agent") {
    const url = row.text ? findPrUrl(row.text) : null;
    const inlinePr = url && url !== prUrl ? url : null;
    const links = row.text && !url ? findLinks(row.text) : [];
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 5 }}>
            {head}
            {/* Cowork prose rides the plain gray bubble (refs 1/6/7) —
                code turns fold long text under a Summary disclosure. */}
            {mode === "cowork" ? (
              <AgentBubble text={row.text!} last={next?.kind !== "agent"} />
            ) : mode === "code" ? (
              next?.kind === "agent" ? (
                <InterimText text={row.text!} />
              ) : (
                <SummaryText text={row.text!} last />
              )
            ) : (
              <RichText text={row.text!} last={next?.kind !== "agent"} />
            )}
            {inlinePr ? <PRChip url={inlinePr} /> : null}
            {links.map((u, i) => (
              <LinkCard
                key={u}
                url={u}
                reacted={mode === "cowork" && reactCard && i === links.length - 1}
              />
            ))}
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  if (row.kind === "check") {
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 8 }}>
            {head}
            <ToolCard items={row.items || []} live={row.streaming} />
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  if (row.kind === "prog") {
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 8 }}>
            {head}
            <ProgLines text={row.text || ""} />
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  if (row.kind === "shot") {
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 8 }}>
            {head}
            <ObserveCard
              name={row.shot || ""}
              caption={row.shotCaption}
              preview={row.shotUri}
              onPress={onShot}
            />
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  if (row.kind === "deliver" && row.deliver) {
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 8 }}>
            {head}
            <DeliverCard
              path={row.deliver.path}
              name={row.deliver.name}
              size={row.deliver.size}
              caption={row.deliver.caption}
            />
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  if (row.kind === "approval" && row.approval) {
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 8 }}>
            {head}
            <ApprovalCard
              {...row.approval}
              onDecide={
                onApproval
                  ? (choice) => onApproval(row, choice)
                  : undefined
              }
            />
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  if (row.kind === "voice" && row.voice) {
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 8 }}>
            {head}
            <VoiceCard durationSec={row.voice.durationSec} />
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  if (row.kind === "video" && row.video) {
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 8 }}>
            {head}
            <VideoCard
              uri={row.video.uri}
              durationSec={row.video.durationSec}
              caption={row.video.caption}
            />
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  if (row.kind === "build" && row.build) {
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 8 }}>
            {head}
            <BuildCard {...row.build} />
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  // Tool plumbing never renders as its own beat — execution detail lives
  // inside the turn card's expandable steps. Only failures break the silence
  // (the user must see a command that actually failed). If the suppressed
  // row carried the turn head, render the head alone so the title isn't lost.
  if (row.kind === "term" && row.term) {
    const failed = !!row.term.failed;
    if (!failed || transientFailed) return head ? <View style={gapStyle}>{head}</View> : null;
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 8 }}>
            {head}
            <BeatLine icon="apple.terminal" android="terminal" tone="bad">
              <BeatText color={T.bad}>
                A command failed
                {row.term.ms != null ? ` · ${fmtMs(row.term.ms)}` : ""}
              </BeatText>
            </BeatLine>
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  if (row.kind === "file" && row.file) {
    const f = row.file;
    if (!f.failed || transientFailed) return head ? <View style={gapStyle}>{head}</View> : null;
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 8 }}>
            {head}
            <BeatLine icon="doc.text" android="description" tone="bad">
              <BeatText color={T.bad}>
                Couldn&apos;t write{" "}
                <Text style={{ color: T.bad, ...fw("600") }}>{f.name}</Text>
              </BeatText>
            </BeatLine>
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  // Sub-agent plumbing follows the same silence rule as term/file: it
  // never earns a standalone beat — only a failure surfaces.
  if (row.kind === "sub" && row.sub) {
    const s = row.sub;
    const bad = /fail|error|cancel/i.test(s.status);
    if (!bad || transientFailed) return head ? <View style={gapStyle}>{head}</View> : null;
    return (
      <EnterRow animate={animate} style={gapStyle}>
        <AgentShell first={first}>
          <View style={{ gap: 8 }}>
            {head}
            <BeatLine icon="person.2" android="groups" tone="bad">
              <BeatText color={T.bad}>
                {s.desc || "Delegated task"}
                {s.agent ? ` · ${s.agent}` : ""} — {s.status}
              </BeatText>
            </BeatLine>
          </View>
        </AgentShell>
      </EnterRow>
    );
  }
  // Unknown kinds with no text skip cleanly — a broken wire mapping can't
  // crash or pollute the thread; text-bearing beats still get a line.
  if (!row.text) return null;
  const done = /^(done|finished|complete)/i.test(row.text || "");
  const bad = row.kind === "error";
  return (
    <EnterRow animate={animate} style={gapStyle}>
      <AgentShell first={false}>
        <View style={{ gap: 8 }}>
          {head}
          <BeatLine
            icon={done ? "checkmark" : bad ? "exclamationmark.triangle" : undefined}
            android={done ? "check" : bad ? "warning" : undefined}
            tone={bad ? "bad" : done ? "ok" : "idle"}
          >
            <BeatText color={bad ? T.bad : undefined}>{row.text}</BeatText>
          </BeatLine>
        </View>
      </AgentShell>
    </EnterRow>
  );
});

// PROBE: per-cell error boundary — a leaf throw inside a FlatList cell can
// blank the whole list while the screen chrome survives. Log it.
export class ErrBox extends React.Component<
  { children: React.ReactNode },
  { err: string | null }
> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: String(e) };
  }

  render() {
    if (this.state.err)
      return (
        <Text style={{ color: "#c00", padding: 8 }}>
          {`ERR ${this.state.err.slice(0, 120)}`}
        </Text>
      );
    return this.props.children;
  }
}

export function ThreadRow({
  row,
  rows,
  index,
  buddyKey,
  mode,
  ctx,
  streaming,
  prUrl,
  onShot,
  onApproval,
}: {
  row: Row;
  rows: Row[];
  index: number;
  buddyKey: string;
  mode: Mode;
  ctx?: string;
  /** Global streaming flag — marks the open (last) turn "Working". */
  streaming?: boolean;
  /** Thread PR URL — suppresses the inline chip that duplicates it. */
  prUrl?: string;
  onShot?: () => void;
  onApproval?: (row: Row, choice: "primary" | "secondary") => void;
}) {
  const prev = prevRow(rows, index);
  let firstUser = false;
  if (row.kind === "user") {
    firstUser = true;
    for (let i = 0; i < index; i++)
      if (rows[i].kind === "user") {
        firstUser = false;
        break;
      }
  }
  // The 👍 react lands on the last link artifact of the last agent message
  // that produced one — ref 7's doc-card react.
  let reactCard = false;
  if (row.kind === "agent") {
    reactCard = true;
    for (let i = index + 1; i < rows.length; i++)
      if (rows[i].kind === "agent" && rows[i].text && findLinks(rows[i].text!).length) {
        reactCard = false;
        break;
      }
    if (reactCard && !(row.text && findLinks(row.text).length)) reactCard = false;
  }
  // Code threads read as turns: the first agent-side row after a user
  // prompt (or the list head) carries the turn head — bold task title +
  // quiet status. The title is that prompt's first line, honestly.
  // Memoized — RowView's React.memo compares by identity and a fresh
  // object every render would defeat it on each stream flush.
  const turn = useMemo(() => {
    if (mode !== "code" || side(row.kind) !== "agent") return undefined;
    if (prev && prev.kind !== "user") return undefined;
    let last = index;
    let at = row.at;
    for (let i = index; i < rows.length; i++) {
      const r = rows[i];
      if (r.kind === "sep") continue;
      if (r.kind === "user") break;
      last = i;
      if (r.at) at = r.at;
    }
    const live = !!streaming && last === rows.length - 1;
    const title = prev?.text
      ? prev.text.split("\n")[0].slice(0, 96)
      : ctx || "Working session";
    return { title, live, at };
  }, [mode, row, prev, rows, index, streaming, ctx]);
  // A failed term/file/sub beat is transient plumbing noise when the same
  // turn went on to produce any later row (the agent recovered); only a
  // failure that ends the turn earns the red beat. Sep rows are time-gap
  // markers, not turn ends — the boundary is the next user row.
  let transientFailed = false;
  if (
    (row.kind === "term" && !!row.term?.failed) ||
    (row.kind === "file" && !!row.file?.failed) ||
    (row.kind === "sub" && !!row.sub && /fail|error|cancel/i.test(row.sub.status))
  ) {
    for (let i = index + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.kind === "sep") continue;
      if (r.kind === "user") break;
      transientFailed = true;
      break;
    }
  }
  return (
    <RowView
      row={row}
      prev={prev}
      next={nextRow(rows, index)}
      mode={mode}
      firstUser={firstUser}
      ctx={ctx}
      reactCard={reactCard}
      prUrl={prUrl}
      turn={turn}
      transientFailed={transientFailed}
      onShot={onShot}
      onApproval={onApproval}
    />
  );
}

// "Pip is working" — the live status line above the composer from the
// cowork refs: tiny persona buddy + shimmering status text + real clock.
export function WorkingRow({
  buddyKey,
  status,
  name,
  sec,
}: {
  buddyKey: string;
  status?: string;
  name?: string;
  /** Seconds since the turn started — real clock, no fake percent. */
  sec?: number;
}) {
  const clock =
    sec != null && sec > 0
      ? ` · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`
      : "";
  // Thinking phase = model reasoning pre-first-token; working = tools on the
  // rig. The pill breathes the whole time and vanishes when the reply lands.
  const thinking = !status || /^think/i.test(status);
  const detail =
    (status && !/^(working|thinking)/i.test(status) ? ` · ${status}` : "") + clock;
  const breath = useSharedValue(0);
  useEffect(() => {
    breath.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 900, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pillS = useAnimatedStyle(() => ({ opacity: 0.75 + breath.value * 0.25 }));
  return (
    <Animated.View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          alignSelf: "center",
          marginBottom: 8,
          paddingHorizontal: 13,
          paddingVertical: 6,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: T.hairlineStrong,
          backgroundColor: T.surfaceSoft,
        },
        pillS,
      ]}
    >
      {thinking ? <MiniDots /> : <Spinner size={11} />}
      <ShimmerText
        text={
          thinking
            ? `Thinking…${detail}`
            : `${name ?? buddyName(buddyKey)} is working${detail}`
        }
        style={{ fontSize: 12.5 }}
      />
    </Animated.View>
  );
}

// The live tail under the list — streaming text inside a real agent bubble
// (blinking caret); the committed row lands with noEnter so the swap reads
// as a morph. Mid-turn "thinking" is the WorkingRow pill above the
// composer — no separate typing-dots row.
export function LiveTail({
  streamText,
  streaming,
  mode,
  afterRows,
}: {
  streamText: string;
  streaming: boolean;
  /** buddyKey stays in the signature for call-site parity — the flush-left
   * tail doesn't need it. */
  buddyKey: string;
  mode: Mode;
  afterRows: Row[];
}) {
  const last = afterRows[afterRows.length - 1];
  const first = !last || side(last.kind) !== "agent";
  const gap = last ? (side(last.kind) === "agent" ? 6 : 18) : 0;
  if (!streaming || !streamText) return null;
  return (
    <View style={{ marginTop: gap }}>
      <AgentShell first={first}>
        <TailIn>
          {mode === "cowork" ? (
            <AgentBubble text={liveTailText(streamText)} live last />
          ) : (
            <RichText text={liveTailText(streamText)} live last />
          )}
        </TailIn>
      </AgentShell>
    </View>
  );
}

function TailIn({ children }: { children: React.ReactNode }) {
  const s = useFadeInStyle(0, 160);
  return <Animated.View style={s}>{children}</Animated.View>;
}

// ---------------------------------------------------------------------------
// StatusMark — the four session states the spec names, ~9px each: working
// (pink equalizer), attention (sky breathing dot), done (green), crashed
// (soft red, slow blink), sleeping (hollow ring). Replaces StatusDot in
// inbox rows so a scan of the list reads state, not just liveness.
// ---------------------------------------------------------------------------
export type StatusState =
  | "working"
  | "attention"
  | "done"
  | "crashed"
  | "sleeping"
  | "idle";

export const STATUS_HUE: Record<StatusState, string> = {
  working: "#FF5FB0",
  attention: "#38A9F8",
  done: "#34A853",
  crashed: "#D0564B",
  sleeping: "#B9B5AB",
  idle: "#C9C5BB",
};

const EQ_MS = 380;
function EqBar({ hue, delay, size }: { hue: string; delay: number; size: number }) {
  const v = useSharedValue(0.3);
  useEffect(() => {
    v.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: EQ_MS, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.3, { duration: EQ_MS, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        false
      )
    );
  }, [delay]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useAnimatedStyle(() => ({ transform: [{ scaleY: v.value }] }));
  return (
    <Animated.View
      style={[
        {
          width: Math.max(1.6, size * 0.2),
          height: size,
          borderRadius: size * 0.1,
          backgroundColor: hue,
        },
        s,
      ]}
    />
  );
}

function BreathDot({ hue, size, ms = 1500 }: { hue: string; size: number; ms?: number }) {
  const v = useSharedValue(0.45);
  useEffect(() => {
    v.value = withRepeat(
      withSequence(
        withTiming(1, { duration: ms, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.45, { duration: ms, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useAnimatedStyle(() => ({
    opacity: v.value,
    transform: [{ scale: 0.75 + v.value * 0.25 }],
  }));
  return (
    <Animated.View
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: hue }, s]}
    />
  );
}

export function StatusMark({ state, size = 9 }: { state: StatusState; size?: number }) {
  if (state === "working") {
    return (
      <View
        style={{
          width: size + 4,
          height: size,
          flexDirection: "row",
          alignItems: "flex-end",
          justifyContent: "space-between",
        }}
      >
        {[0, 1, 2].map((i) => (
          <EqBar key={i} hue={STATUS_HUE.working} delay={i * 130} size={size} />
        ))}
      </View>
    );
  }
  if (state === "attention") return <BreathDot hue={STATUS_HUE.attention} size={size} />;
  if (state === "crashed")
    return <BreathDot hue={STATUS_HUE.crashed} size={size * 0.78} ms={2100} />;
  if (state === "done")
    return (
      <View
        style={{
          width: size * 0.72,
          height: size * 0.72,
          borderRadius: size,
          backgroundColor: STATUS_HUE.done,
        }}
      />
    );
  if (state === "sleeping")
    return (
      <View
        style={{
          width: size * 0.78,
          height: size * 0.78,
          borderRadius: size,
          borderWidth: 1.2,
          borderColor: STATUS_HUE.sleeping,
        }}
      />
    );
  return (
    <View
      style={{
        width: size * 0.5,
        height: size * 0.5,
        borderRadius: size,
        backgroundColor: STATUS_HUE.idle,
      }}
    />
  );
}

/** SessionMeta → StatusMark vocabulary. Attention outranks working — a
 * stalled stream is the thing that needs eyes, not another pulse. */
export function statusOf(sm?: {
  streaming?: boolean;
  stalled?: boolean;
  dead?: boolean;
  hibernated?: boolean;
  done?: boolean;
  preview?: string;
}): StatusState {
  if (sm?.dead) return "crashed";
  if (sm?.stalled) return "attention";
  if (sm?.streaming) return "working";
  if (sm?.hibernated) return "sleeping";
  if (sm?.done || sm?.preview) return "done";
  return "idle";
}

export const STATUS_LABEL: Record<StatusState, string> = {
  working: "Working",
  attention: "Needs you",
  done: "Done",
  crashed: "Crashed",
  sleeping: "Sleeping",
  idle: "Idle",
};

// Header status dot — pulsing blue while streaming, quiet gray idle.
export function StatusDot({ live }: { live?: boolean }) {
  const v = useSharedValue(1);
  useEffect(() => {
    v.value = live
      ? withRepeat(
          withSequence(
            withTiming(0.35, { duration: 650, easing: Easing.inOut(Easing.ease) }),
            withTiming(1, { duration: 650, easing: Easing.inOut(Easing.ease) })
          ),
          -1,
          true
        )
      : withTiming(1, { duration: 200 });
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useAnimatedStyle(() => ({ opacity: v.value }));
  return (
    <Animated.View
      style={[
        {
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: live ? T.working : T.dotIdle,
        },
        s,
      ]}
    />
  );
}

const metaRow: ViewStyle = {
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "flex-start",
  gap: 5,
  marginTop: 5,
  // Sits at the sent bubble's left edge — the ref places the meta line at
  // the bubble's left corner, not flush-right under it.
  alignSelf: "flex-start",
  paddingLeft: 2,
};
const metaChip: ViewStyle = {
  borderRadius: 999,
  paddingHorizontal: 7,
  paddingVertical: 2.5,
  backgroundColor: "rgba(106,90,224,0.11)",
};

// Connection dot — springs between ok-green and bad-red with a small pop on
// every drop/reconnect, so the wire state is felt, not just colored.
export function ConnDot({ connected }: { connected: boolean }) {
  const v = useSharedValue(connected ? 1 : 0);
  useEffect(() => {
    v.value = withSpring(connected ? 1 : 0, { damping: 13, stiffness: 240 });
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(v.value, [0, 1], [T.bad, T.ok]),
    transform: [{ scale: interpolate(v.value, [0, 0.5, 1], [1, 1.45, 1]) }],
  }));
  return <Animated.View style={[{ width: 9, height: 9, borderRadius: 5 }, s]} />;
}
