import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverPublicRepositories, listPublicRepositories, mergeRepositoryContexts, parseRepositoryUrl, parseRepositoryUserUrl, repositoryContextsFromMaterials } from "./repository";
import type { RepositoryContext } from "../types";

describe("parseRepositoryUrl", () => {
  it("accepts GitHub and strips a git suffix", () => {
    expect(parseRepositoryUrl("https://github.com/example/interview-lab.git")).toMatchObject({ provider: "github", owner: "example", repo: "interview-lab" });
  });

  it("accepts Gitee repository paths and rejects unrelated hosts", () => {
    expect(parseRepositoryUrl("https://gitee.com/example/interview-lab")).toMatchObject({ provider: "gitee", repo: "interview-lab" });
    expect(parseRepositoryUrl("https://gitlab.com/example/interview-lab")).toBeUndefined();
  });
});

describe("parseRepositoryUserUrl", () => {
  it("accepts user homepages and removes trailing slash/query details", () => {
    expect(parseRepositoryUserUrl("https://github.com/fuliye2005/?tab=repositories")).toEqual({ provider: "github", username: "fuliye2005", url: "https://github.com/fuliye2005" });
    expect(parseRepositoryUserUrl("https://gitee.com/example")).toEqual({ provider: "gitee", username: "example", url: "https://gitee.com/example" });
  });

  it("does not mistake a repository path for a user page", () => {
    expect(parseRepositoryUserUrl("https://github.com/example/interview-lab")).toBeUndefined();
    expect(parseRepositoryUserUrl("https://gitlab.com/example")).toBeUndefined();
    expect(parseRepositoryUserUrl("not a url")).toBeUndefined();
  });
});

describe("public repository discovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches a GitHub page with pagination parameters and normalizes metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        id: 42,
        name: "interview-lab",
        full_name: "fuliye2005/interview-lab",
        html_url: "https://github.com/fuliye2005/interview-lab",
        description: null,
        default_branch: "main",
        language: "TypeScript",
        stargazers_count: 3,
        forks_count: 1,
        updated_at: "2026-09-03T00:00:00Z",
        fork: false,
        archived: false,
        private: false,
      },
    ])));

    const result = await listPublicRepositories("https://github.com/fuliye2005", { page: 2, perPage: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("https://api.github.com/users/fuliye2005/repos?");
    expect(requestUrl).toContain("per_page=1");
    expect(requestUrl).toContain("page=2");
    expect(result).toMatchObject({ page: 2, perPage: 1, hasNextPage: true });
    expect(result.repositories[0]).toMatchObject({ id: "42", provider: "github", fullName: "fuliye2005/interview-lab", defaultBranch: "main", stars: 3, forks: 1, visibility: "public" });
  });

  it("uses the Gitee user endpoint and reports the final page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      { id: 7, name: "demo", path: "demo", html_url: "https://gitee.com/example/demo", default_branch: "master", fork: true, private: false },
    ])));

    const result = await listPublicRepositories("https://gitee.com/example", { perPage: 30 });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("https://gitee.com/api/v5/users/example/repos?");
    expect(result.hasNextPage).toBe(false);
    expect(result.repositories[0]).toMatchObject({ provider: "gitee", name: "demo", defaultBranch: "master", isFork: true });
  });

  it("can discover multiple pages without duplicating repository ids", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const page = new URL(url).searchParams.get("page");
      return new Response(JSON.stringify(page === "1"
        ? [{ id: 1, name: "one", html_url: "https://github.com/example/one" }, { id: 2, name: "two", html_url: "https://github.com/example/two" }, { id: 3, name: "three", html_url: "https://github.com/example/three" }]
        : page === "2"
          ? [{ id: 1, name: "one", html_url: "https://github.com/example/one" }, { id: 4, name: "four", html_url: "https://github.com/example/four" }]
          : []));
    });

    const result = await discoverPublicRepositories("https://github.com/example", { perPage: 3, maxPages: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.pagesFetched).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.repositories.map((repository) => repository.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("merges legacy and collection material without duplicate repositories", () => {
    const legacy = { url: "https://github.com/example/demo", provider: "github", name: "demo", branch: "main", description: "", fileTree: "", keyFiles: "", summary: "", confirmed: false, importedAt: "2026-09-03T00:00:00Z" } satisfies RepositoryContext;
    const duplicate = { ...legacy, url: "https://github.com/example/demo/", name: "different label" };
    const second = { ...legacy, url: "https://gitee.com/example/second", provider: "gitee", name: "second" } satisfies RepositoryContext;

    expect(mergeRepositoryContexts([legacy, duplicate], legacy, second).map((repository) => repository.url)).toEqual([legacy.url, second.url]);
    expect(repositoryContextsFromMaterials({ repository: legacy, repositories: [duplicate, second] })).toHaveLength(2);
  });
});
