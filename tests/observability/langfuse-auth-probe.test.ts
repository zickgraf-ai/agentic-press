import { describe, it, expect, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { probeLangfuseAuth } from "../../src/observability/langfuse-auth-probe.js";

const PUBLIC_KEY = "pk-test-public";
const SECRET_KEY = "sk-test-secret-that-must-not-leak";

async function startStub(
  handler: (req: express.Request, res: express.Response) => void
): Promise<{ server: Server; host: string }> {
  const app = express();
  app.get("/api/public/projects", handler);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, host: `http://127.0.0.1:${port}` };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("probeLangfuseAuth", () => {
  it("returns ok on 200 and reports project name when present", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.status(200).json({ data: [{ id: "proj-abc", name: "agentic-press" }] });
    });
    try {
      const result = await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.projectId).toBe("proj-abc");
    } finally {
      await closeServer(server);
    }
  });

  it("returns ok with no projectId when response body is empty/unrecognized", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.status(200).send("");
    });
    try {
      const result = await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.projectId).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it("returns auth failure on 401", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.status(401).json({ error: "Unauthorized" });
    });
    try {
      const result = await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("auth");
        expect(result.status).toBe(401);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("returns 'server' on 5xx without throwing", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.status(503).json({ error: "down" });
    });
    try {
      const result = await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("server");
        expect(result.status).toBe(503);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("returns 'network' when the host is unreachable", async () => {
    // Bind then close — guarantees ECONNREFUSED on a known port.
    const stub = await startStub(() => {});
    const port = (stub.server.address() as AddressInfo).port;
    await closeServer(stub.server);
    const result = await probeLangfuseAuth({
      host: `http://127.0.0.1:${port}`,
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("network");
  });

  it("returns 'timeout' when the server hangs past the timeout", async () => {
    const app = express();
    app.get("/api/public/projects", () => {
      /* never responds */
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await probeLangfuseAuth({
        host: `http://127.0.0.1:${port}`,
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
        timeoutMs: 50,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("timeout");
    } finally {
      await closeServer(server);
    }
  });

  it("sends Basic auth with base64(publicKey:secretKey)", async () => {
    let receivedAuth = "";
    const { server, host } = await startStub((req, res) => {
      receivedAuth = String(req.headers.authorization ?? "");
      res.status(200).json({ data: [] });
    });
    try {
      await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      const expected = "Basic " + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64");
      expect(receivedAuth).toBe(expected);
    } finally {
      await closeServer(server);
    }
  });

  it("secret-key bytes NEVER appear in result objects (defence against accidental leak)", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.status(401).json({ error: SECRET_KEY }); // server echoes the secret back — hostile case
    });
    try {
      const result = await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      // Even when the server echoes the secret back, the probe must not propagate it.
      const blob = JSON.stringify(result);
      expect(blob).not.toContain(SECRET_KEY);
    } finally {
      await closeServer(server);
    }
  });

  it("never throws — pathological inputs degrade to a 'network' or 'timeout' result", async () => {
    const result = await probeLangfuseAuth({
      host: "http://this-host-does-not-resolve.invalid",
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["network", "timeout"]).toContain(result.reason);
    }
  });
});

describe("probeLangfuseAuth — invalid input handling", () => {
  it("returns 'network' for malformed host URL without throwing", async () => {
    const result = await probeLangfuseAuth({
      host: "not-a-url",
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
  });
});

// Suppress unused-import warnings from vi in case some matchers go unused.
void vi;
