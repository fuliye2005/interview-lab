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
  private interpolate(template: string, audioBase64 = "") {
    return template
      .split("{{apiKey}}").join(this.config.apiKey)
      .split("{{base64}}").join(audioBase64);
  }

  private socket?: WebSocket;
  constructor(private readonly config: AsrProviderConfig, private readonly callbacks: AsrCallbacks) {}

  async connect() {
    if (!this.config.wsUrl) throw new Error("请先配置 ASR WebSocket 地址");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.callbacks.onStatus("connecting");
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.interpolate(this.config.wsUrl));
      this.socket = socket;
      const timer = window.setTimeout(() => {
        socket.close();
        reject(new Error("ASR WebSocket 连接超时"));
      }, this.config.timeoutMs);
      socket.onopen = () => {
        window.clearTimeout(timer);
        try {
          const init = parseJson(this.interpolate(this.config.initMessage || "{}"), "初始化消息");
          if (Object.keys(init).length) socket.send(JSON.stringify(init));
          this.callbacks.onStatus("listening");
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      socket.onerror = () => reject(new Error("ASR WebSocket 连接失败"));
      socket.onmessage = (event) => this.handleMessage(event.data);
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
    if (type === this.config.partialEvent) this.callbacks.onPartial(transcript);
    if (type === this.config.finalEvent) this.callbacks.onFinal(transcript);
    if (type === this.config.errorEvent) this.callbacks.onError(transcript || "ASR 服务返回错误");
  }
}
