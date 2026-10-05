// Terminal — a real shell on the laptop, driven from the phone.
// Every command runs via rig.exec on the daemon's host; `cd` is tracked
// client-side and prepended so state persists between commands.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Screen } from "../../components/glass";
import { Icon } from "../../components/icon";
import { T, FONT, fw } from "../../theme";
import { rig } from "../../rig";
import { useRig } from "../../state";
import { PressScale } from "../../components/pressable";

type Line = { kind: "cmd" | "out" | "err" | "sys"; text: string };

const MAX_LINES = 800;

// pty output carries ANSI — strip CSI/OSC and control bytes, and apply
// carriage-return line rewrites (each \r resets the current line).
const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, "");
const applyCr = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((ln) => (ln.includes("\r") ? ln.slice(ln.lastIndexOf("\r") + 1) : ln))
    .join("\n");

export default function Terminal() {
  const { connected, hostInfo } = useRig();
  const params = useLocalSearchParams<{ cwd?: string }>();
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [cwd, setCwd] = useState(params.cwd || "");
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const push = useCallback((l: Line) => {
    setLines((prev) => {
      const next = [...prev, l];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  // A real pty on the rig — one login shell, streamed live. Falls back to
  // per-command rig.exec when the daemon can't host a pty (Windows).
  const termIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!connected || termIdRef.current != null) return;
    let dead = false;
    const off = rig.onFrame((f: any) => {
      const tid = termIdRef.current;
      if (f.type === "term.out" && tid != null && f.termId === tid) {
        const text = applyCr(stripAnsi(String(f.data || "")));
        if (!text) return;
        for (const ln of text.split("\n")) if (ln.length) push({ kind: "out", text: ln });
      } else if (f.type === "term.exit" && f.termId === termIdRef.current) {
        termIdRef.current = null;
        push({ kind: "sys", text: `shell exited (${f.code}) — tap ❯ to reopen` });
      }
    });
    rig
      .termOpen(cwd || "")
      .then((id) => {
        if (dead) rig.termClose(id);
        else termIdRef.current = id;
      })
      .catch(() => {}); // no pty backend — the exec path below covers it
    return () => {
      dead = true;
      off();
      if (termIdRef.current != null) {
        rig.termClose(termIdRef.current);
        termIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Resolve home once so "~" and bare starts have a base.
  useEffect(() => {
    if (!connected || cwd) return;
    rig
      .exec("echo $HOME", "", () => {}, 8000)
      .then((f: any) => {
        const h = String(f.out || "").trim();
        if (h.startsWith("/")) setCwd(h);
      })
      .catch(() => setCwd("/"));
  }, [connected, cwd]);

  const bannered = useRef(false);
  const banner = useCallback(() => {
    if (bannered.current || !connected) return;
    bannered.current = true;
    push({
      kind: "sys",
      text: `${hostInfo?.hostname || "remote"} · ${hostInfo?.os || ""} — connected`,
    });
  }, [connected, hostInfo, push]);

  // Track `cd` locally: relative targets resolve against current cwd.
  const resolveCd = (arg: string) => {
    const a = arg.replace(/^['"]|['"]$/g, "");
    if (a === "-" || !a) return cwd;
    if (a === "~") return cwd.startsWith("/") ? cwd.split("/").slice(0, 3).join("/") || cwd : cwd;
    if (a.startsWith("/")) return a;
    if (a.startsWith("~/"))
      return `${cwd.split("/").slice(0, 3).join("/")}/${a.slice(2)}`;
    const parts = cwd.split("/").filter(Boolean);
    for (const seg of a.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg && seg !== ".") parts.push(seg);
    }
    return `/${parts.join("/")}`;
  };

  const run = async () => {
    const cmd = input.trim();
    if (!cmd || running) return;
    banner();
    setInput("");

    // pty died (shell exited or daemon dropped it) — reopen once so the
    // next command lands in a real shell instead of the exec fallback.
    if (connected && termIdRef.current == null) {
      rig.termOpen(cwd || "").then((id) => (termIdRef.current = id)).catch(() => {});
    }

    // pty live: the shell echoes the command and owns cd/clear itself —
    // we only mirror `clear` on the scrollback so the screen matches.
    if (termIdRef.current != null) {
      if (cmd === "clear") setLines([]);
      else rig.termIn(termIdRef.current, `${cmd}\n`);
      return;
    }

    push({ kind: "cmd", text: `${cwd.replace(/^\/Users\/[^/]+/, "~") || "~"} ❯ ${cmd}` });

    // `cd` handled client-side — the exec subprocess is stateless.
    const cdMatch = cmd.match(/^cd\s*(.*)$/);
    if (cdMatch) {
      const next = resolveCd(cdMatch[1] || "~");
      const r = await rig.exec(`cd "${next}" && pwd`, "", () => {}, 8000).catch(() => null);
      if (r && r.code === 0) {
        setCwd(next);
      } else {
        push({ kind: "err", text: `cd: no such directory: ${cdMatch[1]}` });
      }
      return;
    }
    if (cmd === "clear") {
      setLines([]);
      return;
    }

    setRunning(true);
    let got = false;
    try {
      const res = await rig.exec(cmd, cwd, (chunk) => {
        got = true;
        for (const ln of chunk.replace(/\r\n/g, "\n").split("\n")) {
          if (ln.length) push({ kind: "out", text: ln });
        }
      });
      if (res.code !== 0)
        push({
          kind: "err",
          text: `exit ${res.code}${res.timedOut ? " (timed out)" : ""}`,
        });
      else if (!got) push({ kind: "sys", text: "·" });
    } catch (e) {
      push({ kind: "err", text: e instanceof Error ? e.message : "exec failed" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Screen pad={0}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        {/* header */}
        <View style={styles.topBar}>
          <PressScale
            onPress={() => (router.canGoBack() ? router.back() : router.navigate("/home"))}
            style={styles.circleBtn}
            hitSlop={8}
          >
            <Icon name="chevron.left" android="arrow_back" color={T.ink} size={16} />
          </PressScale>
          <PressScale
            onPress={() => router.navigate("/code/folders")}
            style={styles.cwdPill}
            hitSlop={6}
          >
            <Icon name="folder" android="folder" color={T.sub} size={12} />
            <Text style={[FONT.small, { color: T.ink, ...fw("600") }]} numberOfLines={1}>
              {cwd ? cwd.replace(/^\/Users\/[^/]+/, "~") : "…"}
            </Text>
            <Icon name="chevron.down" android="expand_more" color={T.faint} size={11} />
          </PressScale>
          <PressScale
            onPress={() => setLines([])}
            style={styles.circleBtn}
            hitSlop={8}
            accessibilityLabel="Clear terminal"
          >
            <Icon name="trash" android="delete" color={T.sub} size={14} />
          </PressScale>
        </View>

        {/* scrollback */}
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={{ padding: 14, paddingBottom: 8 }}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          showsVerticalScrollIndicator={false}
        >
          {lines.map((l, i) => (
            <Text
              key={i}
              selectable
              style={[
                FONT.mono,
                { fontSize: 12, lineHeight: 17 },
                l.kind === "cmd" && { color: T.ink, ...fw("600"), marginTop: 10 },
                l.kind === "out" && { color: T.inkSoft },
                l.kind === "err" && { color: T.bad },
                l.kind === "sys" && { color: T.faint },
              ]}
            >
              {l.text}
            </Text>
          ))}
          {running ? (
            <Text style={[FONT.mono, { color: T.faint, fontSize: 12, marginTop: 4 }]}>
              running…
            </Text>
          ) : null}
        </ScrollView>

        {/* input */}
        <View style={styles.inputBar}>
          <Text style={[FONT.mono, { color: T.working, fontSize: 13 }]}>❯</Text>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={connected ? "type a command" : "not connected"}
            placeholderTextColor={T.faint}
            editable={connected && !running}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            returnKeyType="send"
            onSubmitEditing={run}
            style={[FONT.mono, styles.input]}
          />
          <PressScale
            onPress={run}
            disabled={!input.trim() || running}
            hitSlop={8}
            style={({ pressed }) => pressed && { opacity: 0.7 }}
          >
            <Icon
              name="arrow.up.circle.fill"
              android="arrow_circle_up"
              color={input.trim() && !running ? T.ink : T.faint}
              size={24}
            />
          </PressScale>
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
  cwdPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minWidth: 0,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: T.pillBg,
  },
  scroll: { flex: 1, backgroundColor: T.surfaceSoft },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.hairline,
    backgroundColor: T.surface,
  },
  input: {
    flex: 1,
    color: T.ink,
    paddingVertical: 4,
    ...FONT.mono,
  },
});
