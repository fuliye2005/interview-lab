import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalSnapshot, createSafeDataBundle, defaultSettings, isLikelyDatabaseCorruption, loadHistory, loadSettings, mergeStoredHeaderConfig, parseExternalSnapshot, parseSafeDataBundle, saveSettings, saveSnapshot } from "./storage";

const historyKey = "interview-lab.history.v1";
const settingsKey = "interview-lab.settings.v1";

afterEach(() => vi.unstubAllGlobals());

function setStoredHistory(value: unknown) {
  const values = new Map([[historyKey, JSON.stringify(value)]]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, item: string) => values.set(key, item),
      removeItem: (key: string) => values.delete(key),
    },
  });
}

function setStoredSettings(value: unknown) {
  const values = new Map([[settingsKey, JSON.stringify(value)]]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, item: string) => values.set(key, item),
      removeItem: (key: string) => values.delete(key),
    },
  });
  return values;
}

describe("loadHistory", () => {
  it("migrates legacy per-question records into single-turn interview sessions", () => {
    setStoredHistory([{ id: "turn-1", createdAt: "2026-08-17T08:00:00.000Z", question: "请介绍自己", answer: "我是候选人", asrName: "ASR", llmName: "LLM" }]);

    const sessions = loadHistory();

    expect(sessions).toEqual([expect.objectContaining({ id: "turn-1", title: expect.stringMatching(/^历史面试 /), carriedTurnCount: 0, turns: [expect.objectContaining({ question: "请介绍自己" })] })]);
  });

  it("keeps session records grouped by interview", () => {
    setStoredHistory([{ id: "session-1", createdAt: "2026-08-17T08:00:00.000Z", updatedAt: "2026-08-17T08:05:00.000Z", asrName: "ASR", llmName: "LLM", carriedTurnCount: 2, turns: [] }]);

    const sessions = loadHistory();

    expect(sessions[0]).toMatchObject({ id: "session-1", title: expect.stringMatching(/^历史面试 /), carriedTurnCount: 2, turns: [] });
  });

  it("preserves manually named sessions", () => {
    setStoredHistory([{ id: "session-2", title: "解决方案顾问一面", createdAt: "2026-08-17T08:00:00.000Z", updatedAt: "2026-08-17T08:05:00.000Z", asrName: "ASR", llmName: "LLM", carriedTurnCount: 0, turns: [] }]);

    expect(loadHistory()[0]).toMatchObject({ id: "session-2", title: "解决方案顾问一面" });
  });

  it("normalizes context inclusion and pinning flags for old and new turns", () => {
    setStoredHistory([{ id: "session-3", title: "二面", createdAt: "2026-08-17T08:00:00.000Z", updatedAt: "2026-08-17T08:05:00.000Z", asrName: "ASR", llmName: "LLM", carriedTurnCount: 0, turns: [
      { id: "turn-1", createdAt: "2026-08-17T08:01:00.000Z", question: "固定问题", answer: "固定回答", asrName: "ASR", llmName: "LLM", pinned: true },
      { id: "turn-2", createdAt: "2026-08-17T08:02:00.000Z", question: "排除问题", answer: "排除回答", asrName: "ASR", llmName: "LLM", contextIncluded: false },
    ] }]);

    expect(loadHistory()[0]?.turns).toEqual([
      expect.objectContaining({ id: "turn-1", contextIncluded: true, pinned: true }),
      expect.objectContaining({ id: "turn-2", contextIncluded: false, pinned: false }),
    ]);
  });

  it("keeps a resumable unfinished interview draft across reloads", () => {
    setStoredHistory([{ id: "session-draft", title: "未完成的一面", createdAt: "2026-08-19T08:00:00.000Z", updatedAt: "2026-08-19T08:02:00.000Z", asrName: "ASR", llmName: "LLM", carriedTurnCount: 1, turns: [], draft: {
      active: true,
      sessionMode: "answer",
      testMode: "answer",
      paused: false,
      question: "请继续这个问题",
      partial: "",
      answer: "上一次已经生成的回答",
      answerStatus: "complete",
      lastQuestion: "上一问",
      turns: [{ id: "turn-1", question: "上一问", answer: "上一答" }],
      contextTurns: [{ id: "turn-1", sessionId: "session-draft", question: "上一问", answer: "上一答", included: true, pinned: true }],
      completeHistoryCount: 1,
      contextStats: { total: 1, sent: 1, omitted: 0 },
      frameworkOverride: "star",
      savedAt: "2026-08-19T08:02:00.000Z",
    } }]);

    const session = loadHistory()[0];

    expect(session?.draft).toMatchObject({ active: true, sessionMode: "answer", question: "请继续这个问题", turns: [{ id: "turn-1" }], contextStats: { sent: 1 } });
  });
});

