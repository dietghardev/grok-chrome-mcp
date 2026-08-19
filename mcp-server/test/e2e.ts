/**
 * End-to-end: real Chrome, real extension, real CDP, driven over MCP stdio.
 * Not part of `npm test` — it needs a Chrome binary and a free bridge port.
 *
 * Google Chrome stable refuses --load-extension, so there are two modes:
 *
 *   E2E_USE_CONNECTED=1 npm run e2e   drive a browser that already has the
 *                                     extension loaded (the manual pass,
 *                                     scripted). Opens one localhost tab and
 *                                     closes it again.
 *   CHROME_PATH=/path/to/chromium npm run e2e
 *                                     launch an isolated browser itself; needs
 *                                     Chromium or Chrome for Testing.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BRIDGE_HOST, PORT_END, PORT_START } from "../src/protocol.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, "..", "..");
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const cleanups: Array<() => void | Promise<void>> = [];
async function cleanup() {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      // best effort
    }
  }
}

function log(step: string) {
  console.log(`  ${step}`);
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  const block = (res.content as Array<{ type: string; text: string }>).find(
    (c) => c.type === "text",
  );
  assert.ok(block, `${name} returned no text block`);
  return JSON.parse(block.text);
}

async function main() {
  const useConnected = Boolean(process.env.E2E_USE_CONNECTED);
  if (!useConnected) {
    assert.ok(fs.existsSync(CHROME), `Chrome not found at ${CHROME}`);
  }

  // A bridge already on the range would steal the extension's connection.
  for (let p = PORT_START; p <= PORT_END; p++) {
    const busy = await fetch(`http://${BRIDGE_HOST}:${p}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    assert.ok(
      !busy,
      `Port ${p} already has a grok-chrome bridge. Quit Grok (or the other session) and retry.`,
    );
  }

  // 1. Serve the fixture.
  const fixtureDir = path.join(repo, "mcp-server", "fixture");
  const server = http.createServer((req, res) => {
    const file = path.join(fixtureDir, req.url === "/" ? "index.html" : req.url!);
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(body);
    });
  });
  await new Promise<void>((r) => server.listen(4173, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const origin = "http://127.0.0.1:4173";
  log(`fixture served at ${origin}`);

  // 2. Start the MCP server the way Grok does.
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repo, "mcp-server", "dist", "index.js")],
    }),
  );
  cleanups.push(() => client.close());
  log("mcp server connected over stdio");

  const manifest = JSON.parse(
    fs.readFileSync(path.join(repo, "extension", "manifest.json"), "utf8"),
  ) as { version: string };

  if (useConnected) {
    log("using an already-connected browser (no Chrome launched)");
    const waitMs = Number(process.env.E2E_WAIT_MS ?? 20_000);
    const deadline0 = Date.now() + waitMs;
    let target: { name: string; id: string; version: string } | undefined;
    let seen: string[] = [];
    let announced = false;
    while (Date.now() < deadline0) {
      const listed = (await callJson(client, "chrome_browsers"))
        .browsers as Array<{ name: string; id: string; version: string }>;
      seen = listed.map((b) => `${b.name} v${b.version || "?"}`);
      // Wait for the version in this working tree: an extension loaded before
      // the last edit is a different program.
      target = listed.find((b) => b.version === manifest.version);
      if (target) break;
      if (listed.length && !announced) {
        announced = true;
        log(
          `waiting for a reload — connected: ${seen.join(", ")}, need v${manifest.version}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(
      target,
      seen.length
        ? `Still no extension at v${manifest.version} (connected: ${seen.join(", ")}). Reload it at chrome://extensions.`
        : "No browser connected. Load extension/ at chrome://extensions and keep Chrome open.",
    );
    await callJson(client, "chrome_select_browser", { browserId: target.id });
    log(`driving ${target.name} v${target.version} (${target.id})`);
    return runChecks(client, origin, os.tmpdir());
  }

  // Any browser already connected belongs to the user — a Chrome they left
  // running with this extension loaded will happily attach to our bridge.
  // Note them now and never send them a command.
  await new Promise((r) => setTimeout(r, 2500));
  const preexisting = (await callJson(client, "chrome_browsers")).browsers as Array<{
    id: string;
    name: string;
  }>;
  const foreign = new Set(preexisting.map((b) => b.id));
  if (foreign.size) {
    log(
      `ignoring ${foreign.size} already-connected browser(s): ${preexisting
        .map((b) => `${b.name}/${b.id}`)
        .join(", ")}`,
    );
  }

  // 3. Launch Chrome with the unpacked extension.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "grok-e2e-"));
  const extensionDir = path.join(repo, "extension");
  const args = [
    `--user-data-dir=${profile}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "about:blank",
  ];
  if (!process.env.E2E_HEADED) args.unshift("--headless=new");
  const chrome: ChildProcess = spawn(CHROME, args, { stdio: "ignore" });
  cleanups.push(() => {
    chrome.kill("SIGKILL");
    fs.rmSync(profile, { recursive: true, force: true });
  });
  log(`chrome launched (${process.env.E2E_HEADED ? "headed" : "headless"})`);

  // 4. Wait for the browser we launched — and only that one.
  const deadline = Date.now() + 30_000;
  let mine: { name: string; id: string } | undefined;
  while (Date.now() < deadline) {
    const listed = (await callJson(client, "chrome_browsers")).browsers as Array<{
      name: string;
      id: string;
    }>;
    mine = listed.find((b) => !foreign.has(b.id));
    if (mine) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(mine, "the launched Chrome never connected to the bridge");
  const picked = await callJson(client, "chrome_select_browser", {
    browserId: mine.id,
  });
  assert.equal(picked.ok, true, JSON.stringify(picked));
  assert.notEqual(
    mine.name,
    "Unknown",
    "the launched browser never identified itself",
  );
  log(`driving the browser we launched: ${mine.name} (${mine.id})`);

  return runChecks(client, origin, profile);
}

async function runChecks(client: Client, origin: string, workDir: string) {
  // 5. Mutating without a grant must not touch Chrome.
  const denied = await callJson(client, "chrome_navigate", {
    url: `${origin}/`,
  });
  assert.equal(denied.code, "needs_permission", JSON.stringify(denied));
  assert.equal(denied.origin, origin);
  log("ungranted navigate refused with needs_permission");

  const granted = await callJson(client, "chrome_grant_site", { origin });
  assert.ok((granted.granted as string[]).includes(origin));

  const opened = await callJson(client, "chrome_new_tab", { url: `${origin}/` });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  log(`opened tab ${opened.tabId}`);

  // 6. Read the page.
  const named = (await callJson(client, "chrome_browsers"))
    .browsers as Array<{ name: string }>;
  assert.notEqual(named[0].name, "Unknown", "hello never identified the browser");
  log(`browser identified as ${named[0].name}`);

  const snap = await callJson(client, "chrome_snapshot");
  assert.equal(snap.ok, true, JSON.stringify(snap));
  assert.match(snap.text as string, /Sign in/, snap.text as string);
  log("snapshot lists the form");

  const found = await callJson(client, "chrome_find", { text: "Sign in" });
  assert.ok((found.matches as number) >= 1, JSON.stringify(found));
  const signInRef = /\[(e\d+)\]/.exec(found.text as string)?.[1];
  assert.ok(signInRef, `no ref in find output: ${found.text}`);

  const text = await callJson(client, "chrome_text");
  assert.match(text.text as string, /Grok Chrome fixture/);
  log("page text extracted");

  // 7. Fill the form and submit it.
  const emailRef = /\[(e\d+)\] textbox "Email/.exec(snap.text as string)?.[1];
  assert.ok(emailRef, "no email textbox ref in snapshot");
  const filled = await callJson(client, "chrome_fill", {
    ref: emailRef,
    value: "grok@example.com",
  });
  assert.equal(filled.ok, true, JSON.stringify(filled));

  const clicked = await callJson(client, "chrome_click", { ref: signInRef });
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  log("filled email and clicked Sign in");

  // 8. The click logs an error and reveals text after a delay.
  const waited = await callJson(client, "chrome_wait_for", {
    text: "Welcome back",
    timeoutMs: 8000,
  });
  assert.equal(waited.ok, true, JSON.stringify(waited));
  log(`wait_for saw the late text after ${waited.waitedMs}ms`);

  const console_ = await callJson(client, "chrome_console", { level: "error" });
  const messages = console_.messages as Array<{ text: string }>;
  assert.ok(
    messages.some((m) => m.text.includes("login failed")),
    `console errors: ${JSON.stringify(messages)}`,
  );
  log("console.error captured");

  const network = await callJson(client, "chrome_network", {
    urlContains: "missing-endpoint",
  });
  assert.ok(
    (network.requests as unknown[]).length >= 1,
    `network: ${JSON.stringify(network)}`,
  );
  log("failed request captured");

  // 9. Select, keyboard, evaluate.
  const snap2 = await callJson(client, "chrome_snapshot");
  const comboRef = /\[(e\d+)\] combobox/.exec(snap2.text as string)?.[1];
  assert.ok(comboRef, `no combobox in snapshot: ${snap2.text}`);
  const selected = await callJson(client, "chrome_select_option", {
    ref: comboRef,
    values: ["blue"],
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  const afterSelect = await callJson(client, "chrome_evaluate", {
    expression: "document.getElementById('chosen').textContent",
  });
  assert.equal(afterSelect.value, "chose blue", JSON.stringify(afterSelect));
  log("select_option and evaluate agree");

  const pressed = await callJson(client, "chrome_press", { key: "End" });
  assert.equal(pressed.ok, true, JSON.stringify(pressed));

  const badKey = await callJson(client, "chrome_press", { key: "Frobnicate" });
  assert.equal(badKey.code, "invalid_input", JSON.stringify(badKey));
  log("press handled a real key and rejected a bogus one");

  // 10. The shadow mouse must not pollute what the model reads.
  const textWithCursor = await callJson(client, "chrome_text");
  assert.ok(
    !(textWithCursor.text as string).includes("__grok_shadow_mouse__"),
    "cursor overlay leaked into page text",
  );
  const snapWithCursor = await callJson(client, "chrome_snapshot");
  assert.ok(
    !(snapWithCursor.text as string).includes("grok_shadow_mouse"),
    "cursor overlay leaked into the snapshot",
  );
  log("shadow mouse stays out of snapshot and text");

  // 11. Screenshot and a recorded GIF.
  const shot = await client.callTool({
    name: "chrome_screenshot",
    arguments: {},
  });
  const image = (shot.content as Array<{ type: string; data?: string }>).find(
    (c) => c.type === "image",
  );
  assert.ok(image?.data && image.data.length > 1000, "screenshot too small");
  const shotText = (shot.content as Array<{ type: string; text?: string }>).find(
    (c) => c.type === "text",
  );
  assert.ok(
    !shotText?.text?.includes(image.data.slice(0, 40)),
    "screenshot base64 leaked into the text block",
  );
  log(`screenshot ok (${Math.round(image.data.length / 1024)}kB, once)`);

  const recStart = await callJson(client, "chrome_record_start", { fps: 4 });
  assert.equal(recStart.ok, true, JSON.stringify(recStart));
  await callJson(client, "chrome_scroll", { direction: "down", amount: 3 });
  await new Promise((r) => setTimeout(r, 800));
  await callJson(client, "chrome_scroll", { direction: "up", amount: 3 });
  const gifPath = path.join(workDir, "grok-e2e-run.gif");
  const recStop = await callJson(client, "chrome_record_stop", { path: gifPath });
  assert.equal(recStop.ok, true, JSON.stringify(recStop));
  assert.ok((recStop.frames as number) >= 2, JSON.stringify(recStop));
  const gif = fs.readFileSync(gifPath);
  assert.equal(gif.subarray(0, 6).toString("ascii"), "GIF89a");
  log(
    `recorded ${recStop.frames} frames -> ${Math.round((recStop.bytes as number) / 1024)}kB gif`,
  );

  // 12. Internal pages stay off limits.
  const blocked = await callJson(client, "chrome_navigate", {
    url: "chrome://settings",
  });
  assert.equal(blocked.code, "blocked_origin", JSON.stringify(blocked));
  log("chrome:// refused");

  // 13. Closing Grok's own tab needs no grant and clears the target.
  const closed = await callJson(client, "chrome_close_tab");
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const afterClose = await callJson(client, "chrome_page");
  assert.equal(afterClose.code, "no_tab", JSON.stringify(afterClose));
  log("closed the tab and cleared the target");

  console.log("\ne2e ok");
}

main()
  .then(cleanup)
  .catch(async (err) => {
    await cleanup();
    console.error("\ne2e FAILED:", err.message);
    process.exit(1);
  });
