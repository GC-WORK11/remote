import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Image,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useReducedMotion,
  withRepeat,
  withTiming,
  withSequence,
  withSpring,
  interpolate,
  interpolateColor,
  Easing,
} from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
// Same eager-native-module hazard as expo-notifications: dev clients built
// before the package landed lack ExpoSpeechRecognition, and the bare import
// would crash the tree. Resolve lazily; the hook falls back to a no-op so
// call order stays unconditional.
const _speech: typeof import("expo-speech-recognition") | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-speech-recognition");
  } catch {
    return null;
  }
})();
/* eslint-disable import/first */
const ExpoSpeechRecognitionModule = _speech?.ExpoSpeechRecognitionModule;
const useSpeechRecognitionEvent: typeof import("expo-speech-recognition").useSpeechRecognitionEvent =
  _speech?.useSpeechRecognitionEvent ?? ((() => {}) as never);
import { T, FONT, fw } from "../theme";
import { Icon } from "./icon";
import { useFadeInStyle } from "../motion";
import { PressScale } from "./pressable";

export interface Attachment {
  kind: "image" | "file";
  uri?: string; // image preview
  name: string;
  mimeType?: string;
  data?: string; // base64 for images
  text?: string; // text content for files
}

interface Props {
  value: string;
  onChange: (t: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  attachments: Attachment[];
  onRemoveAttachment: (i: number) => void;
  /** Cursor-style context pills under the composer, bottom-left (cwd, model). */
  chips?: ContextChip[];
  /** "/" autocomplete entries (code mode): typing "/" opens a small list
   * above the composer; picking one fills the field. */
  slashCommands?: SlashCommand[];
  placeholder?: string;
  disabled?: boolean;
  /** Grok layout: the input renders as a borderless gray pill. */
  split?: boolean;
}

export interface SlashCommand {
  /** Command name used for filtering after the "/". */
  name: string;
  /** Label shown in the dropdown ("/screenshot"). */
  label: string;
  /** Text inserted into the field on select. */
  insert: string;
  /** Local action — runs instead of inserting text (IDE-style surface hops). */
  run?: () => void;
}

export interface ContextChip {
  icon?: string;
  android?: string;
  label: string;
  onPress?: () => void;
}

// SharedValue writes must live outside component scope or React Compiler's
// immutability rule reads them as state mutation.
function driveFocus(focus: SharedValue<number>, on: boolean) {
  focus.value = withTiming(on ? 1 : 0, { duration: on ? 220 : 260 });
}

// Interaction-pulse glow — slow 2.8s breathe while the agent works; a soft
// accent ring that fades in on focus. Ambient, not flashy.
function Glow({ active, focus }: { active: boolean; focus: SharedValue<number> }) {
  const p = useSharedValue(0);
  useEffect(() => {
    if (active) {
      p.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 1400, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      );
    } else {
      p.value = withTiming(0, { duration: 250 });
    }
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useAnimatedStyle(() => ({
    opacity: active ? interpolate(p.value, [0, 1], [0.3, 0.75]) : focus.value * 0.45,
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          borderRadius: T.rComposer,
          borderWidth: 1.6,
          borderColor: "rgba(255,90,60,0.42)",
        },
        s,
      ]}
    />
  );
}

// Send slot: mic glyph when empty (dictation toggle), accent ↑ with text,
// ■ stop while the agent runs. Morph is a 150ms ease-out crossfade+scale.
// While dictating the mic pulses red; tap again to end the take.
function SendSlot({
  canSend,
  streaming,
  listening,
  dictAvailable,
  onSend,
  onStop,
  onMic,
}: {
  canSend: boolean;
  streaming: boolean;
  listening: boolean;
  dictAvailable: boolean;
  onSend: () => void;
  onStop: () => void;
  onMic: () => void;
}) {
  const prog = useSharedValue(0); // 0 mic, 1 send, 2 stop
  const live = useSharedValue(0);
  useEffect(() => {
    prog.value = withTiming(streaming ? 2 : canSend ? 1 : 0, {
      duration: 150,
      easing: Easing.out(Easing.ease),
    });
  }, [streaming, canSend]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    live.value = listening
      ? withRepeat(withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }), -1, true)
      : withTiming(0, { duration: 150 });
  }, [listening]); // eslint-disable-line react-hooks/exhaustive-deps

  const bg = useAnimatedStyle(() => ({
    // Cowork spec: the right slot is always a black circle — glyph morphs
    // mic → send → stop; stop drops to ink for a subtle state shift.
    backgroundColor: interpolateColor(prog.value, [0, 1, 2], ["#0B0B0E", "#0B0B0E", T.ink]),
  }));
  const micS = useAnimatedStyle(() => ({
    opacity: interpolate(prog.value, [0, 1, 2], [1, 0, 0]),
    transform: [{ scale: interpolate(prog.value, [0, 1], [1, 0.5]) }],
  }));
  const liveRing = useAnimatedStyle(() => ({
    opacity: live.value * 0.55,
    transform: [{ scale: 1 + live.value * 0.18 }],
  }));
  const upS = useAnimatedStyle(() => ({
    opacity: interpolate(prog.value, [0, 1, 2], [0, 1, 0]),
    transform: [{ scale: interpolate(prog.value, [0, 1, 2], [0.5, 1, 0.5]) }],
  }));
  const stopS = useAnimatedStyle(() => ({
    opacity: interpolate(prog.value, [0, 1.5, 2], [0, 0, 1]),
    transform: [{ scale: interpolate(prog.value, [1, 2], [0.5, 1]) }],
  }));

  return (
    <PressScale
      scale={0.84}
      onPress={() => {
        if (streaming) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onStop();
        } else if (listening) {
          Haptics.selectionAsync();
          onMic();
        } else if (canSend) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onSend();
        } else {
          Haptics.selectionAsync();
          onMic();
        }
      }}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={
        streaming ? "Stop generating" : canSend ? "Send message" : "Voice input"
      }
    >
      <Animated.View style={[styles.sendBtn, bg]}>
        <Animated.View style={[styles.liveRing, liveRing]} />
        <Animated.View style={[styles.sendIcon, micS]}>
          <Icon
            name="mic"
            android="mic"
            color={listening ? "#FF5A45" : dictAvailable ? "#FFFFFF" : "rgba(255,255,255,0.4)"}
            size={14}
          />
        </Animated.View>
        <Animated.Text style={[styles.sendGlyph, upS]}>↑</Animated.Text>
        <Animated.View style={[styles.stopGlyph, stopS]} />
      </Animated.View>
    </PressScale>
  );
}

