#!/usr/bin/env python3
"""A tiny MCP server (stdio, JSON-RPC 2.0, newline-delimited) used by the tests and for trying the MCP support by hand.
Tools: add(a, b) and echo(text)."""
import json
import sys

TOOLS = [
    {"name": "add", "description": "Add two whole numbers and return the sum.",
     "inputSchema": {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}}, "required": ["a", "b"]}},
    {"name": "echo", "description": "Return the text it is given.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
]


def reply(rid, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": rid}
    msg.update({"error": error} if error else {"result": result})
    print(json.dumps(msg), flush=True)


for line in sys.stdin:
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    method, rid = msg.get("method"), msg.get("id")
    if method == "initialize":
        reply(rid, {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "demo", "version": "1"}})
    elif method == "tools/list":
        reply(rid, {"tools": TOOLS})
    elif method == "tools/call":
        name, args = msg["params"]["name"], msg["params"].get("arguments", {})
        if name == "add":
            reply(rid, {"content": [{"type": "text", "text": str(args["a"] + args["b"])}]})
        elif name == "echo":
            reply(rid, {"content": [{"type": "text", "text": args["text"]}]})
        else:
            reply(rid, {"content": [{"type": "text", "text": f"no such tool {name}"}], "isError": True})
    elif rid is not None:
        reply(rid, error={"code": -32601, "message": f"unknown method {method}"})
