import { describe, expect, it } from "vitest";
import { applyLlmProviderPreset, LLM_PROVIDER_PRESETS, providerLabel, providerRequiresKey } from "./providers";
import type { LlmProfile } from "../types";

const profile = (overrides: Partial<LlmProfile> = {}): LlmProfile => ({
  id: "provider-test",
  name: "我的文本模型",
  provider: "custom",
  preset: "custom",
  baseUrl: "https://example.test/v1",
  apiKey: "secret",
  model: "",
  modelOptions: [],
  protocol: "chat-completions",
  requestPath: "",
  extraHeaders: "",
  contextWindow: 8000,
  answerDetail: "balanced",
  reasoningEffort: "none",
  ...overrides,
});

describe("LLM provider presets", () => {
  it("contains the planned cloud and local providers", () => {
    expect(LLM_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      "openai-compatible",
      "openai-responses",
      "openrouter",
      "deepseek",
      "kimi",
      "qwen",
      "doubao",
      "ollama",
    ]);
  });

  it("applies a preset without replacing an existing key", () => {
    const result = applyLlmProviderPreset(profile({ health: { status: "success", testedAt: "2026-08-18T08:00:00.000Z", latencyMs: 42 } }), "deepseek");

    expect(result.provider).toBe("deepseek");
    expect(result.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(result.model).toBe("deepseek-chat");
    expect(result.apiKey).toBe("secret");
    expect(result.health).toBeUndefined();
    expect(result.contextWindow).toBe(64000);
    expect(providerLabel(result)).toBe("DeepSeek");
  });

  it("keeps a user model when applying a new preset", () => {
    const result = applyLlmProviderPreset(profile({ model: "my-model", contextWindow: 32000 }), "ollama");

    expect(result.model).toBe("my-model");
    expect(result.contextWindow).toBe(32000);
    expect(result.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  it("only exempts the local Ollama preset from a required key", () => {
    expect(providerRequiresKey(profile())).toBe(true);
    expect(providerRequiresKey(profile({ provider: "ollama", preset: "ollama" }))).toBe(false);
  });
});
