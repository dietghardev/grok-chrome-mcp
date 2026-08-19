import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Recorder } from "../src/record.js";
import type { Bridge, WsResponse } from "../src/protocol.js";
import { Session } from "../src/session.js";
import { createTools } from "../src/tools.js";
import { buildPng, solid } from "./pngbuild.js";

const RED = buildPng(6, 6, solid(6, 6, [200, 20, 20]));

describe("Recorder", () => {
  it("collects frames while recording", () => {
    const r = new Recorder();
    expect(r.isRecording()).toBe(false);
    r.start(4, 100);
    expect(r.isRecording()).toBe(true);
    r.addFrame(RED);
    r.addFrame(RED);
    expect(r.frameCount()).toBe(2);
  });

  it("ignores frames when not recording", () => {
    const r = new Recorder();
    r.addFrame(RED);
    expect(r.frameCount()).toBe(0);
  });

  it("stops collecting once the frame cap is reached", () => {
    const r = new Recorder();
    r.start(4, 3);
    for (let i = 0; i < 10; i++) r.addFrame(RED);
    expect(r.frameCount()).toBe(3);
    expect(r.hitCap()).toBe(true);
  });

  it("hands over the frames and resets on stop", () => {
    const r = new Recorder();
    r.start(4, 100);
    r.addFrame(RED);
    const frames = r.stop();
    expect(frames).toHaveLength(1);
    expect(r.isRecording()).toBe(false);
    expect(r.frameCount()).toBe(0);
  });
});

function fakeBridge(png: Buffer): Bridge {
  return {
    port: 17352,
    isConnected: () => true,
    waitForConnection: async () => true,
    close: async () => undefined,
    clients: () => [],
    select: () => false,
    activeBrowserId: () => null,
    onBrowserGone: () => undefined,
    send: async (method) => {
      if (method === "page") {
        return {
          id: "x",
          ok: true,
          result: { tabId: 7, url: "http://localhost:3000/", title: "App" },
        } satisfies WsResponse;
      }
      if (method === "screenshot") {
        return {
          id: "x",
          ok: true,
          result: { data: png.toString("base64"), width: 6, height: 6 },
        };
      }
      return { id: "x", ok: true, result: {} };
    },
  };
}

describe("recording tools", () => {
  it("writes a playable GIF and reports where it went", async () => {
    const session = new Session();
    session.targetTabId = 7;
    const tools = createTools(session, fakeBridge(RED));
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "grok-rec-")),
      "run.gif",
    );

    const started = await tools.recordStart(20);
    expect(started.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    const stopped = await tools.recordStop(out);

    expect(stopped.ok).toBe(true);
    if (stopped.ok) {
      expect(stopped.path).toBe(out);
      expect(stopped.frames).toBeGreaterThan(0);
      expect(stopped.bytes).toBeGreaterThan(0);
    }
    expect(fs.readFileSync(out).subarray(0, 6).toString("ascii")).toBe("GIF89a");
  });

  it("refuses to start twice", async () => {
    const session = new Session();
    session.targetTabId = 7;
    const tools = createTools(session, fakeBridge(RED));
    expect((await tools.recordStart(2)).ok).toBe(true);
    const again = await tools.recordStart(2);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("invalid_input");
    await tools.recordStop(
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-rec-")), "x.gif"),
    );
  });

  it("reports stopping when nothing is recording", async () => {
    const session = new Session();
    session.targetTabId = 7;
    const tools = createTools(session, fakeBridge(RED));
    const r = await tools.recordStop("/tmp/none.gif");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });

  it("rejects a relative output path", async () => {
    const session = new Session();
    session.targetTabId = 7;
    const tools = createTools(session, fakeBridge(RED));
    await tools.recordStart(2);
    const r = await tools.recordStop("relative.gif");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });
});
