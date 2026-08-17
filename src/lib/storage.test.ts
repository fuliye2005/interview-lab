import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHistory } from "./storage";

const historyKey = "interview-lab.history.v1";

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

describe("loadHistory", () => {
  it("migrates legacy per-question records into single-turn interview sessions", () => {
    setStoredHistory([{ id: "turn-1", createdAt: "2026-08-17T08:00:00.000Z", question: "请介绍自己", answer: "我是候选人", asrName: "ASR", llmName: "LLM" }]);

    const sessions = loadHistory();

    expect(sessions).toEqual([expect.objectContaining({ id: "turn-1", carriedTurnCount: 0, turns: [expect.objectContaining({ question: "请介绍自己" })] })]);
  });

  it("keeps session records grouped by interview", () => {
    setStoredHistory([{ id: "session-1", createdAt: "2026-08-17T08:00:00.000Z", updatedAt: "2026-08-17T08:05:00.000Z", asrName: "ASR", llmName: "LLM", carriedTurnCount: 2, turns: [] }]);

    const sessions = loadHistory();

    expect(sessions[0]).toMatchObject({ id: "session-1", carriedTurnCount: 2, turns: [] });
  });
});
