import type { MaterialContext, PublicRepository, PublicRepositoryDiscovery, PublicRepositoryPage, RepositoryContext, RepositoryListOptions, RepositorySort, RepositoryUserRef } from "../types";

type Provider = RepositoryContext["provider"];
type RepositoryFile = { name?: string; path?: string; type?: string; download_url?: string; url?: string };
type RepositoryPayload = {
  id?: string | number;
  name?: string;
  path?: string;
  full_name?: string;
  html_url?: string;
  web_url?: string;
  description?: string | null;
  default_branch?: string | null;
  language?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  updated_at?: string | null;
  pushed_at?: string | null;
  fork?: boolean;
  archived?: boolean;
  private?: boolean;
  visibility?: string | null;
};

const DEFAULT_REPOSITORY_PAGE_SIZE = 30;
const MAX_REPOSITORY_PAGE_SIZE = 100;
const DEFAULT_DISCOVERY_MAX_PAGES = 5;
const MAX_DISCOVERY_PAGES = 20;

function providerForHost(hostname: string): Provider | undefined {
  const host = hostname.toLowerCase();
  return host === "github.com" ? "github" : host === "gitee.com" ? "gitee" : undefined;
}

function providerUrl(provider: Provider, path: string) {
  return `https://${provider === "github" ? "github.com" : "gitee.com"}${path}`;
}

export function parseRepositoryUrl(input: string): { provider: Provider; owner: string; repo: string; url: string } | undefined {
  try {
    const parsed = new URL(input.trim());
    const provider = providerForHost(parsed.hostname);
    if (!provider) return undefined;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    const repo = parts[1].replace(/\.git$/, "");
    if (!repo) return undefined;
    return { provider, owner: parts[0], repo, url: `https://${parsed.hostname}/${parts[0]}/${repo}` };
  } catch {
    return undefined;
  }
}

/** Parse a provider user page, keeping repository paths out of the discovery flow. */
export function parseRepositoryUserUrl(input: string): RepositoryUserRef | undefined {
  try {
    const parsed = new URL(input.trim());
    const provider = providerForHost(parsed.hostname);
    if (!provider) return undefined;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 1 || !parts[0]) return undefined;
    const username = parts[0];
    return { provider, username, url: providerUrl(provider, `/${username}`) };
  } catch {
    return undefined;
  }
}

function apiBase(provider: Provider) {
  return provider === "github" ? "https://api.github.com" : "https://gitee.com/api/v5";
}

async function fetchJson<T>(url: string, resource = "仓库", signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" }, signal });
  if (!response.ok) {
    if (response.status === 404) throw new Error(`${resource}不存在、地址错误，或内容不是公开的`);
    if (response.status === 403) throw new Error("代码托管平台 API 暂时拒绝了请求，可能已达到访问频率限制，请稍后再试");
    throw new Error(`${resource}请求失败：${response.status}`);
  }
  return response.json() as Promise<T>;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value as number)));
}

