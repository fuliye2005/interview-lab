import type { AppSettings, LlmProfile, MaterialContext, SessionRecord } from "../types";
import { createAsrPreset, createDefaultAsrConfig, createDefaultLlmProfile } from "../types";

const SETTINGS_KEY = "interview-lab.settings.v1";
const MATERIALS_KEY = "interview-lab.materials.v1";
const HISTORY_KEY = "interview-lab.history.v1";

export const defaultSettings = (): AppSettings => ({
  asr: createDefaultAsrConfig(),
  asrProfiles: { "aliyun-trial": createDefaultAsrConfig() },
  llmProfiles: [createDefaultLlmProfile()],
  activeLlmProfileId: "",
  shortcut: "Ctrl+Shift+Space",
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
  return {
    ...defaults,
    ...profile,
    id: profile.id || defaults.id,
    name: profile.name || defaults.name,
    answerDetail: profile.answerDetail === "concise" || profile.answerDetail === "detailed" || profile.answerDetail === "balanced" ? profile.answerDetail : defaults.answerDetail,
    reasoningEffort: profile.reasoningEffort === "low" || profile.reasoningEffort === "medium" || profile.reasoningEffort === "high" || profile.reasoningEffort === "none" ? profile.reasoningEffort : defaults.reasoningEffort,
  };
}

export function loadSettings(): AppSettings {
  const stored = read<Partial<AppSettings> | null>(SETTINGS_KEY, defaultSettings()) ?? {};
  const fallback = defaultSettings();
  const llmProfiles = Array.isArray(stored.llmProfiles) && stored.llmProfiles.length
    ? stored.llmProfiles.map((profile) => normalizeLlmProfile(profile))
    : fallback.llmProfiles;
  const activeAsr = {
    ...(stored.asr?.preset ? createAsrPreset(stored.asr.preset) : fallback.asr),
    ...(stored.asr ?? {}),
    protocol: stored.asr?.protocol ?? (stored.asr?.wsUrl ? "generic" : fallback.asr.protocol),
  };
  const asrProfiles = Object.fromEntries(
    Object.entries(stored.asrProfiles ?? {}).map(([preset, profile]) => [preset, {
      ...createAsrPreset(preset as keyof typeof stored.asrProfiles),
      ...profile,
    }]),
  ) as Partial<Record<keyof typeof fallback.asrProfiles, typeof activeAsr>>;
  const activePreset = activeAsr.preset ?? "generic";
  const settings: AppSettings = {
    ...fallback,
    ...stored,
    asr: activeAsr,
    asrProfiles: { ...fallback.asrProfiles, ...asrProfiles, [activePreset]: activeAsr },
    llmProfiles,
  };
  if (!settings.llmProfiles.some((profile) => profile.id === settings.activeLlmProfileId)) {
    settings.activeLlmProfileId = settings.llmProfiles[0]?.id || "";
  }
  return settings;
}

export const saveSettings = (settings: AppSettings) => write(SETTINGS_KEY, settings);
export const loadMaterials = () => read(MATERIALS_KEY, emptyMaterials());
export const saveMaterials = (materials: MaterialContext) => write(MATERIALS_KEY, materials);
export const loadHistory = () => read<SessionRecord[]>(HISTORY_KEY, []);

export function saveHistory(history: SessionRecord[]) {
  write(HISTORY_KEY, history.slice(0, 100));
}

export function clearHistory() {
  window.localStorage.removeItem(HISTORY_KEY);
}
