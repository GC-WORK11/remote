import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Image, StyleSheet, ScrollView } from "react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn } from "react-native-reanimated";
import { Screen } from "../components/glass";
import { Header } from "../components/header";
import { Icon } from "../components/icon";
import { T, FONT, fw } from "../theme";
import { rig, Frame } from "../rig";
import { useRig } from "../state";
import { PressScale } from "../components/pressable";

interface Rec {
  id: string;
  startedAt: number;
  durationMs: number;
  frames: number;
  dropped?: number;
  fps: number;
  bytes: number;
  width?: number;
  height?: number;
  live?: boolean;
  mp4?: boolean;
}

interface RecFrame {
  seq: number;
  t: number;
  b64: string;
}

function fmtClock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDay(t: number) {
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay
    ? hm
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
}

export default function Recordings() {
  const { connected } = useRig();
  const [recs, setRecs] = useState<Rec[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // playback state — buf is the working copy for callbacks, framesList the
  // render-visible mirror (refs may not be read during render)
  const buf = useRef<RecFrame[]>([]);
  const [framesList, setFramesList] = useState<RecFrame[]>([]);
  const [total, setTotal] = useState(0);
  const [dur, setDur] = useState(0);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const nextFrom = useRef(1);
  const fetching = useRef(false);
  const trackW = useRef(0);
  const posRef = useRef(0);

  const refresh = useCallback(() => {
    rig.trySend({ type: "computer.record.list" });
  }, []);

  useEffect(() => {
    if (!connected) return;
    refresh();
    const off = rig.onFrame((f: Frame) => {
      if (f.type === "computer.recordings") setRecs(f.recordings || []);
      if (
        f.type === "computer.recorded" ||
        f.type === "computer.record.finished" ||
        (f.type === "ok" && f.for === "computer.record.delete")
      )
        refresh();
      if (f.type === "error") setErr(String(f.error || "error"));
    });
    const poll = setInterval(refresh, 5000); // live rows grow while recording
    return () => {
      off();
      clearInterval(poll);
    };
  }, [connected, refresh]);

  const fetchRange = useCallback(
    async (id: string, from: number, count = 40) => {
      if (fetching.current) return;
      fetching.current = true;
      try {
        const w = rig.waitFor("computer.record.frames", 20000);
        rig.send({ type: "computer.record.frames", id, from, count });
        const f = await w;
        const got: RecFrame[] = (f.frames || []).map((x: any) => ({
          seq: x.seq,
          t: x.t,
          b64: x.imageBase64,
        }));
        buf.current = [...buf.current, ...got].sort((a, b) => a.seq - b.seq);
        // keep a sliding window — drop frames >8 s behind the playhead so a
        // long recording can't grow the JS heap unbounded; the prefetch
        // horizon already bounds what's buffered ahead (~1.5 s)
        const floor = posRef.current - 8000;
        if (buf.current.length && buf.current[0].t < floor)
          buf.current = buf.current.filter((x) => x.t >= floor);
        setFramesList(buf.current);
        setTotal(f.total || 0);
        nextFrom.current = f.nextFrom || nextFrom.current;
      } catch {
        setErr("Couldn't load frames — connection dropped?");
      } finally {
        fetching.current = false;
      }
    },
    []
  );

  const openRec = useCallback(
    async (r: Rec) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setErr(null);
      setOpenId(r.id);
      setPlaying(false);
      posRef.current = 0;
      setPos(0);
      setDur(r.durationMs || 0);
      buf.current = [];
      setFramesList([]);
      nextFrom.current = 1;
      setTotal(r.frames || 0);
      await fetchRange(r.id, 1, 40);
      setPlaying(true);
    },
    [fetchRange]
  );

  const closePlayer = useCallback(() => {
    setOpenId(null);
    setPlaying(false);
    buf.current = [];
    setFramesList([]);
  }, []);

  const del = useCallback(
    (id: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (openId === id) closePlayer();
      rig.trySend({ type: "computer.record.delete", id });
    },
    [openId, closePlayer]
  );

  // transport — advance the playhead in wall time; frames map by capture offset
  useEffect(() => {
    if (!playing || !openId) return;
    let last = Date.now();
    const iv = setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      setPos((p) => {
        const np = p + dt;
        if (dur && np >= dur) {
          const live = recs.find((r) => r.id === openId)?.live;
          if (!live) {
            setPlaying(false);
            posRef.current = dur;
            return dur;
          }
        }
        posRef.current = np;
        return np;
      });
    }, 50);
    return () => clearInterval(iv);
  }, [playing, openId, dur, recs]);

  // prefetch: keep ~1.5 s of recording buffered ahead of the playhead
  useEffect(() => {
    if (!openId) return;
    const lastBuf = buf.current[buf.current.length - 1];
    if (
      (!lastBuf || pos > lastBuf.t - 1500) &&
      nextFrom.current <= total &&
      !fetching.current
    ) {
      fetchRange(openId, nextFrom.current, 40);
    }
  }, [pos, openId, total, fetchRange]);

  const frameAt = (posMs: number): RecFrame | null => {
    const a = framesList;
    if (!a.length) return null;
    let lo = 0;
    let hi = a.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].t <= posMs) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return a[ans];
  };
  const cur = frameAt(pos);

  const scrubTo = useCallback(
    (frac: number) => {
      if (!openId || !dur) return;
      const target = Math.max(0, Math.min(0.999, frac)) * dur;
      posRef.current = target;
      setPos(target);
      const near = buf.current.some((fr) => Math.abs(fr.t - target) < 600);
      if (!near) {
        const targetSeq = Math.max(1, Math.round(frac * total));
        buf.current = [];
        setFramesList([]);
        nextFrom.current = targetSeq;
        fetchRange(openId, targetSeq, 40);
      }
    },
    [openId, dur, total, fetchRange]
  );

  /* eslint-disable react-hooks/refs -- runOnJS(true) gesture callbacks are events, not render */
  const scrub = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onStart((e) => {
      if (trackW.current > 0) scrubTo(e.x / trackW.current);
    })
    .onUpdate((e) => {
      if (trackW.current > 0) scrubTo(e.x / trackW.current);
    });
  /* eslint-enable react-hooks/refs */

  const openMeta = recs.find((r) => r.id === openId);
  const progress = dur > 0 ? Math.min(1, pos / dur) : 0;

  return (
    <Screen pad={14}>
      <Header
        title="Recordings"
        subtitle={`${recs.length} on the rig`}
        right={
          <PressScale
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.back();
            }}
            style={styles.backBtn}
            hitSlop={8}
          >
            <Icon name="chevron.left" android="arrow_back" color={T.ink} size={17} />
          </PressScale>
        }
      />

      {err ? (
        <View style={styles.errCard}>
          <Text style={[FONT.small, { color: T.bad }]} numberOfLines={2}>
            {err}
          </Text>
        </View>
      ) : null}

      {openId ? (
        <Animated.View entering={FadeIn.duration(220)} style={styles.playerCard}>
          <View style={styles.frameBox}>
            {cur ? (
              <Image
                source={{ uri: `data:image/jpeg;base64,${cur.b64}` }}
                style={StyleSheet.absoluteFill}
                resizeMode="contain"
              />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.frameWait]}>
                <Text style={[FONT.small, { color: "rgba(255,255,255,0.6)" }]}>
                  Loading frames…
                </Text>
              </View>
            )}
            {openMeta?.live ? (
              <View style={styles.liveTag}>
                <View style={styles.liveDot} />
                <Text style={[FONT.pill, { color: "#fff" }]}>Recording</Text>
              </View>
            ) : null}
          </View>

          <View style={styles.transport}>
            <PressScale
              onPress={() => {
                Haptics.selectionAsync();
                if (!playing && dur && pos >= dur) {
                  posRef.current = 0;
                  setPos(0);
                }
                setPlaying(!playing);
              }}
              style={styles.playBtn}
              hitSlop={6}
            >
              <Icon
                name={playing ? "pause.fill" : "play.fill"}
                android={playing ? "pause" : "play_arrow"}
                color="#fff"
                size={15}
              />
            </PressScale>
            <GestureDetector gesture={scrub}>
              <View
                style={styles.track}
                onLayout={(e) => {
                  trackW.current = e.nativeEvent.layout.width;
                }}
              >
                <View style={styles.trackFill}>
                  <View
                    style={[styles.trackProg, { width: `${progress * 100}%` }]}
                  />
                </View>
                <View
                  style={[styles.knob, { left: `${progress * 100}%`, marginLeft: -6 }]}
                />
              </View>
            </GestureDetector>
            <Text style={[FONT.tiny, styles.timeText]}>
              {fmtClock(pos)} / {fmtClock(dur)}
            </Text>
          </View>

          <View style={styles.metaRow}>
            <Text style={[FONT.tiny, { color: T.sub, flex: 1 }]} numberOfLines={1}>
              {openMeta
                ? `${fmtDay(openMeta.startedAt)} · ${openMeta.frames} frames · ${openMeta.fps?.toFixed(1)} fps · ${fmtSize(openMeta.bytes)}${framesList.length < total ? ` · buffered ${framesList.length}/${total}` : ""}`
                : ""}
            </Text>
            <PressScale
              onPress={() => router.navigate("/screen")}
              style={styles.goLive}
              hitSlop={8}
            >
              <Icon name="display" android="desktop_windows" color={T.sub} size={15} />
            </PressScale>
            <PressScale onPress={() => del(openId)} hitSlop={8}>
              <Icon name="trash" android="delete" color={T.bad} size={15} />
            </PressScale>
          </View>
        </Animated.View>
      ) : null}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {recs.map((r) => (
          <PressScale
            key={r.id}
            onPress={() => openRec(r)}
            style={({ pressed }) => [
              styles.recRow,
              pressed && { backgroundColor: T.controlBg },
              openId === r.id && { borderColor: T.hairlineStrong },
            ]}
          >
            <View style={styles.recIcon}>
              <Icon
                name={r.live ? "record.circle" : "film"}
                android={r.live ? "fiber_manual_record" : "movie"}
                color={r.live ? T.bad : T.sub}
                size={18}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[FONT.small, { color: T.ink, ...fw("600") }]}>
                {fmtClock(r.durationMs)} · {fmtSize(r.bytes)}
              </Text>
              <Text style={[FONT.tiny, { color: T.sub, marginTop: 1 }]}>
                {fmtDay(r.startedAt)} · {r.frames} frames · {r.fps?.toFixed(1)} fps
                {r.width ? ` · ${r.width}×${r.height}` : ""}
              </Text>
            </View>
            {r.live ? (
              <View style={styles.recLivePill}>
                <View style={styles.liveDot} />
                <Text style={[FONT.pill, { color: T.bad }]}>REC</Text>
              </View>
            ) : (
              <Icon name="play.circle" android="play_circle" color={T.faint} size={22} />
            )}
          </PressScale>
        ))}
        {!recs.length ? (
          <View style={styles.empty}>
            <Icon name="film" android="movie" color={T.faint} size={30} />
            <Text style={[FONT.small, { color: T.sub, marginTop: 10, textAlign: "center" }]}>
              No recordings yet.{"\n"}Hit the record button on the Screen tab.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.surfaceStrong,
    borderWidth: StyleSheet.hairlineWidth * 1.5,
    borderColor: T.hairline,
  },
  errCard: {
    backgroundColor: "rgba(224,62,62,0.08)",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
  },
  playerCard: {
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "#141417",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    marginBottom: 12,
    ...T.shadow,
  },
  frameBox: { aspectRatio: 16 / 10, backgroundColor: "#0B0B0E" },
  frameWait: { alignItems: "center", justifyContent: "center" },
  liveTag: {
    position: "absolute",
    top: 10,
    left: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: T.rPill,
    backgroundColor: "rgba(224,62,62,0.85)",
  },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#fff" },
  transport: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
  },
  playBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.accent,
  },
  track: { flex: 1, height: 26, justifyContent: "center" },
  trackFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.18)",
    overflow: "hidden",
  },
  trackProg: { height: 4, backgroundColor: "#fff" },
  knob: {
    position: "absolute",
    top: 7,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#fff",
  },
  timeText: { color: "rgba(255,255,255,0.7)", minWidth: 74, textAlign: "right" },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 12,
  },
  metaRowText: {},
  goLive: {},
  recRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 16,
    backgroundColor: T.cardBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    marginBottom: 8,
  },
  recIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.controlBg,
  },
  recLivePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: T.rPill,
    backgroundColor: "rgba(224,62,62,0.10)",
  },
  empty: { alignItems: "center", paddingTop: 60 },
});
