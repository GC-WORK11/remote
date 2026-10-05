// PR view — Cursor's mobile pull-request page. Reached by tapping a PRCard
// in-thread. Everything on screen comes from real wire data: the PR URL the
// agent announced (param / sessionMeta.pr), files it touched (mutating tool
// args), archived observe frames, and rig.exec for "Mark Ready". Checks come
// from rig.pr.checks (`gh pr checks --json`, polled) — when the rig can't
// answer, the ring renders "waiting" and says so, never a fake pass.
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Linking,
  Image,
  Modal,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { Screen } from "../components/glass";
import { Icon } from "../components/icon";
import { MiniCheck, Spinner } from "../components/bubbles";
import { T, FONT, fw } from "../theme";
import { useRig } from "../state";
import { sessionTitle } from "../useChat";
import { rig, Frame } from "../rig";
import { PressScale } from "../components/pressable";

type CheckState = "waiting" | "passed" | "failed";

// Waiting: teal ring with a rotating arc. Settled: the arc fades and the
// verdict pops in — pass = green check, fail = red ×.
function ChecksRing({ state, size = 54 }: { state: CheckState; size?: number }) {
  const spin = useSharedValue(0);
  const settled = useSharedValue(0);
  useEffect(() => {
    spin.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.linear }),
      -1,
      false
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    settled.value = withTiming(state === "waiting" ? 0 : 1, { duration: 320 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const arc = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
    opacity: 1 - settled.value,
  }));
  const done = useAnimatedStyle(() => ({
    opacity: settled.value,
    transform: [{ scale: 0.55 + settled.value * 0.45 }],
  }));
  const teal = "#0FA5A0";
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: size / 2, borderWidth: 3, borderColor: "rgba(0,0,0,0.07)" },
        ]}
      />
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: size / 2,
            borderWidth: 3,
            borderColor: "rgba(0,0,0,0)",
            borderTopColor: teal,
            borderRightColor: teal,
          },
          arc,
        ]}
      />
      <Animated.View
        style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }, done]}
      >
        {state !== "waiting" ? (
          <MiniCheck ok={state === "passed"} size={size * 0.56} />
        ) : null}
      </Animated.View>
    </View>
  );
}

// Whatever check truth the wire carries — session.pr.checks / session.checks /
// meta.pr.checks — normalized. Empty means "not reported", rendered as waiting.
function readChecks(session: any, metaChecks: any): { label: string; state: CheckState }[] {
  const raw = session?.pr?.checks ?? session?.checks ?? metaChecks;
  if (!Array.isArray(raw)) return [];
  return raw.map((c: any) => {
    const st = String(c?.conclusion ?? c?.state ?? c?.status ?? "").toLowerCase();
    const state: CheckState = /success|pass|ok/.test(st)
      ? "passed"
      : /fail|error|cancel|timed/.test(st)
        ? "failed"
        : "waiting";
    return { label: String(c?.name || c?.label || "check"), state };
  });
}

