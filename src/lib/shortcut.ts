const modifierOrder = ["Ctrl", "Alt", "Shift", "Meta"];

const keyAliases: Record<string, string> = {
  Control: "Ctrl",
  AltGraph: "AltGraph",
  Meta: "Meta",
  OS: "Meta",
  Esc: "Esc",
  Escape: "Esc",
  " ": "Space",
  Spacebar: "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

const globalAliases: Record<string, string> = {
  Ctrl: "Control",
  Meta: "Super",
  Esc: "Escape",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
};

export function shortcutKeyToken(event: Pick<KeyboardEvent, "key" | "code">) {
  if (keyAliases[event.key]) return keyAliases[event.key];
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}

export function formatShortcut(tokens: Iterable<string>) {
  const unique = [...new Set(tokens)].filter(Boolean);
  const modifiers = modifierOrder.filter((token) => unique.includes(token));
  const keys = unique.filter((token) => !modifierOrder.includes(token));
  return [...modifiers, ...keys].join("+");
}

export function toGlobalShortcut(shortcut: string) {
  return shortcut.split("+").filter(Boolean).map((token) => globalAliases[token] ?? token).join("+");
}
