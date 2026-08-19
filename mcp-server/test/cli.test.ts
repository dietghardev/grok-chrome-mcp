import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultServeInvocation,
  installExtension,
  parseCli,
  renderConfigBlock,
} from "../src/cli.js";

describe("parseCli", () => {
  it("runs the MCP server when given no arguments", () => {
    expect(parseCli([])).toEqual({ command: "serve" });
  });

  it("recognises the setup command", () => {
    expect(parseCli(["setup"])).toEqual({ command: "setup" });
    expect(parseCli(["install"])).toEqual({ command: "setup" });
  });

  it("recognises help and version", () => {
    expect(parseCli(["--help"]).command).toBe("help");
    expect(parseCli(["-h"]).command).toBe("help");
    expect(parseCli(["--version"]).command).toBe("version");
  });

  it("treats an unknown argument as help so nothing runs by surprise", () => {
    expect(parseCli(["--frobnicate"]).command).toBe("help");
  });
});

describe("renderConfigBlock", () => {
  it("gives the npx form people can paste into ~/.grok/config.toml", () => {
    const block = renderConfigBlock();
    expect(block).toContain("[mcp_servers.grok-chrome]");
    expect(block).toContain('command = "npx"');
    expect(block).toContain('"grok-chrome-mcp"');
  });

  it("prints a node path when setup is run from a git clone", () => {
    const block = renderConfigBlock({
      command: "node",
      args: ["/abs/path/mcp-server/dist/index.js"],
    });
    expect(block).toContain('command = "node"');
    expect(block).toContain('"/abs/path/mcp-server/dist/index.js"');
    expect(block).not.toContain("npx");
  });
});

describe("defaultServeInvocation", () => {
  it("uses node when the entry is a clone's dist/index.js", () => {
    const r = defaultServeInvocation("/tmp/grok-chrome-mcp/mcp-server/dist/index.js");
    expect(r).toEqual({
      command: "node",
      args: [path.resolve("/tmp/grok-chrome-mcp/mcp-server/dist/index.js")],
    });
  });

  it("uses npx when the entry is an npm or npx install", () => {
    expect(
      defaultServeInvocation("/tmp/node_modules/grok-chrome-mcp/dist/index.js")
        .command,
    ).toBe("npx");
    expect(defaultServeInvocation("/tmp/_npx/abc/dist/index.js").command).toBe(
      "npx",
    );
  });
});

describe("installExtension", () => {
  it("copies the extension somewhere stable and reports the path", async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "grok-src-"));
    fs.mkdirSync(path.join(source, "lib"));
    fs.writeFileSync(path.join(source, "manifest.json"), '{"version":"9.9.9"}');
    fs.writeFileSync(path.join(source, "lib", "keys.js"), "// keys");
    const dest = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "grok-dest-")),
      "extension",
    );

    const result = await installExtension(source, dest);

    expect(result.path).toBe(dest);
    expect(result.version).toBe("9.9.9");
    expect(fs.readFileSync(path.join(dest, "lib", "keys.js"), "utf8")).toBe(
      "// keys",
    );
  });

  it("replaces an older copy so a reload picks up the new version", async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "grok-src-"));
    fs.writeFileSync(path.join(source, "manifest.json"), '{"version":"2.0.0"}');
    const dest = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "grok-dest-")),
      "extension",
    );
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "stale.js"), "old");

    await installExtension(source, dest);

    expect(fs.existsSync(path.join(dest, "stale.js"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "manifest.json"))).toBe(true);
  });

  it("explains itself when the extension is missing from the package", async () => {
    const missing = path.join(os.tmpdir(), "grok-not-here-" + process.pid);
    await expect(
      installExtension(missing, path.join(os.tmpdir(), "grok-dest")),
    ).rejects.toThrow(/extension/i);
  });
});
