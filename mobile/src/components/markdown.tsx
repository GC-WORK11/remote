// RichText — the CODE-mode agent bubble. Same chrome as AgentBubble
// (warm #F2F2F2 bubble, tail on the last of a run, long-press copy,
// 620-char collapse) but the body renders real markdown: fenced code
// cards with a regex-lite syntax tint, headings, lists, quotes, links,
// and tables. Zero new deps — everything here is regex + RN primitives.
import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { T, FONT, fw } from "../theme";
import { Icon } from "./icon";
import { Caret } from "./bubbles";
import { cleanAgentText } from "../agentText";
import { openLink } from "./sheetbus";
import { PressScale } from "./pressable";

const copyText = async (t: string) => {
  try {
    await Clipboard.setStringAsync(t);
  } catch {}
  try {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {}
};

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
// Inline — **bold** *italic* `code` ~~strike~~ [links]. Same grammar as the
// flat renderer plus strikethrough.
// ---------------------------------------------------------------------------

type InlinePart = {
  t: string;
  k: "text" | "bold" | "italic" | "code" | "strike" | "link";
  url?: string;
};

function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re =
    /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index), k: "text" });
    if (m[1] != null || m[2] != null) parts.push({ t: m[1] ?? m[2], k: "bold" });
    else if (m[3] != null) parts.push({ t: m[3], k: "italic" });
    else if (m[4] != null) parts.push({ t: m[4], k: "strike" });
    else if (m[5] != null) parts.push({ t: m[5], k: "code" });
    else if (m[6] != null) parts.push({ t: m[6], k: "link", url: m[7] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: text.slice(last), k: "text" });
  return parts;
}

