/**
 * Browser identity, kept injectable so it can be tested outside Chrome.
 * Identification must never be able to fail: an unknown browser still has to
 * announce itself, or the MCP server cannot scope tab state to it.
 */

export const BROWSER_ID_KEY = "grokBrowserId";

export async function detectBrowserName(nav) {
  const navigatorLike = nav || {};
  try {
    // Brave reports itself as Chrome in the brand list, so ask it directly.
    if (navigatorLike.brave && (await navigatorLike.brave.isBrave())) {
      return "Brave";
    }
  } catch {
    // not Brave, or the check is unavailable
  }
  const brands =
    (navigatorLike.userAgentData && navigatorLike.userAgentData.brands) || [];
  const names = brands.map((b) => String((b && b.brand) || ""));
  const match = (re) => names.some((n) => re.test(n));
  if (match(/Edge/i)) return "Edge";
  if (match(/Opera|OPR/i)) return "Opera";
  if (match(/Vivaldi/i)) return "Vivaldi";
  if (match(/Google Chrome/i)) return "Chrome";
  if (match(/Chromium/i)) return "Chromium";
  return "Chrome";
}

/**
 * A stable id per browser install so the server keeps this browser's target
 * tab across service-worker restarts and extension reloads.
 */
export async function stableBrowserId(storage) {
  try {
    const stored = await storage.get(BROWSER_ID_KEY);
    const existing = stored && stored[BROWSER_ID_KEY];
    if (typeof existing === "string" && existing) return existing;
    const fresh = crypto.randomUUID();
    await storage.set({ [BROWSER_ID_KEY]: fresh });
    return fresh;
  } catch {
    // Storage is best-effort; an ephemeral id still identifies this worker.
    return crypto.randomUUID();
  }
}
