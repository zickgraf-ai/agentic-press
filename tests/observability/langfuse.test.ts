import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  return { mockLogger };
});

vi.mock("../../src/logger.js", () => ({
  default: mockLogger,
  childLogger: vi.fn(() => mockLogger),
}));

// Mocked Langfuse SDK — we capture spies so each test can assert against them.
const traceSpan = vi.fn();
const traceUpdate = vi.fn();
const traceObj = { span: traceSpan, update: traceUpdate };
const langfuseTrace = vi.fn(() => traceObj);
const langfuseFlushAsync = vi.fn(async () => {});
const langfuseShutdownAsync = vi.fn(async () => {});
const LangfuseCtor = vi.fn(function (this: any) {
  this.trace = langfuseTrace;
  this.flushAsync = langfuseFlushAsync;
  this.shutdownAsync = langfuseShutdownAsync;
});

const langfuseModuleFactory = vi.fn(() => ({ Langfuse: LangfuseCtor }));
vi.mock("langfuse", () => langfuseModuleFactory());

import { createTracer, getNoopActiveTrace } from "../../src/observability/langfuse.js";

beforeEach(() => {
  traceSpan.mockReset();
  traceUpdate.mockReset();
  langfuseTrace.mockReset().mockReturnValue(traceObj);
  langfuseFlushAsync.mockReset().mockResolvedValue(undefined);
  langfuseShutdownAsync.mockReset().mockResolvedValue(undefined);
  LangfuseCtor.mockClear();
  langfuseModuleFactory.mockClear();
});

describe("createTracer (no-op mode)", () => {
  it("returns a no-op tracer immediately when disabled", async () => {
    const tracer = await createTracer({ enabled: false });
    expect(tracer).toBeDefined();
    // No-op tracer never constructs the SDK.
    expect(LangfuseCtor).not.toHaveBeenCalled();
    // Module factory must not be invoked from the disabled path.
    expect(langfuseModuleFactory).not.toHaveBeenCalled();
  });

  it("no-op tracer returns the singleton sentinel ActiveTrace and never throws", async () => {
    const tracer = await createTracer({ enabled: false });
    const active = tracer.startTrace({ name: "test" });
    expect(active).toBe(getNoopActiveTrace());
    // Two successive startTrace calls must return the same cached sentinel —
    // the disabled path must not allocate per request.
    expect(tracer.startTrace({ name: "test2" })).toBe(active);
    expect(() => active.span({ tool: "Read", status: "allowed", durationMs: 5 })).not.toThrow();
    expect(() => active.end({ outcome: "allowed" })).not.toThrow();
    await expect(tracer.flush()).resolves.toBeUndefined();
    await expect(tracer.shutdown()).resolves.toBeUndefined();
    expect(LangfuseCtor).not.toHaveBeenCalled();
  });
});

describe("createTracer (enabled mode)", () => {
  it("constructs the Langfuse SDK with credentials", async () => {
    await createTracer({
      enabled: true,
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "https://cloud.langfuse.com",
    });
    expect(LangfuseCtor).toHaveBeenCalledTimes(1);
    expect(LangfuseCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: "pk-test",
        secretKey: "sk-test",
        baseUrl: "https://cloud.langfuse.com",
      })
    );
  });

  it("startTrace calls SDK trace() once and returns an ActiveTrace", async () => {
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const active = tracer.startTrace({ name: "mcp.request:Read", sessionId: "s1", metadata: { foo: 1 } });
    expect(langfuseTrace).toHaveBeenCalledTimes(1);
    expect(langfuseTrace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mcp.request:Read", sessionId: "s1" })
    );
    expect(active).toBeDefined();
    expect(typeof active.span).toBe("function");
    expect(typeof active.end).toBe("function");
  });

  it("ActiveTrace.span calls trace.span with mcp.tool_call and metadata", async () => {
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    active.span({
      tool: "Read",
      status: "allowed",
      durationMs: 12,
      flags: ["pf1"],
    });
    expect(traceSpan).toHaveBeenCalledTimes(1);
    const arg = traceSpan.mock.calls[0]![0];
    expect(arg.name).toBe("mcp.tool_call");
    expect(arg.metadata).toEqual({
      tool: "Read",
      status: "allowed",
      durationMs: 12,
      flags: ["pf1"],
    });
  });

  it("ActiveTrace.end updates the trace with outcome metadata", async () => {
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    active.end({ outcome: "allowed" });
    expect(traceUpdate).toHaveBeenCalledTimes(1);
    const arg = traceUpdate.mock.calls[0]![0];
    expect(arg.metadata).toEqual({ outcome: "allowed" });
  });

  it("ActiveTrace.end is idempotent — second call is a no-op at the SDK level", async () => {
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    active.end({ outcome: "allowed" });
    active.end({ outcome: "error" });
    active.end({ outcome: "blocked" });
    expect(traceUpdate).toHaveBeenCalledTimes(1);
    // And span() after end() is also a no-op — the session is closed.
    active.span({ tool: "Read", status: "allowed", durationMs: 1 });
    expect(traceSpan).not.toHaveBeenCalled();
  });

  it("swallows SDK errors thrown inside ActiveTrace.span", async () => {
    mockLogger.warn.mockClear();
    traceSpan.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    expect(() =>
      active.span({ tool: "Read", status: "allowed", durationMs: 1 })
    ).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("swallows SDK errors thrown inside ActiveTrace.end", async () => {
    mockLogger.warn.mockClear();
    traceUpdate.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    expect(() => active.end({ outcome: "allowed" })).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("startTrace SDK failure returns the no-op sentinel", async () => {
    mockLogger.warn.mockClear();
    langfuseTrace.mockImplementationOnce(() => {
      throw new Error("trace boom");
    });
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    expect(active).toBe(getNoopActiveTrace());
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("flush and shutdown delegate to SDK", async () => {
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    await tracer.flush();
    await tracer.shutdown();
    expect(langfuseFlushAsync).toHaveBeenCalledTimes(1);
    expect(langfuseShutdownAsync).toHaveBeenCalledTimes(1);
  });
});
