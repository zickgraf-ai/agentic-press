import { describe, it, expect, vi } from "vitest";

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

import { loadDashboardConfig } from "../../src/dashboard/config.js";

describe("loadDashboardConfig", () => {
  it("returns enabled: false when no env vars set", () => {
    const config = loadDashboardConfig({});
    expect(config).toEqual({ enabled: false });
  });

  it("returns enabled: true with url and apiKey when both set", () => {
    const config = loadDashboardConfig({
      MISSION_CONTROL_URL: "http://localhost:3000",
      MISSION_CONTROL_API_KEY: "test-key-123",
    });
    expect(config).toEqual({
      enabled: true,
      url: "http://localhost:3000",
      apiKey: "test-key-123",
    });
  });

  it("returns enabled: true without apiKey when only URL is set", () => {
    const config = loadDashboardConfig({
      MISSION_CONTROL_URL: "http://localhost:3000",
    });
    expect(config).toEqual({
      enabled: true,
      url: "http://localhost:3000",
    });
  });

  it("returns enabled: false and warns when only API key is set (no URL)", () => {
    mockLogger.warn.mockClear();
    const config = loadDashboardConfig({
      MISSION_CONTROL_API_KEY: "orphan-key",
    });
    expect(config).toEqual({ enabled: false });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("MISSION_CONTROL_API_KEY is set without MISSION_CONTROL_URL")
    );
  });

  it("returns enabled: false when URL is empty string", () => {
    const config = loadDashboardConfig({
      MISSION_CONTROL_URL: "",
    });
    expect(config).toEqual({ enabled: false });
  });

  it("returns enabled: false when URL is whitespace-only", () => {
    const config = loadDashboardConfig({
      MISSION_CONTROL_URL: "   ",
    });
    expect(config).toEqual({ enabled: false });
  });

  it("trims whitespace from URL", () => {
    const config = loadDashboardConfig({
      MISSION_CONTROL_URL: "  http://localhost:3000  ",
    });
    expect(config).toEqual({ enabled: true, url: "http://localhost:3000" });
  });

  it("strips trailing slash from URL", () => {
    const config = loadDashboardConfig({
      MISSION_CONTROL_URL: "http://localhost:3000/",
    });
    expect(config).toEqual({ enabled: true, url: "http://localhost:3000" });
  });

  it("strips multiple trailing slashes from URL", () => {
    const config = loadDashboardConfig({
      MISSION_CONTROL_URL: "http://localhost:3000///",
    });
    expect(config).toEqual({ enabled: true, url: "http://localhost:3000" });
  });
});