function Inline({ text, base }: { text: string; base: object }) {
  const parts = parseInline(text);
  return (
    <Text style={base}>
      {parts.map((p, i) => {
        if (p.k === "bold")
          return (
            <Text key={i} style={{ ...fw("700") }}>
              {p.t}
            </Text>
          );
        if (p.k === "italic")
          return (
            <Text key={i} style={{ fontStyle: "italic" }}>
              {p.t}
            </Text>
          );
        if (p.k === "strike")
          return (
            <Text key={i} style={{ textDecorationLine: "line-through", color: T.sub }}>
              {p.t}
            </Text>
          );
        if (p.k === "code")
          return (
            <Text
              key={i}
              style={[FONT.mono, { fontSize: 13.5, backgroundColor: T.codeBg, borderRadius: 5 }]}
            >
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

// ---------------------------------------------------------------------------
// Syntax tint — one regex pass over the whole snippet; groups hit in the
// alternation's priority order (comments → strings → numbers → keywords →
// types → call sites). Language-agnostic: keyword list covers the C/TS/Py/Go/
// Rust/Java intersection, so a wrong fence tag still tints sensibly.
// ---------------------------------------------------------------------------

type TokKind = "plain" | "com" | "str" | "num" | "kw" | "type" | "fn" | "pre";
type Tok = { t: string; k: TokKind };

const KEYWORDS =
  "as|assert|async|await|bool|break|byte|case|catch|chan|char|class|const|continue|def|defer|del|do|double|elif|else|enum|export|extends|fallthrough|false|final|finally|float|fn|for|from|func|go|if|impl|implements|import|in|int|interface|is|lambda|let|long|map|match|mod|move|mut|new|none|not|null|of|or|package|pass|private|protected|pub|raise|range|readonly|ref|return|select|self|short|static|struct|super|switch|this|throw|trait|true|try|type|typeof|undefined|use|var|void|volatile|while|with|yield";

const TOK_RE = new RegExp(
  [
    "(\\/\\/[^\\n]*)", // line comment
    "|(\\/\\*[\\s\\S]*?\\*\\/)", // block comment
    "|(#\\s*(?:include|import|define|pragma)[^\\n]*)", // preprocessor
    "|(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\\\n]|\\\\.)*`)", // strings
    "|\\b(0x[0-9a-fA-F_]+|0b[01_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?[fLuU]*)\\b", // numbers
    `|\\b(${KEYWORDS})\\b`, // keywords
    "|\\b([A-Z][A-Za-z0-9_]*)\\b", // PascalCase → type
    "|\\b([a-z_][A-Za-z0-9_]*)(?=\\s*\\()", // call site
  ].join(""),
  "g"
);

const TOK_COLOR: Record<Exclude<TokKind, "plain">, string> = {
  com: "#7A7E86",
  str: "#0A6757",
  num: "#1D4EC2",
  kw: "#A02B6A",
  type: "#8A5C00",
  fn: "#5A3FC0",
  pre: "#7A5C14",
};

function tokenize(code: string): Tok[] {
  const toks: Tok[] = [];
  let last = 0;
  TOK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOK_RE.exec(code))) {
    if (m.index > last) toks.push({ t: code.slice(last, m.index), k: "plain" });
    const k: TokKind = m[1] != null || m[2] != null
      ? "com"
      : m[3] != null
        ? "pre"
        : m[4] != null
          ? "str"
          : m[5] != null
            ? "num"
            : m[6] != null
              ? "kw"
              : m[7] != null
                ? "type"
                : "fn";
    toks.push({ t: m[0], k });
    last = m.index + m[0].length;
  }
  if (last < code.length) toks.push({ t: code.slice(last), k: "plain" });
  return toks;
}

function CodeCard({ code, lang }: { code: string; lang?: string }) {
  const toks = useMemo(() => tokenize(code), [code]);
  return (
    <View style={styles.codeCard}>
      <View style={styles.codeHead}>
        <Text style={[FONT.tiny, styles.codeLang]}>{lang || "code"}</Text>
        <CopyBtn text={code} />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 1 }}
        contentContainerStyle={{ paddingBottom: 2 }}
      >
        <Text selectable style={[FONT.mono, styles.codeText]}>
          {toks.map((tk, i) =>
            tk.k === "plain" ? (
              <Text key={i}>{tk.t}</Text>
            ) : (
              <Text
                key={i}
                style={{ color: TOK_COLOR[tk.k], fontStyle: tk.k === "com" ? "italic" : "normal" }}
              >
                {tk.t}
              </Text>
            )
          )}
        </Text>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Blocks — fenced code | table | heading | quote | list | hr | paragraph.
// ---------------------------------------------------------------------------

type Block =
  | { k: "code"; lang?: string; body: string }
  | { k: "table"; head: string[]; rows: string[][] }
  | { k: "md"; body: string };

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const re = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) blocks.push({ k: "md", body: text.slice(last, m.index) });
    blocks.push({ k: "code", lang: m[1] || undefined, body: m[2].replace(/\n+$/, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) blocks.push({ k: "md", body: text.slice(last) });

  // Table pass: inside each md block, lift | a | b | lines into a table.
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.k !== "md") {
      out.push(b);
      continue;
    }
    const lines = b.body.split("\n");
    let buf: string[] = [];
    const flush = () => {
      if (buf.length) out.push({ k: "md", body: buf.join("\n") });
      buf = [];
    };
    const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const isSep = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes("-");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
        // header + separator + ≥0 body rows = one table
        const head = cells(l);
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows.push(cells(lines[i]));
          i++;
        }
        i--;
        flush();
        out.push({ k: "table", head, rows });
      } else {
        buf.push(l);
      }
    }
    flush();
  }
  return out;
}

