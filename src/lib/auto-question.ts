export interface QuestionAssessment {
  isQuestion: boolean;
  isComplete: boolean;
  confidence: number;
  reason: string;
}

const QUESTION_MARKERS = [
  "吗", "么", "如何", "怎么", "为什么", "为何", "能否", "是否", "请介绍", "介绍一下",
  "谈谈", "说说", "说一下", "讲一下", "举例", "具体讲", "怎么看", "有什么看法", "你会怎样", "遇到",
];

const FILLER_PATTERNS = [/^(嗯+|啊+|呃+|那个|这个|好的|好吧|对的)[，。！!、\s]*$/i];

function normalize(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

/**
 * A low-latency, provider-independent first pass. It intentionally errs on
 * the side of waiting: only a likely, complete question should reach LLM.
 */
export function assessQuestion(input: string): QuestionAssessment {
  const text = normalize(input);
  if (!text || text.length < 4 || FILLER_PATTERNS.some((pattern) => pattern.test(text))) {
    return { isQuestion: false, isComplete: false, confidence: 0, reason: "内容过短或只是口头填充" };
  }

  const marker = QUESTION_MARKERS.some((item) => text.includes(item));
  const punctuation = /[?？。！!]$/.test(text);
  const imperative = /^(请|能不能|可以|麻烦|请你)/.test(text);
  const confidence = Math.min(0.98, 0.28 + (marker ? 0.34 : 0) + (punctuation ? 0.2 : 0) + (imperative ? 0.1 : 0) + (text.length >= 12 ? 0.08 : 0));
  const isQuestion = marker || punctuation || imperative;
  const isComplete = isQuestion && (punctuation || marker || text.length >= 12);
  return {
    isQuestion,
    isComplete,
    confidence,
    reason: isComplete ? "已识别为完整问题" : isQuestion ? "疑似问题，等待补充" : "暂未识别为问题",
  };
}

export function normalizeQuestionFingerprint(input: string) {
  return normalize(input).replace(/[，。！？、,.!?\s]/g, "").toLocaleLowerCase();
}

export function mergeTranscript(existing: string, incoming: string) {
  const left = normalize(existing);
  const right = normalize(incoming);
  if (!left) return right;
  if (!right || left === right || left.endsWith(right)) return left;
  if (right.startsWith(left)) return right;
  const separator = /[\s，。！？、,.!?]$/.test(left) ? "" : " ";
  return `${left}${separator}${right}`;
}
