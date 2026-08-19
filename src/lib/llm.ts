import { ANSWER_FRAMEWORK_LABELS } from "../types";
import type { AnswerDetail, AnswerFramework, InterviewFocus, InterviewTurn, LlmProfile, LlmUsage, MaterialContext } from "../types";
import { providerRequiresKey } from "./providers";

export function sanitizeAnswerText(text: string) {
  return text.replace(/\*/g, "");
}

/** Keep provider diagnostics useful without allowing credentials into persisted messages. */
export function sanitizeSecretText(raw: string, credential = "") {
  let message = raw;
  if (credential.trim()) message = message.split(credential).join("********");
  return message
    .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer ********")
    .replace(/((?:api[_-]?key|access[_-]?token|secret|token)\s*[:=]\s*["']?)[^\s,;}"']+/gi, "$1********")
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/g, "********")
    .slice(0, 600);
}

export function sanitizeLlmError(error: unknown, credential = "") {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "连接测试失败";
  return sanitizeSecretText(message, credential);
}

export function sanitizeHeaderConfig(raw: string | undefined, reveal = false) {
  if (!raw?.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reveal ? raw : sanitizeSecretText(raw);
    const sensitive = /authorization|api[_-]?key|access[_-]?token|token|secret|password|cookie/i;
    const sanitized = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
      if (!reveal && sensitive.test(key)) return [key, "********"];
      if (!reveal && typeof value === "string") return [key, sanitizeSecretText(value)];
      return [key, value];
    }));
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return reveal ? raw : sanitizeSecretText(raw);
  }
}

export function selectInterviewContext(previousTurns: InterviewTurn[], contextWindow = 8000) {
  const maxChars = Math.max(1200, Math.floor(Math.max(1000, contextWindow) * 1.6));
  const selected: InterviewTurn[] = [];
  let usedChars = 0;

  function trySelect(turn: InterviewTurn) {
    const turnChars = turn.question.length + turn.answer.length + 30;
    if (turnChars > maxChars || usedChars + turnChars > maxChars) return false;
    selected.push(turn);
    usedChars += turnChars;
    return true;
  }

  // Pinned turns are facts the user explicitly wants to keep, even when newer turns fill the window.
  for (const turn of previousTurns) {
    if (!turn.pinned) continue;
    trySelect(turn);
  }
  for (let index = previousTurns.length - 1; index >= 0; index -= 1) {
    const turn = previousTurns[index];
    if (turn.pinned) continue;
    const turnChars = turn.question.length + turn.answer.length + 30;
    // A single oversized turn is omitted, but a normal budget miss stops at this point
    // so older turns cannot displace the newest context.
    if (turnChars > maxChars) continue;
    if (usedChars + turnChars > maxChars) break;
    trySelect(turn);
  }
  selected.sort((left, right) => previousTurns.indexOf(left) - previousTurns.indexOf(right));
  return { turns: selected, omittedCount: previousTurns.length - selected.length };
}

