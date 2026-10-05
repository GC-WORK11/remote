#!/usr/bin/env python3
"""
fake-omp.py — Windows port of fake-omp.sh: protocol-shaped stand-in for
`omp --mode rpc` used for load tests. Speaks just enough ndjson-RPC to
satisfy omprd: answers the handshake, then on any `prompt` frame emits
FAKE_N (default 200) message_delta frames and a prompt_result. Everything
else gets a generic success response that echoes the request's "id" —
required so omprd-correlated requests (daemon-issued get_state/compact)
route privately instead of leaking into the broadcast.

FAKE_N env sets the burst size; FAKE_SLEEP_MS adds a delay between frames.
SCENARIO:<name> markers in the prompt text select scripted turn shapes —
see fake-omp.sh for the scenario catalog.
"""

import json
import os
import re
import sys
import time

N = int(os.environ.get("FAKE_N", "200"))
SLEEP_MS = int(os.environ.get("FAKE_SLEEP_MS", "0"))

ID_RE = re.compile(r'"id"\s*:\s*"([^"]*)"')


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except OSError:
        # parent killed the pipe mid-turn — die quietly
        os._exit(0)


def prompt_result(rid):
    d = {"type": "prompt_result", "status": "ok", "sessionSettled": True,
         "usage": {"input_tokens": 123, "output_tokens": 45}}
    if rid:
        d = dict(d, id=rid)
    emit(d)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        m = ID_RE.search(line)
        rid = m.group(1) if m else None

        if "negotiate_protocol" in line:
            emit({"id": "omprd-handshake", "type": "response",
                  "command": "negotiate_protocol", "success": True,
                  "data": {"protocolVersion": 2}})
        elif '"prompt"' in line:
            if "SCENARIO:busy" in line:
                emit({"type": "agent_start"})
                time.sleep(0.6)
                emit({"type": "message_delta", "seq": 1, "delta": "busy-tok"})
                time.sleep(0.3)
                prompt_result(rid)
            elif "SCENARIO:retry" in line:
                emit({"type": "agent_start"})
                emit({"type": "auto_retry_start", "attempt": 1,
                      "errorMessage": "rate limit"})
                emit({"type": "auto_retry_end", "success": True})
                time.sleep(0.8)
                emit({"type": "message_delta", "seq": 1,
                      "delta": "resumed-after-retry"})
                prompt_result(rid)
            elif "SCENARIO:agentend" in line:
                emit({"type": "agent_start"})
                emit({"type": "message_delta", "seq": 1, "delta": "pre-end"})
                time.sleep(0.4)
                emit({"type": "agent_end"})
            else:
                for i in range(1, N + 1):
                    emit({"type": "message_delta", "seq": i,
                          "delta": f"tok-{i} lorem ipsum dolor sit amet consectetur"})
                    if SLEEP_MS > 0:
                        time.sleep(SLEEP_MS / 1000.0)
                prompt_result(rid)
        elif "get_state" in line:
            d = {"type": "response", "command": "get_state", "success": True,
                 "data": {"contextUsage": {"tokens": 1234, "contextWindow": 128000,
                                           "percent": 1.0}}}
            if rid:
                d = dict(d, id=rid)
            emit(d)
        else:
            d = {"type": "response", "success": True, "data": {}}
            if rid:
                d = dict(d, id=rid)
            emit(d)


if __name__ == "__main__":
    main()
