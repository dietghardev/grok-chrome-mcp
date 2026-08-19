import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PACKAGE_NAME = "grok-chrome-mcp";

/** Where `setup` puts the extension so Chrome can load it unpacked. */
export const EXTENSION_HOME = path.join(
  os.homedir(),
  ".grok",
  "grok-chrome-extension",
);

export type Cli =
  | { command: "serve" }
  | { command: "setup" }
  | { command: "help" }
  | { command: "version" };

export function parseCli(argv: string[]): Cli {
  const first = argv[0];
  if (first === undefined) return { command: "serve" };
  if (first === "setup" || first === "install") return { command: "setup" };
  if (first === "--version" || first === "-v") return { command: "version" };
  // Anything unrecognised prints help rather than silently starting a server
  // that would then look like it hung.
  return { command: "help" };
}

export function renderConfigBlock(): string {
  return [
    "[mcp_servers.grok-chrome]",
    'command = "npx"',
    `args = ["-y", "${PACKAGE_NAME}"]`,
    "enabled = true",
  ].join("\n");
}

export type InstallResult = { path: string; version: string };

/**
 * Copies the packaged extension to a stable path. npx caches packages in
 * directories that change between runs, and Chrome needs the unpacked folder
 * to stay put for as long as the extension is loaded.
 */
export async function installExtension(
  source: string,
  dest: string,
): Promise<InstallResult> {
  let manifest: string;
  try {
    manifest = await fsp.readFile(path.join(source, "manifest.json"), "utf8");
  } catch {
    throw new Error(
      `No extension found at ${source}. Reinstall ${PACKAGE_NAME}, or clone the repo and load its extension/ directory.`,
    );
  }

  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.cp(source, dest, { recursive: true });

  let version = "unknown";
  try {
    version = String(JSON.parse(manifest).version ?? "unknown");
  } catch {
    // a manifest we cannot parse is Chrome's problem to report, not ours
  }
  return { path: dest, version };
}

export function helpText(version: string): string {
  return `${PACKAGE_NAME} v${version} — drive your Chrome from Grok Build

Usage:
  npx ${PACKAGE_NAME}            start the MCP server (this is what Grok runs)
  npx ${PACKAGE_NAME} setup      install the Chrome extension and print next steps
  npx ${PACKAGE_NAME} --version  print the version

Add to ~/.grok/config.toml:

${renderConfigBlock()}
`;
}

export function setupText(result: InstallResult): string {
  return `Grok Chrome extension v${result.version} installed.

1. Open chrome://extensions and turn on Developer mode (top right).
2. Click "Load unpacked" and choose:

     ${result.path}

3. Add this to ~/.grok/config.toml:

${renderConfigBlock()}

4. Restart Grok. Pin the extension — it goes from "waiting for Grok" to
   "connected" once Grok starts.

Works in Edge, Brave, Opera and Vivaldi too: load the same folder there.
`;
}
