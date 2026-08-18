import type { AsrPreset, AsrProviderConfig } from "../types";
import { createAsrPreset } from "../types";
import { GenericAsrSession } from "./asr";

export interface AsrProviderPreset {
  id: AsrPreset;
  label: string;
  description: string;
  credentialLabel: string;
  protocolLabel: string;
}

export const ASR_PROVIDER_PRESETS: AsrProviderPreset[] = [
  {
    id: "aliyun-trial",
    label: "阿里云试用",
    description: "阿里云智能语音交互试用 AppKey",
    credentialLabel: "临时 Token + AppKey",
    protocolLabel: "阿里云 NLS",
  },
  {
    id: "aliyun-nls",
    label: "阿里云正式",
    description: "阿里云智能语音交互正式项目",
    credentialLabel: "临时 Token + AppKey",
    protocolLabel: "阿里云 NLS",
  },
  {
    id: "volcengine-asr",
    label: "豆包流式识别",
    description: "火山引擎豆包流式语音识别",
    credentialLabel: "Access Token + App ID + Cluster",
    protocolLabel: "豆包二进制协议",
  },
  {
    id: "generic",
    label: "通用 WebSocket",
    description: "兼容自定义 JSON / WebSocket 服务",
    credentialLabel: "可选 Key / 请求头",
    protocolLabel: "通用 WebSocket",
  },
];

export type AsrErrorKind = "configuration" | "authentication" | "timeout" | "network" | "protocol" | "service" | "unknown";

export interface ClassifiedAsrError {
  kind: AsrErrorKind;
  label: string;
  message: string;
}

export interface AsrTestResult {
  latencyMs: number;
  finalText?: string;
}

export function asrProviderPreset(id: AsrPreset) {
  return ASR_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function asrProviderLabel(config: Pick<AsrProviderConfig, "preset" | "protocol">) {
  return asrProviderPreset(config.preset ?? "generic")?.label ?? (config.protocol === "aliyun-nls" ? "阿里云 NLS" : config.protocol === "volcengine-asr" ? "豆包流式识别" : "通用 WebSocket");
}

export function asrConfigReady(config: AsrProviderConfig) {
  if (!config.wsUrl.trim()) return false;
  if (config.protocol === "aliyun-nls") return Boolean(config.apiKey.trim() && config.appKey?.trim());
  if (config.protocol === "volcengine-asr") return Boolean(config.apiKey.trim() && config.appId?.trim() && config.cluster?.trim());
  return true;
}

export function asrMissingFields(config: AsrProviderConfig) {
  const fields: string[] = [];
  if (!config.wsUrl.trim()) fields.push("WebSocket 地址");
  if (config.protocol === "aliyun-nls") {
    if (!config.apiKey.trim()) fields.push("临时 Token");
    if (!config.appKey?.trim()) fields.push("AppKey");
  } else if (config.protocol === "volcengine-asr") {
    if (!config.apiKey.trim()) fields.push("Access Token");
    if (!config.appId?.trim()) fields.push("App ID");
    if (!config.cluster?.trim()) fields.push("Cluster");
  }
  return fields;
}

export function classifyAsrError(error: unknown): ClassifiedAsrError {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "ASR 请求失败";
  const lower = message.toLowerCase();
  if (message.includes("请先配置") || message.includes("必须") || message.includes("缺少") || message.includes("填写")) {
    return { kind: "configuration", label: "配置不完整", message };
  }
  if (/401|403|token|apikey|appkey|access.?token|鉴权|认证|授权/.test(lower)) {
    return { kind: "authentication", label: "鉴权失败", message };
  }
  if (/超时|timeout/.test(lower)) {
    return { kind: "timeout", label: "连接超时", message };
  }
  if (/websocket|network|网络|连接失败|连接已关闭|fetch/.test(lower)) {
    return { kind: "network", label: "网络连接", message };
  }
  if (/json|协议|protocol|消息|帧/.test(lower)) {
    return { kind: "protocol", label: "协议错误", message };
  }
  if (/服务|server|gateway|quota|限流/.test(lower)) {
    return { kind: "service", label: "服务端错误", message };
  }
  return { kind: "unknown", label: "未知错误", message };
}

export function asrConfigPreview(config: AsrProviderConfig) {
  return `provider = "${asrProviderLabel(config)}"
protocol = "${config.protocol || "generic"}"
ws_url = "${config.wsUrl || "未填写"}"
audio_mode = "${config.audioMode}"
timeout_ms = ${config.timeoutMs}
api_key = "${config.apiKey ? "********" : "未填写"}"
app_key = "${config.appKey ? "********" : "未填写"}"
app_id = "${config.appId || "未填写"}"
cluster = "${config.cluster || "未填写"}"`;
}

function asrTestCallbacks(finalText: (value: string) => void, errorText: (value: string) => void) {
  return {
    onStatus: () => undefined,
    onPartial: () => undefined,
    onFinal: finalText,
    onError: errorText,
  };
}

export async function testAsrConnection(config: AsrProviderConfig): Promise<AsrTestResult> {
  const missing = asrMissingFields(config);
  if (missing.length) throw new Error(`请先填写：${missing.join("、")}`);
  const startedAt = performance.now();
  let failure = "";
  const session = new GenericAsrSession(config, asrTestCallbacks(() => undefined, (message) => { failure = message; }));
  try {
    await session.connect();
    if (failure) throw new Error(failure);
    return { latencyMs: Math.round(performance.now() - startedAt) };
  } finally {
    session.close();
  }
}

export async function testAsrFinalText(config: AsrProviderConfig): Promise<AsrTestResult> {
  const missing = asrMissingFields(config);
  if (missing.length) throw new Error(`请先填写：${missing.join("、")}`);
  const startedAt = performance.now();
  let failure = "";
  let resolveFinal: ((text: string) => void) | undefined;
  const finalText = new Promise<string>((resolve) => { resolveFinal = resolve; });
  const session = new GenericAsrSession(config, asrTestCallbacks((text) => resolveFinal?.(text), (message) => { failure = message; }));
  try {
    await session.connect();
    session.sendAudio(new ArrayBuffer(3200));
    session.finalizeSegment();
    const timeoutMs = Math.max(2000, Math.min(8000, config.timeoutMs));
    const result = await Promise.race([
      finalText,
      new Promise<string>((resolve) => window.setTimeout(() => resolve(""), timeoutMs)),
    ]);
    if (failure) throw new Error(failure);
    if (!result.trim()) throw new Error("连接成功，但未收到最终文本事件；请用真实语音再验证一次。\n");
    return { latencyMs: Math.round(performance.now() - startedAt), finalText: result };
  } finally {
    session.close();
  }
}

export function createAsrProfile(preset: AsrPreset) {
  return createAsrPreset(preset);
}
