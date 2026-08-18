import { ChangeEvent, CSSProperties, Dispatch, SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { GenericAsrSession } from "./lib/asr";
import { ASR_PROVIDER_PRESETS, asrConfigPreview, asrConfigReady, asrMissingFields, asrProviderLabel, classifyAsrError, testAsrConnection, testAsrFinalText } from "./lib/asr-providers";
import { BUILD_INFO } from "./lib/build-info";
import { buildInterviewPrompt, listLlmModels, sanitizeAnswerText, sanitizeLlmError, selectInterviewContext, streamLlm, testLlmConnection } from "./lib/llm";
import { extractMaterialText, makeCandidateDraft, makeJobDraft } from "./lib/materials";
import { applyLlmProviderPreset, LLM_PROVIDER_PRESETS, providerLabel, providerRequiresKey } from "./lib/providers";
import { importRepository as importRepositoryMaterial } from "./lib/repository";
import { detectRuntimeEnvironment } from "./lib/runtime";
import { formatShortcut, shortcutKeyToken, toGlobalShortcut } from "./lib/shortcut";
import { clearHistory, createSafeDataBundle, defaultSettings, emptyMaterials, getStorageDiagnostics, initializeStorage, loadHistory, loadMaterials, loadSettings, markCleanShutdown, parseSafeDataBundle, restoreLatestBackup, saveHistory, saveMaterials, saveSettings, saveSnapshot } from "./lib/storage";
import type { StorageDiagnostics } from "./lib/storage";
import type { AnswerFramework, AnswerStatus, AppSettings, AsrPreset, AsrProviderConfig, AsrStatus, InterviewContextTurn, InterviewFocus, InterviewSession, InterviewTurn, LlmProfile, LlmProviderPresetId, MaterialContext, OverlayLayout, OverlaySettings, SessionRecord, WheelScrollSettings } from "./types";
import { ANSWER_FRAMEWORK_LABELS, createAsrPreset, createDefaultLlmProfile, INTERVIEW_FOCUS_LABELS } from "./types";
import "./App.css";
import "./theme.css";

type Tab = "session" | "materials" | "settings" | "history";
type SessionMode = "idle" | "all" | "asr" | "answer";
type TestMode = "all" | "asr" | "answer";
type SessionStage = "idle" | "manual" | "listening" | "finalizing" | "answering" | "complete";
type ProfileTestState = { status: "idle" | "testing" | "success" | "error"; testedAt?: string; latencyMs?: number; firstTokenMs?: number; message?: string };
type ProfileSort = "active" | "name" | "updated";
type ProfileModelState = { status: "idle" | "loading" | "success" | "error"; models: string[]; message?: string };
type AsrProfileTestState = { status: "idle" | "testing" | "success" | "error"; mode?: "connection" | "final"; latencyMs?: number; finalText?: string; errorKind?: string; message?: string; hint?: string };
type LlmEditorTab = "basic" | "parameters" | "advanced" | "raw";

function persistedProfileTest(profile: Pick<LlmProfile, "health">): ProfileTestState {
  return profile.health ? { ...profile.health } : { status: "idle" };
}
type OverlayCommand = { command: "start" | "submit" | "stop" | "pause" | "stop-generation" | "regenerate" | "hide"; testMode?: TestMode };
type OverlayState = {
  answer: string;
  question: string;
  lastQuestion: string;
  partial: string;
  sessionActive: boolean;
  sessionPaused: boolean;
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
  overlaySettings: OverlaySettings;
  wheelScroll: WheelScrollSettings;
  interviewFocus: string;
  materialsLabel: string;
  carriedTurnCount: number;
  sourceTitle: string;
  completeContextTurnCount: number;
  sentContextTurnCount: number;
  omittedContextTurnCount: number;
};

const DEFAULT_OVERLAY_STATE: OverlayState = {
  answer: "",
  question: "",
  lastQuestion: "",
  partial: "",
  sessionActive: false,
  sessionPaused: false,
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
  overlaySettings: {
    alwaysOnTop: true,
    opacity: 0.96,
    fontScale: 1,
    layout: "standard",
    clickThrough: false,
    autoFollow: true,
    size: { width: 520, height: 440 },
  },
  wheelScroll: { transcript: false, answer: false },
  interviewFocus: "",
  materialsLabel: "未添加材料",
  carriedTurnCount: 0,
  sourceTitle: "",
  completeContextTurnCount: 0,
  sentContextTurnCount: 0,
  omittedContextTurnCount: 0,
};

function splitAnswerText(raw: string) {
  const responseMarker = raw.match(/(?:【参考回答】|参考回答\s*[:：])([\s\S]*)/i);
  if (!responseMarker || responseMarker.index === undefined) return { outline: "", response: raw.trim() };
  const outline = raw.slice(0, responseMarker.index).replace(/(?:【要点】|要点(?:提纲)?\s*[:：]?)/i, "").trim();
  return { outline, response: responseMarker[1].trim() };
}

function makeStageSummary(turns: SessionRecord[]) {
  const completed = turns.filter((turn) => !turn.error && turn.question.trim() && turn.answer.trim()).slice(-6);
  if (!completed.length) return "";
  return completed.map((turn, index) => {
    const question = turn.question.replace(/\s+/g, " ").trim().slice(0, 90);
    const answer = turn.answer.replace(/\s+/g, " ").trim().slice(0, 150);
    return `${index + 1}. ${question}：${answer}`;
  }).join("\n");
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

function profileConfigPreview(profile: LlmProfile, focus: InterviewFocus, revealKey = false) {
  return `model = "${profile.model || "未填写"}"
provider = "${providerLabel(profile)}"
base_url = "${profile.baseUrl || "未填写"}"
protocol = "${profile.protocol}"
context_window = ${profile.contextWindow || 8000}
answer_detail = "${profile.answerDetail}"
reasoning_effort = "${profile.reasoningEffort}"
interview_focus = "${focus}"
api_key = "${profile.apiKey ? revealKey ? profile.apiKey : "********" : "未填写"}"`;
}

function profileRawConfig(profile: LlmProfile, focus: InterviewFocus, revealKey = false) {
  return JSON.stringify({
    name: profile.name,
    provider: profile.preset ?? profile.provider ?? "custom",
    base_url: profile.baseUrl,
    api_key: profile.apiKey ? revealKey ? profile.apiKey : "********" : "",
    model: profile.model,
    protocol: profile.protocol,
    request_path: profile.requestPath || "",
    context_window: formatContextWindow(profile.contextWindow || 8000),
    answer_detail: profile.answerDetail,
    reasoning_effort: profile.reasoningEffort,
    extra_headers: profile.extraHeaders || "",
    interview_focus: focus,
  }, null, 2);
}

function isLlmProviderPreset(value: unknown): value is LlmProviderPresetId {
  return value === "custom" || LLM_PROVIDER_PRESETS.some((preset) => preset.id === value);
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
  const [contextOpen, setContextOpen] = useState(false);
  const answerRef = useRef<HTMLElement | null>(null);

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
  useEffect(() => {
    if (!state.overlaySettings.autoFollow || !answerRef.current) return;
    answerRef.current.scrollTop = answerRef.current.scrollHeight;
  }, [state.answer, state.overlaySettings.autoFollow]);

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
  function changeOverlaySettings(patch: Partial<OverlaySettings>) {
    void emit("overlay-settings", patch);
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

  const layout = state.overlaySettings.layout;
  const showAnswer = layout !== "transcript";
  const showTranscript = layout !== "answer";
  const compact = layout === "compact";
  const modeLabel = testMode === "asr" ? "语音转文字" : testMode === "answer" ? "问题回答" : "全部启动";
  const answerLabel = state.answerStatus === "generating" ? "正在生成" : state.answerStatus === "complete" ? "回答完成" : state.answerStatus === "error" ? "生成失败" : "等待回答";
  const submitDisabled = !state.sessionActive || state.sessionPaused || state.answerStatus === "generating" || (state.sessionMode === "answer" && !questionDraft.trim());
  const regenerateDisabled = !state.sessionActive || state.answerStatus === "generating" || !state.lastQuestion.trim() || !state.llmReady;
  const overlayStyle = { opacity: state.overlaySettings.opacity, "--overlay-font-scale": state.overlaySettings.fontScale } as CSSProperties;

  return <main className={"overlay-shell overlay-layout-" + layout} style={overlayStyle}>
    <header className="overlay-header" data-tauri-drag-region>
      <div className="overlay-title" data-tauri-drag-region><span className={state.sessionActive ? "overlay-live-dot active" : "overlay-live-dot"} /><div data-tauri-drag-region><strong>悬浮面试台</strong><small>{state.sessionTitle || "未开始会话"} · {state.turnCount} 轮上下文</small></div></div>
      <div className="overlay-window-actions"><button title="隐藏悬浮窗" onClick={() => void hideWindow()}>—</button><button title="关闭悬浮窗" onClick={() => void closeWindow()}>×</button></div>
    </header>
    <section className="overlay-body">
      <div className="overlay-toolbar">
        <label><span>测试内容</span><select value={testMode} onChange={(event) => changeMode(event.target.value as TestMode)} disabled={state.sessionActive}><option value="all">全部启动</option><option value="asr">语音转文字</option><option value="answer">问题回答</option></select></label>
        <span className={"overlay-status " + (state.sessionActive ? "active" : "")}><i />{state.statusLabel} · {modeLabel}</span>
        <button className="overlay-icon-button" title={state.overlaySettings.alwaysOnTop ? "取消置顶" : "置顶悬浮窗"} onClick={() => changeOverlaySettings({ alwaysOnTop: !state.overlaySettings.alwaysOnTop })}>{state.overlaySettings.alwaysOnTop ? "置顶" : "普通"}</button>
        <button className="overlay-icon-button" title="打开上下文抽屉" onClick={() => setContextOpen((open) => !open)}>上下文</button>
      </div>
      <div className="overlay-settings-strip">
        <label><span>布局</span><select value={layout} onChange={(event) => changeOverlaySettings({ layout: event.target.value as OverlayLayout })}><option value="compact">紧凑</option><option value="standard">标准</option><option value="answer">只回答</option><option value="transcript">只转写</option></select></label>
        <label className="overlay-range"><span>透明度</span><input type="range" min="0.55" max="1" step="0.01" value={state.overlaySettings.opacity} onChange={(event) => changeOverlaySettings({ opacity: Number(event.target.value) })} /></label>
        <label className="overlay-range"><span>字号</span><input type="range" min="0.8" max="1.35" step="0.05" value={state.overlaySettings.fontScale} onChange={(event) => changeOverlaySettings({ fontScale: Number(event.target.value) })} /></label>
        <button className={"overlay-toggle " + (state.overlaySettings.clickThrough ? "active" : "")} title={state.overlaySettings.clickThrough ? "点击穿透中，可用快捷键恢复交互" : "开启点击穿透"} onClick={() => changeOverlaySettings({ clickThrough: !state.overlaySettings.clickThrough })}>{state.overlaySettings.clickThrough ? "穿透中" : "可交互"}</button>
      </div>
      {contextOpen && <aside className="overlay-context-drawer">
        <div><strong>本次上下文</strong><button className="text-button" onClick={() => setContextOpen(false)}>收起</button></div>
        <span>岗位方向：{state.interviewFocus || "未设置"}</span>
        <span>材料状态：{state.materialsLabel}</span>
        <span>完整 {state.completeContextTurnCount} 轮 · 本次发送 {state.sentContextTurnCount} 轮{state.omittedContextTurnCount ? ` · 省略 ${state.omittedContextTurnCount} 轮` : ""}</span>
        <span>当前轮数：{state.turnCount} · 承接 {state.carriedTurnCount} 轮</span>
        {state.sourceTitle && <span>来源会话：{state.sourceTitle}</span>}
      </aside>}
      <div className="overlay-actions">{state.sessionActive ? <><button className="danger" onClick={() => sendCommand("stop")}>结束会话</button><button onClick={() => sendCommand("pause")} disabled={state.answerStatus === "generating"}>{state.sessionPaused ? "继续" : "暂停"}</button>{state.answerStatus === "generating" ? <button className="danger" onClick={() => sendCommand("stop-generation")}>停止生成</button> : <button className="primary" disabled={submitDisabled} onClick={() => sendCommand("submit")}>提交当前问题</button>}<button disabled={regenerateDisabled} onClick={() => sendCommand("regenerate")}>重新生成</button></> : <button className="primary" disabled={testMode === "all" ? !state.llmReady || !state.asrReady : testMode === "asr" ? !state.asrReady : !state.llmReady} onClick={() => sendCommand("start")}>启动测试</button>}<span>{copyNotice || state.notice}</span></div>
      <div className="overlay-field-heading"><strong>当前问题</strong><small>{state.sessionMode === "answer" ? "可直接输入并提交" : "可编辑转写文本"}</small></div>
      <textarea className="overlay-question" value={questionDraft} onChange={(event) => changeQuestion(event.target.value)} placeholder="输入或等待当前面试问题…" />
      {showTranscript && <div className="overlay-transcript-block"><div className="overlay-partial" onWheel={(event) => { if (!state.wheelScroll.transcript) event.preventDefault(); }}><span>实时增量转写</span><p>{state.partial || "等待系统音频…"}</p></div></div>}
      {showAnswer && <><div className="overlay-answer-head"><strong>回答</strong><span className={"overlay-answer-status " + state.answerStatus}>{answerLabel}</span></div><article ref={answerRef} className="overlay-answer" onWheel={(event) => { if (!state.wheelScroll.answer) event.preventDefault(); }}>{state.answer || "回答生成后会在这里显示。"}</article></>}
      {!compact && <div className="overlay-footer"><button onClick={() => void copyAnswer()} disabled={!state.answer}>复制回答</button><button disabled={regenerateDisabled} onClick={() => sendCommand("regenerate")}>重新生成</button><span>主窗口与悬浮窗共享同一场面试上下文</span></div>}
    </section>
  </main>;
}
function App() {
  const desktopRuntime = isTauri();
  const isOverlayWindow = new URLSearchParams(window.location.search).get("overlay") === "1";
  const runtimeEnvironment = useMemo(() => detectRuntimeEnvironment(navigator.userAgent, navigator.platform, desktopRuntime), [desktopRuntime]);
  const [tab, setTab] = useState<Tab>("session");
  const [settings, setSettings] = useState<AppSettings>(() => desktopRuntime && !isOverlayWindow ? defaultSettings() : loadSettings());
  const [materials, setMaterials] = useState<MaterialContext>(() => desktopRuntime && !isOverlayWindow ? emptyMaterials() : loadMaterials());
  const [history, setHistory] = useState<InterviewSession[]>(() => desktopRuntime && !isOverlayWindow ? [] : loadHistory());
  const [storageReady, setStorageReady] = useState(!desktopRuntime || isOverlayWindow);
  const [storageError, setStorageError] = useState("");
  const [storageDiagnostics, setStorageDiagnostics] = useState<StorageDiagnostics | null>(null);
  const [storageBundleBusy, setStorageBundleBusy] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionPaused, setSessionPaused] = useState(false);
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
  const [activeSessionSourceTitle, setActiveSessionSourceTitle] = useState("");
  const [activeSessionCarriedTurnCount, setActiveSessionCarriedTurnCount] = useState(0);
  const [contextStats, setContextStats] = useState({ total: 0, sent: 0, omitted: 0 });
  const [pendingContextTurns, setPendingContextTurns] = useState<InterviewContextTurn[]>([]);
  const [sessionFrameworkOverride, setSessionFrameworkOverride] = useState<AnswerFramework | "">("");
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<string | undefined>();
  const [historyQuery, setHistoryQuery] = useState("");
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
  const overlayBoundWindowRef = useRef<WebviewWindow | null>(null);
  const overlayUnlistenRef = useRef<Array<() => void>>([]);
  const overlayStatePersistTimerRef = useRef<number | undefined>(undefined);
  const overlayActionsRef = useRef<{ start: (mode: TestMode) => void; submit: () => void; stop: () => void; pause: () => void; stopGeneration: () => void; regenerate: () => void }>({ start: () => {}, submit: () => {}, stop: () => {}, pause: () => {}, stopGeneration: () => {}, regenerate: () => {} });
  const closeToTrayRef = useRef(true);
  const generationAbortRef = useRef<AbortController | null>(null);
  const lastQuestionRef = useRef("");
  const interviewTurnsRef = useRef<InterviewTurn[]>([]);
  const completeHistoryCountRef = useRef(0);
  const activeSessionIdRef = useRef("");
  const loadedContextRef = useRef<InterviewContextTurn[]>([]);
  const loadedSourceSessionIdRef = useRef<string | undefined>(undefined);
  const activeProfile = useMemo(() => settings.llmProfiles.find((item) => item.id === settings.activeLlmProfileId) ?? settings.llmProfiles[0], [settings]);
  const visibleHistory = useMemo(() => {
    const query = historyQuery.trim().toLocaleLowerCase();
    if (!query) return history;
    return history.filter((session) => {
      const searchable = [
        session.title,
        session.asrName,
        session.llmName,
        session.stageSummary || "",
        new Date(session.createdAt).toLocaleString(),
        new Date(session.updatedAt).toLocaleString(),
        ...session.turns.flatMap((turn) => [turn.question, turn.answer, turn.error || ""]),
      ].join(" ").toLocaleLowerCase();
      return searchable.includes(query);
    });
  }, [history, historyQuery]);
  const llmReady = Boolean(activeProfile?.baseUrl.trim() && activeProfile?.model.trim() && activeProfile && (!providerRequiresKey(activeProfile) || activeProfile.apiKey.trim()));
  const asrReady = asrConfigReady(settings.asr);
  const hasMaterials = Boolean(materials.resume.trim() || materials.jobDescription.trim() || materials.personalNotes.trim() || materials.candidateSummary.trim() || materials.jobSummary.trim() || materials.repository?.summary.trim());
  const overlayMaterialsLabel = materials.confirmed ? "已确认并用于回答" : hasMaterials ? "有材料，等待确认" : "未添加材料";
  const sessionStage: SessionStage = answerStatus === "generating" ? "answering" : answerStatus === "complete" ? "complete" : !sessionActive ? "idle" : sessionMode === "answer" ? "manual" : asrStatus === "finalizing" ? "finalizing" : "listening";
  const effectiveAnswerFramework = sessionFrameworkOverride || settings.answerFramework;
  const statusLabel = sessionPaused ? "已暂停" : sessionStage === "manual" ? "等待输入" : sessionStage === "answering" ? "正在生成回答" : sessionStage === "complete" ? sessionMode === "asr" ? "转写已完成" : "回答已完成" : sessionStage === "listening" ? "正在聆听" : sessionStage === "finalizing" ? "正在提交问题" : sessionStage === "idle" && !llmReady && testMode !== "asr" ? "待配置模型" : sessionStage === "idle" ? "未开始" : "连接异常";
  testModeRef.current = testMode;
  closeToTrayRef.current = settings.closeToTray;

  function queueOverlayWindowState(patch: Partial<OverlaySettings>) {
    if (overlayStatePersistTimerRef.current) window.clearTimeout(overlayStatePersistTimerRef.current);
    overlayStatePersistTimerRef.current = window.setTimeout(() => {
      setSettings((state) => ({ ...state, overlay: { ...state.overlay, ...patch } }));
    }, 140);
  }
  async function applyOverlayWindowSettings(windowRef: WebviewWindow, overlay: OverlaySettings) {
    const operations: Promise<void>[] = [windowRef.setAlwaysOnTop(overlay.alwaysOnTop), windowRef.setIgnoreCursorEvents(overlay.clickThrough)];
    if (overlay.position) operations.push(windowRef.setPosition(new LogicalPosition(overlay.position.x, overlay.position.y)));
    if (overlay.size) operations.push(windowRef.setSize(new LogicalSize(overlay.size.width, overlay.size.height)));
    await Promise.allSettled(operations);
  }
  async function bindOverlayWindow(windowRef: WebviewWindow) {
    if (overlayBoundWindowRef.current === windowRef) return;
    overlayUnlistenRef.current.forEach((cleanup) => cleanup());
    overlayUnlistenRef.current = [];
    overlayBoundWindowRef.current = windowRef;
    const [unlistenMoved, unlistenResized, unlistenClose] = await Promise.all([
      windowRef.onMoved(async ({ payload }) => {
        const scale = await windowRef.scaleFactor().catch(() => 1);
        const logical = payload.toLogical(scale);
        queueOverlayWindowState({ position: { x: logical.x, y: logical.y } });
      }),
      windowRef.onResized(async ({ payload }) => {
        const scale = await windowRef.scaleFactor().catch(() => 1);
        const logical = payload.toLogical(scale);
        queueOverlayWindowState({ size: { width: Math.max(360, logical.width), height: Math.max(280, logical.height) } });
      }),
      windowRef.onCloseRequested(() => {
        overlayBoundWindowRef.current = null;
        unlistenMoved();
        unlistenResized();
        overlayUnlistenRef.current = [];
      }),
    ]);
    overlayUnlistenRef.current = [unlistenMoved, unlistenResized, unlistenClose];
  }

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
  useEffect(() => {
    if (!storageReady || isOverlayWindow) return;
    void getStorageDiagnostics().then(setStorageDiagnostics);
  }, [storageReady, isOverlayWindow]);
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    let unlisten: () => void = () => {};
    void getCurrentWindow().onCloseRequested(async (event) => {
      if (closeToTrayRef.current) {
        event.preventDefault();
        await getCurrentWindow().hide();
        setNotice("主窗口已隐藏，Interview Lab 仍在系统托盘运行。可从托盘菜单重新打开或退出。");
        return;
      }
      await markCleanShutdown();
    }).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, [desktopRuntime, isOverlayWindow]);
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    let unlisten: () => void = () => {};
    void listen("tray-quit", async () => {
      await markCleanShutdown();
      await invoke("exit_app");
    }).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, [desktopRuntime, isOverlayWindow]);
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
    void unregisterAll().then(async () => {
      if (!settings.shortcutEnabled) return;
      const bindings: Array<[string, () => void]> = [
        [settings.shortcut, () => { void submitQuestion(); }],
        [settings.overlayToggleShortcut, () => { void toggleOverlayWindow(); }],
        [settings.stopGenerationShortcut, () => { stopGeneration(); }],
        [settings.clickThroughShortcut, () => { void toggleOverlayClickThrough(); }],
      ];
      const seen = new Set<string>();
      for (const [shortcut, handler] of bindings) {
        if (!shortcut?.trim()) continue;
        const globalShortcut = toGlobalShortcut(shortcut);
        if (seen.has(globalShortcut)) continue;
        seen.add(globalShortcut);
        await register(globalShortcut, (event) => {
          if (alive && event.state === "Pressed") handler();
        });
      }
    }).catch(() => setNotice("全局快捷键注册失败，可使用界面按钮。"));
    return () => { alive = false; void unregisterAll(); };
  }, [desktopRuntime, isOverlayWindow, settings.shortcut, settings.overlayToggleShortcut, settings.stopGenerationShortcut, settings.clickThroughShortcut, settings.shortcutEnabled, sessionActive]);
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    const state: OverlayState = {
      answer,
      question,
      lastQuestion: lastQuestionRef.current,
      partial,
      sessionActive,
      sessionPaused,
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
      overlaySettings: settings.overlay,
      wheelScroll: settings.wheelScroll,
      interviewFocus: INTERVIEW_FOCUS_LABELS[settings.interviewFocus],
      materialsLabel: overlayMaterialsLabel,
      carriedTurnCount: activeSessionCarriedTurnCount,
      sourceTitle: activeSessionSourceTitle,
      completeContextTurnCount: contextStats.total,
      sentContextTurnCount: contextStats.sent,
      omittedContextTurnCount: contextStats.omitted,
    };
    overlayStateRef.current = state;
    void emitTo("answer-overlay", "overlay-state", state).catch(() => undefined);
  }, [desktopRuntime, isOverlayWindow, answer, question, partial, sessionActive, sessionPaused, sessionMode, testMode, answerStatus, asrStatus, turnCount, notice, statusLabel, activeSessionTitle, activeSessionCarriedTurnCount, activeSessionSourceTitle, llmReady, asrReady, contextStats, settings.overlay, settings.wheelScroll, settings.interviewFocus, overlayMaterialsLabel]);
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    let unlisten: () => void = () => {};
    void listen("overlay-ready", () => {
      void emitTo("answer-overlay", "overlay-state", overlayStateRef.current).catch(() => undefined);
    }).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, [desktopRuntime, isOverlayWindow]);
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    let unlisten: () => void = () => {};
    void listen<Partial<OverlaySettings>>("overlay-settings", (event) => {
      const next = { ...settings.overlay, ...event.payload };
      setSettings((state) => ({ ...state, overlay: next }));
      void WebviewWindow.getByLabel("answer-overlay").then((windowRef) => windowRef ? applyOverlayWindowSettings(windowRef, next) : undefined);
    }).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, [desktopRuntime, isOverlayWindow, settings.overlay]);
  useEffect(() => {
    if (!desktopRuntime || isOverlayWindow) return;
    void WebviewWindow.getByLabel("answer-overlay").then((windowRef) => windowRef ? applyOverlayWindowSettings(windowRef, settings.overlay) : undefined);
  }, [desktopRuntime, isOverlayWindow, settings.overlay]);

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
      setAsrProfileTests((state) => ({ ...state, [preset]: { status: "error", mode, errorKind: classified.label, message: classified.message, hint: classified.hint } }));
      setNotice(`${profile.name}：${classified.label} · ${classified.message}`);
    }
  }
  function duplicateProfile(profile: LlmProfile) {
    const copy: LlmProfile = { ...profile, id: crypto.randomUUID(), name: `${profile.name} 副本`, health: undefined };
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
    setProfileTests((state) => { const next = { ...state }; delete next[profileId]; return next; });
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
      const testedAt = new Date().toISOString();
      const health = { status: "success" as const, testedAt, ...result };
      setProfileTests((state) => ({ ...state, [profile.id]: health }));
      setSettings((state) => ({ ...state, llmProfiles: state.llmProfiles.map((item) => item.id === profile.id ? { ...item, health } : item) }));
    } catch (error) {
      const testedAt = new Date().toISOString();
      const message = sanitizeLlmError(error, profile.apiKey);
      const health = { status: "error" as const, testedAt, message };
      setProfileTests((state) => ({ ...state, [profile.id]: health }));
      setSettings((state) => ({ ...state, llmProfiles: state.llmProfiles.map((item) => item.id === profile.id ? { ...item, health } : item) }));
    }
  }
  function log(raw: string) { if (settings.asr.debug) setDebug((items) => [raw.slice(0, 1000), ...items].slice(0, 30)); }
  function interviewContextForSession(sessionId: string, sessions = history): InterviewContextTurn[] {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const chain: InterviewSession[] = [];
    let current = byId.get(sessionId);
    while (current) {
      chain.unshift(current);
      current = current.sourceSessionId ? byId.get(current.sourceSessionId) : undefined;
    }
    return chain.flatMap((session) => session.turns
      .filter((turn) => !turn.error && turn.question.trim() && turn.answer.trim())
      .map((turn) => ({
        id: turn.id,
        sessionId: session.id,
        question: turn.question,
        answer: turn.answer,
        included: turn.contextIncluded !== false,
        pinned: Boolean(turn.pinned),
      })));
  }
  function promptTurnsForContext(context: InterviewContextTurn[]): InterviewTurn[] {
    return context.filter((turn) => turn.included).map(({ id, question, answer, pinned }) => ({ id, question, answer, pinned }));
  }
  function beginInterview() {
    const now = new Date().toISOString();
    const carriedContext = loadedContextRef.current.filter((turn) => turn.included);
    const carriedTurns = promptTurnsForContext(carriedContext);
    const sourceTitle = loadedSourceSessionIdRef.current ? history.find((session) => session.id === loadedSourceSessionIdRef.current)?.title || "" : "";
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
      stageSummary: loadedSourceSessionIdRef.current ? history.find((session) => session.id === loadedSourceSessionIdRef.current)?.stageSummary || "" : "",
      lastContextTurnCount: carriedTurns.length,
      lastOmittedTurnCount: 0,
    };
    activeSessionIdRef.current = session.id;
    lastQuestionRef.current = "";
    setActiveSessionTitle(title);
    setActiveSessionSourceTitle(sourceTitle);
    setActiveSessionCarriedTurnCount(carriedTurns.length);
    interviewTurnsRef.current = carriedTurns;
    loadedContextRef.current = [];
    setPendingContextTurns([]);
    loadedSourceSessionIdRef.current = undefined;
    completeHistoryCountRef.current = carriedContext.length;
    setTurnCount(carriedTurns.length);
    setContextStats({ total: carriedContext.length, sent: carriedTurns.length, omitted: 0 });
    setHistory((items) => [session, ...items]);
    setSettings((state) => ({ ...state, sessionTitleDraft: "" }));
  }
  function appendSessionRecord(record: SessionRecord) {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    setHistory((items) => items.map((session) => {
      if (session.id !== sessionId) return session;
      const turns = [...session.turns, { ...record, contextIncluded: record.contextIncluded !== false, pinned: Boolean(record.pinned) }];
      return {
        ...session,
        updatedAt: record.createdAt,
        turns,
        stageSummary: session.stageSummary?.trim() ? session.stageSummary : makeStageSummary(turns),
      };
    }));
  }
  function loadSessionContext(session: InterviewSession) {
    if (sessionActive) { setNotice("请先结束当前会话，再载入历史会话作为下一轮上下文。"); return; }
    const context = interviewContextForSession(session.id);
    const turns = promptTurnsForContext(context);
    loadedContextRef.current = context;
    setPendingContextTurns(context);
    loadedSourceSessionIdRef.current = session.id;
    interviewTurnsRef.current = turns;
    completeHistoryCountRef.current = context.length;
    setTurnCount(turns.length);
    setContextStats({ total: context.length, sent: turns.length, omitted: 0 });
    setQuestion("");
    setAnswer("");
    setAnswerStatus("idle");
    setSettings((state) => ({ ...state, sessionTitleDraft: `${session.title} · 下一轮` }));
    setTab("session");
    setNotice(`已载入 ${context.length} 轮历史问答，其中 ${turns.length} 轮将承接；点击“启动测试”后会创建下一轮面试记录。`);
  }
  function renameHistorySession(sessionId: string, title: string) {
    setHistory((items) => items.map((session) => session.id === sessionId ? { ...session, title, updatedAt: new Date().toISOString() } : session));
  }
  function updateSessionSummary(sessionId: string, stageSummary: string) {
    setHistory((items) => items.map((session) => session.id === sessionId ? { ...session, stageSummary, updatedAt: new Date().toISOString() } : session));
  }
  function updateHistoryTurn(sessionId: string, turnId: string, patch: Partial<SessionRecord>) {
    setHistory((items) => items.map((session) => session.id === sessionId
      ? { ...session, updatedAt: new Date().toISOString(), turns: session.turns.map((turn) => turn.id === turnId ? { ...turn, ...patch } : turn) }
      : session));
    if (patch.question !== undefined || patch.answer !== undefined) {
      const nextContext = loadedContextRef.current.map((turn) => turn.id === turnId
        ? { ...turn, ...(patch.question !== undefined ? { question: patch.question } : {}), ...(patch.answer !== undefined ? { answer: patch.answer } : {}) }
        : turn);
      loadedContextRef.current = nextContext;
      setPendingContextTurns(nextContext);
      const promptTurns = promptTurnsForContext(nextContext);
      interviewTurnsRef.current = promptTurns;
      completeHistoryCountRef.current = nextContext.length;
      setTurnCount(promptTurns.length);
      setContextStats((stats) => ({ ...stats, total: nextContext.length, sent: promptTurns.length }));
    }
  }
  function updateHistoryContext(sessionId: string, turnId: string, patch: Pick<SessionRecord, "contextIncluded" | "pinned">) {
    updateHistoryTurn(sessionId, turnId, patch);
    setPendingContextTurns((items) => items.map((turn) => turn.id === turnId ? { ...turn, included: patch.contextIncluded ?? turn.included, pinned: patch.pinned ?? Boolean(turn.pinned) } : turn));
    loadedContextRef.current = loadedContextRef.current.map((turn) => turn.id === turnId ? { ...turn, included: patch.contextIncluded ?? turn.included, pinned: patch.pinned ?? Boolean(turn.pinned) } : turn);
    const nextContext = loadedContextRef.current;
    const promptTurns = promptTurnsForContext(nextContext);
    interviewTurnsRef.current = promptTurns;
    setTurnCount(promptTurns.length);
    setContextStats({ total: nextContext.length, sent: promptTurns.length, omitted: 0 });
  }
  function generateSessionSummary(session: InterviewSession) {
    const summary = makeStageSummary(session.turns);
    setHistory((items) => items.map((item) => item.id === session.id ? { ...item, stageSummary: summary, updatedAt: new Date().toISOString() } : item));
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
      setSessionPaused(false);
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
    setSessionPaused(false);
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
    generationAbortRef.current?.abort();
    generationAbortRef.current = null;
    const wasAsrSession = sessionMode === "asr" || sessionMode === "all";
    asrRef.current?.close(); asrRef.current = undefined;
    if (desktopRuntime && wasAsrSession) await invoke("stop_system_audio_capture").catch(() => undefined);
    setSessionActive(false); setSessionPaused(false); setSessionMode("idle"); setAsrStatus("idle"); setPartial(""); pendingRef.current = false;
    setActiveSessionTitle("");
    setActiveSessionSourceTitle("");
    setActiveSessionCarriedTurnCount(0);
    setSessionFrameworkOverride("");
    setNotice("会话已结束，仅保留文本记录。");
  }
  async function toggleSessionPause() {
    if (!sessionActive) return;
    const nextPaused = !sessionPaused;
    const wasAsrSession = sessionMode === "asr" || sessionMode === "all";
    try {
      if (desktopRuntime && wasAsrSession) await invoke(nextPaused ? "pause_system_audio_capture" : "resume_system_audio_capture");
      setSessionPaused(nextPaused);
      if (nextPaused) {
        pendingRef.current = false;
        setAsrStatus(sessionMode === "answer" ? "idle" : "listening");
        setNotice("本场面试已暂停；恢复后继续沿用当前会话上下文。");
      } else {
        setAsrStatus(sessionMode === "answer" ? "idle" : "listening");
        setNotice("本场面试已继续，当前问题和上下文保持不变。");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "切换暂停状态失败");
    }
  }
  async function submitQuestion() {
    if (!sessionActive) {
      setNotice("请先点击“启动测试”，再提交当前问题。");
      return;
    }
    if (sessionPaused) {
      setNotice("当前会话已暂停，请先点击“继续”。");
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
  function stopGeneration() {
    const controller = generationAbortRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setAnswerStatus("idle");
    setNotice("已停止生成，当前未完成回答不会写入上下文。");
  }
  async function regenerateAnswer() {
    if (answerStatus === "generating" || !lastQuestionRef.current.trim()) return;
    await generateAnswer(lastQuestionRef.current);
  }
  async function generateAnswer(rawQuestion: string) {
    const finalQuestion = rawQuestion.trim();
    if (!finalQuestion || answerStatus === "generating" || !activeProfile) return;
    lastQuestionRef.current = finalQuestion;
    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    const previousTurns = interviewTurnsRef.current;
    const contextSelection = selectInterviewContext(previousTurns, activeProfile.contextWindow);
    setContextStats({ total: completeHistoryCountRef.current, sent: contextSelection.turns.length, omitted: contextSelection.omittedCount });
    const activeSessionId = activeSessionIdRef.current;
    if (activeSessionId) {
      setHistory((items) => items.map((session) => session.id === activeSessionId
        ? { ...session, lastContextTurnCount: contextSelection.turns.length, lastOmittedTurnCount: contextSelection.omittedCount }
        : session));
    }
    pendingRef.current = false; setQuestion(""); setPartial(""); setAnswer(""); setAnswerStatus("generating"); setAsrStatus("listening");
    await showOverlay("", false, false);
    let full = "";
    try {
      const activeStageSummary = history.find((session) => session.id === activeSessionIdRef.current)?.stageSummary || "";
      await streamLlm(activeProfile, buildInterviewPrompt(finalQuestion, materials, previousTurns, activeProfile.answerDetail, settings.interviewFocus, activeProfile.contextWindow, activeStageSummary, effectiveAnswerFramework), (delta) => {
        full += delta;
        const cleanAnswer = sanitizeAnswerText(full);
        setAnswer(cleanAnswer);
      }, abortController.signal);
      const cleanAnswer = sanitizeAnswerText(full);
      setAnswerStatus("complete");
      interviewTurnsRef.current = [...previousTurns, { question: finalQuestion, answer: cleanAnswer }];
      completeHistoryCountRef.current += 1;
      setTurnCount(interviewTurnsRef.current.length);
      setContextStats((stats) => ({ ...stats, total: completeHistoryCountRef.current }));
      appendSessionRecord({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), question: finalQuestion, answer: cleanAnswer, asrName: settings.asr.name, llmName: activeProfile.name });
    } catch (error) {
      if (abortController.signal.aborted) {
        setAnswerStatus("idle");
        setNotice("已停止生成，当前未完成回答不会写入上下文。");
        return;
      }
      const message = error instanceof Error ? error.message : "文本模型请求失败";
      setAnswerStatus("error"); setNotice(message);
      appendSessionRecord({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), question: finalQuestion, answer: "", asrName: settings.asr.name, llmName: activeProfile.name, error: message });
    } finally {
      if (generationAbortRef.current === abortController) generationAbortRef.current = null;
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
  async function showOverlay(content = answer, focus = false, reveal = true) {
    if (!desktopRuntime || isOverlayWindow) return;
    const snapshot = { ...overlayStateRef.current, answer: content };
    overlayStateRef.current = snapshot;
    const windowRef = await WebviewWindow.getByLabel("answer-overlay");
    if (windowRef) {
      await bindOverlayWindow(windowRef);
      await applyOverlayWindowSettings(windowRef, settings.overlay);
      if (reveal) {
        await windowRef.show();
        if (focus) await windowRef.setFocus();
        else await getCurrentWindow().setFocus().catch(() => undefined);
      }
      await emitTo("answer-overlay", "overlay-state", snapshot).catch(() => undefined);
      return;
    }
    const size = settings.overlay.size ?? { width: 520, height: 440 };
    const windowRefNew = new WebviewWindow("answer-overlay", {
      url: "/?overlay=1",
      title: "实时回答",
      width: size.width,
      height: size.height,
      ...(settings.overlay.position ? { x: settings.overlay.position.x, y: settings.overlay.position.y } : {}),
      minWidth: 360,
      minHeight: 280,
      alwaysOnTop: settings.overlay.alwaysOnTop,
      decorations: false,
      resizable: true,
      skipTaskbar: true,
      visible: false,
    });
    await bindOverlayWindow(windowRefNew);
    await applyOverlayWindowSettings(windowRefNew, settings.overlay);
    if (reveal) {
      await windowRefNew.show();
      if (focus) await windowRefNew.setFocus();
      else await getCurrentWindow().setFocus().catch(() => undefined);
    }
    window.setTimeout(() => void emitTo("answer-overlay", "overlay-state", snapshot).catch(() => undefined), 350);
  }
  async function toggleOverlayWindow() {
    if (!desktopRuntime || isOverlayWindow) return;
    const windowRef = await WebviewWindow.getByLabel("answer-overlay");
    if (windowRef) {
      const visible = await windowRef.isVisible().catch(() => false);
      if (visible) {
        await windowRef.hide();
        return;
      }
    }
    await showOverlay(overlayStateRef.current.answer, true, true);
  }
  async function toggleOverlayClickThrough() {
    const next = !overlayStateRef.current.overlaySettings.clickThrough;
    setSettings((state) => ({ ...state, overlay: { ...state.overlay, clickThrough: next } }));
    const windowRef = await WebviewWindow.getByLabel("answer-overlay");
    if (windowRef) await windowRef.setIgnoreCursorEvents(next).catch(() => undefined);
    setNotice(next ? "悬浮窗已开启点击穿透；可再次按快捷键关闭。" : "悬浮窗已恢复可交互。");
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
  function exportSafeBackup() {
    const bundle = createSafeDataBundle({ settings, materials, history });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `interview-lab-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("已导出安全备份；API Key 未包含在文件中。");
  }
  function importSafeBackup() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      setStorageBundleBusy(true);
      try {
        const bundle = parseSafeDataBundle(await file.text());
        const currentProfiles = new Map(settings.llmProfiles.map((profile) => [profile.id, profile]));
        const currentProfilesByName = new Map(settings.llmProfiles.map((profile) => [profile.name, profile]));
        const importedSettings: AppSettings = {
          ...bundle.settings,
          asr: { ...bundle.settings.asr, apiKey: settings.asr.apiKey },
          asrProfiles: Object.fromEntries(Object.entries(bundle.settings.asrProfiles).map(([preset, profile]) => [preset, profile ? { ...profile, apiKey: settings.asrProfiles[preset as AsrPreset]?.apiKey || "" } : profile])) as AppSettings["asrProfiles"],
          llmProfiles: bundle.settings.llmProfiles.map((profile) => ({ ...profile, apiKey: currentProfiles.get(profile.id)?.apiKey || currentProfilesByName.get(profile.name)?.apiKey || "" })),
        };
        await saveSnapshot({ settings: importedSettings, materials: bundle.materials, history: bundle.history });
        setSettings(importedSettings);
        setMaterials(bundle.materials);
        setHistory(bundle.history);
        setStorageDiagnostics(await getStorageDiagnostics());
        setNotice(`已导入安全备份：${bundle.history.length} 场会话；原有 Key 未被覆盖。`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "备份导入失败");
      } finally {
        setStorageBundleBusy(false);
      }
    };
    input.click();
  }
  async function restoreLatestStoredBackup() {
    if (!desktopRuntime || isOverlayWindow) {
      setNotice("只有桌面端 SQLite 存储支持恢复最近备份。");
      return;
    }
    if (!window.confirm("恢复最近备份会覆盖当前配置、材料和会话记录，但会保留本机已有 API Key。继续吗？")) return;
    setStorageBundleBusy(true);
    try {
      const snapshot = await restoreLatestBackup();
      if (!snapshot) {
        setNotice("还没有可恢复的本机备份。");
        return;
      }
      setSettings(snapshot.settings);
      setMaterials(snapshot.materials);
      setHistory(snapshot.history);
      setSelectedHistorySessionId(undefined);
      setStorageDiagnostics(await getStorageDiagnostics());
      setNotice(`已恢复最近备份：${snapshot.history.length} 场会话；本机已有 Key 已保留。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "恢复最近备份失败");
    } finally {
      setStorageBundleBusy(false);
    }
  }
  overlayActionsRef.current = {
    start: (mode) => startTest(mode),
    submit: () => { void submitQuestion(); },
    stop: () => { void stopSession(); },
    pause: () => { void toggleSessionPause(); },
    stopGeneration: () => stopGeneration(),
    regenerate: () => { void regenerateAnswer(); },
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
        } else if (payload.command === "pause") {
          overlayActionsRef.current.pause();
        } else if (payload.command === "stop-generation") {
          overlayActionsRef.current.stopGeneration();
        } else if (payload.command === "regenerate") {
          overlayActionsRef.current.regenerate();
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
      <p className="sidebar-footer">受控测试模式<br />不保存原始音频<br /><span className="build-stamp">v{BUILD_INFO.version} · {BUILD_INFO.commit}</span></p></aside>
    <section className={tab === "session" ? "content session-content" : "content"}><header className="topbar"><div><p className="eyebrow">WINDOWS · REALTIME ASR · LLM</p><h1>{({ session: "会话控制", materials: "候选人材料", settings: "服务配置", history: "文本记录" })[tab]}</h1></div><span className={`status ${statusClass}`}>{statusLabel}</span></header>
      <p className="notice">{notice}</p>
      <div className="quick-status" aria-label="当前配置状态"><span className={llmReady ? "ready" : "pending"}><i />文本模型：{llmReady ? "已就绪" : "待配置"}</span><span className={asrReady ? "ready" : "muted"}><i />ASR：{asrReady ? "已配置" : "未配置"}</span>{tab === "materials" && <span className={materialClass}><i />材料：{materialLabel}</span>}{storageError && <span className="pending"><i />本机存储：异常</span>}<span className="autosave-state"><i />设置自动保存在本机</span></div>
      {tab === "session" && <section className="session-grid">
        <div className="panel session-panel">
          <div className="panel-head session-head"><div><div className="panel-kicker">LIVE SESSION</div><h2>系统音频会话</h2><p>默认输出设备 · PCM16 / Mono / 16kHz</p></div><span className={`session-badge ${sessionStage}`}><i />{statusLabel}</span></div>
          <div className="session-actions"><div className="button-row">{sessionActive ? <><button className="danger" onClick={() => void stopSession()}>结束会话</button><button onClick={() => void toggleSessionPause()} disabled={answerStatus === "generating"}>{sessionPaused ? "继续" : "暂停"}</button></> : <><button className="primary" onClick={() => startTest()}>启动测试</button><label className="test-mode"><span>测试内容</span><select value={testMode} onChange={(event) => setTestMode(event.target.value as TestMode)}><option value="all">全部启动</option><option value="asr">语音转文字</option><option value="answer">问题回答</option></select></label></>}{sessionActive && sessionMode !== "answer" && <button className="primary submit-button" disabled={sessionPaused} onClick={() => void submitQuestion()}>提交当前问题</button>}</div><span className="action-hint">{sessionPaused ? "当前会话已暂停，点击“继续”后恢复" : !settings.shortcutEnabled ? "快捷键已关闭，可使用按钮提交当前问题" : testMode === "asr" && !asrReady ? "先在服务配置中填写 ASR 凭证" : testMode === "answer" && !llmReady ? "先在服务配置中填写文本模型" : testMode === "all" && (!llmReady || !asrReady) ? "全部启动需要同时配置 ASR 与文本模型" : sessionStage === "listening" ? `听到问题后按 ${settings.shortcut} 提交` : sessionStage === "finalizing" ? "正在等待最终转写文本" : sessionStage === "answering" ? "回答会同步显示在右侧" : testMode === "asr" ? "单独验证实时语音转文字" : testMode === "answer" ? "直接输入问题验证回答效果" : "同时验证转写与问题回答"}</span></div>
          <div className="field-heading"><label>实时增量转写</label><span className={asrStatus === "listening" ? "live-dot" : ""}>{asrStatus === "listening" ? "正在接收" : "等待开始"}</span></div>
          <div className="transcript scroll-region" onWheel={(event) => { if (!settings.wheelScroll.transcript) event.preventDefault(); }}>{partial || "等待系统音频…"}</div>
          <div className="field-heading"><label>转写结果 / 当前问题</label><button className="text-button" disabled={!question && !partial} onClick={clearCurrentQuestion}>清空</button></div>
          <textarea rows={6} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="ASR 最终文本会显示在这里，也可以直接输入问题测试模型。" />
          <div className="session-secondary-controls">
            <div className="interview-context">本次面试上下文：完整 {contextStats.total} 轮 · 本次发送 {contextStats.sent} 轮{contextStats.omitted ? ` · 超出窗口省略 ${contextStats.omitted} 轮` : ""}{sessionActive && activeSessionTitle ? ` · ${activeSessionTitle}` : ""}</div>
            {pendingContextTurns.length > 0 && !sessionActive && <div className="pending-context-strip"><span>下一轮将承接 {pendingContextTurns.filter((turn) => turn.included).length} / {pendingContextTurns.length} 轮</span><button className="text-button" onClick={() => { setSelectedHistorySessionId(loadedSourceSessionIdRef.current); setTab("history"); }}>查看并修改上下文</button></div>}
            <SessionProgress stage={sessionStage} mode={sessionMode === "idle" ? testMode : sessionMode} />
            {!sessionActive && <label className="session-title-draft"><span>本次会话主题</span><input value={settings.sessionTitleDraft} onChange={(event) => setSettings((state) => ({ ...state, sessionTitleDraft: event.target.value }))} placeholder="例如：售前解决方案岗位一面" /></label>}
            <label className="session-framework"><span>本场回答框架</span><select value={sessionFrameworkOverride} onChange={(event) => setSessionFrameworkOverride(event.target.value as AnswerFramework | "")}><option value="">跟随默认：{ANSWER_FRAMEWORK_LABELS[settings.answerFramework]}</option>{Object.entries(ANSWER_FRAMEWORK_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <div className="shortcut"><span>全局快捷键</span><kbd>{settings.shortcut}</kbd><span>· 仅在语音转文字或全部启动时用于提交当前语音段</span></div>
          </div>
        </div>
        <div className="panel answer-panel">
          <div className="panel-head"><div><div className="panel-kicker">AI RESPONSE</div><h2>中文回答</h2><p>{INTERVIEW_FOCUS_LABELS[settings.interviewFocus]} · {activeProfile?.answerDetail === "detailed" ? "详细" : activeProfile?.answerDetail === "concise" ? "简洁" : "标准"}</p></div><span className={`answer-status ${answerStatus}`}>{answerStatus === "generating" ? "流式生成中" : answerStatus === "complete" ? "已完成" : answerStatus === "error" ? "生成失败" : "等待问题"}</span></div>
          <div className="answer-toolbar answer-toolbar-top"><button onClick={() => void copyAnswer()} disabled={!answer}>复制回答</button><button onClick={() => void showOverlay(answer, true)}>打开悬浮窗</button>{answerStatus === "generating" ? <button className="danger" onClick={stopGeneration}>停止生成</button> : <><button onClick={() => void regenerateAnswer()} disabled={!sessionActive || !lastQuestionRef.current || !llmReady}>重新生成</button><button className="primary" disabled={!sessionActive || !question || !llmReady} onClick={() => void generateAnswer(question)}>用当前文本生成</button></>}</div>
          <AnswerView answer={answer} wheelEnabled={settings.wheelScroll.answer} />
        </div>
        {settings.asr.debug && <div className="panel debug-panel"><h2>ASR 调试消息</h2><pre>{debug.join("\n\n") || "等待 WebSocket 消息…"}</pre></div>}
      </section>}
      {tab === "materials" && <section className="materials-grid"><div className="panel"><div className="panel-head"><div><div className="panel-kicker">CANDIDATE CONTEXT</div><h2>候选人材料</h2><p>可选：PDF、DOCX、TXT 或直接粘贴。</p></div><button onClick={() => importMaterial("resume")}>导入简历</button></div><label>简历原文</label><textarea rows={10} value={materials.resume} onChange={(event) => setMaterials((state) => ({ ...state, resume: event.target.value, confirmed: false }))} /><label>个人补充资料</label><textarea rows={5} value={materials.personalNotes} onChange={(event) => setMaterials((state) => ({ ...state, personalNotes: event.target.value, confirmed: false }))} /></div><div className="panel"><div className="panel-head"><div><div className="panel-kicker">TARGET ROLE</div><h2>目标岗位</h2><p>可选：一次会话仅使用一份 JD。</p></div><button onClick={() => importMaterial("jobDescription")}>导入 JD</button></div><label>岗位描述</label><textarea rows={10} value={materials.jobDescription} onChange={(event) => setMaterials((state) => ({ ...state, jobDescription: event.target.value, confirmed: false }))} /><button className="primary full" onClick={draftSummaries}>生成可编辑摘要草稿</button></div><div className="panel full-width context-panel"><div className="panel-head"><div><div className="panel-kicker">READY FOR LLM</div><h2>确认后的 LLM 上下文</h2><p>只有确认后的摘要才会参与回答，避免模型误用未检查的信息。</p></div><div className="context-actions"><span className={`context-state ${materialClass}`}><i />{materialLabel}</span><button className={materials.confirmed ? "success" : "primary"} onClick={() => setMaterials((state) => ({ ...state, confirmed: !state.confirmed }))}>{materials.confirmed ? "取消确认" : "确认并用于回答"}</button></div></div><div className="summary-grid"><div><label>候选人事实摘要</label><textarea rows={12} value={materials.candidateSummary} onChange={(event) => setMaterials((state) => ({ ...state, candidateSummary: event.target.value, confirmed: false }))} /></div><div><label>岗位要求摘要</label><textarea rows={12} value={materials.jobSummary} onChange={(event) => setMaterials((state) => ({ ...state, jobSummary: event.target.value, confirmed: false }))} /></div></div></div></section>}
      {tab === "materials" && <section className="panel repository-panel"><div className="panel-head"><div><div className="panel-kicker">OPEN SOURCE PROJECT</div><h2>GitHub / Gitee 仓库</h2><p>导入公开仓库的 README、目录和关键配置，用于回答项目与 Vibe Coding 经历问题。</p></div><span className={`context-state ${materials.repository?.confirmed ? "ready" : materials.repository ? "pending" : "muted"}`}><i />{materials.repository?.confirmed ? "已确认" : materials.repository ? "待确认" : "未导入"}</span></div><div className="repository-import-row"><input value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repo 或 https://gitee.com/owner/repo" /><button className="primary" disabled={repositoryImporting} onClick={() => void importRepositoryContext()}>{repositoryImporting ? "导入中…" : "导入仓库"}</button></div>{materials.repository && <><div className="repository-meta"><strong>{materials.repository.name}</strong><span>{materials.repository.provider === "github" ? "GitHub" : "Gitee"} · {materials.repository.branch} · {materials.repository.fileTree.split("\n").filter(Boolean).length} 个文件</span></div><label>项目摘要（可编辑）</label><textarea rows={5} value={materials.repository.summary} onChange={(event) => setMaterials((state) => ({ ...state, repository: state.repository ? { ...state.repository, summary: event.target.value, confirmed: false } : state.repository }))} /><label>关键文件与目录（只读预览）</label><textarea className="repository-preview" readOnly rows={8} value={`${materials.repository.fileTree}\n\n${materials.repository.keyFiles}`} /><div className="context-actions repository-actions"><button className={materials.repository.confirmed ? "success" : "primary"} onClick={() => setMaterials((state) => ({ ...state, repository: state.repository ? { ...state.repository, confirmed: !state.repository.confirmed } : state.repository }))}>{materials.repository.confirmed ? "取消用于回答" : "确认并用于回答"}</button><button onClick={() => setMaterials((state) => ({ ...state, repository: undefined }))}>移除仓库</button></div></>}</section>}
      {tab === "settings" && <section className="settings-stack"><AsrProviderPanel settings={settings} asrProfileTests={asrProfileTests} expandedPresetIds={expandedAsrPresetIds} onToggleExpanded={toggleAsrPresetExpanded} onSelect={selectAsrPreset} onUpdate={updateAsrProfile} onTest={testAsrProfile} onSave={saveConfiguration} />
        <LlmProviderPanel settings={settings} setSettings={setSettings} profileTests={profileTests} profileModelStates={profileModelStates} profileQuery={profileQuery} profileSort={profileSort} expandedProfileIds={expandedProfileIds} setProfileQuery={setProfileQuery} setProfileSort={setProfileSort} onToggleExpanded={toggleProfileExpanded} onAddPreset={addProfileFromPreset} onApplyPreset={applyProfilePreset} onDuplicate={duplicateProfile} onRemove={removeProfile} onMove={moveProfile} onTest={testProfile} onLoadModels={loadProfileModels} onInvalidateTest={(id) => setProfileTests((state) => { const next = { ...state }; delete next[id]; return next; })} onSave={saveConfiguration} />
        <div className="panel"><div className="panel-head"><div><h2>回答策略</h2><p>默认策略会用于新会话；会话页可以临时覆盖，不会改动这里的配置。</p></div></div><div className="form-grid"><Field label="面试方向" value={settings.interviewFocus} onChange={(value) => setSettings((state) => ({ ...state, interviewFocus: value as InterviewFocus }))} select={Object.entries(INTERVIEW_FOCUS_LABELS)} /><Field label="默认回答框架" value={settings.answerFramework} onChange={(value) => setSettings((state) => ({ ...state, answerFramework: value as AnswerFramework }))} select={Object.entries(ANSWER_FRAMEWORK_LABELS)} /></div></div>
        <div className="panel"><div className="panel-head"><div><h2>全局快捷键</h2><p>关闭后不会注册或响应该组快捷键；快捷键冲突时请更换组合。</p></div><label className="checkbox shortcut-toggle"><input type="checkbox" checked={settings.shortcutEnabled} onChange={(event) => setSettings((state) => ({ ...state, shortcutEnabled: event.target.checked }))} />启用快捷键</label></div><div className="shortcut-grid"><div className="shortcut-field"><span>提交当前问题</span><ShortcutRecorder value={settings.shortcut} onChange={(value) => setSettings((state) => ({ ...state, shortcut: value }))} /></div><div className="shortcut-field"><span>显示 / 隐藏悬浮窗</span><ShortcutRecorder value={settings.overlayToggleShortcut} onChange={(value) => setSettings((state) => ({ ...state, overlayToggleShortcut: value }))} /></div><div className="shortcut-field"><span>停止回答生成</span><ShortcutRecorder value={settings.stopGenerationShortcut} onChange={(value) => setSettings((state) => ({ ...state, stopGenerationShortcut: value }))} /></div><div className="shortcut-field"><span>切换点击穿透</span><ShortcutRecorder value={settings.clickThroughShortcut} onChange={(value) => setSettings((state) => ({ ...state, clickThroughShortcut: value }))} /></div></div></div>
        <OverlaySettingsPanel settings={settings.overlay} onChange={(patch) => setSettings((state) => ({ ...state, overlay: { ...state.overlay, ...patch } }))} />
        <div className="panel"><div className="panel-head"><div><h2>界面行为</h2><p>分别控制转写区和回答区是否响应鼠标滚轮。</p></div></div><div className="settings-toggle-grid"><label className="checkbox"><input type="checkbox" checked={settings.wheelScroll.transcript} onChange={(event) => setSettings((state) => ({ ...state, wheelScroll: { ...state.wheelScroll, transcript: event.target.checked } }))} />转写区允许滚轮滚动</label><label className="checkbox"><input type="checkbox" checked={settings.wheelScroll.answer} onChange={(event) => setSettings((state) => ({ ...state, wheelScroll: { ...state.wheelScroll, answer: event.target.checked } }))} />回答区允许滚轮滚动</label></div></div>
        <div className="panel"><div className="panel-head"><div><h2>退出行为</h2><p>关闭主窗口时可继续驻留托盘，悬浮面试台不会被强制结束。</p></div></div><div className="settings-toggle-grid"><label className="checkbox"><input type="checkbox" checked={settings.closeToTray} onChange={(event) => setSettings((state) => ({ ...state, closeToTray: event.target.checked }))} />关闭主窗口后继续在托盘运行</label></div></div>
        <DataSafetyPanel diagnostics={storageDiagnostics} runtimeEnvironment={runtimeEnvironment} busy={storageBundleBusy} onExport={exportSafeBackup} onImport={importSafeBackup} onRestore={restoreLatestStoredBackup} />
      </section>}
      {tab === "history" && <section className="panel history-panel">{selectedHistorySessionId && history.some((session) => session.id === selectedHistorySessionId) ? (() => {
        const session = history.find((item) => item.id === selectedHistorySessionId)!;
        const contextTurns = interviewContextForSession(session.id);
        const carryableCount = contextTurns.filter((turn) => turn.included).length;
        const pinnedCount = contextTurns.filter((turn) => turn.included && turn.pinned).length;
        return <div className="history-detail">
          <div className="panel-head history-detail-header"><div><button className="text-button history-back" onClick={() => setSelectedHistorySessionId(undefined)}>返回会话列表</button><h2>会话详情</h2><p>完整问答保留在这里；载入前可编辑、排除或固定上下文轮次。</p></div><button className="primary" disabled={sessionActive || !carryableCount} onClick={() => loadSessionContext(session)}>载入已选上下文</button></div>
          <label className="history-session-title-editor"><span>会话主题</span><input value={session.title} onChange={(event) => renameHistorySession(session.id, event.target.value)} placeholder="输入这场面试的主题" /></label>
          <div className="history-meta"><span>创建于 {new Date(session.createdAt).toLocaleString()}</span><span>更新于 {new Date(session.updatedAt).toLocaleString()}</span><span>完整 {session.turns.length} 轮</span><span>可承接 {carryableCount} 轮</span>{pinnedCount > 0 && <span>固定 {pinnedCount} 轮</span>}{session.lastContextTurnCount ? <span>上次发送 {session.lastContextTurnCount} 轮{session.lastOmittedTurnCount ? `，省略 ${session.lastOmittedTurnCount} 轮` : ""}</span> : null}{session.carriedTurnCount > 0 && <span>本场承接 {session.carriedTurnCount} 轮</span>}<span>{session.asrName} → {session.llmName}</span></div>
          <div className="history-summary-editor"><div className="history-summary-editor-head"><label>阶段摘要（可编辑）</label><button className="text-button" onClick={() => generateSessionSummary(session)}>根据本场记录生成</button></div><textarea rows={4} value={session.stageSummary || ""} onChange={(event) => updateSessionSummary(session.id, event.target.value)} placeholder="可记录这一轮面试的重点、已确认事实和待追问方向。" /></div>
          <div className="history-context-preview"><div className="history-context-preview-head"><div><strong>载入前上下文</strong><small>勾选“带入”决定下一轮发送内容；固定轮次会优先保留。</small></div><span>{carryableCount} / {contextTurns.length} 轮将承接</span></div>{contextTurns.length ? <div className="context-turn-list">{contextTurns.map((turn, index) => <div className={`context-turn-row ${turn.included ? "included" : "excluded"}`} key={`${turn.sessionId}-${turn.id}`}><span>{index + 1}</span><div><strong>{turn.question}</strong><small>{turn.answer.slice(0, 160)}{turn.answer.length > 160 ? "…" : ""}</small></div><label className="checkbox"><input type="checkbox" checked={turn.included} onChange={(event) => updateHistoryContext(turn.sessionId, turn.id, { contextIncluded: event.target.checked })} />带入</label><label className="checkbox"><input type="checkbox" checked={Boolean(turn.pinned)} disabled={!turn.included} onChange={(event) => updateHistoryContext(turn.sessionId, turn.id, { pinned: event.target.checked })} />固定</label></div>)}</div> : <p className="empty-session">没有可承接的已完成问答。</p>}</div>
          {session.turns.length ? <div className="history-turn-list">{session.turns.map((turn) => <article className="history-turn" key={turn.id}><div className="history-turn-toolbar"><span className="history-turn-time">{new Date(turn.createdAt).toLocaleString()}</span><label className="checkbox"><input type="checkbox" checked={turn.contextIncluded !== false} disabled={Boolean(turn.error)} onChange={(event) => updateHistoryContext(session.id, turn.id, { contextIncluded: event.target.checked })} />带入上下文</label><label className="checkbox"><input type="checkbox" checked={Boolean(turn.pinned)} disabled={turn.contextIncluded === false || Boolean(turn.error)} onChange={(event) => updateHistoryContext(session.id, turn.id, { pinned: event.target.checked })} />固定</label></div><label className="history-edit-field"><span>面试问题</span><textarea rows={3} value={turn.question} onChange={(event) => updateHistoryTurn(session.id, turn.id, { question: event.target.value })} /></label>{turn.error ? <p className="error">{turn.error}</p> : <label className="history-edit-field"><span>回答</span><textarea rows={6} value={turn.answer} onChange={(event) => updateHistoryTurn(session.id, turn.id, { answer: event.target.value })} /></label>}</article>)}</div> : <p className="empty-session">本次测试尚未提交问题。</p>}
        </div>;
      })() : <><div className="panel-head"><div><h2>面试会话记录</h2><p>每次启动测试都会创建一场面试；不保存音频。</p></div><button className="danger" onClick={() => { clearHistory(); setHistory([]); setSelectedHistorySessionId(undefined); setHistoryQuery(""); }}>清空记录</button></div><div className="history-toolbar"><label className="history-search"><span>搜索会话</span><input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="主题、问题、回答、模型或时间" /></label><span>{visibleHistory.length} / {history.length} 场</span>{historyQuery && <button className="text-button" onClick={() => setHistoryQuery("")}>清除搜索</button>}</div>{history.length ? visibleHistory.length ? <div className="history-list">{visibleHistory.map((session) => <button className="history-summary" key={session.id} onClick={() => setSelectedHistorySessionId(session.id)}><strong>{session.title}</strong><span>{new Date(session.updatedAt).toLocaleString()} · 完整 {session.turns.length} 轮{session.carriedTurnCount ? ` · 承接 ${session.carriedTurnCount} 轮` : ""}{session.lastContextTurnCount ? ` · 上次发送 ${session.lastContextTurnCount} 轮` : ""}</span><small>{session.asrName} → {session.llmName}</small></button>)}</div> : <p className="empty">没有匹配的会话记录。</p> : <p className="empty">还没有面试会话记录。</p>}</>}</section>}
    </section>
  </main>;
}

function OverlaySettingsPanel({ settings, onChange }: { settings: OverlaySettings; onChange: (patch: Partial<OverlaySettings>) => void }) {
  return <div className="panel overlay-settings-panel">
    <div className="panel-head"><div><div className="panel-kicker">FLOATING INTERVIEW DESK</div><h2>悬浮面试台</h2><p>悬浮窗可独立调整布局、置顶、透明度和交互方式，位置与尺寸会自动记忆。</p></div><span className="context-state ready"><i />设置自动保存</span></div>
    <div className="form-grid overlay-settings-grid">
      <Field label="默认布局" value={settings.layout} onChange={(value) => onChange({ layout: value as OverlayLayout })} select={[["compact", "紧凑"], ["standard", "标准"], ["answer", "只回答"], ["transcript", "只转写"]]} />
      <label className="field"><span>透明度 · {Math.round(settings.opacity * 100)}%</span><input type="range" min="0.55" max="1" step="0.01" value={settings.opacity} onChange={(event) => onChange({ opacity: Number(event.target.value) })} /></label>
      <label className="field"><span>字号 · {Math.round(settings.fontScale * 100)}%</span><input type="range" min="0.8" max="1.35" step="0.05" value={settings.fontScale} onChange={(event) => onChange({ fontScale: Number(event.target.value) })} /></label>
    </div>
    <div className="settings-toggle-grid overlay-toggle-grid">
      <label className="checkbox"><input type="checkbox" checked={settings.alwaysOnTop} onChange={(event) => onChange({ alwaysOnTop: event.target.checked })} />悬浮窗保持置顶</label>
      <label className="checkbox"><input type="checkbox" checked={settings.autoFollow} onChange={(event) => onChange({ autoFollow: event.target.checked })} />回答生成时自动跟随底部</label>
      <label className="checkbox"><input type="checkbox" checked={settings.clickThrough} onChange={(event) => onChange({ clickThrough: event.target.checked })} />点击穿透（需从主窗口关闭）</label>
    </div>
  </div>;
}

function DataSafetyPanel({ diagnostics, runtimeEnvironment, busy, onExport, onImport, onRestore }: { diagnostics: StorageDiagnostics | null; runtimeEnvironment: { label: string; detail: string }; busy: boolean; onExport: () => void; onImport: () => void; onRestore: () => void | Promise<void> }) {
  const backendLabel = diagnostics?.backend === "sqlite" ? "SQLite" : diagnostics?.backend === "localStorage" ? "浏览器预览存储" : "检测中";
  const integrityLabel = diagnostics?.integrity === "ok" ? "完整性正常" : diagnostics?.integrity === "error" ? "需要检查" : "未检测";
  return <div className="panel data-safety-panel">
    <div className="panel-head"><div><div className="panel-kicker">DATA SAFETY</div><h2>数据与恢复</h2><p>安全备份不包含 API Key；桌面端密钥只保存在 Stronghold，导入或恢复后保留本机已有凭证。</p></div><span className={`context-state ${diagnostics?.integrity === "ok" ? "ready" : diagnostics?.integrity === "error" ? "pending" : "muted"}`}><i />{integrityLabel}</span></div>
    <div className="storage-diagnostics"><span title={runtimeEnvironment.detail}>运行环境：{runtimeEnvironment.label}</span><span>存储：{backendLabel}</span><span>数据版本：{diagnostics?.schemaVersion || BUILD_INFO.dataSchema}</span><span>密钥：{diagnostics?.secretStore === "stronghold" ? "Stronghold" : "不持久化"}</span><span>备份：{diagnostics?.backupCount ?? "—"} 份</span><span className={diagnostics?.uncleanExit ? "diagnostic-warning" : ""}>{diagnostics?.uncleanExit ? "上次异常退出，已保留现有数据" : "上次退出状态正常"}</span>{diagnostics?.lastCleanShutdownAt && <span>上次正常退出：{new Date(diagnostics.lastCleanShutdownAt).toLocaleString()}</span>}{diagnostics?.lastBackupAt && <span>最近备份：{new Date(diagnostics.lastBackupAt).toLocaleString()}</span>}<span>构建：v{BUILD_INFO.version} · {BUILD_INFO.commit}{BUILD_INFO.builtAt ? ` · ${new Date(BUILD_INFO.builtAt).toLocaleString()}` : ""}</span></div>
    {diagnostics?.recoveryMessage && <p className="config-warning storage-recovery-message">{diagnostics.recoveryMessage}</p>}
    <div className="storage-actions"><button onClick={onExport}>导出安全备份</button><button onClick={onImport} disabled={busy}>{busy ? "处理中…" : "导入安全备份"}</button><button onClick={() => void onRestore()} disabled={busy || diagnostics?.backend !== "sqlite" || !diagnostics?.backupCount}>{busy ? "处理中…" : "恢复最近备份"}</button></div>
  </div>;
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
  const [revealedPresetIds, setRevealedPresetIds] = useState<AsrPreset[]>([]);
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
        const revealCredential = revealedPresetIds.includes(preset.id);
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
          <div className="provider-card-meta"><span>{missing.length ? `待填写：${missing.join("、")}` : preset.credentialLabel}</span><span>{test.status === "success" ? `${test.mode === "final" ? "最终事件" : "可用"} · ${test.latencyMs} ms${test.finalText ? ` · ${test.finalText}` : ""}` : test.status === "error" ? <><strong>{test.errorKind || "失败"}</strong> · {test.message || "请检查配置"}{test.hint && <small className="provider-diagnostic-hint">{test.hint}</small>}</> : "尚未测试"}</span><span>{active ? "当前启用" : "未启用"}</span></div>
          {expanded && <div className="provider-card-editor asr-provider-editor">
            <div className="provider-editor-top"><Field label="名称" value={profile.name} onChange={(value) => onUpdate(preset.id, "name", value)} /><Field label="WebSocket URL" value={profile.wsUrl} onChange={(value) => onUpdate(preset.id, "wsUrl", value)} placeholder="wss://…" /></div>
            <div className="form-grid"><Field label={profile.protocol === "aliyun-nls" ? "阿里云临时 Token" : profile.protocol === "volcengine-asr" ? "豆包 Access Token" : "API Key（可选）"} value={profile.apiKey} type="password" onChange={(value) => onUpdate(preset.id, "apiKey", value)} />{profile.protocol === "aliyun-nls" && <Field label="阿里云 AppKey" value={profile.appKey || ""} onChange={(value) => onUpdate(preset.id, "appKey", value)} />}{profile.protocol === "volcengine-asr" && <><Field label="豆包 App ID" value={profile.appId || ""} onChange={(value) => onUpdate(preset.id, "appId", value)} /><Field label="豆包 Cluster" value={profile.cluster || ""} onChange={(value) => onUpdate(preset.id, "cluster", value)} placeholder="控制台显示的 Cluster ID" /></>}<Field label="超时（ms）" value={String(profile.timeoutMs)} onChange={(value) => onUpdate(preset.id, "timeoutMs", Number(value) || 10000)} /></div>
            {profile.protocol === "volcengine-asr" && <p className="config-warning">豆包需要自定义二进制协议和 Authorization 头；当前浏览器 WebSocket 适配器只保存并诊断该配置，实时会话仍请先使用阿里云或通用 WebSocket。</p>}
            <details><summary>高级协议与稳定性</summary><p className="config-note">断线时最多重连指定次数，音频缓存有上限；最终事件会自动去重。</p><div className="form-grid three"><Field label="音频封装" value={profile.audioMode} onChange={(value) => onUpdate(preset.id, "audioMode", value as AsrProviderConfig["audioMode"])} select={[["binary", "原始二进制 PCM"], ["json-base64", "JSON Base64"]]} /><Field label="重连次数" value={String(profile.reconnectAttempts ?? 2)} onChange={(value) => onUpdate(preset.id, "reconnectAttempts", Number(value) || 0)} /><Field label="重连间隔（ms）" value={String(profile.reconnectDelayMs ?? 800)} onChange={(value) => onUpdate(preset.id, "reconnectDelayMs", Number(value) || 800)} /><Field label="音频队列上限" value={String(profile.audioQueueLimit ?? 24)} onChange={(value) => onUpdate(preset.id, "audioQueueLimit", Number(value) || 24)} /><Field label="事件路径" value={profile.eventPath || ""} onChange={(value) => onUpdate(preset.id, "eventPath", value)} /><Field label="文本路径" value={profile.textPath || ""} onChange={(value) => onUpdate(preset.id, "textPath", value)} /><Field label="增量事件" value={profile.partialEvent || ""} onChange={(value) => onUpdate(preset.id, "partialEvent", value)} /><Field label="最终事件" value={profile.finalEvent || ""} onChange={(value) => onUpdate(preset.id, "finalEvent", value)} /><Field label="错误事件" value={profile.errorEvent || ""} onChange={(value) => onUpdate(preset.id, "errorEvent", value)} /></div><label>初始化消息 JSON</label><textarea rows={3} value={profile.initMessage || ""} onChange={(event) => onUpdate(preset.id, "initMessage", event.target.value)} /><label>JSON/Base64 音频模板（使用 {'{{base64}}'}）</label><textarea rows={2} value={profile.audioTemplate || ""} onChange={(event) => onUpdate(preset.id, "audioTemplate", event.target.value)} /><label>结束 / Flush 消息 JSON</label><textarea rows={2} value={profile.finalizeMessage || ""} onChange={(event) => onUpdate(preset.id, "finalizeMessage", event.target.value)} /></details>
            <label className="checkbox"><input type="checkbox" checked={profile.debug} onChange={(event) => onUpdate(preset.id, "debug", event.target.checked)} />显示原始消息调试日志</label>
            <div className="config-preview"><div><strong>asr.toml 预览</strong><span>{revealCredential ? "当前凭证可见" : "凭证默认隐藏"}</span></div><textarea readOnly rows={8} value={asrConfigPreview(profile, revealCredential)} /><label className="checkbox"><input type="checkbox" checked={revealCredential} onChange={(event) => setRevealedPresetIds((ids) => event.target.checked ? [...ids, preset.id] : ids.filter((id) => id !== preset.id))} />显示当前 Key / AppKey</label></div>
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
  onInvalidateTest,
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
  onInvalidateTest: (id: string) => void;
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
        const leftTest = profileTests[left.id] ?? persistedProfileTest(left);
        const rightTest = profileTests[right.id] ?? persistedProfileTest(right);
        const leftState = leftTest.status === "success" ? 1 : 0;
        const rightState = rightTest.status === "success" ? 1 : 0;
        return rightState - leftState || (rightTest.testedAt || "").localeCompare(leftTest.testedAt || "") || left.name.localeCompare(right.name, "zh-CN");
      }
      return (left.id === settings.activeLlmProfileId ? -1 : 1) - (right.id === settings.activeLlmProfileId ? -1 : 1);
    });
  }, [profileQuery, profileSort, profileTests, settings.llmProfiles, settings.activeLlmProfileId]);

  function updateProfile<K extends keyof LlmProfile>(id: string, key: K, value: LlmProfile[K]) {
    setSettings((state) => ({ ...state, llmProfiles: state.llmProfiles.map((item) => item.id === id ? { ...item, [key]: value, health: undefined } : item) }));
    onInvalidateTest(id);
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
        const test = profileTests[profile.id] ?? persistedProfileTest(profile);
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
          {expanded && <LlmProfileEditor profile={profile} models={modelState.models} modelState={modelState} focus={settings.interviewFocus} onUpdate={(key, value) => updateProfile(profile.id, key, value)} onApplyPreset={(preset) => onApplyPreset(profile.id, preset)} />}
        </article>;
      })}
    </div>
  </div>;
}