function normalizeCount(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizePublicRepository(provider: Provider, username: string, payload: RepositoryPayload): PublicRepository {
  const name = payload.name || payload.path || payload.full_name?.split("/").pop() || "未命名仓库";
  const fullName = payload.full_name || `${username}/${name}`;
  return {
    id: String(payload.id ?? payload.html_url ?? payload.web_url ?? fullName),
    provider,
    owner: username,
    name,
    fullName,
    url: payload.html_url || payload.web_url || providerUrl(provider, `/${username}/${name}`),
    description: payload.description || "",
    defaultBranch: payload.default_branch || "main",
    language: payload.language || "",
    stars: normalizeCount(payload.stargazers_count),
    forks: normalizeCount(payload.forks_count),
    updatedAt: payload.updated_at || payload.pushed_at || "",
    isFork: Boolean(payload.fork),
    archived: Boolean(payload.archived),
    visibility: payload.visibility || (payload.private ? "private" : "public"),
  };
}

function repositoryUser(input: string | RepositoryUserRef): RepositoryUserRef {
  if (typeof input !== "string") return input;
  const parsed = parseRepositoryUserUrl(input);
  if (!parsed) throw new Error("请输入 GitHub 或 Gitee 用户主页地址，例如 https://github.com/用户名");
  return parsed;
}

function repositoryContextKey(repository: RepositoryContext) {
  try {
    const parsed = new URL(repository.url);
    const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    return `${repository.provider}:${parsed.hostname.toLowerCase()}:${path}`;
  } catch {
    return `${repository.provider}:${repository.url.trim().toLowerCase()}:${repository.name.trim().toLowerCase()}`;
  }
}

/** Merge legacy and collection-shaped repository material while preserving first-seen order. */
export function mergeRepositoryContexts(...sources: Array<RepositoryContext | RepositoryContext[] | undefined>): RepositoryContext[] {
  const merged: RepositoryContext[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const entries = Array.isArray(source) ? source : source ? [source] : [];
    for (const repository of entries) {
      if (!repository || !repository.url || !repository.name) continue;
      const key = repositoryContextKey(repository);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(repository);
    }
  }
  return merged;
}

/** Read both repository storage shapes so callers can migrate incrementally. */
export function repositoryContextsFromMaterials(materials: Pick<MaterialContext, "repository" | "repositories">): RepositoryContext[] {
  return mergeRepositoryContexts(materials.repositories, materials.repository);
}

/** Fetch one public repository page for a GitHub/Gitee user. */
export async function listPublicRepositories(input: string | RepositoryUserRef, options: RepositoryListOptions = {}): Promise<PublicRepositoryPage> {
  const user = repositoryUser(input);
  const page = positiveInteger(options.page, 1, Number.MAX_SAFE_INTEGER);
  const perPage = positiveInteger(options.perPage, DEFAULT_REPOSITORY_PAGE_SIZE, MAX_REPOSITORY_PAGE_SIZE);
  const sort: RepositorySort = options.sort || "updated";
  const direction = options.direction || "desc";
  const params = new URLSearchParams({ per_page: String(perPage), page: String(page), sort, direction });
  const endpoint = `${apiBase(user.provider)}/users/${encodeURIComponent(user.username)}/repos?${params.toString()}`;
  const payload = await fetchJson<RepositoryPayload[]>(endpoint, "用户仓库", options.signal);
  const repositories = (Array.isArray(payload) ? payload : [])
    .filter((item) => item.private !== true)
    .map((item) => normalizePublicRepository(user.provider, user.username, item));
  return { user, repositories, page, perPage, hasNextPage: repositories.length >= perPage };
}

/** Discover several pages, bounded to avoid an accidental API-rate-limit loop. */
export async function discoverPublicRepositories(input: string | RepositoryUserRef, options: Omit<RepositoryListOptions, "page"> & { maxPages?: number } = {}): Promise<PublicRepositoryDiscovery> {
  const user = repositoryUser(input);
  const maxPages = positiveInteger(options.maxPages, DEFAULT_DISCOVERY_MAX_PAGES, MAX_DISCOVERY_PAGES);
  const repositories: PublicRepository[] = [];
  const seen = new Set<string>();
  let hasMore = false;
  let pagesFetched = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await listPublicRepositories(user, { ...options, page });
    pagesFetched += 1;
    for (const repository of result.repositories) {
      if (seen.has(repository.id)) continue;
      seen.add(repository.id);
      repositories.push(repository);
    }
    hasMore = result.hasNextPage;
    if (!hasMore) break;
  }
  return { user, repositories, pagesFetched, hasMore };
}

function isKeyFile(name: string) {
  return /^(readme(?:\.[^.]*)?|package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle|dockerfile|docker-compose\.ya?ml|tsconfig\.json|vite\.config\.[^.]*)$/i.test(name);
}

async function collectFiles(provider: Provider, owner: string, repo: string, branch: string, path = "", depth = 0): Promise<RepositoryFile[]> {
  if (depth > 2) return [];
  const endpoint = `${apiBase(provider)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""}?ref=${encodeURIComponent(branch)}`;
  const items = await fetchJson<RepositoryFile | RepositoryFile[]>(endpoint);
  const list = Array.isArray(items) ? items : [items];
  const files: RepositoryFile[] = [];
  for (const item of list.slice(0, 40)) {
    if (item.type === "file") files.push(item);
    else if (item.type === "dir" && depth < 2 && /^(src|app|lib|config|docs|scripts)$/i.test(item.name || "")) {
      files.push(...await collectFiles(provider, owner, repo, branch, item.path || "", depth + 1));
    }
    if (files.length >= 80) break;
  }
  return files.slice(0, 80);
}

async function readFileContent(file: RepositoryFile) {
  if (!file.download_url && !file.url) return "";
  try {
    const response = await fetch(file.download_url || file.url || "");
    if (!response.ok) return "";
    return (await response.text()).slice(0, 12000);
  } catch {
    return "";
  }
}

export async function importRepository(input: string): Promise<RepositoryContext> {
  const parsed = parseRepositoryUrl(input);
  if (!parsed) throw new Error("请输入 GitHub 或 Gitee 公共仓库地址");
  const metadata = await fetchJson<{ default_branch?: string; name?: string; full_name?: string; description?: string }>(`${apiBase(parsed.provider)}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`, "仓库");
  const branch = metadata.default_branch || "main";
  const files = await collectFiles(parsed.provider, parsed.owner, parsed.repo, branch);
  const fileTree = files.map((file) => file.path || file.name || "").filter(Boolean).join("\n");
  const keyFiles = (await Promise.all(files.filter((file) => isKeyFile(file.name || "")).slice(0, 12).map(async (file) => {
    const content = await readFileContent(file);
    return content ? `### __INTERVIEW_LAB_FILE__ ${file.path || file.name}\n${content}` : "";
  }))).filter(Boolean).join("\n\n");
  const name = metadata.full_name || `${parsed.owner}/${parsed.repo}`;
  const summary = [`项目：${name}`, `仓库地址：${parsed.url}`, `默认分支：${branch}`, metadata.description ? `项目描述：${metadata.description}` : "", "请补充你本人在该项目中的职责、关键决策、使用的工具以及最终结果。"].filter(Boolean).join("\n");
  return { url: parsed.url, provider: parsed.provider, name, branch, description: metadata.description || "", fileTree, keyFiles, summary, confirmed: false, importedAt: new Date().toISOString() };
}
