"""The benchmark's only local tool: read a Markdown skill without executing code."""
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(os.environ["SKILL_ROOT"]).resolve()
AUDIT = Path(os.environ["READ_AUDIT"])
TOOL = {
    "name": "read_file",
    "description": "Read a Markdown skill file at its advertised absolute path.",
    "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    "inputSchema": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
        "additionalProperties": False,
    },
}

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "benchmark-readonly", "version": "1"},
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [TOOL]}
    elif method == "tools/call":
        try:
            if request["params"]["name"] != "read_file":
                raise ValueError("Unknown tool")
            target = Path(request["params"]["arguments"]["path"]).resolve()
            if not target.is_relative_to(ROOT) or target.suffix != ".md":
                raise ValueError("Only Markdown files inside the skill directory are readable")
            content = target.read_text()
            with AUDIT.open("a") as audit:
                audit.write(json.dumps({"path": str(target), "sha256": hashlib.sha256(content.encode()).hexdigest()}) + "\n")
            result = {"content": [{"type": "text", "text": content}]}
        except (KeyError, ValueError, OSError) as error:
            result = {"isError": True, "content": [{"type": "text", "text": str(error)}]}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Method not found"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
