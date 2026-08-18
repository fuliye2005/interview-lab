export interface BuildInfo {
  version: string;
  commit: string;
  builtAt: string;
  dataSchema: number;
}

export const BUILD_INFO: BuildInfo = typeof __INTERVIEW_LAB_BUILD_INFO__ === "undefined"
  ? { version: "dev", commit: "local", builtAt: "", dataSchema: 1 }
  : __INTERVIEW_LAB_BUILD_INFO__;
