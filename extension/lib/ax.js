/**
 * Accessibility-tree flattening shared by the service worker and its tests.
 * chrome_snapshot and chrome_find share one numbering: e7 means the same node
 * in both, so a find result can be clicked without re-snapshotting.
 */

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textarea",
]);

const NOISE_ROLES = new Set(["generic", "none", "presentation", "InlineTextBox"]);

function axValue(field) {
  if (!field || field.value == null) return "";
  return String(field.value);
}

function propertyValue(node, name) {
  const props = Array.isArray(node.properties) ? node.properties : [];
  for (const prop of props) {
    if (prop && prop.name === name) return prop.value && prop.value.value;
  }
  return undefined;
}

function isTruthyProp(value) {
  return value === true || value === "true";
}

function entryFor(node) {
  if (!node || node.ignored) return null;
  if (node.backendDOMNodeId == null) return null;

  const role = axValue(node.role) || "generic";
  const name = axValue(node.name).trim();
  const lower = role.toLowerCase();
  const interactive = INTERACTIVE_ROLES.has(lower);
  if (!name && !interactive) return null;
  if (!name && NOISE_ROLES.has(lower)) return null;

  const entry = {
    role,
    name,
    backendNodeId: node.backendDOMNodeId,
  };
  const value = axValue(node.value);
  if (value) entry.value = value;
  if (isTruthyProp(propertyValue(node, "disabled"))) entry.disabled = true;
  if (isTruthyProp(propertyValue(node, "checked"))) entry.checked = true;
  if (isTruthyProp(propertyValue(node, "focused"))) entry.focused = true;
  if (isTruthyProp(propertyValue(node, "required"))) entry.required = true;
  return entry;
}

export function formatEntry(ref, entry) {
  let line = `[${ref}] ${entry.role}`;
  if (entry.name) line += ` "${entry.name}"`;
  if (entry.value) line += ` value="${entry.value}"`;
  const flags = [];
  if (entry.disabled) flags.push("disabled");
  if (entry.checked) flags.push("checked");
  if (entry.focused) flags.push("focused");
  if (entry.required) flags.push("required");
  if (flags.length) line += ` (${flags.join(", ")})`;
  return line;
}

/** Walks the AX tree depth-first so refs follow reading order. */
export function renderSnapshot(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map();
  for (const node of list) {
    if (node && node.nodeId != null) byId.set(String(node.nodeId), node);
  }

  const ordered = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node) return;
    const id = String(node.nodeId);
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push(node);
    for (const childId of node.childIds || []) walk(byId.get(String(childId)));
  };

  const roots = list.filter(
    (n) => n && (n.parentId == null || !byId.has(String(n.parentId))),
  );
  for (const root of roots.length ? roots : list) walk(root);
  for (const node of list) walk(node);

  const entries = [];
  const refs = {};
  const lines = [];
  for (const node of ordered) {
    const entry = entryFor(node);
    if (!entry) continue;
    const ref = "e" + (entries.length + 1);
    entry.ref = ref;
    entries.push(entry);
    refs[ref] = { backendNodeId: entry.backendNodeId };
    lines.push(formatEntry(ref, entry));
  }
  return { text: lines.join("\n"), refs, entries };
}

/** Filters a rendered snapshot without renumbering it. */
export function findMatches(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const text = query && query.text ? String(query.text).toLowerCase() : "";
  const role = query && query.role ? String(query.role).toLowerCase() : "";
  const hits = [];
  for (const entry of list) {
    if (role && entry.role.toLowerCase() !== role) continue;
    if (text) {
      const haystack = `${entry.name} ${entry.value || ""}`.toLowerCase();
      if (!haystack.includes(text)) continue;
    }
    hits.push({ ref: entry.ref, line: formatEntry(entry.ref, entry), entry });
  }
  return hits;
}
