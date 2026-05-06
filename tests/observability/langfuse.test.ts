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
// _tracerProvider is private API on NodeSDK. We read it directly because the
// public `@opentelemetry/api` `trace.getTracerProvider()` returns a
// `ProxyTracerProvider` that does not work with `setLangfuseTracerProvider`
// — see the long comment in src/observability/langfuse.ts for rationale.
let nodeSDKTracerProvider: unknown = { __sentinel: "tracerProvider" };
const NodeSDKCtor = vi.fn(function (this: any) {
  this.start = sdkNodeStart;
  this.shutdown = sdkNodeShutdown;
  this._tracerProvider = nodeSDKTracerProvider;
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
  nodeSDKTracerProvider = { __sentinel: "tracerProvider" };
  tracingFactory.mockClear();
  clientFactory.mockClear();
  otelFactory.mockClear();
  sdkNodeFactory.mockClear();
  coreFactory.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.debug.mockClear();
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
    // We read NodeSDK's private `_tracerProvider` field directly because the
    // public `@opentelemetry/api` getTracerProvider returns a wrapper that
    // doesn't work with setLangfuseTracerProvider. See the long comment in
    // src/observability/langfuse.ts for the empirical rationale (reviewer C2).
    expect(setLangfuseTracerProvider).toHaveBeenCalledWith(
      expect.objectContaining({ __sentinel: "tracerProvider" })
    );
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

  // Reviewer I4: standalone flush() is called from the SIGTERM handler outside
  // shutdown(); a rejection there must be swallowed and warn-logged so the
  // process exit isn't blocked by a Langfuse network hiccup.
  it("flush swallows LangfuseClient.flush rejections (no propagation, warn logged)", async () => {
    langfuseClientFlush.mockRejectedValueOnce(new Error("network timeout"));
    const tracer = await createTracer(enabledConfig);
    await expect(tracer.flush()).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
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

  // Reviewer I2: each shutdown phase must time out independently so a single
  // hanging upstream cannot starve later phases of the global shutdown budget.
  it("shutdown phases have independent timeouts — a hanging client.flush does not block sdk.shutdown", async () => {
    let sdkShutdownStarted = false;
    // client.flush hangs forever (resolved by the per-phase timeout).
    langfuseClientFlush.mockImplementationOnce(() => new Promise(() => {}));
    // sdk.shutdown should still run after the flush phase times out.
    sdkNodeShutdown.mockImplementationOnce(async () => {
      sdkShutdownStarted = true;
    });
    const tracer = await createTracer(enabledConfig);
    // Wrap with our own outer timeout so a regression hanging both phases
    // doesn't make this test stall the whole suite.
    await Promise.race([
      tracer.shutdown(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("test outer timeout")), 5000)),
    ]);
    expect(sdkShutdownStarted).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
      expect.stringContaining("client.flush timed out")
    );
  });

  // Reviewer I1: silent loss of trace enrichment if the SDK runtime shape
  // diverges (no otelSpan on the root observation). Warn ONCE per process so
  // the per-request hot path stays quiet but operators get a signal.
  it("warns once if rootObs.otelSpan is undefined (SDK shape divergence — silent enrichment loss otherwise)", async () => {
    startObservation.mockImplementation(() => ({
      update: rootObsUpdate,
      end: rootObsEnd,
      startObservation: startChildObservation,
      // otelSpan deliberately undefined.
    }));
    const tracer = await createTracer(enabledConfig);
    tracer.startTrace({ name: "mcp.request:A" });
    tracer.startTrace({ name: "mcp.request:B" });
    tracer.startTrace({ name: "mcp.request:C" });
    const matching = mockLogger.warn.mock.calls.filter((c) =>
      typeof c[0] === "string"
        ? c[0].includes("rootObs.otelSpan is undefined")
        : typeof c[1] === "string" && c[1].includes("rootObs.otelSpan is undefined")
    );
    expect(matching).toHaveLength(1);
  });

  // Reviewer C2 (warn fallback): if a future @opentelemetry/sdk-node release
  // renames or removes the private `_tracerProvider` field, the wrapper must
  // warn loudly rather than silently lose all traces. The "use the public
  // OTEL API" half of the C2 advice was infeasible (returns a hollow proxy);
  // the warn fallback is the practical defense.
  it("warns when NodeSDK._tracerProvider is undefined (private field absent — silent ingestion failure otherwise)", async () => {
    nodeSDKTracerProvider = undefined;
    await createTracer(enabledConfig);
    const matching = mockLogger.warn.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("NodeSDK._tracerProvider is undefined")
    );
    expect(matching).toHaveLength(1);
  });

  // Reviewer C3: a partial failure inside end() must leave `ended = false`
  // so a subsequent retry from server.ts's outer catch can attempt cleanup.
  // OTEL span.end() is idempotent so the retry is safe.
  it("end leaves ended=false when rootObs.update throws — retry path is intact", async () => {
    rootObsUpdate.mockImplementationOnce(() => {
      throw new Error("update boom");
    });
    const tracer = await createTracer(enabledConfig);
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    active.end({ outcome: "error" });
    // First call failed inside the try; second call should still attempt the
    // SDK calls (which now succeed) — proves ended was NOT prematurely flipped.
    rootObsUpdate.mockImplementationOnce(() => {});
    active.end({ outcome: "error" });
    // Two attempts total at update; rootObs.end called once on the successful retry.
    expect(rootObsUpdate).toHaveBeenCalledTimes(2);
    expect(rootObsEnd).toHaveBeenCalledTimes(1);
  });

  // Reviewer S8: end() without an output param must NOT set TRACE_OUTPUT —
  // the guard prevents the literal string "undefined" from appearing in the UI.
  it("end without output does not set TRACE_OUTPUT", async () => {
    const tracer = await createTracer(enabledConfig);
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    active.end({ outcome: "allowed" });
    const outputCalls = otelSpanSetAttribute.mock.calls.filter((c) => c[0] === "MOCK_TRACE_OUTPUT");
    expect(outputCalls).toHaveLength(0);
  });
});

