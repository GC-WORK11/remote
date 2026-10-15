// FileView — read/edit a real file on the rig (rig.fsRead / rig.fsWrite).
// Port of mobile/src/app/code/fileview.tsx: mono view with line numbers,
// pencil → textarea, Save → fsWrite (atomic on the daemon), blob download.
// Route: #/file?path=/abs/file&dir=/abs/dir
import { createSignal, createMemo, createEffect, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { rig, tilde } from "../lib/rig";
import { app } from "../lib/store";
import I from "../components/Icon";
import "./codeviews.css";

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const dirname = (p: string) => p.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";

export default function FileView() {
  const [params] = useSearchParams();
  const path = () => String((params as any).path || "");
  const name = () => basename(path() || "file");
  const dir = () => String((params as any).dir || dirname(path()));
  const [text, setText] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [pulling, setPulling] = createSignal(false);

  createEffect(() => {
    const p = path();
    if (!p) return;
    setText(null);
    setErr(null);
    setEditing(false);
    rig
      .fsRead(p) // 200KB cap is the daemon default; truncated flag tells us
      .then((f: any) => {
        if (f.ok === false) setErr(String(f.error || "read failed"));
        else if (typeof f.content === "string")
          setText(f.truncated ? `${f.content}\n\n— truncated —` : f.content);
        else if (typeof f.contentBase64 === "string") setErr("binary file — download it instead of previewing");
        else setErr("empty");
      })
      .catch((e: any) => setErr(e instanceof Error ? e.message : "read failed"));
  });

  const gutter = createMemo(() => {
    const t = text();
    if (t === null) return "";
    const n = t.split("\n").length;
    let s = "";
    for (let i = 1; i <= n; i++) s += `${i}\n`;
    return s;
  });

  const save = async () => {
    if (saving()) return;
    setSaving(true);
    try {
      const f: any = await rig.fsWrite(path(), draft());
      if (f.ok === false) throw new Error(String(f.error || "write failed"));
      setText(draft());
      setEditing(false);
      app.showToast("Saved");
    } catch (e) {
      app.showToast(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  // Pull the file (up to 48MB, base64 for binary) → browser blob download.
  const download = async () => {
    if (pulling()) return;
    setPulling(true);
    try {
      const f: any = await rig.fsRead(path(), 48 << 20);
      if (f.ok === false) throw new Error(String(f.error || "read failed"));
      if (f.truncated) throw new Error("file too large to download here");
      let blob: Blob;
      if (typeof f.contentBase64 === "string" && f.contentBase64) {
        const bin = atob(f.contentBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: "application/octet-stream" });
      } else if (typeof f.content === "string") {
        blob = new Blob([f.content], { type: "text/plain;charset=utf-8" });
      } else {
        throw new Error("no data");
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name();
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      app.showToast(e instanceof Error ? e.message : "download failed");
    } finally {
      setPulling(false);
    }
  };

  return (
    <div class="cv fileview">
      <div class="cv__bar">
        <div class="cv__title" style={{ flex: "none", "max-width": "60%" }}>
          {name()}
          <span class="cv__subtitle">{tilde(dir())}</span>
        </div>
        <span style={{ flex: 1 }} />
        <Show when={text() !== null && !editing()}>
          <button class="circle-btn" title="Edit" onClick={() => { setDraft(text() || ""); setEditing(true); }}>
            <I.pencil size={15} />
          </button>
        </Show>
        <Show when={!editing() && path()}>
          <button class="circle-btn" title="Download" onClick={download} disabled={pulling()}>
            <Show when={!pulling()} fallback={<span class="spinner" />}>
              <I.download size={15} />
            </Show>
          </button>
        </Show>
        <Show when={editing()}>
          <button class="circle-btn" title="Cancel" onClick={() => setEditing(false)}>
            <I.x size={15} />
          </button>
          <button class="circle-btn" title="Save to rig" onClick={save} disabled={saving()}>
            <Show when={!saving()} fallback={<span class="spinner" />}>
              <I.check size={16} />
            </Show>
          </button>
        </Show>
      </div>

      <Show
        when={!err()}
        fallback={<p class="cv__err" style={{ padding: "16px 18px" }}>{err()}</p>}
      >
        <Show
          when={!editing()}
          fallback={
            <div class="fileview__body">
              <textarea
                class="fileview__editor"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                autofocus
                autocapitalize="none"
                autocomplete="off"
                autocorrect="off"
                spellcheck={false}
              />
            </div>
          }
        >
          <Show
            when={text() !== null}
            fallback={
              <div class="cv__center">
                <span class="spinner" />
              </div>
            }
          >
            <div class="fileview__body">
              <div class="fileview__scroll">
                <pre class="fileview__gutter">{gutter()}</pre>
                <pre class="fileview__text">{text()}</pre>
              </div>
            </div>
          </Show>
        </Show>
      </Show>

      <p class="fileview__hint">
        Lives on the rig — <a href={`#/files?path=${encodeURIComponent(dir())}`}>open the folder</a>
        {" · "}
        <a href="#/terminal">open a terminal</a>
      </p>
    </div>
  );
}
