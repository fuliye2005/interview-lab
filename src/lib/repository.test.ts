import { describe, expect, it } from "vitest";
import { parseRepositoryUrl } from "./repository";

describe("parseRepositoryUrl", () => {
  it("accepts GitHub and strips a git suffix", () => {
    expect(parseRepositoryUrl("https://github.com/example/interview-lab.git")).toMatchObject({ provider: "github", owner: "example", repo: "interview-lab" });
  });

  it("accepts Gitee repository paths and rejects unrelated hosts", () => {
    expect(parseRepositoryUrl("https://gitee.com/example/interview-lab")).toMatchObject({ provider: "gitee", repo: "interview-lab" });
    expect(parseRepositoryUrl("https://gitlab.com/example/interview-lab")).toBeUndefined();
  });
});
