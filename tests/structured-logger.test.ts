import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { createLogger, childLogger } from "../src/logger.js";

function captureStream(): { stream: Writable; output: string[] } {
  const output: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output.push(chunk.toString());
      callback();
    },
  });
  return { stream, output };
}

function parseLines(output: string[]): Record<string, unknown>[] {
  return output
    .flatMap((c) => c.split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("structured logger", () => {
  describe("createLogger", () => {
    it("returns a pino logger with standard methods", () => {
      const { stream } = captureStream();
      const log = createLogger("info", stream);
      expect(typeof log.info).toBe("function");
      expect(typeof log.warn).toBe("function");
      expect(typeof log.error).toBe("function");
      expect(typeof log.debug).toBe("function");
    });

    it("outputs structured JSON with level, time, and msg", () => {
      const { stream, output } = captureStream();
      const log = createLogger("info", stream);
      log.info("test message");
      const lines = parseLines(output);
      expect(lines).toHaveLength(1);
      expect(lines[0].msg).toBe("test message");
      expect(lines[0].level).toBe(30); // pino info = 30
      expect(lines[0].time).toBeDefined();
    });

    it("respects log level filtering", () => {
      const { stream, output } = captureStream();
      const log = createLogger("warn", stream);
      log.debug("filtered");
      log.info("filtered");
      log.warn("visible");
      log.error("visible");
      const lines = parseLines(output);
      expect(lines).toHaveLength(2);
      expect(lines[0].msg).toBe("visible");
      expect(lines[1].msg).toBe("visible");
    });

    it("includes structured fields passed as first argument", () => {
      const { stream, output } = captureStream();
      const log = createLogger("info", stream);
      log.info({ correlationId: "abc123", server: "fs" }, "request handled");
      const lines = parseLines(output);
      expect(lines[0].correlationId).toBe("abc123");
      expect(lines[0].server).toBe("fs");
      expect(lines[0].msg).toBe("request handled");
    });

    it("defaults to 'info' level when no level specified", () => {
      const { stream, output } = captureStream();
      const log = createLogger(undefined, stream);
      log.debug("should not appear");
      log.info("should appear");
      const lines = parseLines(output);
      expect(lines).toHaveLength(1);
      expect(lines[0].msg).toBe("should appear");
    });
  });

  describe("child loggers", () => {
    it("creates a child with module binding", () => {
      const { stream, output } = captureStream();
      const log = createLogger("info", stream);
      const child = log.child({ module: "test-module" });
      child.info("child message");
      const lines = parseLines(output);
      expect(lines[0].module).toBe("test-module");
      expect(lines[0].msg).toBe("child message");
    });

    it("child inherits parent level", () => {
      const { stream, output } = captureStream();
      const log = createLogger("error", stream);
      const child = log.child({ module: "strict" });
      child.info("filtered");
      child.warn("filtered");
      child.error("visible");
      const lines = parseLines(output);
      expect(lines).toHaveLength(1);
      expect(lines[0].msg).toBe("visible");
    });

    it("child can add additional context via nested child", () => {
      const { stream, output } = captureStream();
      const log = createLogger("info", stream);
      const child = log.child({ module: "mcp-proxy" });
      const reqChild = child.child({ correlationId: "abc123" });
      reqChild.error({ error: "bridge timeout" }, "request failed");
      const lines = parseLines(output);
      expect(lines[0].module).toBe("mcp-proxy");
      expect(lines[0].correlationId).toBe("abc123");
      expect(lines[0].error).toBe("bridge timeout");
      expect(lines[0].msg).toBe("request failed");
    });
  });

  describe("module exports", () => {
    it("default export is a pino logger", async () => {
      const mod = await import("../src/logger.js");
      expect(typeof mod.default.info).toBe("function");
      expect(typeof mod.default.child).toBe("function");
    });

    it("childLogger is a named export that returns a child logger", () => {
      const child = childLogger("test");
      expect(typeof child.info).toBe("function");
      expect(typeof child.warn).toBe("function");
    });
  });
});
