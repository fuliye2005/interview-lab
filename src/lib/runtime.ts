export type RuntimeEnvironmentKind = "webview2" | "tauri-webview" | "browser-preview";

export interface RuntimeEnvironment {
  kind: RuntimeEnvironmentKind;
  label: string;
  detail: string;
}

/** Tauri on Windows is rendered by WebView2; the user agent lets us surface a useful startup diagnostic. */
export function detectRuntimeEnvironment(userAgent: string, platform: string, tauriRuntime: boolean): RuntimeEnvironment {
  if (!tauriRuntime) {
    return { kind: "browser-preview", label: "浏览器预览", detail: "仅用于开发预览，不保存桌面端密钥。" };
  }
  const windows = /Windows/i.test(`${userAgent} ${platform}`);
  const edgeVersion = userAgent.match(/Edg\/([\d.]+)/i)?.[1];
  if (windows && edgeVersion) {
    return { kind: "webview2", label: `WebView2 已加载 · Edge ${edgeVersion}`, detail: "当前窗口由 Tauri + Microsoft Edge WebView2 渲染。" };
  }
  return { kind: "tauri-webview", label: "Tauri WebView 已加载", detail: "桌面运行时已加载，但未从 User-Agent 读取到 WebView2 版本。" };
}
