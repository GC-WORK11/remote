import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Image,
  ViewStyle,
  ScrollView,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import MaskedView from "@react-native-masked-view/masked-view";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  withDelay,
  Easing,
} from "react-native-reanimated";
import { T, FONT, fw } from "../theme";
import { cleanAgentText } from "../agentText";
import { Icon } from "./icon";
import { openLink } from "./sheetbus";
import { useFadeInStyle } from "../motion";
import { PressScale } from "./pressable";

const copyText = async (t: string) => {
  try {
    await Clipboard.setStringAsync(t);
  } catch {}
  try {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {}
};

// ---------------------------------------------------------------------------
// ShimmerText — 2.5s gradient sweep clipped to text. Live status labels.
// ---------------------------------------------------------------------------

const ALinear = Animated.createAnimatedComponent(LinearGradient);

export function ShimmerText({
  text,
  style,
}: {
  text: string;
  style?: object;
}) {
  const x = useSharedValue(0);
  useEffect(() => {
    x.value = withRepeat(withTiming(1, { duration: 2500, easing: Easing.linear }), -1, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const sweep = useAnimatedStyle(() => ({
    transform: [{ translateX: -140 + x.value * 280 }],
  }));
  const base = { ...FONT.small, color: T.sub, ...style };
  return (
    <MaskedView
      maskElement={
        <Text style={[base, { backgroundColor: "transparent" }]} numberOfLines={1}>
          {text}
        </Text>
      }
      style={{ alignSelf: "flex-start" }}
    >
      <View style={{ flexDirection: "row" }}>
        <Text style={[base, { color: "rgba(0,0,0,0.6)" }]} numberOfLines={1}>
          {text}
        </Text>
        <ALinear
          colors={["rgba(255,255,255,0)", "rgba(255,255,255,0.95)", "rgba(255,255,255,0)"]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={[{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }, sweep]}
        />
      </View>
    </MaskedView>
  );
}

// ---------------------------------------------------------------------------
// Micro-motion: Spinner (running tool), Caret (streaming), MiniCheck (settled).
// ---------------------------------------------------------------------------

export function Spinner({ size = 12, color = T.inkSoft }: { size?: number; color?: string }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withRepeat(withTiming(1, { duration: 750, easing: Easing.linear }), -1, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useAnimatedStyle(() => ({
    transform: [{ rotate: `${v.value * 360}deg` }],
  }));
  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: Math.max(1.3, size * 0.13),
          borderColor: "rgba(20,18,12,0.14)",
          borderTopColor: color,
        },
        s,
      ]}
    />
  );
}

export function Caret({ color = T.inkSoft }: { color?: string }) {
  const v = useSharedValue(1);
  useEffect(() => {
    v.value = withRepeat(
      withSequence(
        withTiming(0.12, { duration: 480, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 480, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useAnimatedStyle(() => ({ opacity: v.value }));
  return (
    <Animated.View
      style={[{ width: 2.5, height: 15, borderRadius: 1.5, backgroundColor: color }, s]}
    />
  );
}

export function MiniCheck({ ok = true, size = 15 }: { ok?: boolean; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: ok ? T.ok : T.bad,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: "#fff", fontSize: size * 0.6, ...fw("800") }}>
        {ok ? "✓" : "✕"}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Copy — small ghost button, swaps to a check for a beat.
// ---------------------------------------------------------------------------

function CopyBtn({ text, color = T.sub }: { text: string; color?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <PressScale
      hitSlop={10}
      onPress={async () => {
        await copyText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
      style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}
    >
      <Icon
        name={ok ? "checkmark" : "doc.on.doc"}
        android={ok ? "check" : "content_copy"}
        color={ok ? T.ok : color}
        size={12.5}
      />
    </PressScale>
  );
}

// ---------------------------------------------------------------------------
// Markdown-lite — bold / italic / inline code / [links], fenced blocks with
// language + copy, bullet & numbered lists, headings, quotes. No deps.
// ---------------------------------------------------------------------------

type InlinePart = { t: string; k: "text" | "bold" | "italic" | "code" | "link"; url?: string };

function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re =
    /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index), k: "text" });
    if (m[1] != null || m[2] != null) parts.push({ t: m[1] ?? m[2], k: "bold" });
    else if (m[3] != null) parts.push({ t: m[3], k: "italic" });
    else if (m[4] != null) parts.push({ t: m[4], k: "code" });
    else if (m[5] != null) parts.push({ t: m[5], k: "link", url: m[6] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: text.slice(last), k: "text" });
  return parts;
}

export function Inline({ text, base }: { text: string; base: object }) {
  const parts = parseInline(text);
  return (
    <Text style={base}>
      {parts.map((p, i) => {
        if (p.k === "bold") return <Text key={i} style={{ ...fw("700") }}>{p.t}</Text>;
        if (p.k === "italic") return <Text key={i} style={{ fontStyle: "italic" }}>{p.t}</Text>;
        if (p.k === "code")
          return (
            <Text key={i} style={[FONT.mono, { fontSize: 14.5, ...fw("600"), color: T.inkSoft }]}>
              {p.t}
            </Text>
          );
        if (p.k === "link")
          return (
            <Text
              key={i}
              style={{ color: T.link }}
              onPress={p.url ? () => openLink(p.url!) : undefined}
              suppressHighlighting
            >
              {p.t}
            </Text>
          );
        return <Text key={i}>{p.t}</Text>;
      })}
    </Text>
  );
}

type MdBlock = { k: "md" | "code"; lang?: string; body: string };

function splitBlocks(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const re = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) blocks.push({ k: "md", body: text.slice(last, m.index) });
    blocks.push({ k: "code", lang: m[1] || undefined, body: m[2].replace(/\n+$/, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) blocks.push({ k: "md", body: text.slice(last) });
  return blocks;
}

const CODE_LINES = 12;

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [open, setOpen] = useState(false);
  const lines = code.replace(/\n+$/, "").split("\n");
  const over = lines.length - CODE_LINES;
  const shown = open || over <= 0 ? code : lines.slice(0, CODE_LINES).join("\n");
  return (
    <View style={styles.code}>
      <View style={styles.codeHead}>
        <Text style={[FONT.tiny, styles.codeLang]}>{lang || "code"}</Text>
        <CopyBtn text={code} />
      </View>
      {/* Two Fabric traps around code scrollviews: selectable Text inside a
          horizontal ScrollView mismeasures intrinsic height (thousands of px
          of dead space), and a maxHeight on the ScrollView itself leaves an
          ancestor-sized hole equal to maxHeight − measured content. So the
          clamp lives on this clipping wrapper while the ScrollView sizes
          naturally; copy stays on the header button. */}
      <View style={styles.codeClip}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.codeScroll}
        >
          <Text style={[FONT.mono, styles.codeText]}>{shown}</Text>
        </ScrollView>
      </View>
      {over > 0 ? (
        <PressScale onPress={() => setOpen((o) => !o)} hitSlop={6}>
          <Text style={[FONT.tiny, { color: T.sub, ...fw("600"), marginTop: 4 }]}>
            {open ? "Show less" : `Show ${over} more line${over === 1 ? "" : "s"}`}
          </Text>
        </PressScale>
      ) : null}
    </View>
  );
}

const HEAD_SIZES = [19, 17.5, 16, 15.5];

// Line-structured rendering — agent replies mix prose + lists + headings in
// one block constantly ("Here's the plan:\n- one\n- two"). Classify each
// line, group consecutive same-kind runs, and render the runs in order so a
// single literal marker never leaks as vomit text.
type MdLine =
  | { k: "head"; lvl: number; t: string }
  | { k: "quote"; t: string }
  | { k: "bullet"; t: string; indent: number; checked: boolean | null }
  | { k: "num"; t: string; n: number; indent: number }
  | { k: "row"; cells: string[] }
  | { k: "rule" }
  | { k: "text"; t: string };

function classifyLines(raw: string[]): MdLine[] {
  const out: MdLine[] = [];
  for (const l of raw) {
    if (!l.trim()) {
      // A blank line ends a prose run — without the marker, two paragraphs
      // separated by one newline would merge into a single block.
      out.push({ k: "text", t: "" });
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\s*(#{1,4})\s+(.*)$/))) {
      out.push({ k: "head", lvl: Math.min(m[1].length, 4) - 1, t: m[2] });
    } else if (/^\s*([-*_]\s*){3,}$/.test(l)) {
      out.push({ k: "rule" });
    } else if ((m = l.match(/^\s*>\s?(.*)$/))) {
      out.push({ k: "quote", t: m[1] });
    } else if ((m = l.match(/^(\s*)[-*•+]\s+(.*)$/))) {
      const body = m[2];
      const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
      out.push({
        k: "bullet",
        t: task ? task[2] : body,
        indent: Math.floor(m[1].replace(/\t/g, "  ").length / 2),
        checked: task ? task[1] !== " " : null,
      });
    } else if ((m = l.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) {
      out.push({ k: "num", t: m[3], n: Number(m[2]), indent: Math.floor(m[1].replace(/\t/g, "  ").length / 2) });
    } else if (/^\s*\|.*\|\s*$/.test(l)) {
      const cells = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // drop |---|---|
      out.push({ k: "row", cells });
    } else {
      out.push({ k: "text", t: l });
    }
  }
  return out;
}

function MdPara({ text, base, color }: { text: string; base: object; color: string }) {
  const lines = classifyLines(text.split("\n")).filter(
    (l, i, a) => !(l.k === "text" && !l.t && (i === 0 || i === a.length - 1))
  );
  if (!lines.length) return null;
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.k === "text") {
      // Join a run of plain lines into ONE paragraph — wrapped prose must
      // reflow as a single block, not stack as ragged one-line rows.
      if (!l.t) { i++; continue; }
      const run: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur.k !== "text" || !cur.t) break;
        run.push(cur.t.trim());
        i++;
      }
      out.push(
        <View key={out.length} style={{ marginTop: out.length ? 4 : 0 }}>
          <Inline text={run.join(" ")} base={base} />
        </View>
      );
      continue;
    }
    if (l.k === "bullet" || l.k === "num" || l.k === "quote" || l.k === "row") {
      const kind = l.k;
      const run: MdLine[] = [];
      while (i < lines.length && lines[i].k === kind) run.push(lines[i++]);
      out.push(
        <View key={out.length} style={{ gap: 4 }}>
          {run.map((r, j) => {
            if (r.k === "bullet")
              return (
                <View key={j} style={[styles.liRow, { marginLeft: r.indent * 14 }]}>
                  <Text style={[base, { color: r.checked === true ? T.ok : T.faint, width: 14 }]}>
                    {r.checked === null ? (r.indent > 0 ? "◦" : "•") : r.checked ? "✓" : "○"}
                  </Text>
                  <View style={{ flexShrink: 1, minWidth: 0 }}>
                    <Inline text={r.t} base={r.checked === true ? { ...base, color: T.sub } : base} />
                  </View>
                </View>
              );
            if (r.k === "num")
              return (
                <View key={j} style={[styles.liRow, { marginLeft: r.indent * 14 }]}>
                  <Text style={[base, { color: T.sub, ...fw("600"), width: 18 }]}>{r.n}.</Text>
                  <View style={{ flexShrink: 1, minWidth: 0 }}>
                    <Inline text={r.t} base={base} />
                  </View>
                </View>
              );
            if (r.k === "quote")
              return (
                <View key={j} style={styles.quote}>
                  <Inline text={r.t} base={{ ...base, color: T.sub }} />
                </View>
              );
            if (r.k === "row")
              return (
                <View key={j} style={styles.liRow}>
                  <View style={{ flexShrink: 1, minWidth: 0 }}>
                    <Inline
                      text={r.cells.filter(Boolean).join("  ·  ")}
                      base={j === 0 ? { ...base, ...fw("600") } : base}
                    />
                  </View>
                </View>
              );
            return null;
          })}
        </View>
      );
      continue;
    }
    if (l.k === "head") {
      out.push(
        <View key={out.length} style={{ marginTop: out.length ? 8 : 0, marginBottom: 3 }}>
          <Inline text={l.t} base={{ ...FONT.head, fontSize: HEAD_SIZES[l.lvl], color }} />
        </View>
      );
      i++;
      continue;
    }
    if (l.k === "rule") {
      out.push(<View key={out.length} style={styles.hrule} />);
      i++;
      continue;
    }
    // Every MdLine kind is consumed above — nothing falls through.
    i++;
  }
  return <View style={{ gap: 3 }}>{out}</View>;
}

export function Md({ text, color = T.ink }: { text: string; color?: string }) {
  const base = { ...FONT.body, fontSize: 15.5, color, lineHeight: 22.5, letterSpacing: -0.09 };
  const blocks = useMemo(() => splitBlocks(cleanAgentText(text)), [text]);
  const out: React.ReactNode[] = [];
  blocks.forEach((b, i) => {
    if (b.k === "code") {
      out.push(<CodeBlock key={i} code={b.body} lang={b.lang} />);
      return;
    }
    const paras = b.body.split(/\n{2,}/);
    paras.forEach((para, j) => {
      const t = para.trim();
      if (!t) return;
      out.push(
        <View key={`${i}-${j}`} style={{ marginTop: j === 0 ? 0 : 7 }}>
          <MdPara text={t} base={base} color={color} />
        </View>
      );
    });
  });
  return <View style={{ gap: 2 }}>{out}</View>;
}

// Collapse point — long messages fade out behind a "Show more" affordance.
const COLLAPSE_AT = 620;

function truncateMd(t: string): string | null {
  if (t.length <= COLLAPSE_AT) return null;
  let cut = t.lastIndexOf("\n\n", COLLAPSE_AT);
  if (cut < COLLAPSE_AT * 0.5) cut = t.lastIndexOf(" ", COLLAPSE_AT);
  if (cut < 1) cut = COLLAPSE_AT;
  let head = t.slice(0, cut).trimEnd();
  if ((head.match(/```/g) || []).length % 2 === 1) {
    head = head.slice(0, head.lastIndexOf("```")).trimEnd();
  }
  const lastNl = head.lastIndexOf("\n");
  if (/^#{1,3}\s/.test(head.slice(lastNl + 1))) head = head.slice(0, lastNl + 1).trimEnd();
  return head;
}

// ---------------------------------------------------------------------------
// Bubbles — black sent / warm-gray agent, tail on the last of a run,
// long-press copy, press feedback. Entrance springs live at the row level
// (rows.tsx EnterRow) so every row kind animates identically.
// ---------------------------------------------------------------------------

function EnterBubble({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={style}>{children}</View>;
}

export function SentBubble({
  text,
  images,
  last = true,
}: {
  text: string;
  images?: string[];
  last?: boolean;
}) {
  return (
    <EnterBubble style={styles.sentWrap}>
      <PressScale
        delayLongPress={280}
        onLongPress={() => copyText(text)}
        style={({ pressed }) => [
          styles.sent,
          last && { borderBottomRightRadius: T.rBubbleTail },
          pressed && { opacity: 0.88 },
        ]}
      >
        {images?.map((u, i) => (
          <Image key={i} source={{ uri: u }} style={styles.sentImg} />
        ))}
        {text ? (
          <Text
            style={[
              FONT.body,
              { fontSize: 15.5, color: T.sentText, lineHeight: 21.5, letterSpacing: -0.09 },
            ]}
          >
            {text}
          </Text>
        ) : null}
      </PressScale>
    </EnterBubble>
  );
}

export function AgentBubble({
  text,
  last = true,
  live = false,
  flat = false,
}: {
  text: string;
  last?: boolean;
  live?: boolean;
  /** Cowork (Grok): agent prose sits directly on the canvas — no bubble
   * fill, no tail. Filled bubbles stay for the code surface. */
  flat?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const head = useMemo(() => (live || expanded ? null : truncateMd(text)), [text, live, expanded]);
  const collapsible = !live && text.length > COLLAPSE_AT;
  return (
    <EnterBubble style={flat ? styles.agentWrapFlat : styles.agentWrap}>
      <PressScale
        delayLongPress={280}
        onLongPress={() => copyText(text)}
        style={({ pressed }) => [
          styles.agent,
          flat && styles.agentFlat,
          !flat && last && { borderBottomLeftRadius: T.rBubbleTail },
          pressed && { opacity: flat ? 0.8 : 0.94 },
        ]}
      >
        <View>
          <Md text={head ?? text} />
          {head ? (
            <LinearGradient
              pointerEvents="none"
              colors={flat ? ["rgba(246,244,239,0)", "#F6F4EF"] : ["rgba(236,234,228,0)", T.agentBubble]}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={styles.fade}
            />
          ) : null}
        </View>
        {live ? (
          <View style={{ marginTop: 5 }}>
            <Caret />
          </View>
        ) : null}
        {collapsible ? (
          <PressScale
            onPress={() => setExpanded((e) => !e)}
            hitSlop={6}
            style={({ pressed }) => [styles.moreBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={[FONT.small, { color: T.sub, ...fw("600") }]}>
              {expanded ? "Show less" : "Show more"}
            </Text>
            <Icon
              name={expanded ? "chevron.up" : "chevron.down"}
              android={expanded ? "expand_less" : "expand_more"}
              color={T.faint}
              size={11}
            />
          </PressScale>
        ) : null}
      </PressScale>
    </EnterBubble>
  );
}

// Agent-side row — avatar gutter aligned under the header buddy; the avatar
// only renders on the first row of a consecutive agent run. No avatar → no
// gutter (cowork refs keep bubbles flush-left).
export function AgentShell({
  first,
  avatar,
  children,
}: {
  first?: boolean;
  avatar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.shellRow}>
      {avatar ? <View style={styles.avatarSlot}>{first ? avatar : null}</View> : null}
      <View style={styles.shellBody}>{children}</View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// ToolCard — Grok's card-in-card: warm gray outer card, white inner rows.
// Live: shimmering "Working" + spinner rows. Settled: "Done · N actions",
// expandable.
// ---------------------------------------------------------------------------

export interface ChecklistRow {
  id: string;
  label: string;
  done: boolean;
  failed?: boolean;
  /** Tool family — drives the leading glyph. Absent on replay rows built
   * before class tracking, and for prose-narrated actions. */
  cls?: string;
  /** Settle time (ms) — the result's own durationMs/tookMs, else the locally
   * measured start→end gap. Absent on replay (frames carry no clocks). */
  ms?: number;
}

// "16s" / "<1s" / "1m 4s" — the settle-time stamps from the code refs.
export function fmtMs(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Per-family glyphs — the Working card reads as a real harness timeline
// (terminal, file, screen, search…) instead of uniform dots.
const CLS_ICON: Record<string, { ios: string; android: string }> = {
  term: { ios: "apple.terminal", android: "terminal" },
  file: { ios: "doc.text", android: "description" },
  search: { ios: "magnifyingglass", android: "search" },
  computer: { ios: "display", android: "desktop_windows" },
  web: { ios: "globe", android: "language" },
  subagent: { ios: "person.2", android: "groups" },
  plan: { ios: "checklist", android: "checklist" },
  git: { ios: "arrow.triangle.branch", android: "account_tree" },
  build: { ios: "hammer", android: "build" },
  work: { ios: "gearshape", android: "settings" },
};

function ToolRow({ item, live }: { item: ChecklistRow; live?: boolean }) {
  // New checklist lines slide in as tools fire — subtle, per-item.
  const enter = useFadeInStyle();
  const glyph = CLS_ICON[item.cls || "work"] || CLS_ICON.work;
  return (
    <Animated.View style={[styles.toolRow, enter]}>
      <View style={styles.toolGlyph}>
        <Icon
          name={glyph.ios as any}
          android={glyph.android as any}
          color={item.failed ? T.bad : item.done || live ? T.sub : T.inkSoft}
          size={11}
        />
      </View>
      {item.failed ? (
        <MiniCheck ok={false} size={14} />
      ) : item.done ? (
        <MiniCheck size={14} />
      ) : live ? (
        <Spinner size={13} />
      ) : (
        <View style={styles.toolDot} />
      )}
      <Text
        numberOfLines={1}
        style={[
          FONT.small,
          { fontSize: 13, flex: 1, color: item.done || item.failed ? T.sub : T.ink },
        ]}
      >
        {item.label}
      </Text>
      {item.ms != null ? (
        <Text style={[FONT.tiny, { fontSize: 10.5, color: T.faint }]}>
          {fmtMs(item.ms)}
        </Text>
      ) : null}
    </Animated.View>
  );
}

export function ToolCard({ items, live }: { items: ChecklistRow[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const expanded = !!live || open;
  const shown = expanded ? items.slice(-7) : [];
  const hidden = items.length - shown.length;
  const doneCount = items.filter((i) => i.done).length;
  return (
    <View style={styles.toolCard}>
      <PressScale
        onPress={() => setOpen((o) => !o)}
        disabled={!!live}
        style={({ pressed }) => [styles.toolHead, pressed && !live && { opacity: 0.7 }]}
      >
        {live ? (
          <ShimmerText text="Working" style={{ fontSize: 13, ...fw("600") }} />
        ) : (
          <>
            <MiniCheck size={14} />
            <Text style={[FONT.small, { ...fw("600"), color: T.inkSoft, fontSize: 13 }]}>
              Done
            </Text>
          </>
        )}
        <View style={{ flex: 1 }} />
        <Text style={[FONT.tiny, { color: T.faint }]}>
          {live ? `${doneCount}/${items.length}` : `${items.length} ${items.length === 1 ? "action" : "actions"}`}
        </Text>
        {!live ? (
          <Icon
            name="chevron.down"
            android="expand_more"
            color={T.faint}
            size={12}
          />
        ) : null}
      </PressScale>
      {expanded ? (
        <View style={{ gap: 5 }}>
          {hidden > 0 ? (
            <Text style={[FONT.tiny, { color: T.faint, paddingLeft: 6 }]}>
              +{hidden} earlier
            </Text>
          ) : null}
          {shown.map((it) => (
            <ToolRow key={it.id} item={it} live={live} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// Mid-turn progress lines — "Worked 16s", "Status: building", "Run: https://…".
// Small gray mono text, no bubble: a status line, not a message.
export function ProgLines({ text }: { text: string }) {
  const enter = useFadeInStyle();
  return (
    <Animated.View style={[styles.progWrap, enter]}>
      {text.split("\n").map((l, i) => (
        <Text key={i} numberOfLines={1} style={[FONT.tiny, styles.progLine]}>
          {l}
        </Text>
      ))}
    </Animated.View>
  );
}

// BeatLine — one honest sentence about something the agent did. A small
// family glyph + flush-left text; no card, no box. Tool work, file writes,
// delegated tasks and status events all land here — the refs' anatomy.
export function BeatLine({
  icon,
  android,
  tone = "idle",
  children,
}: {
  icon?: string;
  android?: string;
  tone?: "idle" | "ok" | "bad" | "work";
  children: React.ReactNode;
}) {
  const enter = useFadeInStyle();
  return (
    <Animated.View style={[styles.beatRow, enter]}>
      {icon ? (
        <Icon
          name={icon as any}
          android={android as any}
          color={tone === "bad" ? T.bad : tone === "ok" ? T.ok : T.faint}
          size={12}
        />
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </Animated.View>
  );
}

export function BeatText({
  children,
  color,
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <Text numberOfLines={2} style={[FONT.small, { fontSize: 13, color: color || T.sub }]}>
      {children}
    </Text>
  );
}

export function TimeSeparator({ label }: { label: string }) {
  return (
    <View style={styles.sepWrap}>
      <Text style={[FONT.meta, { fontSize: 11.5, ...fw("500"), color: T.sepText }]}>
        {label}
      </Text>
    </View>
  );
}

function Dot({ delay, size = 6.5, color = T.dotIdle }: { delay: number; size?: number; color?: string }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 600, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 600, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      )
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useAnimatedStyle(() => ({
    transform: [{ translateY: -v.value * (size * 0.45) }],
    opacity: 0.35 + v.value * 0.65,
  }));
  return (
    <Animated.View
      style={[
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        s,
      ]}
      collapsable={false}
    />
  );
}

// Tiny dot trio — header "typing" indicator while the agent streams.
export function MiniDots({ color = T.working }: { color?: string }) {
  return (
    <View style={{ flexDirection: "row", gap: 2.5, alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <Dot key={i} delay={i * 160} size={3.5} color={color} />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  sentWrap: { alignSelf: "flex-end", maxWidth: "78%" }, // spec: user 78%
  sent: {
    borderRadius: T.rBubble,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 6,
    overflow: "hidden",
    backgroundColor: T.sentBubble,
    ...T.shadowTight,
  },
  beatRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    paddingLeft: 8,
    paddingVertical: 2.5,
  },
  sentImg: {
    width: 190,
    height: 190,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  agentWrap: { alignSelf: "flex-start", maxWidth: "82%" }, // spec: agent 82%
  agentWrapFlat: { alignSelf: "flex-start", maxWidth: "90%" },
  // Cowork refs: agent prose sits in warm-gray bubbles, tail on the last
  // of a run. Status/progress lines stay naked (that's a different row).
  agent: {
    backgroundColor: T.agentBubble,
    borderRadius: T.rBubble,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    ...T.shadowTight,
  },
  // Grok Bot anatomy: plain replies are bare ink text on the canvas.
  agentFlat: {
    backgroundColor: "transparent",
    paddingHorizontal: 2,
    paddingVertical: 1,
    borderWidth: 0,
    shadowOpacity: 0,
    elevation: 0,
  },
  shellRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  avatarSlot: { width: 26, alignItems: "center", paddingTop: 3 },
  shellBody: { flex: 1, alignItems: "stretch", minWidth: 0 },
  sepWrap: { alignItems: "center", paddingVertical: 12 },
  code: {
    backgroundColor: T.codeBg,
    borderRadius: 11,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 8,
    marginVertical: 5,
  },
  codeHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 4,
  },
  codeLang: { color: T.faint, letterSpacing: 0.6, textTransform: "uppercase", fontSize: 10 },
  codeClip: { maxHeight: 12 * 18 + 4, overflow: "hidden" },
  codeScroll: { flexGrow: 0 },
  codeText: { color: T.inkSoft, fontSize: 12.5, lineHeight: 18 },
  quote: {
    borderLeftWidth: 2.5,
    borderLeftColor: T.hairlineStrong,
    paddingLeft: 10,
    gap: 2,
    marginVertical: 2,
  },
  liRow: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
  hrule: { height: 1, backgroundColor: T.hairline, marginVertical: 7 },
  fade: {
    position: "absolute",
    left: -2,
    right: -2,
    bottom: -3,
    height: 46,
  },
  moreBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
    alignSelf: "flex-start",
  },
  // Flat checklist — the work timeline sits on the canvas, not in a card.
  toolCard: {
    alignSelf: "stretch",
    gap: 3,
    paddingLeft: 8,
    paddingVertical: 2,
  },
  toolHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 2,
  },
  toolRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 2.5,
  },
  toolDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: T.faint, marginLeft: 4 },
  toolGlyph: { width: 16, alignItems: "center" },
  progWrap: { gap: 3, paddingLeft: 8, paddingVertical: 2 },
  progLine: { fontSize: 11.5, color: T.faint },
});
