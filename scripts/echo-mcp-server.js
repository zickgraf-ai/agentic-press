#!/usr/bin/env node
// Minimal MCP echo server for integration testing.
// Reads JSON-RPC requests from stdin, responds on stdout.
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const req = JSON.parse(line);
      const res = {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: "echo: " + JSON.stringify(req.params) }],
        },
      };
      process.stdout.write(JSON.stringify(res) + "\n");
    } catch {}
  }
});
