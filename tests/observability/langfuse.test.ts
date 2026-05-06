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

// ── Mock SDK shape for v5 (@langfuse/tracing + @langfuse/client + @langfuse/otel + @opentelemetry/sdk-node) ──
//
// startObservation(name, attributes) returns a LangfuseSpan-like object with:
//   - .update(attrs)     — applied to root + child observations
//   - .end()             — finalizes the observation
//   - .startObservation(name, attrs) — creates a child (we only ever do this for `mcp.tool_call`)
//   - .otelSpan          — the underlying OpenTelemetry span; we set TRACE_* attrs via setAttribute
//
// LangfuseClient has .flush() and .shutdown() for lifecycle.
// LangfuseSpanProcessor and NodeSDK are constructed but only their start/shutdown matter for tests.

const otelSpanSetAttribute = vi.fn();
const childObsEnd = vi.fn();
const childObsUpdate = vi.fn();
const startChildObservation = vi.fn(() => ({
  update: childObsUpdate,
  end: childObsEnd,
  otelSpan: { setAttribute: vi.fn() },
}));
const rootObsEnd = vi.fn();
const rootObsUpdate = vi.fn();

function makeRootObs() {
  return {
    update: rootObsUpdate,
    end: rootObsEnd,
    startObservation: startChildObservation,
    otelSpan: { setAttribute: otelSpanSetAttribute },
  };
}

const startObservation = vi.fn(() => makeRootObs());
const setLangfuseTracerProvider = vi.fn();

const tracingFactory = vi.fn(() => ({
  startObservation,
  setLangfuseTracerProvider,
}));
vi.mock("@langfuse/tracing", () => tracingFactory());

const langfuseClientFlush = vi.fn(async () => {});
const langfuseClientShutdown = vi.fn(async () => {});
const LangfuseClientCtor = vi.fn(function (this: any) {
  this.flush = langfuseClientFlush;
  this.shutdown = langfuseClientShutdown;
});
const clientFactory = vi.fn(() => ({ LangfuseClient: LangfuseClientCtor }));
vi.mock("@langfuse/client", () => clientFactory());

const LangfuseSpanProcessorCtor = vi.fn(function (this: any) {});
const otelFactory = vi.fn(() => ({ LangfuseSpanProcessor: LangfuseSpanProcessorCtor }));
vi.mock("@langfuse/otel", () => otelFactory());

const sdkNodeStart = vi.fn();
const sdkNodeShutdown = vi.fn(async () => {});
const NodeSDKCtor = vi.fn(function (this: any) {
  this.start = sdkNodeStart;
  this.shutdown = sdkNodeShutdown;
  this._tracerProvider = { __sentinel: "tracerProvider" };
});
const sdkNodeFactory = vi.fn(() => ({ NodeSDK: NodeSDKCtor }));
vi.mock("@opentelemetry/sdk-node", () => sdkNodeFactory());

// LangfuseOtelSpanAttributes is the OTEL key registry used to set trace-level
// fields on the root observation. Mocked with stable strings so tests can
// assert which key was written without depending on the upstream constants.
const coreFactory = vi.fn(() => ({
  LangfuseOtelSpanAttributes: {
    TRACE_NAME: "MOCK_TRACE_NAME",
    TRACE_USER_ID: "MOCK_TRACE_USER_ID",
    TRACE_SESSION_ID: "MOCK_TRACE_SESSION_ID",
    TRACE_TAGS: "MOCK_TRACE_TAGS",
    TRACE_INPUT: "MOCK_TRACE_INPUT",
    TRACE_OUTPUT: "MOCK_TRACE_OUTPUT",
    TRACE_METADATA: "MOCK_TRACE_METADATA",
  },
}));
vi.mock("@langfuse/core", () => coreFactory());

import { createTracer, getNoopActiveTrace } from "../../src/observability/langfuse.js";

beforeEach(() => {
  startObservation.mockReset().mockImplementation(() => makeRootObs());
  startChildObservation.mockReset().mockImplementation(() => ({
    update: childObsUpdate,
    end: childObsEnd,
    otelSpan: { setAttribute: vi.fn() },
  }));
  setLangfuseTracerProvider.mockReset();
  rootObsEnd.mockReset();
  rootObsUpdate.mockReset();
  childObsEnd.mockReset();
  childObsUpdate.mockReset();
  otelSpanSetAttribute.mockReset();
  langfuseClientFlush.mockReset().mockResolvedValue(undefined);
  langfuseClientShutdown.mockReset().mockResolvedValue(undefined);
  LangfuseClientCtor.mockClear();
  LangfuseSpanProcessorCtor.mockClear();
  NodeSDKCtor.mockClear();
  sdkNodeStart.mockReset();
  sdkNodeShutdown.mockReset().mockResolvedValue(undefined);
  tracingFactory.mockClear();
  clientFactory.mockClear();
  otelFactory.mockClear();
  sdkNodeFactory.mockClear();
  coreFactory.mockClear();
  mockLogger.warn.mockClear();
});

