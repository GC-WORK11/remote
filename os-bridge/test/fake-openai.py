#!/usr/bin/env python3
"""Deterministic OpenAI-chat-completions stub for measuring real omp turns.

POST /v1/chat/completions:
  - request WITHOUT tool results  -> streams a tool_call for `bash echo RIG-TOOL-OK`
  - request WITH tool results     -> streams "RIG-OK" text + usage

Logs every request body's byte size + message/tool counts to stderr so the
per-turn token audit comes straight off the wire.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8377
REQ_LOG = "/tmp/fake-openai-requests.jsonl"


def sse(obj) -> bytes:
    return b"data: " + json.dumps(obj).encode() + b"\n\n"


def chunk(model, delta, finish=None, usage=None):
    c = {"id": "chatcmpl-rig", "object": "chat.completion.chunk", "created": int(time.time()),
         "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    if usage:
        c["usage"] = usage
    return c


def reply_tool_call(model, stream):
    args = json.dumps({"command": "echo RIG-TOOL-OK"})
    if not stream:
        return {"id": "chatcmpl-rig", "object": "chat.completion", "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": None,
                             "tool_calls": [{"id": "call_1", "type": "function",
                                             "function": {"name": "bash", "arguments": args}}]},
                             "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 50, "completion_tokens": 12, "total_tokens": 62}}
    out = sse(chunk(model, {"role": "assistant", "content": ""}))
    out += sse(chunk(model, {"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                            "function": {"name": "bash", "arguments": ""}}]}))
    # stream the arg string in pieces to mimic real token flow
    for i in range(0, len(args), 8):
        out += sse(chunk(model, {"tool_calls": [{"index": 0, "function": {"arguments": args[i:i + 8]}}]}))
    out += sse(chunk(model, {}, "tool_calls",
                     {"prompt_tokens": 50, "completion_tokens": 12, "total_tokens": 62}))
    out += b"data: [DONE]\n\n"
    return out


def reply_text(model, stream, text="RIG-OK"):
    words = text.split(" ")
    if not stream:
        return {"id": "chatcmpl-rig", "object": "chat.completion", "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 60, "completion_tokens": 3, "total_tokens": 63}}
    out = sse(chunk(model, {"role": "assistant", "content": ""}))
    for w in words:
        out += sse(chunk(model, {"content": w + " "}))
    out += sse(chunk(model, {}, "stop",
                     {"prompt_tokens": 60, "completion_tokens": 3, "total_tokens": 63}))
    out += b"data: [DONE]\n\n"
    return out


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        rec = {"t": time.time(), "path": self.path, "bytes": len(body)}
        try:
            req = json.loads(body)
            rec["model"] = req.get("model")
            rec["stream"] = req.get("stream")
            rec["n_messages"] = len(req.get("messages", []))
            rec["n_tools"] = len(req.get("tools", []))
            rec["tools_bytes"] = len(json.dumps(req.get("tools", [])))
            rec["sys_bytes"] = sum(len(json.dumps(m)) for m in req.get("messages", [])
                                   if m.get("role") == "system")
            rec["has_tool_result"] = any(
                m.get("role") == "tool" or
                (isinstance(m.get("content"), list) and
                 any(p.get("type") == "tool_result" for p in m["content"]))
                for m in req.get("messages", []))
        except Exception:
            req = {}
        with open(REQ_LOG, "a") as f:
            f.write(json.dumps(rec) + "\n")

        if self.path.rstrip("/").endswith("chat/completions"):
            model = req.get("model", "stub-model")
            stream = bool(req.get("stream"))
            if rec.get("has_tool_result"):
                payload = reply_text(model, stream)
            else:
                payload = reply_tool_call(model, stream)
            if stream:
                data = payload if isinstance(payload, bytes) else sse(chunk(model, {"content": str(payload)}))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(data)
            else:
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        elif "models" in self.path:
            data = json.dumps({"object": "list", "data": [{"id": "stub-model", "object": "model"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(404)
            self.end_headers()

    do_GET = do_POST


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