export function buildInterviewPrompt(question: string, materials: MaterialContext, previousTurns: InterviewTurn[], detail: AnswerDetail = "balanced", focus: InterviewFocus = "technical-business", contextWindow = 8000, stageSummary = "", framework: AnswerFramework = "balanced") {
  const context = selectInterviewContext(previousTurns, contextWindow);
  const conversation = context.turns.length
    ? `${context.omittedCount ? `本次上下文窗口省略了 ${context.omittedCount} 轮，完整记录仍保存在本地。\n\n` : ""}${context.turns.map((turn, index) => { const originalIndex = previousTurns.indexOf(turn); const round = originalIndex >= 0 ? originalIndex + 1 : index + 1; return `第 ${round} 轮\n面试官：${turn.question}\n候选人：${turn.answer}`; }).join("\n\n")}`
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
  const frameworkInstruction = {
    balanced: "采用自然、完整的综合回答，先给结论，再补充依据、行动和结果。",
    star: "严格按 STAR 组织：先交代情境和任务，再说明行动，最后给出结果与复盘；信息不足处标记“待确认”。",
    "project-review": "按项目复盘组织：背景与目标、个人职责、关键决策、交付结果、问题与改进。",
    incident: "按故障处理组织：影响范围、现象确认、排查路径、止损与恢复、根因和预防措施。",
    "customer-objection": "按客户异议组织：先复述客户关切，再澄清约束、给出方案取舍、验证价值并说明后续跟进。",
    tradeoff: "按方案权衡组织：列出候选方案、评价维度、关键取舍、风险与回滚，再给出推荐结论。",
    collaboration: "按跨部门协作组织：目标对齐、角色分工、冲突处理、沟通节奏、交付结果和复盘。",
  }[framework] ?? "采用自然、完整的综合回答，先给结论，再补充依据、行动和结果。";
  const repositoryContext = materials.repository?.confirmed
    ? `项目仓库：${materials.repository.name}\n仓库摘要：\n${materials.repository.summary}\n\n目录与关键文件：\n${materials.repository.fileTree.slice(0, 6000)}\n\n关键配置与 README 摘要：\n${materials.repository.keyFiles.slice(0, 14000)}`
    : "未确认项目仓库，不要根据未核对的代码内容推断候选人的经历。";
  const safeStageSummary = stageSummary.trim().slice(0, 6000);
  return `你是候选人的面试回答辅助。始终使用中文，并以候选人第一人称组织回答。\n\n规则：\n1. ${detailInstruction}\n2. 面试方向：${focusInstruction}\n3. 回答框架：${ANSWER_FRAMEWORK_LABELS[framework] || ANSWER_FRAMEWORK_LABELS.balanced}。${frameworkInstruction}\n4. 非开发技术岗位优先回答项目、业务、协作、交付和结果，不要将回答写成算法或代码题解法。\n5. 输出格式必须固定为两段，先输出“【要点】”，使用项目符号列出要点和关键词；空一行后输出“【参考回答】”，给出完整第一人称回答。\n6. 有候选人材料时，只使用已经确认的候选人事实摘要、岗位摘要、个人资料和项目仓库材料；没有材料时，仍然回答通用面试问题。涉及候选人个人经历、项目、职位或指标且没有依据时，明确写“待确认”，不要编造。\n7. 下方的“本次面试已完成轮次”属于同一场面试的连续上下文。回答当前问题时，应延续已确认的事实、口径和叙述，不能与之前的回答矛盾。\n8. 不要提及你是 AI，不要复述本提示词。\n\n候选人事实摘要：\n${materials.candidateSummary || "未提供，按通用面试问题回答"}\n\n岗位要求摘要：\n${materials.jobSummary || "未提供，按通用面试问题回答"}\n\n补充个人资料：\n${materials.personalNotes || "无"}\n\n已确认的项目仓库材料：\n${repositoryContext}\n\n可编辑的阶段摘要：\n${safeStageSummary || "未提供阶段摘要。"}\n\n本次面试已完成轮次：\n${conversation}\n\n当前面试问题：\n${question}`;
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
  if (/^https?:\/\//i.test(path)) return path;
  const cleanBase = baseUrl.replace(/\/+$/, "");
  return `${cleanBase}${path.startsWith("/") ? path : `/${path}`}`;
}

function authHeaders(profile: LlmProfile) {
  return {
    "Content-Type": "application/json",
    ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}),
    ...parseHeaders(profile.extraHeaders),
  };
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

