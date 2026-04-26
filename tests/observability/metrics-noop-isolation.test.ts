import { describe, it, expect, vi } from "vitest";

/**
 * Isolated test for the headline guarantee of the metrics module:
 *
 *   When metrics are disabled, the `prom-client` SDK module must NEVER be
 *   imported. That keeps prom-client a true optional dependency and means a
 *   deployment without the SDK installed still works when metrics are off.
 *
 * This test is intentionally standalone (its own file, its own mock factory,
 * no shared beforeEach) so the guarantee cannot be broken by test-ordering or
 * mock-state drift in other observability tests.
 */

const promClientFactory = vi.fn(() => ({
  Counter: vi.fn(),
  Histogram: vi.fn(),
  Registry: vi.fn(),
  collectDefaultMetrics: vi.fn(),
}));

vi.mock("prom-client", () => promClientFactory());

describe("createMetricsRecorder isolation", () => {
  it("never loads the prom-client module on the disabled path", async () => {
    const { createMetricsRecorder, getNoopRecorder } = await import(
      "../../src/observability/metrics.js"
    );
    const recorder = await createMetricsRecorder({ enabled: false });
    expect(recorder).toBeDefined();
    // The mock factory for `prom-client` is only invoked when the module is
    // actually imported. On the disabled path, it must not be touched.
    expect(promClientFactory).not.toHaveBeenCalled();
    // No-op recorder is the cached singleton.
    expect(recorder).toBe(getNoopRecorder());
    // Calling record methods must not trigger import either.
    recorder.recordRequest("Read", "allowed", 0);
    recorder.recordInjectionFlag("foo");
    recorder.recordBlockedRequest("bar");
    expect(promClientFactory).not.toHaveBeenCalled();
  });
});
