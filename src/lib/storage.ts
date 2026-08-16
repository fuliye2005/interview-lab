import type { AppSettings, MaterialContext, SessionRecord } from "../types";
import { createDefaultAsrConfig, createDefaultLlmProfile } from "../types";

const SETTINGS_KEY = "interview-lab.settings.v1";
const MATERIALS_KEY = "interview-lab.materials.v1";
const HISTORY_KEY = "interview-lab.history.v1";

export const defaultSettings = (): AppSettings => ({
  asr: createDefaultAsrConfig(),
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

export function loadSettings(): AppSettings {
  const settings = read(SETTINGS_KEY, defaultSettings());
  if (!settings.activeLlmProfileId && settings.llmProfiles[0]) {
    settings.activeLlmProfileId = settings.llmProfiles[0].id;
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
