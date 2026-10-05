// Connect GitHub — the laptop's real `gh` CLI, driven from the phone.
// Lists the signed-in account's repos; tap one and it's cloned into
// ~/code/<name> on the rig (or opened in place when already cloned) and a
// code session starts rooted there. No fake state: when gh is missing or
// not authed, the screen says so and shows the laptop-side command.
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Screen } from "../../components/glass";
import { Icon } from "../../components/icon";
import { T, FONT, fw, tilde } from "../../theme";
import { rig } from "../../rig";
import { useRig } from "../../state";
import { startSessionWithCwd } from "../../useChat";
import { PressScale } from "../../components/pressable";
import { relTime } from "../../reltime";

type Repo = {
  nameWithOwner: string;
  description?: string;
  isPrivate?: boolean;
  updatedAt?: string;
};

type GhState =
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "unauthed" }
  | { phase: "error"; message: string }
  | { phase: "ready"; repos: Repo[] };

export default function Repos() {
  const { connected } = useRig();
  const [st, setSt] = useState<GhState>({ phase: "loading" });
  const [home, setHome] = useState("");
  const [cloning, setCloning] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const probe = async () => {
    setSt({ phase: "loading" });
    try {
      const h = await rig.exec("echo $HOME", "", () => {}, 8000);
      const homeDir = String(h.out || "").trim();
      if (homeDir.startsWith("/")) setHome(homeDir);
      const which = await rig.exec("command -v gh", "", () => {}, 8000);
      if (!String(which.out || "").trim()) {
        setSt({ phase: "missing" });
        return;
      }
      const auth = await rig.exec("gh auth status", "", () => {}, 10000);
      // gh exits 1 with "not logged into any hosts" when unauthed.
      if (auth.code !== 0) {
        setSt({ phase: "unauthed" });
        return;
      }
      const list = await rig.exec(
        "gh repo list --limit 40 --json nameWithOwner,description,isPrivate,updatedAt",
        "",
        () => {},
        20000
      );
      if (list.code !== 0) {
        setSt({
          phase: "error",
          message: String(list.out || "gh repo list failed").trim().slice(0, 200),
        });
        return;
      }
      let repos: Repo[] = [];
      try {
        repos = JSON.parse(String(list.out || "[]"));
      } catch {
        setSt({ phase: "error", message: "Couldn't read the repo list" });
        return;
      }
      setSt({ phase: "ready", repos });
    } catch (e) {
      setSt({
        phase: "error",
        message: e instanceof Error ? e.message : "gh probe failed",
      });
    }
  };

  useEffect(() => {
    if (!connected) return;
    // deferred a tick — probe() synchronously flips state to loading, and
    // setState inside the effect body trips react-hooks/set-state-in-effect
    const t = setTimeout(probe, 0);
    return () => clearTimeout(t);
  }, [connected]);

  const openRepo = async (repo: Repo) => {
    const full = repo.nameWithOwner;
    const name = full.split("/").pop() || full;
    const base = home ? `${home}/code` : "~/code";
    const dir = `${base}/${name}`;
    setCloning(full);
    setNote("");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await rig.fsMkdir(base);
      // Already cloned? Open it straight — a fresh `gh repo clone` would
      // fail non-destructively, but the check saves the round trip. An
      // existing-but-empty dir doesn't count (nothing to work in).
      const existing = await rig.fsList(dir, 8000).catch(() => null);
      const populated = !!existing && existing.dirs.length + existing.files.length > 0;
      if (!populated) {
        setNote(`Cloning ${full}…`);
        const cl = await rig.exec(`gh repo clone "${full}"`, base, () => {}, 120000);
        if (cl.code !== 0) {
          // gh answers "already exists and is not an empty directory" for
          // the non-git populated case — still open it as a project.
          if (!/already exists/i.test(String(cl.out || ""))) {
            setNote(
              String(cl.out || "Clone failed").trim().split("\n").pop()?.slice(0, 160) ||
                "Clone failed"
            );
            setCloning(null);
            return;
          }
        }
      }
      startSessionWithCwd(dir);
      router.navigate("/thread");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't open the repo");
      setCloning(null);
    }
  };

  return (
    <Screen pad={16}>
      <View style={styles.topBar}>
        <PressScale
          onPress={() => (router.canGoBack() ? router.back() : router.navigate("/home"))}
          style={styles.circleBtn}
          hitSlop={8}
          accessibilityLabel="Back"
        >
          <Icon name="chevron.left" android="arrow_back" color={T.ink} size={16} />
        </PressScale>
        <Text style={[FONT.head, { color: T.ink, flex: 1 }]}>Connect GitHub</Text>
        <PressScale
          onPress={probe}
          style={styles.circleBtn}
          hitSlop={8}
          accessibilityLabel="Refresh"
        >
          <Icon name="arrow.clockwise" android="refresh" color={T.ink} size={15} />
        </PressScale>
      </View>

      <Text style={[FONT.small, { color: T.sub, marginBottom: 10 }]}>
        Repos on the laptop&rsquo;s GitHub account — tap to clone into{" "}
        <Text style={fw("700")}>{tilde(home ? `${home}/code` : "~/code")}</Text> and
        open as a project.
      </Text>

      {st.phase === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator color={T.sub} />
        </View>
      ) : st.phase === "missing" ? (
        <View style={styles.stateCard}>
          <Icon name="apple.terminal" android="terminal" color={T.sub} size={20} />
          <Text style={[FONT.head, { color: T.ink }]}>gh isn&rsquo;t on the rig</Text>
          <Text style={[FONT.small, { color: T.sub, textAlign: "center" }]}>
            Install the GitHub CLI on your laptop —
            {"\n"}macOS: brew install gh   ·   Linux: apt install gh
            {"\n"}Windows: winget install GitHub.cli
          </Text>
        </View>
      ) : st.phase === "unauthed" ? (
        <View style={styles.stateCard}>
          <Icon name="person.crop.circle.badge.exclam" android="account_circle" color={T.sub} size={20} />
          <Text style={[FONT.head, { color: T.ink }]}>GitHub isn&rsquo;t signed in</Text>
          <Text style={[FONT.small, { color: T.sub, textAlign: "center" }]}>
            On the laptop, run: gh auth login{"\n"}
            Then pull to refresh here.
          </Text>
        </View>
      ) : st.phase === "error" ? (
        <View style={styles.stateCard}>
          <Icon name="exclamationmark.triangle" android="warning" color={T.bad} size={20} />
          <Text style={[FONT.small, { color: T.bad, textAlign: "center" }]}>{st.message}</Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 20 }}>
          {note ? (
            <Text style={[FONT.small, { color: T.sub, paddingBottom: 8 }]}>{note}</Text>
          ) : null}
          {st.repos.length === 0 ? (
            <Text style={[FONT.small, { color: T.sub, textAlign: "center", paddingVertical: 30 }]}>
              No repositories on this account.
            </Text>
          ) : null}
          {st.repos.map((r) => (
            <PressScale
              key={r.nameWithOwner}
              onPress={() => openRepo(r)}
              disabled={!!cloning}
              style={({ pressed }) => [
                styles.row,
                pressed && { backgroundColor: "rgba(0,0,0,0.04)" },
              ]}
            >
              <Icon
                name={r.isPrivate ? "lock.fill" : "book.closed"}
                android={r.isPrivate ? "lock" : "menu_book"}
                color={T.sub}
                size={15}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[FONT.body, { color: T.ink, ...fw("600") }]} numberOfLines={1}>
                  {r.nameWithOwner}
                </Text>
                {r.description ? (
                  <Text style={[FONT.small, { color: T.sub }]} numberOfLines={1}>
                    {r.description}
                  </Text>
                ) : null}
              </View>
              {cloning === r.nameWithOwner ? (
                <ActivityIndicator size="small" color={T.sub} />
              ) : (
                <Text style={[FONT.meta, { color: T.faint }]}>
                  {r.updatedAt ? relTime(Date.parse(r.updatedAt)) : ""}
                </Text>
              )}
            </PressScale>
          ))}
        </ScrollView>
      )}
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
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  stateCard: {
    marginTop: 40,
    alignItems: "center",
    gap: 10,
    backgroundColor: T.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairlineStrong,
    padding: 24,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 11,
    paddingHorizontal: 8,
    borderRadius: 12,
    marginHorizontal: -8,
  },
});
