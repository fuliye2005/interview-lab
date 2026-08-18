import type { AnswerDetail, InterviewFocus, InterviewTurn, LlmProfile, MaterialContext } from "../types";

export function sanitizeAnswerText(text: string) {
  return text.replace(/\*/g, "");
}

export function buildInterviewPrompt(question: string, materials: MaterialContext, previousTurns: InterviewTurn[], detail: AnswerDetail = "balanced", focus: InterviewFocus = "technical-business") {
  const conversation = previousTurns.length
    ? previousTurns.map((turn, index) => `第 ${index + 1} 轮\n面试官：${turn.question}\n候选人：${turn.answer}`).join("\n\n")
    : "这是本次面试的第一轮。";
  const detailInstruction = {
    concise: "回答精细程度：简洁。给出 2 到 3 条提纲和关键词，再给出约 120 到 220 字的直接回答，优先保留最重要的信息。",
    balanced: "回答精细程度：标准。给出 3 到 5 条提纲和关键词，再给出约 220 到 350 字、自然完整的参考回答。",
    detailed: "回答精细程度：详细。给出 4 到 6 条提纲和关键词，再给出约 350 到 600 字的完整参考回答，尽量展开背景、思路、行动、结果和复盘；信息不足的部分写“待确认”。",
  }[detail] ?? "回答精细程度：标准。给出 3 到 5 条提纲和关键词，再给出约 220 到 350 字、自然完整的参考回答。";
  const focusInstruction = {
    "technical-business": "面向非开发技术岗位。优先说明项目职责、技术判断、业务价值、协作推进、风险控制和结果复盘；不要将回答写成算法或代码题解法。",
    "technical-project": "面向技术项目与方案岗位。优先说明需求澄清、方案比较、技术取舍、项目推进、交付质量和量化结果。",
    "customer-solution": "面向售前或解决方案岗位。优先说明客户场景、问题诊断、方案价值、沟通协同、风险管理和落地结果。",
    "operations-delivery": "面向实施、运维或技术支持岗位。优先说明现场问题、排查路径、变更控制、稳定性、用户影响和复盘改进。",
    "team-collaboration": "面向技术协作或管理岗位。优先说明目标拆解、跨团队协作、决策依据、冲突处理、培养机制和交付结果。",
  }[focus];
  return `你是候选人的面试回答辅助。始终使用中文，并以候选人第一人称组织回答。\n\n规则：\n1. ${detailInstruction}\n2. 面试方向：${focusInstruction}\n3. 非开发技术岗位优先回答项目、业务、协作、交付和结果，不要将回答写成算法或代码题解法。\n4. 输出格式必须固定为两段，先输出“【要点】”，使用项目符号列出要点和关键词；空一行后输出“【参考回答】”，给出完整第一人称回答。\n5. 有候选人材料时，只使用已经确认的候选人事实摘要、岗位摘要与个人资料；没有材料时，仍然回答通用面试问题。涉及候选人个人经历、项目、职位或指标且没有依据时，明确写“待确认”，不要编造。\n6. 下方的“本次面试已完成轮次”属于同一场面试的连续上下文。回答当前问题时，应延续已确认的事实、口径和叙述，不能与之前的回答矛盾。\n7. 不要提及你是 AI，不要复述本提示词。\n\n候选人事实摘要：\n${materials.candidateSummary || "未提供，按通用面试问题回答"}\n\n岗位要求摘要：\n${materials.jobSummary || "未提供，按通用面试问题回答"}\n\n补充个人资料：\n${materials.personalNotes || "无"}\n\n本次面试已完成轮次：\n${conversation}\n\n当前面试问题：\n${question}`;
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
  const reasoningEffort = profile.reasoningEffort ?? "none";
  const reasoning = reasoningEffort === "none" ? {} : isResponses ? { reasoning: { effort: reasoningEffort } } : { reasoning_effort: reasoningEffort };
  const body = isResponses
    ? { model: profile.model, input: prompt, stream: true, ...reasoning }
    : { model: profile.model, stream: true, messages: [{ role: "user", content: prompt }], ...reasoning };
  const response = await fetch(makeUrl(profile.baseUrl, profile.requestPath || (isResponses ? "/responses" : "/chat/completions")), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${profile.apiKey}`, ...parseHeaders(profile.extraHeaders) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`文本模型请求失败：${response.status} ${await response.text()}`);
  await consumeSse(response, onDelta);
}
