import { afterEach, describe, expect, it, vi } from "vitest";
import { createSafeDataBundle, defaultSettings, loadHistory, loadSettings, parseSafeDataBundle, saveSettings } from "./storage";

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

  it("exports a backup without credentials and accepts its normalized shape", () => {
    const settings = defaultSettings();
    settings.asr.apiKey = "asr-secret";
    settings.asrProfiles["aliyun-trial"]!.apiKey = "preset-secret";
    settings.llmProfiles[0].apiKey = "llm-secret";
    const bundle = createSafeDataBundle({ settings, materials: { resume: "简历", jobDescription: "JD", personalNotes: "", candidateSummary: "", jobSummary: "", confirmed: false }, history: [] });

    expect(bundle.settings.asr.apiKey).toBe("");
    expect(bundle.settings.asrProfiles["aliyun-trial"]?.apiKey).toBe("");
    expect(bundle.settings.llmProfiles[0].apiKey).toBe("");
    expect(parseSafeDataBundle(JSON.stringify(bundle))).toMatchObject({ format: "interview-lab-backup", version: 1, history: [] });
    const tampered = JSON.parse(JSON.stringify(bundle)) as { settings: typeof bundle.settings };
    tampered.settings.llmProfiles[0].apiKey = "injected-secret";
    tampered.settings.asrProfiles["aliyun-trial"]!.apiKey = "injected-asr-secret";
    expect(parseSafeDataBundle(JSON.stringify(tampered)).settings.llmProfiles[0].apiKey).toBe("");
    expect(parseSafeDataBundle(JSON.stringify(tampered)).settings.asrProfiles["aliyun-trial"]?.apiKey).toBe("");
  });

  it("rejects malformed or incompatible backup files before touching storage", () => {
    expect(() => parseSafeDataBundle("not-json")).toThrow("不是合法 JSON");
    expect(() => parseSafeDataBundle(JSON.stringify({ format: "other", version: 1 }))).toThrow("不支持");
    expect(() => parseSafeDataBundle(JSON.stringify({ format: "interview-lab-backup", version: 1, settings: {}, materials: {} }))).toThrow("缺少配置");
  });
});
