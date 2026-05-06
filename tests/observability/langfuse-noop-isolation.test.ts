import { describe, it, expect, vi } from "vitest";

/**
 * I8 — Isolated test for the headline guarantee of this feature:
 *
 *   When Langfuse is disabled, the v5 SDK packages must NEVER be imported.
 *   That keeps observability a true optional dependency — a deployment that
 *   doesn't install `@langfuse/*` or `@opentelemetry/sdk-node` still works
 *   when tracing is off.
 *
 * This test is intentionally standalone (its own file, its own mock factories,
 * no shared beforeEach) so the guarantee cannot be broken by test-ordering or
 * mock-state drift in other observability tests.
 *
 * v5 changed the package layout: the single `langfuse` package became
 * `@langfuse/tracing`, `@langfuse/client`, `@langfuse/otel`, plus the
 * `@opentelemetry/sdk-node` runtime requirement. We assert all four factories
 * stay untouched on the disabled path.
 */

const tracingFactory = vi.fn(() => ({
  startObservation: vi.fn(),
  setLangfuseTracerProvider: vi.fn(),
}));
vi.mock("@langfuse/tracing", () => tracingFactory());

const clientFactory = vi.fn(() => ({
  LangfuseClient: vi.fn(function (this: { flush: () => Promise<void>; shutdown: () => Promise<void> }) {
    this.flush = async () => {};
    this.shutdown = async () => {};
  }),
}));
vi.mock("@langfuse/client", () => clientFactory());

const otelFactory = vi.fn(() => ({
  LangfuseSpanProcessor: vi.fn(),
}));
vi.mock("@langfuse/otel", () => otelFactory());

const sdkNodeFactory = vi.fn(() => ({
  NodeSDK: vi.fn(function (this: { start: () => void; shutdown: () => Promise<void> }) {
    this.start = () => {};
    this.shutdown = async () => {};
  }),
}));
vi.mock("@opentelemetry/sdk-node", () => sdkNodeFactory());

const coreFactory = vi.fn(() => ({
  LangfuseOtelSpanAttributes: {},
}));
vi.mock("@langfuse/core", () => coreFactory());

describe("createTracer isolation (#I8)", () => {
  it("never loads any @langfuse/* or OTEL module on the disabled path", async () => {
    // Fresh import inside the test: because this file has no shared
    // beforeEach mutating mock state, and because each `vi.mock(...)`
    // factory only runs when something imports the corresponding module,
    // we can assert the factories have never been called after
    // createTracer({ enabled: false }).
    const { createTracer, getNoopActiveTrace } = await import(
      "../../src/observability/langfuse.js"
    );
    const tracer = await createTracer({ enabled: false });
    expect(tracer).toBeDefined();

    // None of the v5 SDK package factories may be invoked on the disabled path.
    expect(tracingFactory).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(otelFactory).not.toHaveBeenCalled();
    expect(sdkNodeFactory).not.toHaveBeenCalled();
    expect(coreFactory).not.toHaveBeenCalled();

    // startTrace on the disabled path returns the frozen NOOP sentinel —
    // calling span/end on it is a no-op and allocates nothing.
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    expect(active).toBe(getNoopActiveTrace());
    active.span({ tool: "Read", status: "allowed", durationMs: 0 });
    active.end({ outcome: "allowed" });

    // Re-assert post-use: the disabled tracer's methods must not lazily
    // trigger any SDK import.
    expect(tracingFactory).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(otelFactory).not.toHaveBeenCalled();
    expect(sdkNodeFactory).not.toHaveBeenCalled();
    expect(coreFactory).not.toHaveBeenCalled();
  });
});
