import { isTauri, invoke } from "@tauri-apps/api/core";
import { sanitizeHeaderConfig, sanitizeLlmError } from "./llm";
import type { AnswerFramework, AppSettings, AsrPreset, AsrProviderConfig, InterviewContextTurn, InterviewDraft, InterviewFocus, InterviewSession, InterviewTurn, LlmHealth, LlmProfile, LlmUsage, MaterialContext, SessionRecord } from "../types";
import { createAsrPreset, createDefaultAsrConfig, createDefaultLlmProfile } from "../types";

const SETTINGS_KEY = "interview-lab.settings.v1";
const MATERIALS_KEY = "interview-lab.materials.v1";
const HISTORY_KEY = "interview-lab.history.v1";
const DATABASE_PATH = "sqlite:interview-lab.db";
const STRONGHOLD_CLIENT = "interview-lab";
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
export const DATA_SCHEMA_VERSION = 2;

type SqlResult = { rowsAffected: number; lastInsertId?: number };
interface SqlDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<SqlResult>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}
interface SecretStore {
  get(key: string): Promise<Uint8Array | null>;
  insert(key: string, value: number[]): Promise<void>;
  remove(key: string): Promise<Uint8Array | null>;
}
interface SecretVault {
  save(): Promise<void>;
}

export interface PersistentSnapshot {
  settings: AppSettings;
  materials: MaterialContext;
  history: InterviewSession[];
}

export interface SafeDataBundle {
  format: "interview-lab-backup";
  version: 2;
  exportedAt: string;
  note: "API keys are intentionally excluded; re-enter them after import.";
  settings: AppSettings;
  materials: MaterialContext;
  history: InterviewSession[];
}

export interface StorageDiagnostics {
  backend: "sqlite" | "localStorage";
  schemaVersion: number;
  migrationStatus: "current" | "outdated" | "unknown" | "error";
  migrationVersion?: number;
  migrationDescription?: string;
  integrity: "ok" | "unknown" | "error";
  secretStore: "stronghold" | "browser-not-persisted";
  backupCount: number;
  lastBackupAt?: string;
  uncleanExit: boolean;
  lastStartedAt?: string;
  lastCleanShutdownAt?: string;
  recoveryPerformed?: boolean;
  recoveryMessage?: string;
}

interface RuntimeMarker {
  state: "running" | "clean";
  startedAt: string;
  cleanAt?: string;
}

interface PersistentContext {
  db: SqlDatabase;
  store: SecretStore;
  stronghold: SecretVault;
  snapshot: PersistentSnapshot;
  secretCache: Map<string, string>;
  writeQueue: Promise<void>;
  lastBackupAt: number;
  startup: { uncleanExit: boolean; lastStartedAt?: string; lastCleanShutdownAt?: string; recoveryPerformed?: boolean; recoveryMessage?: string };
}

interface PersistedSnapshotPayload {
  format?: unknown;
  version?: unknown;
  settings?: Partial<AppSettings>;
  materials?: unknown;
  history?: unknown;
}

let contextPromise: Promise<PersistentContext> | undefined;

export const defaultSettings = (): AppSettings => ({
  asr: createDefaultAsrConfig(),
  asrProfiles: { "aliyun-trial": createDefaultAsrConfig() },
  llmProfiles: [createDefaultLlmProfile()],
  activeLlmProfileId: "",
  shortcut: "Ctrl+Shift+Space",
  overlayToggleShortcut: "Ctrl+Shift+O",
  stopGenerationShortcut: "Ctrl+Shift+X",
  clickThroughShortcut: "Ctrl+Shift+P",
  shortcutEnabled: true,
  closeToTray: true,
  interviewFocus: "technical-business",
  answerFramework: "balanced",
  sessionTitleDraft: "",
  wheelScroll: { transcript: false, answer: false },
  overlay: {
    alwaysOnTop: true,
    opacity: 0.96,
    fontScale: 1,
    layout: "standard",
    clickThrough: false,
    autoFollow: true,
    size: { width: 520, height: 440 },
  },
});

export const emptyMaterials = (): MaterialContext => ({
  resume: "",
  jobDescription: "",
  personalNotes: "",
  candidateSummary: "",
  jobSummary: "",
  confirmed: false,
});

function read<T>(key: string, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function normalizeLlmProfile(profile: Partial<LlmProfile>): LlmProfile {
  const defaults = createDefaultLlmProfile();
  const provider = profile.provider && ["custom", "openai-compatible", "openai-responses", "openrouter", "deepseek", "kimi", "qwen", "doubao", "ollama"].includes(profile.provider)
    ? profile.provider
    : defaults.provider;
  const modelOptions = Array.isArray(profile.modelOptions)
    ? profile.modelOptions.filter((model): model is string => typeof model === "string").slice(0, 200)
    : defaults.modelOptions;
  const apiKey = typeof profile.apiKey === "string" ? profile.apiKey : "";
  const health = normalizeLlmHealth(profile.health, apiKey);
  return {
    ...defaults,
    ...profile,
    id: profile.id || defaults.id,
    name: profile.name || defaults.name,
    provider,
    preset: provider,
    modelOptions,
    answerDetail: profile.answerDetail === "concise" || profile.answerDetail === "detailed" || profile.answerDetail === "balanced" ? profile.answerDetail : defaults.answerDetail,
    reasoningEffort: profile.reasoningEffort === "low" || profile.reasoningEffort === "medium" || profile.reasoningEffort === "high" || profile.reasoningEffort === "none" ? profile.reasoningEffort : defaults.reasoningEffort,
    apiKey,
    usagePath: typeof profile.usagePath === "string" ? profile.usagePath.slice(0, 240) : defaults.usagePath,
    health,
    healthHistory: normalizeLlmHealthHistory(profile.healthHistory, apiKey) ?? (health ? [health] : undefined),
    usage: normalizeLlmUsage(profile.usage, apiKey),
  };
}

function normalizeLlmHealth(value: unknown, credential = ""): LlmHealth | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (source.status !== "success" && source.status !== "error") return undefined;
  if (typeof source.testedAt !== "string" || !source.testedAt.trim()) return undefined;
  const health: NonNullable<LlmProfile["health"]> = {
    status: source.status,
    testedAt: source.testedAt.slice(0, 80),
  };
  if (Number.isFinite(source.latencyMs)) health.latencyMs = Math.max(0, Math.round(Number(source.latencyMs)));
  if (Number.isFinite(source.firstTokenMs)) health.firstTokenMs = Math.max(0, Math.round(Number(source.firstTokenMs)));
  if (typeof source.message === "string" && source.message.trim()) health.message = sanitizeLlmError(source.message, credential);
  return health;
}

