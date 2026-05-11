import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { probeLangfuseAuth, type ProbeResult } from "../../src/observability/langfuse-auth-probe.js";

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

describe("probeLangfuseAuth — happy path and credential mismatch", () => {
  it("returns ok on 200 with application/json body and reports projectId", async () => {
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

  it("returns ok with no projectId when JSON has empty data array", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.status(200).json({ data: [] });
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
        if (result.reason === "auth") expect(result.status).toBe(401);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("returns auth failure on 403 (some Langfuse tiers gate at 403, not 401)", async () => {
    const { server, host } = await startStub((_req, res) => res.status(403).send());
    try {
      const result = await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === "auth") expect(result.status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });
});

describe("probeLangfuseAuth — wrong-host / captive-portal defence (PR-74 review I3)", () => {
  it("200 with text/html body → unexpected-shape (NOT ok)", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.status(200).type("text/html").send("<html>Captive Portal Sign-In</html>");
    });
    try {
      const result = await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unexpected-shape");
        if (result.reason === "unexpected-shape") expect(result.status).toBe(200);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("200 with application/json but unparseable body → unexpected-shape", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.status(200).type("application/json").send("not really json");
    });
    try {
      const result = await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unexpected-shape");
    } finally {
      await closeServer(server);
    }
  });

  it("200 with JSON missing 'data' array → unexpected-shape", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.status(200).json({ message: "hi" });
    });
    try {
      const result = await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unexpected-shape");
    } finally {
      await closeServer(server);
    }
  });

  it("redirects are refused — Basic auth must not leak to a third-party host (review S4)", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.redirect(302, "http://elsewhere.invalid/api/public/projects");
    });
    try {
      const result = await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      expect(result.ok).toBe(false);
      // Node's fetch with redirect: "error" raises a TypeError -> our network branch.
      if (!result.ok) expect(result.reason).toBe("network");
    } finally {
      await closeServer(server);
    }
  });
});

describe("probeLangfuseAuth — non-success transport states", () => {
  it("returns 'server' on 5xx without throwing", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.status(503).json({ error: "down" });
    });
    try {
      const result = await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === "server") expect(result.status).toBe(503);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 'network' when the host is unreachable", async () => {
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
        // 200ms cap is comfortable on a loaded CI runner per review S9.
        timeoutMs: 200,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("timeout");
    } finally {
      await closeServer(server);
    }
  });

  it("never throws — pathological inputs degrade to 'network' or 'timeout'", async () => {
    const result = await probeLangfuseAuth({
      host: "http://this-host-does-not-resolve.invalid",
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
      timeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["network", "timeout"]).toContain(result.reason);
  });

  it("returns 'network' for malformed host URL without throwing", async () => {
    const result = await probeLangfuseAuth({
      host: "not-a-url",
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
      timeoutMs: 200,
    });
    expect(result.ok).toBe(false);
  });
});

describe("probeLangfuseAuth — auth header shape", () => {
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
});

describe("probeLangfuseAuth — no-leak invariant (PR-74 review I5)", () => {
  const SECRET_B64 = Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64");

  function assertNoLeak(result: ProbeResult): void {
    const blob = JSON.stringify(result);
    expect(blob).not.toContain(SECRET_KEY);
    expect(blob).not.toContain(SECRET_B64);
    // The public key alone is not a secret, but assert nonetheless that
    // result objects never carry credential material in any form.
    expect(blob.toLowerCase()).not.toContain("authorization");
  }

  it("ok path", async () => {
    const { server, host } = await startStub((_req, res) =>
      res.status(200).json({ data: [{ id: "proj-x" }] })
    );
    try {
      assertNoLeak(await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY }));
    } finally {
      await closeServer(server);
    }
  });

  it("auth path — even when the server echoes the secret back in its 401 body", async () => {
    const { server, host } = await startStub((_req, res) => {
      res.status(401).json({ error: SECRET_KEY, basic: SECRET_B64 });
    });
    try {
      assertNoLeak(await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY }));
    } finally {
      await closeServer(server);
    }
  });

  it("server path (5xx body containing the secret)", async () => {
    const { server, host } = await startStub((_req, res) => res.status(500).send(SECRET_KEY));
    try {
      assertNoLeak(await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY }));
    } finally {
      await closeServer(server);
    }
  });

  it("unexpected-shape path (200/HTML body containing the secret)", async () => {
    const { server, host } = await startStub((_req, res) =>
      res.status(200).type("text/html").send(`<html>${SECRET_KEY}</html>`)
    );
    try {
      assertNoLeak(await probeLangfuseAuth({ host, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY }));
    } finally {
      await closeServer(server);
    }
  });

  it("network path", async () => {
    const stub = await startStub(() => {});
    const port = (stub.server.address() as AddressInfo).port;
    await closeServer(stub.server);
    assertNoLeak(
      await probeLangfuseAuth({
        host: `http://127.0.0.1:${port}`,
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      })
    );
  });

  it("timeout path", async () => {
    const app = express();
    app.get("/api/public/projects", () => {});
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    try {
      assertNoLeak(
        await probeLangfuseAuth({
          host: `http://127.0.0.1:${port}`,
          publicKey: PUBLIC_KEY,
          secretKey: SECRET_KEY,
          timeoutMs: 100,
        })
      );
    } finally {
      await closeServer(server);
    }
  });
});