// Attachment tray — springs open (height + fade + slight drop) the moment
// the first chip lands; each chip fades in on a small stagger of its own.
function AttachRow({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const v = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!reduced) v.value = withSpring(1, { damping: 20, stiffness: 240 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const s = useAnimatedStyle(() => ({
    opacity: v.value,
    maxHeight: 4 + v.value * 150,
    transform: [{ translateY: (1 - v.value) * -6 }],
  }));
  return <Animated.View style={[styles.attachRow, s]}>{children}</Animated.View>;
}

function AttachChip({
  a,
  i,
  onRemove,
}: {
  a: Attachment;
  i: number;
  onRemove: () => void;
}) {
  const s = useFadeInStyle(Math.min(i * 30, 150));
  return (
    <Animated.View style={[styles.attachChip, s]}>
      {a.kind === "image" && a.uri ? (
        <Image source={{ uri: a.uri }} style={styles.attachImg} />
      ) : (
        <Icon name="doc" android="description" color={T.sub} size={14} />
      )}
      <Text numberOfLines={1} style={[FONT.tiny, styles.attachName]}>
        {a.name}
      </Text>
      <PressScale onPress={onRemove} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${a.name}`}>
        <Text style={{ color: T.faint, fontSize: 14, paddingLeft: 2 }}>×</Text>
      </PressScale>
    </Animated.View>
  );
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  attachments,
  onRemoveAttachment,
  chips,
  slashCommands,
  placeholder = "Message",
  disabled,
  split,
}: Props) {
  // Focus raises the pill — soft shadow deepen + accent ring (in Glow).
  const [slashDismissed, setSlashDismissed] = useState(false);
  // Voice input — the mic slot starts on-device speech recognition; interim
  // results stream into the field so the user can edit before sending.
  const [listening, setListening] = useState(false);
  const dictBase = useRef("");
  // Speech recognition availability is a device property (sims and some
  // locales report false) — probe once so an unavailable mic explains itself
  // instead of no-oping silently.
  const [dictAvailable] = useState(() => {
    try {
      return !!ExpoSpeechRecognitionModule?.isRecognitionAvailable();
    } catch {
      return false;
    }
  });
  const [dictHint, setDictHint] = useState(false);
  const dictHintT = useRef<ReturnType<typeof setTimeout> | null>(null);

  useSpeechRecognitionEvent("result", (e) => {
    const t = (e.results || []).map((r: any) => r.transcript).join("");
    if (t) onChange(dictBase.current + t);
  });
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("error", () => setListening(false));
  useEffect(
    () => () => {
      if (dictHintT.current) clearTimeout(dictHintT.current);
    },
    []
  );

  const toggleDictation = async () => {
    if (listening) {
      setListening(false);
      try {
        ExpoSpeechRecognitionModule?.stop();
      } catch {}
      return;
    }
    if (!dictAvailable || !ExpoSpeechRecognitionModule) {
      setDictHint(true);
      if (dictHintT.current) clearTimeout(dictHintT.current);
      dictHintT.current = setTimeout(() => setDictHint(false), 2400);
      return;
    }
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) return;
      dictBase.current = value ? value + (value.endsWith(" ") ? "" : " ") : "";
      setListening(true);
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: true,
        continuous: true,
      });
    } catch {
      setListening(false);
    }
  };
  const focus = useSharedValue(0);
  const focusStyle = useAnimatedStyle(() => ({
    shadowColor: "#000",
    shadowOpacity: interpolate(focus.value, [0, 1], [0.04, 0.12]),
    shadowRadius: interpolate(focus.value, [0, 1], [2, 10]),
    shadowOffset: { width: 0, height: interpolate(focus.value, [0, 1], [1, 4]) },
    elevation: interpolate(focus.value, [0, 1], [1, 6]),
  }));
  const canSend = !!value.trim() || attachments.length > 0;

  // Slash autocomplete — "/" at field start lists honest commands; a space
  // ends it, blur dismisses, typing again revives it.
  const slashQuery = /^\/(\S*)$/.exec(value)?.[1];
  const slashOpen =
    !!slashCommands?.length && slashQuery !== undefined && !slashDismissed;
  const slashMatches = slashOpen
    ? (slashCommands || []).filter((cmd) =>
        cmd.name.startsWith((slashQuery || "").toLowerCase())
      )
    : [];
  const change = (t: string) => {
    setSlashDismissed(false);
    onChange(t);
  };

  return (
    <View>
      {slashMatches.length ? (
        <View style={styles.slashWrap}>
          <View style={styles.slashCard}>
            {slashMatches.map((cmd, i) => (
              <PressScale
                key={cmd.name}
                onPress={() => {
                  Haptics.selectionAsync();
                  setSlashDismissed(true);
                  if (cmd.run) {
                    onChange("");
                    cmd.run();
                  } else {
                    onChange(cmd.insert);
                  }
                }}
                style={({ pressed }) => [
                  styles.slashRow,
                  i > 0 && styles.slashRowLine,
                  pressed && { backgroundColor: "rgba(0,0,0,0.04)" },
                ]}
                accessibilityRole="button"
                accessibilityLabel={cmd.label}
              >
                <Text style={[FONT.small, { color: T.ink, ...fw("600") }]}>
                  {cmd.label}
                </Text>
                <Text
                  style={[FONT.tiny, { color: T.faint, flex: 1 }]}
                  numberOfLines={1}
                >
                  {cmd.insert}
                </Text>
              </PressScale>
            ))}
          </View>
        </View>
      ) : null}
      {dictHint ? (
        <View style={styles.dictHintWrap}>
          <Text style={styles.dictHint}>
            Voice input isn&apos;t available on this device
          </Text>
        </View>
      ) : null}
      <View style={split ? styles.splitRow : undefined}>
        <Animated.View
          style={[
            styles.outer,
            split ? styles.outerPill : null,
            split ? null : T.shadowComposer,
            // flex:1 is only safe inside splitRow (row direction) — in the
            // column layout a basis-0 grow child collapses to zero height.
            split ? styles.outerFill : null,
            focusStyle,
          ]}
        >
          <Glow active={streaming} focus={focus} />
          {attachments.length > 0 && (
            <AttachRow>
              {attachments.map((a, i) => (
                <AttachChip key={i} a={a} i={i} onRemove={() => onRemoveAttachment(i)} />
              ))}
            </AttachRow>
          )}
          <View style={styles.row}>
            <TextInput
              value={value}
              onChangeText={change}
              placeholder={placeholder}
              placeholderTextColor={T.placeholder}
              multiline
              editable={!disabled}
              onFocus={() => driveFocus(focus, true)}
              onBlur={() => {
                driveFocus(focus, false);
                setSlashDismissed(true);
              }}
              // Enter sends (Shift+Enter still newlines) — chat convention.
              // The web DOM event carries shiftKey; RN's declared type omits it.
              onKeyPress={(e) => {
                const ev = e.nativeEvent as { key: string; shiftKey?: boolean };
                if (ev.key === "Enter" && !ev.shiftKey) {
                  e.preventDefault();
                  if (canSend) onSend();
                }
              }}
              style={styles.input}
              accessibilityLabel={placeholder}
            />
            <SendSlot
              canSend={canSend}
              streaming={streaming}
              listening={listening}
              dictAvailable={dictAvailable}
              onSend={onSend}
              onStop={onStop}
              onMic={toggleDictation}
            />
          </View>
        </Animated.View>
      </View>
      {chips?.length ? (
        <View style={styles.chipRow}>
          {(chips || []).map((chip, i) => (
            <PressScale
              key={i}
              onPress={chip.onPress}
              disabled={!chip.onPress}
              hitSlop={6}
              style={({ pressed }) => [styles.contextChip, pressed && { opacity: 0.7 }]}
              accessibilityRole={chip.onPress ? "button" : "text"}
              accessibilityLabel={chip.label}
            >
              {chip.icon ? (
                <Icon
                  name={chip.icon as any}
                  android={(chip.android || chip.icon) as any}
                  color={T.faint}
                  size={10}
                />
              ) : null}
              <Text
                style={[FONT.small, { color: T.sub, ...fw("500"), fontSize: 11 }]}
                numberOfLines={1}
              >
                {chip.label}
              </Text>
              {chip.onPress ? (
                <Icon name="chevron.down" android="expand_more" color={T.faint} size={10} />
              ) : null}
            </PressScale>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    borderRadius: T.rComposer,
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  splitRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  outerFill: { flex: 1 },
  // Grok mobile anatomy: the field is a borderless soft-gray pill — no
  // hairline, no card shadow; text sits ~16pt in from the left edge.
  outerPill: {
    borderRadius: 25,
    backgroundColor: T.fieldBg,
    borderWidth: 0,
    paddingLeft: 12,
    paddingVertical: 4,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
    paddingTop: 9,
    paddingLeft: 2,
  },
  // Grok-minimal model pill — small text, subtle hairline, no fill.
  contextChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: T.rPill,
    backgroundColor: "transparent",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    maxWidth: 220,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 46,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: T.ink,
    maxHeight: 120,
    paddingVertical: 6,
    paddingHorizontal: 5,
    ...fw("400"),
  },
  sendBtn: {
    width: 30, // spec: single 30pt morph circle
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  sendIcon: { position: "absolute" },
  liveRing: {
    position: "absolute",
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
    borderColor: "#FF5A45",
  },
  sendGlyph: {
    position: "absolute",
    fontSize: 16,
    ...fw("700"),
    color: "#fff",
    marginTop: -1,
  },
  stopGlyph: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: 3,
    backgroundColor: "#fff",
  },
  attachRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingTop: 4,
    paddingBottom: 6,
    overflow: "hidden",
  },
  attachChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 6,
    paddingRight: 8,
    borderRadius: 12,
    backgroundColor: T.cardBgTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    maxWidth: 180,
  },
  attachImg: { width: 34, height: 34, borderRadius: 8 },
  attachName: { color: T.sub, maxWidth: 100 },
  dictHintWrap: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    right: 0,
    paddingBottom: 8,
    zIndex: 20,
    alignItems: "center",
  },
  dictHint: {
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    paddingHorizontal: 12,
    paddingVertical: 6,
    color: T.sub,
    fontSize: 12,
    overflow: "hidden",
    ...T.shadowTight,
  },
  slashWrap: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    right: 0,
    paddingBottom: 8,
    zIndex: 20,
  },
  slashCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    paddingVertical: 4,
    overflow: "hidden",
    ...T.shadowTight,
  },
  slashRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    minHeight: 40,
  },
  slashRowLine: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.hairline,
  },
});