function normalizeLlmHealthHistory(value: unknown, credential = "") {
  if (!Array.isArray(value)) return undefined;
  const history = value.map((item) => normalizeLlmHealth(item, credential)).filter((item): item is LlmHealth => Boolean(item));
  return history.length ? history.slice(0, 12) : undefined;
}

function normalizeLlmUsage(value: unknown, credential = ""): LlmUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (source.status !== "success" && source.status !== "error") return undefined;
  if (typeof source.fetchedAt !== "string" || !source.fetchedAt.trim()) return undefined;
  const usage: LlmUsage = { status: source.status, fetchedAt: source.fetchedAt.slice(0, 80) };
  if (typeof source.summary === "string" && source.summary.trim()) usage.summary = sanitizeLlmError(source.summary, credential).slice(0, 300);
  if (typeof source.message === "string" && source.message.trim()) usage.message = sanitizeLlmError(source.message, credential);
  return usage;
}

function normalizeSettings(stored?: Partial<AppSettings> | null): AppSettings {
  const fallback = defaultSettings();
  const source = stored ?? {};
  const storedWheelScroll = source.wheelScroll && typeof source.wheelScroll === "object" ? source.wheelScroll : {};
  const storedOverlay = source.overlay && typeof source.overlay === "object" ? source.overlay : {};
  const llmProfiles = Array.isArray(source.llmProfiles) && source.llmProfiles.length
    ? source.llmProfiles.map((profile) => normalizeLlmProfile(profile))
    : fallback.llmProfiles;
  const activeAsr = {
    ...(source.asr?.preset ? createAsrPreset(source.asr.preset) : fallback.asr),
    ...(source.asr ?? {}),
    protocol: source.asr?.protocol ?? (source.asr?.wsUrl ? "generic" : fallback.asr.protocol),
  };
  const asrProfiles = Object.fromEntries(
    Object.entries(source.asrProfiles ?? {}).map(([preset, profile]) => [preset, {
      ...createAsrPreset(preset as AsrPreset),
      ...profile,
    }]),
  ) as Partial<Record<AsrPreset, AsrProviderConfig>>;
  const activePreset = activeAsr.preset ?? "generic";
  const settings: AppSettings = {
    ...fallback,
    ...source,
    asr: activeAsr,
    asrProfiles: { ...fallback.asrProfiles, ...asrProfiles, [activePreset]: activeAsr },
    llmProfiles,
    shortcut: typeof source.shortcut === "string" && source.shortcut.trim() ? source.shortcut : fallback.shortcut,
    overlayToggleShortcut: typeof source.overlayToggleShortcut === "string" && source.overlayToggleShortcut.trim() ? source.overlayToggleShortcut : fallback.overlayToggleShortcut,
    stopGenerationShortcut: typeof source.stopGenerationShortcut === "string" && source.stopGenerationShortcut.trim() ? source.stopGenerationShortcut : fallback.stopGenerationShortcut,
    clickThroughShortcut: typeof source.clickThroughShortcut === "string" && source.clickThroughShortcut.trim() ? source.clickThroughShortcut : fallback.clickThroughShortcut,
    shortcutEnabled: typeof source.shortcutEnabled === "boolean" ? source.shortcutEnabled : fallback.shortcutEnabled,
    closeToTray: typeof source.closeToTray === "boolean" ? source.closeToTray : fallback.closeToTray,
    interviewFocus: isInterviewFocus(source.interviewFocus) ? source.interviewFocus : fallback.interviewFocus,
    answerFramework: isAnswerFramework(source.answerFramework) ? source.answerFramework : fallback.answerFramework,
    sessionTitleDraft: typeof source.sessionTitleDraft === "string" ? source.sessionTitleDraft : fallback.sessionTitleDraft,
    wheelScroll: { ...fallback.wheelScroll, ...storedWheelScroll },
    overlay: normalizeOverlaySettings(storedOverlay, fallback.overlay),
  };
  if (!settings.llmProfiles.some((profile) => profile.id === settings.activeLlmProfileId)) {
    settings.activeLlmProfileId = settings.llmProfiles[0]?.id || "";
  }
  return settings;
}

