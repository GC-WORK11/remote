// __DEV__-only fixture: the mascot family gallery — hero tile, roster at
// rail + row sizes, header chip and working line, no rig needed.
import React from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { Redirect } from "expo-router";
import { Screen } from "../components/glass";
import { Mascot, Buddy, buddyName, buddyFor } from "../components/mascot";
import { WorkingRow } from "../components/rows";
import { BUDDY_ROSTER, BuddyShape, T, FONT, fw } from "../theme";

export default function DevMascots() {
  if (!__DEV__) return <Redirect href="/" />;
  return (
    <Screen pad={16}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text style={[FONT.title, { color: T.ink, marginBottom: 18 }]}>Mascot family</Text>

        {/* hero — blob centered in a soft rounded tile, name below */}
        <View style={styles.heroCol}>
          <View style={styles.heroTile}>
            <Mascot shape="triangle" color="#FF5FB0" size={84} />
          </View>
          <Text style={[FONT.head, { color: T.ink, marginTop: 16, fontSize: 15 }]}>DevBot</Text>
        </View>

        {/* the roster — row size */}
        <View style={styles.grid}>
          {BUDDY_ROSTER.map((b, i) => (
            <View key={i} style={styles.cell}>
              <Mascot shape={b.shape as BuddyShape} color={b.color} size={44} />
              <Text style={[FONT.meta, { color: T.faint, marginTop: 6 }]}>
                {b.shape}
              </Text>
            </View>
          ))}
        </View>

        {/* rail size — 28px blobs like the sidebar list */}
        <Text style={[FONT.small, { color: T.sub, ...fw("600"), marginTop: 8 }]}>Rail (28)</Text>
        <View style={[styles.grid, { marginTop: 8 }]}>
          {BUDDY_ROSTER.map((b, i) => (
            <View key={i} style={[styles.cell, { width: 40 }]}>
              <Mascot shape={b.shape as BuddyShape} color={b.color} size={28} />
            </View>
          ))}
        </View>

        {/* header chip — tiny mascot + name in a centered pill */}
        <Text style={[FONT.small, { color: T.sub, ...fw("600"), marginTop: 16 }]}>Header chip</Text>
        <View style={{ alignItems: "center", marginTop: 8 }}>
          <View style={styles.namePill}>
            <Buddy k="remote" size={22} />
            <Text style={[FONT.head, { color: T.ink, marginLeft: 8 }]}>DevBot</Text>
          </View>
        </View>

        {/* working line — small blob + muted text */}
        <Text style={[FONT.small, { color: T.sub, ...fw("600"), marginTop: 16 }]}>Working line</Text>
        <View style={{ marginTop: 8 }}>
          <WorkingRow buddyKey="remote" />
          <WorkingRow buddyKey="sess_dev_thread" name={buddyName("sess_dev_thread")} />
          <WorkingRow buddyKey="sess_alpha" />
        </View>

        {/* hashed personas — what real sessions look like */}
        <Text style={[FONT.small, { color: T.sub, ...fw("600"), marginTop: 16 }]}>Sessions</Text>
        <View style={{ marginTop: 8 }}>
          {["sess_dev_thread", "sess_alpha", "sess_beta", "sess_gamma"].map((k) => (
            <View key={k} style={styles.row}>
              <Buddy k={k} size={44} />
              <View style={{ flex: 1, marginLeft: 13 }}>
                <Text style={[FONT.head, { color: T.ink, fontSize: 14 }]}>{buddyName(k)}</Text>
                <Text style={[FONT.small, { color: T.sub, fontSize: 12.5, marginTop: 2 }]}>
                  {buddyFor(k).shape} · {buddyFor(k).color}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heroCol: { alignItems: "center", paddingVertical: 8 },
  heroTile: {
    width: 104,
    height: 104,
    borderRadius: 26,
    backgroundColor: "#EFEDE9",
    alignItems: "center",
    justifyContent: "center",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 10,
  },
  cell: { width: 64, alignItems: "center" },
  namePill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: T.rPill,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 46,
    ...T.shadowTight,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
  },
});
