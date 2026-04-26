import { describe, it, expect, vi, beforeEach } from "vitest";

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

// Mock prom-client. We capture spies so each test can assert against them.
const counterInc = vi.fn();
const histogramObserve = vi.fn();
const registryMetrics = vi.fn(async () => "# HELP mcp_proxy_requests_total Total\n");
const registryClear = vi.fn();
const registryRegister = vi.fn();

const CounterCtor = vi.fn(function (this: any, _opts: any) {
  this.inc = counterInc;
});
const HistogramCtor = vi.fn(function (this: any, _opts: any) {
  this.observe = histogramObserve;
});
const RegistryCtor = vi.fn(function (this: any) {
  this.metrics = registryMetrics;
  this.clear = registryClear;
  this.registerMetric = registryRegister;
  this.contentType = "text/plain; version=0.0.4; charset=utf-8";
});
const collectDefaultMetrics = vi.fn();

const promClientFactory = vi.fn(() => ({
  Counter: CounterCtor,
  Histogram: HistogramCtor,
  Registry: RegistryCtor,
  collectDefaultMetrics,
}));
vi.mock("prom-client", () => promClientFactory());

import {
  createNoopRecorder,
  createMetricsRecorder,
  getNoopRecorder,
} from "../../src/observability/metrics.js";

beforeEach(() => {
  counterInc.mockReset();
  histogramObserve.mockReset();
  registryMetrics.mockReset().mockResolvedValue("# HELP mcp_proxy_requests_total Total\n");
  registryClear.mockReset();
  registryRegister.mockReset();
  CounterCtor.mockClear();
  HistogramCtor.mockClear();
  RegistryCtor.mockClear();
  collectDefaultMetrics.mockClear();
  promClientFactory.mockClear();
});

describe("createNoopRecorder", () => {
  it("returns a singleton (same reference each call)", () => {
    const a = createNoopRecorder();
    const b = createNoopRecorder();
    expect(a).toBe(b);
  });

  it("getNoopRecorder returns the same singleton", () => {
    expect(getNoopRecorder()).toBe(createNoopRecorder());
  });

  it("all record methods are callable without throwing", () => {
    const r = createNoopRecorder();
    expect(() => r.recordRequest("Read", "allowed", 42)).not.toThrow();
    expect(() => r.recordInjectionFlag("ignore_instructions")).not.toThrow();
    expect(() => r.recordBlockedRequest("allowlist")).not.toThrow();
  });

  it("metricsText resolves with empty body and a content-type", async () => {
    const r = createNoopRecorder();
    const out = await r.metricsText();
    expect(typeof out.contentType).toBe("string");
    expect(typeof out.body).toBe("string");
  });

  it("shutdown resolves without throwing", async () => {
    const r = createNoopRecorder();
    await expect(r.shutdown()).resolves.toBeUndefined();
  });
});

describe("createMetricsRecorder (disabled)", () => {
  it("returns the no-op recorder when config.enabled is false", async () => {
    const r = await createMetricsRecorder({ enabled: false });
    expect(r).toBe(getNoopRecorder());
    expect(promClientFactory).not.toHaveBeenCalled();
    expect(CounterCtor).not.toHaveBeenCalled();
  });
});

describe("createMetricsRecorder (enabled)", () => {
  it("constructs the prom-client Registry, Counters, Histogram and collects default metrics", async () => {
    await createMetricsRecorder({ enabled: true, port: 9090 });
    expect(RegistryCtor).toHaveBeenCalledTimes(1);
    // 3 counters: requests, injection flags, blocked
    expect(CounterCtor).toHaveBeenCalledTimes(3);
    // 1 histogram: request duration
    expect(HistogramCtor).toHaveBeenCalledTimes(1);
    expect(collectDefaultMetrics).toHaveBeenCalledTimes(1);
  });

  it("recordRequest increments the request counter and observes the histogram", async () => {
    const r = await createMetricsRecorder({ enabled: true, port: 9090 });
    r.recordRequest("Read", "allowed", 42);
    expect(counterInc).toHaveBeenCalled();
    expect(histogramObserve).toHaveBeenCalled();
    // The request counter should be incremented with tool/status labels
    const incCall = counterInc.mock.calls.find(
      (c) => c[0] && typeof c[0] === "object" && c[0].tool === "Read" && c[0].status === "allowed"
    );
    expect(incCall).toBeDefined();
  });

  it("recordInjectionFlag increments the injection counter with pattern label", async () => {
    const r = await createMetricsRecorder({ enabled: true, port: 9090 });
    r.recordInjectionFlag("ignore_instructions");
    const incCall = counterInc.mock.calls.find(
      (c) => c[0] && typeof c[0] === "object" && c[0].pattern === "ignore_instructions"
    );
    expect(incCall).toBeDefined();
  });

  it("recordBlockedRequest increments the blocked counter with reason label", async () => {
    const r = await createMetricsRecorder({ enabled: true, port: 9090 });
    r.recordBlockedRequest("allowlist");
    const incCall = counterInc.mock.calls.find(
      (c) => c[0] && typeof c[0] === "object" && c[0].reason === "allowlist"
    );
    expect(incCall).toBeDefined();
  });

  it("swallows prom-client errors thrown inside recordRequest (#error-isolation)", async () => {
    mockLogger.warn.mockClear();
    counterInc.mockImplementationOnce(() => {
      throw new Error("prom boom");
    });
    const r = await createMetricsRecorder({ enabled: true, port: 9090 });
    expect(() => r.recordRequest("Read", "allowed", 1)).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("swallows prom-client errors thrown inside recordInjectionFlag", async () => {
    mockLogger.warn.mockClear();
    counterInc.mockImplementationOnce(() => {
      throw new Error("prom boom");
    });
    const r = await createMetricsRecorder({ enabled: true, port: 9090 });
    expect(() => r.recordInjectionFlag("foo")).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("swallows prom-client errors thrown inside recordBlockedRequest", async () => {
    mockLogger.warn.mockClear();
    counterInc.mockImplementationOnce(() => {
      throw new Error("prom boom");
    });
    const r = await createMetricsRecorder({ enabled: true, port: 9090 });
    expect(() => r.recordBlockedRequest("allowlist")).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("metricsText returns prom-client text output and content-type", async () => {
    const r = await createMetricsRecorder({ enabled: true, port: 9090 });
    const out = await r.metricsText();
    expect(out.contentType).toContain("text/plain");
    expect(out.body).toContain("mcp_proxy_requests_total");
    expect(registryMetrics).toHaveBeenCalled();
  });

  it("shutdown clears the registry and resolves", async () => {
    const r = await createMetricsRecorder({ enabled: true, port: 9090 });
    await r.shutdown();
    expect(registryClear).toHaveBeenCalled();
  });
});
