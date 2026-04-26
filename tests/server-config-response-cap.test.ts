import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  childLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

import { parseMaxResponseBytes } from "../src/server-config.js";
import { DEFAULT_MAX_RESPONSE_BYTES } from "../src/mcp-proxy/stdio-bridge.js";

/**
 * The MAX_RESPONSE_BYTES env-var parser is fail-loud by design — silently
 * coercing a typo into a number would mask config errors and re-expose
 * the OOM surface the cap exists to close. These tests pin both halves of
 * that contract: the canonical-decimal forms it accepts, and the
 * non-canonical forms it must reject.
 */
describe("parseMaxResponseBytes", () => {
  describe("valid inputs", () => {
    it.each([
      ["10485760", 10485760],
      ["0", 0],
      ["1", 1],
      ["10", 10],
      ["999999999", 999999999],
    ])("accepts canonical decimal %j → %i", (input, expected) => {
      expect(parseMaxResponseBytes(input)).toBe(expected);
    });

    it("returns the default when the env var is unset (undefined)", () => {
      expect(parseMaxResponseBytes(undefined)).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    });
  });

  describe("invalid inputs (must throw)", () => {
    // Each of these would silently parse to SOME number under naive parseInt,
    // masking a config typo. The round-trip canonical-form check rejects them.
    it.each([
      ["100abc"],   // trailing garbage; parseInt → 100
      ["1e7"],      // scientific notation; parseInt → 1
      ["+10"],      // leading plus; parseInt → 10
      ["010"],      // leading zero; parseInt(_, 10) → 10 but String(10) !== "010"
      ["0x10"],     // hex literal; parseInt(_, 10) → 0
      ["-1"],       // negative number rejected by n < 0 check
      ["abc"],      // pure text; parseInt → NaN
      [""],         // empty string; parseInt → NaN
      ["  "],       // whitespace only; parseInt → NaN after trim
      ["1.5"],      // decimal; parseInt → 1
      ["1 2"],      // embedded whitespace
    ])("rejects %j", (input) => {
      expect(() => parseMaxResponseBytes(input)).toThrow(/MAX_RESPONSE_BYTES/);
    });
  });
});
