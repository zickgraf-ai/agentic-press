import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { createTracer } from "../../src/observability/langfuse.js";

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

  it("no-op tracer methods do not throw and return sentinel handles", async () => {
    const tracer = await createTracer({ enabled: false });
    const handle = tracer.startTrace({ name: "test" });
    expect(handle).toBeDefined();
    expect(() =>
      tracer.spanToolCall(handle, { tool: "Read", status: "allowed", durationMs: 5 })
    ).not.toThrow();
    expect(() => tracer.endTrace(handle, { outcome: "ok" })).not.toThrow();
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

  it("startTrace calls SDK trace() once and returns a non-noop handle", async () => {
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const handle = tracer.startTrace({ name: "mcp.request:Read", sessionId: "s1", metadata: { foo: 1 } });
    expect(langfuseTrace).toHaveBeenCalledTimes(1);
    expect(langfuseTrace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mcp.request:Read", sessionId: "s1" })
    );
    expect(handle).toBeDefined();
  });

  it("spanToolCall calls trace.span with mcp.tool_call and metadata", async () => {
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const handle = tracer.startTrace({ name: "mcp.request:Read" });
    tracer.spanToolCall(handle, {
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

  it("endTrace updates the trace with outcome metadata", async () => {
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const handle = tracer.startTrace({ name: "mcp.request:Read" });
    tracer.endTrace(handle, { outcome: "allowed" });
    expect(traceUpdate).toHaveBeenCalledTimes(1);
    const arg = traceUpdate.mock.calls[0]![0];
    expect(arg.metadata).toEqual({ outcome: "allowed" });
  });

  it("swallows SDK errors thrown inside spanToolCall", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    traceSpan.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const handle = tracer.startTrace({ name: "mcp.request:Read" });
    expect(() =>
      tracer.spanToolCall(handle, { tool: "Read", status: "allowed", durationMs: 1 })
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("swallows SDK errors thrown inside endTrace", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    traceUpdate.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://cloud.langfuse.com",
    });
    const handle = tracer.startTrace({ name: "mcp.request:Read" });
    expect(() => tracer.endTrace(handle, { outcome: "ok" })).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
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
