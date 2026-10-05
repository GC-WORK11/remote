// Thread — the open conversation. Chrome adapts to mode: cowork keeps the
// Grok header (buddy + monitor shortcut); code adds context chips + PR card.
import React, { useRef } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Modal,
  ScrollView,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import Animated, { FadeIn } from "react-native-reanimated";
import { Screen } from "../components/glass";
import { Composer } from "../components/composer";

import { PRCard, ApprovalSheet, isBigApproval, findPrUrl } from "../components/cards";
import { ThreadRow, LiveTail, StatusDot, WorkingRow, ErrBox } from "../components/rows";
import { Buddy, buddyName } from "../components/mascot";
import { Icon } from "../components/icon";
import { openMergeSheet, openSpawnSheet, useMergePhase } from "../components/sheetbus";
import { T, FONT, fw, tilde } from "../theme";
import { useSessionChat, sessionTitle, startPlainSession, isExpectingNew, cleanPreview } from "../useChat";
import type { Row } from "../useChat";
import { useRig } from "../state";
import { rig } from "../rig";
import { PressScale } from "../components/pressable";

// Slash commands — the "/" autocomplete lists actions the rig actually has.
// Each fills the field; sending it just prompts the session.
export const SLASH_COMMANDS = [
  { name: "screenshot", label: "/screenshot", insert: "Take a screenshot of my screen" },
  { name: "observe", label: "/observe", insert: "Observe my screen and describe what's on it" },
  { name: "recordings", label: "/recordings", insert: "List my screen recordings" },
  { name: "model", label: "/model", insert: "What model are you running?" },
  { name: "status", label: "/status", insert: "Summarize what's running" },
];

