// RowView — renders every transcript row kind.
import { For, Show, createSignal, createResource, onCleanup } from "solid-js";
import { Row, fmtMs } from "../lib/chat";
import { rig } from "../lib/rig";
import { app } from "../lib/store";
import { Markdown } from "./Markdown";
import I from "./Icon";

function img64(f: any): string | null {
  if (!f || typeof f.imageBase64 !== "string") return null;
  return `data:image/${f.format === "png" ? "png" : "jpeg"};base64,${f.imageBase64}`;
}

function ShotCard(props: { row: Row }) {
  const [img] = createResource(
    () => props.row.shot,
    async (name) => {
      const f = await rig.fetchShot(name).catch(() => null);
      return img64(f);
    }
  );
  return (
    <div class="row-in row-agent row-gap--sm">
      <button class="shotcard" onClick={() => app.setScreenPanel(true)} title={props.row.shotCaption}>
        <Show when={img()} fallback={<div class="shotcard__ph">loading…</div>}>
          <img src={img()!} alt={props.row.shotCaption || "screenshot"} />
        </Show>
        <span class="shotcard__cap">{props.row.shotCaption || "Screenshot"}</span>
      </button>
    </div>
  );
}

function TermCard(props: { row: Row }) {
  const [open, setOpen] = createSignal(false);
  const t = () => props.row.term!;
  const preview = () => {
    const lines = (t().out || "").trim().split("\n");
    return open() ? t().out : lines.slice(0, 8).join("\n") + (lines.length > 8 ? `\n… ${lines.length - 8} more` : "");
  };
  return (
    <div class="row-in row-agent row-gap--sm termcard-wrap">
      <div class={`termcard ${t().failed ? "termcard--failed" : ""}`}>
        <div class="termcard__head">
          <span class="termcard__cmd" title={t().cmd}>
            $ {t().cmd}
          </span>
          <Show when={t().ms != null}>
            <span class="termcard__ms">{fmtMs(t().ms!)}</span>
          </Show>
        </div>
        <Show when={t().out.trim()}>
          <pre class="termcard__out" onClick={() => setOpen(!open())} title="click to expand">
            {preview()}
          </pre>
        </Show>
      </div>
    </div>
  );
}

function FileCard(props: { row: Row }) {
  const f = () => props.row.file!;
  const path = () => `${f().dir ? f().dir + "/" : ""}${f().name}`;
  const open = () => {
    const dir = f().dir || "";
    location.hash = `#/file?path=${encodeURIComponent(path())}&dir=${encodeURIComponent(dir)}`;
  };
  return (
    <div class="row-in row-agent row-gap--sm">
      <button class={`filecard ${f().failed ? "filecard--failed" : ""}`} onClick={open}>
        <I.file size={16} />
        <span class="filecard__name">{f().name}</span>
        <Show when={f().dir}>
          <span class="filecard__dir">{f().dir}</span>
        </Show>
        <Show when={f().adds != null}>
          <span class="diffpill diffpill--add">+{f().adds}</span>
          <span class="diffpill diffpill--del">−{f().dels}</span>
        </Show>
        <Show when={f().bytes != null && f().adds == null}>
          <span class="filecard__meta">
            {f().bytes! > 1024 ? `${(f().bytes! / 1024).toFixed(1)} KB` : `${f().bytes} B`}
          </span>
        </Show>
      </button>
    </div>
  );
}

function DeliverCard(props: { row: Row }) {
  const [busy, setBusy] = createSignal(false);
  const d = () => props.row.deliver!;
  const download = async () => {
    setBusy(true);
    try {
      const r = await rig.fsRead(d().path, 32 * 1024 * 1024);
      const b64 = r.dataBase64 || r.contentBase64 || r.data;
      const bytes = Uint8Array.from(atob(String(b64).replace(/\s/g, "")), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes]));
      const a = document.createElement("a");
      a.href = url;
      a.download = d().name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) {
      app.showToast(e?.message || "Download failed");
    }
    setBusy(false);
  };
  return (
    <div class="row-in row-agent row-gap--sm">
      <button class="filecard filecard--deliver" onClick={download} disabled={busy()}>
        <I.download size={16} />
        <span class="filecard__name">{d().name}</span>
        <Show when={d().size != null}>
          <span class="filecard__meta">
            {d().size! > 1048576 ? `${(d().size! / 1048576).toFixed(1)} MB` : `${Math.round(d().size! / 1024)} KB`}
          </span>
        </Show>
        <span class="filecard__meta">{busy() ? "downloading…" : "Save"}</span>
      </button>
    </div>
  );
}

function SubCard(props: { row: Row }) {
  const s = () => props.row.sub!;
  const running = () => /running|waiting/i.test(s().status);
  const open = () => {
    const sid = s().key;
    if (sid && app.sessions.some((x) => x.id === sid)) location.hash = `#/thread/${sid}`;
    else app.setSpawnParent(props.row.sub?.key || null);
  };
  return (
    <div class="row-in row-agent row-gap--sm">
      <button class={`subcard ${running() ? "subcard--live" : ""}`} onClick={open}>
        <span class="subcard__badge">{running() ? <span class="mini-dots"><i /><i /><i /></span> : <I.users size={15} />}</span>
        <span class="subcard__body">
          <span class="subcard__desc">{s().desc}</span>
          <span class="subcard__meta">
            {s().agent ? `${s().agent} · ` : ""}
            {s().status}
          </span>
        </span>
      </button>
    </div>
  );
}

