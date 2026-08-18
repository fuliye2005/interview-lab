import type { LlmProfile, LlmProviderPresetId, LlmProtocol } from "../types";

export interface LlmProviderPreset {
  id: Exclude<LlmProviderPresetId, "custom">;
  label: string;
  description: string;
  baseUrl: string;
  protocol: LlmProtocol;
  defaultModel: string;
  contextWindow: number;
}

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: "openai-compatible",
    label: "OpenAI Compatible",
    description: "兼容 Chat Completions 的通用入口",
    baseUrl: "https://api.openai.com/v1",
    protocol: "chat-completions",
    defaultModel: "gpt-4o-mini",
    contextWindow: 128000,
  },
  {
    id: "openai-responses",
    label: "OpenAI Responses",
    description: "使用 Responses API 和流式输出",
    baseUrl: "https://api.openai.com/v1",
    protocol: "responses",
    defaultModel: "gpt-4o-mini",
    contextWindow: 128000,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "统一接入多家模型供应商",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "chat-completions",
    defaultModel: "openai/gpt-4o-mini",
    contextWindow: 128000,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek Chat / Reasoner",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "chat-completions",
    defaultModel: "deepseek-chat",
    contextWindow: 64000,
  },
  {
    id: "kimi",
    label: "Kimi",
    description: "Moonshot OpenAI 兼容接口",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "chat-completions",
    defaultModel: "moonshot-v1-8k",
    contextWindow: 128000,
  },
  {
    id: "qwen",
    label: "通义千问",
    description: "DashScope 兼容模式",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "chat-completions",
    defaultModel: "qwen-plus",
    contextWindow: 128000,
  },
  {
    id: "doubao",
    label: "豆包",
    description: "火山方舟 OpenAI 兼容入口",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    protocol: "chat-completions",
    defaultModel: "",
    contextWindow: 128000,
  },
  {
    id: "ollama",
    label: "本地 Ollama",
    description: "本机模型，不强制填写 Key",
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "chat-completions",
    defaultModel: "qwen2.5:7b",
    contextWindow: 32768,
  },
];

export function providerLabel(profile: Pick<LlmProfile, "provider" | "preset">) {
  const id = profile.provider ?? profile.preset;
  return LLM_PROVIDER_PRESETS.find((preset) => preset.id === id)?.label ?? "自定义 Provider";
}

export function providerRequiresKey(profile: Pick<LlmProfile, "provider" | "preset">) {
  return (profile.provider ?? profile.preset) !== "ollama";
}

export function providerPreset(id: LlmProviderPresetId) {
  return LLM_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function applyLlmProviderPreset(profile: LlmProfile, id: LlmProviderPresetId): LlmProfile {
  if (id === "custom") return { ...profile, provider: "custom", preset: "custom" };
  const preset = providerPreset(id);
  if (!preset) return profile;
  return {
    ...profile,
    provider: id,
    preset: id,
    name: profile.name === "我的文本模型" || profile.name.endsWith(" 副本") ? preset.label : profile.name,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    model: profile.model || preset.defaultModel,
    contextWindow: profile.contextWindow && profile.contextWindow !== 8000 ? profile.contextWindow : preset.contextWindow,
    modelOptions: [],
    health: undefined,
  };
}
