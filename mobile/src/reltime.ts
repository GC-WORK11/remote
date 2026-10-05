// Cursor-style relative stamps: "now", "4m", "2h", "17h", "Yesterday",
// then weekday-within-week, then short date — the convention on the
// Workspaces inbox and code-thread status lines.
export function relTime(t?: number): string {
  if (!t) return "";
  const d = new Date(t);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m`;
  if (diff < 86_400_000 && d.toDateString() === now.toDateString())
    return `${Math.round(diff / 3_600_000)}h`;
  const y = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  if (diff < 6 * 86_400_000)
    return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "Finished 6m" — quiet status line under a settled turn.
export function finishedAgo(t?: number): string {
  const r = relTime(t);
  if (!r) return "";
  return r === "now" ? "Finished now" : `Finished ${r} ago`;
}
