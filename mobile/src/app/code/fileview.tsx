// File viewer + editor — reads a real file off the laptop (rig.fs.read);
// the pencil swaps the read pane for an editable field and Save runs
// rig.fs.write (atomic tmp+fsync+rename on the daemon side).
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { Screen } from "../../components/glass";
import { Icon } from "../../components/icon";
import { T, FONT, fw } from "../../theme";
import { rig } from "../../rig";
import { useRig } from "../../state";
import { PressScale } from "../../components/pressable";
import { pullFileToPhone } from "../../deliver";

export default function FileView() {
  const { connected } = useRig();
  const params = useLocalSearchParams<{ path?: string }>();
  const path = String(params.path || "");
  const name = path.split("/").pop() || "file";
  const dir = path.slice(0, Math.max(0, path.length - name.length - 1));
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState(false);

  const shareFile = async () => {
    if (pulling) return;
    Haptics.selectionAsync();
    setPulling(true);
    try {
      await pullFileToPhone(path, name);
      setPulled(true);
      setTimeout(() => setPulled(false), 2500);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setErr("couldn't pull the file to the phone — retry");
    } finally {
      setPulling(false);
    }
  };

  useEffect(() => {
    if (!connected || !path) return;
    rig
      .fsRead(path)
      .then((f: any) => {
        if (f.ok === false) setErr(String(f.error || "read failed"));
        else if (typeof f.content === "string")
          setText(f.truncated ? `${f.content}\n\n— truncated —` : f.content);
        else if (typeof f.contentBase64 === "string") setErr("binary file — preview not supported");
        else setErr("empty");
      })
      .catch((e: any) => setErr(e instanceof Error ? e.message : "read failed"));
  }, [connected, path]);

  const startEdit = () => {
    Haptics.selectionAsync();
    setDraft(text || "");
    setEditing(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const f: any = await rig.fsWrite(path, draft);
      if (f.ok === false) throw new Error(String(f.error || "write failed"));
      setText(draft);
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
      setEditing(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen pad={16}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.topBar}>
          <PressScale onPress={() => router.back()} style={styles.circleBtn} hitSlop={8}>
            <Icon name="chevron.left" android="arrow_back" color={T.ink} size={16} />
          </PressScale>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[FONT.head, { color: T.ink }]} numberOfLines={1}>
              {name}
            </Text>
            <Text style={[FONT.meta, { color: T.faint }]} numberOfLines={1}>
              {dir}
            </Text>
          </View>
          {text !== null && !editing ? (
            <PressScale onPress={startEdit} style={styles.circleBtn} hitSlop={8}>
              <Icon name="pencil" android="edit" color={T.ink} size={15} />
            </PressScale>
          ) : null}
          {!editing && path ? (
            <PressScale onPress={shareFile} style={styles.circleBtn} hitSlop={8}>
              {pulling ? (
                <ActivityIndicator color={T.ink} size="small" />
              ) : (
                <Icon
                  name="square.and.arrow.up"
                  android={pulled ? "check" : "ios_share"}
                  color={pulled ? T.ok : T.ink}
                  size={15}
                />
              )}
            </PressScale>
          ) : null}
        </View>
        {err ? (
          <Text style={[FONT.small, { color: T.bad, marginTop: 16 }]}>{err}</Text>
        ) : editing ? (
          <>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.body, styles.editor, FONT.mono]}
              textAlignVertical="top"
              accessibilityLabel={`Editing ${name}`}
            />
            <View style={styles.saveRow}>
              <PressScale
                onPress={() => setEditing(false)}
                style={styles.cancelBtn}
                hitSlop={8}
              >
                <Text style={[FONT.small, { color: T.sub, ...fw("600") }]}>Cancel</Text>
              </PressScale>
              <PressScale
                onPress={save}
                disabled={saving}
                style={[styles.saveBtn, saving && { opacity: 0.6 }]}
                hitSlop={8}
              >
                {saving ? (
                  <ActivityIndicator color="#FFF" size="small" />
                ) : (
                  <Text style={[FONT.small, { color: "#FFF", ...fw("700") }]}>
                    Save to laptop
                  </Text>
                )}
              </PressScale>
            </View>
          </>
        ) : text === null ? (
          <View style={{ paddingTop: 40, alignItems: "center" }}>
            <ActivityIndicator color={T.sub} />
          </View>
        ) : (
          <ScrollView
            style={styles.body}
            contentContainerStyle={{ padding: 14 }}
            showsVerticalScrollIndicator={false}
          >
            <Text selectable style={[FONT.mono, { fontSize: 12, lineHeight: 17, color: T.inkSoft }]}>
              {text}
            </Text>
          </ScrollView>
        )}
        {saved ? (
          <View style={styles.savedPill}>
            <Icon name="checkmark" android="check" color="#FFF" size={12} />
            <Text style={[FONT.tiny, { color: "#FFF", ...fw("600") }]}>Saved</Text>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  circleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: T.pillBg,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
    marginTop: 10,
    backgroundColor: T.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
  },
  editor: {
    padding: 14,
    fontSize: 12,
    lineHeight: 17,
    color: T.inkSoft,
  },
  saveRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 10,
    paddingTop: 10,
  },
  cancelBtn: { paddingHorizontal: 14, paddingVertical: 10 },
  saveBtn: {
    backgroundColor: T.ink,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 10,
    minWidth: 120,
    alignItems: "center",
  },
  savedPill: {
    position: "absolute",
    bottom: 22,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(30,30,32,0.92)",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
});
