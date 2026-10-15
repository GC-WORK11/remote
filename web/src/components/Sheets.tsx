// Sheets — all overlay surfaces: session menu, model picker, new-bot,
// auth broker, routines (schedules), changes (git/checkpoints), PR merge.
import { For, Show, createEffect, createResource, createSignal } from "solid-js";
import { app, sessionTitle } from "../lib/store";
import { rig, tilde } from "../lib/rig";
import { Sheet, SheetRow } from "./Sheet";
import I from "./Icon";
import { fmtMs } from "../lib/chat";

// ---------- Session sheet (per-thread actions) ----------
function SessionSheet() {
  const id = () => app.sessionSheetId();
  const s = () => app.sessions.find((x) => x.id === id());
  const close = () => app.setSessionSheetId(null);
  const [renameVal, setRenameVal] = createSignal("");
  const [renaming, setRenaming] = createSignal(false);
  createEffect(() => {
    if (id()) {
      setRenaming(false);
      setRenameVal(sessionTitle(s() || {}));
    }
  });
  const act = (f: () => void) => () => {
    f();
    close();
  };
  return (
    <Sheet open={!!id()} onClose={close} title={s() ? sessionTitle(s()) : "Session"}>
      <Show when={s()}>
        {(sess) => (
          <>
            <Show
              when={!renaming()}
              fallback={
                <div class="sheet__form">
                  <input
                    value={renameVal()}
                    onInput={(e) => setRenameVal(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && renameVal().trim()) {
                        rig.sessionRename(sess().id, renameVal().trim());
                        setRenaming(false);
                      }
                    }}
                  />
                  <button
                    class="btn-primary"
                    onClick={() => {
                      rig.sessionRename(sess().id, renameVal().trim());
                      setRenaming(false);
                    }}
                  >
                    Rename
                  </button>
                </div>
              }
            >
              <SheetRow icon={<I.pencil size={16} />} label="Rename" onClick={() => setRenaming(true)} />
            </Show>
            <SheetRow
              icon={<I.pin size={16} />}
              label={sess().pinned ? "Unpin" : "Pin to top"}
              onClick={act(() => rig.sessionMeta(sess().id, { pinned: !sess().pinned }))}
            />
            <SheetRow
              icon={<I.branch size={16} />}
              label="Changes"
              sub="git status, diffs, checkpoints"
              onClick={act(() => app.setChangesFor(sess().id))}
            />
            <SheetRow
              icon={<I.users size={16} />}
              label="Spawn a sub-agent"
              onClick={act(() => app.setSpawnParent(sess().id))}
            />
            <SheetRow
              icon={<I.brain size={16} />}
              label="Model & effort"
              onClick={act(() => app.setModelSheet(true))}
            />
            <Show when={sess().cwd}>
              <SheetRow
                icon={<I.pr size={16} />}
                label="Create pull request"
                onClick={act(async () => {
                  try {
                    const r = await rig.prCreate({ cwd: sess().cwd!, fill: true });
                    const url = r.url || r.data?.url;
                    if (url) {
                      app.patchMeta(sess().id, { pr: { ...(app.meta[sess().id]?.pr || {}), url, at: Date.now() } });
                      app.setMergeSheetUrl(url);
                    }
                  } catch (e: any) {
                    app.showToast(e?.message || "PR create failed");
                  }
                })}
              />
            </Show>
            <SheetRow
              icon={<I.restart size={16} />}
              label="Restart session"
              onClick={act(() => {
                rig.send({ type: "session.resume", sessionId: sess().id });
              })}
            />
            <SheetRow
              icon={<I.eyeOff size={16} />}
              label={sess().hidden ? "Unhide" : "Hide"}
              onClick={act(() => rig.sessionMeta(sess().id, { hidden: !sess().hidden }))}
            />
            <SheetRow
              icon={<I.trash size={16} />}
              label="Delete session"
              danger
              onClick={act(() => {
                rig.sessionDelete(sess().id);
                if (app.activeId() === sess().id) {
                  app.setActive(null);
                  location.hash = "#/home";
                }
              })}
            />
          </>
        )}
      </Show>
    </Sheet>
  );
}

