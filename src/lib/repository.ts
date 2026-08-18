import type { RepositoryContext } from "../types";

type Provider = RepositoryContext["provider"];
type RepositoryFile = { name?: string; path?: string; type?: string; download_url?: string; url?: string };

export function parseRepositoryUrl(input: string): { provider: Provider; owner: string; repo: string; url: string } | undefined {
  try {
    const parsed = new URL(input.trim());
    const provider = parsed.hostname.toLowerCase() === "github.com" ? "github" : parsed.hostname.toLowerCase() === "gitee.com" ? "gitee" : undefined;
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

function apiBase(provider: Provider) {
  return provider === "github" ? "https://api.github.com" : "https://gitee.com/api/v5";
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`仓库请求失败：${response.status}`);
  return response.json() as Promise<T>;
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
  const metadata = await fetchJson<{ default_branch?: string; name?: string; full_name?: string; description?: string }>(`${apiBase(parsed.provider)}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`);
  const branch = metadata.default_branch || "main";
  const files = await collectFiles(parsed.provider, parsed.owner, parsed.repo, branch);
  const fileTree = files.map((file) => file.path || file.name || "").filter(Boolean).join("\n");
  const keyFiles = (await Promise.all(files.filter((file) => isKeyFile(file.name || "")).slice(0, 12).map(async (file) => {
    const content = await readFileContent(file);
    return content ? `### ${file.path || file.name}\n${content}` : "";
  }))).filter(Boolean).join("\n\n");
  const name = metadata.full_name || `${parsed.owner}/${parsed.repo}`;
  const summary = [`项目：${name}`, `仓库地址：${parsed.url}`, `默认分支：${branch}`, metadata.description ? `项目描述：${metadata.description}` : "", "请补充你本人在该项目中的职责、关键决策、使用的工具以及最终结果。"].filter(Boolean).join("\n");
  return { url: parsed.url, provider: parsed.provider, name, branch, description: metadata.description || "", fileTree, keyFiles, summary, confirmed: false, importedAt: new Date().toISOString() };
}
