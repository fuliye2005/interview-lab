import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInterviewPrompt, fetchLlmUsage, listLlmModels, sanitizeAnswerText, sanitizeLlmError, selectInterviewContext, streamLlm, summarizeLlmUsage, testLlmConnection } from "./llm";
import type { LlmProfile, MaterialContext } from "../types";

const materials: MaterialContext = {
  resume: "原始简历",
  jobDescription: "原始 JD",
  personalNotes: "候选人补充资料",
  candidateSummary: "候选人有三年后端开发经验，负责过订单系统。",
  jobSummary: "岗位需要 Java、分布式系统和沟通能力。",
  confirmed: true,
};

const profile = (overrides: Partial<LlmProfile> = {}): LlmProfile => ({
  id: "test-profile",
  name: "测试模型",
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
  model: "test-model",
  protocol: "chat-completions",
  requestPath: "",
  extraHeaders: "",
  contextWindow: 8000,
  answerDetail: "balanced",
  reasoningEffort: "none",
  ...overrides,
});

function sseResponse() {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"回答"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function modelsResponse() {
  return new Response(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.restoreAllMocks());

describe("buildInterviewPrompt", () => {
  it("uses confirmed context and requires Chinese first-person grounded answers", () => {
    const prompt = buildInterviewPrompt("请介绍订单系统的难点", materials, [{ question: "请介绍自己", answer: "我有三年后端开发经验。" }]);

    expect(prompt).toContain("始终使用中文");
    expect(prompt).toContain("候选人第一人称");
    expect(prompt).toContain("待确认");
    expect(prompt).toContain(materials.candidateSummary);
    expect(prompt).toContain(materials.jobSummary);
    expect(prompt).toContain("请介绍自己");
    expect(prompt).toContain("我有三年后端开发经验。");
    expect(prompt).toContain("同一场面试的连续上下文");
    expect(prompt).toContain("请介绍订单系统的难点");
  });

  it("marks absent summaries as pending verification", () => {
    const prompt = buildInterviewPrompt("问题", { ...materials, candidateSummary: "", jobSummary: "" }, []);

    expect(prompt).toContain("仍然回答通用面试问题");
    expect(prompt).toContain("未提供，按通用面试问题回答");
    expect(prompt).toContain("没有依据时，明确写“待确认”");
  });

  it("supports an entirely empty materials context", () => {
    const prompt = buildInterviewPrompt("你如何处理跨团队协作？", {
      resume: "",
      jobDescription: "",
      personalNotes: "",
      candidateSummary: "",
      jobSummary: "",
      confirmed: false,
    }, []);

    expect(prompt).toContain("你如何处理跨团队协作？");
    expect(prompt).toContain("仍然回答通用面试问题");
  });

  it("changes the answer instructions for each detail level", () => {
    const concise = buildInterviewPrompt("问题", materials, [], "concise");
    const balanced = buildInterviewPrompt("问题", materials, [], "balanced");
    const detailed = buildInterviewPrompt("问题", materials, [], "detailed");

    expect(concise).toContain("回答精细程度：简洁");
    expect(balanced).toContain("回答精细程度：标准");
    expect(detailed).toContain("回答精细程度：详细");
    expect(concise).not.toBe(balanced);
    expect(balanced).not.toBe(detailed);
  });

  it("adapts answers for non-development technical roles", () => {
    const prompt = buildInterviewPrompt("你如何处理客户现场的故障？", materials, [], "balanced", "operations-delivery");

    expect(prompt).toContain("实施、运维或技术支持岗位");
    expect(prompt).toContain("不要将回答写成算法或代码题解法");
  });

  it("applies a per-session answer framework without changing the model profile", () => {
    const prompt = buildInterviewPrompt("请说说一次客户异议", materials, [], "balanced", "customer-solution", 8000, "这一轮重点是客户价值和风险边界。", "customer-objection");

    expect(prompt).toContain("客户异议");
    expect(prompt).toContain("先复述客户关切");
    expect(prompt).toContain("这一轮重点是客户价值和风险边界。");
  });

  it("keeps the newest turns when a long interview reaches the context window", () => {
    const turns = Array.from({ length: 12 }, (_, index) => ({ question: `问题 ${index + 1}`, answer: "很长的回答内容。".repeat(100) }));
    const selected = selectInterviewContext(turns, 1200);

    expect(selected.omittedCount).toBeGreaterThan(0);
    expect(selected.turns[selected.turns.length - 1]?.question).toBe("问题 12");
    const prompt = buildInterviewPrompt("当前问题", materials, turns, "balanced", "technical-business", 1200);
    expect(prompt).toContain("更早的");
    expect(prompt).toContain("问题 12");
    expect(prompt).not.toContain("问题 1\n");
  });

  it("keeps pinned turns ahead of newer turns when context is constrained", () => {
    const turns = [
      { id: "pinned", question: "候选人的固定事实", answer: "我负责过订单系统交付。", pinned: true },
      ...Array.from({ length: 10 }, (_, index) => ({ question: `较新问题 ${index + 1}`, answer: "较长回答。".repeat(100) })),
    ];
    const selected = selectInterviewContext(turns, 1200);

    expect(selected.turns.some((turn) => turn.id === "pinned")).toBe(true);
    expect(selected.turns[selected.turns.length - 1]?.question).toBe("较新问题 10");
  });
});

describe("streamLlm reasoning settings", () => {
  it("does not send a reasoning field when effort is not specified", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse());

    await streamLlm(profile(), "问题", () => undefined);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("allows a keyless local Ollama profile", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse());

    await streamLlm(profile({ provider: "ollama", preset: "ollama", apiKey: "", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" }), "问题", () => undefined);

    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[1]?.headers)).not.toContain("Bearer");
  });

  it("maps effort to Chat Completions reasoning_effort", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse());

    await streamLlm(profile({ reasoningEffort: "medium" }), "问题", () => undefined);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.reasoning_effort).toBe("medium");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("maps effort to Responses API reasoning.effort", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse());

    await streamLlm(profile({ protocol: "responses", reasoningEffort: "high" }), "问题", () => undefined);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("returns latency metrics for a connection test", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse());

    const result = await testLlmConnection(profile());

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it("loads and sorts unique model ids", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelsResponse());

    await expect(listLlmModels(profile())).resolves.toEqual(["a-model", "z-model"]);
  });

  it("passes an abort signal through streaming requests", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      return sseResponse();
    });

    await expect(streamLlm(profile(), "问题", () => undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("provider usage", () => {
  it("summarizes common nested token and cost fields", () => {
    expect(summarizeLlmUsage({ data: { total_tokens: 12345, total_cost: 1.25, currency: "USD", remaining: 4.5 } })).toContain("总 Token 12,345");
    expect(summarizeLlmUsage({ data: { total_tokens: 12345, total_cost: 1.25, currency: "USD", remaining: 4.5 } })).toContain("费用 USD1.25");
    expect(summarizeLlmUsage({ usage: { input_tokens: 10, output_tokens: 20 } })).toContain("输入 10 · 输出 20 Token");
  });

  it("fetches usage through the configured path and keeps the auth header", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ total_tokens: 99 }), { status: 200 }));

    await expect(fetchLlmUsage(profile({ usagePath: "/usage" }))).resolves.toEqual({ summary: "总 Token 99" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.test/v1/usage");
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("requires an explicit usage endpoint", async () => {
    await expect(fetchLlmUsage(profile())).rejects.toThrow("用量查询路径");
  });
});

describe("sanitizeAnswerText", () => {
  it("removes markdown asterisks before display", () => {
    expect(sanitizeAnswerText("**回答提纲**\n* 第一条\n普通文本")).toBe("回答提纲\n 第一条\n普通文本");
  });
});

describe("sanitizeLlmError", () => {
  it("removes provider credentials from diagnostic text", () => {
    const credential = "test-credential-secret-123456789";
    const message = sanitizeLlmError(new Error(`401 api_key=${credential}; Bearer ${credential}`), credential);

    expect(message).not.toContain(credential);
    expect(message).toContain("********");
  });
});
