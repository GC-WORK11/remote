#!/usr/bin/env python3
"""
fake-claude.py — protocol-shaped stand-in for
`claude --print --output-format stream-json --input-format stream-json`
used by omprd's multi-harness path tests. Emits system.init on startup,
then for each stdin `user` message replies with the real claude event
sequence: stream_event deltas → assistant (text + optional tool_use) →
user(tool_result) → result.

SCENARIO:tool in the prompt text selects the tool-call turn shape;
SCENARIO:fail emits an error result.
"""

import json
import os
import sys
import time
import uuid

CONV_ID = os.environ.get("FAKE_CONV_ID", "deadbeef-conv-1")
MODEL = os.environ.get("FAKE_MODEL", "claude-sonnet-4-5")
SLEEP_MS = int(os.environ.get("FAKE_SLEEP_MS", "0"))


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except OSError:
        os._exit(0)


def delta(text):
    emit({"type": "stream_event",
          "event": {"type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": text}}})


def result(ok, session_id, usage=None):
    d = {"type": "result",
         "subtype": "success" if ok else "error",
         "is_error": not ok,
         "session_id": session_id,
         "result": "turn finished" if ok else "model exploded",
         "total_cost_usd": 0.0012,
         "usage": usage or {"input_tokens": 512, "output_tokens": 128}}
    emit(d)


def main():
    emit({"type": "system", "subtype": "init",
          "session_id": CONV_ID, "model": MODEL,
          "tools": ["Bash", "Read", "Edit"]})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            j = json.loads(line)
        except Exception:
            continue
        if j.get("type") != "user":
            continue
        msg = j.get("message") or {}
        content = msg.get("content") or []
        text = "".join(b.get("text", "") for b in content
                       if isinstance(b, dict) and b.get("type") == "text")

        if "SCENARIO:fail" in text:
            result(False, CONV_ID)
            continue

        reply = f"RIG-CLAUDE-OK {text[:60]}"
        for chunk in (reply[: len(reply) // 2], reply[len(reply) // 2:]):
            delta(chunk)
            if SLEEP_MS:
                time.sleep(SLEEP_MS / 1000.0)

        blocks = [{"type": "text", "text": reply}]
        if "SCENARIO:tool" in text:
            call_id = "toolu_" + uuid.uuid4().hex[:8]
            blocks.append({"type": "tool_use", "id": call_id,
                           "name": "Bash", "input": {"command": "ls -la"}})
            emit({"type": "assistant", "message": {"role": "assistant",
                                                   "content": blocks}})
            emit({"type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": call_id,
                 "content": [{"type": "text",
                              "text": "total 8\ndrwxr-xr-x 2 devin staff 64"}]}]}})
        else:
            emit({"type": "assistant", "message": {"role": "assistant",
                                                   "content": blocks}})

        result(True, CONV_ID)


if __name__ == "__main__":
    main()
