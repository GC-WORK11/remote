// Composer — chat input: autosize textarea, attach, mic (Web Speech),
// send/stop morph, model + effort + harness chips, "/" commands, "@" files.
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { app } from "../lib/store";
import { rig } from "../lib/rig";
import { ChatEngine } from "../lib/chat";
import I from "./Icon";

export interface Attachment {
  kind: "image" | "file";
  uri?: string; // object URL for images
  name: string;
  mimeType?: string;
  data?: string; // base64
  text?: string;
}

const SLASH = [
  { cmd: "/screen", hint: "See the rig's screen" },
  { cmd: "/record start", hint: "Start recording the screen" },
  { cmd: "/record stop", hint: "Stop recording" },
  { cmd: "/checkpoint", hint: "Snapshot the working tree" },
  { cmd: "/compact", hint: "Compact context" },
  { cmd: "/pause", hint: "Pause scheduled routines" },
  { cmd: "/resume", hint: "Resume routines" },
  { cmd: "/pr", hint: "Open the PR panel" },
];

export function Composer(props: {
  engine?: ChatEngine; // undefined → new-session composer (inbox)
  cwd?: string;
  onSent?: (sessionId: string | null) => void;
  placeholder?: string;
}) {
  const [input, setInput] = createSignal("");
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [listening, setListening] = createSignal(false);
  const [showSlash, setShowSlash] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let ta: HTMLTextAreaElement | undefined;
  let rec: any = null;
  let fileInput: HTMLInputElement | undefined;
  let imgInput: HTMLInputElement | undefined;

  const streaming = () => !!props.engine?.streaming();
  const slashItems = () => SLASH.filter((s) => s.cmd.startsWith(input().split(" ")[0] || "/"));

  const autosize = () => {
    if (!ta) return;
    ta.style.height = "0";
    ta.style.height = Math.min(160, ta.scrollHeight) + "px";
  };

  const doSend = async () => {
    const text = input().trim();
    const atts = attachments();
    if ((!text && !atts.length) || streaming() || busy()) return;

    // slash commands handled locally
    if (text.startsWith("/") && !text.includes(" ")) {
      const c = text;
      if (c === "/screen") {
        app.setScreenPanel(true);
        setInput("");
        return;
      }
      if (c === "/pr") {
        app.setSessionSheetId(app.activeId());
        setInput("");
        return;
      }
    }
    if (text === "/record start" || text === "/record stop") {
      rig.recordStart(text.endsWith("start") ? {} : {}).catch(() => {});
      if (text.endsWith("stop")) rig.recordStop().catch(() => {});
      setInput("");
      return;
    }
    if (text === "/compact" && props.engine) {
      rig.rpc(props.engine.sessionId, { type: "compact" });
      setInput("");
      return;
    }
    if (text === "/checkpoint" && props.engine) {
      rig.checkpointCreate(props.engine.sessionId).catch(() => {});
      setInput("");
      return;
    }

    setBusy(true);
    try {
      const files = atts.filter((a) => a.kind === "file");
      const images = atts
        .filter((a) => a.kind === "image" && a.data)
        .map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType || "image/jpeg" }));
      let message = text;
      if (files.length) {
        const bundled = files.map((f) => `[Attached: ${f.name}]\n${(f.text || "").slice(0, 40000)}`).join("\n\n");
        message = `${message || "See attached."}\n\n${bundled}`;
      }
      if (props.engine) {
        props.engine.send(message, images.length ? images : undefined);
        props.onSent?.(props.engine.sessionId);
      } else {
        // new session — daemon creates + we adopt via session.started
        const f: any = { type: "session.new" };
        if (props.cwd) f.cwd = props.cwd;
        if (app.preferredModel()) f.model = app.preferredModel();
        if (app.preferredEffort()) f.thinking = app.preferredEffort();
        if (app.preferredHarness() && app.preferredHarness() !== "omp") f.harness = app.preferredHarness();
        // first prompt piggybacks via session.new? omp protocol: send prompt
        // right after session.started. Arm a waiter.
        const msg = message;
        const imgs = images.length ? images : undefined;
        const off = rig.onFrame((fr) => {
          if (fr.type === "session.started" && fr.sessionId) {
            off();
            const sid = fr.sessionId;
            app.setActive(sid);
            rig.prompt(sid, msg, imgs);
            props.onSent?.(sid);
            location.hash = `#/thread/${sid}`;
          }
        });
        setTimeout(off, 30000);
        rig.send(f);
      }
      setInput("");
      setAttachments([]);
      autosize();
    } finally {
      setBusy(false);
    }
  };

  const stop = () => props.engine?.stop();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
    if (e.key === "Escape") setShowSlash(false);
  };

  const onPaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        e.preventDefault();
        const f = it.getAsFile();
        if (f) await addImageFile(f);
      }
    }
  };

  const addImageFile = async (f: File) => {
    const data = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] || "");
      r.readAsDataURL(f);
    });
    setAttachments((p) => [
      ...p,
      { kind: "image", uri: URL.createObjectURL(f), name: f.name || "image.png", mimeType: f.type || "image/png", data },
    ]);
  };
  const addTextFile = async (f: File) => {
    const text = f.size < 200_000 ? await f.text() : "";
    setAttachments((p) => [...p, { kind: "file", name: f.name, mimeType: f.type, text }]);
  };

  const toggleMic = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      app.showToast("Speech input isn't supported in this browser");
      return;
    }
    if (listening()) {
      rec?.stop();
      setListening(false);
      return;
    }
    rec = new SR();
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e: any) => {
      let s = "";
      for (const r of e.results) s += r[0].transcript;
      setInput(s);
      autosize();
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start();
    setListening(true);
  };
  onCleanup(() => rec?.abort?.());

  onMount(() => {
    ta?.focus();
  });

  return (
    <div class="composer">
      <Show when={attachments().length}>
        <div class="composer__atts">
          <For each={attachments()}>
            {(a, i) => (
              <span class="attachchip">
                <Show when={a.kind === "image" && a.uri} fallback={<I.file size={13} />}>
                  <img src={a.uri} alt="" />
                </Show>
                <span>{a.name}</span>
                <button onClick={() => setAttachments((p) => p.filter((_, j) => j !== i()))}>
                  <I.x size={11} />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={showSlash() && input().startsWith("/")}>
        <div class="slashmenu">
          <For each={slashItems()}>
            {(s) => (
              <button
                class="slashmenu__item"
                onClick={() => {
                  setInput(s.cmd);
                  setShowSlash(false);
                  doSend();
                }}
              >
                <span class="slashmenu__cmd">{s.cmd}</span>
                <span class="slashmenu__hint">{s.hint}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="composer__box">
        <button class="composer__iconbtn" title="Attach" onClick={() => fileInput?.click()}>
          <I.plus size={18} />
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          onChange={(e) => {
            for (const f of Array.from(e.currentTarget.files || []))
              f.type.startsWith("image/") ? addImageFile(f) : addTextFile(f);
            e.currentTarget.value = "";
          }}
        />
        <input
          ref={imgInput}
          type="file"
          accept="image/*"
          hidden
          multiple
          onChange={(e) => {
            for (const f of Array.from(e.currentTarget.files || [])) addImageFile(f);
            e.currentTarget.value = "";
          }}
        />
        <textarea
          ref={ta}
          class="composer__input"
          rows={1}
          placeholder={props.placeholder || "Message…"}
          value={input()}
          onInput={(e) => {
            setInput(e.currentTarget.value);
            setShowSlash(e.currentTarget.value.startsWith("/"));
            autosize();
          }}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
        <button
          class={`sendslot ${streaming() ? "sendslot--stop" : ""} ${listening() ? "sendslot--live" : ""}`}
          title={streaming() ? "Stop" : input().trim() || attachments().length ? "Send" : "Dictate"}
          onClick={() => (streaming() ? stop() : input().trim() || attachments().length ? doSend() : toggleMic())}
        >
          <span class="sendslot__morph">
            <Show when={streaming()} fallback={
              <Show when={input().trim() || attachments().length} fallback={<I.mic size={14} />}>
                <I.arrowUp size={16} />
              </Show>
            }>
              <I.stop size={10} />
            </Show>
          </span>
        </button>
      </div>
      <div class="composer__chips">
        <button class="chip" onClick={() => app.setModelSheet(true)} title="Model & effort">
          <I.brain size={13} />
          <span>{props.engine?.model() || app.preferredModel() || "model"}</span>
        </button>
        <span class="chip chip--static" title="Reasoning effort">
          {app.preferredEffort()}
        </span>
        <Show when={app.preferredHarness() !== "omp"}>
          <span class="chip chip--accent">{app.preferredHarness()}</span>
        </Show>
      </div>
    </div>
  );
}
