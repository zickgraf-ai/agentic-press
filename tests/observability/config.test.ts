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

import { loadLangfuseConfig, loadMetricsConfig } from "../../src/observability/config.js";

describe("loadLangfuseConfig", () => {
  it("returns disabled when LANGFUSE_PUBLIC_KEY is missing", () => {
    const cfg = loadLangfuseConfig({ LANGFUSE_SECRET_KEY: "sk-test" });
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled when LANGFUSE_SECRET_KEY is missing", () => {
    const cfg = loadLangfuseConfig({ LANGFUSE_PUBLIC_KEY: "pk-test" });
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled when both keys are empty strings", () => {
    const cfg = loadLangfuseConfig({ LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" });
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled with empty env", () => {
    const cfg = loadLangfuseConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it("returns enabled with default host when both keys are present", () => {
    const cfg = loadLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
    });
    expect(cfg.enabled).toBe(true);
    if (cfg.enabled) {
      expect(cfg.publicKey).toBe("pk-test");
      expect(cfg.secretKey).toBe("sk-test");
      expect(cfg.host).toBe("https://cloud.langfuse.com");
    }
  });

  it("warns and returns disabled when only LANGFUSE_PUBLIC_KEY is set (#C4)", () => {
    mockLogger.warn.mockClear();
    const cfg = loadLangfuseConfig({ LANGFUSE_PUBLIC_KEY: "pk-test" });
    expect(cfg.enabled).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0]![0]).toContain("only one credential is set");
  });

  it("warns and returns disabled when only LANGFUSE_SECRET_KEY is set (#C4)", () => {
    mockLogger.warn.mockClear();
    const cfg = loadLangfuseConfig({ LANGFUSE_SECRET_KEY: "sk-test" });
    expect(cfg.enabled).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0]![0]).toContain("only one credential is set");
  });

  it("does not warn when both keys are missing", () => {
    mockLogger.warn.mockClear();
    loadLangfuseConfig({});
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("honors a custom LANGFUSE_HOST", () => {
    const cfg = loadLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_HOST: "https://langfuse.example.com",
    });
    expect(cfg.enabled).toBe(true);
    if (cfg.enabled) {
      expect(cfg.host).toBe("https://langfuse.example.com");
    }
  });
});

describe("loadMetricsConfig", () => {
  it("returns disabled when METRICS_PORT is missing", () => {
    const cfg = loadMetricsConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled when METRICS_PORT is empty string", () => {
    const cfg = loadMetricsConfig({ METRICS_PORT: "" });
    expect(cfg.enabled).toBe(false);
  });

  it("returns enabled with parsed port when METRICS_PORT is a valid integer", () => {
    const cfg = loadMetricsConfig({ METRICS_PORT: "9090" });
    expect(cfg.enabled).toBe(true);
    if (cfg.enabled) {
      expect(cfg.port).toBe(9090);
    }
  });

  it("warns and returns disabled when METRICS_PORT is non-numeric", () => {
    mockLogger.warn.mockClear();
    const cfg = loadMetricsConfig({ METRICS_PORT: "abc" });
    expect(cfg.enabled).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("warns and returns disabled when METRICS_PORT is 0", () => {
    mockLogger.warn.mockClear();
    const cfg = loadMetricsConfig({ METRICS_PORT: "0" });
    expect(cfg.enabled).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("warns and returns disabled when METRICS_PORT is out of range high", () => {
    mockLogger.warn.mockClear();
    const cfg = loadMetricsConfig({ METRICS_PORT: "65536" });
    expect(cfg.enabled).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("does not warn when METRICS_PORT is missing entirely", () => {
    mockLogger.warn.mockClear();
    loadMetricsConfig({});
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("trims whitespace from METRICS_PORT", () => {
    const cfg = loadMetricsConfig({ METRICS_PORT: "  9090  " });
    expect(cfg.enabled).toBe(true);
    if (cfg.enabled) {
      expect(cfg.port).toBe(9090);
    }
  });
});
