import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { GenericAsrSession } from "./lib/asr";
import { buildInterviewPrompt, sanitizeAnswerText, streamLlm } from "./lib/llm";
import { extractMaterialText, makeCandidateDraft, makeJobDraft } from "./lib/materials";
import { formatShortcut, shortcutKeyToken, toGlobalShortcut } from "./lib/shortcut";
import { clearHistory, loadHistory, loadMaterials, loadSettings, saveHistory, saveMaterials, saveSettings } from "./lib/storage";
import type { AnswerStatus, AppSettings, AsrPreset, AsrStatus, InterviewFocus, InterviewSession, InterviewTurn, LlmProfile, MaterialContext, SessionRecord } from "./types";
import { createAsrPreset, createDefaultLlmProfile, INTERVIEW_FOCUS_LABELS } from "./types";
import "./App.css";
import "./theme.css";

type Tab = "session" | "materials" | "settings" | "history";
type SessionMode = "idle" | "all" | "asr" | "answer";
type TestMode = "all" | "asr" | "answer";
type SessionStage = "idle" | "manual" | "listening" | "finalizing" | "answering" | "complete";

function splitAnswerText(raw: string) {
  const responseMarker = raw.match(/(?:【参考回答】|参考回答\s*[:：])([\s\S]*)/i);
  if (!responseMarker || responseMarker.index === undefined) return { outline: "", response: raw.trim() };
  const outline = raw.slice(0, responseMarker.index).replace(/(?:【要点】|要点(?:提纲)?\s*[:：]?)/i, "").trim();
  return { outline, response: responseMarker[1].trim() };
}

function formatContextWindow(value?: number) {
  if (!value) return "";
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 100_000 && value % 1_000 === 0) return `${value / 1_000}K`;
  return String(value);
}

function parseContextWindow(value: string) {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!match) return undefined;
  const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
  const parsed = Math.round(Number(match[1]) * multiplier);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 2_000_000 ? parsed : undefined;
}

function profileConfigPreview(profile: LlmProfile, focus: InterviewFocus) {
  return `model = "${profile.model || "未填写"}"
base_url = "${profile.baseUrl || "未填写"}"
protocol = "${profile.protocol}"
context_window = ${profile.contextWindow || 8000}
answer_detail = "${profile.answerDetail}"
reasoning_effort = "${profile.reasoningEffort}"
interview_focus = "${focus}"
api_key = "${profile.apiKey ? "已配置（隐藏）" : "未配置"}"`;
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

function AnswerView({ answer }: { answer: string }) {
  if (!answer) return <div className="answer-empty"><strong>等待问题</strong><span>回答生成后会在这里显示要点和第一人称参考回答。</span></div>;
  const sections = splitAnswerText(answer);
  return <div className="answer-content">
    {sections.outline && <section className="answer-section outline"><h3>回答要点</h3><p>{sections.outline}</p></section>}
    <section className="answer-section"><h3>参考回答</h3><p>{sections.response}</p></section>
  </div>;
}

function Overlay() {
  const [answer, setAnswer] = useState("等待回答…");
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: () => void = () => {};
    void listen<{ answer: string }>("overlay-answer", (event) => setAnswer(event.payload.answer || "等待回答…")).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, []);
  return <main className="overlay-shell" data-tauri-drag-region><header data-tauri-drag-region><span data-tauri-drag-region>实时回答</span><button onClick={() => window.close()}>×</button></header><article>{answer}</article></main>;
}

