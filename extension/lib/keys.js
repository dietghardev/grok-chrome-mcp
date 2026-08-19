/**
 * Keyboard mapping shared by the service worker and its tests.
 * CDP wants a virtual key code and a DOM code for every key; printable keys
 * additionally carry the text they insert.
 */

const MODIFIER_BITS = { alt: 1, control: 2, meta: 4, shift: 8 };

const MODIFIER_ALIASES = {
  alt: "alt",
  option: "alt",
  control: "control",
  ctrl: "control",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  shift: "shift",
};

const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  insert: { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 },
};

for (let n = 1; n <= 12; n++) {
  NAMED_KEYS["f" + n] = {
    key: "F" + n,
    code: "F" + n,
    windowsVirtualKeyCode: 111 + n,
  };
}

const PUNCTUATION = {
  "-": { code: "Minus", vk: 189 },
  "=": { code: "Equal", vk: 187 },
  "[": { code: "BracketLeft", vk: 219 },
  "]": { code: "BracketRight", vk: 221 },
  "\\": { code: "Backslash", vk: 220 },
  ";": { code: "Semicolon", vk: 186 },
  "'": { code: "Quote", vk: 222 },
  ",": { code: "Comma", vk: 188 },
  ".": { code: "Period", vk: 190 },
  "/": { code: "Slash", vk: 191 },
  "`": { code: "Backquote", vk: 192 },
  " ": { code: "Space", vk: 32 },
};

function printableKey(ch) {
  if (/^[a-z]$/.test(ch)) {
    return {
      key: ch,
      code: "Key" + ch.toUpperCase(),
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
      text: ch,
    };
  }
  if (/^[A-Z]$/.test(ch)) {
    return {
      key: ch,
      code: "Key" + ch,
      windowsVirtualKeyCode: ch.charCodeAt(0),
      text: ch,
      shifted: true,
    };
  }
  if (/^[0-9]$/.test(ch)) {
    return {
      key: ch,
      code: "Digit" + ch,
      windowsVirtualKeyCode: ch.charCodeAt(0),
      text: ch,
    };
  }
  const punct = PUNCTUATION[ch];
  if (punct) {
    return {
      key: ch,
      code: punct.code,
      windowsVirtualKeyCode: punct.vk,
      text: ch,
    };
  }
  return null;
}

/**
 * Parses "Control+Shift+K" style input into CDP key event fields.
 * Returns null for anything unrecognised so callers can report a clean error.
 */
export function parseKey(input) {
  if (typeof input !== "string" || input === "") return null;

  const parts = input.split("+");
  // A trailing "+" means the plus sign itself is the key ("Control++").
  let rawKey = parts.pop();
  if (rawKey === "" && parts.length > 0) rawKey = "+";
  if (rawKey === "") return null;

  let modifiers = 0;
  for (const part of parts) {
    const name = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (!name) return null;
    modifiers |= MODIFIER_BITS[name];
  }

  const named = NAMED_KEYS[rawKey.toLowerCase()];
  const base = named
    ? { ...named }
    : rawKey.length === 1
      ? printableKey(rawKey)
      : null;
  if (!base) return null;

  if (base.shifted) {
    modifiers |= MODIFIER_BITS.shift;
    delete base.shifted;
  }

  const result = {
    key: base.key,
    code: base.code,
    windowsVirtualKeyCode: base.windowsVirtualKeyCode,
    modifiers,
  };
  // Text insertion only happens when no command modifier is held; otherwise
  // Control+A would type an "a" as well as selecting everything.
  const commandHeld =
    (modifiers & MODIFIER_BITS.control) !== 0 ||
    (modifiers & MODIFIER_BITS.meta) !== 0 ||
    (modifiers & MODIFIER_BITS.alt) !== 0;
  if (base.text !== undefined && !commandHeld) result.text = base.text;
  return result;
}

export const KEY_MODIFIER_BITS = MODIFIER_BITS;
