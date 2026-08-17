import { describe, expect, it } from "vitest";
import { formatShortcut, shortcutKeyToken, toGlobalShortcut } from "./shortcut";

describe("shortcut recording helpers", () => {
  it("keeps modifiers in a stable order for simultaneous keys", () => {
    expect(formatShortcut(["Shift", "Space", "Ctrl", "Shift"])).toBe("Ctrl+Shift+Space");
  });

  it("normalizes browser key names for display", () => {
    expect(shortcutKeyToken({ key: "Control", code: "ControlLeft" })).toBe("Ctrl");
    expect(shortcutKeyToken({ key: " ", code: "Space" })).toBe("Space");
    expect(shortcutKeyToken({ key: "a", code: "KeyA" })).toBe("A");
  });

  it("converts display names to Tauri global shortcut names", () => {
    expect(toGlobalShortcut("Ctrl+Shift+Space")).toBe("Control+Shift+Space");
    expect(toGlobalShortcut("Meta+Up")).toBe("Super+ArrowUp");
  });
});
