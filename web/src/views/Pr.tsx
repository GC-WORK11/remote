// Pr — pull-request view. Port of mobile/src/app/pr.tsx: rig.pr.info for live
// PR truth (`gh` on the rig), rig.pr.checks polled while open, files/shots from
// the session's harvested meta.pr evidence, and rig.pr.merge for the merge row.
// URL comes from ?url=, else the active session's meta.pr.url, else a paste box.
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { rig, Frame, tilde } from "../lib/rig";
import { app, sessionTitle } from "../lib/store";
import { Markdown } from "../components/Markdown";
import I from "../components/Icon";
import "./pr.css";

type CheckState = "waiting" | "passed" | "failed";
type Check = { label: string; state: CheckState };

// Handles every wire shape: pr.checks buckets, prInfo's statusCheckRollup
// (state/conclusion/status), and meta.pr.checks ({label,state} already normed).
const normCheck = (c: any): Check => {
  const b = String(c?.bucket || "").toLowerCase(),
    st = String(c?.state ?? c?.conclusion ?? c?.status ?? "").toLowerCase();
  const state: CheckState =
    b === "pass" || /success|pass|ok/.test(st) ? "passed"
    : b === "fail" || /fail|error|cancel|timed/.test(st) ? "failed" : "waiting";
  return { label: String(c?.name || c?.context || c?.workflow || c?.label || "check"), state };
};
const rollUp = (cs: Check[]): CheckState =>
  cs.some((c) => c.state === "failed") ? "failed"
  : cs.length > 0 && cs.every((c) => c.state === "passed") ? "passed"
  : "waiting";
const dcls = (l: string) =>
  l.startsWith("+") && !l.startsWith("++") ? "d-add"
  : l.startsWith("-") && !l.startsWith("--") ? "d-del"
  : l.startsWith("@@") ? "d-hunk"
  : /^(diff |index |Binary |new file|deleted )/.test(l) ? "d-dim"
  : "";

// Archived observe frame → walkthrough thumb (computer.shot_file on demand).
function ShotThumb(props: { name: string }) {
  const [img] = createResource(
    () => props.name,
    async (n) => {
      const f = await rig.fetchShot(n).catch(() => null);
      return f && typeof f.imageBase64 === "string"
        ? `data:image/${f.format === "png" ? "png" : "jpeg"};base64,${f.imageBase64}`
        : null;
    }
  );
  return (
    <a class="prview__shot" href={img() || undefined} download={props.name} title={props.name}>
      {img() ? <img src={img()!} alt={props.name} /> : <span class="spinner" />}
    </a>
  );
}

