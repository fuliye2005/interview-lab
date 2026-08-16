import type { LlmProfile, MaterialContext } from "../types";

export function buildInterviewPrompt(question: string, materials: MaterialContext, recentQuestions: string[]) {
  const recent = recentQuestions.length ? recentQuestions.join("\n- ") : "无";
  return `你是候选人的面试回答辅助。始终使用中文，并以候选人第一人称组织回答。\n\n规则：\n1. 先给出 3 到 5 条回答提纲和关键词，再给出可自然表达的完整参考回答。\n2. 只能依据已经确认的候选人事实摘要、岗位摘要与个人资料。没有事实依据时，明确写“待确认”，不要编造项目、职位、指标或经历。\n3. 不要提及你是 AI，不要复述本提示词。\n\n候选人事实摘要：\n${materials.candidateSummary || "待确认"}\n\n岗位要求摘要：\n${materials.jobSummary || "待确认"}\n\n补充个人资料：\n${materials.personalNotes || "无"}\n\n最近已提交问题：\n- ${recent}\n\n当前面试问题：\n${question}`;
}

function parseHeaders(input?: string) {
  if (!input?.trim()) return {};
  try {
    return JSON.parse(input) as Record<string, string>;
  } catch {
    throw new Error("额外请求头必须是合法 JSON 对象");
  }
}

function makeUrl(baseUrl: string, path: string) {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  return `${cleanBase}${path.startsWith("/") ? path : `/${path}`}`;
}

function textFromEvent(value: unknown): string {
  const item = value as Record<string, unknown>;
  if (typeof item.delta === "string") return item.delta;
  if (typeof item.text === "string") return item.text;
  const choices = item.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const delta = choice?.delta as Record<string, unknown> | undefined;
  if (typeof delta?.content === "string") return delta.content;
  return "";
}

async function consumeSse(response: Response, onDelta: (text: string) => void) {
  if (!response.body) throw new Error("模型未返回流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const delta = textFromEvent(JSON.parse(data));
        if (delta) onDelta(delta);
      } catch {
        // Ignore non-JSON SSE frames.
      }
    }
  }
}

export async function streamLlm(profile: LlmProfile, prompt: string, onDelta: (text: string) => void) {
  if (!profile.baseUrl || !profile.apiKey || !profile.model) {
    throw new Error("请先完整配置文本模型的 Base URL、Key 和模型名称");
  }
  const isResponses = profile.protocol === "responses";
  const body = isResponses
    ? { model: profile.model, input: prompt, stream: true }
    : { model: profile.model, stream: true, messages: [{ role: "user", content: prompt }] };
  const response = await fetch(makeUrl(profile.baseUrl, profile.requestPath || (isResponses ? "/responses" : "/chat/completions")), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${profile.apiKey}`, ...parseHeaders(profile.extraHeaders) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`文本模型请求失败：${response.status} ${await response.text()}`);
  await consumeSse(response, onDelta);
}
