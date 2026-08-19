export type SimpleTomlValue = string | number | boolean;

function findAssignmentSeparator(line: string) {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== "\\") {
      quote = quote === character ? undefined : quote ?? character;
    } else if (character === "=" && !quote) {
      return index;
    }
  }
  return -1;
}

function stripInlineComment(value: string) {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === '"' || character === "'") && value[index - 1] !== "\\") {
      quote = quote === character ? undefined : quote ?? character;
    } else if (character === "#" && !quote) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trim();
}

function parseScalar(raw: string, lineNumber: number): SimpleTomlValue {
  const value = stripInlineComment(raw).trim();
  if (!value) throw new Error(`TOML 第 ${lineNumber} 行缺少值。`);
  if (value.startsWith("[") || value.startsWith("{")) throw new Error(`TOML 第 ${lineNumber} 行暂不支持数组或对象值。`);
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error();
      return parsed;
    } catch {
      throw new Error(`TOML 第 ${lineNumber} 行的字符串不是合法双引号字符串。`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new Error(`TOML 第 ${lineNumber} 行的字符串没有闭合。`);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === "true" || value === "false") return value === "true";
  // Context windows are intentionally allowed to use human-friendly values such as 128K or 1M.
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)[kKmM]$/.test(value)) return value;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`TOML 第 ${lineNumber} 行的值格式不受支持。`);
}

export function parseSimpleToml(input: string): Record<string, SimpleTomlValue> {
  const result: Record<string, SimpleTomlValue> = {};
  input.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (trimmed.startsWith("[") || trimmed.endsWith("]")) throw new Error(`TOML 第 ${lineNumber} 行不支持配置分组。`);
    const separator = findAssignmentSeparator(line);
    if (separator < 0) throw new Error(`TOML 第 ${lineNumber} 行缺少“=”号。`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`TOML 第 ${lineNumber} 行的键名无效。`);
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`TOML 第 ${lineNumber} 行重复定义了键“${key}”。`);
    result[key] = parseScalar(line.slice(separator + 1), lineNumber);
  });
  return result;
}

function formatScalar(value: SimpleTomlValue) {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

export function serializeSimpleToml(values: Record<string, SimpleTomlValue>) {
  return Object.entries(values).map(([key, value]) => `${key} = ${formatScalar(value)}`).join("\n");
}