function FileRow({ path, cwd }: { path: string; cwd?: string }) {
  const rel =
    cwd && path.startsWith(cwd)
      ? path.slice(cwd.length).replace(/^\//, "")
      : path;
  const leaf = rel.split("/").pop() || rel;
  const dir = rel.length > leaf.length ? rel.slice(0, rel.length - leaf.length) : "";
  return (
    <View style={styles.fileRow}>
      <Icon name="doc.text" android="description" color={T.faint} size={13} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[FONT.mono, { color: T.inkSoft, fontSize: 12 }]}>
          {leaf}
        </Text>
        {dir ? (
          <Text numberOfLines={1} style={[FONT.tiny, { color: T.faint, fontSize: 10 }]}>
            {dir}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// Archived observe frame → walkthrough thumb (computer.shot_file on demand).
function ShotThumb({ name }: { name: string }) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rig.fetchShot(name).then((f) => {
      if (!live) return;
      const b64 = f?.imageBase64;
      if (typeof b64 === "string")
        setUri(`data:image/${f?.format === "png" ? "png" : "jpeg"};base64,${b64}`);
    });
    return () => {
      live = false;
    };
  }, [name]);
  return (
    <View style={styles.shotThumb}>
      {uri ? (
        <Image source={{ uri }} style={styles.shotImg} resizeMode="cover" />
      ) : (
        <View style={[styles.shotImg, { alignItems: "center", justifyContent: "center" }]}>
          <Spinner size={13} />
        </View>
      )}
    </View>
  );
}

export default function PrView() {
  const { url, title: pTitle, branch, sid } = useLocalSearchParams<{
    url?: string;
    title?: string;
    branch?: string;
    sid?: string;
  }>();
  const { sessions, active, sessionMeta, connected } = useRig();
  const session = sessions.find((s) => (s.id || s.sessionId) === (sid || active));

  const title = pTitle || (session ? sessionTitle(session) : "Pull Request");
  const metaPr = (sid || active) ? sessionMeta[(sid || active) as string]?.pr : undefined;
  const prUrl = url || metaPr?.url || "";
  const repo = branch ||
    (session?.cwd
      ? String(session.cwd).replace(/\/+$/, "").split("/").slice(-2).join("/")
      : "");

  // Live PR truth via rig.pr.info (the laptop's `gh`). When it answers we
  // show real checks/files/state; when it can't (gh missing/unauthed) the
  // wire-derived fallbacks below carry the honest empty states.
  const [prLive, setPrLive] = useState<Frame | null>(null);
  const [prErr, setPrErr] = useState<string>("");
  const loadPr = () =>
    rig
      .prInfo(prUrl)
      .then((f) => {
        if (f.ok === false || (f.ok === undefined && f.error)) setPrErr(String(f.error || ""));
        else setPrLive(f);
      })
      .catch(() => setPrErr(""));
  useEffect(() => {
    if (connected && prUrl) loadPr().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, prUrl]);

  const liveChecks = readChecks(
    prLive ? { checks: prLive.statusCheckRollup } : undefined,
    undefined
  );

  // Fresher truth: rig.pr.checks runs `gh pr checks --json` on the host and
  // buckets each run (pass/fail/pending). Polls while the PR is open so the
  // ring flips to its verdict without a manual refresh.
  const [ciChecks, setCiChecks] = useState<{ label: string; state: CheckState }[]>([]);
  useEffect(() => {
    if (!connected || !prUrl) return;
    let dead = false;
    const pull = () =>
      rig
        .prChecks(prUrl)
        .then((r) => {
          if (dead || !r.ok || !Array.isArray(r.checks)) return;
          setCiChecks(
            r.checks.map((ch: any) => ({
              label: String(ch.name || ch.workflow || "check"),
              state:
                ch.bucket === "pass"
                  ? "passed"
                  : ch.bucket === "fail"
                    ? "failed"
                    : "waiting",
            }))
          );
        })
        .catch(() => {});
    pull();
    const t = setInterval(pull, 30000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [connected, prUrl]);

  const checks = ciChecks.length
    ? ciChecks
    : liveChecks.length
      ? liveChecks
      : readChecks(session, metaPr?.checks);
  const checkState: CheckState = checks.some((c) => c.state === "failed")
    ? "failed"
    : checks.length && checks.every((c) => c.state === "passed")
      ? "passed"
      : "waiting";
  const files: string[] = prLive?.files?.length
    ? prLive.files.map((f: any) => String(f?.path || f)).filter(Boolean)
    : metaPr?.files || [];
  const shots = metaPr?.shots || [];
  const prState = String(prLive?.state || "OPEN").toUpperCase();
  const liveTitle = prLive?.title ? String(prLive.title) : title;
  const liveBranch = prLive?.headRefName ? String(prLive.headRefName) : repo;
  const diffCounts =
    typeof prLive?.additions === "number" || typeof prLive?.deletions === "number"
      ? `+${prLive?.additions ?? 0} −${prLive?.deletions ?? 0}`
      : "";

  let host = "";
  try {
    host = prUrl ? new URL(prUrl).host : "";
  } catch {}

  // Mark Ready → `gh pr ready` on the rig via rig.exec; the exec stream
  // reports the real exit code back.
  const [marking, setMarking] = useState(false);
  const [markNote, setMarkNote] = useState("");
  const execId = useRef("");
  const lastOut = useRef("");
  useEffect(
    () =>
      rig.onFrame((f: Frame) => {
        if (f.type === "exec.started") execId.current = String(f.execId || "");
        else if (f.type === "exec.output" && String(f.execId || "") === execId.current)
          lastOut.current = String(f.chunk || "");
        else if (f.type === "exec.done" && String(f.execId || "") === execId.current) {
          setMarking(false);
          execId.current = "";
          if (f.code === 0) {
            setMarkNote("Marked ready for review");
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } else {
            const tail = lastOut.current.trim().split("\n").pop() || "";
            setMarkNote(tail ? tail.slice(0, 90) : `gh exited ${f.code}`);
          }
        }
      }),
    []
  );
  const markReady = () => {
    const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
    if (!m || marking) return;
    setMarking(true);
    setMarkNote("");
    lastOut.current = "";
    try {
      rig.send({
        type: "rig.exec",
        command: `$(type -P gh 2>/dev/null || echo gh) pr ready ${m[3]} --repo ${m[1]}/${m[2]}`,
        cwd: session?.cwd,
      });
    } catch {
      setMarking(false);
      setMarkNote("Not connected to the rig");
    }
  };

  // Merge — real `gh pr merge` on the laptop through rig.pr.merge. The sheet
  // picks the method + delete-branch; the reply carries gh's own output.
  const [mergeOpen, setMergeOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const [delBranch, setDelBranch] = useState(true);
  const merge = async (method: "squash" | "merge" | "rebase") => {
    if (merging) return;
    setMerging(true);
    setMergeOpen(false);
    setMarkNote("Merging…");
    try {
      const f: any = await rig.prMerge(prUrl, method, delBranch);
      if (f.ok === false) throw new Error(String(f.error || "merge failed"));
      setMarkNote(`Merged (${method})`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      loadPr().catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : "merge failed";
      setMarkNote(msg.slice(0, 90));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setMerging(false);
    }
  };

  return (
    <Screen pad={16}>
      {/* header — back, centered label, open-external */}
      <View style={styles.top}>
        <PressScale
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/home"))}
          style={styles.circleBtn}
          hitSlop={8}
        >
          <Icon name="chevron.left" android="arrow_back" color={T.ink} size={17} />
        </PressScale>
        <Text style={[FONT.small, { color: T.sub, ...fw("600") }]}>Pull request</Text>
        <PressScale
          onPress={() => prUrl && Linking.openURL(prUrl)}
          style={styles.circleBtn}
          hitSlop={8}
        >
          <Icon name="arrow.up.right" android="north_east" color={T.ink} size={15} />
        </PressScale>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 18 }}>
        {/* title + state */}
        <View style={styles.headCard}>
          <Text style={[FONT.head, { color: T.ink, fontSize: 18, lineHeight: 24 }]}>
            {liveTitle}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 9 }}>
            <View
              style={[
                styles.openChip,
                prState === "MERGED" && { backgroundColor: "rgba(130,90,220,0.14)" },
                (prState === "CLOSED" || prState === "DRAFT") && {
                  backgroundColor: "rgba(0,0,0,0.07)",
                },
              ]}
            >
              <Text
                style={[
                  FONT.tiny,
                  {
                    color:
                      prState === "OPEN"
                        ? T.prGreen
                        : prState === "MERGED"
                          ? "#7A5BC0"
                          : T.sub,
                    ...fw("700"),
                  },
                ]}
              >
                {prState === "OPEN"
                  ? "Open"
                  : prState.charAt(0) + prState.slice(1).toLowerCase()}
              </Text>
            </View>
            {diffCounts ? (
              <Text style={[FONT.mono, { color: T.sub, fontSize: 11 }]}>{diffCounts}</Text>
            ) : null}
            {liveBranch ? (
              <Text numberOfLines={1} style={[FONT.mono, { color: T.sub, fontSize: 11, flexShrink: 1 }]}>
                {liveBranch}
              </Text>
            ) : null}
            {host ? (
              <Text numberOfLines={1} style={[FONT.tiny, { color: T.faint }]}>
                {host}
              </Text>
            ) : null}
          </View>
        </View>

        {/* checks */}
        <View style={styles.checkCard}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 13 }}>
            <ChecksRing state={checkState} />
            <View style={{ flex: 1 }}>
              <Text style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 14 }]}>
                {checkState === "waiting"
                  ? "Waiting for checks"
                  : checkState === "passed"
                    ? "Checks passed"
                    : "Checks failed"}
              </Text>
              <Text style={[FONT.tiny, { color: T.faint, marginTop: 2 }]}>
                {checks.length
                  ? `${checks.filter((c) => c.state === "passed").length}/${checks.length} passed`
                  : prErr
                    ? prErr.slice(0, 120)
                    : "Live check status is not reported by the rig yet"}
              </Text>
            </View>
          </View>
          {checks.length ? (
            <View style={{ marginTop: 11, gap: 6 }}>
              {checks.map((c, i) => (
                <View key={i} style={styles.checkRow}>
                  {c.state === "waiting" ? (
                    <Spinner size={12} />
                  ) : (
                    <MiniCheck ok={c.state === "passed"} size={13} />
                  )}
                  <Text numberOfLines={1} style={[FONT.small, { color: T.sub, fontSize: 12.5, flex: 1 }]}>
                    {c.label}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>

        {/* files the run touched — no diff counts on the wire, so none shown */}
        <View style={styles.section}>
          <Text style={[FONT.tiny, styles.sectionLabel]}>FILES TOUCHED</Text>
          {files.length ? (
            <View style={styles.fileCard}>
              {files.map((f) => (
                <FileRow key={f} path={f} cwd={session?.cwd} />
              ))}
            </View>
          ) : (
            <Text style={[FONT.tiny, { color: T.faint }]}>
              Changed files are not reported by the rig yet
            </Text>
          )}
        </View>

        {/* walkthrough — only when the agent actually observed the screen */}
        {shots.length ? (
          <View style={styles.section}>
            <Text style={[FONT.tiny, styles.sectionLabel]}>WALKTHROUGH</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 10 }}>
                {shots.map((s) => (
                  <ShotThumb key={s} name={s} />
                ))}
              </View>
            </ScrollView>
          </View>
        ) : null}
      </ScrollView>

      {/* bottom dock — review state, open, mark ready */}
      <View style={styles.dock}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[FONT.head, { color: T.ink, fontSize: 15 }]}>Review</Text>
          <Text numberOfLines={1} style={[FONT.tiny, { color: markNote ? T.sub : T.faint }]}>
            {markNote ||
              (files.length
                ? `${files.length} file${files.length === 1 ? "" : "s"} touched`
                : checkState === "waiting"
                  ? "Checks pending"
                  : `${checks.filter((c) => c.state === "passed").length}/${checks.length} checks`)}
          </Text>
        </View>
        <PressScale
          onPress={() => prUrl && Linking.openURL(prUrl)}
          style={({ pressed }) => [styles.dockBtnGhost, pressed && { opacity: 0.7 }]}
        >
          <Text style={[FONT.small, { color: T.ink, ...fw("600") }]}>Review</Text>
        </PressScale>
        {prState === "OPEN" ? (
          <PressScale
            onPress={markReady}
            disabled={marking || !prUrl}
            style={({ pressed }) => [
              styles.dockBtnGhost,
              (!prUrl || marking) && { opacity: 0.55 },
              pressed && { opacity: 0.7 },
            ]}
          >
            {marking ? (
              <Spinner size={12} />
            ) : (
              <Text style={[FONT.small, { color: T.ink, ...fw("600") }]}>Ready</Text>
            )}
          </PressScale>
        ) : null}
        {prState === "OPEN" ? (
          <PressScale
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setMergeOpen(true);
            }}
            // Reported checks still running → hold the button (the rings
            // explain why; green flips it back). Zero reported checks —
            // gh unauthed/missing — can't gate on what we can't see, so
            // the button stays and gh's own verdict comes back as the note.
            disabled={merging || !prUrl || (checks.length > 0 && checkState === "waiting")}
            style={({ pressed }) => [
              styles.dockBtnDark,
              (!prUrl || merging || (checks.length > 0 && checkState === "waiting")) && { opacity: 0.55 },
              pressed && { opacity: 0.85 },
            ]}
          >
            {merging ? (
              <Spinner size={12} color="#fff" />
            ) : (
              <Text style={[FONT.small, { color: "#fff", ...fw("600") }]}>Merge</Text>
            )}
          </PressScale>
        ) : (
          <PressScale
            onPress={markReady}
            disabled={marking || !prUrl}
            style={({ pressed }) => [
              styles.dockBtnDark,
              (!prUrl || marking) && { opacity: 0.55 },
              pressed && { opacity: 0.85 },
            ]}
          >
            {marking ? (
              <Spinner size={12} color="#fff" />
            ) : (
              <Text style={[FONT.small, { color: "#fff", ...fw("600") }]}>Mark Ready</Text>
            )}
          </PressScale>
        )}
      </View>

      {/* merge sheet — method + delete-branch, then gh does the rest */}
      <Modal
        visible={mergeOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setMergeOpen(false)}
      >
        <PressScale style={styles.sheetScrim} onPress={() => setMergeOpen(false)}>
          <PressScale style={styles.mergeSheet} onPress={() => {}}>
            <Text style={[FONT.head, { color: T.ink }]}>Merge pull request</Text>
            <Text style={[FONT.tiny, { color: T.sub, marginTop: 3, marginBottom: 12 }]}>
              Runs `gh pr merge` on {host || "your laptop"}.
            </Text>
            {(["squash", "merge", "rebase"] as const).map((m) => (
              <PressScale
                key={m}
                onPress={() => merge(m)}
                style={({ pressed }) => [
                  styles.mergeRow,
                  pressed && { backgroundColor: "rgba(0,0,0,0.04)" },
                ]}
              >
                <Icon
                  name="arrow.triangle.merge"
                  android="call_merge"
                  color={T.ink}
                  size={15}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[FONT.small, { color: T.ink, ...fw("600") }]}>
                    {m === "squash" ? "Squash and merge" : m === "merge" ? "Create a merge commit" : "Rebase and merge"}
                  </Text>
                  <Text style={[FONT.tiny, { color: T.faint, marginTop: 1 }]}>
                    {m === "squash"
                      ? "Commits become one"
                      : m === "merge"
                        ? "All commits + merge commit"
                        : "Commits replayed onto base"}
                  </Text>
                </View>
                <Icon name="chevron.right" android="chevron_right" color={T.faint} size={14} />
              </PressScale>
            ))}
            <PressScale
              onPress={() => setDelBranch(!delBranch)}
              style={styles.delRow}
              hitSlop={6}
            >
              <Icon
                name={delBranch ? "checkmark.square.fill" : "square"}
                android={delBranch ? "check_box" : "check_box_outline_blank"}
                color={delBranch ? T.ink : T.faint}
                size={16}
              />
              <Text style={[FONT.small, { color: T.sub, flex: 1 }]}>
                Delete the branch after merge
              </Text>
            </PressScale>
          </PressScale>
        </PressScale>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  circleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: T.pillBg,
    alignItems: "center",
    justifyContent: "center",
  },
  headCard: {
    backgroundColor: T.cardBgTint,
    borderRadius: T.rCard,
    padding: 16,
    marginTop: 8,
  },
  openChip: {
    backgroundColor: "rgba(31,168,92,0.13)",
    borderRadius: T.rPill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  checkCard: {
    backgroundColor: T.cardBgTint,
    borderRadius: T.rCard,
    padding: 16,
    marginTop: 12,
  },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 2 },
  section: { marginTop: 16, gap: 8 },
  sectionLabel: { color: T.faint, letterSpacing: 0.9, paddingLeft: 2 },
  fileCard: {
    backgroundColor: T.cardBgTint,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingVertical: 9,
  },
  shotThumb: {
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: T.cardBgTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
  },
  shotImg: { width: 168, height: 104 },
  dock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 10,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.hairlineStrong,
  },
  dockBtnGhost: {
    borderRadius: T.rPill,
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
  },
  dockBtnDark: {
    borderRadius: T.rPill,
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: T.ink,
    minWidth: 92,
    alignItems: "center",
  },
  sheetScrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  mergeSheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 18,
    paddingBottom: 28,
  },
  mergeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: 12,
  },
  delRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 6,
    marginTop: 4,
  },
});