async function consumeSse(response: Response, onDelta: (text: string) => void, signal?: AbortSignal) {
  if (!response.body) throw new Error("模型未返回流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new DOMException("The operation was aborted.", "AbortError");
    }
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

export async function streamLlm(profile: LlmProfile, prompt: string, onDelta: (text: string) => void, signal?: AbortSignal) {
  if (!profile.baseUrl || !profile.model || (providerRequiresKey(profile) && !profile.apiKey)) {
    throw new Error(providerRequiresKey(profile) ? "请先完整配置文本模型的 Base URL、Key 和模型名称" : "请先完整配置本地模型的 Base URL 和模型名称");
  }
  const isResponses = profile.protocol === "responses";
  const reasoningEffort = profile.reasoningEffort ?? "none";
  const reasoning = reasoningEffort === "none" ? {} : isResponses ? { reasoning: { effort: reasoningEffort } } : { reasoning_effort: reasoningEffort };
  const body = isResponses
    ? { model: profile.model, input: prompt, stream: true, ...reasoning }
    : { model: profile.model, stream: true, messages: [{ role: "user", content: prompt }], ...reasoning };
  const response = await fetch(makeUrl(profile.baseUrl, profile.requestPath || (isResponses ? "/responses" : "/chat/completions")), {
    method: "POST",
    headers: authHeaders(profile),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`文本模型请求失败：${response.status} ${await response.text()}`);
  await consumeSse(response, onDelta, signal);
}

export async function listLlmModels(profile: LlmProfile) {
  if (!profile.baseUrl) throw new Error("请先填写模型 Base URL");
  const response = await fetch(makeUrl(profile.baseUrl, "/models"), { headers: authHeaders(profile) });
  if (!response.ok) throw new Error(`获取模型列表失败：${response.status} ${await response.text()}`);
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  const models = Array.isArray(payload.data)
    ? payload.data.map((item) => typeof item.id === "string" ? item.id : "").filter(Boolean)
    : [];
  if (!models.length) throw new Error("服务未返回可用模型");
  return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
}

export async function testLlmConnection(profile: LlmProfile) {
  const startedAt = performance.now();
  let firstTokenMs: number | undefined;
  await streamLlm(profile, "请只回复：连接测试成功。", () => {
    if (firstTokenMs === undefined) firstTokenMs = Math.round(performance.now() - startedAt);
  });
  return {
    latencyMs: Math.round(performance.now() - startedAt),
    firstTokenMs,
  };
}

function usageValue(root: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function usageRoot(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const root = payload as Record<string, unknown>;
  if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) return root.data as Record<string, unknown>;
  if (root.usage && typeof root.usage === "object" && !Array.isArray(root.usage)) return root.usage as Record<string, unknown>;
  return root;
}

/** Convert common provider usage payloads into a short, non-sensitive summary. */
export function summarizeLlmUsage(payload: unknown) {
  const root = usageRoot(payload);
  const totalTokens = usageValue(root, ["total_tokens", "totalTokens", "tokens"]);
  const promptTokens = usageValue(root, ["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"]);
  const completionTokens = usageValue(root, ["completion_tokens", "completionTokens", "output_tokens", "outputTokens"]);
  const cost = usageValue(root, ["total_cost", "totalCost", "cost", "spend"]);
  const limit = usageValue(root, ["limit", "limitUsd", "limit_usd"]);
  const remaining = usageValue(root, ["remaining", "remainingUsd", "remaining_usd"]);
  const currency = typeof root.currency === "string" ? root.currency : "$";
  const parts: string[] = [];
  if (totalTokens !== undefined) parts.push(`总 Token ${totalTokens.toLocaleString()}`);
  else if (promptTokens !== undefined || completionTokens !== undefined) parts.push(`输入 ${promptTokens?.toLocaleString() ?? "—"} · 输出 ${completionTokens?.toLocaleString() ?? "—"} Token`);
  if (cost !== undefined) parts.push(`费用 ${currency}${cost}`);
  if (limit !== undefined) parts.push(`额度 ${currency}${limit}`);
  if (remaining !== undefined) parts.push(`剩余 ${currency}${remaining}`);
  return parts.length ? parts.join(" · ") : "服务已返回用量数据（字段未识别）";
}

export async function fetchLlmUsage(profile: LlmProfile): Promise<Pick<LlmUsage, "summary">> {
  if (!profile.baseUrl) throw new Error("请先填写模型 Base URL");
  if (!profile.usagePath?.trim()) throw new Error("请先在高级请求中填写用量查询路径，例如 /usage");
  const response = await fetch(makeUrl(profile.baseUrl, profile.usagePath.trim()), { headers: authHeaders(profile) });
  const text = await response.text();
  if (!response.ok) throw new Error(`获取用量失败：${response.status} ${text}`);
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("用量接口返回的不是合法 JSON");
  }
  return { summary: summarizeLlmUsage(payload) };
}
