#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  BRIDGE_FILE,
  removeBridgeFile,
  writeBridgeFile,
} from "./bridge-file.js";
import { startBridge } from "./bridge-http.js";
import {
  EXTENSION_HOME,
  defaultServeInvocation,
  helpText,
  installExtension,
  parseCli,
  setupText,
} from "./cli.js";
import { screenshotContent } from "./content.js";
import type { Bridge } from "./protocol.js";
import { Session } from "./session.js";
import { createTools } from "./tools.js";

const GRANT_HINT =
  "May return needs_permission; ask the user, then call chrome_grant_site.";

function bindFailedBridge(): Bridge {
  return {
    port: 0,
    isConnected: () => false,
    waitForConnection: async () => false,
    close: async () => undefined,
    clients: () => [],
    select: () => false,
    activeBrowserId: () => null,
    onBrowserGone: () => undefined,
    send: async () => ({
      id: "x",
      ok: false,
      error: {
        code: "bridge_bind_failed",
        message: "Ports 17352–17361 all taken.",
      },
    }),
  };
}

function textResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function packageVersion(): string {
  for (const candidate of [
    path.join(HERE, "..", "package.json"),
    path.join(HERE, "..", "..", "package.json"),
  ]) {
    try {
      return String(JSON.parse(fs.readFileSync(candidate, "utf8")).version);
    } catch {
      // try the next location
    }
  }
  return "0.0.0";
}

/** The extension ships inside the package; in a git clone it is a sibling. */
function packagedExtensionDir(): string {
  for (const candidate of [
    path.join(HERE, "..", "extension"),
    path.join(HERE, "..", "..", "extension"),
  ]) {
    if (fs.existsSync(path.join(candidate, "manifest.json"))) return candidate;
  }
  return path.join(HERE, "..", "extension");
}

async function runCli(): Promise<boolean> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.command === "serve") return false;

  if (cli.command === "version") {
    console.log(packageVersion());
    return true;
  }
  if (cli.command === "help") {
    console.log(helpText(packageVersion(), defaultServeInvocation()));
    return true;
  }
  try {
    const result = await installExtension(packagedExtensionDir(), EXTENSION_HOME);
    console.log(setupText(result, defaultServeInvocation()));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
  return true;
}

