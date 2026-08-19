import { describe, expect, it } from "vitest";
import { findMatches, renderSnapshot } from "../../extension/lib/ax.js";

type Prop = { name: string; value: { value: unknown } };
function node(
  id: number,
  role: string,
  name: string,
  extra: {
    backendDOMNodeId?: number;
    childIds?: string[];
    parentId?: string;
    value?: string;
    properties?: Prop[];
    ignored?: boolean;
  } = {},
) {
  return {
    nodeId: String(id),
    ignored: extra.ignored ?? false,
    role: { value: role },
    name: { value: name },
    value: extra.value === undefined ? undefined : { value: extra.value },
    properties: extra.properties ?? [],
    childIds: extra.childIds ?? [],
    parentId: extra.parentId,
    backendDOMNodeId: extra.backendDOMNodeId ?? id * 10,
  };
}

describe("renderSnapshot", () => {
  it("numbers refs in tree order and maps them to backend node ids", () => {
    const { text, refs } = renderSnapshot([
      node(1, "RootWebArea", "Login", { childIds: ["2", "3"] }),
      node(2, "heading", "Sign in", { parentId: "1" }),
      node(3, "button", "Go", { parentId: "1" }),
    ]);
    expect(text.split("\n")).toEqual([
      '[e1] RootWebArea "Login"',
      '[e2] heading "Sign in"',
      '[e3] button "Go"',
    ]);
    expect(refs.e3).toEqual({ backendNodeId: 30 });
  });

  it("shows the current value of a text field", () => {
    const { text } = renderSnapshot([
      node(1, "textbox", "Email", { value: "a@b.com" }),
    ]);
    expect(text).toBe('[e1] textbox "Email" value="a@b.com"');
  });

  it("marks disabled and checked state", () => {
    const { text } = renderSnapshot([
      node(1, "button", "Save", {
        properties: [{ name: "disabled", value: { value: true } }],
      }),
      node(2, "checkbox", "Remember me", {
        properties: [{ name: "checked", value: { value: "true" } }],
      }),
    ]);
    expect(text).toContain('[e1] button "Save" (disabled)');
    expect(text).toContain('[e2] checkbox "Remember me" (checked)');
  });

  it("skips ignored nodes and unnamed generic containers", () => {
    const { text } = renderSnapshot([
      node(1, "generic", "", { childIds: ["2", "3"] }),
      node(2, "StaticText", "hello", { parentId: "1" }),
      node(3, "button", "", { parentId: "1", ignored: true }),
    ]);
    expect(text).toBe('[e1] StaticText "hello"');
  });

  it("keeps an unnamed interactive control so it can still be clicked", () => {
    const { text } = renderSnapshot([node(1, "textbox", "")]);
    expect(text).toBe("[e1] textbox");
  });

  it("drops nodes with no backing DOM node", () => {
    const orphan = node(1, "button", "Ghost");
    delete (orphan as { backendDOMNodeId?: number }).backendDOMNodeId;
    expect(renderSnapshot([orphan]).text).toBe("");
  });
});

describe("findMatches", () => {
  const tree = [
    node(1, "button", "Sign in"),
    node(2, "link", "Sign up"),
    node(3, "textbox", "Email address"),
  ];

  it("matches on name text without regard to case", () => {
    const { entries } = renderSnapshot(tree);
    const hits = findMatches(entries, { text: "sign" });
    expect(hits.map((h) => h.ref)).toEqual(["e1", "e2"]);
  });

  it("keeps the ref numbers from the full snapshot", () => {
    const { entries } = renderSnapshot(tree);
    const hits = findMatches(entries, { text: "email" });
    expect(hits[0].ref).toBe("e3");
    expect(hits[0].line).toBe('[e3] textbox "Email address"');
  });

  it("filters by role as well as text", () => {
    const { entries } = renderSnapshot(tree);
    expect(findMatches(entries, { text: "sign", role: "link" })).toHaveLength(1);
    expect(findMatches(entries, { role: "textbox" })[0].ref).toBe("e3");
  });

  it("returns nothing when the query matches no node", () => {
    const { entries } = renderSnapshot(tree);
    expect(findMatches(entries, { text: "checkout" })).toEqual([]);
  });
});
