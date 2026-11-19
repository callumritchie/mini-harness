"""MCP servers, in Claude Code's .mcp.json format. Stdio servers only. Their tools appear as mcp__<server>__<tool>; the agent
sends every call through the permission gate before it gets here."""
import json
import os
import queue
import re
import subprocess
import threading
from pathlib import Path

import safety
import tools

PROTOCOL_VERSION = "2025-03-26"
STARTUP_SECONDS = 20
CALL_SECONDS = 60


class McpError(Exception):
    pass


def _clean(text):
    return re.sub(r"[^a-zA-Z0-9_-]", "_", text)


def expand_env(value):
    """${VAR} and ${VAR:-default}, as Claude Code does in .mcp.json."""
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}", lambda m: os.environ.get(m.group(1), m.group(2) or ""), value)


class Client:
    """One stdio server: newline-delimited JSON-RPC 2.0."""

    def __init__(self, command, args, env, cwd):
        self.proc = subprocess.Popen([command, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     env=env, cwd=cwd, text=True, bufsize=1)
        self.inbox, self.next_id, self.lock = queue.Queue(), 1, threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            try:
                self.inbox.put(json.loads(line))
            except json.JSONDecodeError:
                continue  # not a protocol message (some servers print logs to stdout)
        self.inbox.put(None)  # the server closed its output

    def _send(self, message):
        try:
            self.proc.stdin.write(json.dumps(message) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            raise McpError("the server has stopped")

    def notify(self, method, params=None):
        self._send({"jsonrpc": "2.0", "method": method, **({"params": params} if params is not None else {})})

    def request(self, method, params, timeout):
        with self.lock:
            rid, self.next_id = self.next_id, self.next_id + 1
            self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
            while True:
                try:
                    msg = self.inbox.get(timeout=timeout)
                except queue.Empty:
                    raise McpError(f"no answer to {method} within {timeout}s")
                if msg is None:
                    raise McpError("the server closed the connection")
                if "method" in msg and "id" in msg:  # a request from the server (sampling, roots...): we support none of them
                    self._send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "not supported by this client"}})
                    continue
                if msg.get("id") == rid:
                    if "error" in msg:
                        raise McpError(f"{msg['error'].get('message', msg['error'])}")
                    return msg.get("result", {})

    def close(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=3)
        except Exception:  # noqa: BLE001
            self.proc.kill()


class Manager:
    """All configured servers and their tools."""

    def __init__(self):
        self.clients, self.tools, self.warnings = {}, {}, []  # tools: full name -> (server, tool dict)

    @classmethod
    def load(cls, project):
        """Start the servers listed under mcpServers in <project>/.mcp.json. A server that fails is skipped with a warning."""
        m = cls()
        path = Path(project) / ".mcp.json"
        if not path.is_file():
            return m
        try:
            servers = json.loads(path.read_text(encoding="utf-8")).get("mcpServers", {})
        except (OSError, json.JSONDecodeError) as e:
            m.warnings.append(f".mcp.json could not be read ({e})")
            return m
        for name, conf in servers.items():
            if not isinstance(conf, dict) or not conf.get("command") or conf.get("type", "stdio") != "stdio":
                m.warnings.append(f"MCP server '{name}' skipped: only stdio servers with a command are supported")
                continue
            try:
                m._start(name, conf, project)
            except (McpError, OSError) as e:
                m.warnings.append(f"MCP server '{name}' could not start: {e}")
        return m

    def _start(self, name, conf, project):
        env = {k: v for k, v in os.environ.items() if k not in safety.OWN_SECRET_VARS}  # our API keys are not for servers
        env.update({k: expand_env(str(v)) for k, v in (conf.get("env") or {}).items()})
        client = Client(expand_env(conf["command"]), [expand_env(str(a)) for a in conf.get("args", [])], env, str(project))
        try:
            client.request("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                                          "clientInfo": {"name": "mini-harness", "version": "1"}}, STARTUP_SECONDS)
            client.notify("notifications/initialized")
            found, cursor = [], None
            while True:
                result = client.request("tools/list", {"cursor": cursor} if cursor else {}, STARTUP_SECONDS)
                found += result.get("tools", [])
                cursor = result.get("nextCursor")
                if not cursor:
                    break
        except McpError:
            client.close()
            raise
        self.clients[name] = client
        for t in found:
            full = f"mcp__{_clean(name)}__{_clean(t['name'])}"[:64]
            while full in self.tools:
                full = full[:60] + "_x"
            self.tools[full] = (name, t)

    def owns(self, name):
        return name in self.tools

    def tool_defs(self):
        """Tool definitions for the API, in a fixed order (the tool list is part of the cached prefix)."""
        defs = []
        for full in sorted(self.tools):
            server, t = self.tools[full]
            schema = dict(t.get("inputSchema") or {"type": "object", "properties": {}})
            schema.setdefault("type", "object")
            defs.append({"name": full, "description": f"[MCP server '{server}'] {t.get('description', '')}".strip(), "input_schema": schema})
        return defs

    def check(self, name, args):
        """Input rules for an MCP tool, from its own schema: required inputs, types, allowed values."""
        _, t = self.tools[name]
        spec = {"input_schema": {"properties": (t.get("inputSchema") or {}).get("properties", {}),
                                 "required": (t.get("inputSchema") or {}).get("required", [])}}
        return tools.check_schema(name, spec, args, strict_unknown=(t.get("inputSchema") or {}).get("additionalProperties") is False)

    def call(self, name, args):
        """Run an MCP tool. Returns (text, is_error); never raises."""
        server, t = self.tools[name]
        try:
            result = self.clients[server].request("tools/call", {"name": t["name"], "arguments": args}, CALL_SECONDS)
        except McpError as e:
            return f"The MCP server '{server}' failed: {e}. Try again, or use a different approach.", True
        parts = []
        for c in result.get("content", []):
            if c.get("type") == "text":
                parts.append(c.get("text", ""))
            else:
                parts.append(f"[{c.get('type', 'content')} omitted: this client shows text only]")
        text = "\n".join(parts) or (json.dumps(result["structuredContent"]) if "structuredContent" in result else "(no output)")
        is_error = bool(result.get("isError"))
        return tools.clip(text if not is_error else f"The tool reported an error: {text}\nRead it, fix the input or approach, and try again."), is_error

    def close(self):
        for c in self.clients.values():
            c.close()
