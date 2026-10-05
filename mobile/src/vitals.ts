// rig.vitals reply → display strings. Every probed field is independently
// null — renderers skip what the host can't answer; nothing is fabricated.

export function fmtBytes(n?: number | null): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  const g = n / 1e9;
  if (g >= 10) return `${Math.round(g)} GB`;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  return `${Math.round(n / 1e6)} MB`;
}

export function fmtUptime(sec?: number | null): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return null;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function vitalsLine(v: any): string {
  if (!v || v.ok === false) return "";
  const parts: string[] = [];
  const b = v.battery;
  if (b && typeof b.pct === "number") {
    parts.push(
      `${b.pct}%${b.charging ? " charging" : b.state === "discharging" ? " batt" : ""}`
    );
  } else if (b?.source) {
    parts.push(String(b.source).replace(/ Power$/, ""));
  }
  const up = fmtUptime(v.uptimeSec);
  if (up) parts.push(`up ${up}`);
  if (Array.isArray(v.load) && typeof v.load[0] === "number")
    parts.push(`load ${v.load[0].toFixed(1)}`);
  else if (typeof v.cpuPct === "number") parts.push(`cpu ${v.cpuPct}%`);
  const free = fmtBytes(v.disk?.avail ?? v.disk?.free);
  if (free) parts.push(`${free} free`);
  if (typeof v.mem?.usedPct === "number") parts.push(`mem ${v.mem.usedPct}%`);
  // The drawer footer is narrow — the strip shows the strongest four probes
  // and leaves the rest to the screen-sheet rows, never a mid-token "…".
  return parts.slice(0, 4).join(" · ");
}

export interface VitalsRow {
  icon: string;
  android: string;
  label: string;
  value: string;
}

export function vitalsRows(v: any): VitalsRow[] {
  if (!v || v.ok === false) return [];
  const rows: VitalsRow[] = [];
  const b = v.battery;
  if (b) {
    const bits = [
      typeof b.pct === "number" ? `${b.pct}%` : "",
      b.state ? String(b.state) : b.charging ? "charging" : "",
      b.source ? `(${b.source})` : "",
    ].filter(Boolean);
    rows.push({
      icon: "battery.75",
      android: "battery_std",
      label: "Battery",
      value: bits.join(" ") || "present",
    });
  }
  const up = fmtUptime(v.uptimeSec);
  if (up) rows.push({ icon: "clock", android: "schedule", label: "Uptime", value: up });
  if (Array.isArray(v.load) && v.load.length === 3)
    rows.push({
      icon: "gauge",
      android: "speed",
      label: "Load",
      value: v.load.map((x: number) => x.toFixed(2)).join("  "),
    });
  else if (typeof v.cpuPct === "number")
    rows.push({ icon: "gauge", android: "speed", label: "CPU", value: `${v.cpuPct}%` });
  if (v.mem && typeof v.mem.total === "number") {
    const used = typeof v.mem.usedPct === "number" ? ` · ${v.mem.usedPct}% used` : "";
    const avail = fmtBytes(v.mem.avail);
    rows.push({
      icon: "memorychip",
      android: "memory",
      label: "Memory",
      value: `${avail ? `${avail} free` : ""}${used}`.trim() || `${fmtBytes(v.mem.total)} total`,
    });
  }
  if (v.disk && typeof v.disk.total === "number") {
    const free = fmtBytes(v.disk.avail ?? v.disk.free);
    rows.push({
      icon: "internaldrive",
      android: "storage",
      label: "Disk",
      value: `${free ?? "?"} free of ${fmtBytes(v.disk.total)}`,
    });
  }
  if (v.net?.ssid)
    rows.push({ icon: "wifi", android: "wifi", label: "Network", value: String(v.net.ssid) });
  return rows;
}
