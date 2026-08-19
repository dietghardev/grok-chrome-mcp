import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { startBridge } from "./bridge-http.js";
import { screenshotContent } from "./content.js";
import type { Bridge } from "./protocol.js";
import { Session } from "./session.js";
import { createTools } from "./tools.js";

const GRANT_HINT =
  "May return needs_permission; ask the user, then call chrome_grant_site.";

const BRIDGE_DIR = path.join(os.homedir(), ".grok");
const BRIDGE_FILE = path.join(BRIDGE_DIR, "chrome-bridge.json");

function bindFailedBridge(): Bridge {
  return {
    port: 0,
    isConnected: () => false,
    waitForConnection: async () => false,
    close: async () => undefined,
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

async function writeBridgeFile(port: number): Promise<void> {
  await fsp.mkdir(BRIDGE_DIR, { recursive: true });
  const body = JSON.stringify({ port, pid: process.pid });
  await fsp.writeFile(BRIDGE_FILE, body, { mode: 0o600 });
  await fsp.chmod(BRIDGE_FILE, 0o600);
}

function removeBridgeFile(): void {
  try {
    fs.unlinkSync(BRIDGE_FILE);
  } catch {
    // already gone
  }
}

async function main(): Promise<void> {
  let bridge: Bridge;
  try {
    bridge = await startBridge();
  } catch {
    bridge = bindFailedBridge();
  }
  if (bridge.port !== 0) {
    try {
      await writeBridgeFile(bridge.port);
    } catch {
      // status file is best-effort for humans / CLI smoke
    }
  }

  const session = new Session();
  const tools = createTools(session, bridge);

  const server = new McpServer({
    name: "grok-chrome",
    version: "0.1.0",
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
    removeBridgeFile();
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
