import { ChangeEvent, Dispatch, SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { GenericAsrSession } from "./lib/asr";
import { ASR_PROVIDER_PRESETS, asrConfigPreview, asrConfigReady, asrMissingFields, asrProviderLabel, classifyAsrError, testAsrConnection, testAsrFinalText } from "./lib/asr-providers";
import { buildInterviewPrompt, listLlmModels, sanitizeAnswerText, streamLlm, testLlmConnection } from "./lib/llm";
import { extractMaterialText, makeCandidateDraft, makeJobDraft } from "./lib/materials";
import { applyLlmProviderPreset, LLM_PROVIDER_PRESETS, providerLabel, providerRequiresKey } from "./lib/providers";
import { importRepository as importRepositoryMaterial } from "./lib/repository";
import { formatShortcut, shortcutKeyToken, toGlobalShortcut } from "./lib/shortcut";
import { clearHistory, defaultSettings, emptyMaterials, initializeStorage, loadHistory, loadMaterials, loadSettings, saveHistory, saveMaterials, saveSettings } from "./lib/storage";
import type { AnswerStatus, AppSettings, AsrPreset, AsrProviderConfig, AsrStatus, InterviewFocus, InterviewSession, InterviewTurn, LlmProfile, LlmProviderPresetId, MaterialContext, SessionRecord } from "./types";
import { createAsrPreset, createDefaultLlmProfile, INTERVIEW_FOCUS_LABELS } from "./types";
import "./App.css";
import "./theme.css";

type Tab = "session" | "materials" | "settings" | "history";
type SessionMode = "idle" | "all" | "asr" | "answer";
type TestMode = "all" | "asr" | "answer";
type SessionStage = "idle" | "manual" | "listening" | "finalizing" | "answering" | "complete";
type ProfileTestState = { status: "idle" | "testing" | "success" | "error"; latencyMs?: number; firstTokenMs?: number; message?: string };
type ProfileSort = "active" | "name" | "updated";
type ProfileModelState = { status: "idle" | "loading" | "success" | "error"; models: string[]; message?: string };
type AsrProfileTestState = { status: "idle" | "testing" | "success" | "error"; mode?: "connection" | "final"; latencyMs?: number; finalText?: string; errorKind?: string; message?: string };
type OverlayCommand = { command: "start" | "submit" | "stop" | "hide"; testMode?: TestMode };
type OverlayState = {
  answer: string;
  question: string;
  partial: string;
  sessionActive: boolean;
  sessionMode: SessionMode;
  testMode: TestMode;
  answerStatus: AnswerStatus;
  asrStatus: AsrStatus;
  turnCount: number;
  notice: string;
  statusLabel: string;
  sessionTitle: string;
  llmReady: boolean;
  asrReady: boolean;
};

const DEFAULT_OVERLAY_STATE: OverlayState = {
  answer: "",
  question: "",
  partial: "",
  sessionActive: false,
  sessionMode: "idle",
  testMode: "all",
  answerStatus: "idle",
  asrStatus: "idle",
  turnCount: 0,
  notice: "请从主窗口启动测试，或直接在这里开始一场面试。",
  statusLabel: "未开始",
  sessionTitle: "",
  llmReady: false,
  asrReady: false,
};

function splitAnswerText(raw: string) {
  const responseMarker = raw.match(/(?:【参考回答】|参考回答\s*[:：])([\s\S]*)/i);
  if (!responseMarker || responseMarker.index === undefined) return { outline: "", response: raw.trim() };
  const outline = raw.slice(0, responseMarker.index).replace(/(?:【要点】|要点(?:提纲)?\s*[:：]?)/i, "").trim();
  return { outline, response: responseMarker[1].trim() };
}

function formatContextWindow(value?: number) {
  if (!value) return "";
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`;
  return String(value);
}

function parseContextWindow(value: string) {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!match) return undefined;
  const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
  const parsed = Math.round(Number(match[1]) * multiplier);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 128_000_000 ? parsed : undefined;
}

function profileConfigPreview(profile: LlmProfile, focus: InterviewFocus) {
  return `model = "${profile.model || "未填写"}"
provider = "${providerLabel(profile)}"
base_url = "${profile.baseUrl || "未填写"}"
protocol = "${profile.protocol}"
context_window = ${profile.contextWindow || 8000}
answer_detail = "${profile.answerDetail}"
reasoning_effort = "${profile.reasoningEffort}"
interview_focus = "${focus}"
api_key = "${profile.apiKey ? "********" : "未填写"}"`;
}

function SessionProgress({ stage, mode }: { stage: SessionStage; mode: SessionMode }) {
  const answerOnly = mode === "answer";
  const asrOnly = mode === "asr";
  const steps = answerOnly ? ["输入问题", "生成回答"] : asrOnly ? ["开始会话", "聆听问题", "提交问题"] : ["开始会话", "聆听问题", "提交问题", "生成回答"];
  const stageIndex = answerOnly
    ? stage === "answering" || stage === "complete" ? 1 : 0
    : stage === "idle" ? 0 : stage === "listening" ? 1 : stage === "finalizing" ? 2 : asrOnly ? 2 : 3;
  return <div className="session-progress" aria-label="会话进度">
    {steps.map((label, index) => <div className={index < stageIndex ? "progress-step done" : index === stageIndex ? "progress-step active" : "progress-step"} key={label}>
      <span>{index < stageIndex ? "✓" : index + 1}</span><strong>{label}</strong>
    </div>)}
  </div>;
}

function AnswerView({ answer, wheelEnabled }: { answer: string; wheelEnabled: boolean }) {
  if (!answer) return <div className="answer-empty"><strong>等待问题</strong><span>回答生成后会在这里显示要点和第一人称参考回答。</span></div>;
  const sections = splitAnswerText(answer);
  return <div className="answer-content" onWheel={(event) => { if (!wheelEnabled) event.preventDefault(); }}>
    {sections.outline && <section className="answer-section outline"><h3>回答要点</h3><p>{sections.outline}</p></section>}
    <section className="answer-section"><h3>参考回答</h3><p>{sections.response}</p></section>
  </div>;
}

function Overlay() {
  const [state, setState] = useState<OverlayState>(DEFAULT_OVERLAY_STATE);
  const [questionDraft, setQuestionDraft] = useState("");
  const [testMode, setTestMode] = useState<TestMode>("all");
  const [copyNotice, setCopyNotice] = useState("");

  useEffect(() => {
    const previousMinWidth = document.body.style.minWidth;
    document.body.style.minWidth = "0";
    return () => { document.body.style.minWidth = previousMinWidth; };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlistenFns: Array<() => void> = [];
    void Promise.all([
      listen<OverlayState>("overlay-state", (event) => {
        if (disposed) return;
        setState((current) => ({ ...current, ...event.payload }));
        setQuestionDraft(event.payload.question ?? "");
        setTestMode(event.payload.testMode ?? "all");
      }),
    ]).then((cleanups) => {
      if (disposed) cleanups.forEach((cleanup) => cleanup());
      else {
        cleanups.forEach((cleanup) => unlistenFns.push(cleanup));
        void emit("overlay-ready");
      }
    });
    return () => { disposed = true; unlistenFns.forEach((cleanup) => cleanup()); };
  }, []);

  function sendCommand(command: OverlayCommand["command"]) {
    void emit<OverlayCommand>("overlay-command", { command, testMode });
  }
  function changeQuestion(value: string) {
    setQuestionDraft(value);
    void emit("overlay-question", { question: value });
  }
  function changeMode(value: TestMode) {
    setTestMode(value);
    void emit("overlay-mode", { testMode: value });
  }
  async function copyAnswer() {
    if (!state.answer.trim()) return;
    try {
      await navigator.clipboard.writeText(state.answer);
      setCopyNotice("已复制");
      window.setTimeout(() => setCopyNotice(""), 1200);
    } catch {
      setCopyNotice("复制失败");
    }
  }
  async function hideWindow() {
    await getCurrentWindow().hide();
  }
  async function closeWindow() {
    await getCurrentWindow().close();
  }

  const modeLabel = testMode === "asr" ? "语音转文字" : testMode === "answer" ? "问题回答" : "全部启动";
  const answerLabel = state.answerStatus === "generating" ? "正在生成" : state.answerStatus === "complete" ? "回答完成" : state.answerStatus === "error" ? "生成失败" : "等待回答";
  const submitDisabled = !state.sessionActive || state.answerStatus === "generating" || (state.sessionMode === "answer" && !questionDraft.trim());

  return <main className="overlay-shell">
    <header className="overlay-header" data-tauri-drag-region>
      <div className="overlay-title" data-tauri-drag-region><span className={state.sessionActive ? "overlay-live-dot active" : "overlay-live-dot"} /><div data-tauri-drag-region><strong>悬浮面试台</strong><small>{state.sessionTitle || "未开始会话"} · {state.turnCount} 轮上下文</small></div></div>
      <div className="overlay-window-actions"><button title="隐藏悬浮窗" onClick={() => void hideWindow()}>—</button><button title="关闭悬浮窗" onClick={() => void closeWindow()}>×</button></div>
    </header>
    <section className="overlay-body">
      <div className="overlay-toolbar"><label><span>测试内容</span><select value={testMode} onChange={(event) => changeMode(event.target.value as TestMode)} disabled={state.sessionActive}><option value="all">全部启动</option><option value="asr">语音转文字</option><option value="answer">问题回答</option></select></label><span className={`overlay-status ${state.sessionActive ? "active" : ""}`}><i />{state.statusLabel} · {modeLabel}</span></div>
      <div className="overlay-actions">{state.sessionActive ? <><button className="danger" onClick={() => sendCommand("stop")}>结束会话</button><button className="primary" disabled={submitDisabled} onClick={() => sendCommand("submit")}>提交当前问题</button></> : <button className="primary" disabled={testMode === "all" ? !state.llmReady || !state.asrReady : testMode === "asr" ? !state.asrReady : !state.llmReady} onClick={() => sendCommand("start")}>启动测试</button>}<span>{copyNotice || state.notice}</span></div>
      <div className="overlay-field-heading"><strong>当前问题</strong><small>{state.sessionMode === "answer" ? "可直接输入并提交" : "可编辑转写文本"}</small></div>
      <textarea className="overlay-question" value={questionDraft} onChange={(event) => changeQuestion(event.target.value)} placeholder="输入或等待当前面试问题…" />
      <div className="overlay-partial"><span>实时增量转写</span><p>{state.partial || "等待系统音频…"}</p></div>
      <div className="overlay-answer-head"><strong>回答</strong><span className={`overlay-answer-status ${state.answerStatus}`}>{answerLabel}</span></div>
      <article className="overlay-answer">{state.answer || "回答生成后会在这里显示。"}</article>
      <div className="overlay-footer"><button onClick={() => void copyAnswer()} disabled={!state.answer}>复制回答</button><span>主窗口与悬浮窗共享同一场面试上下文</span></div>
    </section>
  </main>;
}

function App() {
  const desktopRuntime = isTauri();
  const isOverlayWindow = new URLSearchParams(window.location.search).get("overlay") === "1";
  const [tab, setTab] = useState<Tab>("session");
  const [settings, setSettings] = useState<AppSettings>(() => desktopRuntime && !isOverlayWindow ? defaultSettings() : loadSettings());
  const [materials, setMaterials] = useState<MaterialContext>(() => desktopRuntime && !isOverlayWindow ? emptyMaterials() : loadMaterials());
  const [history, setHistory] = useState<InterviewSession[]>(() => desktopRuntime && !isOverlayWindow ? [] : loadHistory());
  const [storageReady, setStorageReady] = useState(!desktopRuntime || isOverlayWindow);
  const [storageError, setStorageError] = useState("");
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionMode, setSessionMode] = useState<SessionMode>("idle");
  const [testMode, setTestMode] = useState<TestMode>("all");
  const [asrStatus, setAsrStatus] = useState<AsrStatus>("idle");
  const [answerStatus, setAnswerStatus] = useState<AnswerStatus>("idle");
  const [partial, setPartial] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [notice, setNotice] = useState("配置文本模型后即可开始测试；ASR 和候选人材料均可选。");
  const [debug, setDebug] = useState<string[]>([]);
  const [turnCount, setTurnCount] = useState(0);
  const [activeSessionTitle, setActiveSessionTitle] = useState("");
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<string | undefined>();
  const [profileTests, setProfileTests] = useState<Record<string, ProfileTestState>>({});
  const [profileModelStates, setProfileModelStates] = useState<Record<string, ProfileModelState>>({});
  const [asrProfileTests, setAsrProfileTests] = useState<Record<string, AsrProfileTestState>>({});
  const [expandedAsrPresetIds, setExpandedAsrPresetIds] = useState<AsrPreset[]>([]);
  const [profileQuery, setProfileQuery] = useState("");
  const [profileSort, setProfileSort] = useState<ProfileSort>("active");
  const [expandedProfileIds, setExpandedProfileIds] = useState<string[]>([]);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [repositoryImporting, setRepositoryImporting] = useState(false);
  const asrRef = useRef<GenericAsrSession | undefined>(undefined);
  const pendingRef = useRef(false);
  const questionRef = useRef("");
  const testModeRef = useRef<TestMode>("all");
  const overlayStateRef = useRef<OverlayState>(DEFAULT_OVERLAY_STATE);
  const overlayActionsRef = useRef<{ start: (mode: TestMode) => void; submit: () => void; stop: () => void }>({ start: () => {}, submit: () => {}, stop: () => {} });
  const interviewTurnsRef = useRef<InterviewTurn[]>([]);
  const activeSessionIdRef = useRef("");
  const loadedContextRef = useRef<InterviewTurn[]>([]);
  const loadedSourceSessionIdRef = useRef<string | undefined>(undefined);
  const activeProfile = useMemo(() => settings.llmProfiles.find((item) => item.id === settings.activeLlmProfileId) ?? settings.llmProfiles[0], [settings]);
  const llmReady = Boolean(activeProfile?.baseUrl.trim() && activeProfile?.model.trim() && activeProfile && (!providerRequiresKey(activeProfile) || activeProfile.apiKey.trim()));
  const asrReady = asrConfigReady(settings.asr);
  const hasMaterials = Boolean(materials.resume.trim() || materials.jobDescription.trim() || materials.personalNotes.trim() || materials.candidateSummary.trim() || materials.jobSummary.trim() || materials.repository?.summary.trim());
  const sessionStage: SessionStage = answerStatus === "generating" ? "answering" : answerStatus === "complete" ? "complete" : !sessionActive ? "idle" : sessionMode === "answer" ? "manual" : asrStatus === "finalizing" ? "finalizing" : "listening";
  const statusLabel = sessionStage === "manual" ? "等待输入" : sessionStage === "answering" ? "正在生成回答" : sessionStage === "complete" ? sessionMode === "asr" ? "转写已完成" : "回答已完成" : sessionStage === "listening" ? "正在聆听" : sessionStage === "finalizing" ? "正在提交问题" : sessionStage === "idle" && !llmReady && testMode !== "asr" ? "待配置模型" : sessionStage === "idle" ? "未开始" : "连接异常";
  testModeRef.current = testMode;

  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    let cancelled = false;
    setStorageReady(false);
    void initializeStorage().then((snapshot) => {
      if (cancelled) return;
      setSettings(snapshot.settings);
      setMaterials(snapshot.materials);
      setHistory(snapshot.history);
      setStorageError("");
      setStorageReady(true);
    }).catch((error) => {
      if (cancelled) return;
      const message = error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : (() => {
              try {
                return JSON.stringify(error);
              } catch {
                return "本机数据加载失败";
              }
            })();
      setStorageError(message);
      setNotice(`本机数据加载失败：${message}。已暂停保存，避免覆盖现有配置。`);
    });
    return () => { cancelled = true; };
  }, [desktopRuntime, isOverlayWindow]);
  useEffect(() => { if (storageReady && !isOverlayWindow) void saveSettings(settings); }, [settings, storageReady, isOverlayWindow]);
  useEffect(() => { if (storageReady && !isOverlayWindow) void saveMaterials(materials); }, [materials, storageReady, isOverlayWindow]);
  useEffect(() => { if (storageReady && !isOverlayWindow) void saveHistory(history); }, [history, storageReady, isOverlayWindow]);
  useEffect(() => { if (!repositoryUrl && materials.repository?.url) setRepositoryUrl(materials.repository.url); }, [materials.repository?.url, repositoryUrl]);
  useEffect(() => { questionRef.current = question; }, [question]);
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    let unlisten: () => void = () => {};
    void listen<number[]>("audio-pcm", (event) => asrRef.current?.sendAudio(Uint8Array.from(event.payload).buffer)).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, [desktopRuntime, isOverlayWindow]);
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    let unlisten: () => void = () => {};
    void listen<string>("audio-capture-error", (event) => {
      asrRef.current?.close();
      asrRef.current = undefined;
      pendingRef.current = false;
      setSessionActive(false);
      setSessionMode("idle");
      setAsrStatus("error");
      setNotice(`系统音频采集失败：${event.payload}`);
    }).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, [desktopRuntime, isOverlayWindow]);
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    let alive = true;
    void unregisterAll().then(() => settings.shortcutEnabled && settings.shortcut ? register(toGlobalShortcut(settings.shortcut), (event) => {
      if (alive && event.state === "Pressed") void submitQuestion();
    }) : undefined).catch(() => setNotice("全局快捷键注册失败，可使用“提交当前问题”按钮。"));
    return () => { alive = false; void unregisterAll(); };
  }, [desktopRuntime, isOverlayWindow, settings.shortcut, settings.shortcutEnabled, sessionActive]);
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    const state: OverlayState = {
      answer,
      question,
      partial,
      sessionActive,
      sessionMode,
      testMode,
      answerStatus,
      asrStatus,
      turnCount,
      notice,
      statusLabel,
      sessionTitle: activeSessionTitle,
      llmReady,
      asrReady,
    };
    overlayStateRef.current = state;
    void emitTo("answer-overlay", "overlay-state", state).catch(() => undefined);
  }, [desktopRuntime, isOverlayWindow, answer, question, partial, sessionActive, sessionMode, testMode, answerStatus, asrStatus, turnCount, notice, statusLabel, activeSessionTitle, llmReady, asrReady]);
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    let unlisten: () => void = () => {};
    void listen("overlay-ready", () => {
      void emitTo("answer-overlay", "overlay-state", overlayStateRef.current).catch(() => undefined);
    }).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, [desktopRuntime, isOverlayWindow]);

  function updateAsrProfile<K extends keyof AppSettings["asr"]>(preset: AsrPreset, key: K, value: AppSettings["asr"][K]) {
    setSettings((state) => {
      const profile = { ...(state.asrProfiles[preset] ?? createAsrPreset(preset)), [key]: value };
      return {
        ...state,
        asr: state.asr.preset === preset ? profile : state.asr,
        asrProfiles: { ...state.asrProfiles, [preset]: profile },
      };
    });
  }
  function selectAsrPreset(preset: AsrPreset) {
    setSettings((state) => {
      const currentPreset = state.asr.preset ?? "generic";
      const asr = { ...(state.asrProfiles[preset] ?? createAsrPreset(preset)) };
      return { ...state, asr, asrProfiles: { ...state.asrProfiles, [currentPreset]: state.asr, [preset]: asr } };
    });
    setNotice("已切换到已保存的 ASR 预配置；该预配置的凭证和高级参数会保留在本机。");
  }
  function saveConfiguration() {
    saveSettings(settings);
    setNotice("服务配置已保存到本机。");
  }
  function toggleAsrPresetExpanded(preset: AsrPreset) {
    setExpandedAsrPresetIds((ids) => ids.includes(preset) ? ids.filter((id) => id !== preset) : [...ids, preset]);
  }
  async function testAsrProfile(preset: AsrPreset, mode: "connection" | "final") {
    const profile = settings.asrProfiles[preset] ?? createAsrPreset(preset);
    const missing = asrMissingFields(profile);
    if (missing.length) {
      setAsrProfileTests((state) => ({ ...state, [preset]: { status: "error", mode, errorKind: "配置不完整", message: `请先填写：${missing.join("、")}` } }));
      setNotice(`${asrProviderLabel(profile)}：请先填写 ${missing.join("、")}。`);
      return;
    }
    setAsrProfileTests((state) => ({ ...state, [preset]: { status: "testing", mode } }));
    try {
      const result = mode === "connection" ? await testAsrConnection(profile) : await testAsrFinalText(profile);
      setAsrProfileTests((state) => ({ ...state, [preset]: { status: "success", mode, latencyMs: result.latencyMs, finalText: result.finalText } }));
      setNotice(mode === "connection" ? `${profile.name} 连接成功，延迟 ${result.latencyMs} ms。` : `${profile.name} 收到最终文本事件：${result.finalText || "（空文本）"}`);
    } catch (error) {
      const classified = classifyAsrError(error);
      setAsrProfileTests((state) => ({ ...state, [preset]: { status: "error", mode, errorKind: classified.label, message: classified.message } }));
      setNotice(`${profile.name}：${classified.label} · ${classified.message}`);
    }
  }
  function duplicateProfile(profile: LlmProfile) {
    const copy: LlmProfile = { ...profile, id: crypto.randomUUID(), name: `${profile.name} 副本` };
    setSettings((state) => ({ ...state, llmProfiles: [...state.llmProfiles, copy], activeLlmProfileId: copy.id }));
    setExpandedProfileIds((ids) => ids.includes(copy.id) ? ids : [...ids, copy.id]);
    setNotice(`已复制模型配置：${copy.name}`);
  }
  function addProfileFromPreset(presetId: LlmProviderPresetId = "custom") {
    const profile = applyLlmProviderPreset(createDefaultLlmProfile(), presetId);
    setSettings((state) => ({ ...state, llmProfiles: [...state.llmProfiles, profile], activeLlmProfileId: profile.id }));
    setExpandedProfileIds((ids) => ids.includes(profile.id) ? ids : [...ids, profile.id]);
    setNotice(`已添加 ${providerLabel(profile)} 配置，请填写 Key 后测试连接。`);
  }
  function applyProfilePreset(profileId: string, presetId: LlmProviderPresetId) {
    setSettings((state) => ({
      ...state,
      llmProfiles: state.llmProfiles.map((profile) => profile.id === profileId ? applyLlmProviderPreset(profile, presetId) : profile),
    }));
    setProfileModelStates((state) => ({ ...state, [profileId]: { status: "idle", models: [] } }));
    setNotice("已应用 Provider 预配置；现有 Key 和自定义回答策略会保留。保存后即可在本机复用。");
  }
  function removeProfile(profileId: string) {
    if (settings.activeLlmProfileId === profileId) {
      setNotice("当前启用的模型不能直接删除，请先切换到其他配置。");
      return;
    }
    setSettings((state) => ({ ...state, llmProfiles: state.llmProfiles.filter((profile) => profile.id !== profileId) }));
    setExpandedProfileIds((ids) => ids.filter((id) => id !== profileId));
    setProfileModelStates((state) => { const next = { ...state }; delete next[profileId]; return next; });
    setProfileTests((state) => { const next = { ...state }; delete next[profileId]; return next; });
    setNotice("已移除模型配置；当前启用配置未受影响。");
  }
  function moveProfile(profileId: string, direction: -1 | 1) {
    setSettings((state) => {
      const index = state.llmProfiles.findIndex((profile) => profile.id === profileId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= state.llmProfiles.length) return state;
      const profiles = [...state.llmProfiles];
      [profiles[index], profiles[nextIndex]] = [profiles[nextIndex], profiles[index]];
      return { ...state, llmProfiles: profiles };
    });
  }
  function toggleProfileExpanded(profileId: string) {
    setExpandedProfileIds((ids) => ids.includes(profileId) ? ids.filter((id) => id !== profileId) : [...ids, profileId]);
  }
  async function loadProfileModels(profile: LlmProfile) {
    setProfileModelStates((state) => ({ ...state, [profile.id]: { status: "loading", models: state[profile.id]?.models ?? [] } }));
    try {
      const models = await listLlmModels(profile);
      setProfileModelStates((state) => ({ ...state, [profile.id]: { status: "success", models } }));
      setSettings((state) => ({ ...state, llmProfiles: state.llmProfiles.map((item) => item.id === profile.id ? { ...item, modelOptions: models } : item) }));
      setNotice(`已获取 ${models.length} 个可用模型：${profile.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === "string" ? error : "获取模型列表失败";
      setProfileModelStates((state) => ({ ...state, [profile.id]: { status: "error", models: [], message } }));
    }
  }
  async function testProfile(profile: LlmProfile) {
    setProfileTests((state) => ({ ...state, [profile.id]: { status: "testing" } }));
    try {
      const result = await testLlmConnection(profile);
      setProfileTests((state) => ({ ...state, [profile.id]: { status: "success", ...result } }));
    } catch (error) {
      setProfileTests((state) => ({ ...state, [profile.id]: { status: "error", message: error instanceof Error ? error.message : "连接测试失败" } }));
    }
  }
  function log(raw: string) { if (settings.asr.debug) setDebug((items) => [raw.slice(0, 1000), ...items].slice(0, 30)); }
  function interviewTurnsForSession(sessionId: string, sessions = history): InterviewTurn[] {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const chain: InterviewSession[] = [];
    let current = byId.get(sessionId);
    while (current) {
      chain.unshift(current);
      current = current.sourceSessionId ? byId.get(current.sourceSessionId) : undefined;
    }
    return chain.flatMap((session) => session.turns.filter((turn) => !turn.error && turn.answer.trim()).map(({ question, answer }) => ({ question, answer })));
  }
  function beginInterview() {
    const now = new Date().toISOString();
    const carriedTurns = loadedContextRef.current;
    const title = settings.sessionTitleDraft.trim() || `面试 ${new Date(now).toLocaleString()}`;
    const session: InterviewSession = {
      id: crypto.randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      asrName: settings.asr.name,
      llmName: activeProfile?.name || "未选择文本模型",
      sourceSessionId: loadedSourceSessionIdRef.current,
      carriedTurnCount: carriedTurns.length,
      turns: [],
    };
    activeSessionIdRef.current = session.id;
    setActiveSessionTitle(title);
    interviewTurnsRef.current = carriedTurns;
    loadedContextRef.current = [];
    loadedSourceSessionIdRef.current = undefined;
    setTurnCount(carriedTurns.length);
    setHistory((items) => [session, ...items]);
    setSettings((state) => ({ ...state, sessionTitleDraft: "" }));
  }
  function appendSessionRecord(record: SessionRecord) {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    setHistory((items) => items.map((session) => session.id === sessionId ? { ...session, updatedAt: record.createdAt, turns: [...session.turns, record] } : session));
  }
  function loadSessionContext(session: InterviewSession) {
    if (sessionActive) { setNotice("请先结束当前会话，再载入历史会话作为下一轮上下文。"); return; }
    const turns = interviewTurnsForSession(session.id);
    loadedContextRef.current = turns;
    loadedSourceSessionIdRef.current = session.id;
    interviewTurnsRef.current = turns;
    setTurnCount(turns.length);
    setQuestion("");
    setAnswer("");
    setAnswerStatus("idle");
    setSettings((state) => ({ ...state, sessionTitleDraft: `${session.title} · 下一轮` }));
    setTab("session");
    setNotice(`已载入 ${turns.length} 轮历史问答；点击“启动测试”后会创建下一轮面试记录并延续这些上下文。`);
  }
  function renameHistorySession(sessionId: string, title: string) {
    setHistory((items) => items.map((session) => session.id === sessionId ? { ...session, title, updatedAt: new Date().toISOString() } : session));
  }

  async function startSession(mode: Exclude<TestMode, "answer">) {
    if (!desktopRuntime) {
      setAsrStatus("error");
      setNotice("当前是网页预览环境，无法调用系统音频采集。请从安装后的 Interview Lab 桌面程序打开，再测试语音转文字。");
      return;
    }
    if (settings.asr.protocol === "volcengine-asr") {
      setAsrStatus("error");
      setNotice("豆包预配置已保存，但当前桌面端尚未接入其自定义二进制帧与 Authorization 请求头；请选择阿里云或通用 WebSocket 后开始会话。");
      return;
    }
    const asr = new GenericAsrSession(settings.asr, {
      onStatus: (status) => setAsrStatus(status),
      onPartial: setPartial,
      onFinal: (text) => {
        const completeQuestion = questionRef.current ? `${questionRef.current}${text}` : text;
        questionRef.current = completeQuestion;
        setQuestion(completeQuestion);
        setPartial("");
        if (pendingRef.current && mode === "all") void generateAnswer(completeQuestion);
        if (pendingRef.current && mode === "asr") {
          pendingRef.current = false;
          setAsrStatus("listening");
          setNotice("语音转文字已完成，结果已写入当前问题框。");
        }
      },
      onError: (message) => { setAsrStatus("error"); setNotice(message); },
      onDebug: log,
    });
    try {
      await asr.connect();
      asrRef.current = asr;
      await invoke("start_system_audio_capture");
      beginInterview();
      setSessionActive(true);
      setSessionMode(mode);
      setAsrStatus("listening");
      setNotice(mode === "asr" ? "正在捕获系统音频并进行语音转文字。原始音频不会保存。" : materials.confirmed ? "正在捕获默认系统输出并发送给 ASR。原始音频不会保存。" : "正在捕获系统音频；未确认候选人材料，将使用通用回答上下文。");
    } catch (error) {
      asr.close();
      setAsrStatus("error");
      setNotice(error instanceof Error ? error.message : "启动会话失败");
    }
  }
  function startAnswerSession() {
    asrRef.current?.close();
    asrRef.current = undefined;
    pendingRef.current = false;
    beginInterview();
    setSessionActive(true);
    setSessionMode("answer");
    setAsrStatus("idle");
    setPartial("");
    setNotice("本次面试已开始。可直接输入第一个问题；之后每次提交都会延续同一场面试的上下文。");
  }
  function startTest(mode: TestMode = testMode) {
    if (sessionActive) {
      setNotice("当前会话已在进行中，请先结束后再启动下一场面试。");
      return;
    }
    if (mode === "all" && (!asrReady || !llmReady)) {
      setNotice(!asrReady && !llmReady ? "“全部启动”需要先配置 ASR 和文本模型；如只验证转写，请在下拉框选择“语音转文字”。" : !asrReady ? "“全部启动”还需要配置 ASR；如只验证回答，可选择“问题回答”。" : "“全部启动”还需要配置文本模型；如只验证转写，可选择“语音转文字”。");
      return;
    }
    if (mode === "asr" && !asrReady) {
      const missing = asrMissingFields(settings.asr);
      setNotice(`请先在服务配置中填写 ASR：${missing.join("、") || "WebSocket 地址"}。`);
      return;
    }
    if (mode === "answer" && !llmReady) {
      setNotice("请先在服务配置中填写文本模型的 Base URL、Key 和模型名称，再测试问题回答。");
      return;
    }
    if (mode === "answer") { startAnswerSession(); return; }
    void startSession(mode);
  }
  async function stopSession() {
    const wasAsrSession = sessionMode === "asr" || sessionMode === "all";
    asrRef.current?.close(); asrRef.current = undefined;
    if (desktopRuntime && wasAsrSession) await invoke("stop_system_audio_capture").catch(() => undefined);
    setSessionActive(false); setSessionMode("idle"); setAsrStatus("idle"); setPartial(""); pendingRef.current = false;
    setActiveSessionTitle("");
    setNotice("会话已结束，仅保留文本记录。");
  }
  async function submitQuestion() {
    if (!sessionActive) {
      setNotice("请先点击“启动测试”，再提交当前问题。");
      return;
    }
    if (sessionMode === "answer") {
      if (!questionRef.current.trim()) { setNotice("请先输入要测试的问题。"); return; }
      await generateAnswer(questionRef.current);
      return;
    }
    pendingRef.current = true; setAsrStatus("finalizing"); setNotice("正在等待 ASR 返回当前问题最终文本…");
    try {
      asrRef.current?.finalizeSegment();
      window.setTimeout(() => {
        if (!pendingRef.current || !questionRef.current.trim()) return;
        if (sessionMode === "asr") {
          pendingRef.current = false;
          setAsrStatus("listening");
          setNotice("语音转文字已写入当前问题框。");
          return;
        }
        void generateAnswer(questionRef.current);
      }, 1500);
    } catch (error) { setAsrStatus("error"); setNotice(error instanceof Error ? error.message : "提交失败"); }
  }
  async function generateAnswer(rawQuestion: string) {
    const finalQuestion = rawQuestion.trim();
    if (!finalQuestion || answerStatus === "generating" || !activeProfile) return;
    const previousTurns = interviewTurnsRef.current;
    pendingRef.current = false; setQuestion(""); setPartial(""); setAnswer(""); setAnswerStatus("generating"); setAsrStatus("listening");
    await showOverlay("");
    try {
      let full = "";
      await streamLlm(activeProfile, buildInterviewPrompt(finalQuestion, materials, previousTurns, activeProfile.answerDetail, settings.interviewFocus, activeProfile.contextWindow), (delta) => {
        full += delta;
        const cleanAnswer = sanitizeAnswerText(full);
        setAnswer(cleanAnswer);
      });
      const cleanAnswer = sanitizeAnswerText(full);
      setAnswerStatus("complete");
      interviewTurnsRef.current = [...previousTurns, { question: finalQuestion, answer: cleanAnswer }];
      setTurnCount(interviewTurnsRef.current.length);
      appendSessionRecord({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), question: finalQuestion, answer: cleanAnswer, asrName: settings.asr.name, llmName: activeProfile.name });
    } catch (error) {
      const message = error instanceof Error ? error.message : "文本模型请求失败";
      setAnswerStatus("error"); setNotice(message);
      appendSessionRecord({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), question: finalQuestion, answer: "", asrName: settings.asr.name, llmName: activeProfile.name, error: message });
    }
  }
  async function copyAnswer() {
    if (!answer.trim()) { setNotice("还没有可复制的回答。"); return; }
    try { await navigator.clipboard.writeText(answer); setNotice("回答已复制到剪贴板。"); }
    catch { setNotice("当前环境不允许访问剪贴板，请手动选择回答文本复制。"); }
  }
  function clearCurrentQuestion() {
    setQuestion("");
    setPartial("");
    setAnswer("");
    setAnswerStatus("idle");
    setNotice("当前问题已清空。");
  }
  async function showOverlay(content = answer) {
    if (!desktopRuntime || isOverlayWindow) return;
    const snapshot = { ...overlayStateRef.current, answer: content };
    overlayStateRef.current = snapshot;
    const windowRef = await WebviewWindow.getByLabel("answer-overlay");
    if (windowRef) {
      await windowRef.show();
      await windowRef.setFocus();
      await emitTo("answer-overlay", "overlay-state", snapshot).catch(() => undefined);
      return;
    }
    new WebviewWindow("answer-overlay", { url: "/?overlay=1", title: "实时回答", width: 520, height: 440, alwaysOnTop: true, decorations: false });
    window.setTimeout(() => void emitTo("answer-overlay", "overlay-state", snapshot).catch(() => undefined), 350);
  }
  function importMaterial(kind: "resume" | "jobDescription") {
    const input = document.createElement("input"); input.type = "file"; input.accept = ".pdf,.docx,.txt,.md";
    input.onchange = async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
      try { const text = await extractMaterialText(file); setMaterials((state) => ({ ...state, [kind]: text, confirmed: false })); setNotice(`${file.name} 已导入。`); }
      catch (error) { setNotice(error instanceof Error ? error.message : "材料导入失败"); }
    }; input.click();
  }
  function draftSummaries() { setMaterials((state) => ({ ...state, candidateSummary: makeCandidateDraft(state.resume, state.personalNotes), jobSummary: makeJobDraft(state.jobDescription), confirmed: false })); }
  async function importRepositoryContext() {
    if (!repositoryUrl.trim()) { setNotice("请先输入 GitHub 或 Gitee 仓库地址。"); return; }
    setRepositoryImporting(true);
    try {
      const repository = await importRepositoryMaterial(repositoryUrl);
      setMaterials((state) => ({ ...state, repository }));
      setRepositoryUrl(repository.url);
      setNotice(`已导入 ${repository.name}，请检查摘要后确认用于回答。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "仓库导入失败");
    } finally {
      setRepositoryImporting(false);
    }
  }
  overlayActionsRef.current = {
    start: (mode) => startTest(mode),
    submit: () => { void submitQuestion(); },
    stop: () => { void stopSession(); },
  };
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    let disposed = false;
    const unlistenFns: Array<() => void> = [];
    void Promise.all([
      listen<OverlayCommand>("overlay-command", (event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.command === "start") {
          const mode = payload.testMode ?? testModeRef.current;
          setTestMode(mode);
        } else if (payload.command === "submit") {
          overlayActionsRef.current.submit();
        } else if (payload.command === "stop") {
          overlayActionsRef.current.stop();
        } else if (payload.command === "hide") {
          void WebviewWindow.getByLabel("answer-overlay").then((windowRef) => windowRef?.hide());
        }
      }),
      listen<{ question: string }>("overlay-question", (event) => {
        if (disposed) return;
        const nextQuestion = event.payload.question ?? "";
        questionRef.current = nextQuestion;
        setQuestion(nextQuestion);
      }),
      listen<{ testMode: TestMode }>("overlay-mode", (event) => {
        if (disposed) return;
        setTestMode(event.payload.testMode);
      }),
    ]).then((cleanups) => cleanups.forEach((cleanup) => unlistenFns.push(cleanup)));
    return () => { disposed = true; unlistenFns.forEach((cleanup) => cleanup()); };
  }, [desktopRuntime, isOverlayWindow]);
  if (isOverlayWindow) return <Overlay />;

  const statusClass = sessionStage === "complete" ? "complete" : sessionMode === "answer" && sessionActive ? "manual" : asrStatus;
  const materialLabel = materials.confirmed ? "已确认并用于回答" : hasMaterials ? "有材料，等待确认" : "未添加材料";
  const materialClass = materials.confirmed ? "ready" : hasMaterials ? "pending" : "muted";

  return <main className="app-shell">
    <aside className="sidebar"><div className="brand"><span>IL</span><div><strong>Interview Lab</strong><small>实时语音测试台</small></div></div>
      {(["session", "materials", "settings", "history"] as Tab[]).map((item) => <button key={item} className={tab === item ? "nav active" : "nav"} onClick={() => setTab(item)}>{({ session: "会话控制", materials: "候选人材料", settings: "服务配置", history: "文本记录" })[item]}</button>)}
      <p className="sidebar-footer">受控测试模式<br />不保存原始音频</p></aside>
    <section className={tab === "session" ? "content session-content" : "content"}><header className="topbar"><div><p className="eyebrow">WINDOWS · REALTIME ASR · LLM</p><h1>{({ session: "会话控制", materials: "候选人材料", settings: "服务配置", history: "文本记录" })[tab]}</h1></div><span className={`status ${statusClass}`}>{statusLabel}</span></header>
      <p className="notice">{notice}</p>
      <div className="quick-status" aria-label="当前配置状态"><span className={llmReady ? "ready" : "pending"}><i />文本模型：{llmReady ? "已就绪" : "待配置"}</span><span className={asrReady ? "ready" : "muted"}><i />ASR：{asrReady ? "已配置" : "未配置"}</span>{tab === "materials" && <span className={materialClass}><i />材料：{materialLabel}</span>}{storageError && <span className="pending"><i />本机存储：异常</span>}<span className="autosave-state"><i />设置自动保存在本机</span></div>
      {tab === "session" && <section className="session-grid">
        <div className="panel session-panel">
          <div className="panel-head session-head"><div><div className="panel-kicker">LIVE SESSION</div><h2>系统音频会话</h2><p>默认输出设备 · PCM16 / Mono / 16kHz</p></div><span className={`session-badge ${sessionStage}`}><i />{statusLabel}</span></div>
          <div className="interview-context">本次面试上下文：已完成 {turnCount} 轮问答{sessionActive && activeSessionTitle ? ` · ${activeSessionTitle}` : ""}</div>
          <SessionProgress stage={sessionStage} mode={sessionMode === "idle" ? testMode : sessionMode} />
          {!sessionActive && <label className="session-title-draft"><span>本次会话主题</span><input value={settings.sessionTitleDraft} onChange={(event) => setSettings((state) => ({ ...state, sessionTitleDraft: event.target.value }))} placeholder="例如：售前解决方案岗位一面" /></label>}
          <div className="session-actions"><div className="button-row">{sessionActive ? <button className="danger" onClick={() => void stopSession()}>结束会话</button> : <><button className="primary" onClick={() => startTest()}>启动测试</button><label className="test-mode"><span>测试内容</span><select value={testMode} onChange={(event) => setTestMode(event.target.value as TestMode)}><option value="all">全部启动</option><option value="asr">语音转文字</option><option value="answer">问题回答</option></select></label></>}{sessionActive && sessionMode !== "answer" && <button className="primary submit-button" onClick={() => void submitQuestion()}>提交当前问题</button>}</div><span className="action-hint">{!settings.shortcutEnabled ? "快捷键已关闭，可使用按钮提交当前问题" : testMode === "asr" && !asrReady ? "先在服务配置中填写 ASR 凭证" : testMode === "answer" && !llmReady ? "先在服务配置中填写文本模型" : testMode === "all" && (!llmReady || !asrReady) ? "全部启动需要同时配置 ASR 与文本模型" : sessionStage === "listening" ? `听到问题后按 ${settings.shortcut} 提交` : sessionStage === "finalizing" ? "正在等待最终转写文本" : sessionStage === "answering" ? "回答会同步显示在右侧" : testMode === "asr" ? "单独验证实时语音转文字" : testMode === "answer" ? "直接输入问题验证回答效果" : "同时验证转写与问题回答"}</span></div>
          <div className="shortcut"><span>全局快捷键</span><kbd>{settings.shortcut}</kbd><span>· 仅在语音转文字或全部启动时用于提交当前语音段</span></div>
          <div className="field-heading"><label>实时增量转写</label><span className={asrStatus === "listening" ? "live-dot" : ""}>{asrStatus === "listening" ? "正在接收" : "等待开始"}</span></div>
          <div className="transcript scroll-region" onWheel={(event) => { if (!settings.wheelScroll.transcript) event.preventDefault(); }}>{partial || "等待系统音频…"}</div>
          <div className="field-heading"><label>转写结果 / 当前问题</label><button className="text-button" disabled={!question && !partial} onClick={clearCurrentQuestion}>清空</button></div>
          <textarea rows={6} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="ASR 最终文本会显示在这里，也可以直接输入问题测试模型。" />
        </div>
        <div className="panel answer-panel">
          <div className="panel-head"><div><div className="panel-kicker">AI RESPONSE</div><h2>中文回答</h2><p>{INTERVIEW_FOCUS_LABELS[settings.interviewFocus]} · {activeProfile?.answerDetail === "detailed" ? "详细" : activeProfile?.answerDetail === "concise" ? "简洁" : "标准"}</p></div><span className={`answer-status ${answerStatus}`}>{answerStatus === "generating" ? "流式生成中" : answerStatus === "complete" ? "已完成" : answerStatus === "error" ? "生成失败" : "等待问题"}</span></div>
          <AnswerView answer={answer} wheelEnabled={settings.wheelScroll.answer} />
          <div className="answer-toolbar"><button onClick={() => void copyAnswer()} disabled={!answer}>复制回答</button><button onClick={() => void showOverlay()}>打开悬浮窗</button><button className="primary" disabled={!sessionActive || !question || answerStatus === "generating" || !llmReady} onClick={() => void generateAnswer(question)}>用当前文本生成</button></div>
        </div>
        {settings.asr.debug && <div className="panel debug-panel"><h2>ASR 调试消息</h2><pre>{debug.join("\n\n") || "等待 WebSocket 消息…"}</pre></div>}
      </section>}
      {tab === "materials" && <section className="materials-grid"><div className="panel"><div className="panel-head"><div><div className="panel-kicker">CANDIDATE CONTEXT</div><h2>候选人材料</h2><p>可选：PDF、DOCX、TXT 或直接粘贴。</p></div><button onClick={() => importMaterial("resume")}>导入简历</button></div><label>简历原文</label><textarea rows={10} value={materials.resume} onChange={(event) => setMaterials((state) => ({ ...state, resume: event.target.value, confirmed: false }))} /><label>个人补充资料</label><textarea rows={5} value={materials.personalNotes} onChange={(event) => setMaterials((state) => ({ ...state, personalNotes: event.target.value, confirmed: false }))} /></div><div className="panel"><div className="panel-head"><div><div className="panel-kicker">TARGET ROLE</div><h2>目标岗位</h2><p>可选：一次会话仅使用一份 JD。</p></div><button onClick={() => importMaterial("jobDescription")}>导入 JD</button></div><label>岗位描述</label><textarea rows={10} value={materials.jobDescription} onChange={(event) => setMaterials((state) => ({ ...state, jobDescription: event.target.value, confirmed: false }))} /><button className="primary full" onClick={draftSummaries}>生成可编辑摘要草稿</button></div><div className="panel full-width context-panel"><div className="panel-head"><div><div className="panel-kicker">READY FOR LLM</div><h2>确认后的 LLM 上下文</h2><p>只有确认后的摘要才会参与回答，避免模型误用未检查的信息。</p></div><div className="context-actions"><span className={`context-state ${materialClass}`}><i />{materialLabel}</span><button className={materials.confirmed ? "success" : "primary"} onClick={() => setMaterials((state) => ({ ...state, confirmed: !state.confirmed }))}>{materials.confirmed ? "取消确认" : "确认并用于回答"}</button></div></div><div className="summary-grid"><div><label>候选人事实摘要</label><textarea rows={12} value={materials.candidateSummary} onChange={(event) => setMaterials((state) => ({ ...state, candidateSummary: event.target.value, confirmed: false }))} /></div><div><label>岗位要求摘要</label><textarea rows={12} value={materials.jobSummary} onChange={(event) => setMaterials((state) => ({ ...state, jobSummary: event.target.value, confirmed: false }))} /></div></div></div></section>}
      {tab === "materials" && <section className="panel repository-panel"><div className="panel-head"><div><div className="panel-kicker">OPEN SOURCE PROJECT</div><h2>GitHub / Gitee 仓库</h2><p>导入公开仓库的 README、目录和关键配置，用于回答项目与 Vibe Coding 经历问题。</p></div><span className={`context-state ${materials.repository?.confirmed ? "ready" : materials.repository ? "pending" : "muted"}`}><i />{materials.repository?.confirmed ? "已确认" : materials.repository ? "待确认" : "未导入"}</span></div><div className="repository-import-row"><input value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repo 或 https://gitee.com/owner/repo" /><button className="primary" disabled={repositoryImporting} onClick={() => void importRepositoryContext()}>{repositoryImporting ? "导入中…" : "导入仓库"}</button></div>{materials.repository && <><div className="repository-meta"><strong>{materials.repository.name}</strong><span>{materials.repository.provider === "github" ? "GitHub" : "Gitee"} · {materials.repository.branch} · {materials.repository.fileTree.split("\n").filter(Boolean).length} 个文件</span></div><label>项目摘要（可编辑）</label><textarea rows={5} value={materials.repository.summary} onChange={(event) => setMaterials((state) => ({ ...state, repository: state.repository ? { ...state.repository, summary: event.target.value, confirmed: false } : state.repository }))} /><label>关键文件与目录（只读预览）</label><textarea className="repository-preview" readOnly rows={8} value={`${materials.repository.fileTree}\n\n${materials.repository.keyFiles}`} /><div className="context-actions repository-actions"><button className={materials.repository.confirmed ? "success" : "primary"} onClick={() => setMaterials((state) => ({ ...state, repository: state.repository ? { ...state.repository, confirmed: !state.repository.confirmed } : state.repository }))}>{materials.repository.confirmed ? "取消用于回答" : "确认并用于回答"}</button><button onClick={() => setMaterials((state) => ({ ...state, repository: undefined }))}>移除仓库</button></div></>}</section>}
      {tab === "settings" && <section className="settings-stack"><AsrProviderPanel settings={settings} asrProfileTests={asrProfileTests} expandedPresetIds={expandedAsrPresetIds} onToggleExpanded={toggleAsrPresetExpanded} onSelect={selectAsrPreset} onUpdate={updateAsrProfile} onTest={testAsrProfile} onSave={saveConfiguration} />
        <LlmProviderPanel settings={settings} setSettings={setSettings} profileTests={profileTests} profileModelStates={profileModelStates} profileQuery={profileQuery} profileSort={profileSort} expandedProfileIds={expandedProfileIds} setProfileQuery={setProfileQuery} setProfileSort={setProfileSort} onToggleExpanded={toggleProfileExpanded} onAddPreset={addProfileFromPreset} onApplyPreset={applyProfilePreset} onDuplicate={duplicateProfile} onRemove={removeProfile} onMove={moveProfile} onTest={testProfile} onLoadModels={loadProfileModels} onSave={saveConfiguration} />
        <div className="panel"><div className="panel-head"><div><h2>回答策略</h2><p>决定模型在技术问题中优先强调的表达维度。</p></div></div><div className="form-grid"><Field label="面试方向" value={settings.interviewFocus} onChange={(value) => setSettings((state) => ({ ...state, interviewFocus: value as InterviewFocus }))} select={Object.entries(INTERVIEW_FOCUS_LABELS)} /></div></div>
        <div className="panel"><div className="panel-head"><div><h2>全局快捷键</h2><p>关闭后不会注册或响应该快捷键。</p></div><label className="checkbox shortcut-toggle"><input type="checkbox" checked={settings.shortcutEnabled} onChange={(event) => setSettings((state) => ({ ...state, shortcutEnabled: event.target.checked }))} />启用快捷键</label></div><div className="shortcut-field"><span>快捷键</span><ShortcutRecorder value={settings.shortcut} onChange={(value) => setSettings((state) => ({ ...state, shortcut: value }))} /></div></div>
        <div className="panel"><div className="panel-head"><div><h2>界面行为</h2><p>分别控制转写区和回答区是否响应鼠标滚轮。</p></div></div><div className="settings-toggle-grid"><label className="checkbox"><input type="checkbox" checked={settings.wheelScroll.transcript} onChange={(event) => setSettings((state) => ({ ...state, wheelScroll: { ...state.wheelScroll, transcript: event.target.checked } }))} />转写区允许滚轮滚动</label><label className="checkbox"><input type="checkbox" checked={settings.wheelScroll.answer} onChange={(event) => setSettings((state) => ({ ...state, wheelScroll: { ...state.wheelScroll, answer: event.target.checked } }))} />回答区允许滚轮滚动</label></div></div></section>}
      {tab === "history" && <section className="panel history-panel">{selectedHistorySessionId && history.some((session) => session.id === selectedHistorySessionId) ? (() => {
        const session = history.find((item) => item.id === selectedHistorySessionId)!;
        return <div className="history-detail"><div className="panel-head history-detail-header"><div><button className="text-button history-back" onClick={() => setSelectedHistorySessionId(undefined)}>返回会话列表</button><h2>会话详情</h2><p>完整问答仅在详情页显示；修改主题会自动保存。</p></div><button className="primary" disabled={sessionActive} onClick={() => loadSessionContext(session)}>载入为下一轮上下文</button></div><label className="history-session-title-editor"><span>会话主题</span><input value={session.title} onChange={(event) => renameHistorySession(session.id, event.target.value)} placeholder="输入这场面试的主题" /></label><div className="history-meta"><span>创建于 {new Date(session.createdAt).toLocaleString()}</span><span>更新于 {new Date(session.updatedAt).toLocaleString()}</span><span>{session.turns.length} 轮问答</span>{session.carriedTurnCount > 0 && <span>承接 {session.carriedTurnCount} 轮上下文</span>}<span>{session.asrName} → {session.llmName}</span></div>{session.turns.length ? <div className="history-turn-list">{session.turns.map((turn) => <article className="history-turn" key={turn.id}><div className="history-turn-time">{new Date(turn.createdAt).toLocaleString()}</div><h3>{turn.question}</h3>{turn.error ? <p className="error">{turn.error}</p> : <p>{turn.answer}</p>}</article>)}</div> : <p className="empty-session">本次测试尚未提交问题。</p>}</div>;
      })() : <><div className="panel-head"><div><h2>面试会话记录</h2><p>每次启动测试都会创建一场面试；不保存音频。</p></div><button className="danger" onClick={() => { clearHistory(); setHistory([]); setSelectedHistorySessionId(undefined); }}>清空记录</button></div>{history.length ? <div className="history-list">{history.map((session) => <button className="history-summary" key={session.id} onClick={() => setSelectedHistorySessionId(session.id)}><strong>{session.title}</strong><span>{new Date(session.updatedAt).toLocaleString()} · {session.turns.length} 轮问答{session.carriedTurnCount ? ` · 承接 ${session.carriedTurnCount} 轮` : ""}</span><small>{session.asrName} → {session.llmName}</small></button>)}</div> : <p className="empty">还没有面试会话记录。</p>}</>}</section>}
    </section>
  </main>;
}

function AsrProviderPanel({
  settings,
  asrProfileTests,
  expandedPresetIds,
  onToggleExpanded,
  onSelect,
  onUpdate,
  onTest,
  onSave,
}: {
  settings: AppSettings;
  asrProfileTests: Record<string, AsrProfileTestState>;
  expandedPresetIds: AsrPreset[];
  onToggleExpanded: (preset: AsrPreset) => void;
  onSelect: (preset: AsrPreset) => void;
  onUpdate: <K extends keyof AsrProviderConfig>(preset: AsrPreset, key: K, value: AsrProviderConfig[K]) => void;
  onTest: (preset: AsrPreset, mode: "connection" | "final") => void;
  onSave: () => void;
}) {
  return <div className="panel provider-manager-panel asr-provider-manager">
    <div className="panel-head provider-manager-head">
      <div><div className="panel-kicker">ASR PROVIDERS</div><h2>实时语音 Provider</h2><p>每个 Provider 独立保存凭证、协议和高级参数；切换启用配置不会覆盖其他服务。</p></div>
      <button className="primary" onClick={onSave}>保存配置</button>
    </div>
    <div className="provider-preset-strip asr-preset-strip" aria-label="语音识别预配置">
      {ASR_PROVIDER_PRESETS.map((preset) => <button key={preset.id} title={preset.description} onClick={() => { onSelect(preset.id); onToggleExpanded(preset.id); }}><strong>{preset.label}</strong><small>{preset.credentialLabel}</small></button>)}
    </div>
    <div className="provider-list">
      {ASR_PROVIDER_PRESETS.map((preset) => {
        const profile = settings.asrProfiles[preset.id] ?? createAsrPreset(preset.id);
        const test = asrProfileTests[preset.id] ?? { status: "idle" as const };
        const active = settings.asr.preset === preset.id;
        const expanded = expandedPresetIds.includes(preset.id);
        const health = test.status === "success" ? "healthy" : test.status === "error" ? "error" : "idle";
        const missing = asrMissingFields(profile);
        return <article className={`provider-card asr-provider-card ${active ? "active-provider" : ""} ${expanded ? "expanded" : ""}`} key={preset.id}>
          <div className="provider-card-head">
            <div className="provider-card-identity"><span className={`provider-health ${health}`} /><div><strong>{profile.name || preset.label}</strong><span>{preset.protocolLabel} · {profile.audioMode === "binary" ? "PCM 二进制" : "JSON Base64"} · {profile.wsUrl || "未填写地址"}</span></div></div>
            <div className="provider-card-actions">
              <label className="radio provider-active-toggle"><input type="radio" checked={active} onChange={() => onSelect(preset.id)} />启用</label>
              <button onClick={() => onToggleExpanded(preset.id)}>{expanded ? "收起" : "编辑"}</button>
              <button onClick={() => onTest(preset.id, "connection")} disabled={test.status === "testing"}>{test.status === "testing" && test.mode === "connection" ? "连接中…" : "连接测试"}</button>
              <button onClick={() => onTest(preset.id, "final")} disabled={test.status === "testing" || !profile.wsUrl}>{test.status === "testing" && test.mode === "final" ? "等待文本…" : "最终文本"}</button>
            </div>
          </div>
          <div className="provider-card-meta"><span>{missing.length ? `待填写：${missing.join("、")}` : preset.credentialLabel}</span><span>{test.status === "success" ? `${test.mode === "final" ? "最终事件" : "可用"} · ${test.latencyMs} ms${test.finalText ? ` · ${test.finalText}` : ""}` : test.status === "error" ? `${test.errorKind || "失败"} · ${test.message || "请检查配置"}` : "尚未测试"}</span><span>{active ? "当前启用" : "未启用"}</span></div>
          {expanded && <div className="provider-card-editor asr-provider-editor">
            <div className="provider-editor-top"><Field label="名称" value={profile.name} onChange={(value) => onUpdate(preset.id, "name", value)} /><Field label="WebSocket URL" value={profile.wsUrl} onChange={(value) => onUpdate(preset.id, "wsUrl", value)} placeholder="wss://…" /></div>
            <div className="form-grid"><Field label={profile.protocol === "aliyun-nls" ? "阿里云临时 Token" : profile.protocol === "volcengine-asr" ? "豆包 Access Token" : "API Key（可选）"} value={profile.apiKey} type="password" onChange={(value) => onUpdate(preset.id, "apiKey", value)} />{profile.protocol === "aliyun-nls" && <Field label="阿里云 AppKey" value={profile.appKey || ""} onChange={(value) => onUpdate(preset.id, "appKey", value)} />}{profile.protocol === "volcengine-asr" && <><Field label="豆包 App ID" value={profile.appId || ""} onChange={(value) => onUpdate(preset.id, "appId", value)} /><Field label="豆包 Cluster" value={profile.cluster || ""} onChange={(value) => onUpdate(preset.id, "cluster", value)} placeholder="控制台显示的 Cluster ID" /></>}<Field label="超时（ms）" value={String(profile.timeoutMs)} onChange={(value) => onUpdate(preset.id, "timeoutMs", Number(value) || 10000)} /></div>
            {profile.protocol === "volcengine-asr" && <p className="config-warning">豆包需要自定义二进制协议和 Authorization 头；当前浏览器 WebSocket 适配器只保存并诊断该配置，实时会话仍请先使用阿里云或通用 WebSocket。</p>}
            <details><summary>高级协议与稳定性</summary><p className="config-note">断线时最多重连指定次数，音频缓存有上限；最终事件会自动去重。</p><div className="form-grid three"><Field label="音频封装" value={profile.audioMode} onChange={(value) => onUpdate(preset.id, "audioMode", value as AsrProviderConfig["audioMode"])} select={[["binary", "原始二进制 PCM"], ["json-base64", "JSON Base64"]]} /><Field label="重连次数" value={String(profile.reconnectAttempts ?? 2)} onChange={(value) => onUpdate(preset.id, "reconnectAttempts", Number(value) || 0)} /><Field label="重连间隔（ms）" value={String(profile.reconnectDelayMs ?? 800)} onChange={(value) => onUpdate(preset.id, "reconnectDelayMs", Number(value) || 800)} /><Field label="音频队列上限" value={String(profile.audioQueueLimit ?? 24)} onChange={(value) => onUpdate(preset.id, "audioQueueLimit", Number(value) || 24)} /><Field label="事件路径" value={profile.eventPath || ""} onChange={(value) => onUpdate(preset.id, "eventPath", value)} /><Field label="文本路径" value={profile.textPath || ""} onChange={(value) => onUpdate(preset.id, "textPath", value)} /><Field label="增量事件" value={profile.partialEvent || ""} onChange={(value) => onUpdate(preset.id, "partialEvent", value)} /><Field label="最终事件" value={profile.finalEvent || ""} onChange={(value) => onUpdate(preset.id, "finalEvent", value)} /><Field label="错误事件" value={profile.errorEvent || ""} onChange={(value) => onUpdate(preset.id, "errorEvent", value)} /></div><label>初始化消息 JSON</label><textarea rows={3} value={profile.initMessage || ""} onChange={(event) => onUpdate(preset.id, "initMessage", event.target.value)} /><label>JSON/Base64 音频模板（使用 {'{{base64}}'}）</label><textarea rows={2} value={profile.audioTemplate || ""} onChange={(event) => onUpdate(preset.id, "audioTemplate", event.target.value)} /><label>结束 / Flush 消息 JSON</label><textarea rows={2} value={profile.finalizeMessage || ""} onChange={(event) => onUpdate(preset.id, "finalizeMessage", event.target.value)} /></details>
            <label className="checkbox"><input type="checkbox" checked={profile.debug} onChange={(event) => onUpdate(preset.id, "debug", event.target.checked)} />显示原始消息调试日志</label>
            <div className="config-preview"><div><strong>asr.toml 预览</strong><span>凭证默认隐藏</span></div><textarea readOnly rows={8} value={asrConfigPreview(profile)} /></div>
          </div>}
        </article>;
      })}
    </div>
  </div>;
}

function LlmProviderPanel({
  settings,
  setSettings,
  profileTests,
  profileModelStates,
  profileQuery,
  profileSort,
  expandedProfileIds,
  setProfileQuery,
  setProfileSort,
  onToggleExpanded,
  onAddPreset,
  onApplyPreset,
  onDuplicate,
  onRemove,
  onMove,
  onTest,
  onLoadModels,
  onSave,
}: {
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  profileTests: Record<string, ProfileTestState>;
  profileModelStates: Record<string, ProfileModelState>;
  profileQuery: string;
  profileSort: ProfileSort;
  expandedProfileIds: string[];
  setProfileQuery: (value: string) => void;
  setProfileSort: (value: ProfileSort) => void;
  onToggleExpanded: (id: string) => void;
  onAddPreset: (id?: LlmProviderPresetId) => void;
  onApplyPreset: (id: string, preset: LlmProviderPresetId) => void;
  onDuplicate: (profile: LlmProfile) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onTest: (profile: LlmProfile) => void;
  onLoadModels: (profile: LlmProfile) => void;
  onSave: () => void;
}) {
  const visibleProfiles = useMemo(() => {
    const query = profileQuery.trim().toLowerCase();
    const filtered = settings.llmProfiles.filter((profile) => {
      if (!query) return true;
      return [profile.name, providerLabel(profile), profile.baseUrl, profile.model].some((value) => value?.toLowerCase().includes(query));
    });
    return filtered.sort((left, right) => {
      if (profileSort === "name") return left.name.localeCompare(right.name, "zh-CN");
      if (profileSort === "updated") {
        const leftState = profileTests[left.id]?.status === "success" ? 1 : 0;
        const rightState = profileTests[right.id]?.status === "success" ? 1 : 0;
        return rightState - leftState || left.name.localeCompare(right.name, "zh-CN");
      }
      return (left.id === settings.activeLlmProfileId ? -1 : 1) - (right.id === settings.activeLlmProfileId ? -1 : 1);
    });
  }, [profileQuery, profileSort, profileTests, settings.llmProfiles, settings.activeLlmProfileId]);

  function updateProfile<K extends keyof LlmProfile>(id: string, key: K, value: LlmProfile[K]) {
    setSettings((state) => ({ ...state, llmProfiles: state.llmProfiles.map((item) => item.id === id ? { ...item, [key]: value } : item) }));
  }

  return <div className="panel provider-manager-panel">
    <div className="panel-head provider-manager-head">
      <div><div className="panel-kicker">MODEL PROVIDERS</div><h2>文本模型 Provider</h2><p>像 CC Switch 一样集中管理预配置、启用状态、测速和模型列表。</p></div>
      <div className="provider-manager-actions"><button onClick={() => onAddPreset()}>添加自定义</button><button className="primary" onClick={onSave}>保存配置</button></div>
    </div>
    <div className="provider-toolbar">
      <label className="provider-search"><span>搜索</span><input value={profileQuery} onChange={(event) => setProfileQuery(event.target.value)} placeholder="名称、Provider、模型或地址" /></label>
      <label className="provider-sort"><span>排序</span><select value={profileSort} onChange={(event) => setProfileSort(event.target.value as ProfileSort)}><option value="active">当前启用优先</option><option value="name">名称</option><option value="updated">最近测试可用</option></select></label>
      <span className="provider-count">{visibleProfiles.length} / {settings.llmProfiles.length} 个配置</span>
    </div>
    <div className="provider-preset-strip" aria-label="新增 Provider 预配置">
      {LLM_PROVIDER_PRESETS.map((preset) => <button key={preset.id} title={preset.description} onClick={() => onAddPreset(preset.id)}><strong>{preset.label}</strong><small>{preset.defaultModel || "填写模型"}</small></button>)}
    </div>
    <div className="provider-list">
      {visibleProfiles.length === 0 && <div className="provider-empty">没有匹配的模型配置。</div>}
      {visibleProfiles.map((profile) => {
        const test = profileTests[profile.id] ?? { status: "idle" as const };
        const modelState = profileModelStates[profile.id] ?? { status: "idle" as const, models: profile.modelOptions ?? [] };
        const expanded = expandedProfileIds.includes(profile.id);
        const active = profile.id === settings.activeLlmProfileId;
        const health = test.status === "success" ? "healthy" : test.status === "error" ? "error" : "idle";
        return <article key={profile.id} className={`provider-card ${active ? "active-provider" : ""} ${expanded ? "expanded" : ""}`}>
          <div className="provider-card-head">
            <div className="provider-card-identity"><span className={`provider-health ${health}`} /><div><strong>{profile.name || "未命名模型"}</strong><span>{providerLabel(profile)} · {profile.protocol === "responses" ? "Responses API" : "Chat Completions"} · {profile.model || "未填写模型"}</span></div></div>
            <div className="provider-card-actions">
              <label className="radio provider-active-toggle"><input type="radio" checked={active} onChange={() => setSettings((state) => ({ ...state, activeLlmProfileId: profile.id }))} />启用</label>
              <button title="上移" onClick={() => onMove(profile.id, -1)}>↑</button><button title="下移" onClick={() => onMove(profile.id, 1)}>↓</button>
              <button onClick={() => onToggleExpanded(profile.id)}>{expanded ? "收起" : "编辑"}</button>
              <button onClick={() => onTest(profile)} disabled={test.status === "testing"}>{test.status === "testing" ? "测速中…" : "测速"}</button>
              <button onClick={() => onLoadModels(profile)} disabled={modelState.status === "loading"}>{modelState.status === "loading" ? "读取中…" : "模型列表"}</button>
              <button onClick={() => onDuplicate(profile)}>复制</button>
              <button className="link danger-text" disabled={active} onClick={() => onRemove(profile.id)}>删除</button>
            </div>
          </div>
          <div className="provider-card-meta"><span>{profile.baseUrl || "未填写 Base URL"}</span><span>{test.status === "success" ? `可用 · ${test.latencyMs} ms · 首 Token ${test.firstTokenMs ?? "—"} ms` : test.status === "error" ? test.message : "尚未测试"}</span><span>{modelState.models.length ? `${modelState.models.length} 个模型` : "未读取模型列表"}</span></div>
          {expanded && <div className="provider-card-editor">
            <div className="provider-editor-top"><Field label="Provider 预配置" value={profile.preset ?? profile.provider ?? "custom"} onChange={(value) => onApplyPreset(profile.id, value as LlmProviderPresetId)} select={[["custom", "自定义 Provider"], ...LLM_PROVIDER_PRESETS.map((preset) => [preset.id, preset.label] as [string, string])]} /><Field label="名称" value={profile.name} onChange={(value) => updateProfile(profile.id, "name", value)} /></div>
            <div className="form-grid"><ModelField profile={profile} models={modelState.models} onChange={(value) => updateProfile(profile.id, "model", value)} /><Field label="Base URL" value={profile.baseUrl} onChange={(value) => updateProfile(profile.id, "baseUrl", value)} placeholder="https://…/v1" /><Field label="Key" value={profile.apiKey} type="password" onChange={(value) => updateProfile(profile.id, "apiKey", value)} /><Field label="上游协议" value={profile.protocol} onChange={(value) => updateProfile(profile.id, "protocol", value as LlmProfile["protocol"])} select={[["responses", "Responses API"], ["chat-completions", "Chat Completions"]]} /><Field label="自定义路径（可选）" value={profile.requestPath || ""} onChange={(value) => updateProfile(profile.id, "requestPath", value)} /><ContextWindowField value={profile.contextWindow || 8000} onChange={(value) => updateProfile(profile.id, "contextWindow", value)} /><Field label="回答精细程度" value={profile.answerDetail || "balanced"} onChange={(value) => updateProfile(profile.id, "answerDetail", value as LlmProfile["answerDetail"])} select={[["concise", "简洁"], ["balanced", "标准"], ["detailed", "详细"]]} /><Field label="思考深度" value={profile.reasoningEffort || "none"} onChange={(value) => updateProfile(profile.id, "reasoningEffort", value as LlmProfile["reasoningEffort"])} select={[["none", "不指定"], ["low", "低"], ["medium", "中"], ["high", "高"]]} /></div>
            <label>额外请求头 JSON</label><textarea rows={2} value={profile.extraHeaders || ""} onChange={(event) => updateProfile(profile.id, "extraHeaders", event.target.value)} />
            {modelState.status === "error" && <p className="provider-inline-error">{modelState.message}</p>}
            <div className="config-preview"><div><strong>config.toml 预览</strong><span>Key 默认隐藏</span></div><textarea readOnly rows={8} value={profileConfigPreview(profile, settings.interviewFocus)} /></div>
          </div>}
        </article>;
      })}
    </div>
  </div>;
}

function ModelField({ profile, models, onChange }: { profile: LlmProfile; models: string[]; onChange: (value: string) => void }) {
  const listId = `models-${profile.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return <label className="field"><span>模型{models.length ? ` · ${models.length} 个可选` : ""}</span><input list={listId} value={profile.model} placeholder="填写模型 ID" onChange={(event) => onChange(event.target.value)} />{models.length > 0 && <datalist id={listId}>{models.map((model) => <option key={model} value={model} />)}</datalist>}</label>;
}

function Field({ label, value, onChange, type = "text", placeholder, select }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; select?: Array<[string, string]> }) {
  return <label className="field"><span>{label}</span>{select ? <select value={value} onChange={(event) => onChange(event.target.value)}>{select.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select> : <input type={type} value={value} placeholder={placeholder} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)} />}</label>;
}

function ContextWindowField({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(formatContextWindow(value));
  useEffect(() => setDraft(formatContextWindow(value)), [value]);
  function commit() {
    const parsed = parseContextWindow(draft);
    if (parsed) onChange(parsed);
    else setDraft(formatContextWindow(value));
  }
  return <label className="field context-window-field"><span>上下文窗口</span><input value={draft} inputMode="text" placeholder="8K / 32K / 128K / 1M" onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><small>支持任意 K / M 单位，例如 8K、32K、128K、1M</small></label>;
}

function ShortcutRecorder({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [draft, setDraft] = useState(value);
  const pressedKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const token = shortcutKeyToken(event);
      if (!token) return;
      const next = new Set(pressedKeysRef.current);
      next.add(token);
      pressedKeysRef.current = next;
      setDraft(formatShortcut(next));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      pressedKeysRef.current.delete(shortcutKeyToken(event));
    };
    const onWindowBlur = () => pressedKeysRef.current.clear();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
      pressedKeysRef.current.clear();
    };
  }, [recording]);

  function toggleRecording() {
    if (recording) {
      if (draft) onChange(draft);
      pressedKeysRef.current.clear();
      setRecording(false);
      return;
    }
    pressedKeysRef.current.clear();
    setDraft(value);
    setRecording(true);
  }

  return <div className="shortcut-editor"><button type="button" className={recording ? "shortcut-recorder recording" : "shortcut-recorder"} aria-label={recording ? "确认快捷键修改" : "点击录制快捷键"} aria-pressed={recording} onClick={toggleRecording}>{recording ? draft || "请按下快捷键" : value}</button><span className="shortcut-state">{recording ? "再次点击确认" : "点击修改"}</span></div>;
}

export default App;
import "./theme.css";
