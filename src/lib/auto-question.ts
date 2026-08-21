export interface QuestionAssessment {
  isQuestion: boolean;
  isComplete: boolean;
  confidence: number;
  reason: string;
}

const QUESTION_MARKERS = [
  "吗", "么", "什么", "哪些", "哪个", "如何", "怎么", "为什么", "为何", "能否", "是否", "有没有",
  "请介绍", "介绍一下", "谈谈", "说说", "说一下", "讲一下", "举例", "具体讲", "怎么看", "有什么看法", "你会怎样", "遇到",
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
  const questionMark = /[?？]$/.test(text);
  const sentenceEnd = /[。！!]$/.test(text);
  const imperative = /^(请问|请|能不能|可以|麻烦|请你)/.test(text);
  // A full stop is not enough evidence: ordinary statements often end with “。”
  // and must not trigger an automatic answer.
  const isQuestion = questionMark || marker || imperative;
  const isComplete = isQuestion && (
    questionMark
    || (marker && (sentenceEnd || text.length >= 10))
    || (imperative && (sentenceEnd || text.length >= 12))
  );
  const confidence = Math.min(0.98, 0.2 + (marker ? 0.34 : 0) + (questionMark ? 0.34 : 0) + (imperative ? 0.1 : 0) + (sentenceEnd && isQuestion ? 0.04 : 0) + (text.length >= 12 ? 0.08 : 0));
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
  const maxOverlap = Math.min(left.length, right.length);
  let overlap = 0;
  for (let length = maxOverlap; length >= 2; length -= 1) {
    if (left.slice(-length) === right.slice(0, length)) {
      overlap = length;
      break;
    }
  }
  if (overlap) return `${left}${right.slice(overlap)}`;
  const separator = /[\s，。！？、,.!?]$/.test(left) ? "" : " ";
  return `${left}${separator}${right}`;
}
