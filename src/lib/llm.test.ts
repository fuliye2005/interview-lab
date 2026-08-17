import { describe, expect, it } from "vitest";
import { buildInterviewPrompt } from "./llm";
import type { MaterialContext } from "../types";

const materials: MaterialContext = {
  resume: "原始简历",
  jobDescription: "原始 JD",
  personalNotes: "候选人补充资料",
  candidateSummary: "候选人有三年后端开发经验，负责过订单系统。",
  jobSummary: "岗位需要 Java、分布式系统和沟通能力。",
  confirmed: true,
};

describe("buildInterviewPrompt", () => {
  it("uses confirmed context and requires Chinese first-person grounded answers", () => {
    const prompt = buildInterviewPrompt("请介绍订单系统的难点", materials, ["请介绍自己"]);

    expect(prompt).toContain("始终使用中文");
    expect(prompt).toContain("候选人第一人称");
    expect(prompt).toContain("待确认");
    expect(prompt).toContain(materials.candidateSummary);
    expect(prompt).toContain(materials.jobSummary);
    expect(prompt).toContain("请介绍自己");
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
});