// ---------- Model / effort / harness ----------
const EFFORTS = ["low", "medium", "high", "xhigh"];
const HARNESSES = [
  { id: "omp", name: "omp", desc: "the built-in agent" },
  { id: "claude", name: "claude", desc: "Claude Code CLI" },
  { id: "acp", name: "acp", desc: "ACP agent (if installed)" },
];
function ModelSheet() {
  const close = () => app.setModelSheet(false);
  const [models] = createResource(
    () => (app.modelSheet() ? app.activeId() : null),
    async (sid) => {
      if (!sid) return [];
      try {
        const [r, lp] = await Promise.all([
          rig.request(sid, { type: "get_available_models" }, 10000),
          rig.request(sid, { type: "get_login_providers" }, 10000).catch(() => null),
        ]);
        const all = r?.data?.models || [];
        const authed: string[] = (lp?.data?.providers || []).filter((p: any) => p.authenticated).map((p: any) => p.id);
        const configured: string[] = Array.isArray(app.hostInfo()?.providers) ? app.hostInfo()!.providers : [];
        const ok = new Set([...authed, ...configured]);
        return ok.size ? all.filter((m: any) => ok.has(m.provider || m.providerId)) : all;
      } catch {
        return [];
      }
    }
  );
  const pick = (m: any) => {
    const provider = m.provider || m.providerId || "";
    const modelId = m.modelId || m.id || "";
    if (app.activeId()) rig.rpc(app.activeId()!, { type: "set_model", provider, modelId });
    app.setPreferredModel(provider ? `${provider}/${modelId}` : modelId || "");
    if (app.activeId()) app.patchMeta(app.activeId()!, { model: m.name || modelId });
    close();
  };
  return (
    <Sheet open={app.modelSheet()} onClose={close} title="Model, effort, harness">
      <div class="sheet__sect">Reasoning effort</div>
      <div class="chipsrow">
        <For each={EFFORTS}>
          {(e) => (
            <button
              class={`chip ${app.preferredEffort() === e ? "chip--on" : ""}`}
              onClick={() => {
                app.setPreferredEffort(e);
                if (app.activeId() && rig.connected) rig.rpc(app.activeId()!, { type: "set_thinking_level", level: e });
              }}
            >
              {e}
            </button>
          )}
        </For>
      </div>
      <div class="sheet__sect">Harness</div>
      <div class="chipsrow">
        <For each={HARNESSES}>
          {(h) => (
            <button
              class={`chip ${app.preferredHarness() === h.id ? "chip--on" : ""}`}
              title={h.desc}
              onClick={() => app.setPreferredHarness(h.id)}
            >
              {h.name}
            </button>
          )}
        </For>
      </div>
      <div class="sheet__sect">Models</div>
      <Show when={!models.loading} fallback={<div class="sheet__loading"><span class="spinner" /></div>}>
        <div class="modellist">
          <For each={models()} fallback={<p class="sheet__empty">Open a thread to list its models.</p>}>
            {(m: any) => (
              <button class="sheet-row" onClick={() => pick(m)}>
                <span class="sheet-row__body">
                  <span class="sheet-row__label">{m.name || m.modelId || m.id}</span>
                  <span class="sheet-row__sub">{m.provider || m.providerId}</span>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </Sheet>
  );
}

// ---------- New agent ----------
function NewSheet() {
  const close = () => app.setNewSheet(false);
  const [cwd, setCwd] = createSignal("");
  const [recentDirs, setRecentDirs] = createSignal<string[]>([]);
  createEffect(async () => {
    if (!app.newSheet()) return;
    try {
      const r = await rig.fsList("~", 8000).catch(() => null);
      if (r) setRecentDirs(r.dirs.slice(0, 8).map((d) => d.path).filter(Boolean));
    } catch {}
    const saved = localStorage.getItem("recentDirs");
    if (saved) setRecentDirs((p) => [...new Set([...JSON.parse(saved), ...p])].slice(0, 10));
  });
  const start = (dir?: string) => {
    const f: any = { type: "session.new" };
    if (dir) f.cwd = dir;
    if (app.preferredModel()) f.model = app.preferredModel();
    if (app.preferredEffort()) f.thinking = app.preferredEffort();
    if (app.preferredHarness() !== "omp") f.harness = app.preferredHarness();
    if (dir) {
      app.setMode("code");
      const rec = [dir, ...recentDirs().filter((x) => x !== dir)].slice(0, 10);
      localStorage.setItem("recentDirs", JSON.stringify(rec));
    } else app.setMode("cowork");
    const off = rig.onFrame((fr) => {
      if (fr.type === "session.started" && fr.sessionId) {
        off();
        app.setActive(fr.sessionId);
        location.hash = `#/thread/${fr.sessionId}`;
      }
    });
    setTimeout(off, 30000);
    rig.send(f);
    close();
  };
  return (
    <Sheet open={app.newSheet()} onClose={close} title="New agent">
      <SheetRow
        icon={<I.sparkles size={16} />}
        label="On the computer"
        sub="watches and drives the rig's screen"
        onClick={() => start()}
      />
      <div class="sheet__sect">In a folder</div>
      <div class="sheet__form">
        <input
          value={cwd()}
          onInput={(e) => setCwd(e.currentTarget.value)}
          placeholder="~/code/project"
          spellcheck={false}
          onKeyDown={(e) => e.key === "Enter" && cwd().trim() && start(cwd().trim())}
        />
        <button class="btn-secondary" onClick={() => start(cwd().trim())} disabled={!cwd().trim()}>
          Start
        </button>
      </div>
      <Show when={recentDirs().length}>
        <div class="sheet__sect">Recent</div>
        <For each={recentDirs()}>
          {(d) => (
            <SheetRow icon={<I.folder size={15} />} label={tilde(d)} onClick={() => start(d)} />
          )}
        </For>
      </Show>
    </Sheet>
  );
}

// ---------- Auth broker ----------
function AuthSheet() {
  const close = () => app.setAuthSheet(false);
  const [keyFor, setKeyFor] = createSignal<string | null>(null);
  const [keyVal, setKeyVal] = createSignal("");
  return (
    <Sheet open={app.authSheet()} onClose={close} title="Accounts on the rig">
      <Show when={app.authLive()}>
        <div class="authlive">
          <span class="mini-dots"><i /><i /><i /></span> Signing in to {app.authLive()}…
          <For each={app.authEvents()}>
            {(e) => (
              <div class="authlive__line">
                {e.url ? (
                  <button class="linkbtn" onClick={() => rig.hostOpen(e.url)}>
                    Open sign-in page
                  </button>
                ) : (
                  <span>{String(e.message || e.detail || e.kind || "")}</span>
                )}
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={keyFor()}>
        {(p) => (
          <div class="sheet__form">
            <input
              type="password"
              value={keyVal()}
              onInput={(e) => setKeyVal(e.currentTarget.value)}
              placeholder={`${p()} API key`}
            />
            <button
              class="btn-primary"
              onClick={() => {
                rig.authLogin(p(), keyVal());
                setKeyFor(null);
                setKeyVal("");
              }}
            >
              Save
            </button>
          </div>
        )}
      </Show>
      <For each={app.authProviders()}>
        {(p: any) => (
          <SheetRow
            icon={<I.shield size={15} />}
            label={p.name || p.id}
            sub={p.authenticated ? "connected" : p.kind || "not connected"}
            right={<span class={`pill ${p.authenticated ? "pill--ok" : "pill--outline"}`}>{p.authenticated ? "on" : "off"}</span>}
            onClick={() => {
              if (!p.authenticated) {
                if (p.flow === "key" || p.kind === "key") setKeyFor(p.id);
                else app.authStart(p.id);
              }
            }}
          />
        )}
      </For>
      <Show when={!app.authProviders().length}>
        <p class="sheet__empty">The rig hasn't reported any providers yet.</p>
      </Show>
    </Sheet>
  );
}

// ---------- Routines (schedules) ----------
function RoutinesSheet() {
  const close = () => app.setRoutinesSheet(false);
  const [jobs, { refetch }] = createResource(
    () => app.routinesSheet(),
    async () => (await rig.scheduleList().catch(() => ({ jobs: [] })))?.jobs || []
  );
  const [prompt, setPrompt] = createSignal("");
  const [every, setEvery] = createSignal("3600");
  const [cwd, setCwd] = createSignal("");
  const add = async () => {
    if (!prompt().trim()) return;
    await rig
      .scheduleAdd({ prompt: prompt().trim(), everySec: parseInt(every()) || 3600, cwd: cwd() || undefined })
      .catch((e) => app.showToast(e?.message || "failed"));
    setPrompt("");
    refetch();
  };
  return (
    <Sheet open={app.routinesSheet()} onClose={close} title="Routines">
      <div class="sheet__form">
        <input value={prompt()} onInput={(e) => setPrompt(e.currentTarget.value)} placeholder="Every so often, do…" />
        <div class="chipsrow">
          <input class="sheet__num" value={every()} onInput={(e) => setEvery(e.currentTarget.value)} inputmode="numeric" title="seconds" />
          <span class="sheet__unit">sec</span>
          <input value={cwd()} onInput={(e) => setCwd(e.currentTarget.value)} placeholder="cwd (optional)" />
          <button class="btn-primary" onClick={add} disabled={!prompt().trim()}>
            Add
          </button>
        </div>
      </div>
      <For each={jobs()} fallback={<p class="sheet__empty">No routines yet.</p>}>
        {(j: any) => (
          <SheetRow
            icon={<I.clock size={15} />}
            label={j.prompt || j.id}
            sub={`every ${fmtMs((j.everySec || 0) * 1000)}${j.cwd ? ` · ${tilde(j.cwd)}` : ""}`}
            right={
              <button
                class="circle-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  rig.scheduleRemove(j.id).then(refetch).catch(() => {});
                }}
              >
                <I.trash size={14} />
              </button>
            }
            onClick={() => rig.scheduleEnable(j.id, !j.enabled).then(refetch).catch(() => {})}
          />
        )}
      </For>
    </Sheet>
  );
}

// ---------- Changes (git + checkpoints) ----------
function ChangesSheet() {
  const id = () => app.changesFor();
  const close = () => app.setChangesFor(null);
  const cwd = () => app.sessions.find((s) => s.id === id())?.cwd;
  const [tab, setTab] = createSignal<"status" | "checkpoints">("status");
  const [status, { refetch: refetchStatus }] = createResource(
    () => (id() && tab() === "status" ? id() : null),
    async (sid) => {
      const r = await rig.gitStatus({ sessionId: sid }).catch((e) => ({ error: e?.message }));
      return r;
    }
  );
  const [cps, { refetch: refetchCps }] = createResource(
    () => (id() && tab() === "checkpoints" ? id() : null),
    async (sid) => (await rig.checkpointList(sid).catch(() => ({ checkpoints: [] })))?.checkpoints || []
  );
  return (
    <Sheet open={!!id()} onClose={close} title="Changes">
      <div class="chipsrow">
        <button class={`chip ${tab() === "status" ? "chip--on" : ""}`} onClick={() => setTab("status")}>Status</button>
        <button class={`chip ${tab() === "checkpoints" ? "chip--on" : ""}`} onClick={() => setTab("checkpoints")}>
          Checkpoints
        </button>
        <span style={{ flex: 1 }} />
        <button class="circle-btn" title="New checkpoint" onClick={() => id() && rig.checkpointCreate(id()!, "manual").then(refetchCps).catch(() => {})}>
          <I.plus size={15} />
        </button>
      </div>
      <Show when={tab() === "status"}>
        <Show when={!status.loading} fallback={<div class="sheet__loading"><span class="spinner" /></div>}>
          <Show when={status() && !status()!.error} fallback={<p class="sheet__empty">{status()?.error || "No repo here."}</p>}>
            <div class="gitstat">
              <div class="gitstat__branch"><I.branch size={14} /> {(status() as any).branch || "?"}</div>
              <pre class="gitstat__files">{(status() as any).status || (status() as any).text || "clean"}</pre>
            </div>
          </Show>
        </Show>
      </Show>
      <Show when={tab() === "checkpoints"}>
        <For each={cps()} fallback={<p class="sheet__empty">No checkpoints yet — they're taken automatically each turn.</p>}>
          {(cp: any) => (
            <SheetRow
              icon={<I.mark size={15} />}
              label={cp.label || cp.ref}
              sub={cp.at ? new Date(cp.at).toLocaleString() : ""}
              right={
                <button
                  class="btn-secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    rig.checkpointRestore(id()!, cp.ref, true).then(() => app.showToast("Restored")).catch((err) => app.showToast(err?.message || "restore failed"));
                  }}
                >
                  Restore
                </button>
              }
            />
          )}
        </For>
      </Show>
    </Sheet>
  );
}

// ---------- Spawn sub-agent ----------
function SpawnSheet() {
  const pid = () => app.spawnParent();
  const close = () => app.setSpawnParent(null);
  const [prompt, setPrompt] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const go = async () => {
    if (!pid() || busy()) return;
    setBusy(true);
    try {
      const r = await rig.sessionSpawn({ parentId: pid()!, prompt: prompt() || undefined, title: title() || undefined });
      const sid = r.sessionId || r.id;
      if (sid) {
        app.setActive(sid);
        location.hash = `#/thread/${sid}`;
      }
      close();
    } catch (e: any) {
      app.showToast(e?.message || "spawn failed");
    }
    setBusy(false);
  };
  return (
    <Sheet open={!!pid()} onClose={close} title="Spawn a sub-agent">
      <div class="sheet__form">
        <input value={title()} onInput={(e) => setTitle(e.currentTarget.value)} placeholder="Title (optional)" />
        <textarea
          value={prompt()}
          onInput={(e) => setPrompt(e.currentTarget.value)}
          placeholder="Task for the sub-agent…"
          rows={3}
        />
        <button class="btn-primary" onClick={go} disabled={busy()}>
          {busy() ? "Spawning…" : "Spawn"}
        </button>
      </div>
    </Sheet>
  );
}

// ---------- PR merge ----------
function MergeSheet() {
  const url = () => app.mergeSheetUrl();
  const close = () => app.setMergeSheetUrl(null);
  const [info] = createResource(url, async (u) => await rig.prInfo(u).catch((e) => ({ error: e?.message })));
  const [checks] = createResource(url, async (u) => await rig.prChecks(u).catch(() => ({ checks: [] })));
  const [busy, setBusy] = createSignal(false);
  const merge = async (method: "squash" | "merge" | "rebase") => {
    setBusy(true);
    try {
      await rig.prMerge(url()!, method);
      app.showToast("Merged");
      close();
    } catch (e: any) {
      app.showToast(e?.message || "merge failed");
    }
    setBusy(false);
  };
  return (
    <Sheet open={!!url()} onClose={close} title="Pull request" dark={false}>
      <Show when={!info.loading} fallback={<div class="sheet__loading"><span class="spinner" /></div>}>
        <Show when={info() && !info()!.error} fallback={<p class="sheet__empty">{info()?.error || "Couldn't load PR"}</p>}>
          <div class="prinfo">
            <div class="prinfo__title">{(info() as any).title || url()}</div>
            <div class="prinfo__meta">
              {(info() as any).state || ""} {(info() as any).headRefName ? `· ${(info() as any).headRefName} → ${(info() as any).baseRefName || "main"}` : ""}
            </div>
          </div>
          <For each={(checks()?.checks || []) as any[]}>
            {(c: any) => (
              <div class="checkrow">
                <span class={`dot dot--${c.state === "SUCCESS" ? "done" : c.state === "FAILURE" ? "crashed" : "working"}`} />
                <span>{c.name || c.context || c.label}</span>
              </div>
            )}
          </For>
          <div class="chipsrow" style={{ "margin-top": "12px" }}>
            <button class="btn-primary" disabled={busy()} onClick={() => merge("squash")}>Squash & merge</button>
            <button class="btn-secondary" disabled={busy()} onClick={() => merge("merge")}>Merge</button>
            <button class="btn-secondary" disabled={busy()} onClick={() => merge("rebase")}>Rebase</button>
          </div>
        </Show>
      </Show>
    </Sheet>
  );
}

export function Sheets() {
  return (
    <>
      <SessionSheet />
      <ModelSheet />
      <NewSheet />
      <AuthSheet />
      <RoutinesSheet />
      <ChangesSheet />
      <SpawnSheet />
      <MergeSheet />
    </>
  );
}