export default function Thread() {
  const c = useSessionChat();
  const { mode, setActive, setAuthSheet, authProviders, setScreenSheet, setDrawerOpen, sessions, patchMeta } =
    useRig();
  const list = useRef<{ scrollToEnd: (o?: { animated?: boolean }) => void } | null>(null);
  // New rows only pull the view down when the user is already at the tail —
  // reading history or a prepended page must never yank the scroll position.
  const atBottom = useRef(true);
  const onListScroll = (e: {
    nativeEvent: { contentOffset: { y: number }; layoutMeasurement: { height: number }; contentSize: { height: number } };
  }) => {
    const ne = e.nativeEvent;
    atBottom.current =
      ne.contentOffset.y + ne.layoutMeasurement.height >= ne.contentSize.height - 80;
    if (ne.contentOffset.y < 64) c.loadOlder();
  };
  const maybeScrollToEnd = () => {
    if (atBottom.current) list.current?.scrollToEnd({ animated: true });
  };
  const bindList = (v: FlatList | ScrollView | null) => {
    list.current = v;
  };
  // Deep link: remote://thread?sid=<id> focuses that session — same target
  // notifications will use later.
  const { sid } = useLocalSearchParams<{ sid?: string }>();
  React.useEffect(() => {
    if (sid && sid !== c.active) setActive(sid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  // IDE-parity slash set: surface hops run locally, the rest fill a prompt.
  const slashCommands =
    mode === "code"
      ? [
          { name: "files", label: "/files", insert: "Browse my folders", run: () => router.navigate("/code/folders") },
          { name: "terminal", label: "/terminal", insert: "Open the terminal", run: () => router.navigate("/code/terminal") },
          { name: "browser", label: "/browser", insert: "Open a page served on my computer", run: () => router.navigate("/code/browser") },
          { name: "new", label: "/new", insert: "Start a new thread", run: () => { startPlainSession(); } },
          { name: "diff", label: "/diff", insert: "Show me the current git diff of my changes" },
          { name: "checkpoint", label: "/checkpoint", insert: "Create a checkpoint of the workspace now" },
          { name: "rewind", label: "/rewind", insert: "List my checkpoints so I can rewind to one" },
          { name: "commit", label: "/commit", insert: "Commit my current changes with a good message" },
          { name: "push", label: "/push", insert: "Push my branch to the remote" },
          { name: "pr", label: "/pr", insert: "Open a pull request for this branch" },
          { name: "test", label: "/test", insert: "Run the tests in this project and report the results" },
          { name: "review", label: "/review", insert: "Review my uncommitted changes for bugs and style" },
          { name: "simplify", label: "/simplify", insert: "Simplify the code we just touched — same behavior, cleaner" },
          { name: "compact", label: "/compact", insert: "Compact this conversation — summarize context and continue" },
          { name: "rename", label: "/rename", insert: "Give this thread a better name" },
          ...SLASH_COMMANDS,
        ]
      : [
          { name: "open", label: "/open", insert: "Open " },
          { name: "type", label: "/type", insert: "Type " },
          { name: "awake", label: "/awake", insert: "Keep my laptop awake" },
          ...SLASH_COMMANDS,
        ];

  // Read once per render so the memo below recomputes when the flag flips —
  // isExpectingNew() is module state, not reactive, and a memo keyed only on
  // c.rows would serve a stale [] after the pending session lands.
  const expecting = isExpectingNew();
  const title = expecting ? "Remote" : c.active ? sessionTitle(c.session) : "Remote";
  const repo = c.session?.cwd
    ? c.session.cwd.replace(/\/+$/, "").split("/").slice(-2).join("/")
    : undefined;
  const loc = tilde(c.session?.cwd);
  // Daemon probes git once per session — empty string when cwd isn't a repo.
  const branch = (c.session as { branch?: string } | undefined)?.branch || "";
  const buddyKey = expecting ? "remote" : c.active || "remote";

  // The thread shows conversation + artifacts only — execution-trace rows
  // (tool checklists, status beats, daemon events) stay out of the UI. The
  // data still exists for selectors above; this is purely visual.
  const visibleRows = React.useMemo(
    // A "+" new-session is in flight: show the empty state, not the
    // previous session's rows, until session.started lands the new id.
    () => {
      if (expecting) return [];
      const kept = c.rows.filter(
        (r) => r.kind !== "prog" && r.kind !== "event" && r.kind !== "check"
      );
      // One turn = one voice: interim narration commits as separate agent
      // rows, but the thread reads them as a single bubble — consecutive
      // agent rows merge into the first. Cards/artifacts between them
      // (shots, delivers, errors) still split bubbles naturally.
      const out: typeof kept = [];
      for (const r of kept) {
        const last = out[out.length - 1];
        if (r.kind === "agent" && last?.kind === "agent" && last.text && r.text) {
          out[out.length - 1] = { ...last, text: `${last.text}\n\n${r.text}` };
        } else out.push(r);
      }
      return out;
    },
    [c.rows, expecting]
  );
  const lastAgent = React.useMemo(
    () => [...c.rows].reverse().find((r) => r.kind === "agent" && r.text),
    [c.rows]
  );
  const prUrl = lastAgent?.text ? findPrUrl(lastAgent.text) : null;
  const prMeta = c.meta?.pr;
  const prChecks = prMeta?.checks || [];
  const mergePhase = useMergePhase(prUrl || undefined);

  // Live CI rollup — rig.pr.checks runs real `gh pr checks --json` on the
  // host; buckets map onto the card's waiting/passed/failed vocabulary.
  // Polls while the PR stays open so a red-to-green flip lands by itself.
  React.useEffect(() => {
    if (!prUrl || !c.active || !c.connected) return;
    const sid = c.active;
    let dead = false;
    const pull = () =>
      rig
        .prChecks(prUrl)
        .then((r) => {
          if (dead || !r.ok || !Array.isArray(r.checks)) return;
          const checks = r.checks.map(
            (ch: any): { label: string; state: "waiting" | "passed" | "failed" } => ({
              label: String(ch.name || ch.workflow || "check"),
              state:
                ch.bucket === "pass"
                  ? "passed"
                  : ch.bucket === "fail"
                    ? "failed"
                    : "waiting",
            })
          );
          patchMeta(sid, { pr: { ...c.meta?.pr, url: prUrl, checks } });
        })
        .catch(() => {});
    pull();
    const t = setInterval(pull, 30000);
    return () => {
      dead = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prUrl, c.active, c.connected]);

  // Sub-agents — sessions.list rows carry parentId from the wire; this
  // thread's children render as a collapsible section above the composer.
  const childSessions = React.useMemo(
    () => sessions.filter((s: any) => s.parentId === c.active),
    [sessions, c.active]
  );
  const parentSession = React.useMemo(
    () => sessions.find((s: any) => (s.id || s.sessionId) === c.session?.parentId),
    [sessions, c.session?.parentId]
  );
  // Default: expanded once children exist, a slim collapsed row otherwise —
  // the section is the spawn affordance's home without adding chrome to
  // plain threads. A manual toggle sticks until the child count changes
  // (render-time derived state — the documented pattern, no effect needed).
  const [subsToggled, setSubsToggled] = React.useState<boolean | null>(null);
  const [subsSeen, setSubsSeen] = React.useState(0);
  if (subsSeen !== childSessions.length) {
    setSubsSeen(childSessions.length);
    setSubsToggled(null);
  }
  const subsOpen = subsToggled ?? childSessions.length > 0;
  // Mergeable = checks the wire actually reported and all passed — when the
  // wire can't answer, the pill stays honest and simply doesn't show.
  const mergeable =
    !!prUrl &&
    mergePhase === "idle" &&
    prChecks.length > 0 &&
    prChecks.every((ch) => ch.state === "passed");
  const modelLabel = c.model || c.meta?.model || undefined;
  const hasAgentTurn = React.useMemo(
    () => c.rows.some((r) => r.kind === "agent"),
    [c.rows]
  );

  // Ref 4: a big/destructive ask pops the dark approval sheet over the
  // thread; the inline card stays as the record. Dismissing the backdrop
  // hushes it for that request only (a second pending ask re-raises it).
  const bigAsk = React.useMemo(
    () =>
      mode === "cowork"
        ? [...c.rows].reverse().find(
            (r) =>
              r.kind === "approval" &&
              r.approval?.state === "pending" &&
              isBigApproval(r.approval.title, r.approval.preview)
          )
        : undefined,
    [c.rows, mode]
  );
  const [hushedAsk, setHushedAsk] = React.useState<string | null>(null);
  const askReqId = bigAsk?.approval?.reqId || "";
  const askOpen = !!bigAsk && askReqId !== hushedAsk;
  const coworkCtx = repo || "your computer";
  // Persona is always the buddy — the session title is the header's job.
  const agentName = buddyName(buddyKey);

  // RowView is memoized — inline closures would defeat it and re-render
  // every row on each ~12fps stream flush. respondApproval closes over the
  // hook's live `active`; keep it behind a ref so the callback identity is
  // stable while the latest impl still runs.
  const respondApprovalRef = useRef(c.respondApproval);
  React.useEffect(() => {
    respondApprovalRef.current = c.respondApproval;
  });
  const onShot = React.useCallback(() => setScreenSheet(true), [setScreenSheet]);
  const onApproval = React.useCallback(
    (row: Row, choice: "primary" | "secondary") =>
      respondApprovalRef.current(row.approval?.reqId || "", choice === "primary"),
    []
  );

  return (
    <Screen pad={16}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* header — back, identity pill, monitor shortcut */}
        <Animated.View entering={FadeIn.duration(180)} style={styles.chatTop}>
          <PressScale
            onPress={() => {
              setActive(null);
              // Deep-linked entry has no back stack — GO_BACK would throw
              // an unhandled-action toast. Land on the inbox instead.
              if (router.canGoBack()) router.back();
              else router.replace("/home");
            }}
            style={styles.circleBtn}
            hitSlop={8}
          >
            <Icon name="chevron.left" android="arrow_back" color={T.ink} size={17} />
          </PressScale>
          <View style={styles.pillSlot}>
            <PressScale
              onPress={mode === "code" ? () => setDrawerOpen(true) : undefined}
              disabled={mode !== "code"}
              style={styles.namePill}
            >
              {/* the agent's blob + name, like the Grok thread header */}
              <Buddy k={buddyKey} size={22} />
              <View style={{ marginLeft: 8, minWidth: 0, maxWidth: "78%" }}>
                <View style={styles.titleRow}>
                  <Text
                    style={[FONT.head, { color: T.ink, flexShrink: 1 }]}
                    numberOfLines={1}
                  >
                    {/* refs 1/6/7 name the agent persona in the pill */}
                    {mode === "cowork" ? agentName : title}
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
                    <StatusDot live={c.streaming} />
                  )}
                </View>
                <Text style={[FONT.meta, { color: T.sub }]} numberOfLines={1}>
                  {mode === "code" ? loc || "~/rig" : "your computer"}
                </Text>
              </View>
            </PressScale>
          </View>
          <PressScale
            onPress={() => setScreenSheet(true)}
            style={styles.circleBtn}
            hitSlop={8}
          >
            <Icon name="display" android="desktop_windows" color={T.ink} size={17} />
          </PressScale>
        </Animated.View>

        {/* Code-mode surface strip — branch context + Files/Terminal/
            Browser in ONE row: the Codex toolbar, not buried in the
            drawer. */}
        {mode === "code" ? (
          <View style={styles.toolsRow}>
            {repo || branch ? (
              <View style={styles.branchTag}>
                <Icon
                  name="arrow.triangle.branch"
                  android="account_tree"
                  color={T.faint}
                  size={10}
                />
                <Text style={[FONT.meta, { color: T.faint }]} numberOfLines={1}>
                  {branch || repo || loc}
                </Text>
              </View>
            ) : null}
            {([
              { icon: "folder", android: "folder", label: "Files", to: "/code/folders" },
              { icon: "apple.terminal", android: "terminal", label: "Terminal", to: "/code/terminal" },
              { icon: "globe", android: "language", label: "Browser", to: "/code/browser" },
              { icon: "book.closed", android: "menu_book", label: "Repos", to: "/code/repos" },
            ] as const).map((t) => (
              <PressScale
                key={t.label}
                onPress={() =>
                  router.navigate({
                    pathname: t.to,
                    params:
                      t.label === "Terminal" && c.session?.cwd
                        ? { cwd: c.session.cwd }
                        : {},
                  })
                }
                style={({ pressed }) => [styles.toolPill, pressed && { opacity: 0.65 }]}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t.label}
              >
                <Icon name={t.icon} android={t.android} color={T.sub} size={12} />
                <Text style={[FONT.meta, { color: T.sub, ...fw("600") }]}>{t.label}</Text>
              </PressScale>
            ))}
          </View>
        ) : null}

        {/* Sub-agents — real wire lineage: every sessions.list row whose
            parentId is this thread. Collapsible; each row is a live child
            (mascot, title, status) that taps through to its own thread.
            The spawn row runs session.spawn on the rig — the child gets
            this session's cwd by inheritance and the text as its first
            prompt. Empty (no children) renders nothing. */}
        {parentSession || c.session?.parentId ? (
          <PressScale
            onPress={() => parentSession && setActive(parentSession.id || parentSession.sessionId)}
            disabled={!parentSession}
            style={styles.parentLink}
            hitSlop={6}
          >
            <Icon name="arrow.turn.up.left" android="subdirectory_arrow_left" color={T.faint} size={11} />
            <Text style={[FONT.tiny, { color: T.faint }]} numberOfLines={1}>
              spawned by {parentSession ? sessionTitle(parentSession) : c.session?.parentId}
            </Text>
          </PressScale>
        ) : null}
        {childSessions.length || !expecting ? (
          <View style={styles.subsBox}>
            <View style={styles.subsHead}>
              <PressScale
                onPress={() => setSubsToggled(!subsOpen)}
                style={styles.subsHeadTap}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="Toggle sub-agents"
              >
                <Icon
                  name={subsOpen ? "chevron.down" : "chevron.right"}
                  android={subsOpen ? "expand_more" : "chevron_right"}
                  color={T.faint}
                  size={11}
                />
                <Text style={[FONT.tiny, styles.subsLabel]}>
                  SUB-AGENTS{childSessions.length ? ` · ${childSessions.length}` : ""}
                </Text>
              </PressScale>
              <View style={{ flex: 1 }} />
              {childSessions.some((s: any) => s.busy) ? (
                <View style={styles.subsBusyDot} />
              ) : null}
              {c.active ? (
                <PressScale
                  onPress={() => c.active && openSpawnSheet(c.active)}
                  style={({ pressed }) => [styles.subsAddBtn, pressed && { opacity: 0.7 }]}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Spawn a sub-agent"
                >
                  <Icon name="plus" android="add" color={T.ink} size={14} weight="semibold" />
                </PressScale>
              ) : null}
            </View>
            {subsOpen
              ? childSessions.map((s: any) => {
                  const sid = s.id || s.sessionId;
                  const working = !!s.busy;
                  const ended = s.alive === false;
                  const subline = working
                    ? "Working…"
                    : cleanPreview(s.preview || "") || tilde(s.cwd || "") || "Idle";
                  const status = working ? "Working" : ended ? "Ended" : "Idle";
                  return (
                    <PressScale
                      key={sid}
                      onPress={() => setActive(sid)}
                      style={({ pressed }) => [styles.subRow, pressed && { opacity: 0.7 }]}
                      hitSlop={4}
                    >
                      <Buddy k={sid} size={22} />
                      <View style={{ flex: 1, minWidth: 0, marginLeft: 9 }}>
                        <Text
                          style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 13.5 }]}
                          numberOfLines={1}
                        >
                          {sessionTitle(s)}
                        </Text>
                        <View
                          style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 }}
                        >
                          {working ? <StatusDot live /> : null}
                          <Text
                            style={[
                              FONT.tiny,
                              { flex: 1, color: working ? T.working : ended ? T.faint : T.sub },
                            ]}
                            numberOfLines={1}
                          >
                            {subline}
                          </Text>
                        </View>
                      </View>
                      <Text
                        style={[
                          FONT.tiny,
                          { color: working ? T.working : T.faint, ...fw("600") },
                        ]}
                      >
                        {status}
                      </Text>
                    </PressScale>
                  );
                })
              : null}
          </View>
        ) : null}

        {(() => {
          const renderRow = ({ item, index }: { item: (typeof visibleRows)[number]; index: number }) => (
            <ThreadRow
              row={item}
              rows={visibleRows}
              index={index}
              buddyKey={buddyKey}
              mode={mode}
              ctx={mode === "code" ? repo || "the rig" : coworkCtx}
              streaming={c.streaming}
              prUrl={prUrl || undefined}
              onShot={onShot}
              onApproval={onApproval}
            />
          );
          const footer = (
            <>
              {prUrl ? (
                <View style={{ marginTop: 10 }}>
                  <PRCard
                    title={title}
                    url={prUrl}
                    branch={repo}
                    checks={prChecks}
                    files={prMeta?.files}
                    mergeable={mergeable || mergePhase !== "idle"}
                    onPress={() =>
                      router.push({
                        pathname: "/pr",
                        params: {
                          url: prUrl,
                          title,
                          branch: repo || "",
                          sid: c.active || "",
                        },
                      })
                    }
                  />
                </View>
              ) : null}
              <LiveTail
                streamText={c.streamText}
                streaming={c.streaming}
                buddyKey={buddyKey}
                mode={mode}
                afterRows={visibleRows}
              />
            </>
          );
          return visibleRows.length <= 60 ? (
          // Below virtualization's pay-off the FlatList can drop tail cells on
          // native (scrollToEnd fires before the last batch mounts, leaving a
          // dead gap above the composer). A plain ScrollView renders every
          // row immediately — 60 rows is cheap.
          <ScrollView
            ref={bindList}
            onContentSizeChange={maybeScrollToEnd}
            onScroll={onListScroll}
            scrollEventThrottle={200}
            contentContainerStyle={{ paddingBottom: 14, paddingTop: 8 }}
            showsVerticalScrollIndicator={false}
          >
            {c.historyLoading ? (
              <Text style={[FONT.small, styles.earlierTag]}>Earlier…</Text>
            ) : null}
            {visibleRows.length === 0 ? (
              <View style={styles.emptyWrap}>
                <View style={styles.emptyTile}>
                  <Buddy k={buddyKey} size={84} />
                </View>
                <Text style={[FONT.head, { color: T.ink, marginTop: 16, fontSize: 15 }]}>
                  {agentName}
                </Text>
                <Text
                  style={[FONT.small, { color: T.sub, textAlign: "center", marginTop: 4 }]}
                >
                  {mode === "code"
                    ? "Describe the change — it edits on your computer."
                    : "It works on your real computer."}
                </Text>
              </View>
            ) : (
              visibleRows.map((item, index) => (
                <ErrBox key={item.id}>{renderRow({ item, index })}</ErrBox>
              ))
            )}
            {footer}
          </ScrollView>
        ) : (
        <FlatList
          ref={bindList}
          data={visibleRows}
          keyExtractor={(r) => r.id}
          onContentSizeChange={maybeScrollToEnd}
          onScroll={onListScroll}
          scrollEventThrottle={200}
          contentContainerStyle={{ paddingBottom: 14, paddingTop: 8 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={40}
          maxToRenderPerBatch={40}
          windowSize={15}
          updateCellsBatchingPeriod={24}
          removeClippedSubviews={false}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          ListHeaderComponent={
            c.historyLoading ? (
              <Text style={[FONT.small, styles.earlierTag]}>Earlier…</Text>
            ) : null
          }
          ListEmptyComponent={
            // Threads open clean: session mascot inside a soft tile + its
            // name + one line of context + the composer. No prefilled
            // prompts, no bare blob on the canvas.
            <View style={styles.emptyWrap}>
              <View style={styles.emptyTile}>
                <Buddy k={buddyKey} size={84} />
              </View>
              <Text style={[FONT.head, { color: T.ink, marginTop: 16, fontSize: 15 }]}>
                {agentName}
              </Text>
              <Text
                style={[FONT.small, { color: T.sub, textAlign: "center", marginTop: 4 }]}
              >
                {mode === "code"
                  ? "Describe the change — it edits on your computer."
                  : "It works on your real computer."}
              </Text>
            </View>
          }
          renderItem={({ item, index }) => (
            <ErrBox>{renderRow({ item, index })}</ErrBox>
          )}
          ListFooterComponent={footer}
        />
          );
        })()}

        <View style={styles.composerWrap}>
          {mode === "code" && prUrl && mergePhase !== "idle" ? (
            <View style={styles.mergePillRow}>
              <View style={styles.mergePillDone}>
                <Icon
                  name="checkmark"
                  android="check"
                  color={T.ok}
                  size={12}
                  weight="bold"
                />
                <Text style={[FONT.small, { color: T.ok, ...fw("600") }]}>
                  {mergePhase === "merging" ? "Merging" : "Merged"}
                </Text>
              </View>
            </View>
          ) : mergeable ? (
            <View style={styles.mergePillRow}>
              <PressScale
                onPress={() => {
                  if (prUrl)
                    openMergeSheet({
                      url: prUrl,
                      title,
                      branch: repo,
                    });
                }}
                style={({ pressed }) => [
                  styles.mergePill,
                  pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] },
                ]}
                hitSlop={6}
              >
                <Icon
                  name="checkmark"
                  android="check"
                  color={T.ok}
                  size={12}
                  weight="bold"
                />
                <Text style={[FONT.small, { color: T.ok, ...fw("600") }]}>
                  Ready to merge
                </Text>
                <Icon name="chevron.up" android="expand_less" color={T.faint} size={11} />
              </PressScale>
            </View>
          ) : null}
          {c.streaming ? (
            <WorkingRow buddyKey={buddyKey} status={c.status} name={agentName} sec={c.workSec} />
          ) : null}
          <Composer
            value={c.input}
            onChange={c.onInput}
            onSend={c.send}
            onStop={c.stop}
            streaming={c.streaming}
            attachments={c.attachments}
            onRemoveAttachment={(i) => c.setAttachments((a) => a.filter((_, j) => j !== i))}
            chips={
              c.active
                ? [
                    {
                      icon: "sparkles",
                      android: "auto_awesome",
                      label: modelLabel || "model",
                      onPress: c.openModels,
                    },
                  ]
                : []
            }
            // Spec composer: "Ask {agent}" in cowork (Grok's "Ask Inbox
            // Manager"); code keeps the Cursor composer verbs.
            placeholder={
              mode === "cowork"
                ? `Ask ${agentName}`
                : hasAgentTurn
                  ? "Send follow-up"
                  : "Ask to make changes"
            }
            slashCommands={slashCommands}
            disabled={!c.connected}
            split
          />
        </View>
      </KeyboardAvoidingView>

      {/* Ref 4 dark approval sheet — cowork only, big asks only. Deny maps
          to the request's secondary, Allow to its primary. */}
      <ApprovalSheet
        visible={askOpen}
        title={bigAsk?.approval?.title || ""}
        preview={bigAsk?.approval?.preview}
        primary={
          !bigAsk?.approval?.primary || bigAsk.approval.primary === "Approve"
            ? "Allow"
            : bigAsk.approval.primary
        }
        secondary={
          !bigAsk?.approval?.secondary || bigAsk.approval.secondary === "Decline"
            ? "Deny"
            : bigAsk.approval.secondary
        }
        actor={agentName}
        ctx={coworkCtx}
        onDecide={(choice) => {
          c.respondApproval(askReqId, choice === "primary");
          setHushedAsk(askReqId);
        }}
        onReview={() => setScreenSheet(true)}
        onDismiss={() => setHushedAsk(askReqId)}
      />

      <Modal
        visible={c.modelSheet}
        transparent
        animationType="fade"
        onRequestClose={() => c.setModelSheet(false)}
      >
        <PressScale style={styles.sheetBg} onPress={() => c.setModelSheet(false)}>
          <PressScale style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.grabber} />
            <Text style={[FONT.tiny, styles.sheetLabel]}>MODEL</Text>
            {(() => {
              // Reasoning effort — the level the model thinks at. The box
              // mirrors the model sheet anatomy: level + model + reset + a
              // segmented rail. Only shows for thinking-capable picks.
              const sel = c.models.find((m: any) => {
                const l = m.name || m.modelId || m.id || "";
                return l === c.model || m.modelId === c.model || m.id === c.model;
              });
              const efforts = Array.isArray(sel?.thinking?.efforts)
                ? sel.thinking.efforts
                : sel?.reasoning || sel?.thinking
                  ? ["minimal", "low", "medium", "high"]
                  : null;
              if (!efforts) return null;
              const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
              return (
                <View style={styles.effortBox}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <View>
                      <Text style={[FONT.body, { color: T.ink, fontSize: 15.5, ...fw("600") }]}>
                        {cap(c.effort)}
                      </Text>
                      <Text style={[FONT.tiny, { color: T.faint, marginTop: 1 }]} numberOfLines={1}>
                        {c.model}
                      </Text>
                    </View>
                    <PressScale onPress={() => c.setEffort("low")} hitSlop={10}>
                      <Icon
                        name="arrow.counterclockwise"
                        android="refresh"
                        color={T.faint}
                        size={15}
                      />
                    </PressScale>
                  </View>
                  <View style={styles.effortRow}>
                    {efforts.map((e: string) => (
                      <PressScale
                        key={e}
                        onPress={() => c.setEffort(e)}
                        style={[styles.effortPill, c.effort === e && styles.effortPillOn]}
                      >
                        <Text
                          style={[
                            FONT.tiny,
                            { color: c.effort === e ? T.bg : T.sub, ...fw("600") },
                          ]}
                        >
                          {cap(e)}
                        </Text>
                      </PressScale>
                    ))}
                  </View>
                </View>
              );
            })()}
            <ScrollView style={{ maxHeight: 340 }}>
              {(() => {
                // Group the catalog by provider, preserving list order — a
                // flat 200-row dump is unusable.
                const groups: { provider: string; items: any[] }[] = [];
                for (const m of c.models) {
                  const p = m.provider || m.providerId || "Other";
                  const g = groups[groups.length - 1];
                  if (g && g.provider === p) g.items.push(m);
                  else groups.push({ provider: p, items: [m] });
                }
                return groups.map((g) => (
                  <View key={g.provider}>
                    <Text style={[FONT.tiny, styles.groupLabel]} numberOfLines={1}>
                      {g.provider}
                    </Text>
                    {g.items.map((m, i) => {
                      const label = m.name || m.modelId || m.id || `model ${i + 1}`;
                      const sel =
                        label === c.model || m.modelId === c.model || m.id === c.model;
                      return (
                        <PressScale
                          key={`${g.provider}:${m.id || i}`}
                          onPress={() => c.pickModel(m)}
                          style={({ pressed }) => [
                            styles.modelRow,
                            sel && { backgroundColor: T.controlBg },
                            pressed && { opacity: 0.7 },
                          ]}
                        >
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text
                              style={[FONT.body, { color: T.ink, fontSize: 15.5 }]}
                              numberOfLines={1}
                            >
                              {label}
                            </Text>
                          </View>
                          {sel ? (
                            <Icon
                              name="checkmark"
                              android="check"
                              color={T.ink}
                              size={16}
                            />
                          ) : null}
                        </PressScale>
                      );
                    })}
                  </View>
                ));
              })()}
              {!c.models.length ? (
                <Text
                  style={[FONT.small, { color: T.faint, paddingVertical: 18, textAlign: "center" }]}
                >
                  {c.active ? "Fetching models…" : "Start a session first"}
                </Text>
              ) : null}
            </ScrollView>
            <PressScale
              style={styles.connRow}
              onPress={() => {
                c.setModelSheet(false);
                setAuthSheet(true);
              }}
            >
              <Icon name="key" android="vpn_key" color={T.sub} size={15} />
              <Text style={[FONT.small, { color: T.ink, ...fw("600"), flex: 1 }]}>
                Providers
              </Text>
              <Text style={[FONT.tiny, { color: T.faint }]}>
                {authProviders.filter((p: any) => p.authed).length || "none"} connected
              </Text>
            </PressScale>
          </PressScale>
        </PressScale>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  earlierTag: {
    color: T.faint,
    textAlign: "center",
    paddingVertical: 10,
  },
  connRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingTop: 12,
    paddingHorizontal: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
  },
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
    // The header pill hugs its content and sits centered between the two
    // circle buttons — the Grok thread header. Title + live dot, repo or
    // status line under it, mascot on the left.
    maxWidth: "100%",
    backgroundColor: "#FFFFFF",
    borderRadius: T.rPill,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 46,
    ...T.shadowTight,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  emptyWrap: { alignItems: "center", justifyContent: "center", paddingTop: 56, flex: 1 },
  // Grok hero anatomy — the mascot sits inside a soft rounded-square tile
  // with its name under it, not a bare blob on the canvas.
  emptyTile: {
    // Ref hero: mascot ~62% of a soft rounded square, name below the tile.
    width: 104,
    height: 104,
    borderRadius: 26,
    backgroundColor: "#EFEDE9",
    alignItems: "center",
    justifyContent: "center",
  },
  composerWrap: { paddingTop: 4 },
  effortBox: {
    backgroundColor: T.surfaceSoft,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: T.hairline,
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginBottom: 8,
    gap: 9,
  },
  effortRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  effortPill: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: T.controlBg,
  },
  effortPillOn: { backgroundColor: T.ink },
  parentLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "center",
    paddingBottom: 6,
    paddingTop: 2,
  },
  // Sub-agents — T3 quiet-timeline anatomy: a section head on the canvas
  // (no card chrome), children as inbox-anatomy rows split by hairlines.
  // The "+" head button is the only manual spawn affordance (opens a sheet).
  subsBox: {
    marginBottom: 4,
  },
  subsHead: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
  },
  subsHeadTap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 3,
  },
  subsLabel: { color: T.faint, letterSpacing: 0.8, ...fw("600") },
  subsBusyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: T.ok,
    marginRight: 4,
  },
  subsAddBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: T.controlBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.hairline,
  },
  toolsRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    paddingBottom: 6,
    paddingTop: 2,
  },
  toolPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "rgba(0,0,0,0.045)",
  },
  branchTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingRight: 2,
    maxWidth: 130,
  },
  mergePillRow: {
    flexDirection: "row",
    justifyContent: "center",
    paddingBottom: 8,
  },
  mergePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#26262B",
    borderRadius: 18,
    paddingHorizontal: 14,
    height: 36,
    ...T.shadowTight,
  },
  mergePillDone: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: T.okBg,
    borderRadius: 18,
    paddingHorizontal: 14,
    height: 36,
  },
  sheetBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.28)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 30,
  },
  grabber: {
    alignSelf: "center",
    width: 38,
    height: 4.5,
    borderRadius: 3,
    backgroundColor: T.hairlineStrong,
    marginBottom: 14,
  },
  sheetLabel: { color: T.faint, letterSpacing: 0.8, paddingBottom: 8 },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 14,
  },
  groupLabel: {
    color: T.faint,
    letterSpacing: 0.8,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
    textTransform: "uppercase",
  },
});