describe("loadSettings", () => {
  it("keeps wheel scrolling disabled by default and merges partial legacy settings", () => {
    setStoredSettings({ wheelScroll: { answer: true }, shortcutEnabled: false });

    expect(loadSettings()).toMatchObject({ wheelScroll: { transcript: false, answer: true }, shortcutEnabled: false, closeToTray: true, answerFramework: "balanced", overlayToggleShortcut: "Ctrl+Shift+O", stopGenerationShortcut: "Ctrl+Shift+X", clickThroughShortcut: "Ctrl+Shift+P" });
  });

  it("falls back to a safe answer framework when legacy settings contain an unknown value", () => {
    setStoredSettings({ answerFramework: "invented-framework" });

    expect(loadSettings().answerFramework).toBe("balanced");
  });

  it("does not persist credentials in browser preview storage", async () => {
    const values = setStoredSettings(null);
    const settings = defaultSettings();
    settings.asr.apiKey = "asr-secret";
    settings.llmProfiles[0].apiKey = "llm-secret";
    await saveSettings(settings);
    const persisted = JSON.parse(values.get(settingsKey) || "{}") as typeof settings;

    expect(persisted.asr.apiKey).toBe("");
    expect(persisted.llmProfiles[0].apiKey).toBe("");
  });

  it("persists provider health without leaking the credential", async () => {
    const values = setStoredSettings(null);
    const settings = defaultSettings();
    const credential = "test-health-secret-123456789";
    settings.llmProfiles[0].apiKey = credential;
    settings.llmProfiles[0].health = {
      status: "error",
      testedAt: "2026-08-18T08:00:00.000Z",
      message: `请求失败 api_key=${credential}`,
    };

    await saveSettings(settings);
    const persisted = JSON.parse(values.get(settingsKey) || "{}") as typeof settings;
    const healthMessage = persisted.llmProfiles[0].health?.message || "";

    expect(persisted.llmProfiles[0].health).toMatchObject({ status: "error", testedAt: "2026-08-18T08:00:00.000Z" });
    expect(healthMessage).not.toContain(credential);
    expect(healthMessage).toContain("********");
  });

  it("normalizes a bounded provider health history and usage snapshot", () => {
    const history = Array.from({ length: 20 }, (_, index) => ({ status: "success", testedAt: `2026-08-18T08:${String(index).padStart(2, "0")}:00.000Z`, latencyMs: index }));
    setStoredSettings({ llmProfiles: [{ id: "history-profile", name: "历史模型", healthHistory: history, usage: { status: "success", fetchedAt: "2026-08-18T09:00:00.000Z", summary: "总 Token 10" } }] });

    const profile = loadSettings().llmProfiles[0];
    expect(profile.healthHistory).toHaveLength(12);
    expect(profile.healthHistory?.[0]?.latencyMs).toBe(0);
    expect(profile.usage).toMatchObject({ status: "success", summary: "总 Token 10" });
  });

  it("redacts sensitive values inside custom request headers", async () => {
    const values = setStoredSettings(null);
    const settings = defaultSettings();
    settings.asr.extraHeaders = JSON.stringify({ Authorization: "Bearer asr-header-secret", "X-Trace": "trace-value" });
    settings.llmProfiles[0].extraHeaders = JSON.stringify({ "X-API-Key": "llm-header-secret", "X-Trace": "trace-value" });

    await saveSettings(settings);

    const persisted = JSON.parse(values.get(settingsKey) || "{}") as typeof settings;
    expect(persisted.asr.extraHeaders).not.toContain("asr-header-secret");
    expect(persisted.asr.extraHeaders).toContain("********");
    expect(persisted.asr.extraHeaders).toContain("trace-value");
    expect(persisted.llmProfiles[0].extraHeaders).not.toContain("llm-header-secret");
    expect(persisted.llmProfiles[0].extraHeaders).toContain("********");
  });

  it("restores masked header values from the local Stronghold copy", () => {
    const persisted = JSON.stringify({ Authorization: "********", "X-Trace": "trace-value" });
    const local = JSON.stringify({ Authorization: "Bearer local-secret", "X-Trace": "trace-value" });

    expect(mergeStoredHeaderConfig(persisted, local)).toBe(JSON.stringify({ Authorization: "Bearer local-secret", "X-Trace": "trace-value" }, null, 2));
    expect(mergeStoredHeaderConfig(persisted, "")).toBe(JSON.stringify({ "X-Trace": "trace-value" }, null, 2));
  });

  it("writes an imported snapshot as a complete browser-preview unit", async () => {
    const values = setStoredSettings(null);
    const settings = defaultSettings();
    settings.llmProfiles[0].apiKey = "snapshot-secret";
    const materials = { resume: "简历", jobDescription: "JD", personalNotes: "", candidateSummary: "", jobSummary: "", confirmed: false };
    const history = [{ id: "session-1", title: "一面", createdAt: "2026-08-18T08:00:00.000Z", updatedAt: "2026-08-18T08:01:00.000Z", asrName: "ASR", llmName: "LLM", carriedTurnCount: 0, turns: [] }];

    await saveSnapshot({ settings, materials, history });

    expect(JSON.parse(values.get(settingsKey) || "{}")).toMatchObject({ llmProfiles: [{ apiKey: "" }] });
    expect(JSON.parse(values.get("interview-lab.materials.v1") || "{}")).toMatchObject({ resume: "简历" });
    expect(JSON.parse(values.get(historyKey) || "[]")).toHaveLength(1);
  });

  it("exports a backup without credentials and accepts its normalized shape", () => {
    const settings = defaultSettings();
    settings.asr.apiKey = "asr-secret";
    settings.asrProfiles["aliyun-trial"]!.apiKey = "preset-secret";
    settings.llmProfiles[0].apiKey = "llm-secret";
    const bundle = createSafeDataBundle({ settings, materials: { resume: "简历", jobDescription: "JD", personalNotes: "", candidateSummary: "", jobSummary: "", confirmed: false }, history: [] });

    expect(bundle.settings.asr.apiKey).toBe("");
    expect(bundle.settings.asrProfiles["aliyun-trial"]?.apiKey).toBe("");
    expect(bundle.settings.llmProfiles[0].apiKey).toBe("");
    expect(parseSafeDataBundle(JSON.stringify(bundle))).toMatchObject({ format: "interview-lab-backup", version: 2, history: [] });
    const legacyBundle = { ...bundle, version: 1 };
    expect(parseSafeDataBundle(JSON.stringify(legacyBundle))).toMatchObject({ format: "interview-lab-backup", version: 2 });
    const tampered = JSON.parse(JSON.stringify(bundle)) as { settings: typeof bundle.settings };
    tampered.settings.llmProfiles[0].apiKey = "injected-secret";
    tampered.settings.asrProfiles["aliyun-trial"]!.apiKey = "injected-asr-secret";
    expect(parseSafeDataBundle(JSON.stringify(tampered)).settings.llmProfiles[0].apiKey).toBe("");
    expect(parseSafeDataBundle(JSON.stringify(tampered)).settings.asrProfiles["aliyun-trial"]?.apiKey).toBe("");
  });

  it("rejects malformed or incompatible backup files before touching storage", () => {
    expect(() => parseSafeDataBundle("not-json")).toThrow("不是合法 JSON");
    expect(() => parseSafeDataBundle(JSON.stringify({ format: "other", version: 1 }))).toThrow("不支持");
    expect(() => parseSafeDataBundle(JSON.stringify({ format: "interview-lab-backup", version: 2, settings: {}, materials: {} }))).toThrow("缺少配置");
    expect(() => parseSafeDataBundle(JSON.stringify({ format: "interview-lab-backup", version: 3, settings: {}, materials: {}, history: [] }))).toThrow("不支持");
  });
});