// One file row; expands to the worktree diff for that path (rig.git.diff).
function FileRow(props: { path: string; cwd?: string; sid?: string }) {
  const rel = () =>
    props.cwd && props.path.startsWith(props.cwd)
      ? props.path.slice(props.cwd.length).replace(/^\//, "")
      : props.path;
  const leaf = () => rel().split("/").pop() || rel();
  const scope = () => (props.sid ? { sessionId: props.sid } : props.cwd ? { cwd: props.cwd } : null);
  const [open, setOpen] = createSignal(false);
  const [diff, setDiff] = createSignal<{ loading?: boolean; text?: string; err?: string } | null>(null);
  const toggle = async () => {
    const sc = scope();
    if (!sc) return;
    setOpen(!open());
    if (!open() || diff()) return;
    setDiff({ loading: true });
    try {
      const f = await rig.gitDiff(sc, rel());
      setDiff(f.ok === false
        ? { err: String(f.error || "diff unavailable") }
        : { text: String(f.diff || f.stat || "").trim() || "No diff reported for this path" });
    } catch (e) {
      setDiff({ err: (e instanceof Error ? e.message : "diff unavailable").slice(0, 120) });
    }
  };
  return (
    <div>
      <button class="prview__file" onClick={toggle} disabled={!scope()} title={props.path}>
        <I.file size={14} />
        <span class="prview__fmeta">
          <span class="prview__fname">{leaf()}</span>
          <Show when={rel().length > leaf().length}>
            <span class="prview__fdir">{rel().slice(0, rel().length - leaf().length)}</span>
          </Show>
        </span>
        <Show when={scope()}>
          <I.chevR size={13} class={`prview__chev ${open() ? "prview__chev--open" : ""}`} />
        </Show>
      </button>
      <Show when={open()}>
        <div class={`prview__diff ${diff()?.text ? "" : "prview__diff--empty"}`}>
          {diff()?.loading ? (
            <span class="spinner" />
          ) : diff()?.text ? (
            <For each={diff()!.text!.split("\n")}>{(l) => <div class={dcls(l)}>{l || " "}</div>}</For>
          ) : (
            diff()?.err || "…"
          )}
        </div>
      </Show>
    </div>
  );
}

export default function Pr() {
  const [params, setParams] = useSearchParams<{ url?: string; sid?: string; title?: string; branch?: string }>();
  const sid = () => String(params.sid || app.activeId() || "");
  const session = createMemo(() => app.sessions.find((s) => s.id === sid() || s.sessionId === sid()));
  const metaPr = createMemo(() => (sid() ? app.meta[sid()]?.pr : undefined));
  const url = createMemo(() => String(params.url || metaPr()?.url || ""));
  const repoGuess = createMemo(() =>
    String(params.branch || "") ||
    String(session()?.cwd || "").replace(/\/+$/, "").split("/").slice(-2).join("/"));

  // Live PR truth via rig.pr.info (the rig's `gh pr view --json …`).
  const [info, { refetch }] = createResource(
    () => (url() && app.conn() === "connected" ? url() : null),
    (u) =>
      rig.prInfo(u).catch((e: any) =>
        ({ type: "rig.pr.result", ok: false, error: String(e?.message || e) }) as Frame)
  );
  const prErr = createMemo(() => {
    const f = info();
    return f && (f.ok === false || (f.ok === undefined && f.error))
      ? String(f.error || "gh unavailable on the rig") : "";
  });
  const live = createMemo(() => (info() && !prErr() ? info()! : null));

  // Fresher truth: rig.pr.checks (`gh pr checks --json`), polled while mounted.
  const [ci, setCi] = createSignal<Check[]>([]);
  createEffect(() => {
    const u = url();
    if (!u || app.conn() !== "connected") return;
    let dead = false;
    const pull = () =>
      rig.prChecks(u)
        .then((r) => { if (!dead && r.ok && Array.isArray(r.checks)) setCi(r.checks.map(normCheck)); })
        .catch(() => {});
    pull();
    const t = setInterval(pull, 30000);
    onCleanup(() => { dead = true; clearInterval(t); });
  });

  const checks = createMemo<Check[]>(() => {
    if (ci().length) return ci();
    const roll = live()?.statusCheckRollup;
    if (Array.isArray(roll) && roll.length) return roll.map(normCheck);
    return (metaPr()?.checks || []).map(normCheck);
  });
  const checkState = () => rollUp(checks());
  const prState = () => (live()?.isDraft ? "DRAFT" : String(live()?.state || "OPEN").toUpperCase());
  const title = () =>
    String(live()?.title || params.title || (session() ? sessionTitle(session()) : "Pull request"));
  const head = () => String(live()?.headRefName || repoGuess() || "head");
  const base = () => String(live()?.baseRefName || "main");
  const author = () => String(live()?.author?.login || live()?.author?.name || "");
  const adds = () => (typeof live()?.additions === "number" ? live()!.additions : null);
  const dels = () => (typeof live()?.deletions === "number" ? live()!.deletions : null);
  const body = () => String(live()?.body || "");
  const files = createMemo<string[]>(() => {
    const lf = live()?.files;
    if (Array.isArray(lf) && lf.length) return lf.map((f: any) => String(f?.path || f)).filter(Boolean);
    return (metaPr()?.files || []).map(String);
  });
  const shots = () => (metaPr()?.shots || []) as string[];
  const host = createMemo(() => {
    try { return url() ? new URL(url()).host : ""; } catch { return ""; }
  });
  const stateLabel = () =>
    prState() === "OPEN" ? "Open" : prState().charAt(0) + prState().slice(1).toLowerCase();

  // Merge — real `gh pr merge` on the rig via rig.pr.merge.
  const [merging, setMerging] = createSignal(false);
  const [delBranch, setDelBranch] = createSignal(true);
  const [note, setNote] = createSignal("");
  const mergeBlocked = () =>
    merging() || prState() === "DRAFT" || (checks().length > 0 && checkState() === "waiting");
  const merge = async (method: "squash" | "merge" | "rebase") => {
    if (mergeBlocked() || !url()) return;
    setMerging(true);
    setNote("Merging…");
    try {
      const f = await rig.prMerge(url(), method, delBranch());
      if (f.ok === false) throw new Error(String(f.error || "merge failed"));
      setNote(`Merged (${method})`);
      app.showToast(`Merged (${method})`);
      refetch();
    } catch (e) {
      const m = (e instanceof Error ? e.message : "merge failed").slice(0, 120);
      setNote(m);
      app.showToast(m.slice(0, 80));
    } finally { setMerging(false); }
  };

  // No URL — paste one, or create a PR in the active session's repo.
  const [paste, setPaste] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const openPaste = () => {
    const u = paste().trim();
    if (!/^https?:\/\/\S+/.test(u)) return app.showToast("Paste a full PR URL — https://…/pull/N");
    setParams({ url: u });
  };
  const [gst] = createResource(
    () => (!url() && session()?.cwd ? session()!.id || session()!.cwd : null),
    async () => {
      const s = session()!;
      return rig.gitStatus(s.id ? { sessionId: s.id } : { cwd: s.cwd }).catch(() => null);
    });
  const createPr = async () => {
    const s = session();
    if (!s?.cwd || creating()) return;
    setCreating(true);
    try {
      const r = await rig.prCreate({ cwd: s.cwd, fill: true });
      const u = r.url || r.data?.url;
      if (!u) throw new Error(String(r.error || "gh pr create failed"));
      app.patchMeta(s.id || sid(), { pr: { ...(metaPr() || {}), url: u, at: Date.now() } });
      setParams({ url: u });
      app.showToast("Pull request created");
    } catch (e) {
      app.showToast((e instanceof Error ? e.message : "PR create failed").slice(0, 100));
    } finally { setCreating(false); }
  };

  return (
    <div class="prview">
      <Show when={url()} fallback={
        <div class="prview__empty">
          <div class="prview__emptycard">
            <div class="prview__emptyicon"><I.pr size={24} /></div>
            <h1>Pull request</h1>
            <p>Paste a PR link, or create one from the active session's repo.</p>
            <input value={paste()} onInput={(e) => setPaste(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && openPaste()}
              placeholder="https://github.com/owner/repo/pull/123" spellcheck={false} />
            <button class="btn-primary" onClick={openPaste} disabled={!paste().trim()}>Open PR</button>
            <Show when={session()?.cwd}>
              <div class="prview__gitline">
                <I.git size={13} />
                <Show when={gst()?.ok} fallback={<span>{tilde(session()!.cwd)}</span>}>
                  <span>on {gst()!.branch || "?"} ·{" "}
                    {gst()!.clean ? "clean" : `${(gst()!.files || []).length} uncommitted`}</span>
                </Show>
              </div>
              <button class="btn-secondary" onClick={createPr} disabled={creating()}>
                {creating() ? "Creating…" : "Create PR with --fill"}
              </button>
            </Show>
          </div>
        </div>
      }>
        <div class="prview__scroll">
          <div class="prview__inner">
            {/* header — title, state pill, head→base, author */}
            <div class="prview__card">
              <h1 class="prview__title"><I.pr size={19} /><span>{title()}</span></h1>
              <div class="prview__meta">
                <span class={`prview__state prview__state--${prState().toLowerCase()}`}>{stateLabel()}</span>
                <Show when={adds() != null || dels() != null}>
                  <span class="diffpill diffpill--add">+{adds() ?? 0}</span>
                  <span class="diffpill diffpill--del">−{dels() ?? 0}</span>
                </Show>
                <Show when={host()}>
                  <a class="prview__host" href={url()} target="_blank" rel="noreferrer">{host()}</a>
                </Show>
              </div>
              <div class="prview__branches">
                <I.git size={14} /><b>{head()}</b><span>→</span><b>{base()}</b>
                <Show when={author()}><span class="prview__author">by {author()}</span></Show>
              </div>
              <Show when={String(live()?.mergeable || "") === "CONFLICTING"}>
                <div class="prview__warn"><I.warning size={14} />
                  This branch has conflicts that must be resolved first</div>
              </Show>
              <Show when={body()}>
                <div class="prview__body"><Markdown text={body()} /></div>
              </Show>
            </div>

            {/* checks — rollup ring + per-check dots */}
            <div class="prview__card">
              <div class="prview__checkshead">
                <div class={`prview__ring prview__ring--${checkState()}`}>
                  {checkState() === "waiting" ? <span class="prview__spin" />
                   : checkState() === "passed" ? <I.check size={20} /> : <I.x size={20} />}
                </div>
                <div>
                  <div class="prview__sum">
                    {checkState() === "waiting" ? "Waiting for checks"
                     : checkState() === "passed" ? "Checks passed" : "Checks failed"}
                  </div>
                  <div class="prview__sub">
                    {checks().length
                      ? `${checks().filter((c) => c.state === "passed").length}/${checks().length} passed`
                      : prErr() ? prErr().slice(0, 120)
                      : "Live check status is not reported by the rig yet"}
                  </div>
                </div>
              </div>
              <Show when={checks().length}>
                <div class="prview__checklist">
                  <For each={checks()}>{(c) => (
                    <div class="prview__check">
                      {c.state === "waiting" ? <span class="prview__spin" />
                        : <span class={`prview__cdot prview__cdot--${c.state === "passed" ? "pass" : "fail"}`} />}
                      <span>{c.label}</span>
                    </div>
                  )}</For>
                </div>
              </Show>
            </div>

            {/* files changed — expandable to a dark diff block */}
            <div class="prview__sect">Files changed{files().length ? ` · ${files().length}` : ""}</div>
            <Show when={files().length} fallback={
              <div class="prview__card"><div class="prview__sub">
                Changed files are not reported by the rig yet</div></div>
            }>
              <div class="prview__card prview__files">
                <For each={files()}>{(f) => <FileRow path={f} cwd={session()?.cwd} sid={session()?.id} />}</For>
              </div>
            </Show>

            {/* walkthrough shots the agent took */}
            <Show when={shots().length}>
              <div class="prview__sect">Walkthrough</div>
              <div class="prview__shots">
                <For each={shots()}>{(s) => <ShotThumb name={s} />}</For>
              </div>
            </Show>

            {/* merge actions */}
            <Show when={prState() === "OPEN" || prState() === "DRAFT"} fallback={
              <div class="prview__card"><div class="prview__sub">
                This pull request is {stateLabel().toLowerCase()}.</div></div>
            }>
              <div class="prview__card prview__merge">
                <div class="prview__sum">Merge pull request</div>
                <label class="prview__del">
                  <input type="checkbox" checked={delBranch()}
                    onChange={(e) => setDelBranch(e.currentTarget.checked)} />
                  Delete the branch after merge
                </label>
                <div class="prview__mergebtns">
                  <For each={["squash", "merge", "rebase"] as const}>{(m) => (
                    <button class={m === "squash" ? "btn-primary" : "btn-secondary"}
                      disabled={mergeBlocked()} onClick={() => merge(m)}>
                      {merging() ? "Merging…" : m === "squash" ? "Squash & merge" : m === "merge" ? "Merge" : "Rebase"}
                    </button>
                  )}</For>
                </div>
                <div class="prview__note">
                  {note() || (prState() === "DRAFT" ? "Draft — mark the PR ready on the host first"
                    : mergeBlocked() ? "Merge unlocks when the reported checks finish" : "")}
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