// Reviewer I3: safeSerialize is the safety net for OTEL attribute values.
// All three branches need coverage so a future refactor that removes the
// try/catch (or the string-passthrough) is caught by tests.
describe("safeSerialize behavior (via TRACE_INPUT roundtrip)", () => {
  const enabledConfig = {
    enabled: true as const,
    publicKey: "pk",
    secretKey: "sk",
    host: "https://us.cloud.langfuse.com",
  };

  it("string passthrough — TRACE_INPUT receives the literal string unchanged", async () => {
    const tracer = await createTracer(enabledConfig);
    tracer.startTrace({ name: "x", input: "hello world" });
    expect(otelSpanSetAttribute).toHaveBeenCalledWith("MOCK_TRACE_INPUT", "hello world");
  });

  it("object input — TRACE_INPUT receives JSON.stringify output", async () => {
    const tracer = await createTracer(enabledConfig);
    tracer.startTrace({ name: "x", input: { tool: "Read", requestId: 42 } });
    expect(otelSpanSetAttribute).toHaveBeenCalledWith(
      "MOCK_TRACE_INPUT",
      JSON.stringify({ tool: "Read", requestId: 42 })
    );
  });

  it("circular reference — TRACE_INPUT falls back to [unserializable] without throwing", async () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const tracer = await createTracer(enabledConfig);
    expect(() => tracer.startTrace({ name: "x", input: circular })).not.toThrow();
    expect(otelSpanSetAttribute).toHaveBeenCalledWith("MOCK_TRACE_INPUT", "[unserializable]");
  });

  it("BigInt — TRACE_INPUT falls back to [unserializable] without throwing", async () => {
    const tracer = await createTracer(enabledConfig);
    expect(() =>
      tracer.startTrace({ name: "x", input: { count: BigInt("9007199254740993") } })
    ).not.toThrow();
    expect(otelSpanSetAttribute).toHaveBeenCalledWith("MOCK_TRACE_INPUT", "[unserializable]");
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