function App() {
  const [tab, setTab] = useState<Tab>("session");
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [materials, setMaterials] = useState<MaterialContext>(loadMaterials);
  const [history, setHistory] = useState<InterviewSession[]>(loadHistory);
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
  const asrRef = useRef<GenericAsrSession | undefined>(undefined);
  const pendingRef = useRef(false);
  const questionRef = useRef("");
  const interviewTurnsRef = useRef<InterviewTurn[]>([]);
  const activeSessionIdRef = useRef("");
  const loadedContextRef = useRef<InterviewTurn[]>([]);
  const loadedSourceSessionIdRef = useRef<string | undefined>(undefined);
  const activeProfile = useMemo(() => settings.llmProfiles.find((item) => item.id === settings.activeLlmProfileId) ?? settings.llmProfiles[0], [settings]);
  const desktopRuntime = isTauri();
  const llmReady = Boolean(activeProfile?.baseUrl.trim() && activeProfile?.apiKey.trim() && activeProfile?.model.trim());
  const asrReady = Boolean(settings.asr.wsUrl.trim() && settings.asr.apiKey.trim() && (settings.asr.protocol !== "aliyun-nls" || settings.asr.appKey?.trim()));
  const hasMaterials = Boolean(materials.resume.trim() || materials.jobDescription.trim() || materials.personalNotes.trim() || materials.candidateSummary.trim() || materials.jobSummary.trim());

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveMaterials(materials), [materials]);
  useEffect(() => saveHistory(history), [history]);
  useEffect(() => { questionRef.current = question; }, [question]);
  useEffect(() => {
    if (!desktopRuntime) return;
    let unlisten: () => void = () => {};
    void listen<number[]>("audio-pcm", (event) => asrRef.current?.sendAudio(Uint8Array.from(event.payload).buffer)).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, [desktopRuntime]);
  useEffect(() => {
    if (!desktopRuntime) return;
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
  }, [desktopRuntime]);
  useEffect(() => {
    if (!desktopRuntime) return;
    let alive = true;
    void unregisterAll().then(() => settings.shortcut ? register(toGlobalShortcut(settings.shortcut), (event) => {
      if (alive && event.state === "Pressed") void submitQuestion();
    }) : undefined).catch(() => setNotice("全局快捷键注册失败，可使用“提交当前问题”按钮。"));
    return () => { alive = false; void unregisterAll(); };
  }, [desktopRuntime, settings.shortcut, sessionActive]);

  function updateAsr<K extends keyof AppSettings["asr"]>(key: K, value: AppSettings["asr"][K]) {
    setSettings((state) => {
      const asr = { ...state.asr, [key]: value };
      const preset = asr.preset ?? "generic";
      return { ...state, asr, asrProfiles: { ...state.asrProfiles, [preset]: asr } };
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
  function updateProfile<K extends keyof LlmProfile>(id: string, key: K, value: LlmProfile[K]) {
    setSettings((state) => ({ ...state, llmProfiles: state.llmProfiles.map((item) => item.id === id ? { ...item, [key]: value } : item) }));
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
        setQuestion((current) => current ? `${current}${text}` : text);
        setPartial("");
        if (pendingRef.current && mode === "all") void generateAnswer(text || questionRef.current);
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
  function startTest() {
    if (testMode === "all" && (!asrReady || !llmReady)) {
      setNotice(!asrReady && !llmReady ? "“全部启动”需要先配置 ASR 和文本模型；如只验证转写，请在下拉框选择“语音转文字”。" : !asrReady ? "“全部启动”还需要配置 ASR；如只验证回答，可选择“问题回答”。" : "“全部启动”还需要配置文本模型；如只验证转写，可选择“语音转文字”。");
      return;
    }
    if (testMode === "asr" && !asrReady) {
      setNotice("请先在服务配置中填写 ASR 所需的 Token 和 AppKey，再测试语音转文字。");
      return;
    }
    if (testMode === "answer" && !llmReady) {
      setNotice("请先在服务配置中填写文本模型的 Base URL、Key 和模型名称，再测试问题回答。");
      return;
    }
    if (testMode === "answer") { startAnswerSession(); return; }
    void startSession(testMode);
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
        if (desktopRuntime) void emit("overlay-answer", { answer: cleanAnswer });
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
  async function showOverlay(content: string) {
    if (!desktopRuntime) return;
    const windowRef = await WebviewWindow.getByLabel("answer-overlay");
    if (windowRef) { await windowRef.show(); await windowRef.setFocus(); await emit("overlay-answer", { answer: content }); return; }
    new WebviewWindow("answer-overlay", { url: "/?overlay=1", title: "实时回答", width: 520, height: 440, alwaysOnTop: true, decorations: false });
    window.setTimeout(() => void emit("overlay-answer", { answer: content }), 350);
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
  if (new URLSearchParams(window.location.search).get("overlay") === "1") return <Overlay />;

  const sessionStage: SessionStage = answerStatus === "generating" ? "answering" : answerStatus === "complete" ? "complete" : !sessionActive ? "idle" : sessionMode === "answer" ? "manual" : asrStatus === "finalizing" ? "finalizing" : "listening";
  const statusLabel = sessionStage === "manual" ? "等待输入" : sessionStage === "answering" ? "正在生成回答" : sessionStage === "complete" ? sessionMode === "asr" ? "转写已完成" : "回答已完成" : sessionStage === "listening" ? "正在聆听" : sessionStage === "finalizing" ? "正在提交问题" : sessionStage === "idle" && !llmReady && testMode !== "asr" ? "待配置模型" : sessionStage === "idle" ? "未开始" : "连接异常";
  const statusClass = sessionStage === "complete" ? "complete" : sessionMode === "answer" && sessionActive ? "manual" : asrStatus;
  const materialLabel = materials.confirmed ? "已确认并用于回答" : hasMaterials ? "有材料，等待确认" : "未添加材料";
  const materialClass = materials.confirmed ? "ready" : hasMaterials ? "pending" : "muted";

  return <main className="app-shell">
    <aside className="sidebar"><div className="brand"><span>IL</span><div><strong>Interview Lab</strong><small>实时语音测试台</small></div></div>
      {(["session", "materials", "settings", "history"] as Tab[]).map((item) => <button key={item} className={tab === item ? "nav active" : "nav"} onClick={() => setTab(item)}>{({ session: "会话控制", materials: "候选人材料", settings: "服务配置", history: "文本记录" })[item]}</button>)}
      <p className="sidebar-footer">受控测试模式<br />不保存原始音频</p></aside>
    <section className={tab === "session" ? "content session-content" : "content"}><header className="topbar"><div><p className="eyebrow">WINDOWS · REALTIME ASR · LLM</p><h1>{({ session: "会话控制", materials: "候选人材料", settings: "服务配置", history: "文本记录" })[tab]}</h1></div><span className={`status ${statusClass}`}>{statusLabel}</span></header>
      <p className="notice">{notice}</p>
      <div className="quick-status" aria-label="当前配置状态"><span className={llmReady ? "ready" : "pending"}><i />文本模型：{llmReady ? "已就绪" : "待配置"}</span><span className={asrReady ? "ready" : "muted"}><i />ASR：{asrReady ? "已配置" : "未配置"}</span>{tab === "materials" && <span className={materialClass}><i />材料：{materialLabel}</span>}<span className="autosave-state"><i />设置自动保存在本机</span></div>
      {tab === "session" && <section className="session-grid">
        <div className="panel session-panel">
          <div className="panel-head session-head"><div><div className="panel-kicker">LIVE SESSION</div><h2>系统音频会话</h2><p>默认输出设备 · PCM16 / Mono / 16kHz</p></div><span className={`session-badge ${sessionStage}`}><i />{statusLabel}</span></div>
          <div className="interview-context">本次面试上下文：已完成 {turnCount} 轮问答{sessionActive && activeSessionTitle ? ` · ${activeSessionTitle}` : ""}</div>
          <SessionProgress stage={sessionStage} mode={sessionMode === "idle" ? testMode : sessionMode} />
          {!sessionActive && <label className="session-title-draft"><span>本次会话主题</span><input value={settings.sessionTitleDraft} onChange={(event) => setSettings((state) => ({ ...state, sessionTitleDraft: event.target.value }))} placeholder="例如：售前解决方案岗位一面" /></label>}
          <div className="session-actions"><div className="button-row">{sessionActive ? <button className="danger" onClick={() => void stopSession()}>结束会话</button> : <><button className="primary" onClick={startTest}>启动测试</button><label className="test-mode"><span>测试内容</span><select value={testMode} onChange={(event) => setTestMode(event.target.value as TestMode)}><option value="all">全部启动</option><option value="asr">语音转文字</option><option value="answer">问题回答</option></select></label></>}{sessionActive && sessionMode !== "answer" && <button className="primary submit-button" onClick={() => void submitQuestion()}>提交当前问题</button>}</div><span className="action-hint">{testMode === "asr" && !asrReady ? "先在服务配置中填写 ASR 凭证" : testMode === "answer" && !llmReady ? "先在服务配置中填写文本模型" : testMode === "all" && (!llmReady || !asrReady) ? "全部启动需要同时配置 ASR 与文本模型" : sessionStage === "listening" ? `听到问题后按 ${settings.shortcut} 提交` : sessionStage === "finalizing" ? "正在等待最终转写文本" : sessionStage === "answering" ? "回答会同步显示在右侧" : testMode === "asr" ? "单独验证实时语音转文字" : testMode === "answer" ? "直接输入问题验证回答效果" : "同时验证转写与问题回答"}</span></div>
          <div className="shortcut"><span>全局快捷键</span><kbd>{settings.shortcut}</kbd><span>· 仅在语音转文字或全部启动时用于提交当前语音段</span></div>
          <div className="field-heading"><label>实时增量转写</label><span className={asrStatus === "listening" ? "live-dot" : ""}>{asrStatus === "listening" ? "正在接收" : "等待开始"}</span></div>
          <div className="transcript scroll-region">{partial || "等待系统音频…"}</div>
          <div className="field-heading"><label>转写结果 / 当前问题</label><button className="text-button" disabled={!question && !partial} onClick={clearCurrentQuestion}>清空</button></div>
          <textarea rows={6} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="ASR 最终文本会显示在这里，也可以直接输入问题测试模型。" />
        </div>
        <div className="panel answer-panel">
          <div className="panel-head"><div><div className="panel-kicker">AI RESPONSE</div><h2>中文回答</h2><p>{INTERVIEW_FOCUS_LABELS[settings.interviewFocus]} · {activeProfile?.answerDetail === "detailed" ? "详细" : activeProfile?.answerDetail === "concise" ? "简洁" : "标准"}</p></div><span className={`answer-status ${answerStatus}`}>{answerStatus === "generating" ? "流式生成中" : answerStatus === "complete" ? "已完成" : answerStatus === "error" ? "生成失败" : "等待问题"}</span></div>
          <AnswerView answer={answer} />
          <div className="answer-toolbar"><button onClick={() => void copyAnswer()} disabled={!answer}>复制回答</button><button onClick={() => void showOverlay(answer)} disabled={!answer}>打开悬浮窗</button><button className="primary" disabled={!sessionActive || !question || answerStatus === "generating" || !llmReady} onClick={() => void generateAnswer(question)}>用当前文本生成</button></div>
        </div>
        {settings.asr.debug && <div className="panel debug-panel"><h2>ASR 调试消息</h2><pre>{debug.join("\n\n") || "等待 WebSocket 消息…"}</pre></div>}
      </section>}
      {tab === "materials" && <section className="materials-grid"><div className="panel"><div className="panel-head"><div><div className="panel-kicker">CANDIDATE CONTEXT</div><h2>候选人材料</h2><p>可选：PDF、DOCX、TXT 或直接粘贴。</p></div><button onClick={() => importMaterial("resume")}>导入简历</button></div><label>简历原文</label><textarea rows={10} value={materials.resume} onChange={(event) => setMaterials((state) => ({ ...state, resume: event.target.value, confirmed: false }))} /><label>个人补充资料</label><textarea rows={5} value={materials.personalNotes} onChange={(event) => setMaterials((state) => ({ ...state, personalNotes: event.target.value, confirmed: false }))} /></div><div className="panel"><div className="panel-head"><div><div className="panel-kicker">TARGET ROLE</div><h2>目标岗位</h2><p>可选：一次会话仅使用一份 JD。</p></div><button onClick={() => importMaterial("jobDescription")}>导入 JD</button></div><label>岗位描述</label><textarea rows={10} value={materials.jobDescription} onChange={(event) => setMaterials((state) => ({ ...state, jobDescription: event.target.value, confirmed: false }))} /><button className="primary full" onClick={draftSummaries}>生成可编辑摘要草稿</button></div><div className="panel full-width context-panel"><div className="panel-head"><div><div className="panel-kicker">READY FOR LLM</div><h2>确认后的 LLM 上下文</h2><p>只有确认后的摘要才会参与回答，避免模型误用未检查的信息。</p></div><div className="context-actions"><span className={`context-state ${materialClass}`}><i />{materialLabel}</span><button className={materials.confirmed ? "success" : "primary"} onClick={() => setMaterials((state) => ({ ...state, confirmed: !state.confirmed }))}>{materials.confirmed ? "取消确认" : "确认并用于回答"}</button></div></div><div className="summary-grid"><div><label>候选人事实摘要</label><textarea rows={12} value={materials.candidateSummary} onChange={(event) => setMaterials((state) => ({ ...state, candidateSummary: event.target.value, confirmed: false }))} /></div><div><label>岗位要求摘要</label><textarea rows={12} value={materials.jobSummary} onChange={(event) => setMaterials((state) => ({ ...state, jobSummary: event.target.value, confirmed: false }))} /></div></div></div></section>}
      {tab === "settings" && <section className="settings-stack"><div className="panel"><div className="panel-head"><div><h2>实时 ASR Provider</h2><p>选择预配置后，只需填写对应的 Token、AppKey 或 App ID。音频固定为 PCM 16-bit / 单声道 / 16 kHz。</p></div></div><div className="asr-presets" role="group" aria-label="语音识别预配置"><button className={settings.asr.preset === "aliyun-trial" ? "active" : ""} onClick={() => selectAsrPreset("aliyun-trial")}>阿里云试用</button><button className={settings.asr.preset === "aliyun-nls" ? "active" : ""} onClick={() => selectAsrPreset("aliyun-nls")}>阿里云正式</button><button className={settings.asr.preset === "volcengine-asr" ? "active" : ""} onClick={() => selectAsrPreset("volcengine-asr")}>豆包流式识别</button><button className={settings.asr.preset === "generic" ? "active" : ""} onClick={() => selectAsrPreset("generic")}>通用 WebSocket</button></div>{settings.asr.protocol === "volcengine-asr" && <p className="config-warning">豆包预配置已填入官方服务地址和 PCM 参数。该服务需要自定义二进制帧及 Authorization 请求头，当前版本暂未接入底层原生传输，不能直接开始识别。</p>}<div className="form-grid"><Field label="名称" value={settings.asr.name} onChange={(value) => updateAsr("name", value)} /><Field label="WebSocket URL" value={settings.asr.wsUrl} onChange={(value) => updateAsr("wsUrl", value)} placeholder="wss://…" /><Field label={settings.asr.protocol === "aliyun-nls" ? "阿里云临时 Token" : settings.asr.protocol === "volcengine-asr" ? "豆包 Access Token" : "API Key"} value={settings.asr.apiKey} type="password" onChange={(value) => updateAsr("apiKey", value)} />{settings.asr.protocol === "aliyun-nls" && <Field label="阿里云 AppKey" value={settings.asr.appKey || ""} onChange={(value) => updateAsr("appKey", value)} />}{settings.asr.protocol === "volcengine-asr" && <><Field label="豆包 App ID" value={settings.asr.appId || ""} onChange={(value) => updateAsr("appId", value)} /><Field label="豆包 Cluster" value={settings.asr.cluster || ""} onChange={(value) => updateAsr("cluster", value)} placeholder="控制台显示的 Cluster ID" /></>}<Field label="超时（ms）" value={String(settings.asr.timeoutMs)} onChange={(value) => updateAsr("timeoutMs", Number(value) || 10000)} /></div><details><summary>高级协议配置</summary><p className="config-note">阿里云预设默认开启中间结果、标点预测和中文数字规范化；豆包预设默认请求 ITN 与标点。多语模型均需要在各自控制台开通或配置。</p><div className="form-grid three"><Field label="音频封装" value={settings.asr.audioMode} onChange={(value) => updateAsr("audioMode", value as "binary" | "json-base64")} select={[["binary", "原始二进制 PCM"], ["json-base64", "JSON Base64"]]} /><Field label="事件路径" value={settings.asr.eventPath || ""} onChange={(value) => updateAsr("eventPath", value)} /><Field label="文本路径" value={settings.asr.textPath || ""} onChange={(value) => updateAsr("textPath", value)} /><Field label="增量事件" value={settings.asr.partialEvent || ""} onChange={(value) => updateAsr("partialEvent", value)} /><Field label="最终事件" value={settings.asr.finalEvent || ""} onChange={(value) => updateAsr("finalEvent", value)} /><Field label="错误事件" value={settings.asr.errorEvent || ""} onChange={(value) => updateAsr("errorEvent", value)} /></div><label>初始化消息 JSON</label><textarea rows={3} value={settings.asr.initMessage} onChange={(event) => updateAsr("initMessage", event.target.value)} /><label>JSON/Base64 音频模板（使用 {'{{base64}}'}）</label><textarea rows={2} value={settings.asr.audioTemplate} onChange={(event) => updateAsr("audioTemplate", event.target.value)} /><label>结束/Flush 消息 JSON</label><textarea rows={2} value={settings.asr.finalizeMessage} onChange={(event) => updateAsr("finalizeMessage", event.target.value)} /></details><label className="checkbox"><input type="checkbox" checked={settings.asr.debug} onChange={(event) => updateAsr("debug", event.target.checked)} />显示 ASR 原始消息调试日志</label></div>
        <div className="panel"><div className="panel-head"><div><h2>文本模型 Profiles</h2><p>Base URL、Key、协议与上下文窗口都按模型单独保存。</p></div><button onClick={() => { const profile = createDefaultLlmProfile(); setSettings((state) => ({ ...state, llmProfiles: [...state.llmProfiles, profile], activeLlmProfileId: profile.id })); }}>添加模型</button></div>{settings.llmProfiles.map((profile) => <div key={profile.id} className="profile"><div className="profile-title"><label className="radio"><input type="radio" checked={profile.id === settings.activeLlmProfileId} onChange={() => setSettings((state) => ({ ...state, activeLlmProfileId: profile.id }))} />用作当前模型</label><button className="link danger-text" disabled={settings.llmProfiles.length === 1} onClick={() => setSettings((state) => ({ ...state, llmProfiles: state.llmProfiles.filter((item) => item.id !== profile.id), activeLlmProfileId: state.llmProfiles.find((item) => item.id !== profile.id)?.id || "" }))}>删除</button></div><div className="form-grid"><Field label="名称" value={profile.name} onChange={(value) => updateProfile(profile.id, "name", value)} /><Field label="模型" value={profile.model} onChange={(value) => updateProfile(profile.id, "model", value)} /><Field label="Base URL" value={profile.baseUrl} onChange={(value) => updateProfile(profile.id, "baseUrl", value)} placeholder="https://…/v1" /><Field label="Key" value={profile.apiKey} type="password" onChange={(value) => updateProfile(profile.id, "apiKey", value)} /><Field label="上游协议" value={profile.protocol} onChange={(value) => updateProfile(profile.id, "protocol", value as LlmProfile["protocol"])} select={[["responses", "Responses API"], ["chat-completions", "Chat Completions"]]} /><Field label="自定义路径（可选）" value={profile.requestPath || ""} onChange={(value) => updateProfile(profile.id, "requestPath", value)} /><ContextWindowField value={profile.contextWindow || 8000} onChange={(value) => updateProfile(profile.id, "contextWindow", value)} /><Field label="回答精细程度" value={profile.answerDetail || "balanced"} onChange={(value) => updateProfile(profile.id, "answerDetail", value as LlmProfile["answerDetail"])} select={[["concise", "简洁"], ["balanced", "标准"], ["detailed", "详细"]]} /><Field label="思考深度" value={profile.reasoningEffort || "none"} onChange={(value) => updateProfile(profile.id, "reasoningEffort", value as LlmProfile["reasoningEffort"])} select={[["none", "不指定"], ["low", "低"], ["medium", "中"], ["high", "高"]]} /></div><label>额外请求头 JSON</label><textarea rows={2} value={profile.extraHeaders} onChange={(event) => updateProfile(profile.id, "extraHeaders", event.target.value)} /><div className="config-preview"><div><strong>config.toml 预览</strong><span>Key 不会在此显示</span></div><textarea readOnly rows={8} value={profileConfigPreview(profile, settings.interviewFocus)} /></div></div>)}</div>
        <div className="panel"><div className="panel-head"><div><h2>回答策略</h2><p>决定模型在技术问题中优先强调的表达维度。</p></div></div><div className="form-grid"><Field label="面试方向" value={settings.interviewFocus} onChange={(value) => setSettings((state) => ({ ...state, interviewFocus: value as InterviewFocus }))} select={Object.entries(INTERVIEW_FOCUS_LABELS)} /></div></div>
        <div className="panel"><h2>全局快捷键</h2><div className="shortcut-field"><span>快捷键</span><ShortcutRecorder value={settings.shortcut} onChange={(value) => setSettings((state) => ({ ...state, shortcut: value }))} /></div></div></section>}
      {tab === "history" && <section className="panel history-panel">{selectedHistorySessionId && history.some((session) => session.id === selectedHistorySessionId) ? (() => {
        const session = history.find((item) => item.id === selectedHistorySessionId)!;
        return <div className="history-detail"><div className="panel-head history-detail-header"><div><button className="text-button history-back" onClick={() => setSelectedHistorySessionId(undefined)}>返回会话列表</button><h2>会话详情</h2><p>完整问答仅在详情页显示；修改主题会自动保存。</p></div><button className="primary" disabled={sessionActive} onClick={() => loadSessionContext(session)}>载入为下一轮上下文</button></div><label className="history-session-title-editor"><span>会话主题</span><input value={session.title} onChange={(event) => renameHistorySession(session.id, event.target.value)} placeholder="输入这场面试的主题" /></label><div className="history-meta"><span>创建于 {new Date(session.createdAt).toLocaleString()}</span><span>更新于 {new Date(session.updatedAt).toLocaleString()}</span><span>{session.turns.length} 轮问答</span>{session.carriedTurnCount > 0 && <span>承接 {session.carriedTurnCount} 轮上下文</span>}<span>{session.asrName} → {session.llmName}</span></div>{session.turns.length ? <div className="history-turn-list">{session.turns.map((turn) => <article className="history-turn" key={turn.id}><div className="history-turn-time">{new Date(turn.createdAt).toLocaleString()}</div><h3>{turn.question}</h3>{turn.error ? <p className="error">{turn.error}</p> : <p>{turn.answer}</p>}</article>)}</div> : <p className="empty-session">本次测试尚未提交问题。</p>}</div>;
      })() : <><div className="panel-head"><div><h2>面试会话记录</h2><p>每次启动测试都会创建一场面试；不保存音频。</p></div><button className="danger" onClick={() => { clearHistory(); setHistory([]); setSelectedHistorySessionId(undefined); }}>清空记录</button></div>{history.length ? <div className="history-list">{history.map((session) => <button className="history-summary" key={session.id} onClick={() => setSelectedHistorySessionId(session.id)}><strong>{session.title}</strong><span>{new Date(session.updatedAt).toLocaleString()} · {session.turns.length} 轮问答{session.carriedTurnCount ? ` · 承接 ${session.carriedTurnCount} 轮` : ""}</span><small>{session.asrName} → {session.llmName}</small></button>)}</div> : <p className="empty">还没有面试会话记录。</p>}</>}</section>}
    </section>
  </main>;
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
  return <label className="field context-window-field"><span>上下文窗口</span><input value={draft} inputMode="numeric" placeholder="8000 / 200K / 1M" onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><small>支持 8000、200K 或 1M</small></label>;
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