function normalizeOverlaySettings(value: unknown, fallback: AppSettings["overlay"]): AppSettings["overlay"] {
  const source = value && typeof value === "object" ? value as Partial<AppSettings["overlay"]> : {};
  const position = source.position && typeof source.position === "object" && Number.isFinite(source.position.x) && Number.isFinite(source.position.y)
    ? { x: Number(source.position.x), y: Number(source.position.y) }
    : fallback.position;
  const size = source.size && typeof source.size === "object" && Number.isFinite(source.size.width) && Number.isFinite(source.size.height)
    ? { width: Math.max(360, Number(source.size.width)), height: Math.max(280, Number(source.size.height)) }
    : fallback.size;
  const layout = source.layout === "compact" || source.layout === "standard" || source.layout === "answer" || source.layout === "transcript" ? source.layout : fallback.layout;
  return {
    ...fallback,
    ...source,
    opacity: Number.isFinite(source.opacity) ? Math.min(1, Math.max(0.55, Number(source.opacity))) : fallback.opacity,
    fontScale: Number.isFinite(source.fontScale) ? Math.min(1.35, Math.max(0.8, Number(source.fontScale))) : fallback.fontScale,
    layout,
    position,
    size,
    alwaysOnTop: typeof source.alwaysOnTop === "boolean" ? source.alwaysOnTop : fallback.alwaysOnTop,
    clickThrough: typeof source.clickThrough === "boolean" ? source.clickThrough : fallback.clickThrough,
    autoFollow: typeof source.autoFollow === "boolean" ? source.autoFollow : fallback.autoFollow,
  };
}

function isInterviewFocus(value: unknown): value is InterviewFocus {
  return value === "technical-business" || value === "technical-project" || value === "customer-solution" || value === "operations-delivery" || value === "team-collaboration";
}

function isAnswerFramework(value: unknown): value is AnswerFramework {
  return value === "balanced" || value === "star" || value === "project-review" || value === "incident" || value === "customer-objection" || value === "tradeoff" || value === "collaboration";
}

function normalizeMaterials(value: unknown): MaterialContext {
  return { ...emptyMaterials(), ...(value && typeof value === "object" ? value as Partial<MaterialContext> : {}) };
}

function isInterviewSession(value: unknown): value is InterviewSession {
  return typeof value === "object" && value !== null && Array.isArray((value as InterviewSession).turns);
}

function normalizeInterviewDraft(value: unknown): InterviewDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Partial<InterviewDraft>;
  if (source.active !== true) return undefined;
  const sessionMode = source.sessionMode === "all" || source.sessionMode === "asr" || source.sessionMode === "answer" ? source.sessionMode : "answer";
  const testMode = source.testMode === "all" || source.testMode === "asr" || source.testMode === "answer" ? source.testMode : sessionMode;
  const answerStatus = source.answerStatus === "idle" || source.answerStatus === "generating" || source.answerStatus === "complete" || source.answerStatus === "error" ? source.answerStatus : "idle";
  const turns = Array.isArray(source.turns)
    ? source.turns.filter((turn): turn is InterviewTurn => Boolean(turn && typeof turn === "object" && typeof turn.question === "string" && typeof turn.answer === "string")).slice(-200).map((turn) => ({ id: typeof turn.id === "string" ? turn.id.slice(0, 120) : undefined, question: turn.question.slice(0, 20000), answer: turn.answer.slice(0, 40000), pinned: Boolean(turn.pinned) }))
    : [];
  const contextTurns = Array.isArray(source.contextTurns)
    ? source.contextTurns.filter((turn): turn is InterviewContextTurn => Boolean(turn && typeof turn === "object" && typeof turn.id === "string" && typeof turn.sessionId === "string" && typeof turn.question === "string" && typeof turn.answer === "string")).slice(-300).map((turn) => ({ id: turn.id.slice(0, 120), sessionId: turn.sessionId.slice(0, 120), question: turn.question.slice(0, 20000), answer: turn.answer.slice(0, 40000), included: turn.included !== false, pinned: Boolean(turn.pinned) }))
    : [];
  const sourceStats = source.contextStats && typeof source.contextStats === "object"
    ? source.contextStats as Partial<InterviewDraft["contextStats"]>
    : {};
  const contextStats = {
    total: Number.isFinite(sourceStats.total) ? Math.max(0, Math.round(Number(sourceStats.total))) : contextTurns.length,
    sent: Number.isFinite(sourceStats.sent) ? Math.max(0, Math.round(Number(sourceStats.sent))) : contextTurns.filter((turn) => turn.included).length,
    omitted: Number.isFinite(sourceStats.omitted) ? Math.max(0, Math.round(Number(sourceStats.omitted))) : 0,
  };
  return {
    active: true,
    sessionMode,
    testMode,
    paused: Boolean(source.paused),
    question: typeof source.question === "string" ? source.question.slice(0, 20000) : "",
    partial: typeof source.partial === "string" ? source.partial.slice(0, 12000) : "",
    answer: typeof source.answer === "string" ? source.answer.slice(0, 50000) : "",
    answerStatus,
    lastQuestion: typeof source.lastQuestion === "string" ? source.lastQuestion.slice(0, 20000) : "",
    turns,
    contextTurns,
    completeHistoryCount: Number.isFinite(source.completeHistoryCount) ? Math.max(0, Math.round(Number(source.completeHistoryCount))) : contextStats.total,
    contextStats,
    frameworkOverride: source.frameworkOverride === "balanced" || source.frameworkOverride === "star" || source.frameworkOverride === "project-review" || source.frameworkOverride === "incident" || source.frameworkOverride === "customer-objection" || source.frameworkOverride === "tradeoff" || source.frameworkOverride === "collaboration" ? source.frameworkOverride : "",
    savedAt: typeof source.savedAt === "string" && source.savedAt.trim() ? source.savedAt.slice(0, 80) : new Date().toISOString(),
  };
}

