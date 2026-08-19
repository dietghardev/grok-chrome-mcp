import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeBridgeFile, writeBridgeFile } from "../src/bridge-file.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-bridge-"));
const file = path.join(dir, "chrome-bridge.json");

afterEach(() => {
  fs.rmSync(file, { force: true });
});

describe("bridge status file", () => {
  it("records the port and pid, readable only by the user", async () => {
    await writeBridgeFile(file, 17352);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      port: 17352,
      pid: process.pid,
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("removes the file when it still belongs to this process", async () => {
    await writeBridgeFile(file, 17352);
    removeBridgeFile(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves another process's file alone", () => {
    fs.writeFileSync(file, JSON.stringify({ port: 17352, pid: process.pid + 1 }));
    removeBridgeFile(file);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("ignores a missing or unreadable file", () => {
    expect(() => removeBridgeFile(file)).not.toThrow();
    fs.writeFileSync(file, "not json");
    expect(() => removeBridgeFile(file)).not.toThrow();
    expect(fs.existsSync(file)).toBe(true);
  });
});
