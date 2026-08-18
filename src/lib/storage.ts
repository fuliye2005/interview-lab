import { isTauri, invoke } from "@tauri-apps/api/core";
import type { AnswerFramework, AppSettings, AsrPreset, AsrProviderConfig, InterviewFocus, InterviewSession, LlmProfile, MaterialContext, SessionRecord } from "../types";
import { createAsrPreset, createDefaultAsrConfig, createDefaultLlmProfile } from "../types";

const SETTINGS_KEY = "interview-lab.settings.v1";
const MATERIALS_KEY = "interview-lab.materials.v1";
const HISTORY_KEY = "interview-lab.history.v1";
const DATABASE_PATH = "sqlite:interview-lab.db";
const STRONGHOLD_CLIENT = "interview-lab";
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;

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

interface PersistentContext {
  db: SqlDatabase;
  store: SecretStore;
  stronghold: SecretVault;
  snapshot: PersistentSnapshot;
  secretCache: Map<string, string>;
  writeQueue: Promise<void>;
  lastBackupAt: number;
}

let contextPromise: Promise<PersistentContext> | undefined;

export const defaultSettings = (): AppSettings => ({
  asr: createDefaultAsrConfig(),
  asrProfiles: { "aliyun-trial": createDefaultAsrConfig() },
  llmProfiles: [createDefaultLlmProfile()],
  activeLlmProfileId: "",
  shortcut: "Ctrl+Shift+Space",
  shortcutEnabled: true,
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
    apiKey: typeof profile.apiKey === "string" ? profile.apiKey : "",
  };
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
    shortcutEnabled: typeof source.shortcutEnabled === "boolean" ? source.shortcutEnabled : fallback.shortcutEnabled,
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

function hasLegacyData() {
  try {
    return Boolean(window.localStorage.getItem(SETTINGS_KEY) || window.localStorage.getItem(MATERIALS_KEY) || window.localStorage.getItem(HISTORY_KEY));
  } catch {
    return false;
  }
}

function redactSettings(settings: AppSettings): AppSettings {
  const asrProfiles = Object.fromEntries(
    Object.entries(settings.asrProfiles).map(([preset, profile]) => [preset, profile ? { ...profile, apiKey: "" } : profile]),
  ) as AppSettings["asrProfiles"];
  return {
    ...settings,
    asr: { ...settings.asr, apiKey: "" },
    asrProfiles,
    llmProfiles: settings.llmProfiles.map((profile) => ({ ...profile, apiKey: "" })),
  };
}

function secretEntries(settings: AppSettings) {
  const entries: Array<{ key: string; value: string }> = settings.llmProfiles.map((profile) => ({ key: `llm:${profile.id}`, value: profile.apiKey || "" }));
  entries.push({ key: "asr:active", value: settings.asr.apiKey || "" });
  for (const [preset, profile] of Object.entries(settings.asrProfiles)) {
    if (profile) entries.push({ key: `asr:${preset}`, value: profile.apiKey || "" });
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
  const llmProfiles = await Promise.all(settings.llmProfiles.map(async (profile) => ({ ...profile, apiKey: await readSecret(context, `llm:${profile.id}`) })));
  const asrProfiles: AppSettings["asrProfiles"] = {};
  for (const [preset, profile] of Object.entries(settings.asrProfiles)) {
    if (profile) asrProfiles[preset as AsrPreset] = { ...profile, apiKey: await readSecret(context, `asr:${preset}`) };
  }
  const activeApiKey = await readSecret(context, "asr:active");
  return { ...settings, llmProfiles, asrProfiles, asr: { ...settings.asr, apiKey: activeApiKey } };
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
    [key, JSON.stringify(payload), 1, new Date().toISOString()],
  );
}

async function replaceHistory(context: PersistentContext, history: InterviewSession[]) {
  await context.db.execute("BEGIN");
  try {
    await context.db.execute("DELETE FROM interview_sessions");
    for (const session of history.slice(0, 50)) {
      await context.db.execute(
        "INSERT INTO interview_sessions (id, created_at, updated_at, title, source_session_id, carried_turn_count, asr_name, llm_name, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [session.id, session.createdAt, session.updatedAt, session.title, session.sourceSessionId ?? null, session.carriedTurnCount || 0, session.asrName, session.llmName, JSON.stringify(session)],
      );
    }
    await context.db.execute("COMMIT");
  } catch (error) {
    await context.db.execute("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function maybeCreateBackup(context: PersistentContext, reason: string) {
  if (Date.now() - context.lastBackupAt < BACKUP_INTERVAL_MS) return;
  await context.db.execute(
    "INSERT INTO storage_backups (created_at, reason, settings_payload, materials_payload, history_payload) VALUES ($1, $2, $3, $4, $5)",
    [new Date().toISOString(), reason, JSON.stringify(redactSettings(context.snapshot.settings)), JSON.stringify(context.snapshot.materials), JSON.stringify(context.snapshot.history)],
  );
  await context.db.execute("DELETE FROM storage_backups WHERE id NOT IN (SELECT id FROM storage_backups ORDER BY id DESC LIMIT 5)");
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
  const db = await Database.load(DATABASE_PATH) as unknown as SqlDatabase;
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
  };
  const settingsRows = await db.select<Array<{ payload: string }>>("SELECT payload FROM app_documents WHERE document_key = $1", ["settings"]);
  const materialsRows = await db.select<Array<{ payload: string }>>("SELECT payload FROM app_documents WHERE document_key = $1", ["materials"]);
  const historyRows = await db.select<Array<{ payload: string }>>("SELECT payload FROM interview_sessions ORDER BY updated_at DESC");
  const hasDatabaseState = settingsRows.length > 0 || materialsRows.length > 0 || historyRows.length > 0;
  if (!hasDatabaseState && hasLegacyData()) {
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
    const storedSettings = settingsRows[0]?.payload ? normalizeSettings(JSON.parse(settingsRows[0].payload) as Partial<AppSettings>) : defaultSettings();
    const storedMaterials = materialsRows[0]?.payload ? normalizeMaterials(JSON.parse(materialsRows[0].payload)) : emptyMaterials();
    const storedHistory = normalizeHistory(historyRows.map((row) => JSON.parse(row.payload)));
    context.snapshot = { settings: await hydrateSecrets(context, storedSettings), materials: storedMaterials, history: storedHistory };
  }
  return context;
}

async function getTauriContext() {
  if (!isTauri()) return undefined;
  contextPromise ??= createTauriContext();
  return contextPromise;
}

export async function initializeStorage(): Promise<PersistentSnapshot> {
  const context = await getTauriContext();
  if (!context) return { settings: loadSettings(), materials: loadMaterials(), history: loadHistory() };
  return context.snapshot;
}

export function saveSettings(settings: AppSettings): Promise<void> {
  if (!isTauri()) {
    write(SETTINGS_KEY, settings);
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