function normalizeHistory(value: unknown): InterviewSession[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (isInterviewSession(item)) {
      const turns = item.turns.map((turn) => ({
        ...turn,
        contextIncluded: typeof turn.contextIncluded === "boolean" ? turn.contextIncluded : !turn.error && Boolean(turn.answer?.trim()),
        pinned: Boolean(turn.pinned),
      }));
      return {
        ...item,
        title: typeof item.title === "string" && item.title.trim() ? item.title : `历史面试 ${new Date(item.createdAt).toLocaleString()}`,
        updatedAt: item.updatedAt || item.createdAt,
        carriedTurnCount: item.carriedTurnCount || 0,
        stageSummary: typeof item.stageSummary === "string" ? item.stageSummary : "",
        lastContextTurnCount: Number.isFinite(item.lastContextTurnCount) ? Math.max(0, Number(item.lastContextTurnCount)) : 0,
        lastOmittedTurnCount: Number.isFinite(item.lastOmittedTurnCount) ? Math.max(0, Number(item.lastOmittedTurnCount)) : 0,
        draft: normalizeInterviewDraft(item.draft),
        turns,
      };
    }
    const record = item as SessionRecord;
    const normalizedRecord = {
      ...record,
      contextIncluded: typeof record.contextIncluded === "boolean" ? record.contextIncluded : !record.error && Boolean(record.answer?.trim()),
      pinned: Boolean(record.pinned),
    };
    return {
      id: record.id,
      title: `历史面试 ${new Date(record.createdAt).toLocaleString()}`,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      asrName: record.asrName,
      llmName: record.llmName,
      carriedTurnCount: 0,
      stageSummary: "",
      lastContextTurnCount: 0,
      lastOmittedTurnCount: 0,
      turns: [normalizedRecord],
    };
  }).filter((item) => Boolean(item.id && item.createdAt));
}

export function loadSettings(): AppSettings {
  return normalizeSettings(read<Partial<AppSettings> | null>(SETTINGS_KEY, null));
}

export const loadMaterials = () => normalizeMaterials(read<Partial<MaterialContext>>(MATERIALS_KEY, emptyMaterials()));

export function loadHistory(): InterviewSession[] {
  return normalizeHistory(read<unknown>(HISTORY_KEY, []));
}

export function createSafeDataBundle(snapshot: PersistentSnapshot): SafeDataBundle {
  return {
    format: "interview-lab-backup",
    version: 2,
    exportedAt: new Date().toISOString(),
    note: "API keys are intentionally excluded; re-enter them after import.",
    settings: redactSettings(snapshot.settings),
    materials: snapshot.materials,
    history: snapshot.history.slice(0, 50),
  };
}

export function parseSafeDataBundle(raw: string): SafeDataBundle {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("备份文件不是合法 JSON");
  }
  if (!value || typeof value !== "object") throw new Error("备份文件格式不正确");
  const source = value as { format?: unknown; version?: unknown; exportedAt?: unknown; settings?: unknown; materials?: unknown; history?: unknown };
  if (source.format !== "interview-lab-backup" || (source.version !== 1 && source.version !== 2)) throw new Error("不支持的 Interview Lab 备份版本");
  if (!source.settings || !source.materials || !Array.isArray(source.history)) throw new Error("备份文件缺少配置、材料或会话记录");
  return {
    format: "interview-lab-backup",
    version: 2,
    exportedAt: typeof source.exportedAt === "string" ? source.exportedAt : new Date().toISOString(),
    note: "API keys are intentionally excluded; re-enter them after import.",
    settings: redactSettings(normalizeSettings(source.settings as Partial<AppSettings>)),
    materials: normalizeMaterials(source.materials),
    history: normalizeHistory(source.history),
  };
}

function hasLegacyData() {
  try {
    return Boolean(window.localStorage.getItem(SETTINGS_KEY) || window.localStorage.getItem(MATERIALS_KEY) || window.localStorage.getItem(HISTORY_KEY));
  } catch {
    return false;
  }
}

function redactSettings(settings: AppSettings): AppSettings {
  const asrProfiles = Object.fromEntries(
    Object.entries(settings.asrProfiles).map(([preset, profile]) => [preset, profile ? { ...profile, apiKey: "", extraHeaders: sanitizeHeaderConfig(profile.extraHeaders) } : profile]),
  ) as AppSettings["asrProfiles"];
  return {
    ...settings,
    asr: { ...settings.asr, apiKey: "", extraHeaders: sanitizeHeaderConfig(settings.asr.extraHeaders) },
    asrProfiles,
    llmProfiles: settings.llmProfiles.map((profile) => ({
      ...profile,
      apiKey: "",
      extraHeaders: sanitizeHeaderConfig(profile.extraHeaders),
      health: normalizeLlmHealth(profile.health, profile.apiKey),
      healthHistory: normalizeLlmHealthHistory(profile.healthHistory, profile.apiKey),
      usage: normalizeLlmUsage(profile.usage, profile.apiKey),
    })),
  };
}

export function parseExternalSnapshot(raw: string | null | undefined): PersistentSnapshot | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const source = JSON.parse(raw) as PersistedSnapshotPayload;
    if (source.format !== "interview-lab-snapshot" || source.version !== DATA_SCHEMA_VERSION) return undefined;
    if (!source.settings || source.materials === undefined || !Array.isArray(source.history)) return undefined;
    return {
      settings: redactSettings(normalizeSettings(source.settings)),
      materials: normalizeMaterials(source.materials),
      history: normalizeHistory(source.history),
    };
  } catch {
    return undefined;
  }
}

export function createExternalSnapshot(snapshot: PersistentSnapshot, reason: string) {
  return {
    format: "interview-lab-snapshot",
    version: DATA_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    reason,
    settings: redactSettings(snapshot.settings),
    materials: snapshot.materials,
    history: snapshot.history.slice(0, 50),
  };
}

async function writeExternalSnapshot(snapshot: PersistentSnapshot, reason: string) {
  await invoke("write_external_snapshot", { payload: JSON.stringify(createExternalSnapshot(snapshot, reason)) }).catch(() => undefined);
}

const MASKED_SECRET_PATTERN = /\*{4,}/;

function hasMaskedSecret(value: unknown) {
  return typeof value === "string" && MASKED_SECRET_PATTERN.test(value);
}

