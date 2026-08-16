import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { GenericAsrSession } from "./lib/asr";
import { buildInterviewPrompt, streamLlm } from "./lib/llm";
import { extractMaterialText, makeCandidateDraft, makeJobDraft } from "./lib/materials";
import { clearHistory, loadHistory, loadMaterials, loadSettings, saveHistory, saveMaterials, saveSettings } from "./lib/storage";
import type { AnswerStatus, AppSettings, AsrStatus, LlmProfile, MaterialContext, SessionRecord } from "./types";
import { createDefaultLlmProfile } from "./types";
import "./App.css";
import "./theme.css";

type Tab = "session" | "materials" | "settings" | "history";

function Overlay() {
  const [answer, setAnswer] = useState("等待回答…");
  useEffect(() => {
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
  const [history, setHistory] = useState<SessionRecord[]>(loadHistory);
  const [sessionActive, setSessionActive] = useState(false);
  const [asrStatus, setAsrStatus] = useState<AsrStatus>("idle");
  const [answerStatus, setAnswerStatus] = useState<AnswerStatus>("idle");
  const [partial, setPartial] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [notice, setNotice] = useState("配置 Provider 与材料后，即可开始受控测试。");
  const [debug, setDebug] = useState<string[]>([]);
  const asrRef = useRef<GenericAsrSession | undefined>(undefined);
  const pendingRef = useRef(false);
  const questionRef = useRef("");
  const activeProfile = useMemo(() => settings.llmProfiles.find((item) => item.id === settings.activeLlmProfileId) ?? settings.llmProfiles[0], [settings]);

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveMaterials(materials), [materials]);
  useEffect(() => saveHistory(history), [history]);
  useEffect(() => { questionRef.current = question; }, [question]);
  useEffect(() => {
    let unlisten: () => void = () => {};
    void listen<number[]>("audio-pcm", (event) => asrRef.current?.sendAudio(Uint8Array.from(event.payload).buffer)).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten();
  }, []);
  useEffect(() => {
    let alive = true;
    void unregisterAll().then(() => register(settings.shortcut.replace("Ctrl", "Control"), (event) => {
      if (alive && event.state === "Pressed") void submitQuestion();
    })).catch(() => setNotice("全局快捷键注册失败，可使用“提交当前问题”按钮。"));
    return () => { alive = false; void unregisterAll(); };
  }, [settings.shortcut, sessionActive]);

  function updateAsr<K extends keyof AppSettings["asr"]>(key: K, value: AppSettings["asr"][K]) {
    setSettings((state) => ({ ...state, asr: { ...state.asr, [key]: value } }));
  }
  function updateProfile<K extends keyof LlmProfile>(id: string, key: K, value: LlmProfile[K]) {
    setSettings((state) => ({ ...state, llmProfiles: state.llmProfiles.map((item) => item.id === id ? { ...item, [key]: value } : item) }));
  }
  function log(raw: string) { if (settings.asr.debug) setDebug((items) => [raw.slice(0, 1000), ...items].slice(0, 30)); }

  async function startSession() {
    if (!materials.confirmed) { setTab("materials"); setNotice("请先确认候选人事实摘要和岗位摘要。"); return; }
    const asr = new GenericAsrSession(settings.asr, {
      onStatus: (status) => setAsrStatus(status),
      onPartial: setPartial,
      onFinal: (text) => {
        setQuestion((current) => current ? `${current}${text}` : text);
        setPartial("");
        if (pendingRef.current) void generateAnswer(text || questionRef.current);
      },
      onError: (message) => { setAsrStatus("error"); setNotice(message); },
      onDebug: log,
    });
    try {
      await asr.connect();
      asrRef.current = asr;
      await invoke("start_system_audio_capture");
      setSessionActive(true);
      setAsrStatus("listening");
      setNotice("正在捕获默认系统输出并发送给 ASR。原始音频不会保存。");
    } catch (error) {
      asr.close();
      setAsrStatus("error");
      setNotice(error instanceof Error ? error.message : "启动会话失败");
    }
  }
  async function stopSession() {
    asrRef.current?.close(); asrRef.current = undefined;
    await invoke("stop_system_audio_capture").catch(() => undefined);
    setSessionActive(false); setAsrStatus("idle"); setPartial(""); pendingRef.current = false;
    setNotice("会话已结束，仅保留文本记录。");
  }
  async function submitQuestion() {
    if (!sessionActive) { setNotice("请先开始会话。\n"); return; }
    pendingRef.current = true; setAsrStatus("finalizing"); setNotice("正在等待 ASR 返回当前问题最终文本…");
    try {
      asrRef.current?.finalizeSegment();
      window.setTimeout(() => { if (pendingRef.current && questionRef.current.trim()) void generateAnswer(questionRef.current); }, 1500);
    } catch (error) { setAsrStatus("error"); setNotice(error instanceof Error ? error.message : "提交失败"); }
  }
  async function generateAnswer(rawQuestion: string) {
    const finalQuestion = rawQuestion.trim();
    if (!finalQuestion || answerStatus === "generating" || !activeProfile) return;
    pendingRef.current = false; setQuestion(finalQuestion); setAnswer(""); setAnswerStatus("generating"); setAsrStatus("listening");
    await showOverlay("");
    try {
      let full = "";
      await streamLlm(activeProfile, buildInterviewPrompt(finalQuestion, materials, history.slice(0, 3).map((item) => item.question)), (delta) => {
        full += delta; setAnswer(full); void emit("overlay-answer", { answer: full });
      });
      setAnswerStatus("complete"); setQuestion("");
      setHistory((items) => [{ id: crypto.randomUUID(), createdAt: new Date().toISOString(), question: finalQuestion, answer: full, asrName: settings.asr.name, llmName: activeProfile.name }, ...items]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "文本模型请求失败";
      setAnswerStatus("error"); setNotice(message);
      setHistory((items) => [{ id: crypto.randomUUID(), createdAt: new Date().toISOString(), question: finalQuestion, answer: "", asrName: settings.asr.name, llmName: activeProfile.name, error: message }, ...items]);
    }
  }
  async function showOverlay(content: string) {
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

  return <main className="app-shell">
    <aside className="sidebar"><div className="brand"><span>IL</span><div><strong>Interview Lab</strong><small>实时语音测试台</small></div></div>
      {(["session", "materials", "settings", "history"] as Tab[]).map((item) => <button key={item} className={tab === item ? "nav active" : "nav"} onClick={() => setTab(item)}>{({ session: "会话控制", materials: "候选人材料", settings: "服务配置", history: "文本记录" })[item]}</button>)}
      <p className="sidebar-footer">受控测试模式<br />不保存原始音频</p></aside>
    <section className="content"><header className="topbar"><div><p className="eyebrow">WINDOWS · REALTIME ASR · LLM</p><h1>{({ session: "会话控制", materials: "候选人材料", settings: "服务配置", history: "文本记录" })[tab]}</h1></div><span className={`status ${asrStatus}`}>{asrStatus === "listening" ? "ASR 正在转写" : asrStatus === "finalizing" ? "提交中" : asrStatus === "error" ? "连接异常" : "未开始"}</span></header>
      <p className="notice">{notice}</p>
      {tab === "session" && <section className="session-grid">
        <div className="panel"><div className="panel-head"><div><h2>系统音频会话</h2><p>默认输出设备 · PCM16 / Mono / 16kHz</p></div><div className="button-row">{sessionActive ? <button className="danger" onClick={() => void stopSession()}>结束会话</button> : <button className="primary" onClick={() => void startSession()}>开始会话</button>}<button disabled={!sessionActive} onClick={() => void submitQuestion()}>提交当前问题</button></div></div><p className="shortcut">全局快捷键 <kbd>{settings.shortcut}</kbd> · 结束当前问题录制并生成回答</p><label>实时增量转写</label><div className="transcript">{partial || "等待系统音频…"}</div><label>当前问题（可手动修正/测试）</label><textarea rows={6} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="ASR 最终文本会显示在这里；也可粘贴问题测试模型。" /></div>
        <div className="panel answer-panel"><div className="panel-head"><div><h2>中文回答</h2><p>{activeProfile?.name || "未选择文本模型"}</p></div><span className={`answer-status ${answerStatus}`}>{answerStatus === "generating" ? "流式生成中" : answerStatus === "complete" ? "已完成" : answerStatus === "error" ? "失败" : "等待问题"}</span></div><div className="answer-content">{answer || "提交问题后，将先生成要点提纲，再流式显示完整第一人称中文参考回答。"}</div><div className="button-row"><button onClick={() => void showOverlay(answer)}>打开悬浮窗</button><button disabled={!question || answerStatus === "generating"} onClick={() => void generateAnswer(question)}>用当前文本生成</button></div></div>
        {settings.asr.debug && <div className="panel debug-panel"><h2>ASR 调试消息</h2><pre>{debug.join("\n\n") || "等待 WebSocket 消息…"}</pre></div>}
      </section>}
      {tab === "materials" && <section className="materials-grid"><div className="panel"><div className="panel-head"><div><h2>候选人材料</h2><p>PDF、DOCX、TXT 或直接粘贴。</p></div><button onClick={() => importMaterial("resume")}>导入简历</button></div><label>简历原文</label><textarea rows={10} value={materials.resume} onChange={(event) => setMaterials((state) => ({ ...state, resume: event.target.value, confirmed: false }))} /><label>个人补充资料</label><textarea rows={5} value={materials.personalNotes} onChange={(event) => setMaterials((state) => ({ ...state, personalNotes: event.target.value, confirmed: false }))} /></div><div className="panel"><div className="panel-head"><div><h2>目标岗位</h2><p>一次会话仅使用一份 JD。</p></div><button onClick={() => importMaterial("jobDescription")}>导入 JD</button></div><label>岗位描述</label><textarea rows={10} value={materials.jobDescription} onChange={(event) => setMaterials((state) => ({ ...state, jobDescription: event.target.value, confirmed: false }))} /><button className="primary full" onClick={draftSummaries}>生成可编辑摘要草稿</button></div><div className="panel full-width"><div className="panel-head"><div><h2>确认后的 LLM 上下文</h2><p>删除错误信息、补充事实后确认；未确认时不能开始会话。</p></div><button className={materials.confirmed ? "success" : "primary"} onClick={() => setMaterials((state) => ({ ...state, confirmed: !state.confirmed }))}>{materials.confirmed ? "已确认，点击取消" : "确认并用于回答"}</button></div><div className="summary-grid"><div><label>候选人事实摘要</label><textarea rows={12} value={materials.candidateSummary} onChange={(event) => setMaterials((state) => ({ ...state, candidateSummary: event.target.value, confirmed: false }))} /></div><div><label>岗位要求摘要</label><textarea rows={12} value={materials.jobSummary} onChange={(event) => setMaterials((state) => ({ ...state, jobSummary: event.target.value, confirmed: false }))} /></div></div></div></section>}
      {tab === "settings" && <section className="settings-stack"><div className="panel"><div className="panel-head"><div><h2>实时 ASR Provider</h2><p>通用 WebSocket 映射；按你的 ASR 文档填写。</p></div></div><div className="form-grid"><Field label="名称" value={settings.asr.name} onChange={(value) => updateAsr("name", value)} /><Field label="WebSocket URL" value={settings.asr.wsUrl} onChange={(value) => updateAsr("wsUrl", value)} placeholder="wss://…" /><Field label="API Key" value={settings.asr.apiKey} type="password" onChange={(value) => updateAsr("apiKey", value)} /><Field label="超时（ms）" value={String(settings.asr.timeoutMs)} onChange={(value) => updateAsr("timeoutMs", Number(value) || 10000)} /></div><details><summary>高级协议配置</summary><div className="form-grid three"><Field label="音频封装" value={settings.asr.audioMode} onChange={(value) => updateAsr("audioMode", value as "binary" | "json-base64")} select={[["binary", "原始二进制 PCM"], ["json-base64", "JSON Base64"]]} /><Field label="事件路径" value={settings.asr.eventPath || ""} onChange={(value) => updateAsr("eventPath", value)} /><Field label="文本路径" value={settings.asr.textPath || ""} onChange={(value) => updateAsr("textPath", value)} /><Field label="增量事件" value={settings.asr.partialEvent || ""} onChange={(value) => updateAsr("partialEvent", value)} /><Field label="最终事件" value={settings.asr.finalEvent || ""} onChange={(value) => updateAsr("finalEvent", value)} /><Field label="错误事件" value={settings.asr.errorEvent || ""} onChange={(value) => updateAsr("errorEvent", value)} /></div><label>初始化消息 JSON</label><textarea rows={3} value={settings.asr.initMessage} onChange={(event) => updateAsr("initMessage", event.target.value)} /><label>JSON/Base64 音频模板（使用 {'{{base64}}'}）</label><textarea rows={2} value={settings.asr.audioTemplate} onChange={(event) => updateAsr("audioTemplate", event.target.value)} /><label>结束/Flush 消息 JSON</label><textarea rows={2} value={settings.asr.finalizeMessage} onChange={(event) => updateAsr("finalizeMessage", event.target.value)} /></details><label className="checkbox"><input type="checkbox" checked={settings.asr.debug} onChange={(event) => updateAsr("debug", event.target.checked)} />显示 ASR 原始消息调试日志</label></div>
        <div className="panel"><div className="panel-head"><div><h2>文本模型 Profiles</h2><p>参考 Agent：Base URL、Key、上游协议和模型。</p></div><button onClick={() => { const profile = createDefaultLlmProfile(); setSettings((state) => ({ ...state, llmProfiles: [...state.llmProfiles, profile], activeLlmProfileId: profile.id })); }}>添加模型</button></div>{settings.llmProfiles.map((profile) => <div key={profile.id} className="profile"><div className="profile-title"><label className="radio"><input type="radio" checked={profile.id === settings.activeLlmProfileId} onChange={() => setSettings((state) => ({ ...state, activeLlmProfileId: profile.id }))} />用作当前模型</label><button className="link danger-text" disabled={settings.llmProfiles.length === 1} onClick={() => setSettings((state) => ({ ...state, llmProfiles: state.llmProfiles.filter((item) => item.id !== profile.id), activeLlmProfileId: state.llmProfiles.find((item) => item.id !== profile.id)?.id || "" }))}>删除</button></div><div className="form-grid"><Field label="名称" value={profile.name} onChange={(value) => updateProfile(profile.id, "name", value)} /><Field label="模型" value={profile.model} onChange={(value) => updateProfile(profile.id, "model", value)} /><Field label="Base URL" value={profile.baseUrl} onChange={(value) => updateProfile(profile.id, "baseUrl", value)} placeholder="https://…/v1" /><Field label="Key" value={profile.apiKey} type="password" onChange={(value) => updateProfile(profile.id, "apiKey", value)} /><Field label="上游协议" value={profile.protocol} onChange={(value) => updateProfile(profile.id, "protocol", value as LlmProfile["protocol"])} select={[["responses", "Responses API"], ["chat-completions", "Chat Completions"]]} /><Field label="自定义路径（可选）" value={profile.requestPath || ""} onChange={(value) => updateProfile(profile.id, "requestPath", value)} /></div><label>额外请求头 JSON</label><textarea rows={2} value={profile.extraHeaders} onChange={(event) => updateProfile(profile.id, "extraHeaders", event.target.value)} /></div>)}</div>
        <div className="panel"><h2>全局快捷键</h2><Field label="快捷键" value={settings.shortcut} onChange={(value) => setSettings((state) => ({ ...state, shortcut: value }))} placeholder="Ctrl+Shift+Space" /></div></section>}
      {tab === "history" && <section className="panel history-panel"><div className="panel-head"><div><h2>本地文本记录</h2><p>问题、答案、错误和 Provider 名称；不保存音频。</p></div><button className="danger" onClick={() => { clearHistory(); setHistory([]); }}>清空记录</button></div>{history.length ? history.map((item) => <article className="history-item" key={item.id}><div><span>{new Date(item.createdAt).toLocaleString()}</span><strong>{item.asrName} → {item.llmName}</strong></div><h3>{item.question}</h3>{item.error ? <p className="error">{item.error}</p> : <p>{item.answer}</p>}</article>) : <p className="empty">还没有文本记录。</p>}</section>}
    </section>
  </main>;
}

function Field({ label, value, onChange, type = "text", placeholder, select }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; select?: Array<[string, string]> }) {
  return <label className="field"><span>{label}</span>{select ? <select value={value} onChange={(event) => onChange(event.target.value)}>{select.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select> : <input type={type} value={value} placeholder={placeholder} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)} />}</label>;
}

export default App;
import "./theme.css";
