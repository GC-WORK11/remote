/**
 * Remote Guard — pauses destructive/risky tool calls for phone approval.
 * The phone shows an approval card; Deny blocks the tool before it runs.
 */

const RISKY = [
	/\brm\s+(-[a-zA-Z]*[rf]\b|--recursive|--force)/,
	/\bsudo\b/,
	/\bmkfs\b|\bdd\s+.*of=\/dev/,
	/>\s*\/(etc|usr|bin|sbin|var|System)\//,
	/\bgit\s+push\s+.*(-f\b|--force)/,
	/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/,
	/\bnpm\s+publish\b|\bbrew\s+uninstall\b|\bpip\s+uninstall\b/,
	/\bcurl\b[^|]*\|\s*(sh|bash)\b|\bwget\b[^|]*\|\s*(sh|bash)\b/,
	/\bkill(all)?\s+-9\b|\bchmod\s+-R\s+777\b/,
];

export default function (pi: {
	on: (event: string, handler: (event: any, ctx: any) => Promise<any>) => void;
}) {
	pi.on("tool_call", async (event: { toolName?: string; input?: any }, ctx: any) => {
		if (!ctx?.hasUI) return;
		if (event.toolName === "bash") {
			const command = String(event.input?.command ?? "");
			if (command.includes("GUARD-PROBE")) return { block: true, reason: "guard-hook-active" };
			if (!RISKY.some((re) => re.test(command))) return;
			const confirmed = await ctx.ui.confirm(
				"Allow this command?",
				command.length > 400 ? `${command.slice(0, 400)}…` : command,
			);
			if (!confirmed) return { block: true, reason: "Denied from your phone" };
			return;
		}
		if (event.toolName === "write" || event.toolName === "edit") {
			const p = String(event.input?.path ?? event.input?.filePath ?? "");
			if (!/^\/(etc|usr|bin|sbin|var|System|private\/etc)\//.test(p)) return;
			const confirmed = await ctx.ui.confirm(`Write to ${p}?`, "This is outside the workspace — allow it?");
			if (!confirmed) return { block: true, reason: "Denied from your phone" };
		}
	});
}
