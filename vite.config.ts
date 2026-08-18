import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error Vite config runs in Node; the project app intentionally does not ship Node types.
import { execFileSync } from "node:child_process";
// @ts-expect-error Vite config runs in Node; the project app intentionally does not ship Node types.
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: string };
let gitCommit = "unknown";
try {
  gitCommit = String(execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" })).trim() || gitCommit;
} catch {
  // Source archives may not include a .git directory.
}
const buildInfo = {
  version: packageJson.version || "unknown",
  commit: gitCommit,
  builtAt: new Date().toISOString(),
  dataSchema: 2,
};

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    __INTERVIEW_LAB_BUILD_INFO__: JSON.stringify(buildInfo),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
