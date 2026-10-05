// Folders — the laptop's real filesystem, browsed from the phone.
// Codex/Cursor "pick a folder" flow: breadcrumb, dirs first, files below,
// create-a-folder inline, "Open as project" lands the session's cwd there.
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform,
  BackHandler,
} from "react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Screen } from "../../components/glass";
import { Icon } from "../../components/icon";
import { T, FONT, fw } from "../../theme";
import { rig, Frame } from "../../rig";
import { useRig } from "../../state";
import { startSessionWithCwd } from "../../useChat";
import { PressScale } from "../../components/pressable";

type Entry = { path: string; size?: number; dir?: boolean };

function fmtSize(b?: number) {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function basename(p: string) {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}
function join(p: string, name: string) {
  return `${p.replace(/\/+$/, "")}/${name}`;
}

export default function Folders() {
  const { connected, setMode } = useRig();
  const [home, setHome] = useState<string | null>(null);
  const [path, setPath] = useState<string>("");
  const [dirs, setDirs] = useState<Entry[]>([]);
  const [files, setFiles] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const load = async (p: string) => {
    if (!p) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await rig.fsList(p, 15000);
      // matches come back relative to cwd — absolutize for the rows.
      const abs = (e: Frame) =>
        String(e.path || "").startsWith("/")
          ? e
          : { ...e, path: join(p, String(e.path || "")) };
      const toEntry = (e: Frame): Entry => {
        const a = abs(e);
        return { path: String(a.path || ""), size: a.size, dir: !!a.dir };
      };
      // file-manager convention: hidden entries stay hidden
      const visible = (e: Entry) => !basename(e.path).startsWith(".");
      setDirs(r.dirs.map(toEntry).filter(visible));
      setFiles(r.files.map(toEntry).filter(visible));
      setPath(p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't read this folder");
    } finally {
      setBusy(false);
    }
  };

  // Resolve ~ once — the listing path needs an absolute root.
  useEffect(() => {
    if (!connected) return;
    rig
      .exec("echo $HOME", "", () => {}, 8000)
      .then((f: any) => {
        const h = String(f.out || "").trim();
        const root = h.startsWith("/") ? h : "/";
        setHome(root);
        setPath(root);
        load(root);
      })
      .catch(() => {
        setHome("/");
        setPath("/");
        load("/");
      });
  }, [connected]);

  // Android: hardware back walks up one directory (cancels the inline
  // new-folder row first) instead of popping the route — the file-manager
  // convention this picker mirrors.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (creating) {
        setCreating(false);
        setNewName("");
        return true;
      }
      if (path && home && path !== home) {
        const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
        load(parent);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [creating, path, home]);


  const crumbs = React.useMemo(() => {
    if (!path) return [] as { label: string; path: string }[];
    const parts = path.split("/").filter(Boolean);
    const out: { label: string; path: string }[] = [];
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      out.push({ label: acc === home ? "Home" : part, path: acc });
    }
    return out;
  }, [path, home]);

  const mkdir = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await rig.fsMkdir(join(path, name));
      setNewName("");
      setCreating(false);
      await load(path);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "mkdir failed");
    } finally {
      setBusy(false);
    }
  };

  const openProject = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Folder-rooted bot — the thread reads the repo chrome off `mode`.
    // TODO(thread.tsx): derive from session.cwd there and drop the hint.
    setMode("code");
    try {
      startSessionWithCwd(path);
    } catch {}
    router.navigate("/thread");
  };

  return (
    <Screen pad={16}>
      {/* header */}
      <View style={styles.topBar}>
        <PressScale
          onPress={() => (router.canGoBack() ? router.back() : router.navigate("/home"))}
          style={styles.circleBtn}
          hitSlop={8}
        >
          <Icon name="chevron.left" android="arrow_back" color={T.ink} size={16} />
        </PressScale>
        <Text style={[FONT.head, { color: T.ink, flex: 1 }]}>Folders</Text>
        <PressScale
          onPress={() => {
            Haptics.selectionAsync();
            setCreating((v) => !v);
          }}
          style={styles.circleBtn}
          hitSlop={8}
          accessibilityLabel="New folder"
        >
          <Icon name="folder.badge.plus" android="create_new_folder" color={T.ink} size={16} />
        </PressScale>
      </View>

      {/* breadcrumb */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.crumbs}
        contentContainerStyle={{ alignItems: "center", gap: 2 }}
      >
        {crumbs.map((c, i) => (
          <React.Fragment key={c.path}>
            {i > 0 ? (
              <Icon name="chevron.right" android="chevron_right" color={T.faint} size={11} />
            ) : null}
            <PressScale
              onPress={() => load(c.path)}
              hitSlop={6}
              style={({ pressed }) => [
                styles.crumb,
                i === crumbs.length - 1 && styles.crumbOn,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Text
                style={[
                  FONT.small,
                  { color: i === crumbs.length - 1 ? T.ink : T.sub, ...fw(i === crumbs.length - 1 ? "700" : "500") },
                ]}
                numberOfLines={1}
              >
                {c.label}
              </Text>
            </PressScale>
          </React.Fragment>
        ))}
      </ScrollView>

      {/* new-folder inline row */}
      {creating ? (
        <View style={styles.newRow}>
          <Icon name="folder" android="folder" color={T.sub} size={16} />
          <TextInput
            value={newName}
            onChangeText={setNewName}
            placeholder="New folder name"
            placeholderTextColor={T.faint}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={mkdir}
            style={[FONT.body, styles.newInput]}
          />
          <PressScale onPress={mkdir} hitSlop={8} disabled={!newName.trim()}>
            <Icon
              name="checkmark.circle.fill"
              android="check_circle"
              color={newName.trim() ? T.ink : T.faint}
              size={20}
            />
          </PressScale>
        </View>
      ) : null}

      {err ? (
        <Text style={[FONT.small, { color: T.bad, paddingVertical: 8 }]}>{err}</Text>
      ) : null}

      {/* listing */}
      <ScrollView
        key={path}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 16 }}
        showsVerticalScrollIndicator={false}
      >
        {busy && !dirs.length && !files.length ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={T.sub} />
          </View>
        ) : null}
        {dirs.map((d) => (
          <PressScale
            key={d.path}
            onPress={() => load(d.path)}
            style={({ pressed }) => [
              styles.row,
              pressed && { backgroundColor: "rgba(0,0,0,0.04)" },
            ]}
          >
            <Icon name="folder" android="folder" color={T.ink} size={18} />
            <Text style={[FONT.body, { color: T.ink, flex: 1, fontSize: 15 }]} numberOfLines={1}>
              {basename(d.path)}
            </Text>
            <Icon name="chevron.right" android="chevron_right" color={T.faint} size={13} />
          </PressScale>
        ))}
        {files.map((f) => (
          <PressScale
            key={f.path}
            onPress={() =>
              router.push({ pathname: "/code/fileview", params: { path: f.path } })
            }
            style={({ pressed }) => [
              styles.row,
              pressed && { backgroundColor: "rgba(0,0,0,0.04)" },
            ]}
          >
            <Icon name="doc.text" android="description" color={T.sub} size={16} />
            <Text style={[FONT.body, { color: T.inkSoft, flex: 1, fontSize: 15 }]} numberOfLines={1}>
              {basename(f.path)}
            </Text>
            <Text style={[FONT.meta, { color: T.faint }]}>{fmtSize(f.size)}</Text>
          </PressScale>
        ))}
        {!busy && !dirs.length && !files.length && path ? (
          <Text style={[FONT.small, { color: T.sub, paddingVertical: 20, textAlign: "center" }]}>
            Empty folder
          </Text>
        ) : null}
      </ScrollView>

      {/* open-as-project bar */}
      <View style={styles.actionBar}>
        <View style={styles.pathPill}>
          <Icon name="folder" android="folder" color={T.sub} size={14} />
          <Text style={[FONT.small, { color: T.ink, flex: 1, ...fw("600") }]} numberOfLines={1}>
            {path.replace(home || "", "~") || "…"}
          </Text>
        </View>
        <PressScale
          onPress={openProject}
          style={({ pressed }) => [
            styles.openBtn,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
        >
          <Text style={[FONT.small, { color: "#FFF", ...fw("700") }]}>Open as project</Text>
        </PressScale>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },
  circleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: T.pillBg,
    alignItems: "center",
    justifyContent: "center",
  },
  crumbs: {
    flexGrow: 0,
    marginTop: 4,
    marginBottom: 8,
  },
  crumb: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
  },
  crumbOn: { backgroundColor: T.pillBg },
  newRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: T.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 10 : 6,
    marginBottom: 8,
  },
  newInput: { flex: 1, color: T.ink, paddingVertical: 0 },
  loadingWrap: { paddingVertical: 40, alignItems: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 11,
    paddingHorizontal: 8,
    borderRadius: 12,
    marginHorizontal: -8,
  },
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 8,
  },
  pathPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: T.pillBg,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minWidth: 0,
  },
  openBtn: {
    backgroundColor: T.ink,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
});
