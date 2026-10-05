#!/usr/bin/env python3
"""Deterministic openai-completions endpoint for testing the omp/rig loop.

Speaks the SSE streaming shape omp's openai-completions provider expects.
Instead of a canned plan it DERIVES a plan from the latest user message:
"open Notes and type HELLO" → [launch Notes, type HELLO, observe]. Lets us
verify the whole wire — model → tool call → omprd computer op → tool result
→ next call → final text — with no quota, driven by real prompts.
"""
import json
import os
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8420
DELAY = float(os.environ.get("FAKE_DELAY", "0"))

calls = 0
lock = threading.Lock()

# Known macOS app names → matched against the prompt (word boundary).
APPS = [
    "TextEdit", "Notes", "Safari", "Chrome", "Finder", "Calculator",
    "Terminal", "Calendar", "Reminders", "Mail", "Maps", "Music",
    "Photos", "Preview", "Keynote", "Pages", "Numbers", "Stickies",
    "Activity Monitor", "System Settings", "Messages", "FaceTime",
]


def sse_chunk(obj):
    return f"data: {json.dumps(obj)}\n\n".encode()


def make_chunk(cid, model, delta, finish=None):
    return {
        "id": cid,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _last_user_text(messages):
    text = ""
    for m in reversed(messages):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            text = c
        elif isinstance(c, list):
            text = " ".join(
                p.get("text", "") for p in c if isinstance(p, dict)
            )
        break
    return text


def _last_user_index(messages):
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            return i
    return -1


def _gui_plan(prompt):
    """rig_computer ops for open-app / type / observe intents."""
    ops = []
    notes = []
    app = None
    for a in APPS:
        if re.search(r"\b" + re.escape(a) + r"\b", prompt, re.I):
            app = a
            break
    if app:
        ops.append({"op": "launch", "app": app})
        notes.append(f"launch {app}")
        # browsers: 'go to X' / 'download X' / 'search X' → omnibox drive.
        # nav verb must come after the app name so "open Chrome" isn't a target.
        if app in ("Safari", "Chrome"):
            # find the app mention position case-insensitively, keep original case after it
            am = re.search(re.escape(app), prompt, re.I)
            tail = prompt[am.end() :] if am else prompt
            nm = re.search(
                r"(?:go to|open|visit|navigate(?: to)?|download|search(?: for)?|get)\s+['\"]?([^'\",]{2,120}?)['\"]?$",
                tail.strip(),
                re.I,
            )
            if nm:
                target = nm.group(1).strip()
                if re.search(r"download|get", prompt, re.I) and "." not in target.split()[-1]:
                    target += " download"
                ops.append({"op": "key", "combo": "cmd+l"})
                ops.append({"op": "type", "text": target})
                ops.append({"op": "key", "combo": "Return"})
                ops.append({"op": "observe", "scale": 0.5})
                notes.append(f"navigate '{target[:40]}'")
        # doc-based apps need a document before text lands anywhere —
        # empty Notes has no field, TextEdit may show a file picker
        doc_app = app in ("Notes", "TextEdit", "Pages", "Keynote", "Numbers",
                          "Stickies", "Reminders")
        wants_text = re.search(r"type", prompt, re.I)
        wants_new = re.search(r"new (doc|document|note|file|window)", prompt, re.I)
        if doc_app and (wants_text or wants_new):
            ops.append({"op": "key", "combo": "cmd+n"})
            notes.append("new doc (cmd+n)")

    # "type 'X'" / 'type "X"' / "type X" — prefer quoted text
    text = None
    m = re.search(r"type\s+['\"]([^'\"]+)['\"]", prompt, re.I)
    if not m:
        m = re.search(r"[\"“]([^\"”]{2,120})[\"”]", prompt)
    if m:
        text = m.group(1)
    else:
        m = re.search(r"type\s+(.{2,120})$", prompt.strip(), re.I)
        if m:
            text = m.group(1).strip()
    if text:
        ops.append({"op": "type", "text": text})
        notes.append(f"type '{text[:40]}'")

    if re.search(r"screenshot|observe|look|see the screen", prompt, re.I):
        ops.append({"op": "observe", "scale": 0.5})
        notes.append("observe")
    return ops, notes


def plan_for(prompt):
    """Turn a natural-language prompt into tool-call steps.

    Returns [(tool_name, args, note)] — coding tools (write/bash/read)
    for code-mode intents, rig_computer ops for GUI intents.
    """
    steps = []

    fm = re.search(
        r"(?:create|write|make)\s+(?:a\s+)?(?:new\s+)?file\s+([^\s:'\",]+)",
        prompt,
        re.I,
    )
    if fm:
        path = fm.group(1).strip()
        cm = re.search(r"(?:with|containing|contents?)\s+['\"]([^'\"]+)['\"]", prompt, re.I)
        if not cm:
            cm = re.search(r"(?:with|containing)\s+(?:content\s+)?(.+)$", prompt, re.I)
        content = cm.group(1).strip() + "\n" if cm else "# created from the phone\n"
        steps.append(("write", {"path": path, "content": content}, f"write {path}"))

    bm = re.search(
        r"(?:run|execute|shell:?|command:?|and\s+then\s+run)\s+[`'\"]([^`'\"]+)[`'\"]",
        prompt,
        re.I,
    )
    if bm:
        steps.append(("bash", {"command": bm.group(1).strip()}, f"bash: {bm.group(1)[:50]}"))

    # don't match read/cat inside the bash command itself
    scan = prompt[: bm.start()] + prompt[bm.end() :] if bm else prompt
    rm = re.search(r"(?:read|cat|show)\s+(?:file\s+)?(/[^\s'\"]+)", scan, re.I)
    if rm:
        steps.append(("read", {"path": rm.group(1).strip()}, f"read {rm.group(1)}"))

    if not steps:
        ops, notes = _gui_plan(prompt)
        if not ops:
            ops.append({"op": "observe", "scale": 0.5})
            notes.append("observe")
        for i, op in enumerate(ops):
            steps.append(("rig_computer", op, notes[i] if i < len(notes) else notes[-1]))
    return steps


def _tool_text(msg):
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(
            p.get("text", "") for p in c if isinstance(p, dict)
        )
    return ""


def _prose_reply(plan, tool_msgs):
    """Natural-language summary of what the plan did — like a real model."""
    writes = [a["path"] for t, a, _ in plan if t == "write"]
    bashes = [a["command"] for t, a, _ in plan if t == "bash"]
    reads = [a["path"] for t, a, _ in plan if t == "read"]
    ops = [a.get("op") for t, a, _ in plan if t == "rig_computer"]
    app = next(
        (a.get("app") for t, a, _ in plan if t == "rig_computer" and a.get("op") == "launch"),
        None,
    )
    typed = next(
        (a.get("text") for t, a, _ in plan if t == "rig_computer" and a.get("op") == "type"),
        None,
    )
    parts = []
    if writes:
        parts.append("created " + ", ".join(f"`{p}`" for p in writes))
    if reads:
        s = "read " + ", ".join(f"`{p}`" for p in reads)
        snippet = next((_tool_text(m) for m in tool_msgs), "")
        snippet = " ".join(snippet.split())[:140]
        if snippet:
            s += f" — it says: {snippet}"
        parts.append(s)
    if bashes:
        parts.append("ran " + ", ".join(f"`{c}`" for c in bashes))
    if app:
        s = f"opened {app}"
        if typed:
            s += f" and typed '{typed}'"
        parts.append(s)
    elif typed:
        parts.append(f"typed '{typed}'")
    if "observe" in ops:
        if not parts:
            return "Here's what's on screen right now."
        parts.append("took a screenshot")
    if not parts:
        return "Done."
    return "Done — " + ", ".join(parts) + "."


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send_sse(self, chunks):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        for c in chunks:
            if DELAY:
                time.sleep(DELAY)
            self.wfile.write(sse_chunk(c))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_POST(self):
        global calls
        if not self.path.startswith("/v1/chat/completions"):
            self.send_response(404)
            self.end_headers()
            return
        ln = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(ln) or b"{}")
        messages = body.get("messages", [])
        model = body.get("model", "stub-model")
        cid = "chatcmpl-" + uuid.uuid4().hex[:12]
        with lock:
            calls += 1

        ui = _last_user_index(messages)
        plan = plan_for(_last_user_text(messages))
        # tool results belonging to THIS plan turn (after last user msg)
        done = sum(
            1 for m in messages[ui + 1 :] if m.get("role") == "tool"
        )

        chunks = []
        if done < len(plan):
            tool, args, _note = plan[done]
            chunks.append(
                make_chunk(
                    cid,
                    model,
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": f"call_{done}_{uuid.uuid4().hex[:8]}",
                                "type": "function",
                                "function": {
                                    "name": tool,
                                    "arguments": json.dumps(args),
                                },
                            }
                        ],
                    },
                )
            )
            chunks.append(make_chunk(cid, model, {}, finish="tool_calls"))
        else:
            chunks.append(
                make_chunk(
                    cid,
                    model,
                    {
                        "role": "assistant",
                        "content": _prose_reply(plan, messages[ui + 1 :]),
                    },
                )
            )
            chunks.append(make_chunk(cid, model, {}, finish="stop"))
        chunks.append(
            {
                "id": cid,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            }
        )
        self._send_sse(chunks)


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"fake-model on 127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