function TableCard({ head, rows }: { head: string[]; rows: string[][] }) {
  const cellStyle = (hd: boolean) => [FONT.small, { fontSize: 13, color: hd ? T.ink : T.inkSoft, fontWeight: hd ? ("700" as const) : ("400" as const) }];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, flexShrink: 1 }}
    >
      <View style={styles.tableCard}>
        <View style={[styles.tRow, styles.tHead]}>
          {head.map((c, i) => (
            <View key={i} style={styles.tCell}>
              <Inline text={c} base={cellStyle(true)} />
            </View>
          ))}
        </View>
        {rows.map((r, ri) => (
          <View key={ri} style={styles.tRow}>
            {head.map((_, ci) => (
              <View key={ci} style={styles.tCell}>
                <Inline text={r[ci] ?? ""} base={cellStyle(false)} />
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const HEAD_SIZES = [19, 17.5, 16, 15.5];

// Line-structured rendering — agent replies mix prose + lists + headings in
// one block constantly ("Here's the plan:\n- one\n- two"). Classify each
// line, group consecutive same-kind runs, render the runs in order — a
// literal marker never leaks as vomit text.
type MdLine =
  | { k: "head"; lvl: number; t: string }
  | { k: "quote"; t: string }
  | { k: "bullet"; t: string; indent: number; checked: boolean | null }
  | { k: "num"; t: string; n: number; indent: number }
  | { k: "rule" }
  | { k: "text"; t: string };

function classifyLines(raw: string[]): MdLine[] {
  const out: MdLine[] = [];
  for (const l of raw) {
    if (!l.trim()) {
      // Blank line = paragraph break marker so prose runs join correctly.
      out.push({ k: "text", t: "" });
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\s*(#{1,4})\s+(.*)$/))) {
      out.push({ k: "head", lvl: Math.min(m[1].length, 4) - 1, t: m[2] });
    } else if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(l)) {
      out.push({ k: "rule" });
    } else if ((m = l.match(/^\s*>\s?(.*)$/))) {
      out.push({ k: "quote", t: m[1] });
    } else if ((m = l.match(/^(\s*)[-*•+]\s+(.*)$/))) {
      const body = m[2];
      const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
      out.push({
        k: "bullet",
        t: task ? task[2] : body,
        indent: Math.min(2, Math.floor(m[1].replace(/\t/g, "  ").length / 2)),
        checked: task ? task[1] !== " " : null,
      });
    } else if ((m = l.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) {
      out.push({ k: "num", t: m[3], n: Number(m[2]), indent: Math.min(2, Math.floor(m[1].replace(/\t/g, "  ").length / 2)) });
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
      // One paragraph = ONE Text — wrapped prose reflows as a block instead
      // of stacking ragged one-line rows.
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
    if (l.k === "bullet" || l.k === "num" || l.k === "quote") {
      const kind = l.k;
      const run: MdLine[] = [];
      while (i < lines.length && lines[i].k === kind) run.push(lines[i++]);
      out.push(
        <View key={out.length} style={{ gap: 4 }}>
          {run.map((r, j) => {
            if (r.k === "bullet") {
              const depth = r.indent;
              if (r.checked !== null)
                return (
                  <View key={j} style={[styles.liRow, depth > 0 && { marginLeft: depth * 12 }]}>
                    <View style={[styles.taskBox, r.checked && styles.taskBoxOn]}>
                      {r.checked ? (
                        <Icon name="checkmark" android="check" color="#fff" size={9} />
                      ) : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Inline text={r.t} base={r.checked ? { ...base, color: T.sub } : base} />
                    </View>
                  </View>
                );
              return (
                <View key={j} style={[styles.liRow, depth > 0 && { marginLeft: depth * 12 }]}>
                  <Text style={[base, { color: T.faint, width: 14 }]}>{depth > 0 ? "◦" : "•"}</Text>
                  <View style={{ flex: 1 }}>
                    <Inline text={r.t} base={base} />
                  </View>
                </View>
              );
            }
            if (r.k === "num")
              return (
                <View key={j} style={[styles.liRow, r.indent > 0 && { marginLeft: r.indent * 12 }]}>
                  <Text style={[base, { color: T.sub, ...fw("600"), width: 18 }]}>{r.n}.</Text>
                  <View style={{ flex: 1 }}>
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
      out.push(<View key={out.length} style={styles.hr} />);
      i++;
      continue;
    }
    // Every MdLine kind is consumed above — nothing falls through.
    i++;
  }
  return <View style={{ gap: 3 }}>{out}</View>;
}

export function RichMd({ text, color = T.ink }: { text: string; color?: string }) {
  const base = { ...FONT.body, fontSize: 15.5, color, lineHeight: 22.5, letterSpacing: -0.09 };
  const blocks = useMemo(() => splitBlocks(cleanAgentText(text)), [text]);
  const out: React.ReactNode[] = [];
  blocks.forEach((b, i) => {
    if (b.k === "code") {
      out.push(<CodeCard key={i} code={b.body} lang={b.lang} />);
      return;
    }
    if (b.k === "table") {
      out.push(<TableCard key={i} head={b.head} rows={b.rows} />);
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
// Same policy as the flat AgentBubble.
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

// CODE-mode agent bubble — AgentBubble's chrome with the rich body.
// `flat` drops the bubble fill: Cursor reads the settled turn's summary as
// plain text sitting on the canvas, full thread width.
export function RichText({
  text,
  last = true,
  live = false,
  flat = false,
}: {
  text: string;
  last?: boolean;
  live?: boolean;
  flat?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const head = useMemo(() => (live || expanded ? null : truncateMd(text)), [text, live, expanded]);
  const collapsible = !live && text.length > COLLAPSE_AT;
  return (
    <View style={flat ? styles.wrapFlat : styles.wrap}>
      <PressScale
        delayLongPress={280}
        onLongPress={() => copyText(text)}
        style={({ pressed }) => [
          styles.bubble,
          flat && styles.bubbleFlat,
          !flat && last && { borderBottomLeftRadius: T.rBubbleTail },
          pressed && { opacity: flat ? 0.8 : 0.94 },
        ]}
      >
        <View>
          <RichMd text={head ?? text} />
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
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "flex-start", maxWidth: "78%" },
  wrapFlat: { alignSelf: "flex-start", maxWidth: "100%" },
  bubble: {
    backgroundColor: T.agentBubble,
    borderRadius: T.rBubble,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleFlat: {
    backgroundColor: "transparent",
    paddingHorizontal: 0,
    paddingVertical: 0,
    borderRadius: 0,
  },
  codeCard: {
    backgroundColor: T.cardBgTint,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.cardLine,
    paddingHorizontal: 11,
    paddingTop: 7,
    paddingBottom: 9,
    marginVertical: 6,
    overflow: "hidden",
  },
  codeHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: T.cardLine,
    marginBottom: 6,
  },
  codeLang: { color: T.faint, letterSpacing: 0.6, textTransform: "uppercase", fontSize: 10 },
  codeText: { color: T.inkSoft, fontSize: 12.5, lineHeight: 18.5 },
  tableCard: {
    backgroundColor: T.cardBgTint,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.cardLine,
    marginVertical: 6,
    overflow: "hidden",
  },
  tRow: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.cardLine,
  },
  tHead: { borderTopWidth: 0, backgroundColor: "rgba(30,26,18,0.03)" },
  tCell: { paddingHorizontal: 11, paddingVertical: 7, minWidth: 72 },
  quote: {
    borderLeftWidth: 2.5,
    borderLeftColor: T.hairlineStrong,
    paddingLeft: 10,
    gap: 2,
    marginVertical: 2,
  },
  liRow: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
  taskBox: {
    width: 14,
    height: 14,
    borderRadius: 4,
    borderWidth: 1.4,
    borderColor: T.faint,
    marginTop: 3.5,
    alignItems: "center",
    justifyContent: "center",
  },
  taskBoxOn: { backgroundColor: T.ink, borderColor: T.ink },
  hr: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: T.hairlineStrong,
    marginVertical: 6,
  },
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
});
