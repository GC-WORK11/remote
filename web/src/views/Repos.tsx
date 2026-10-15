// Repos — git repos living on the rig, discovered and opened from the web.
// Port of mobile/src/app/code/repos.tsx's strategy: probe the rig with exec
// (here a `find` for .git dirs under $HOME, pruned), merge in session cwds,
// then rig.gitStatus({cwd}) for the branch. Tap → Files view at that path.
import { createSignal, onMount, Show, For } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { rig, tilde } from "../lib/rig";
import { app } from "../lib/store";
import I from "../components/Icon";
import "./codeviews.css";

type RepoRow = { path: string; name: string; branch?: string; dirty: number };
type St =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; repos: RepoRow[] };

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

export default function Repos() {
  const nav = useNavigate();
  const [st, setSt] = createSignal<St>({ phase: "loading" });

  const scan = async () => {
    setSt({ phase: "loading" });
    try {
      // Candidates: every session cwd + every dir holding a .git under $HOME.
      // The find prunes the heavy noise dirs and gives up fast via head.
      const cwds = [...new Set(app.sessions.map((s) => s.cwd).filter((c): c is string => !!c))];
      const f = await rig.exec(
        `find "$HOME" -maxdepth 4 \\( -name node_modules -o -name .cache -o -name .npm -o -name .cargo -o -name .rustup -o -name Library \\) -prune -o -type d -name .git -print 2>/dev/null | head -80`,
        "",
        () => {},
        25000
      );
      const found = String(f.out || "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("/"))
        .map((l) => l.replace(/\/\.git\/?$/, ""));
      const candidates = [...new Set([...cwds, ...found])].slice(0, 60);
      const rows = await Promise.all(
        candidates.map(async (c): Promise<RepoRow | null> => {
          const s: any = await rig.gitStatus({ cwd: c }).catch(() => null);
          if (!s || s.ok !== true) return null;
          const porcelain = String(s.status || s.text || "").trim();
          const dirty = Array.isArray(s.files)
            ? s.files.length
            : porcelain
              ? porcelain.split("\n").filter(Boolean).length
              : 0;
          return { path: c, name: basename(c), branch: s.branch || undefined, dirty };
        })
      );
      setSt({ phase: "ready", repos: rows.filter((r): r is RepoRow => !!r) });
    } catch (e) {
      setSt({ phase: "error", message: e instanceof Error ? e.message : "scan failed" });
    }
  };

  onMount(() => {
    // deferred a tick — mirrors the mobile probe() pattern
    const t = setTimeout(scan, 0);
    return () => clearTimeout(t);
  });

  return (
    <div class="cv reposview">
      <div class="cv__bar">
        <span class="cv__title">Repos</span>
        <button class="circle-btn" title="Rescan" onClick={scan}>
          <I.restart size={15} />
        </button>
      </div>
      <p class="cv__note">
        Git repos on the rig — session working folders plus a <b>find</b> scan of ~, up to 4 levels deep.
        Tap one to browse it.
      </p>

      <Show
        when={st().phase === "ready"}
        fallback={
          <Show
            when={st().phase === "error"}
            fallback={
              <div class="cv__center">
                <span class="spinner" />
                <span>Finding repos on the rig…</span>
              </div>
            }
          >
            <div class="cv__statecard">
              <I.warning size={20} />
              <h3>Scan failed</h3>
              <p>{(st() as any).message}</p>
            </div>
          </Show>
        }
      >
        <div class="cv__list">
          <For
            each={(st() as { phase: "ready"; repos: RepoRow[] }).repos}
            fallback={
              <div class="cv__center">
                <I.git size={26} />
                <span>No git repos found</span>
                <span class="cv__emptysub">
                  Session working folders and ~ are scanned. Clone something on the rig, then rescan.
                </span>
              </div>
            }
          >
            {(r) => (
              <button class="cv__row" onClick={() => nav(`/files?path=${encodeURIComponent(r.path)}`)}>
                <I.git size={16} />
                <span class="cv__rowname">
                  {r.name}
                  <span class="cv__rowsub">{tilde(r.path)}</span>
                </span>
                <Show when={r.dirty > 0}>
                  <span class="cv__meta">{r.dirty} change{r.dirty === 1 ? "" : "s"}</span>
                </Show>
                <span class="pill pill--outline">
                  <I.branch size={11} />
                  {r.branch || "detached"}
                </span>
                <span class="cv__chev">
                  <I.chevR size={13} />
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
