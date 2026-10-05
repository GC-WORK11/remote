// Remote design tokens v3 — calibrated to the Grok Bot / Muse / Cursor refs.
// Pure-white canvas (Grok), warm-cream alt (Muse), black user bubbles,
// light-gray agent bubbles, hairline-free action cards, black CTA pills.
import { Platform } from "react-native";

export const T = {
  bg: "#F6F4F1", // spec canvas — warm paper
  bgWarm: "#F7F4EE", // Muse cream — cowork wallpaper alt
  bgGradientTop: "#F9F7F4",
  bgGradientBottom: "#F4F2EE",
  ink: "#161513", // spec text primary
  inkSoft: "#22201D",
  sub: "#6B6660", // spec text secondary
  faint: "#A8A29B", // spec text tertiary
  placeholder: "#A8A29B",
  accent: "#FF5A3C", // spec coral — recording/live accents only
  accentSoft: "rgba(255,90,60,0.10)",
  sentBubble: "#161513", // spec pure ink bubble
  sentText: "#FFFFFF",
  agentBubble: "#EDEAE6", // spec muted fill
  agentBubbleAlt: "#FFFFFF",
  surface: "#FFFFFF", // spec surface
  surfaceStrong: "#FFFFFF",
  cardBg: "#FFFFFF",
  cardBgTint: "#EDEAE6", // spec muted-fill wash inside cards
  cardLine: "rgba(0,0,0,0.06)",
  controlBg: "rgba(0,0,0,0.045)",
  surfaceSoft: "#FBFAF8", // spec raised/soft surface inside cards
  pillBg: "#EDEAE6",
  fieldBg: "#E9E6E1", // Grok composer pill / quiet secondary fill — soft gray, reads on bg
  hairline: "rgba(0,0,0,0.06)", // spec hairline — the only border tone
  hairlineStrong: "rgba(0,0,0,0.10)",
  separator: "rgba(0,0,0,0.05)",
  sepText: "#A8A29B",
  dotIdle: "#B9B5AB", // typing/typing-placeholder dots
  codeBg: "#ECE9E3",
  codeCard: "#16161A",
  ok: "#1BA672", // spec ready-green
  okBg: "#E4F4EC", // spec on-green pill surface
  warn: "#E87B1C",
  bad: "#E03E3E",
  link: "#3478F6", // iMessage link blue
  working: "#3478F6",
  prGreen: "#1BA672",
  prRed: "#E03E3E",
  rScreen: 40,
  rCard: 14, // spec card radius
  rBubble: 18, // spec bubble radius
  rBubbleTail: 4,
  rComposer: 24,
  rSheet: 28, // spec sheet top radius
  rChip: 16, // spec chip radius
  rPill: 999,
  rBtn: 12,
  rIconTile: 12,
  shadow: {
    shadowColor: "rgba(20,20,28,1)",
    shadowOpacity: 0.07,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
  },
  shadowFloat: {
    shadowColor: "rgba(20,20,28,1)",
    shadowOpacity: 0.13,
    shadowRadius: 40,
    shadowOffset: { width: 0, height: 16 },
    elevation: 8,
  },
  shadowTight: {
    shadowColor: "rgba(20,20,28,1)",
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  shadowComposer: {
    shadowColor: "rgba(0,0,0,1)",
    shadowOpacity: 0.04,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
} as const;

// Android ships Roboto; iOS renders SF. Inter (bundled via
// @expo-google-fonts/inter) is metric-compatible with SF — Android text
// draws at iOS density instead of the wider Roboto default. RN ignores
// `fontWeight` once a variant family is set, so fw() returns the exact
// Inter face on Android and just the weight elsewhere.
const INTER: Record<string, string> = {
  "400": "Inter_400Regular",
  "500": "Inter_500Medium",
  "600": "Inter_600SemiBold",
  "700": "Inter_700Bold",
  "800": "Inter_800ExtraBold",
  "900": "Inter_900Black",
};
export function fw<W extends string | number>(
  weight: W
): { fontWeight: W; fontFamily?: string } {
  const fam = Platform.OS === "android" ? INTER[String(weight)] : undefined;
  return fam ? { fontWeight: weight, fontFamily: fam } : { fontWeight: weight };
}

// Android pads every line box with extra font-metric space — pills and
// bubbles render text a few px low with it on. includeFontPadding off keeps
// labels optically centered; iOS ignores the prop entirely.
const TIGHT = Platform.OS === "android" ? { includeFontPadding: false } : {};

export const FONT = {
  hero: { fontSize: 42, ...fw("800"), letterSpacing: -1.4, ...TIGHT },
  title: { fontSize: 20, ...fw("600"), letterSpacing: -0.3, ...TIGHT },
  head: { fontSize: 17, ...fw("600"), letterSpacing: -0.2, ...TIGHT },
  body: { fontSize: 16, ...fw("400"), ...TIGHT },
  small: { fontSize: 13, ...fw("500"), ...TIGHT },
  meta: { fontSize: 11, ...fw("400"), ...TIGHT },
  pill: { fontSize: 11, ...fw("500"), ...TIGHT },
  tiny: { fontSize: 11, ...fw("500"), ...TIGHT },
  // Menlo is iOS-only — Android/web need the generic family or code text
  // silently renders proportional.
  mono: { fontSize: 13, ...fw("400"), fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), ...TIGHT },
};

// Session cwd → display path: only a real home-dir prefix collapses to ~/
// ("/Users/devin/repos/remote" → "~/repos/remote"). Everything else stays an
// honest absolute path — never invent a ~ that isn't there ("/tmp/x").
export function tilde(cwd?: string): string {
  const p = (cwd || "").replace(/\/+$/, "");
  const m = p.match(/^\/(Users|home)\/[^/]+/);
  return m ? "~" + p.slice(m[0].length) : p;
}

// Flat organic blob family — each buddy is a silhouette + solid color,
// the DevBot-style creature set. `cloud` is the brand mark (brand call
// sites pin it); threads get the blob roster.
export type BuddyShape =
  | "cloud"
  | "triangle"
  | "circle"
  | "square"
  | "hexagon"
  | "pill"
  | "droplet"
  | "duo";

// Shape+color pairs pixel-sampled from the refs — buddyFor() hashes a
// session key into it, so every thread keeps its own creature. Index 0 is
// the DevBot hero: hot-pink rounded triangle.
export const BUDDY_ROSTER: { shape: BuddyShape; color: string }[] = [
  { shape: "triangle", color: "#FF5FB0" }, // DevBot pink — the hero
  { shape: "circle", color: "#A87EFE" }, // lavender
  { shape: "square", color: "#141414" }, // ink
  { shape: "hexagon", color: "#FFAE38" }, // amber
  { shape: "pill", color: "#09C171" }, // green capsule
  { shape: "circle", color: "#1E8BF7" }, // bright blue
  { shape: "duo", color: "#FF8533" }, // orange square + blue drop
  { shape: "pill", color: "#EF2E90" }, // hot-pink capsule
  { shape: "triangle", color: "#14CC6E" }, // green blob
  { shape: "circle", color: "#FF9F1E" }, // orange
  { shape: "square", color: "#FF8E24" }, // tangerine
  { shape: "droplet", color: "#1C8AFF" }, // blue drop
  { shape: "cloud", color: "#3D96F8" }, // lumpy cloud (rail ref)
  { shape: "circle", color: "#F24FA7" }, // pink oval
];
