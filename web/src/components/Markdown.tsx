// Markdown — marked + DOMPurify, streaming-safe (re-parses on text change).
import { createMemo } from "solid-js";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true, gfm: true });

const ALLOWED_URI = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

export function Markdown(props: { text: string; class?: string }) {
  const html = createMemo(() => {
    let raw = "";
    try {
      raw = marked.parse(props.text || "", { async: false }) as string;
    } catch {
      raw = `<p>${(props.text || "").replace(/</g, "&lt;")}</p>`;
    }
    return DOMPurify.sanitize(raw, {
      ALLOWED_URI_REGEXP: ALLOWED_URI,
      ADD_ATTR: ["target"],
    });
  });
  return <div class={`md ${props.class || ""}`} innerHTML={html()} />;
}
