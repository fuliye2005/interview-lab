import { describe, expect, it } from "vitest";
import { detectRuntimeEnvironment } from "./runtime";

describe("detectRuntimeEnvironment", () => {
  it("identifies Windows WebView2 from the desktop user agent", () => {
    const result = detectRuntimeEnvironment("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/138.0.1.2", "Win32", true);

    expect(result.kind).toBe("webview2");
    expect(result.label).toContain("WebView2");
    expect(result.label).toContain("138.0.1.2");
  });

  it("does not claim WebView2 for a desktop runtime with an unusual user agent", () => {
    expect(detectRuntimeEnvironment("Tauri/2.0", "Linux x86_64", true).kind).toBe("tauri-webview");
  });

  it("marks Vite/browser previews separately", () => {
    expect(detectRuntimeEnvironment("Mozilla/5.0", "Win32", false)).toMatchObject({ kind: "browser-preview", label: "浏览器预览" });
  });
});
