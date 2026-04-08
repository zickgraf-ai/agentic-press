import { describe, it, expect, vi } from "vitest";

/**
 * I8 — Isolated test for the headline guarantee of this feature:
 *
 *   When Langfuse is disabled, the `langfuse` SDK module must NEVER be
 *   imported. That keeps Langfuse a true optional dependency and means a
 *   deployment without the SDK installed still works when tracing is off.
 *
 * This test is intentionally standalone (its own file, its own mock factory,
 * no shared beforeEach) so the guarantee cannot be broken by test-ordering or
 * mock-state drift in other observability tests.
 */

const langfuseFactory = vi.fn(() => ({
  Langfuse: vi.fn(function (this: { trace: () => unknown; flushAsync: () => Promise<void>; shutdownAsync: () => Promise<void> }) {
    this.trace = () => ({});
    this.flushAsync = async () => {};
    this.shutdownAsync = async () => {};
  }),
}));

vi.mock("langfuse", () => langfuseFactory());

describe("createTracer isolation (#I8)", () => {
  it("never loads the langfuse module on the disabled path", async () => {
    // Fresh import inside the test: because this file has no shared
    // beforeEach mutating mock state, and because the `vi.mock("langfuse")`
    // factory only runs when something imports "langfuse", we can assert
    // the factory has never been called after createTracer({ enabled: false }).
    const { createTracer, getNoopActiveTrace } = await import(
      "../../src/observability/langfuse.js"
    );
    const tracer = await createTracer({ enabled: false });
    expect(tracer).toBeDefined();
    // The mock factory for `langfuse` is only invoked when the module is
    // actually imported. On the disabled path, it must not be touched.
    expect(langfuseFactory).not.toHaveBeenCalled();
    // startTrace on the disabled path returns the frozen NOOP sentinel —
    // calling span/end on it is a no-op and allocates nothing.
    const active = tracer.startTrace({ name: "mcp.request:Read" });
    expect(active).toBe(getNoopActiveTrace());
    active.span({ tool: "Read", status: "allowed", durationMs: 0 });
    active.end({ outcome: "allowed" });
    expect(langfuseFactory).not.toHaveBeenCalled();
  });
});
