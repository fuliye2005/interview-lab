export type LlmProtocol = "responses" | "chat-completions";
export type AnswerDetail = "concise" | "balanced" | "detailed";
export type ReasoningEffort = "none" | "low" | "medium" | "high";
export type AsrPreset = "aliyun-trial" | "aliyun-nls" | "volcengine-asr" | "generic";
export type InterviewFocus = "technical-business" | "technical-project" | "customer-solution" | "operations-delivery" | "team-collaboration";

export const INTERVIEW_FOCUS_LABELS: Record<InterviewFocus, string> = {
  "technical-business": "技术业务 / 项目岗位",
  "technical-project": "技术项目与方案岗位",
  "customer-solution": "售前 / 解决方案岗位",
  "operations-delivery": "实施 / 运维 / 技术支持岗位",
  "team-collaboration": "技术协作 / 管理岗位",
};

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
  answerDetail: AnswerDetail;
  reasoningEffort: ReasoningEffort;
}

export interface AsrProviderConfig {
  name: string;
  preset?: AsrPreset;
  protocol?: "generic" | "aliyun-nls" | "volcengine-asr";
  wsUrl: string;
  apiKey: string;
  appKey?: string;
  appId?: string;
  cluster?: string;
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

export interface InterviewTurn {
  question: string;
  answer: string;
}

export interface InterviewSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  asrName: string;
  llmName: string;
  sourceSessionId?: string;
  carriedTurnCount: number;
  turns: SessionRecord[];
}

export interface WheelScrollSettings {
  transcript: boolean;
  answer: boolean;
}

export type AsrStatus = "idle" | "connecting" | "listening" | "finalizing" | "error";
export type AnswerStatus = "idle" | "generating" | "complete" | "error";

export interface AppSettings {
  asr: AsrProviderConfig;
  asrProfiles: Partial<Record<AsrPreset, AsrProviderConfig>>;
  llmProfiles: LlmProfile[];
  activeLlmProfileId: string;
  shortcut: string;
  interviewFocus: InterviewFocus;
  sessionTitleDraft: string;
  wheelScroll: WheelScrollSettings;
}

const commonAsrConfig = (): Omit<AsrProviderConfig, "name" | "preset" | "protocol" | "wsUrl" | "apiKey" | "audioMode"> => ({
  extraHeaders: "",
  initMessage: "{}",
  audioTemplate: '{"audio":"{{base64}}"}',
  finalizeMessage: "{}",
  partialEvent: "partial",
  finalEvent: "final",
  errorEvent: "error",
  eventPath: "type",
  textPath: "text",
  timeoutMs: 10000,
  debug: false,
});

export const createAsrPreset = (preset: AsrPreset): AsrProviderConfig => {
  const common = commonAsrConfig();
  if (preset === "aliyun-trial" || preset === "aliyun-nls") {
    return {
      ...common,
      name: preset === "aliyun-trial" ? "阿里云智能语音交互（试用）" : "阿里云智能语音交互",
      preset,
      protocol: "aliyun-nls",
      wsUrl: "wss://nls-gateway.cn-shanghai.aliyuncs.com/ws/v1?token={{apiKey}}",
      apiKey: "",
      appKey: preset === "aliyun-trial" ? "94JTbZd4OWiLVzv9" : "",
      initMessage: '{"header":{"message_id":"{{messageId}}","task_id":"{{taskId}}","namespace":"SpeechTranscriber","name":"StartTranscription","appkey":"{{appKey}}"},"payload":{"format":"pcm","sample_rate":16000,"enable_intermediate_result":true,"enable_punctuation_prediction":true,"enable_inverse_text_normalization":true}}',
      audioMode: "binary",
      finalizeMessage: '{"header":{"message_id":"{{messageId}}","task_id":"{{taskId}}","namespace":"SpeechTranscriber","name":"StopTranscription","appkey":"{{appKey}}"}}',
      partialEvent: "TranscriptionResultChanged",
      finalEvent: "TranscriptionCompleted",
      errorEvent: "TaskFailed",
      eventPath: "header.name",
      textPath: "payload.result",
    };
  }
  if (preset === "volcengine-asr") {
    return {
      ...common,
      name: "豆包流式语音识别",
      preset,
      protocol: "volcengine-asr",
      wsUrl: "wss://openspeech.bytedance.com/api/v2/asr",
      apiKey: "",
      appId: "",
      cluster: "",
      initMessage: '{"app":{"appid":"{{appId}}","token":"{{apiKey}}","cluster":"{{cluster}}"},"user":{"uid":"interview-lab"},"audio":{"format":"raw","rate":16000,"bits":16,"channel":1,"language":"zh-CN"},"request":{"reqid":"{{taskId}}","sequence":1,"workflow":"audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate","nbest":1,"show_utterances":true,"result_type":"single","vad_signal":true,"vad_silence_time":"1000"}}',
      audioMode: "binary",
      finalizeMessage: "{}",
      partialEvent: "response",
      finalEvent: "response",
      errorEvent: "error",
      eventPath: "type",
      textPath: "result.0.text",
    };
  }
  return {
    ...common,
    name: "我的实时 ASR",
    preset,
    protocol: "generic",
    wsUrl: "",
    apiKey: "",
    audioMode: "binary",
    finalizeMessage: '{"event":"finish"}',
  };
};

export const createDefaultAsrConfig = () => createAsrPreset("aliyun-trial");

export const createDefaultLlmProfile = (): LlmProfile => ({
  id: crypto.randomUUID(),
  name: "我的文本模型",
  baseUrl: "https://cf-fast.cctq.ai/v1",
  apiKey: "",
  model: "",
  protocol: "chat-completions",
  requestPath: "",
  extraHeaders: "",
  contextWindow: 8000,
  answerDetail: "balanced",
  reasoningEffort: "none",
});