describe("external recovery snapshots", () => {
  it("only treats explicit SQLite corruption messages as recoverable database damage", () => {
    expect(isLikelyDatabaseCorruption(new Error("database disk image is malformed"))).toBe(true);
    expect(isLikelyDatabaseCorruption({ message: "file is not a database" })).toBe(true);
    expect(isLikelyDatabaseCorruption(new Error("migration failed: permission denied"))).toBe(false);
    expect(isLikelyDatabaseCorruption(new Error("unable to open database file"))).toBe(false);
  });

  it("creates a versioned snapshot without API keys or sensitive headers", () => {
    const settings = defaultSettings();
    settings.asr.apiKey = "asr-external-secret";
    settings.asr.extraHeaders = JSON.stringify({ Authorization: "Bearer external-header-secret", "X-Trace": "keep" });
    settings.llmProfiles[0].apiKey = "llm-external-secret";
    settings.llmProfiles[0].extraHeaders = JSON.stringify({ "X-API-Key": "header-secret", "X-Trace": "keep" });
    const snapshot = createExternalSnapshot({ settings, materials: { resume: "简历", jobDescription: "JD", personalNotes: "", candidateSummary: "", jobSummary: "", confirmed: false }, history: [] }, "test");

    expect(snapshot).toMatchObject({ format: "interview-lab-snapshot", version: 2, reason: "test" });
    expect(JSON.stringify(snapshot)).not.toContain("asr-external-secret");
    expect(JSON.stringify(snapshot)).not.toContain("llm-external-secret");
    expect(JSON.stringify(snapshot)).not.toContain("external-header-secret");
    expect(JSON.stringify(snapshot)).toContain("********");
  });

  it("accepts only the current snapshot format and normalizes its contents", () => {
    const settings = defaultSettings();
    const snapshot = createExternalSnapshot({ settings, materials: { resume: "简历", jobDescription: "JD", personalNotes: "", candidateSummary: "", jobSummary: "", confirmed: false }, history: [] }, "test");

    expect(parseExternalSnapshot(JSON.stringify(snapshot))).toMatchObject({ settings: { wheelScroll: { transcript: false, answer: false } }, history: [] });
    expect(parseExternalSnapshot(JSON.stringify({ ...snapshot, version: 1 }))).toBeUndefined();
    expect(parseExternalSnapshot(JSON.stringify({ ...snapshot, format: "other" }))).toBeUndefined();
    expect(parseExternalSnapshot("not-json")).toBeUndefined();
  });
});
