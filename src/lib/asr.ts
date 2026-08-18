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
  private stoppedByClient = true;
  private connectionPromise?: Promise<void>;
  private pendingReject?: (error: Error) => void;
  private reconnectTimer?: number;
  private reconnectAttempts = 0;
  private sentenceResults = new Map<number, string>();
  private finalFingerprints = new Set<string>();
  private audioQueue: ArrayBuffer[] = [];

  private get isAliyunNls() {
    return this.config.protocol === "aliyun-nls";
  }

  private get queueLimit() {
    return Math.max(1, Math.min(240, Math.round(this.config.audioQueueLimit ?? 24)));
  }

  private get maxReconnectAttempts() {
    return Math.max(0, Math.min(8, Math.round(this.config.reconnectAttempts ?? 2)));
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
    if (this.socket?.readyState === WebSocket.OPEN && this.started) return;
    if (this.connectionPromise) return this.connectionPromise;
    this.stoppedByClient = false;
    this.reconnectAttempts = 0;
    return this.beginOpen();
  }

  private beginOpen() {
    if (this.connectionPromise) return this.connectionPromise;
    const promise = this.openSocket();
    this.connectionPromise = promise;
    void promise.then(() => {
      if (this.connectionPromise === promise) this.connectionPromise = undefined;
    }, () => {
      if (this.connectionPromise === promise) this.connectionPromise = undefined;
    });
    return promise;
  }

  private openSocket() {
    this.callbacks.onStatus("connecting");
    this.taskId = this.newId();
    this.started = false;
    this.sentenceResults.clear();
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.interpolate(this.config.wsUrl));
      this.socket = socket;
      let settled = false;
      let ready = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        socket.close();
        fail(new Error("ASR WebSocket 连接超时"));
      }, Math.max(1000, this.config.timeoutMs));
      const succeed = () => {
        if (settled) return;
        settled = true;
        ready = true;
        window.clearTimeout(timer);
        this.pendingReject = undefined;
        if (!this.isAliyunNls) {
          this.started = true;
          this.callbacks.onStatus("listening");
        }
        this.flushAudio();
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.pendingReject = undefined;
        reject(error);
      };
      this.pendingReject = fail;
      socket.onopen = () => {
        try {
          const init = parseJson(this.interpolate(this.config.initMessage || "{}"), "初始化消息");
          if (Object.keys(init).length) socket.send(JSON.stringify(init));
          if (!this.isAliyunNls) succeed();
        } catch (error) {
          fail(error instanceof Error ? error : new Error("ASR 初始化失败"));
        }
      };
      socket.onerror = () => {
        if (!ready) fail(new Error("ASR WebSocket 连接失败"));
        else this.callbacks.onError("ASR WebSocket 连接失败");
      };
      socket.onclose = () => {
        if (this.stoppedByClient) return;
        if (!ready) {
          fail(new Error("ASR WebSocket 连接已关闭"));
          return;
        }
        this.started = false;
        this.scheduleReconnect();
      };
      socket.onmessage = (event) => {
        const wasStarted = this.started;
        this.handleMessage(event.data);
        if (this.isAliyunNls && !wasStarted && this.started) succeed();
      };
    });
  }

  private scheduleReconnect() {
    if (this.stoppedByClient || this.reconnectTimer || this.connectionPromise) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.callbacks.onError("ASR 连接已断开，自动重连次数已用尽");
      return;
    }
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts += 1;
    const baseDelay = Math.max(200, Math.min(10000, this.config.reconnectDelayMs ?? 800));
    const delay = Math.min(10000, baseDelay * (2 ** attempt));
    this.callbacks.onStatus("connecting");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.beginOpen().then(() => {
        this.reconnectAttempts = 0;
      }).catch(() => {
        window.setTimeout(() => this.scheduleReconnect(), 0);
      });
    }, delay);
  }

  private flushAudio() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const queue = this.audioQueue.splice(0);
    queue.forEach((chunk) => this.sendAudioNow(chunk));
  }

  private sendAudioNow(pcm16: ArrayBuffer) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    if (this.config.audioMode === "binary") {
      this.socket.send(pcm16);
      return true;
    }
    const template = this.config.audioTemplate || '{"audio":"{{base64}}"}';
    this.socket.send(this.interpolate(template, base64(pcm16)));
    return true;
  }

  sendAudio(pcm16: ArrayBuffer) {
    if (this.stoppedByClient) return;
    if (this.sendAudioNow(pcm16)) return;
    if (this.audioQueue.length >= this.queueLimit) this.audioQueue.shift();
    this.audioQueue.push(pcm16);
  }

  finalizeSegment() {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("ASR 尚未连接");
    const payload = parseJson(this.interpolate(this.config.finalizeMessage || "{}"), "结束消息");
    this.finalFingerprints.clear();
    if (Object.keys(payload).length) this.socket.send(JSON.stringify(payload));
  }

  close() {
    this.stoppedByClient = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectAttempts = 0;
    this.audioQueue = [];
    this.pendingReject?.(new Error("ASR 会话已关闭"));
    this.pendingReject = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.started = false;
  }

  private emitFinal(text: string) {
    const normalized = text.trim();
    if (!normalized || this.finalFingerprints.has(normalized)) return;
    this.finalFingerprints.add(normalized);
    if (this.finalFingerprints.size > 20) {
      const oldest = this.finalFingerprints.values().next().value;
      if (typeof oldest === "string") this.finalFingerprints.delete(oldest);
    }
    this.callbacks.onFinal(normalized);
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
        const fullText = [...this.sentenceResults.entries()].sort(([left], [right]) => left - right).map(([, result]) => result).join("") || transcript;
        this.emitFinal(fullText);
      }
      return;
    }
    if (type === this.config.partialEvent) this.callbacks.onPartial(transcript);
    if (type === this.config.finalEvent) this.emitFinal(transcript);
    if (type === this.config.errorEvent) this.callbacks.onError(transcript || "ASR 服务返回错误");
  }
}
