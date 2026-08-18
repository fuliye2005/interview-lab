import { describe, expect, it } from "vitest";
import { ASR_PROVIDER_PRESETS, asrConfigPreview, asrConfigReady, asrMissingFields, classifyAsrError } from "./asr-providers";
import { createAsrPreset } from "../types";

describe("ASR provider presets", () => {
  it("exposes the four configured providers", () => {
    expect(ASR_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual(["aliyun-trial", "aliyun-nls", "volcengine-asr", "generic"]);
  });

  it("validates provider-specific credentials", () => {
    const aliyun = createAsrPreset("aliyun-nls");
    expect(asrConfigReady(aliyun)).toBe(false);
    expect(asrMissingFields(aliyun)).toEqual(["临时 Token", "AppKey"]);
    expect(asrConfigReady({ ...aliyun, apiKey: "token", appKey: "app" })).toBe(true);

    const volcengine = createAsrPreset("volcengine-asr");
    expect(asrMissingFields({ ...volcengine, apiKey: "token", appId: "app" })).toEqual(["Cluster"]);
  });

  it("keeps secrets out of the configuration preview", () => {
    const config = { ...createAsrPreset("generic"), apiKey: "secret-token" };
    expect(asrConfigPreview(config)).toContain('api_key = "********"');
    expect(asrConfigPreview(config)).not.toContain("secret-token");
  });
});

describe("ASR error classification", () => {
  it("distinguishes authentication and timeout errors", () => {
    const expired = classifyAsrError(new Error("401 token expired"));
    expect(expired.kind).toBe("authentication");
    expect(expired.label).toBe("Token 可能已过期");
    expect(expired.hint).toContain("重新获取临时 Token");
    expect(classifyAsrError(new Error("ASR WebSocket 连接超时")).kind).toBe("timeout");
  });
});
