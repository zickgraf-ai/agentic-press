import { describe, it, expect } from "vitest";
import { loadLangfuseConfig } from "../../src/observability/config.js";

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
