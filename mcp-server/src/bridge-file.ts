import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BRIDGE_FILE = path.join(
  os.homedir(),
  ".grok",
  "chrome-bridge.json",
);

/** Debug breadcrumb for humans and the CLI smoke tool; the extension never reads it. */
export async function writeBridgeFile(
  file: string,
  port: number,
): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ port, pid: process.pid }), {
    mode: 0o600,
  });
  await fsp.chmod(file, 0o600);
}

/**
 * Only clears our own breadcrumb. A second server — a smoke run, or a second
 * Grok session — must not delete the file describing the one still running.
 */
export function removeBridgeFile(file: string): void {
  try {
    const body = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
    if (body.pid !== process.pid) return;
    fs.unlinkSync(file);
  } catch {
    // missing, unreadable, or not ours to delete
  }
}
