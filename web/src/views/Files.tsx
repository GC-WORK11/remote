// Files — the rig's real filesystem, browsed from the web.
// Port of mobile/src/app/code/folders.tsx: breadcrumb, dirs first,
// hidden files hidden, inline new-folder/file, right-click rename/delete
// via exec `mv`/`rm`. Lives at #/files?path=/abs/dir.
import { createSignal, createMemo, createEffect, onMount, Show, For } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { rig, Frame, tilde } from "../lib/rig";
import { app } from "../lib/store";
import I from "../components/Icon";
import "./codeviews.css";

type Entry = { path: string; size?: number; dir?: boolean };

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const join = (p: string, name: string) => `${p.replace(/\/+$/, "")}/${name}`;
const parent = (p: string) => p.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
const shq = (s: string) => `"${s.replace(/(["`$\\])/g, "\\$1")}"`;

function fmtSize(b?: number) {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

const CODEISH = /\.(tsx?|jsx?|mjs|cjs|py|rs|go|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|bash|zsh|fish|lua|zig|css|scss|html|vue|svelte|json|ya?ml|toml|md|sql|graphql|proto|rs)$/i;
const IMGISH = /\.(png|jpe?g|gif|webp|svg|avif|heic|bmp)$/i;
function fileIcon(name: string) {
  if (IMGISH.test(name)) return I.image;
  if (CODEISH.test(name)) return I.terminal;
  return I.file;
}

export default function Files() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const path = () => String((params as any).path || "");
  const [home, setHome] = createSignal("");
  const [dirs, setDirs] = createSignal<Entry[]>([]);
  const [files, setFiles] = createSignal<Entry[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal<"folder" | "file" | null>(null);
  const [newName, setNewName] = createSignal("");
  const [menu, setMenu] = createSignal<{ x: number; y: number; e: Entry } | null>(null);
  const [renaming, setRenaming] = createSignal<Entry | null>(null);
  const [renameTo, setRenameTo] = createSignal("");

  const load = async (p: string) => {
    if (!p) return;
    setBusy(true);
    setErr(null);
    setMenu(null);
    try {
      const r = await rig.fsList(p, 15000);
      // matches come back relative to cwd — absolutize for the rows.
      const abs = (e: Frame) =>
        String(e.path || "").startsWith("/") ? e : { ...e, path: join(p, String(e.path || "")) };
      const toEntry = (e: Frame): Entry => {
        const a = abs(e);
        return { path: String(a.path || ""), size: a.size, dir: !!a.dir };
      };
      const visible = (e: Entry) => !basename(e.path).startsWith(".");
      setDirs(r.dirs.map(toEntry).filter(visible));
      setFiles(r.files.map(toEntry).filter(visible));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't read this folder");
    } finally {
      setBusy(false);
    }
  };

  // Default landing: active session's cwd, else $HOME (resolved on the rig).
  onMount(() => {
    rig
      .exec("echo $HOME", "", () => {}, 8000)
      .then((f) => {
        const h = String(f.out || "").trim();
        if (h.startsWith("/")) setHome(h);
        if (!path()) {
          const cwd = app.sessions.find((s) => s.id === app.activeId())?.cwd;
          nav(`/files?path=${encodeURIComponent(cwd || h || "/")}`, { replace: true });
        }
      })
      .catch(() => {
        if (!path()) nav(`/files?path=${encodeURIComponent("/")}`, { replace: true });
      });
  });

  // The ?path= param is the source of truth — crumbs/back/forward all reload it.
  createEffect(() => {
    const p = path();
    if (p) load(p);
  });

  const crumbs = createMemo(() => {
    const p = path();
    if (!p) return [] as { label: string; path: string }[];
    const out: { label: string; path: string }[] = [];
    let acc = "";
    for (const part of p.split("/").filter(Boolean)) {
      acc += `/${part}`;
      out.push({ label: acc === home() ? "Home" : part, path: acc });
    }
    return out;
  });

  const go = (p: string) => nav(`/files?path=${encodeURIComponent(p)}`);
  const openFile = (e: Entry) =>
    nav(`/file?path=${encodeURIComponent(e.path)}&dir=${encodeURIComponent(parent(e.path))}`);

  const createEntry = async () => {
    const name = newName().trim();
    if (!name || !creating()) return;
    const target = join(path(), name);
    setBusy(true);
    try {
      if (creating() === "folder") await rig.fsMkdir(target);
      else await rig.fsWrite(target, "");
      setNewName("");
      const wasFile = creating() === "file";
      setCreating(null);
      await load(path());
      if (wasFile) openFile({ path: target });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(false);
    }
  };

  const doRename = async () => {
    const e = renaming();
    const name = renameTo().trim();
    if (!e || !name || name === basename(e.path)) {
      setRenaming(null);
      return;
    }
    try {
      const r = await rig.exec(`mv ${shq(e.path)} ${shq(join(parent(e.path), name))}`, path(), () => {}, 15000);
      if ((r as any).code !== 0) throw new Error(String(r.out || "rename failed").trim());
      setRenaming(null);
      await load(path());
      app.showToast(`Renamed to ${name}`);
    } catch (e2) {
      app.showToast(e2 instanceof Error ? e2.message : "Rename failed");
    }
  };

  const doDelete = async (e: Entry) => {
    if (!window.confirm(`Delete ${basename(e.path)}${e.dir ? " and everything inside it" : ""}?\nThis runs rm -rf on the rig.`))
      return;
    try {
      const r = await rig.exec(`rm -rf ${shq(e.path)}`, path(), () => {}, 20000);
      if ((r as any).code !== 0) throw new Error(String(r.out || "delete failed").trim());
      await load(path());
      app.showToast(`Deleted ${basename(e.path)}`);
    } catch (e2) {
      app.showToast(e2 instanceof Error ? e2.message : "Delete failed");
    }
  };

  const onRowMenu = (ev: MouseEvent, e: Entry) => {
    ev.preventDefault();
    setMenu({ x: Math.min(ev.clientX, innerWidth - 190), y: Math.min(ev.clientY, innerHeight - 160), e });
  };

  return (
    <div class="cv filesview">
      <div class="cv__bar">
        <span class="cv__title">Files</span>
        <button
          class="circle-btn"
          title="New folder / file"
          onClick={() => {
            setCreating(creating() ? null : "folder");
            setNewName("");
            setRenaming(null);
          }}
        >
          <I.plus size={16} />
        </button>
      </div>

      <div class="cv__crumbs">
        <button
          class="cv__crumb"
          title="Up one folder"
          disabled={!path() || path() === "/"}
          onClick={() => go(parent(path()))}
        >
          <I.arrowUp size={13} />
        </button>
        <For each={crumbs()}>
          {(c, i) => (
            <>
              <Show when={i() > 0}>
                <span class="cv__crumbsep">
                  <I.chevR size={11} />
                </span>
              </Show>
              <button
                class={`cv__crumb ${i() === crumbs().length - 1 ? "cv__crumb--on" : ""}`}
                onClick={() => go(c.path)}
              >
                {c.label}
              </button>
            </>
          )}
        </For>
      </div>

      <Show when={creating()}>
        <div class="cv__newrow">
          <div class="cv__seg">
            <button class={creating() === "folder" ? "cv__seg--on" : ""} onClick={() => setCreating("folder")}>Folder</button>
            <button class={creating() === "file" ? "cv__seg--on" : ""} onClick={() => setCreating("file")}>File</button>
          </div>
          <input
            value={newName()}
            onInput={(e) => setNewName(e.currentTarget.value)}
            placeholder={creating() === "folder" ? "New folder name" : "new-file.txt"}
            autofocus
            autocapitalize="none"
            autocomplete="off"
            spellcheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") createEntry();
              if (e.key === "Escape") setCreating(null);
            }}
          />
          <button class="cv__iconbtn" onClick={createEntry} disabled={!newName().trim()} title="Create">
            <I.check size={16} />
          </button>
          <button class="cv__iconbtn" onClick={() => setCreating(null)} title="Cancel">
            <I.x size={14} />
          </button>
        </div>
      </Show>

      <Show when={renaming()}>
        <div class="cv__newrow">
          <I.pencil size={14} />
          <input
            value={renameTo()}
            onInput={(e) => setRenameTo(e.currentTarget.value)}
            autofocus
            autocapitalize="none"
            autocomplete="off"
            spellcheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") doRename();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
          <button class="cv__iconbtn" onClick={doRename} disabled={!renameTo().trim()} title="Rename">
            <I.check size={16} />
          </button>
          <button class="cv__iconbtn" onClick={() => setRenaming(null)} title="Cancel">
            <I.x size={14} />
          </button>
        </div>
      </Show>

      <Show when={err()}>
        <p class="cv__err">{err()}</p>
      </Show>

      <div class="cv__list">
        <Show when={busy() && !dirs().length && !files().length}>
          <div class="cv__center" style={{ padding: "40px 0" }}>
            <span class="spinner" />
          </div>
        </Show>
        <For each={dirs()}>
          {(d) => (
            <button class="cv__row" onClick={() => go(d.path)} onContextMenu={(ev) => onRowMenu(ev, d)}>
              <I.folder size={18} />
              <span class="cv__rowname">{basename(d.path)}</span>
              <span class="cv__chev">
                <I.chevR size={13} />
              </span>
            </button>
          )}
        </For>
        <For each={files()}>
          {(f) => (
            <button class="cv__row" onClick={() => openFile(f)} onContextMenu={(ev) => onRowMenu(ev, f)}>
              {fileIcon(basename(f.path))({ size: 16 })}
              <span class="cv__rowname cv__rowname--file">{basename(f.path)}</span>
              <span class="cv__meta">{fmtSize(f.size)}</span>
            </button>
          )}
        </For>
        <Show when={!busy() && !dirs().length && !files().length && path()}>
          <p class="cv__note" style={{ "text-align": "center", padding: "20px 0" }}>Empty folder</p>
        </Show>
      </div>

      <div class="cv__foot">
        <div class="cv__pathpill">
          <I.folder size={14} />
          <span>{path() ? tilde(path()) : "…"}</span>
        </div>
      </div>

      <Show when={menu()}>
        {(m) => (
          <>
            <div class="cv__overlay" onClick={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()} />
            <div class="cv__menu" style={{ left: `${m().x}px`, top: `${m().y}px` }}>
              <button
                onClick={() => {
                  const e = m().e;
                  setMenu(null);
                  if (e.dir) go(e.path);
                  else openFile(e);
                }}
              >
                {m().e.dir ? <I.folderOpen size={14} /> : <I.file size={14} />} Open
              </button>
              <button
                onClick={() => {
                  setMenu(null);
                  setCreating(null);
                  setRenaming(m().e);
                  setRenameTo(basename(m().e.path));
                }}
              >
                <I.pencil size={14} /> Rename
              </button>
              <button
                class="cv__menu--bad"
                onClick={() => {
                  const e = m().e;
                  setMenu(null);
                  doDelete(e);
                }}
              >
                <I.trash size={14} /> Delete
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