describe("createTracer (no-op mode)", () => {
  it("returns a no-op tracer immediately when disabled", async () => {
    const tracer = await createTracer({ enabled: false });
    expect(tracer).toBeDefined();
    // No-op tracer never constructs the SDK or its OTEL infrastructure.
    expect(LangfuseClientCtor).not.toHaveBeenCalled();
    expect(LangfuseSpanProcessorCtor).not.toHaveBeenCalled();
    expect(NodeSDKCtor).not.toHaveBeenCalled();
    // None of the v5 module factories must be invoked from the disabled path.
    expect(tracingFactory).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(otelFactory).not.toHaveBeenCalled();
    expect(sdkNodeFactory).not.toHaveBeenCalled();
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
    expect(LangfuseClientCtor).not.toHaveBeenCalled();
  });
});

describe("createTracer (enabled mode)", () => {
  const enabledConfig = {
    enabled: true as const,
    publicKey: "pk-test",
    secretKey: "sk-test",
    host: "https://us.cloud.langfuse.com",
  };

  it("registers the OTEL SDK and constructs the LangfuseClient with credentials", async () => {
    await createTracer(enabledConfig);
    // OTEL setup wired through, in order: span processor → NodeSDK → start → tracer provider hand-off.
    expect(LangfuseSpanProcessorCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: "pk-test",
        secretKey: "sk-test",
        baseUrl: "https://us.cloud.langfuse.com",
      })
    );
    expect(NodeSDKCtor).toHaveBeenCalledTimes(1);
    expect(sdkNodeStart).toHaveBeenCalledTimes(1);
    expect(setLangfuseTracerProvider).toHaveBeenCalledTimes(1);
    expect(LangfuseClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: "pk-test",
        secretKey: "sk-test",
        baseUrl: "https://us.cloud.langfuse.com",
      })
    );
  });

  it("startTrace creates a root observation with input + metadata and sets trace-level OTEL attributes", async () => {
    const tracer = await createTracer(enabledConfig);
    tracer.startTrace({
      name: "mcp.request:Read",
      sessionId: "sess-1",
      userId: "agent-coder",
      tags: ["coder"],
      metadata: { method: "tools/call", requestId: 7, correlationId: "abc" },
      input: { tool: "Read", requestId: 7, method: "tools/call", correlationId: "abc" },
    });
    expect(startObservation).toHaveBeenCalledTimes(1);
    expect(startObservation).toHaveBeenCalledWith(
      "mcp.request:Read",
      expect.objectContaining({
        input: expect.objectContaining({ tool: "Read", requestId: 7 }),
        metadata: expect.objectContaining({ method: "tools/call" }),
      })
    );
    // Trace-level fields go on the root observation's OTEL span via the
    // LangfuseOtelSpanAttributes registry.
    expect(otelSpanSetAttribute).toHaveBeenCalledWith("MOCK_TRACE_NAME", "mcp.request:Read");
    expect(otelSpanSetAttribute).toHaveBeenCalledWith("MOCK_TRACE_SESSION_ID", "sess-1");
    expect(otelSpanSetAttribute).toHaveBeenCalledWith("MOCK_TRACE_USER_ID", "agent-coder");
    expect(otelSpanSetAttribute).toHaveBeenCalledWith("MOCK_TRACE_TAGS", JSON.stringify(["coder"]));
    expect(otelSpanSetAttribute).toHaveBeenCalledWith(
      "MOCK_TRACE_INPUT",
      expect.stringContaining('"tool":"Read"')
    );
  });

  it("ActiveTrace.span creates a child mcp.tool_call observation and ends it immediately", async () => {
    const tracer = await createTracer(enabledConfig);
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    active.span({ tool: "Read", status: "allowed", durationMs: 12, flags: ["pf1"] });
    expect(startChildObservation).toHaveBeenCalledTimes(1);
    expect(startChildObservation).toHaveBeenCalledWith(
      "mcp.tool_call",
      expect.objectContaining({
        metadata: { tool: "Read", status: "allowed", durationMs: 12, flags: ["pf1"] },
      })
    );
    // Child observation closed in the same call — span semantics are point-in-time.
    expect(childObsEnd).toHaveBeenCalledTimes(1);
  });

  it("ActiveTrace.end updates the root with output + outcome, sets trace tags/output, and ends the root", async () => {
    const tracer = await createTracer(enabledConfig);
    const active = tracer.startTrace({ name: "mcp.request:Read", tags: ["coder"] });
    active.span({ tool: "Read", status: "allowed", durationMs: 12 });
    active.end({ outcome: "allowed", output: { outcome: "allowed" } });
    expect(rootObsUpdate).toHaveBeenCalledTimes(1);
    expect(rootObsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        output: { outcome: "allowed" },
        metadata: { outcome: "allowed" },
      })
    );
    expect(rootObsEnd).toHaveBeenCalledTimes(1);
    // TRACE_TAGS gets set both at start (initial tags) and again at end (with status: + outcome: appended).
    const tagCalls = otelSpanSetAttribute.mock.calls.filter((c) => c[0] === "MOCK_TRACE_TAGS");
    expect(tagCalls.length).toBeGreaterThanOrEqual(2);
    const finalTags = JSON.parse(tagCalls[tagCalls.length - 1]![1] as string);
    expect(finalTags).toEqual(expect.arrayContaining(["coder", "status:allowed", "outcome:allowed"]));
    // TRACE_OUTPUT gets set at end.
    expect(otelSpanSetAttribute).toHaveBeenCalledWith(
      "MOCK_TRACE_OUTPUT",
      expect.stringContaining('"outcome":"allowed"')
    );
  });

  it("ActiveTrace.end is idempotent — second call is a no-op at the SDK level", async () => {
    const tracer = await createTracer(enabledConfig);
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    active.end({ outcome: "allowed" });
    active.end({ outcome: "error" });
    active.end({ outcome: "blocked" });
    expect(rootObsUpdate).toHaveBeenCalledTimes(1);
    expect(rootObsEnd).toHaveBeenCalledTimes(1);
    // span() after end() is also a no-op — the session is closed.
    active.span({ tool: "Read", status: "allowed", durationMs: 1 });
    expect(startChildObservation).not.toHaveBeenCalled();
  });

  it("swallows SDK errors thrown inside ActiveTrace.span", async () => {
    startChildObservation.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const tracer = await createTracer(enabledConfig);
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    expect(() => active.span({ tool: "Read", status: "allowed", durationMs: 1 })).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("swallows SDK errors thrown inside ActiveTrace.end", async () => {
    rootObsUpdate.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const tracer = await createTracer(enabledConfig);
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    expect(() => active.end({ outcome: "allowed" })).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("startTrace SDK failure returns the no-op sentinel", async () => {
    startObservation.mockImplementationOnce(() => {
      throw new Error("trace boom");
    });
    const tracer = await createTracer(enabledConfig);
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    expect(active).toBe(getNoopActiveTrace());
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("flush delegates to LangfuseClient.flush", async () => {
    const tracer = await createTracer(enabledConfig);
    await tracer.flush();
    expect(langfuseClientFlush).toHaveBeenCalledTimes(1);
  });

  it("shutdown flushes the client, shuts down the OTEL SDK, then shuts down the client", async () => {
    const order: string[] = [];
    langfuseClientFlush.mockImplementationOnce(async () => {
      order.push("client.flush");
    });
    sdkNodeShutdown.mockImplementationOnce(async () => {
      order.push("otel.shutdown");
    });
    langfuseClientShutdown.mockImplementationOnce(async () => {
      order.push("client.shutdown");
    });
    const tracer = await createTracer(enabledConfig);
    await tracer.shutdown();
    expect(order).toEqual(["client.flush", "otel.shutdown", "client.shutdown"]);
  });

  it("shutdown swallows errors from any phase — proxy must shut down cleanly even if Langfuse hangs", async () => {
    sdkNodeShutdown.mockRejectedValueOnce(new Error("otel hung"));
    const tracer = await createTracer(enabledConfig);
    await expect(tracer.shutdown()).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

describe("input sanitization invariant (#sensitive-data-hygiene)", () => {
  it("the wrapper does not inspect or filter input — sanitization is the caller's responsibility", async () => {
    // This is a contract-level test: the wrapper accepts whatever input is
    // passed and forwards it to the SDK. It does NOT silently drop fields.
    // Sensitive-data hygiene (whitelist what's safe to trace) lives at the
    // call site in src/mcp-proxy/server.ts — this test exists to make that
    // boundary explicit so a future refactor doesn't push sanitization into
    // the wrapper (which would create a false sense of security).
    const tracer = await createTracer({
      enabled: true,
      publicKey: "pk",
      secretKey: "sk",
      host: "https://us.cloud.langfuse.com",
    });
    tracer.startTrace({
      name: "mcp.request:Read",
      input: { tool: "Read", requestId: 7, dangerous: "this would not be passed by server.ts" },
    });
    expect(startObservation).toHaveBeenCalledWith(
      "mcp.request:Read",
      expect.objectContaining({
        input: expect.objectContaining({ dangerous: "this would not be passed by server.ts" }),
      })
    );
  });
});