function ApprovalCard(props: { row: Row; respond: (id: string, ok: boolean) => void }) {
  const a = () => props.row.approval!;
  return (
    <div class="row-in row-agent row-gap--sm">
      <div class={`approve ${a().state === "done" ? "approve--done" : ""}`}>
        <div class="approve__title">
          <I.shield size={15} /> {a().title}
        </div>
        <Show when={a().preview}>
          <pre class="approve__preview">{a().preview}</pre>
        </Show>
        <Show
          when={a().state !== "done"}
          fallback={
            <div class="approve__resolved">
              <Show when={a().resolved !== "secondary"} fallback={<I.x size={11} />}>
                <I.check size={11} />
              </Show>
              {a().doneLabel || (a().resolved === "primary" ? "Approved" : "Denied")}
            </div>
          }
        >
          <div class="approve__btns">
            <button class="btn-secondary" onClick={() => props.respond(a().reqId || "", false)}>
              Deny
            </button>
            <button class="btn-primary" onClick={() => props.respond(a().reqId || "", true)}>
              Approve
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

function CheckRow(props: { row: Row }) {
  const [open, setOpen] = createSignal(!!props.row.streaming);
  const items = () => props.row.items || [];
  return (
    <div class="row-in row-agent row-gap--sm">
      <div class={`checkcard ${props.row.streaming ? "checkcard--live" : ""}`}>
        <button class="checkcard__head" onClick={() => setOpen(!open())}>
          <Show when={props.row.streaming} fallback={<span class="minicheck"><I.check size={9} /></span>}>
            <span class="mini-dots"><i /><i /><i /></span>
          </Show>
          <Show when={props.row.streaming} fallback={<span class="checkcard__doneword">Done</span>}>
            <span class="workingrow__shimmer">Working</span>
          </Show>
          <span style={{ flex: 1 }} />
          <span class="checkcard__count">{items().length} action{items().length === 1 ? "" : "s"}</span>
          <Show when={!props.row.streaming}>
            <span class={`checkcard__chev ${open() ? "checkcard__chev--open" : ""}`}>
              <I.chevD size={12} />
            </span>
          </Show>
        </button>
        <Show when={open()}>
          <ul class="checkcard__list">
            <For each={items()}>
              {(it) => (
                <li class={`checkcard__item ${it.done ? "is-done" : ""} ${it.failed ? "is-failed" : ""}`}>
                  <span class="checkcard__glyph">
                    {(() => {
                      const g = { term: "terminal", file: "file", search: "search", computer: "screen", net: "globe", sub: "users", git: "branch", check: "list" }[String(it.cls || "")] || "settings";
                      const Cmp = (I as any)[g] || I.settings;
                      return <Cmp size={11} />;
                    })()}
                  </span>
                  <span class="checkcard__tick">
                    <Show when={it.failed} fallback={
                      <Show when={!it.done} fallback={<I.check size={11} />}>
                        <span class="mini-dots"><i /><i /><i /></span>
                      </Show>
                    }>
                      <I.x size={11} />
                    </Show>
                  </span>
                  <span class="checkcard__label">{it.label}</span>
                  <Show when={it.ms != null}>
                    <span class="checkcard__ms">{fmtMs(it.ms!)}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}

function ImageStrip(props: { images: string[] }) {
  return (
    <div class="imgstrip">
      <For each={props.images}>{(src) => <img src={src} alt="attachment" />}</For>
    </div>
  );
}

const side = (r?: Row) => (!r ? "" : r.kind === "sep" ? "sep" : r.kind === "user" ? "user" : "agent");

export function RowView(props: {
  row: Row;
  prev?: Row;
  next?: Row;
  respond: (id: string, ok: boolean) => void;
}) {
  const r = () => props.row;
  // run grouping: 4px inside a sender run, 16px across senders
  const gapCls = () => {
    const p = side(props.prev);
    const s = side(r());
    if (!p || p === "sep") return "row-gap--lg";
    return p === s ? "row-gap--sm" : "row-gap--lg";
  };
  const tail = () => side(props.next) !== side(r()) || props.next?.kind === "sep";
  return (
    <>
      <Show when={r().kind === "sep"}>
        <div class="sep" style={{ "grid-column": "1 / -1" }}>
          <span>{r().text}</span>
        </div>
      </Show>
      <Show when={r().kind === "user"}>
        <div class={`row-in row-user ${gapCls()}`}>
          <div class={`bubble bubble--user ${tail() ? "bubble--tail" : ""}`}>
            <Show when={r().images?.length}>
              <ImageStrip images={r().images!} />
            </Show>
            {r().text}
          </div>
        </div>
      </Show>
      <Show when={r().kind === "agent"}>
        <div class={`row-in row-agent ${gapCls()}`}>
          <div class={`bubble bubble--agent ${tail() ? "bubble--tail" : ""}`}>
            <Markdown text={r().text || ""} />
          </div>
        </div>
      </Show>
      <Show when={r().kind === "check"}>
        <CheckRow row={r()} />
      </Show>
      {/* prog/event rows are filtered from display — mobile thread.tsx parity */}
      <Show when={r().kind === "error"}>
        <div class="row-in row-agent row-gap--sm">
          <div class="errorcard">
            <I.warning size={14} /> {r().text}
          </div>
        </div>
      </Show>
      <Show when={r().kind === "shot"}>
        <ShotCard row={r()} />
      </Show>
      <Show when={r().kind === "term"}>
        <TermCard row={r()} />
      </Show>
      <Show when={r().kind === "file"}>
        <FileCard row={r()} />
      </Show>
      <Show when={r().kind === "deliver"}>
        <DeliverCard row={r()} />
      </Show>
      <Show when={r().kind === "sub"}>
        <SubCard row={r()} />
      </Show>
      <Show when={r().kind === "approval"}>
        <ApprovalCard row={r()} respond={props.respond} />
      </Show>
    </>
  );
}
