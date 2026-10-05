// Cursor-style coding cards: agent runs, PR summary, diff chips, deploys.
// Rendered only from real rpc frames / session state — nothing invented.
import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Linking, Image, Platform, Modal, ActivityIndicator } from "react-native";
import Animated, {
  FadeInDown,
  Easing,
  useSharedValue,
  useAnimatedStyle,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
  runOnJS,
  type SharedValue,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { T, FONT, fw } from "../theme";
import { Icon } from "./icon";
import { rig } from "../rig";
import { openBrowserSheet, openMergeSheet, useMergePhase } from "./sheetbus";
import { ShimmerText } from "./bubbles";
import { PressScale } from "./pressable";
import { pullFileToPhone } from "../deliver";

// "View PR +12 −3" chip — opens the real URL in the browser sheet.
export function PRChip({ url }: { url: string }) {
  return (
    <PressScale
      onPress={() => openBrowserSheet(url)}
      style={({ pressed }) => [styles.prChip, pressed && { opacity: 0.75 }]}
    >
      <Icon name="arrow.triangle.branch" android="account_tree" color={T.sub} size={12} />
      <Text style={[FONT.small, { color: T.ink, ...fw("600"), fontSize: 13 }]}>
        View PR
      </Text>
      <Icon name="arrow.up.right" android="north_east" color={T.faint} size={11} />
    </PressScale>
  );
}

// Checks ring — the small circular progress glyph on the Cursor PR status
// row: spins while any check waits, green ✓ when all pass, red ✕ on a fail.
function ChecksRing({ done, failed }: { done?: boolean; failed?: boolean }) {
  const rot = useSharedValue(0);
  useEffect(() => {
    rot.value = done || failed ? 0 : withRepeat(withTiming(360, { duration: 900, easing: Easing.linear }), -1);
  }, [done, failed]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }] }));
  if (done || failed) {
    return (
      <View style={[styles.prRing, { borderColor: done ? T.prGreen : T.prRed }]}>
        <Icon
          name={done ? "checkmark" : "xmark"}
          android={done ? "check" : "close"}
          color={done ? T.prGreen : T.prRed}
          size={10}
          weight="bold"
        />
      </View>
    );
  }
  return (
    <Animated.View style={[styles.prRing, { borderColor: T.hairlineStrong, borderTopColor: T.sub }, s]} />
  );
}

// File thumbnail tile — the "Demos" grid cells: a small doc tile with the
// file glyph and the basename as its caption. Honest: paths only.
function FileThumb({ path }: { path: string }) {
  const name = path.split("/").pop() || path;
  return (
    <View style={{ width: 76 }}>
      <View style={styles.fileTile}>
        <Icon name="doc.text" android="description" color={T.sub} size={18} />
      </View>
      <Text numberOfLines={1} style={[FONT.tiny, styles.fileTileName]}>
        {name}
      </Text>
    </View>
  );
}

