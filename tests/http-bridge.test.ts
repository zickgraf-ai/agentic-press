import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  return { mockLogger };
});
vi.mock("../src/logger.js", () => ({
  default: mockLogger, childLogger: vi.fn(() => mockLogger),
}));

import { createHttpBridge } from "../src/mcp-proxy/http-bridge.js";
import { ResponseSizeExceededError } from "../src/mcp-proxy/stdio-bridge.js";

/**
 * Spin up a minimal Streamable HTTP MCP server: accepts POST application/json
 * with a JSON-RPC body and echoes back a response built by the test handler.
 *
 * The Streamable HTTP spec lets servers respond with either application/json
 * (single response, what we test here) or text/event-stream (SSE, out of
 * scope for this PR). The spec also permits stateless mode — no initialize
 * handshake required if the server doesn't track session state. Our test
 * server is stateless, matching what our bridge expects from a real upstream.
 */
function startMockMcpServer(handler: (body: any, req: any) => any): Promise<{
  url: string;
  server: Server;
  capturedHeaders: Record<string, string | undefined>[];
}> {
  return new Promise((resolve) => {
    const capturedHeaders: Record<string, string | undefined>[] = [];
    const app: Express = express();
    app.use(express.json({ limit: "50mb" }));
    app.post("/mcp", (req, res) => {
      capturedHeaders.push({
        authorization: req.header("authorization"),
        "x-test": req.header("x-test"),
        "content-type": req.header("content-type"),
      });
      const result = handler(req.body, req);
      if (result === undefined) {
        // Simulate hang — client should hit timeout
        return;
      }
      res.json(result);
    });
    const server = app.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, server, capturedHeaders });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("createHttpBridge — happy path", () => {
  let server: Server;
  let url: string;
  let capturedHeaders: Record<string, string | undefined>[];

  beforeEach(async () => {
    const started = await startMockMcpServer((body) => ({
      jsonrpc: "2.0",
      id: body.id,
      result: { content: "echo-" + body.params?.name },
    }));
    server = started.server;
    url = started.url;
    capturedHeaders = started.capturedHeaders;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("call() sends JSON-RPC POST and resolves with the result field", async () => {
    const bridge = createHttpBridge([{ name: "remote", transport: "http", url }]);
    try {
      const result = await bridge.call("remote", "tools/call", { name: "Read", arguments: {} });
      expect(result).toEqual({ content: "echo-Read" });
    } finally {
      await bridge.shutdown();
    }
  });

  it("includes Authorization: Bearer header when bearerToken is set", async () => {
    const bridge = createHttpBridge([
      { name: "remote", transport: "http", url, bearerToken: "secret-token-123" },
    ]);
    try {
      await bridge.call("remote", "tools/call", { name: "Read", arguments: {} });
      expect(capturedHeaders[0]!.authorization).toBe("Bearer secret-token-123");
    } finally {
      await bridge.shutdown();
    }
  });

  it("includes custom headers and merges with bearer token", async () => {
    const bridge = createHttpBridge([
      { name: "remote", transport: "http", url, bearerToken: "t", headers: { "X-Test": "yes" } },
    ]);
    try {
      await bridge.call("remote", "tools/call", { name: "Read", arguments: {} });
      expect(capturedHeaders[0]!.authorization).toBe("Bearer t");
      expect(capturedHeaders[0]!["x-test"]).toBe("yes");
    } finally {
      await bridge.shutdown();
    }
  });

  it("does not send Authorization header when bearerToken is absent", async () => {
    const bridge = createHttpBridge([{ name: "remote", transport: "http", url }]);
    try {
      await bridge.call("remote", "tools/call", { name: "Read", arguments: {} });
      expect(capturedHeaders[0]!.authorization).toBeUndefined();
    } finally {
      await bridge.shutdown();
    }
  });

  it("rejects with descriptive error for unknown server name", async () => {
    const bridge = createHttpBridge([{ name: "remote", transport: "http", url }]);
    try {
      await expect(bridge.call("not-a-server", "tools/call", {})).rejects.toThrow(/not.*configured|not.*found/i);
    } finally {
      await bridge.shutdown();
    }
  });
});

describe("createHttpBridge — error paths", () => {
  it("rejects when upstream returns a JSON-RPC error envelope", async () => {
    const { server, url } = await startMockMcpServer((body) => ({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32602, message: "Invalid params" },
    }));
    const bridge = createHttpBridge([{ name: "remote", transport: "http", url }]);
    try {
      await expect(bridge.call("remote", "tools/call", {})).rejects.toThrow(/Invalid params/);
    } finally {
      await bridge.shutdown();
      await closeServer(server);
    }
  });

  it("rejects when upstream returns non-2xx status", async () => {
    const app: Express = express();
    app.post("/mcp", (_req, res) => {
      res.status(500).send("oops");
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const bridge = createHttpBridge([{ name: "remote", transport: "http", url }]);
    try {
      await expect(bridge.call("remote", "tools/call", {})).rejects.toThrow(/500|HTTP/i);
    } finally {
      await bridge.shutdown();
      await closeServer(server);
    }
  });

  it("rejects with timeout error if upstream never responds", async () => {
    // Use a 50ms timeout for the test
    const { server, url } = await startMockMcpServer(() => undefined); // never responds
    const bridge = createHttpBridge(
      [{ name: "remote", transport: "http", url }],
      { requestTimeoutMs: 50 }
    );
    try {
      await expect(bridge.call("remote", "tools/call", {})).rejects.toThrow(/timed out/i);
    } finally {
      await bridge.shutdown();
      await closeServer(server);
    }
  }, 10000);

  it("rejects with ResponseSizeExceededError when response body exceeds maxResponseBytes", async () => {
    // Server returns a response with a huge result string
    const huge = "x".repeat(2000);
    const { server, url } = await startMockMcpServer((body) => ({
      jsonrpc: "2.0",
      id: body.id,
      result: { content: huge },
    }));
    const bridge = createHttpBridge(
      [{ name: "remote", transport: "http", url }],
      { maxResponseBytes: 1000 } // Cap at 1000 bytes
    );
    try {
      await expect(bridge.call("remote", "tools/call", {})).rejects.toBeInstanceOf(ResponseSizeExceededError);
    } finally {
      await bridge.shutdown();
      await closeServer(server);
    }
  });

  it("with maxResponseBytes=0, large responses pass through (cap disabled)", async () => {
    const big = "x".repeat(50_000);
    const { server, url } = await startMockMcpServer((body) => ({
      jsonrpc: "2.0",
      id: body.id,
      result: { content: big },
    }));
    const bridge = createHttpBridge(
      [{ name: "remote", transport: "http", url }],
      { maxResponseBytes: 0 }
    );
    try {
      const result = await bridge.call("remote", "tools/call", {}) as { content: string };
      expect(result.content).toHaveLength(50_000);
    } finally {
      await bridge.shutdown();
      await closeServer(server);
    }
  });
});

describe("createHttpBridge — multiple servers", () => {
  it("routes calls to the correct server by name", async () => {
    const a = await startMockMcpServer((body) => ({
      jsonrpc: "2.0",
      id: body.id,
      result: { from: "a" },
    }));
    const b = await startMockMcpServer((body) => ({
      jsonrpc: "2.0",
      id: body.id,
      result: { from: "b" },
    }));
    const bridge = createHttpBridge([
      { name: "alpha", transport: "http", url: a.url },
      { name: "beta", transport: "http", url: b.url },
    ]);
    try {
      const ra = await bridge.call("alpha", "tools/call", {});
      const rb = await bridge.call("beta", "tools/call", {});
      expect(ra).toEqual({ from: "a" });
      expect(rb).toEqual({ from: "b" });
    } finally {
      await bridge.shutdown();
      await closeServer(a.server);
      await closeServer(b.server);
    }
  });
});

describe("createHttpBridge — security: redirect rejection (#26 review C1)", () => {
  // CRITICAL invariant: a redirect from the upstream MUST NOT cause the bridge
  // to replay Authorization: Bearer at the redirect target. We set
  // `redirect: "error"` on fetch so any 3xx aborts the request entirely.
  it("rejects when upstream returns a redirect (would replay bearer token otherwise)", async () => {
    const app: Express = express();
    app.post("/mcp", (_req, res) => {
      res.redirect(307, "http://attacker.example.com/steal");
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const bridge = createHttpBridge([
      { name: "remote", transport: "http", url, bearerToken: "secret-token" },
    ]);
    try {
      // The bridge MUST throw — fetch's redirect:"error" causes a TypeError
      // before any retry could exfiltrate the token.
      await expect(bridge.call("remote", "tools/call", {})).rejects.toThrow();
    } finally {
      await bridge.shutdown();
      await closeServer(server);
    }
  });
});

describe("createHttpBridge — slow-drip body DoS (#26 review C2)", () => {
  // The original implementation cleared the timeout after fetch resolved,
  // leaving response.text() unbounded. A malicious upstream that sends
  // headers immediately then drips body bytes could stall the proxy
  // forever. The fix puts the timeout in a finally and threads the abort
  // signal through both phases.
  it("aborts a slow-drip response body before it completes", async () => {
    const app: Express = express();
    app.post("/mcp", (_req, res) => {
      // Send headers immediately so fetch() resolves
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"jsonrpc":"2.0","id":1,"result":');
      // Then never finish — let the timeout fire
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const bridge = createHttpBridge(
      [{ name: "remote", transport: "http", url }],
      { requestTimeoutMs: 100 }
    );
    try {
      await expect(bridge.call("remote", "tools/call", {})).rejects.toThrow(/timed out/i);
    } finally {
      await bridge.shutdown();
      // Force close so the hanging response doesn't keep the test alive
      await closeServer(server);
    }
  }, 5000);
});

describe("createHttpBridge — streaming size cap (#26 review C3)", () => {
  // The original buffered the full body before measuring. A multi-GB response
  // would OOM before the cap fired. The fix streams the body and aborts as
  // soon as accumulated bytes exceed the cap.
  it("cancels the response stream as soon as the byte cap is exceeded mid-stream", async () => {
    const app: Express = express();
    app.post("/mcp", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Stream chunks. The cap should trip after a few hundred bytes, well
      // before the simulated "huge" payload completes.
      const chunk = "x".repeat(500);
      let sent = 0;
      const sendNext = () => {
        if (sent >= 50_000) { res.end(); return; }
        res.write(chunk);
        sent += chunk.length;
        setImmediate(sendNext);
      };
      sendNext();
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const bridge = createHttpBridge(
      [{ name: "remote", transport: "http", url }],
      { maxResponseBytes: 1000 }
    );
    try {
      await expect(bridge.call("remote", "tools/call", {})).rejects.toBeInstanceOf(ResponseSizeExceededError);
    } finally {
      await bridge.shutdown();
      await closeServer(server);
    }
  });
});

describe("createHttpBridge — header precedence (#26 review I4)", () => {
  it("custom headers cannot override Content-Type or Authorization", async () => {
    const captured: Record<string, string | undefined>[] = [];
    const app: Express = express();
    app.use(express.json());
    app.post("/mcp", (req, res) => {
      captured.push({
        contentType: req.header("content-type"),
        authorization: req.header("authorization"),
      });
      res.json({ jsonrpc: "2.0", id: req.body.id, result: { ok: true } });
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const bridge = createHttpBridge([
      {
        name: "remote",
        transport: "http",
        url,
        bearerToken: "real-token",
        headers: {
          "Content-Type": "text/plain",       // Should be ignored
          "Authorization": "Bearer fake-token", // Should be ignored
          "X-Allowed": "yes",                   // Should pass through
        },
      },
    ]);
    try {
      await bridge.call("remote", "tools/call", {});
      expect(captured[0]!.contentType).toContain("application/json");
      expect(captured[0]!.authorization).toBe("Bearer real-token");
    } finally {
      await bridge.shutdown();
      await closeServer(server);
    }
  });
});

describe("createHttpBridge — malformed responses (#26 review S11, S13, S17)", () => {
  it("rejects when upstream returns valid JSON but not an object (array)", async () => {
    const { server, url } = await startMockMcpServer(() => [1, 2, 3]);
    const bridge = createHttpBridge([{ name: "remote", transport: "http", url }]);
    try {
      await expect(bridge.call("remote", "tools/call", {})).rejects.toThrow(/malformed/i);
    } finally {
      await bridge.shutdown();
      await closeServer(server);
    }
  });

  it("rejects when upstream returns HTML error page (non-JSON body)", async () => {
    const app: Express = express();
    app.post("/mcp", (_req, res) => {
      res.status(200).type("text/html").send("<html><body>Oops</body></html>");
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const bridge = createHttpBridge([{ name: "remote", transport: "http", url }]);
    try {
      await expect(bridge.call("remote", "tools/call", {})).rejects.toThrow(/non-JSON/i);
    } finally {
      await bridge.shutdown();
      await closeServer(server);
    }
  });

  it("rejects envelope with neither result nor error (JSON-RPC 2.0 spec violation)", async () => {
    const { server, url } = await startMockMcpServer((body) => ({ jsonrpc: "2.0", id: body.id }));
    const bridge = createHttpBridge([{ name: "remote", transport: "http", url }]);
    try {
      await expect(bridge.call("remote", "tools/call", {})).rejects.toThrow(/neither result nor error/i);
    } finally {
      await bridge.shutdown();
      await closeServer(server);
    }
  });
});

describe("createHttpBridge — duplicate server names", () => {
  it("throws on duplicate server names in constructor", () => {
    expect(() =>
      createHttpBridge([
        { name: "dup", transport: "http", url: "https://a.com/mcp" },
        { name: "dup", transport: "http", url: "https://b.com/mcp" },
      ])
    ).toThrow(/duplicate/i);
  });
});