/** Remove placeholders from a persisted fallback so they are never sent as real headers. */
function safeHeaderFallback(raw?: string) {
  if (!raw?.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return hasMaskedSecret(raw) ? "" : raw;
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter(([key, value]) => !hasMaskedSecret(key) && !hasMaskedSecret(value));
    return JSON.stringify(Object.fromEntries(entries), null, 2);
  } catch {
    return hasMaskedSecret(raw) ? "" : raw;
  }
}

/** Merge local Stronghold header values into an imported or backed-up masked config. */
export function mergeStoredHeaderConfig(persisted: string | undefined, stored: string | undefined) {
  const localStored = stored && !hasMaskedSecret(stored) ? stored : "";
  if (!localStored.trim()) return safeHeaderFallback(persisted);
  if (!persisted?.trim()) return localStored;
  try {
    const imported = JSON.parse(persisted) as unknown;
    const local = JSON.parse(localStored) as unknown;
    if (!imported || typeof imported !== "object" || Array.isArray(imported) || !local || typeof local !== "object" || Array.isArray(local)) {
      return hasMaskedSecret(persisted) ? localStored : persisted;
    }
    const localEntries = local as Record<string, unknown>;
    const merged = Object.fromEntries(Object.entries(imported as Record<string, unknown>).map(([key, value]) => [
      key,
      hasMaskedSecret(value) && Object.prototype.hasOwnProperty.call(localEntries, key) ? localEntries[key] : value,
    ]));
    return JSON.stringify(merged, null, 2);
  } catch {
    return hasMaskedSecret(persisted) ? localStored : persisted;
  }
}

function llmHeaderSecretKey(profileId: string) {
  return `llm:headers:${profileId}`;
}

function asrHeaderSecretKey(preset: string) {
  return `asr:headers:${preset}`;
}

function secretValue(value: string | undefined) {
  return value && !hasMaskedSecret(value) ? value : "";
}

function secretEntries(settings: AppSettings) {
  const entries: Array<{ key: string; value: string }> = settings.llmProfiles.flatMap((profile) => [
    { key: `llm:${profile.id}`, value: secretValue(profile.apiKey) },
    { key: llmHeaderSecretKey(profile.id), value: secretValue(profile.extraHeaders) },
  ]);
  entries.push({ key: "asr:active", value: secretValue(settings.asr.apiKey) });
  entries.push({ key: asrHeaderSecretKey("active"), value: secretValue(settings.asr.extraHeaders) });
  for (const [preset, profile] of Object.entries(settings.asrProfiles)) {
    if (profile) {
      entries.push({ key: `asr:${preset}`, value: secretValue(profile.apiKey) });
      entries.push({ key: asrHeaderSecretKey(preset), value: secretValue(profile.extraHeaders) });
    }
  }
  return entries;
}

function encodeSecret(value: string) {
  return Array.from(new TextEncoder().encode(value));
}

function decodeSecret(value: Uint8Array | null) {
  return value ? new TextDecoder().decode(value) : "";
}

async function readSecret(context: PersistentContext, key: string) {
  try {
    const value = decodeSecret(await context.store.get(key));
    if (value) context.secretCache.set(key, value);
    return value;
  } catch {
    return "";
  }
}

async function hydrateSecrets(context: PersistentContext, settings: AppSettings): Promise<AppSettings> {
  const llmProfiles = await Promise.all(settings.llmProfiles.map(async (profile) => ({
    ...profile,
    apiKey: await readSecret(context, `llm:${profile.id}`),
    extraHeaders: mergeStoredHeaderConfig(profile.extraHeaders, await readSecret(context, llmHeaderSecretKey(profile.id))),
  })));
  const asrProfiles: AppSettings["asrProfiles"] = {};
  for (const [preset, profile] of Object.entries(settings.asrProfiles)) {
    if (profile) {
      asrProfiles[preset as AsrPreset] = {
        ...profile,
        apiKey: await readSecret(context, `asr:${preset}`),
        extraHeaders: mergeStoredHeaderConfig(profile.extraHeaders, await readSecret(context, asrHeaderSecretKey(preset))),
      };
    }
  }
  const activeApiKey = await readSecret(context, "asr:active");
  const activeHeaders = mergeStoredHeaderConfig(settings.asr.extraHeaders, await readSecret(context, asrHeaderSecretKey("active")));
  return { ...settings, llmProfiles, asrProfiles, asr: { ...settings.asr, apiKey: activeApiKey, extraHeaders: activeHeaders } };
}

async function writeSecrets(context: PersistentContext, settings: AppSettings) {
  let changed = false;
  const entries = secretEntries(settings);
  const currentKeys = new Set(entries.map((entry) => entry.key));
  for (const key of context.secretCache.keys()) {
    if (!currentKeys.has(key)) {
      await context.store.remove(key);
      context.secretCache.delete(key);
      changed = true;
    }
  }
  for (const entry of entries) {
    const previous = context.secretCache.get(entry.key) || "";
    if (entry.value === previous) continue;
    if (entry.value) {
      await context.store.insert(entry.key, encodeSecret(entry.value));
      context.secretCache.set(entry.key, entry.value);
    } else {
      await context.store.remove(entry.key).catch(() => undefined);
      context.secretCache.delete(entry.key);
    }
    changed = true;
  }
  if (changed) await context.stronghold.save();
}

async function upsertDocument(context: PersistentContext, key: string, payload: unknown) {
  await context.db.execute(
    "INSERT INTO app_documents (document_key, payload, schema_version, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT(document_key) DO UPDATE SET payload = excluded.payload, schema_version = excluded.schema_version, updated_at = excluded.updated_at",
    [key, JSON.stringify(payload), DATA_SCHEMA_VERSION, new Date().toISOString()],
  );
}