// PR card — the Cursor mobile anatomy: link icon + semibold title, a tag row
// (state pill + file count), a checks status row with the small ring, then a
// full-width action ("Squash & Merge" when mergeable, else "View PR") and a
// file-thumbnail grid when the wire carries touched paths. Every element is
// rendered only from real wire data; counts we don't have stay out.
export function PRCard({
  title,
  url,
  branch,
  author,
  checks,
  files,
  mergeable,
  onPress,
}: {
  title: string;
  url: string;
  branch?: string;
  author?: string;
  checks?: { label: string; state: "waiting" | "passed" | "failed" }[];
  files?: string[];
  /** "Squash & Merge" affordance — only when checks actually passed. */
  mergeable?: boolean;
  onPress?: () => void;
}) {
  const phase = useMergePhase(url);
  const list = files || [];
  const checksKnown = (checks || []).length > 0;
  const failed = checks?.some((c) => c.state === "failed") ?? false;
  const allPassed =
    checksKnown && !failed && (checks || []).every((c) => c.state === "passed");
  const passing = (checks || []).filter((c) => c.state === "passed").length;
  const canMerge = mergeable ?? allPassed;
  return (
    <PressScale onPress={onPress} disabled={!onPress}>
      <Animated.View
        entering={FadeInDown.duration(220).easing(Easing.out(Easing.ease))}
        style={styles.prCard}
      >
        <View style={{ padding: 14, gap: 9 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 9 }}>
            <Icon name="link" android="link" color={T.sub} size={15} />
            <Text
              style={[FONT.head, { color: T.ink, fontSize: 16, lineHeight: 21, flex: 1 }]}
            >
              {title}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <View style={styles.openChip}>
              <Text
                style={[
                  FONT.tiny,
                  { color: phase === "merged" ? T.sub : T.prGreen, ...fw("700") },
                ]}
              >
                {phase === "merged" ? "Merged" : "Open"}
              </Text>
            </View>
            {list.length ? (
              <Text style={[FONT.tiny, { color: T.sub }]}>
                {list.length} {list.length === 1 ? "File" : "Files"}
              </Text>
            ) : null}
            {branch ? (
              <Text numberOfLines={1} style={[FONT.mono, { color: T.sub, fontSize: 11, flexShrink: 1 }]}>
                {branch}
              </Text>
            ) : null}
          </View>
          <View style={styles.prStatusRow}>
            <ChecksRing done={allPassed} failed={failed} />
            <Text style={[FONT.small, { color: T.sub, flex: 1 }]} numberOfLines={1}>
              {failed
                ? `${checks!.filter((c) => c.state === "failed").length} Checks Failed`
                : allPassed
                  ? "All Checks Passed"
                  : checksKnown
                    ? `${passing} of ${checks!.length} Checks Passing`
                    : "Waiting for checks"}
            </Text>
          </View>
        </View>
        {list.length ? (
          <View style={styles.fileGrid}>
            {list.slice(0, 4).map((f) => (
              <FileThumb key={f} path={f} />
            ))}
            {list.length > 4 ? (
              <View style={{ width: 76 }}>
                <View style={[styles.fileTile, { justifyContent: "center" }]}>
                  <Text style={[FONT.small, { color: T.sub, ...fw("600") }]}>
                    +{list.length - 4}
                  </Text>
                </View>
                <Text style={[FONT.tiny, styles.fileTileName]}> </Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {phase !== "idle" || canMerge ? (
          <PressScale
            onPress={() => {
              if (phase === "idle" && canMerge) openMergeSheet({ url, title, branch, author });
              else onPress?.();
            }}
            style={({ pressed }) => [
              styles.prAction,
              phase === "merged" && styles.prActionMerged,
              pressed && { opacity: 0.85 },
            ]}
            accessibilityRole="button"
          >
            {phase === "merging" ? (
              <ShimmerText text="Merging" style={{ fontSize: 14.5, ...fw("700"), color: "#fff" }} />
            ) : (
              <Text
                style={[
                  FONT.head,
                  { color: phase === "merged" ? T.ok : "#FFFFFF", fontSize: 14.5 },
                ]}
              >
                {phase === "merged" ? "✓ Merged" : "Squash & Merge"}
              </Text>
            )}
          </PressScale>
        ) : (
          <PressScale
            onPress={() => Linking.openURL(url)}
            style={({ pressed }) => [styles.prAction, { backgroundColor: T.pillBg }, pressed && { opacity: 0.85 }]}
          >
            <Text style={[FONT.head, { color: T.ink, fontSize: 14.5 }]}>View PR ↗</Text>
          </PressScale>
        )}
      </Animated.View>
    </PressScale>
  );
}

// Code-block card — dark inset card (Cursor terminal texture), mono text.
export function CodeCard({ code, lang }: { code: string; lang?: string }) {
  return (
    <View style={styles.codeCard}>
      {lang ? <Text style={styles.codeLang}>{lang}</Text> : null}
      <Text style={styles.codeText} selectable>
        {code}
      </Text>
    </View>
  );
}

// Content-shaped placeholder bars — staggered pulse, pure shimmer.
function SkelBar({ width, delay }: { width: `${number}%`; delay: number }) {
  const p = useSharedValue(0.4);
  useEffect(() => {
    p.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 720, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.4, { duration: 720, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const s = useAnimatedStyle(() => ({ opacity: p.value }));
  return <Animated.View style={[styles.skelBar, { width }, s]} />;
}


export function findPrUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s"'`]+\/(?:pull|merge_requests|\/-\/merge_requests)\/\d+[^\s"'`]*/i);
  return m ? m[0].replace(/[.,;:!?'"*_~[\]]+$/, "") : null;
}

// Non-PR links in agent prose → doc cards (the Notion/link card in the
// cowork refs). Max two — more is noise.
export function findLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'`)>]+/g)) {
    const u = m[0].replace(/[.,;:!?'"*_~[\]]+$/, "");
    if (seen.has(u) || /\/(pull|merge_requests)\/\d+/i.test(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= 2) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// TermCard — a real command's real output. Dark inset card (terminal
// texture): `$ command` head, mono output capped at ~7 lines with an
// expander, wall-time pill; red edge when the exit status failed.
// ---------------------------------------------------------------------------

// "What the agent saw" — the archived rig screenshot behind an observe
// result, streamed back from the daemon on demand (computer.shot_file).
// Tap opens the live bottom-sheet mirror.
export function ObserveCard({
  name,
  caption,
  preview,
  onPress,
}: {
  name: string;
  caption?: string;
  /** Fixture/deep-link path: a ready image URI — skips the daemon fetch. */
  preview?: string;
  onPress?: () => void;
}) {
  const [uri, setUri] = useState<string | null>(preview || null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (preview) return;
    let live = true;
    rig
      .fetchShot(name)
      .then((f) => {
        if (!live) return;
        const b64 = f?.imageBase64;
        if (typeof b64 === "string")
          setUri(`data:image/${f?.format === "png" ? "png" : "jpeg"};base64,${b64}`);
        else setFailed(true);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [name, preview]);
  return (
    <PressScale
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.shotCard, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.shotFrame}>
        {uri ? (
          <Image source={{ uri }} style={styles.shotImg} resizeMode="cover" />
        ) : (
          <View style={[styles.shotImg, styles.shotPh]}>
            <Text style={[FONT.tiny, { color: T.faint }]}>
              {failed ? "Frame no longer archived" : "Fetching frame…"}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.shotCap}>
        <Icon name="display" android="desktop_windows" color={T.faint} size={11} />
        <Text numberOfLines={1} style={[FONT.tiny, { color: T.sub, flex: 1 }]}>
          {caption || "Observed"}
        </Text>
        {onPress ? (
          <Icon name="arrow.up.left.and.arrow.down.right" android="open_in_full" color={T.faint} size={11} />
        ) : null}
      </View>
    </PressScale>
  );
}

// Delivered file card — the agent's rig_deliver tool lands in the thread as
// this card (name + real size + optional caption). Tap pulls the bytes off
// the rig via rig.fs.read into phone storage and opens the share sheet;
// fetch state lives inside the card so the row tells the truth about
// progress without the thread wiring a handler.
export function DeliverCard({
  path,
  name,
  size,
  caption,
}: {
  path: string;
  name: string;
  size?: number | null;
  caption?: string;
}) {
  const [state, setState] = useState<"ready" | "fetching" | "done" | "error">("ready");
  const [errMsg, setErrMsg] = useState("");
  const grab = async () => {
    if (state === "fetching") return;
    setState("fetching");
    try {
      await pullFileToPhone(path, name);
      setState("done");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      setErrMsg(e instanceof Error && e.message ? e.message : "Couldn't fetch");
      setState("error");
    }
  };
  const ext = (name.split(".").pop() || "").toLowerCase();
  const fmtSize = (n?: number | null) =>
    typeof n === "number" && n > 0
      ? n >= 1 << 20
        ? `${(n / (1 << 20)).toFixed(1)} MB`
        : n >= 1024
          ? `${Math.round(n / 1024)} KB`
          : `${n} B`
      : "";
  const sub =
    state === "fetching"
      ? "Fetching from your rig…"
      : state === "done"
        ? "On your phone"
        : state === "error"
          ? `${errMsg} — tap to retry`
          : [fmtSize(size), caption || "From your rig"].filter(Boolean).join(" · ");
  return (
    <PressScale
      onPress={grab}
      disabled={state === "fetching"}
      style={({ pressed }) => [styles.deliverCard, pressed && { opacity: 0.75 }]}
    >
      <View style={[styles.deliverTile, state === "error" && { backgroundColor: "#EB4D4B" }]}>
        {state === "fetching" ? (
          <ActivityIndicator color="#FFFFFF" size="small" />
        ) : (
          <Text style={{ color: "#fff", fontSize: 10, ...fw("800") }}>
            {ext.slice(0, 4).toUpperCase() || "FILE"}
          </Text>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[FONT.small, { color: T.ink, ...fw("600") }]}>
          {name}
        </Text>
        <Text numberOfLines={1} style={[FONT.tiny, { color: T.faint }]}>
          {sub}
        </Text>
      </View>
      <Icon
        name="arrow.down.to.line"
        android={state === "done" ? "check" : "file_download"}
        color={state === "done" ? T.ok : T.faint}
        size={13}
      />
    </PressScale>
  );
}

// Doc card — icon tile + link name + host (ref 7: yellow doc tile +
// "Q3 board deck v4" + "docs.google.com"). Known doc hosts get a real doc
// glyph on a brand-ish tile; everything else keeps the host-initial box.
// Tap opens the browser bottom-sheet (never auto-opens; never leaves the
// app). `reacted` drops the ref-7 👍 circle under the card's left corner.
export function LinkCard({ url, reacted }: { url: string; reacted?: boolean }) {
  let host = url;
  let name = url;
  try {
    const u = new URL(url);
    host = u.host.replace(/^www\./, "");
    const leaf = u.pathname.split("/").filter(Boolean).pop() || u.host;
    name = decodeURIComponent(leaf).replace(/[-_+]+/g, " ").trim() || host;
    if (name.length > 42) name = name.slice(0, 42).trimEnd() + "…";
  } catch {
    /* leave defaults */
  }
  const isDocHost = /(^|\.)(docs\.google\.com|notion\.so|notion\.site|dropbox\.com|drive\.google\.com)$/.test(
    host
  );
  return (
    <View style={{ alignSelf: "stretch" }}>
      <PressScale
        onPress={() => openBrowserSheet(url)}
        style={({ pressed }) => [styles.linkCard, pressed && { opacity: 0.75 }]}
      >
        <View style={[styles.linkIcon, isDocHost && styles.linkIconDoc]}>
          {isDocHost ? (
            <Icon name="doc.text" android="description" color="#FFFFFF" size={15} />
          ) : (
            <Text style={[FONT.head, { color: T.ink, fontSize: 14 }]}>
              {host[0] ? host[0].toUpperCase() : "↗"}
            </Text>
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[FONT.small, { color: T.ink, ...fw("600") }]}>
            {name}
          </Text>
          <Text numberOfLines={1} style={[FONT.tiny, { color: T.faint }]}>
            {host}
          </Text>
        </View>
        <Icon name="arrow.up.right" android="north_east" color={T.faint} size={12} />
      </PressScale>
      {reacted ? (
        <View style={styles.linkReact} pointerEvents="none">
          <Text style={{ fontSize: 12 }}>👍</Text>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// ApprovalCard — the Grok email/DOC card (ref 6): a light-gray card carrying
// a semibold title + a WHITE inner draft + [black primary][gray secondary]
// side-by-side. Resolving collapses the buttons into a quiet "Done" pill —
// like the settled beat under ref 6's sent email.
// ---------------------------------------------------------------------------

// Destructive/irreversible asks get the ref-4 dark bottom sheet instead of
// (well, in addition to) the inline card — orders, payments, deletes,
// force-pushes, publishes.
export function isBigApproval(title?: string, preview?: string): boolean {
  const s = `${title || ""} ${preview || ""}`.toLowerCase();
  return /(order|purchase|checkout|buy\b|pay\b|charge|payment|delete|remove|erase|destroy|drop\b|format|wipe|overwrite|force.?push|reset|deploy|publish|release|merge|transfer|send money)/.test(
    s
  );
}

export function ApprovalCard({
  title,
  preview,
  primary = "Approve",
  secondary,
  doneLabel = "Approved",
  state,
  resolved: resolvedProp,
  onDecide,
}: {
  title: string;
  preview?: string;
  primary?: string;
  secondary?: string;
  doneLabel?: string;
  state?: "pending" | "done";
  resolved?: "primary" | "secondary";
  onDecide?: (choice: "primary" | "secondary") => void;
}) {
  const [resolvedLocal, setResolvedLocal] = useState<"primary" | "secondary" | null>(
    resolvedProp ?? (state === "done" ? "primary" : null)
  );
  const resolved = resolvedProp ?? resolvedLocal;
  const decide = (choice: "primary" | "secondary") => {
    if (resolved) return;
    setResolvedLocal(choice);
    onDecide?.(choice);
  };
  return (
    <View style={styles.approvalCard}>
      <Text style={[FONT.head, { color: T.ink, fontSize: 15 }]}>{title}</Text>
      {preview ? (
        <View style={styles.approvalInner}>
          <Text
            style={[FONT.body, { fontSize: 14, color: T.inkSoft, lineHeight: 20 }]}
            numberOfLines={6}
          >
            {preview}
          </Text>
        </View>
      ) : null}
      {resolved ? (
        // Ref 6: the settled approval is a quiet gray pill — a mini agent
        // bubble, not a status line.
        <View style={styles.approvalDone}>
          <Icon
            name={resolved === "primary" ? "checkmark" : "xmark"}
            android={resolved === "primary" ? "check" : "close"}
            color={resolved === "primary" ? T.ok : T.sub}
            size={11}
          />
          <Text style={[FONT.small, { color: T.ink, ...fw("700") }]}>
            {resolved === "primary" ? doneLabel : "Dismissed"}
          </Text>
        </View>
      ) : (
        <View style={styles.approvalBtns}>
          <PressScale
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              decide("primary");
            }}
            style={({ pressed }) => [
              styles.approvalPrimary,
              pressed && { opacity: 0.85, transform: [{ scale: 0.985 }] },
            ]}
            accessibilityRole="button"
            accessibilityLabel={primary}
          >
            <Text style={[FONT.head, { color: "#fff", fontSize: 14.5 }]}>{primary}</Text>
          </PressScale>
          {secondary ? (
            <PressScale
              onPress={() => {
                Haptics.selectionAsync();
                decide("secondary");
              }}
              style={({ pressed }) => [styles.approvalSecondary, pressed && { opacity: 0.7 }]}
              accessibilityRole="button"
              accessibilityLabel={secondary}
            >
              <Text style={[FONT.head, { color: T.ink, fontSize: 14.5 }]}>{secondary}</Text>
            </PressScale>
          ) : null}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// ApprovalSheet — the Muse dark bottom-sheet (ref 4) for big/destructive
// asks (isBigApproval): action icon + "{Buddy} wants to …" title, a verify
// copy line, the white preview card with a "Review on screen ↗" chip, a
// dark context row (persona · where it runs), and Deny (gray pill) / Allow
// (blue pill). The inline ApprovalCard stays in the thread as the record;
// this sheet is the decision surface.
// ---------------------------------------------------------------------------

export function ApprovalSheet({
  visible,
  title,
  preview,
  primary = "Allow",
  secondary = "Deny",
  actor,
  ctx,
  onDecide,
  onReview,
  onDismiss,
}: {
  visible: boolean;
  title: string;
  preview?: string;
  primary?: string;
  secondary?: string;
  /** Persona name — "Pip wants to …". */
  actor: string;
  /** Where the action lands — host/cwd tail. */
  ctx?: string;
  onDecide: (choice: "primary" | "secondary") => void;
  /** "Review on screen ↗" — opens the live screen sheet. */
  onReview?: () => void;
  onDismiss: () => void;
}) {
  const commerce = /(order|purchase|checkout|buy\b|pay\b|charge|payment|cart)/i.test(
    `${title} ${preview || ""}`
  );
  const ask = title.replace(/[?\s]+$/, "");
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onDismiss}
    >
      <PressScale style={styles.sheetDim} onPress={onDismiss}>
        <PressScale style={styles.darkSheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.darkGrabber} />
          <View style={styles.darkHead}>
            <Icon
              name={commerce ? "cart" : "exclamationmark.shield"}
              android={commerce ? "shopping_cart" : "verified_user"}
              color="#EDEDF0"
              size={22}
            />
            <Text style={[FONT.head, { color: "#F4F4F6", fontSize: 17, flex: 1, lineHeight: 22 }]}>
              {actor} wants to {ask}
            </Text>
          </View>
          <Text style={[FONT.small, { color: "rgba(235,235,240,0.62)", fontSize: 13.5, lineHeight: 19 }]}>
            Verify the details on your computer before approving.
          </Text>
          {preview ? (
            <View style={styles.darkPreview}>
              <Text
                style={[FONT.body, { color: T.inkSoft, fontSize: 14, lineHeight: 20 }]}
                numberOfLines={7}
              >
                {preview}
              </Text>
              {onReview ? (
                <PressScale
                  onPress={() => {
                    Haptics.selectionAsync();
                    onReview();
                  }}
                  style={({ pressed }) => [styles.darkReview, pressed && { opacity: 0.8 }]}
                  accessibilityRole="button"
                  accessibilityLabel="Review on screen"
                >
                  <Icon name="display" android="desktop_windows" color="#EDEDF0" size={12} />
                  <Text style={[FONT.small, { color: "#F4F4F6", ...fw("600"), fontSize: 12.5 }]}>
                    Review on screen ↗
                  </Text>
                </PressScale>
              ) : null}
            </View>
          ) : null}
          <View style={styles.darkRow}>
            <View style={styles.darkRowDot} />
            <Text numberOfLines={1} style={[FONT.small, { color: "#EDEDF0", ...fw("600"), flex: 1 }]}>
              {actor}{ctx ? ` · ${ctx}` : ""}
            </Text>
            {onReview ? (
              <PressScale onPress={onReview} hitSlop={8} accessibilityRole="button" accessibilityLabel="Open screen">
                <Icon name="chevron.right" android="chevron_right" color="rgba(235,235,240,0.5)" size={14} />
              </PressScale>
            ) : null}
          </View>
          <View style={styles.darkBtns}>
            <PressScale
              onPress={() => {
                Haptics.selectionAsync();
                onDecide("secondary");
              }}
              style={({ pressed }) => [styles.darkDeny, pressed && { opacity: 0.8 }]}
              accessibilityRole="button"
              accessibilityLabel={secondary}
            >
              <Text style={[FONT.head, { color: "#F4F4F6", fontSize: 15 }]}>{secondary}</Text>
            </PressScale>
            <PressScale
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                onDecide("primary");
              }}
              style={({ pressed }) => [styles.darkAllow, pressed && { opacity: 0.85 }]}
              accessibilityRole="button"
              accessibilityLabel={primary}
            >
              <Text style={[FONT.head, { color: "#fff", fontSize: 15 }]}>{primary}</Text>
            </PressScale>
          </View>
        </PressScale>
      </PressScale>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// VoiceCard — Grok's voice-note card: black play/pause circle, gray capsule
// wave bars that fill coral as it "plays", duration on the right. Render-
// only — there is no audio pipeline; the fill animation is the affordance.
// ---------------------------------------------------------------------------

// SharedValue writes live at module scope — React Compiler's immutability
// rule reads in-component `.value =` as state mutation.
function playProgress(p: SharedValue<number>, sec: number, done: () => void) {
  cancelAnimation(p);
  p.value = 0;
  p.value = withTiming(
    1,
    { duration: Math.max(500, sec * 1000), easing: Easing.linear },
    (fin) => {
      if (fin) runOnJS(done)();
    }
  );
}
function stopProgress(p: SharedValue<number>) {
  cancelAnimation(p);
  p.value = withTiming(0, { duration: 260 });
}
function fmtDur(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function VoiceCard({ durationSec }: { durationSec: number }) {
  const [playing, setPlaying] = useState(false);
  const p = useSharedValue(0);
  // Deterministic wave — organic amplitude pattern, same every render.
  const bars = React.useMemo(() => {
    const n = Math.min(30, Math.max(18, Math.round(durationSec * 0.8)));
    return Array.from(
      { length: n },
      (_, i) => 5 + Math.abs(Math.sin(i * 1.35) * 0.7 + Math.sin(i * 0.55 + 1.2) * 0.5) * 20
    );
  }, [durationSec]);
  const clip = useAnimatedStyle(() => ({ width: `${p.value * 100}%` }));
  const toggle = () => {
    Haptics.selectionAsync();
    if (playing) {
      stopProgress(p);
      setPlaying(false);
    } else {
      playProgress(p, durationSec, () => setPlaying(false));
      setPlaying(true);
    }
  };
  return (
    <View style={styles.voiceCard}>
      <PressScale
        onPress={toggle}
        hitSlop={6}
        style={({ pressed }) => [styles.voiceBtn, pressed && { opacity: 0.8 }]}
        accessibilityRole="button"
        accessibilityLabel={playing ? "Pause voice note" : "Play voice note"}
      >
        <Icon
          name={playing ? "pause.fill" : "play.fill"}
          android={playing ? "pause" : "play_arrow"}
          color="#fff"
          size={15}
        />
      </PressScale>
      <View style={styles.waveBox}>
        <View style={styles.waveRow}>
          {bars.map((h, i) => (
            <View key={i} style={[styles.waveBar, { height: h }]} />
          ))}
        </View>
        <Animated.View style={[styles.waveClip, clip]}>
          <View style={styles.waveRow}>
            {bars.map((h, i) => (
              <View key={i} style={[styles.waveBar, styles.waveBarHot, { height: h }]} />
            ))}
          </View>
        </Animated.View>
      </View>
      <Text style={[FONT.tiny, styles.voiceDur]}>{fmtDur(durationSec)}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// VideoCard — a screen-recording clip in the thread: dark thumbnail (or a
// real frame when a uri is attached), centered play circle, duration chip,
// caption. Render-only chrome — the clip pipeline isn't wired yet.
// ---------------------------------------------------------------------------

export function VideoCard({
  uri,
  durationSec = 0,
  caption,
  session,
}: {
  uri?: string;
  durationSec?: number;
  caption?: string;
  /** Workspace name for the "{Session} · Walkthrough" title line. */
  session?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const p = useSharedValue(0);
  const clip = useAnimatedStyle(() => ({ width: `${p.value * 100}%` }));
  const toggle = () => {
    Haptics.selectionAsync();
    if (playing) {
      stopProgress(p);
      setPlaying(false);
    } else {
      playProgress(p, durationSec || 4, () => setPlaying(false));
      setPlaying(true);
    }
  };
  return (
    <View style={styles.videoCard}>
      <View style={styles.jobHead}>
        <View style={styles.jobDot} />
        <Text numberOfLines={1} style={[FONT.head, { color: T.ink, fontSize: 15.5, flex: 1 }]}>
          {session ? `${session} · ` : ""}
          {caption || "Walkthrough"}
        </Text>
      </View>
      <PressScale
        onPress={toggle}
        style={({ pressed }) => [
          styles.videoThumb,
          !uri && styles.videoThumbLight,
          pressed && { opacity: 0.9 },
        ]}
      >
        {uri ? (
          <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <View style={{ flex: 1, alignSelf: "stretch", paddingHorizontal: 18, justifyContent: "center", gap: 7 }}>
            <SkelBar width="82%" delay={0} />
            <SkelBar width="58%" delay={180} />
            <SkelBar width="70%" delay={360} />
          </View>
        )}
        <View style={styles.videoPlay}>
          <Icon
            name={playing ? "pause.fill" : "play.fill"}
            android={playing ? "pause" : "play_arrow"}
            color="#fff"
            size={17}
          />
        </View>
        {durationSec ? (
          <View style={styles.videoDurChip}>
            <Text style={{ color: "#fff", fontSize: 10.5, ...fw("700") }}>
              {fmtDur(durationSec)}
            </Text>
          </View>
        ) : null}
        <View style={styles.videoProgTrack}>
          <Animated.View style={[styles.videoProgFill, clip]} />
        </View>
      </PressScale>
      <View style={styles.videoCap}>
        <Icon name="video.fill" android="videocam" color={T.faint} size={11} />
        <Text numberOfLines={1} style={[FONT.tiny, { color: T.sub, flex: 1 }]}>
          Walkthrough
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// BuildCard — the Mobai build beat: "Build started → building (watching in
// background)" live card, then "Build finished successfully · Time ~1m5s"
// with the artifact link. Tap the run link → browser sheet.
// ---------------------------------------------------------------------------

function IndetBar() {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const s = useAnimatedStyle(() => ({ left: `${-40 + p.value * 60}%` }));
  return (
    <View style={styles.buildTrack}>
      <Animated.View style={[styles.buildSeg, s]} />
    </View>
  );
}

export function BuildCard({
  status,
  id,
  url,
  artifact,
  size,
  durationSec,
}: {
  status: "building" | "success" | "failed";
  id?: string;
  url?: string;
  artifact?: string;
  size?: string;
  durationSec?: number;
}) {
  const live = status === "building";
  const bad = status === "failed";
  return (
    <View style={styles.buildCard}>
      <View style={styles.buildHead}>
        <View style={styles.buildIcon}>
          <Icon name="hammer.fill" android="build" color="#fff" size={13} />
        </View>
        <Text style={[FONT.head, { color: T.ink, fontSize: 15, flex: 1 }]} numberOfLines={1}>
          Build
        </Text>
        <View
          style={[
            styles.buildPill,
            bad
              ? { backgroundColor: "rgba(224,62,62,0.10)" }
              : live
                ? { backgroundColor: T.pillBg }
                : { backgroundColor: T.okBg },
          ]}
        >
          {live ? (
            <>
              <View style={[styles.buildPulse, { backgroundColor: T.working }]} />
              <Text style={[FONT.tiny, { color: T.working, ...fw("700") }]}>Building</Text>
            </>
          ) : (
            <>
              <Icon
                name={bad ? "xmark" : "checkmark"}
                android={bad ? "close" : "check"}
                color={bad ? T.bad : T.ok}
                size={10}
              />
              <Text style={[FONT.tiny, { color: bad ? T.bad : T.ok, ...fw("700") }]}>
                {bad ? "Failed" : "Finished"}
              </Text>
            </>
          )}
        </View>
      </View>
      <View style={{ gap: 4 }}>
        <Text style={[FONT.small, { color: live ? T.sub : T.ink }]}>
          {live
            ? "Status: building (watching in background)"
            : bad
              ? "Build failed."
              : "Build finished successfully."}
        </Text>
        {id ? (
          <Text numberOfLines={1} style={[FONT.mono, { color: T.faint, fontSize: 11 }]}>
            Build ID: {id}
          </Text>
        ) : null}
        {!live && !bad && artifact ? (
          <Text numberOfLines={1} style={[FONT.small, { color: T.inkSoft, ...fw("600") }]}>
            {artifact}
            {size ? ` (${size})` : ""}
          </Text>
        ) : null}
        {!live && !bad && durationSec != null ? (
          <Text style={[FONT.small, { color: T.sub }]}>Time: ~{fmtDur(durationSec)}</Text>
        ) : null}
        {url ? (
          <PressScale
            onPress={() => openBrowserSheet(url)}
            hitSlop={6}
            style={({ pressed }) => [styles.buildLink, pressed && { opacity: 0.7 }]}
          >
            <Icon name="link" android="link" color={T.faint} size={11} />
            <Text numberOfLines={1} style={[FONT.tiny, { color: T.sub, flexShrink: 1 }]}>
              Run: {(() => { try { return new URL(url).host; } catch { return url; } })()}
            </Text>
            <Icon name="arrow.up.right" android="north_east" color={T.faint} size={10} />
          </PressScale>
        ) : null}
      </View>
      {live ? <IndetBar /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  prChip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: T.pillBg,
    borderRadius: T.rPill,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  prCard: {
    backgroundColor: T.cardBgTint,
    borderRadius: T.rCard,
    overflow: "hidden",
    alignSelf: "stretch",
  },
  openChip: {
    backgroundColor: "rgba(31,168,92,0.13)",
    borderRadius: T.rPill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  prMerge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.hairline,
  },
  checkCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: T.ok,
    alignItems: "center",
    justifyContent: "center",
  },
  prBtn: {
    backgroundColor: "#FFFFFF",
    marginHorizontal: 12,
    marginBottom: 12,
    marginTop: 2,
    borderRadius: 14,
    paddingVertical: 11,
    alignItems: "center",
    ...T.shadowTight,
  },
  prRing: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  prStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  fileGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  fileTile: {
    width: 76,
    height: 56,
    borderRadius: 10,
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    alignItems: "center",
    justifyContent: "center",
  },
  fileTileName: {
    color: T.sub,
    marginTop: 4,
    textAlign: "center",
  },
  prAction: {
    backgroundColor: T.ink,
    marginHorizontal: 12,
    marginBottom: 12,
    marginTop: 2,
    borderRadius: 16,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  prActionMerged: {
    backgroundColor: T.okBg,
  },
  shotCard: {
    backgroundColor: T.cardBgTint,
    borderRadius: T.rCard,
    padding: 10,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    alignSelf: "flex-start",
    width: "100%",
    maxWidth: 300,
  },
  shotFrame: {
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
  },
  shotImg: { width: "100%", height: 148 },
  shotPh: { alignItems: "center", justifyContent: "center" },
  shotCap: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 2 },
  deliverCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: T.cardBgTint,
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
  },
  deliverTile: {
    width: 34,
    height: 34,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.ok,
  },
  linkCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: T.cardBgTint,
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
  },
  jobHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  jobDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.ok },
  skelBar: {
    height: 9,
    borderRadius: 5,
    backgroundColor: "rgba(0,0,0,0.08)",
  },
  linkIcon: {
    width: 34,
    height: 34,
    borderRadius: 9,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
  },
  linkIconDoc: {
    // Ref 7's yellow Google doc tile.
    backgroundColor: "#F2B705",
    borderColor: "rgba(0,0,0,0.08)",
  },
  linkReact: {
    // The ref-7 👍 circle hanging under the card's left corner.
    position: "absolute",
    left: -8,
    bottom: -10,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    alignItems: "center",
    justifyContent: "center",
    ...T.shadowTight,
  },
  codeCard: {
    backgroundColor: T.codeCard,
    borderRadius: 14,
    padding: 12,
    marginVertical: 4,
  },
  codeLang: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 10.5,
    ...fw("600"),
    letterSpacing: 0.8,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  codeText: {
    color: "#E8E8EC",
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 12.5,
    lineHeight: 18,
  },
  // ---- approval card (ref 6: light-gray card, white inner draft)
  approvalCard: {
    backgroundColor: T.cardBgTint,
    borderRadius: T.rCard,
    padding: 14,
    gap: 10,
    alignSelf: "stretch",
  },
  approvalInner: {
    backgroundColor: "#FFFFFF",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  approvalBtns: { flexDirection: "row", gap: 8, marginTop: 2 },
  approvalPrimary: {
    flex: 1,
    height: 42,
    borderRadius: 999,
    backgroundColor: T.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  approvalSecondary: {
    flex: 1,
    height: 42,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  approvalDone: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
    alignSelf: "flex-start",
    backgroundColor: "rgba(0,0,0,0.06)",
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  // ---- dark approval sheet (ref 4)
  sheetDim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  darkSheet: {
    backgroundColor: "#1C1C1E",
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 30,
    gap: 13,
  },
  darkGrabber: {
    alignSelf: "center",
    width: 38,
    height: 4.5,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.28)",
    marginBottom: 4,
  },
  darkHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 11,
    paddingTop: 2,
  },
  darkPreview: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  darkReview: {
    alignSelf: "flex-end",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#3A3A3C",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  darkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#2C2C2E",
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingVertical: 12,
  },
  darkRowDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#34A853",
  },
  darkBtns: { flexDirection: "row", gap: 10, marginTop: 2 },
  darkDeny: {
    flex: 1,
    height: 46,
    borderRadius: 999,
    backgroundColor: "#3A3A3C",
    alignItems: "center",
    justifyContent: "center",
  },
  darkAllow: {
    flex: 1,
    height: 46,
    borderRadius: 999,
    backgroundColor: "#2F6BFF",
    alignItems: "center",
    justifyContent: "center",
  },
  // ---- voice card
  voiceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: T.cardBgTint,
    borderRadius: T.rCard,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    maxWidth: 300,
    alignSelf: "flex-start",
  },
  voiceBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: T.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  waveBox: { flex: 1, height: 30, justifyContent: "center" },
  waveRow: { flexDirection: "row", alignItems: "center", gap: 2.5 },
  waveClip: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    overflow: "hidden",
    justifyContent: "center",
  },
  waveBar: { width: 3, borderRadius: 1.5, backgroundColor: "rgba(0,0,0,0.20)" },
  waveBarHot: { backgroundColor: T.accent },
  voiceDur: { color: T.sub, ...fw("600"), minWidth: 30, textAlign: "right" },
  // ---- video card
  videoCard: {
    backgroundColor: T.cardBgTint,
    borderRadius: T.rCard,
    padding: 8,
    gap: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    alignSelf: "flex-start",
    width: "100%",
    maxWidth: 300,
  },
  videoThumb: {
    height: 156,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#16161A",
    alignItems: "center",
    justifyContent: "center",
  },
  // No frame yet — the walkthrough preview is a light skeleton with a dark
  // play circle (Cursor's media card), not an empty black box.
  videoThumbLight: {
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
  },
  videoPlay: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#0B0B0E",
    alignItems: "center",
    justifyContent: "center",
  },
  videoDurChip: {
    position: "absolute",
    right: 8,
    bottom: 8,
    backgroundColor: "rgba(0,0,0,0.62)",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  videoProgTrack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  videoProgFill: { height: "100%", backgroundColor: T.accent },
  videoCap: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 3 },
  // ---- build card
  buildCard: {
    backgroundColor: T.cardBgTint,
    borderRadius: T.rCard,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    padding: 13,
    gap: 10,
    alignSelf: "stretch",
  },
  buildHead: { flexDirection: "row", alignItems: "center", gap: 9 },
  buildIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: T.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  buildPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  buildPulse: { width: 7, height: 7, borderRadius: 4 },
  buildLink: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 },
  buildTrack: {
    height: 3.5,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.08)",
    overflow: "hidden",
  },
  buildSeg: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "40%",
    borderRadius: 2,
    backgroundColor: T.ink,
  },
});
