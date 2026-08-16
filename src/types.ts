export type LlmProtocol = "responses" | "chat-completions";

export interface LlmProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: LlmProtocol;
  requestPath?: string;
  extraHeaders?: string;
  contextWindow?: number;
}

export interface AsrProviderConfig {
  name: string;
  wsUrl: string;
  apiKey: string;
  extraHeaders?: string;
  initMessage?: string;
  audioMode: "binary" | "json-base64";
  audioTemplate?: string;
  finalizeMessage?: string;
  partialEvent?: string;
  finalEvent?: string;
  errorEvent?: string;
  textPath?: string;
  eventPath?: string;
  timeoutMs: number;
  debug: boolean;
}

export interface MaterialContext {
  resume: string;
  jobDescription: string;
  personalNotes: string;
  candidateSummary: string;
  jobSummary: string;
  confirmed: boolean;
}

export interface SessionRecord {
  id: string;
  createdAt: string;
  question: string;
  answer: string;
  asrName: string;
  llmName: string;
  error?: string;
}

export type AsrStatus = "idle" | "connecting" | "listening" | "finalizing" | "error";
export type AnswerStatus = "idle" | "generating" | "complete" | "error";

export interface AppSettings {
  asr: AsrProviderConfig;
  llmProfiles: LlmProfile[];
  activeLlmProfileId: string;
  shortcut: string;
}

export const createDefaultAsrConfig = (): AsrProviderConfig => ({
  name: "我的实时 ASR",
  wsUrl: "",
  apiKey: "",
  extraHeaders: "",
  initMessage: "{}",
  audioMode: "binary",
  audioTemplate: '{"audio":"{{base64}}"}',
  finalizeMessage: '{"event":"finish"}',
  partialEvent: "partial",
  finalEvent: "final",
  errorEvent: "error",
  eventPath: "type",
  textPath: "text",
  timeoutMs: 10000,
  debug: false,
});

export const createDefaultLlmProfile = (): LlmProfile => ({
  id: crypto.randomUUID(),
  name: "我的文本模型",
  baseUrl: "",
  apiKey: "",
  model: "",
  protocol: "chat-completions",
  requestPath: "",
  extraHeaders: "",
  contextWindow: 8000,
});
