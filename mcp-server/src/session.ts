import { fail, type ToolError, type ToolResult } from "./errors.js";
import { parseOrigin } from "./origins.js";

export type SnapshotRef = { backendNodeId: number };

export const DEFAULT_BROWSER_ID = "default";

/**
 * Tab bookkeeping is per browser: tab ids from Chrome mean nothing in Edge,
 * and a snapshot ref only makes sense against the tab it was taken from.
 * Granted origins are deliberately shared — the grant is the user's decision
 * about a site, not about a browser.
 */
type TabState = {
  targetTabId: number | null;
  grokTabs: Set<number>;
  snapshots: Map<number, Map<string, SnapshotRef>>;
};

function emptyTabState(): TabState {
  return { targetTabId: null, grokTabs: new Set(), snapshots: new Map() };
}

export class Session {
  private allow = new Set<string>();
  private scopes = new Map<string, TabState>();
  private tail: Promise<unknown> = Promise.resolve();
  activeBrowserId: string = DEFAULT_BROWSER_ID;

  private scope(browserId = this.activeBrowserId): TabState {
    let state = this.scopes.get(browserId);
    if (!state) {
      state = emptyTabState();
      this.scopes.set(browserId, state);
    }
    return state;
  }

  get targetTabId(): number | null {
    return this.scope().targetTabId;
  }

  set targetTabId(value: number | null) {
    this.scope().targetTabId = value;
  }

  grant(input: string): ToolResult<{ granted: string[] }> {
    const parsed = parseOrigin(input);
    if (!parsed.ok) return parsed;
    this.allow.add(parsed.origin);
    return { ok: true, granted: this.granted };
  }

  revoke(input: string): ToolResult<{ granted: string[] }> {
    const parsed = parseOrigin(input);
    if (!parsed.ok) return parsed;
    this.allow.delete(parsed.origin);
    return { ok: true, granted: this.granted };
  }

  get granted(): string[] {
    return [...this.allow];
  }

  isGranted(origin: string): boolean {
    return this.allow.has(origin);
  }

  requireGrant(origin: string): { ok: true } | ToolError {
    if (this.allow.has(origin)) return { ok: true };
    return fail(
      "needs_permission",
      `Origin ${origin} is not granted. Call chrome_grant_site after the user agrees.`,
      { origin },
    );
  }

  markGrokTab(tabId: number): void {
    this.scope().grokTabs.add(tabId);
  }

  isGrokTab(tabId: number): boolean {
    return this.scope().grokTabs.has(tabId);
  }

  unmarkGrokTab(tabId: number): void {
    const state = this.scope();
    state.grokTabs.delete(tabId);
    state.snapshots.delete(tabId);
    this.clearTargetIf(tabId);
  }

  clearTargetIf(tabId: number): void {
    const state = this.scope();
    if (state.targetTabId === tabId) state.targetTabId = null;
  }

  /** Drops every tab id and ref for a browser that went away. */
  forgetBrowser(browserId: string): void {
    this.scopes.delete(browserId);
  }

  rememberSnapshot(tabId: number, refs: Map<string, SnapshotRef>): void {
    this.scope().snapshots.set(tabId, refs);
  }

  lookupRef(tabId: number, ref: string): ToolResult<SnapshotRef> {
    const map = this.scope().snapshots.get(tabId);
    const hit = map?.get(ref);
    if (!hit) {
      return fail(
        "stale_ref",
        `Ref ${ref} is not from the latest snapshot. Take a new chrome_snapshot.`,
      );
    }
    return { ok: true, ...hit };
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
