import type { AsrProviderConfig } from "../types";

export interface AsrCallbacks {
  onStatus: (status: "connecting" | "listening" | "error") => void;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onDebug?: (message: string) => void;
}

function parseJson(input: string | undefined, label: string) {
  if (!input?.trim()) return {};
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    throw new Error(`${label} 必须是合法 JSON`);
  }
}

function valueAtPath(value: unknown, path = ""): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object") return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

function base64(bytes: ArrayBuffer) {
  const items = new Uint8Array(bytes);
  let binary = "";
  for (const item of items) binary += String.fromCharCode(item);
  return btoa(binary);
}

export class GenericAsrSession {
  private socket?: WebSocket;
  private taskId = "";
  private started = false;
  private stoppedByClient = false;
  private sentenceResults = new Map<number, string>();

  private get isAliyunNls() {
    return this.config.protocol === "aliyun-nls";
  }

  private newId() {
    return crypto.randomUUID().replace(/-/g, "");
  }

  private interpolate(template: string, audioBase64 = "", messageId = this.newId()) {
    return template
      .split("{{apiKey}}").join(this.config.apiKey)
      .split("{{appKey}}").join(this.config.appKey || "")
      .split("{{appId}}").join(this.config.appId || "")
      .split("{{cluster}}").join(this.config.cluster || "")
      .split("{{messageId}}").join(messageId)
      .split("{{taskId}}").join(this.taskId)
      .split("{{base64}}").join(audioBase64);
  }

  constructor(private readonly config: AsrProviderConfig, private readonly callbacks: AsrCallbacks) {}

  async connect() {
    if (!this.config.wsUrl) throw new Error("请先配置 ASR WebSocket 地址");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.callbacks.onStatus("connecting");
    this.taskId = this.newId();
    this.started = false;
    this.stoppedByClient = false;
    this.sentenceResults.clear();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.interpolate(this.config.wsUrl));
      this.socket = socket;
      const timer = window.setTimeout(() => {
        socket.close();
        reject(new Error("ASR WebSocket 连接超时"));
      }, this.config.timeoutMs);
      socket.onopen = () => {
        try {
          const init = parseJson(this.interpolate(this.config.initMessage || "{}"), "初始化消息");
          if (Object.keys(init).length) socket.send(JSON.stringify(init));
          if (!this.isAliyunNls) {
            window.clearTimeout(timer);
            this.started = true;
            this.callbacks.onStatus("listening");
            resolve();
          }
        } catch (error) {
          window.clearTimeout(timer);
          reject(error);
        }
      };
      socket.onerror = () => {
        window.clearTimeout(timer);
        if (this.started) this.callbacks.onError("ASR WebSocket 连接失败");
        else reject(new Error("ASR WebSocket 连接失败"));
      };
      socket.onclose = () => {
        if (!this.stoppedByClient && this.started) this.callbacks.onError("ASR WebSocket 连接已关闭");
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      if (this.isAliyunNls) {
        const originalHandleMessage = socket.onmessage;
        socket.onmessage = (event) => {
          const wasStarted = this.started;
          originalHandleMessage?.call(socket, event);
          if (!wasStarted && this.started) {
            window.clearTimeout(timer);
            resolve();
          }
        };
      }
    });
  }

  sendAudio(pcm16: ArrayBuffer) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.config.audioMode === "binary") {
      this.socket.send(pcm16);
      return;
    }
    const template = this.config.audioTemplate || '{"audio":"{{base64}}"}';
    this.socket.send(this.interpolate(template, base64(pcm16)));
  }

  finalizeSegment() {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("ASR 尚未连接");
    const payload = parseJson(this.interpolate(this.config.finalizeMessage || "{}"), "结束消息");
    if (Object.keys(payload).length) this.socket.send(JSON.stringify(payload));
  }

  close() {
    this.stoppedByClient = true;
    this.socket?.close();
    this.socket = undefined;
  }

  private handleMessage(raw: unknown) {
    const text = typeof raw === "string" ? raw : "";
    this.callbacks.onDebug?.(text);
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    const type = String(valueAtPath(event, this.config.eventPath) ?? "");
    const transcript = String(valueAtPath(event, this.config.textPath) ?? "");
    if (this.isAliyunNls) {
      const status = Number(valueAtPath(event, "header.status") ?? 20000000);
      if (type === "TranscriptionStarted") {
        this.started = true;
        this.callbacks.onStatus("listening");
        return;
      }
      if (status !== 20000000 || type === this.config.errorEvent) {
        const message = String(valueAtPath(event, "header.status_message") ?? transcript ?? "ASR 服务返回错误");
        this.callbacks.onError(message);
        return;
      }
      if (type === this.config.partialEvent) {
        this.callbacks.onPartial(transcript);
        return;
      }
      if (type === "SentenceEnd") {
        const index = Number(valueAtPath(event, "payload.index") ?? this.sentenceResults.size + 1);
        this.sentenceResults.set(index, transcript);
        return;
      }
      if (type === this.config.finalEvent) {
        const fullText = [...this.sentenceResults.entries()].sort(([left], [right]) => left - right).map(([, result]) => result).join("");
        this.callbacks.onFinal(fullText);
      }
      return;
    }
    if (type === this.config.partialEvent) this.callbacks.onPartial(transcript);
    if (type === this.config.finalEvent) this.callbacks.onFinal(transcript);
    if (type === this.config.errorEvent) this.callbacks.onError(transcript || "ASR 服务返回错误");
  }
}
