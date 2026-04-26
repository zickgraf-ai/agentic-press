import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  return { mockLogger };
});
vi.mock("../../src/logger.js", () => ({
  default: mockLogger, childLogger: vi.fn(() => mockLogger),
}));

import {
  createMetricsRecorder,
  createMetricsServer,
  type MetricsRecorder,
} from "../../src/observability/metrics.js";

async function startServer(recorder: MetricsRecorder): Promise<{ server: Server; url: string }> {
  const app = createMetricsServer(recorder);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}/metrics` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("metrics HTTP server", () => {
  let server: Server;
  let url: string;
  let recorder: MetricsRecorder;

  beforeEach(async () => {
    recorder = await createMetricsRecorder({ enabled: true, port: 9090 });
    const started = await startServer(recorder);
    server = started.server;
    url = started.url;
  });

  afterEach(async () => {
    await closeServer(server);
    await recorder.shutdown();
  });

  it("GET /metrics returns 200 with prom text content-type", async () => {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type");
    expect(ct).toContain("text/plain");
  });

  it("GET /metrics body contains expected metric names", async () => {
    // Generate at least one observation so counters appear in output
    recorder.recordRequest("Read", "allowed", 5);
    recorder.recordInjectionFlag("test_pattern");
    recorder.recordBlockedRequest("allowlist");

    const res = await fetch(url);
    const body = await res.text();
    expect(body).toContain("mcp_proxy_requests_total");
    expect(body).toContain("mcp_proxy_request_duration_seconds");
    expect(body).toContain("mcp_proxy_injection_flags_total");
    expect(body).toContain("mcp_proxy_blocked_total");
  });

  it("repeated recordRequest calls accumulate in the counter output", async () => {
    recorder.recordRequest("Read", "allowed", 5);
    recorder.recordRequest("Read", "allowed", 5);
    recorder.recordRequest("Read", "allowed", 5);
    const res = await fetch(url);
    const body = await res.text();
    // Find the requests_total line for tool=Read,status=allowed
    const match = body.match(/mcp_proxy_requests_total\{[^}]*tool="Read"[^}]*status="allowed"[^}]*\}\s+(\d+)/);
    expect(match).toBeTruthy();
    if (match) {
      expect(parseInt(match[1]!, 10)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("metrics HTTP server — error path", () => {
  it("returns 500 when metricsText() rejects", async () => {
    // A custom recorder whose metricsText throws — exercise the catch block in
    // createMetricsServer so a registry failure doesn't surface a 200 with
    // empty body (which would silently mask broken telemetry).
    const recorder: MetricsRecorder = {
      recordRequest: () => {},
      recordInjectionFlag: () => {},
      recordBlockedRequest: () => {},
      metricsText: async () => { throw new Error("registry down"); },
      shutdown: async () => {},
    };
    const app = createMetricsServer(recorder);
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).toContain("metrics unavailable");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