function ModelField({ profile, models, onChange }: { profile: LlmProfile; models: string[]; onChange: (value: string) => void }) {
  const listId = `models-${profile.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return <label className="field"><span>模型{models.length ? ` · ${models.length} 个可选` : ""}</span><input list={listId} value={profile.model} placeholder="填写模型 ID" onChange={(event) => onChange(event.target.value)} />{models.length > 0 && <datalist id={listId}>{models.map((model) => <option key={model} value={model} />)}</datalist>}</label>;
}

function LlmProfileEditor({ profile, models, modelState, focus, onUpdate, onApplyPreset }: {
  profile: LlmProfile;
  models: string[];
  modelState: ProfileModelState;
  focus: InterviewFocus;
  onUpdate: <K extends keyof LlmProfile>(key: K, value: LlmProfile[K]) => void;
  onApplyPreset: (preset: LlmProviderPresetId) => void;
}) {
  const [tab, setTab] = useState<LlmEditorTab>("basic");
  const [rawDraft, setRawDraft] = useState<string | undefined>(undefined);
  const [rawError, setRawError] = useState("");
  const [revealCredential, setRevealCredential] = useState(false);
  useEffect(() => {
    setTab("basic");
    setRawDraft(undefined);
    setRawError("");
    setRevealCredential(false);
  }, [profile.id]);

  function applyRawConfig() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDraft ?? profileRawConfig(profile, focus, revealCredential));
    } catch {
      setRawError("原始配置不是合法 JSON。");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setRawError("原始配置必须是 JSON 对象。");
      return;
    }
    const source = parsed as Record<string, unknown>;
    if (isLlmProviderPreset(source.provider) || isLlmProviderPreset(source.preset)) onApplyPreset((source.provider ?? source.preset) as LlmProviderPresetId);
    if (typeof source.name === "string") onUpdate("name", source.name);
    if (typeof source.base_url === "string") onUpdate("baseUrl", source.base_url);
    if (typeof source.model === "string") onUpdate("model", source.model);
    if (source.api_key !== undefined && source.api_key !== "********" && typeof source.api_key === "string") onUpdate("apiKey", source.api_key);
    if (source.protocol === "responses" || source.protocol === "chat-completions") onUpdate("protocol", source.protocol);
    if (typeof source.request_path === "string") onUpdate("requestPath", source.request_path);
    if (typeof source.context_window === "number" && Number.isFinite(source.context_window)) onUpdate("contextWindow", Math.max(1000, Math.round(source.context_window)));
    if (typeof source.context_window === "string") {
      const parsedWindow = parseContextWindow(source.context_window);
      if (parsedWindow) onUpdate("contextWindow", parsedWindow);
    }
    if (source.answer_detail === "concise" || source.answer_detail === "balanced" || source.answer_detail === "detailed") onUpdate("answerDetail", source.answer_detail);
    if (source.reasoning_effort === "none" || source.reasoning_effort === "low" || source.reasoning_effort === "medium" || source.reasoning_effort === "high") onUpdate("reasoningEffort", source.reasoning_effort);
    if (typeof source.extra_headers === "string") onUpdate("extraHeaders", source.extra_headers);
    setRawDraft(undefined);
    setRawError("");
  }

  const tabs: Array<[LlmEditorTab, string]> = [["basic", "基础配置"], ["parameters", "模型参数"], ["advanced", "高级请求"], ["raw", "原始 JSON"]];
  return <div className="provider-card-editor">
    <div className="editor-tabs" role="tablist" aria-label="模型配置编辑标签">{tabs.map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}</div>
    {tab === "basic" && <>
      <div className="provider-editor-top"><Field label="Provider 预配置" value={profile.preset ?? profile.provider ?? "custom"} onChange={(value) => onApplyPreset(value as LlmProviderPresetId)} select={[["custom", "自定义 Provider"], ...LLM_PROVIDER_PRESETS.map((preset) => [preset.id, preset.label] as [string, string])]} /><Field label="名称" value={profile.name} onChange={(value) => onUpdate("name", value)} /></div>
      <div className="form-grid"><ModelField profile={profile} models={models} onChange={(value) => onUpdate("model", value)} /><Field label="Base URL" value={profile.baseUrl} onChange={(value) => onUpdate("baseUrl", value)} placeholder="https://…/v1" /><Field label="Key" value={profile.apiKey} type="password" onChange={(value) => onUpdate("apiKey", value)} /><Field label="上游协议" value={profile.protocol} onChange={(value) => onUpdate("protocol", value as LlmProfile["protocol"])} select={[["responses", "Responses API"], ["chat-completions", "Chat Completions"]]} /><ContextWindowField value={profile.contextWindow || 8000} onChange={(value) => onUpdate("contextWindow", value)} /></div>
      <p className="config-note">当前启用配置不能直接删除；Key 只保存在桌面端 Stronghold，原始配置默认脱敏。</p>
    </>}
    {tab === "parameters" && <div className="form-grid"><Field label="回答精细程度" value={profile.answerDetail || "balanced"} onChange={(value) => onUpdate("answerDetail", value as LlmProfile["answerDetail"])} select={[["concise", "简洁"], ["balanced", "标准"], ["detailed", "详细"]]} /><Field label="思考深度" value={profile.reasoningEffort || "none"} onChange={(value) => onUpdate("reasoningEffort", value as LlmProfile["reasoningEffort"])} select={[["none", "不指定"], ["low", "低"], ["medium", "中"], ["high", "高"]]} /></div>}
    {tab === "advanced" && <><label>自定义请求路径（可选）</label><input value={profile.requestPath || ""} onChange={(event) => onUpdate("requestPath", event.target.value)} placeholder="/chat/completions" /><label>额外请求头 JSON</label><textarea rows={4} value={profile.extraHeaders || ""} onChange={(event) => onUpdate("extraHeaders", event.target.value)} placeholder='{"X-Trace": "interview-lab"}' /><p className="config-note">请求头必须是合法 JSON 对象；错误会在连接测试时明确提示。</p></>}
    {tab === "raw" && <><div className="config-preview raw-config-preview"><div><strong>可编辑原始 JSON</strong><span>{revealCredential ? "api_key 当前可见" : "api_key 默认隐藏"}</span></div><textarea rows={14} value={rawDraft ?? profileRawConfig(profile, focus, revealCredential)} onChange={(event) => { setRawDraft(event.target.value); setRawError(""); }} /><div className="raw-config-actions"><button className="primary" onClick={applyRawConfig}>应用原始配置</button><button onClick={() => { setRawDraft(profileRawConfig(profile, focus, revealCredential)); setRawError(""); }}>重置草稿</button></div><label className="checkbox"><input type="checkbox" checked={revealCredential} onChange={(event) => { setRevealCredential(event.target.checked); setRawDraft(undefined); }} />显示当前 Key</label>{rawError && <p className="provider-inline-error">{rawError}</p>}</div><div className="config-preview"><div><strong>config.toml 预览</strong><span>{revealCredential ? "当前凭证可见" : "凭证默认隐藏"}</span></div><textarea readOnly rows={8} value={profileConfigPreview(profile, focus, revealCredential)} /></div></>}
    {modelState.status === "error" && <p className="provider-inline-error">{modelState.message}</p>}
  </div>;
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