async function main(): Promise<void> {
  if (await runCli()) return;

  let bridge: Bridge;
  try {
    bridge = await startBridge();
  } catch {
    bridge = bindFailedBridge();
  }
  if (bridge.port !== 0) {
    try {
      await writeBridgeFile(BRIDGE_FILE, bridge.port);
    } catch {
      // status file is best-effort for humans / CLI smoke
    }
  }

  const session = new Session();
  const tools = createTools(session, bridge);

  const server = new McpServer({
    name: "grok-chrome",
    version: packageVersion(),
  });

  server.registerTool(
    "chrome_grant_site",
    {
      description:
        "Grants this origin for the rest of the session. Ask the user before calling.",
      inputSchema: { origin: z.string() },
    },
    async ({ origin }) => textResult(await tools.grantSite(origin)),
  );

  server.registerTool(
    "chrome_revoke_site",
    {
      description:
        "Removes an origin from the allowlist for the rest of the session.",
      inputSchema: { origin: z.string() },
    },
    async ({ origin }) => textResult(await tools.revokeSite(origin)),
  );

  server.registerTool(
    "chrome_browsers",
    {
      description:
        "Lists every connected browser (Chrome, Edge, Brave, …) and which one is active. Read-only.",
    },
    async () => textResult(await tools.browsers()),
  );

  server.registerTool(
    "chrome_select_browser",
    {
      description:
        "Points later tools at a different connected browser, by id from chrome_browsers.",
      inputSchema: { browserId: z.string() },
    },
    async ({ browserId }) => textResult(await tools.selectBrowser(browserId)),
  );

  server.registerTool(
    "chrome_tabs",
    {
      description:
        "Lists open tabs and the current Grok target tab. Read-only; no origin grant required.",
    },
    async () => textResult(await tools.tabs()),
  );

  server.registerTool(
    "chrome_new_tab",
    {
      description: `Opens a new tab and makes it the target. If url is set, ${GRANT_HINT}`,
      inputSchema: { url: z.string().optional() },
    },
    async ({ url }) => textResult(await tools.newTab(url)),
  );

  server.registerTool(
    "chrome_use_tab",
    {
      description:
        "Sets the target tab by id. Does not grant the origin. Later mutating tools still need a grant.",
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => textResult(await tools.useTab(tabId)),
  );

  server.registerTool(
    "chrome_page",
    {
      description:
        "Returns the target tab's url and title. Read-only; no origin grant required.",
    },
    async () => textResult(await tools.page()),
  );

  server.registerTool(
    "chrome_navigate",
    {
      description: `Navigates the target tab (creates one if needed). ${GRANT_HINT}`,
      inputSchema: { url: z.string() },
    },
    async ({ url }) => textResult(await tools.navigate(url)),
  );

  server.registerTool(
    "chrome_screenshot",
    {
      description:
        "Viewport PNG of the target tab. Read-only; no origin grant required.",
    },
    async () => ({ content: screenshotContent(await tools.screenshot()) }),
  );

  server.registerTool(
    "chrome_snapshot",
    {
      description:
        "Accessibility snapshot with refs (e1, e2, …) for later click/type/fill. Read-only; no origin grant required.",
    },
    async () => textResult(await tools.snapshot()),
  );

  server.registerTool(
    "chrome_click",
    {
      description: `Clicks a snapshot ref. ${GRANT_HINT}`,
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => textResult(await tools.click(ref)),
  );

  server.registerTool(
    "chrome_type",
    {
      description: `Types text, optionally into a snapshot ref. ${GRANT_HINT}`,
      inputSchema: {
        text: z.string(),
        ref: z.string().optional(),
        submit: z.boolean().optional(),
      },
    },
    async ({ text, ref, submit }) =>
      textResult(await tools.type(text, ref, submit)),
  );

  server.registerTool(
    "chrome_fill",
    {
      description: `Clears and fills a snapshot ref. ${GRANT_HINT}`,
      inputSchema: { ref: z.string(), value: z.string() },
    },
    async ({ ref, value }) => textResult(await tools.fill(ref, value)),
  );

  server.registerTool(
    "chrome_scroll",
    {
      description: `Scrolls the page or a snapshot ref. ${GRANT_HINT}`,
      inputSchema: {
        direction: z.enum(["up", "down", "left", "right"]),
        ref: z.string().optional(),
        amount: z.number().optional(),
      },
    },
    async ({ direction, ref, amount }) =>
      textResult(await tools.scroll(direction, ref, amount)),
  );

  server.registerTool(
    "chrome_close_tab",
    {
      description:
        "Closes a tab. Free for tabs Grok opened; closing one of the user's own tabs needs a grant.",
      inputSchema: { tabId: z.number().optional() },
    },
    async ({ tabId }) => textResult(await tools.closeTab(tabId)),
  );

  server.registerTool(
    "chrome_hover",
    {
      description: `Moves the pointer over a snapshot ref, firing hover handlers. ${GRANT_HINT}`,
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => textResult(await tools.hover(ref)),
  );

  server.registerTool(
    "chrome_drag",
    {
      description: `Drags one snapshot ref onto another with intermediate pointer moves. ${GRANT_HINT}`,
      inputSchema: { ref: z.string(), toRef: z.string() },
    },
    async ({ ref, toRef }) => textResult(await tools.drag(ref, toRef)),
  );

  server.registerTool(
    "chrome_press",
    {
      description: `Presses a key or combination, e.g. Enter, Tab, Escape, ArrowDown, Control+a, Meta+Shift+p. Optionally focuses a ref first. ${GRANT_HINT}`,
      inputSchema: { key: z.string(), ref: z.string().optional() },
    },
    async ({ key, ref }) => textResult(await tools.press(key, ref)),
  );

  server.registerTool(
    "chrome_select_option",
    {
      description: `Selects options in a <select> by value or visible label. ${GRANT_HINT}`,
      inputSchema: { ref: z.string(), values: z.array(z.string()) },
    },
    async ({ ref, values }) => textResult(await tools.selectOption(ref, values)),
  );

  server.registerTool(
    "chrome_upload_file",
    {
      description: `Sets absolute local file paths on a file input. Hands those files to the page, so only use paths the user named. ${GRANT_HINT}`,
      inputSchema: { ref: z.string(), paths: z.array(z.string()) },
    },
    async ({ ref, paths }) => textResult(await tools.uploadFile(ref, paths)),
  );

  server.registerTool(
    "chrome_back",
    {
      description: `Goes back one entry in the target tab's history. ${GRANT_HINT}`,
    },
    async () => textResult(await tools.back()),
  );

  server.registerTool(
    "chrome_forward",
    {
      description: `Goes forward one entry in the target tab's history. ${GRANT_HINT}`,
    },
    async () => textResult(await tools.forward()),
  );

  server.registerTool(
    "chrome_reload",
    {
      description: `Reloads the target tab and waits for load. ${GRANT_HINT}`,
    },
    async () => textResult(await tools.reload()),
  );

  server.registerTool(
    "chrome_evaluate",
    {
      description: `Runs a JavaScript expression in the page and returns its value (awaited, JSON-serialisable). Powerful: it can read and change anything on the page. ${GRANT_HINT}`,
      inputSchema: { expression: z.string() },
    },
    async ({ expression }) => textResult(await tools.evaluate(expression)),
  );

  server.registerTool(
    "chrome_resize",
    {
      description:
        "Resizes the window so the page viewport matches the requested size. No origin grant required.",
      inputSchema: { width: z.number(), height: z.number() },
    },
    async ({ width, height }) => textResult(await tools.resize(width, height)),
  );

  server.registerTool(
    "chrome_text",
    {
      description:
        "Visible text of the target tab, capped and flagged when truncated. Read-only; no origin grant required.",
      inputSchema: { maxChars: z.number().optional() },
    },
    async ({ maxChars }) => textResult(await tools.pageText(maxChars)),
  );

  server.registerTool(
    "chrome_find",
    {
      description:
        "Finds elements by visible text and/or role, returning refs from the same numbering as chrome_snapshot. Read-only; no origin grant required.",
      inputSchema: { text: z.string().optional(), role: z.string().optional() },
    },
    async ({ text, role }) => textResult(await tools.find(text, role)),
  );

  server.registerTool(
    "chrome_wait_for",
    {
      description:
        "Waits until text appears (text) or disappears (textGone) on the page. Read-only; no origin grant required.",
      inputSchema: {
        text: z.string().optional(),
        textGone: z.string().optional(),
        timeoutMs: z.number().optional(),
      },
    },
    async ({ text, textGone, timeoutMs }) =>
      textResult(await tools.waitFor({ text, textGone, timeoutMs })),
  );

  server.registerTool(
    "chrome_cursor",
    {
      description:
        "Shows or hides the shadow mouse — the on-page cursor overlay that lets the user watch what Grok clicks.",
      inputSchema: { show: z.boolean() },
    },
    async ({ show }) => textResult(await tools.cursor(show)),
  );

  server.registerTool(
    "chrome_record_start",
    {
      description:
        "Starts recording the target tab as an animated GIF. Frames are captured between actions, so the recording shows each step. Read-only; no origin grant required.",
      inputSchema: {
        fps: z.number().min(1).max(10).optional(),
        maxFrames: z.number().min(1).max(1000).optional(),
      },
    },
    async ({ fps, maxFrames }) =>
      textResult(await tools.recordStart(fps, maxFrames)),
  );

  server.registerTool(
    "chrome_record_stop",
    {
      description:
        "Stops recording and writes the GIF to an absolute path. Returns the path, frame count, and size — never the image data.",
      inputSchema: { path: z.string(), delayMs: z.number().optional() },
    },
    async ({ path, delayMs }) => textResult(await tools.recordStop(path, delayMs)),
  );

  server.registerTool(
    "chrome_batch",
    {
      description:
        "Runs a short fixed sequence of actions in one round-trip, stopping at the first failure. Each action is {tool, ...params} where tool is click, type, fill, press, hover, drag, selectOption, scroll, navigate, waitFor, or snapshot. Each action is permission-checked exactly as if called on its own.",
      inputSchema: {
        actions: z.array(z.record(z.string(), z.unknown())).min(1),
      },
    },
    async ({ actions }) => textResult(await tools.batch(actions)),
  );

  server.registerTool(
    "chrome_console",
    {
      description:
        "Recent console messages for the target tab. Read-only; no origin grant required.",
      inputSchema: {
        level: z.enum(["error", "warn", "info", "debug", "log"]).optional(),
        limit: z.number().optional(),
      },
    },
    async ({ level, limit }) =>
      textResult(await tools.consoleMessages(level, limit)),
  );

  server.registerTool(
    "chrome_network",
    {
      description:
        "Recent finished network requests for the target tab. Read-only; no origin grant required.",
      inputSchema: {
        urlContains: z.string().optional(),
        status: z.number().optional(),
        limit: z.number().optional(),
      },
    },
    async ({ urlContains, status, limit }) =>
      textResult(await tools.network(urlContains, status, limit)),
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    removeBridgeFile(BRIDGE_FILE);
    await bridge.close();
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("beforeExit", () => {
    void shutdown();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
