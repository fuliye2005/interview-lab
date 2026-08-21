import { describe, expect, it } from "vitest";
import { assessQuestion, mergeTranscript, normalizeQuestionFingerprint } from "./auto-question";

describe("auto question assessment", () => {
  it("recognizes a complete Chinese interview question", () => {
    const result = assessQuestion("请介绍一下你负责的项目？");
    expect(result.isQuestion).toBe(true);
    expect(result.isComplete).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it("waits on short filler speech", () => {
    expect(assessQuestion("嗯嗯").isQuestion).toBe(false);
  });

  it("does not treat an ordinary statement ending with a full stop as a question", () => {
    const result = assessQuestion("我负责了客户交付项目。");
    expect(result.isQuestion).toBe(false);
    expect(result.isComplete).toBe(false);
  });

  it("normalizes duplicate question fingerprints", () => {
    expect(normalizeQuestionFingerprint("为什么选择我们？")).toBe(normalizeQuestionFingerprint("为什么选择我们"));
  });

  it("merges sentence finals without duplicating a provider's full replacement", () => {
    expect(mergeTranscript("请介绍一下你的项目", "请介绍一下你的项目以及你负责的部分？")).toBe("请介绍一下你的项目以及你负责的部分？");
    expect(mergeTranscript("请介绍一下你的项目", "你负责的部分？")).toBe("请介绍一下你的项目 你负责的部分？");
    expect(mergeTranscript("请介绍一下你的项目以及你", "你的项目以及你负责的部分？")).toBe("请介绍一下你的项目以及你负责的部分？");
  });
});