async function replaceHistoryRows(context: PersistentContext, history: InterviewSession[]) {
  await context.db.execute("DELETE FROM interview_sessions");
  for (const session of history.slice(0, 50)) {
    await context.db.execute(
      "INSERT INTO interview_sessions (id, created_at, updated_at, title, source_session_id, carried_turn_count, asr_name, llm_name, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [session.id, session.createdAt, session.updatedAt, session.title, session.sourceSessionId ?? null, session.carriedTurnCount || 0, session.asrName, session.llmName, JSON.stringify(session)],
    );
  }
}

async function replaceHistory(context: PersistentContext, history: InterviewSession[]) {
  await context.db.execute("BEGIN");
  try {
    await replaceHistoryRows(context, history);
    await context.db.execute("COMMIT");
  } catch (error) {
    await context.db.execute("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function readLatestBackup(context: PersistentContext): Promise<PersistentSnapshot | undefined> {
  const rows = await context.db.select<Array<{ settings_payload: string; materials_payload: string; history_payload: string }>>("SELECT settings_payload, materials_payload, history_payload FROM storage_backups ORDER BY id DESC LIMIT 1");
  const row = rows[0];
  if (!row) return undefined;
  try {
    return {
      settings: normalizeSettings(JSON.parse(row.settings_payload) as Partial<AppSettings>),
      materials: normalizeMaterials(JSON.parse(row.materials_payload)),
      history: normalizeHistory(JSON.parse(row.history_payload)),
    };
  } catch {
    return undefined;
  }
}

async function maybeCreateBackup(context: PersistentContext, reason: string, force = false) {
  if (!force && Date.now() - context.lastBackupAt < BACKUP_INTERVAL_MS) return;
  const createdAt = new Date().toISOString();
  await context.db.execute(
    "INSERT INTO storage_backups (created_at, reason, settings_payload, materials_payload, history_payload) VALUES ($1, $2, $3, $4, $5)",
    [createdAt, reason, JSON.stringify(redactSettings(context.snapshot.settings)), JSON.stringify(context.snapshot.materials), JSON.stringify(context.snapshot.history.slice(0, 50))],
  );
  await context.db.execute("DELETE FROM storage_backups WHERE id NOT IN (SELECT id FROM storage_backups ORDER BY id DESC LIMIT 5)");
  await writeExternalSnapshot(context.snapshot, reason);
  context.lastBackupAt = Date.now();
}

async function persistSettingsNow(context: PersistentContext, settings: AppSettings, reason: string) {
  await maybeCreateBackup(context, reason);
  await writeSecrets(context, settings);
  await upsertDocument(context, "settings", redactSettings(settings));
  context.snapshot.settings = settings;
}

async function persistMaterialsNow(context: PersistentContext, materials: MaterialContext, reason: string) {
  await maybeCreateBackup(context, reason);
  await upsertDocument(context, "materials", materials);
  context.snapshot.materials = materials;
}

async function persistHistoryNow(context: PersistentContext, history: InterviewSession[], reason: string) {
  await maybeCreateBackup(context, reason);
  await replaceHistory(context, history);
  context.snapshot.history = history.slice(0, 50);
}

async function persistSnapshotRows(context: PersistentContext, snapshot: PersistentSnapshot) {
  await context.db.execute("BEGIN");
  try {
    await upsertDocument(context, "settings", redactSettings(snapshot.settings));
    await upsertDocument(context, "materials", snapshot.materials);
    await replaceHistoryRows(context, snapshot.history);
    await context.db.execute("COMMIT");
  } catch (error) {
    await context.db.execute("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function persistSnapshotNow(context: PersistentContext, snapshot: PersistentSnapshot, reason: string, forceBackup = false) {
  await maybeCreateBackup(context, reason, forceBackup);
  await persistSnapshotRows(context, snapshot);
  await writeSecrets(context, snapshot.settings);
  context.snapshot = { settings: snapshot.settings, materials: snapshot.materials, history: snapshot.history.slice(0, 50) };
}

function enqueue(context: PersistentContext, operation: () => Promise<void>) {
  context.writeQueue = context.writeQueue.then(operation, operation);
  return context.writeQueue;
}

async function createTauriContext(): Promise<PersistentContext> {
  const [{ default: Database }, { Stronghold }, { appDataDir, join }] = await Promise.all([
    import("@tauri-apps/plugin-sql"),
    import("@tauri-apps/plugin-stronghold"),
    import("@tauri-apps/api/path"),
  ]);
  let databaseRecovered = false;
  let db: SqlDatabase;
  try {
    db = await Database.load(DATABASE_PATH) as unknown as SqlDatabase;
  } catch (error) {
    const isolated = await invoke<string | null>("isolate_corrupt_database").catch(() => null);
    if (!isolated) throw error;
    databaseRecovered = true;
    db = await Database.load(DATABASE_PATH) as unknown as SqlDatabase;
  }
  const password = await invoke<string>("get_vault_password");
  const vaultPath = await join(await appDataDir(), "interview-lab.secrets.hold");
  const stronghold = await Stronghold.load(vaultPath, password);
  let client;
  try {
    client = await stronghold.loadClient(STRONGHOLD_CLIENT);
  } catch {
    client = await stronghold.createClient(STRONGHOLD_CLIENT);
  }
  const context: PersistentContext = {
    db,
    store: client.getStore() as SecretStore,
    stronghold: stronghold as SecretVault,
    snapshot: { settings: defaultSettings(), materials: emptyMaterials(), history: [] },
    secretCache: new Map(),
    writeQueue: Promise.resolve(),
    lastBackupAt: 0,
    startup: { uncleanExit: false },
  };
  const externalSnapshot = databaseRecovered
    ? parseExternalSnapshot(await invoke<string | null>("read_latest_external_snapshot").catch(() => null))
    : undefined;
  const runtimeRows = await db.select<Array<{ payload: string }>>("SELECT payload FROM app_documents WHERE document_key = $1", ["runtime"]);
  let previousRuntime: RuntimeMarker | undefined;
  try {
    previousRuntime = runtimeRows[0]?.payload ? JSON.parse(runtimeRows[0].payload) as RuntimeMarker : undefined;
  } catch {
    previousRuntime = undefined;
  }
  const startedAt = new Date().toISOString();
  context.startup = {
    uncleanExit: previousRuntime?.state === "running",
    lastStartedAt: startedAt,
    lastCleanShutdownAt: previousRuntime?.cleanAt,
  };
  const settingsRows = await db.select<Array<{ payload: string }>>("SELECT payload FROM app_documents WHERE document_key = $1", ["settings"]);
  const materialsRows = await db.select<Array<{ payload: string }>>("SELECT payload FROM app_documents WHERE document_key = $1", ["materials"]);
  const historyRows = await db.select<Array<{ payload: string }>>("SELECT payload FROM interview_sessions ORDER BY updated_at DESC");
  const hasDatabaseState = settingsRows.length > 0 || materialsRows.length > 0 || historyRows.length > 0;
  if (!hasDatabaseState && externalSnapshot) {
    const hydratedSettings = await hydrateSecrets(context, externalSnapshot.settings);
    const recoveredSnapshot = { settings: hydratedSettings, materials: externalSnapshot.materials, history: externalSnapshot.history };
    await persistSnapshotRows(context, recoveredSnapshot);
    await writeSecrets(context, hydratedSettings);
    context.snapshot = recoveredSnapshot;
    context.startup.recoveryPerformed = true;
    context.startup.recoveryMessage = "检测到数据库无法加载，已从最近的脱敏外部快照恢复配置、材料和会话；本机 Stronghold 凭证已保留。";
  } else if (!hasDatabaseState && databaseRecovered) {
    context.startup.recoveryMessage = "检测到数据库无法加载，已重建空数据库；没有可用的外部快照，未覆盖其它本机数据。";
  } else if (!hasDatabaseState && hasLegacyData()) {
    const legacy = { settings: loadSettings(), materials: loadMaterials(), history: loadHistory() };
    context.snapshot = legacy;
    await writeSecrets(context, legacy.settings);
    await upsertDocument(context, "settings", redactSettings(legacy.settings));
    await upsertDocument(context, "materials", legacy.materials);
    await replaceHistory(context, legacy.history);
    window.localStorage.removeItem(SETTINGS_KEY);
    window.localStorage.removeItem(MATERIALS_KEY);
    window.localStorage.removeItem(HISTORY_KEY);
  } else {
    let storedSettings = defaultSettings();
    let storedMaterials = emptyMaterials();
    let storedHistory: InterviewSession[] = [];
    let settingsHealthy = true;
    let materialsHealthy = true;
    let historyHealthy = true;
    try {
      storedSettings = settingsRows[0]?.payload ? normalizeSettings(JSON.parse(settingsRows[0].payload) as Partial<AppSettings>) : defaultSettings();
    } catch {
      settingsHealthy = false;
    }
    try {
      storedMaterials = materialsRows[0]?.payload ? normalizeMaterials(JSON.parse(materialsRows[0].payload)) : emptyMaterials();
    } catch {
      materialsHealthy = false;
    }
    try {
      storedHistory = normalizeHistory(historyRows.map((row) => JSON.parse(row.payload)));
    } catch {
      historyHealthy = false;
    }
    const recoveryTargets = [
      !settingsHealthy ? "模型与应用配置" : "",
      !materialsHealthy ? "候选人材料" : "",
      !historyHealthy ? "面试会话" : "",
    ].filter(Boolean);
    if (recoveryTargets.length) {
      const backup = await readLatestBackup(context);
      if (backup) {
        if (!settingsHealthy) storedSettings = backup.settings;
        if (!materialsHealthy) storedMaterials = backup.materials;
        if (!historyHealthy) storedHistory = backup.history;
        context.startup.recoveryPerformed = true;
        context.startup.recoveryMessage = `启动时已从最近备份恢复：${recoveryTargets.join("、")}。`;
      } else {
        context.startup.recoveryMessage = `检测到无法解析的${recoveryTargets.join("、")}，但没有可用备份；其余数据保持不变。`;
      }
    }
    const hydratedSettings = await hydrateSecrets(context, storedSettings);
    context.snapshot = { settings: hydratedSettings, materials: storedMaterials, history: storedHistory };
    if (context.startup.recoveryPerformed) {
      await writeSecrets(context, hydratedSettings);
      await upsertDocument(context, "settings", redactSettings(hydratedSettings));
      await upsertDocument(context, "materials", storedMaterials);
      await replaceHistory(context, storedHistory);
    } else if (settingsRows.length && settingsHealthy) {
      // Migrate any pre-0.2.3 custom header values into Stronghold and keep SQLite redacted.
      await writeSecrets(context, hydratedSettings);
      await upsertDocument(context, "settings", redactSettings(hydratedSettings));
    }
  }
  await upsertDocument(context, "runtime", { state: "running", startedAt });
  return context;
}

async function getTauriContext() {
  if (!isTauri()) return undefined;
  contextPromise ??= createTauriContext();
  return contextPromise;
}

export async function getStorageDiagnostics(): Promise<StorageDiagnostics> {
  if (!isTauri()) {
    return { backend: "localStorage", schemaVersion: DATA_SCHEMA_VERSION, migrationStatus: "unknown", integrity: "unknown", secretStore: "browser-not-persisted", backupCount: 0, uncleanExit: false };
  }
  try {
    const context = await getTauriContext();
    if (!context) return { backend: "localStorage", schemaVersion: DATA_SCHEMA_VERSION, migrationStatus: "unknown", integrity: "unknown", secretStore: "browser-not-persisted", backupCount: 0, uncleanExit: false };
    let schemaVersion = 0;
    let migrationStatus: StorageDiagnostics["migrationStatus"] = "unknown";
    let migrationVersion: number | undefined;
    let migrationDescription: string | undefined;
    let integrity: StorageDiagnostics["integrity"] = "unknown";
    try {
      const rows = await context.db.select<Array<{ version?: number; description?: string; success?: boolean | number }>>("SELECT version, description, success FROM _sqlx_migrations ORDER BY version DESC LIMIT 1");
      const latest = rows[0];
      schemaVersion = Number(latest?.version) || 0;
      migrationStatus = latest && latest.success !== false && latest.success !== 0
        ? schemaVersion >= DATA_SCHEMA_VERSION ? "current" : "outdated"
        : "error";
      migrationVersion = schemaVersion || undefined;
      migrationDescription = latest?.description;
    } catch {
      migrationStatus = "error";
    }
    try {
      const rows = await context.db.select<Array<{ version?: number; description?: string }>>("SELECT version, description FROM storage_migration_log ORDER BY version DESC LIMIT 1");
      migrationVersion = Number(rows[0]?.version) || undefined;
      migrationDescription = rows[0]?.description;
    } catch {
      if (migrationStatus === "current") migrationStatus = "unknown";
    }
    try {
      const rows = await context.db.select<Array<Record<string, unknown>>>("PRAGMA quick_check");
      const result = Object.values(rows[0] ?? {})[0];
      integrity = result === "ok" ? "ok" : "error";
    } catch {
      integrity = "unknown";
    }
    const backups = await context.db.select<Array<{ created_at?: string }>>("SELECT created_at FROM storage_backups ORDER BY id DESC");
    return {
      backend: "sqlite",
      schemaVersion,
      migrationStatus,
      migrationVersion,
      migrationDescription,
      integrity,
      secretStore: "stronghold",
      backupCount: backups.length,
      lastBackupAt: backups[0]?.created_at,
      uncleanExit: context.startup.uncleanExit,
      lastStartedAt: context.startup.lastStartedAt,
      lastCleanShutdownAt: context.startup.lastCleanShutdownAt,
      recoveryPerformed: context.startup.recoveryPerformed,
      recoveryMessage: context.startup.recoveryMessage,
    };
  } catch {
    return { backend: "sqlite", schemaVersion: 0, migrationStatus: "error", integrity: "error", secretStore: "stronghold", backupCount: 0, uncleanExit: false };
  }
}

export async function initializeStorage(): Promise<PersistentSnapshot> {
  const context = await getTauriContext();
  if (!context) return { settings: loadSettings(), materials: loadMaterials(), history: loadHistory() };
  return context.snapshot;
}

export async function markCleanShutdown() {
  const context = await getTauriContext();
  if (!context) return;
  await writeExternalSnapshot(context.snapshot, "clean shutdown");
  await enqueue(context, () => upsertDocument(context, "runtime", { state: "clean", startedAt: context.startup.lastStartedAt || new Date().toISOString(), cleanAt: new Date().toISOString() })).catch(() => undefined);
}

export async function restoreLatestBackup(): Promise<PersistentSnapshot | undefined> {
  if (!isTauri()) return undefined;
  const context = await getTauriContext();
  if (!context) return undefined;
  let restored: PersistentSnapshot | undefined;
  await enqueue(context, async () => {
    const backup = await readLatestBackup(context);
    if (!backup) return;
    const settings = await hydrateSecrets(context, backup.settings);
    restored = { settings, materials: backup.materials, history: backup.history };
    await persistSnapshotNow(context, restored, "restore latest backup", true);
  });
  return restored;
}

export function saveSnapshot(snapshot: PersistentSnapshot): Promise<void> {
  if (!isTauri()) {
    write(SETTINGS_KEY, redactSettings(snapshot.settings));
    write(MATERIALS_KEY, snapshot.materials);
    write(HISTORY_KEY, snapshot.history.slice(0, 50));
    return Promise.resolve();
  }
  return getTauriContext().then((context) => context ? enqueue(context, () => persistSnapshotNow(context, snapshot, "snapshot import", true)) : undefined);
}

export function saveSettings(settings: AppSettings): Promise<void> {
  if (!isTauri()) {
    // Browser previews never persist credentials; the desktop build stores them in Stronghold.
    write(SETTINGS_KEY, redactSettings(settings));
    return Promise.resolve();
  }
  return getTauriContext().then((context) => context ? enqueue(context, () => persistSettingsNow(context, settings, "settings update")) : undefined).catch(() => undefined);
}

export function saveMaterials(materials: MaterialContext): Promise<void> {
  if (!isTauri()) {
    write(MATERIALS_KEY, materials);
    return Promise.resolve();
  }
  return getTauriContext().then((context) => context ? enqueue(context, () => persistMaterialsNow(context, materials, "materials update")) : undefined).catch(() => undefined);
}

export function saveHistory(history: InterviewSession[]): Promise<void> {
  if (!isTauri()) {
    write(HISTORY_KEY, history.slice(0, 50));
    return Promise.resolve();
  }
  return getTauriContext().then((context) => context ? enqueue(context, () => persistHistoryNow(context, history, "history update")) : undefined).catch(() => undefined);
}

export function clearHistory(): Promise<void> {
  if (!isTauri()) {
    window.localStorage.removeItem(HISTORY_KEY);
    return Promise.resolve();
  }
  return getTauriContext().then((context) => context ? enqueue(context, () => persistHistoryNow(context, [], "history cleared")) : undefined).catch(() => undefined);
}
