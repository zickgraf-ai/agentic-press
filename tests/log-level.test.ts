import { describe, it, expect, vi } from "vitest";
import { parseLogLevel, levelAtLeast } from "../src/types.js";

describe("parseLogLevel", () => {
  it("returns 'info' for undefined", () => {
    expect(parseLogLevel(undefined)).toBe("info");
  });

  it("returns 'info' for empty string", () => {
    expect(parseLogLevel("")).toBe("info");
  });

  it.each(["debug", "info", "warn", "error"] as const)("accepts %s exactly", (level) => {
    expect(parseLogLevel(level)).toBe(level);
  });

  it.each(["DEBUG", "Info", "WARN", "Error"])("normalizes case: %s", (input) => {
    expect(parseLogLevel(input)).toBe(input.toLowerCase());
  });

  it("warns and falls back to 'info' for unknown values", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseLogLevel("verbose")).toBe("info");
      expect(parseLogLevel("trace")).toBe("info");
      expect(parseLogLevel("garbage")).toBe("info");
      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy.mock.calls[0][0]).toContain("Unknown LOG_LEVEL");
    } finally {
      spy.mockRestore();
    }
  });

  // Regression: the `in` operator walks Object.prototype, so without Object.hasOwn
  // these would all be returned as if they were valid log levels.
  it.each(["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"])(
    "rejects prototype-chain pollution: %s",
    (poison) => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(parseLogLevel(poison)).toBe("info");
      } finally {
        spy.mockRestore();
      }
    }
  );
});

describe("levelAtLeast", () => {
  // Standard logger semantics: levelAtLeast(current, threshold) === "would a message tagged
  // 'threshold' be emitted given current minimum level?"

  it("debug current emits all levels", () => {
    expect(levelAtLeast("debug", "debug")).toBe(true);
    expect(levelAtLeast("debug", "info")).toBe(true);
    expect(levelAtLeast("debug", "warn")).toBe(true);
    expect(levelAtLeast("debug", "error")).toBe(true);
  });

  it("info current emits info, warn, error (but not debug)", () => {
    expect(levelAtLeast("info", "debug")).toBe(false);
    expect(levelAtLeast("info", "info")).toBe(true);
    expect(levelAtLeast("info", "warn")).toBe(true);
    expect(levelAtLeast("info", "error")).toBe(true);
  });

  it("warn current emits warn and error only", () => {
    expect(levelAtLeast("warn", "debug")).toBe(false);
    expect(levelAtLeast("warn", "info")).toBe(false);
    expect(levelAtLeast("warn", "warn")).toBe(true);
    expect(levelAtLeast("warn", "error")).toBe(true);
  });

  it("error current emits only error", () => {
    expect(levelAtLeast("error", "debug")).toBe(false);
    expect(levelAtLeast("error", "info")).toBe(false);
    expect(levelAtLeast("error", "warn")).toBe(false);
    expect(levelAtLeast("error", "error")).toBe(true);
  });
});
