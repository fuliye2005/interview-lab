import { describe, expect, it } from "vitest";
import { createAsrPreset, createDefaultAsrConfig } from "../types";

describe("Aliyun NLS default configuration", () => {
  it("uses the realtime transcription endpoint and protocol messages", () => {
    const config = createDefaultAsrConfig();

    expect(config.protocol).toBe("aliyun-nls");
    expect(config.wsUrl).toContain("nls-gateway.cn-shanghai.aliyuncs.com/ws/v1?token={{apiKey}}");
    expect(config.initMessage).toContain("StartTranscription");
    expect(config.initMessage).toContain("enable_intermediate_result");
    expect(config.initMessage).toContain("enable_punctuation_prediction");
    expect(config.initMessage).toContain("enable_inverse_text_normalization");
    expect(config.finalizeMessage).toContain("StopTranscription");
  });
});

describe("ASR presets", () => {
  it("includes separate Aliyun trial and production presets", () => {
    expect(createAsrPreset("aliyun-trial").appKey).toBe("94JTbZd4OWiLVzv9");
    expect(createAsrPreset("aliyun-nls").appKey).toBe("");
  });

  it("includes Volcengine streaming credentials and PCM settings", () => {
    const config = createAsrPreset("volcengine-asr");

    expect(config.wsUrl).toBe("wss://openspeech.bytedance.com/api/v2/asr");
    expect(config.protocol).toBe("volcengine-asr");
    expect(config.initMessage).toContain("{{appId}}");
    expect(config.initMessage).toContain("{{cluster}}");
    expect(config.initMessage).toContain("nlu_punctuate");
  });
});
