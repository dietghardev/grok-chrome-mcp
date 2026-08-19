import { fail, type ToolResult } from "./errors.js";
import { parseOrigin } from "./origins.js";

export type SnapshotRef = { backendNodeId: number };

export class Session {
  private allow = new Set<string>();
  private grokTabs = new Set<number>();
  private snapshots = new Map<number, Map<string, SnapshotRef>>();
  private tail: Promise<unknown> = Promise.resolve();
  targetTabId: number | null = null;

  grant(input: string): ToolResult<{ granted: string[] }> {
    const parsed = parseOrigin(input);
    if (!parsed.ok) return parsed;
    this.allow.add(parsed.origin);
    return { ok: true, granted: this.granted };
  }

  get granted(): string[] {
    return [...this.allow];
  }

  isGranted(origin: string): boolean {
    return this.allow.has(origin);
  }

  requireGrant(origin: string): ToolResult<Record<string, never>> {
    if (this.allow.has(origin)) return { ok: true };
    return fail(
      "needs_permission",
      `Origin ${origin} is not granted. Call chrome_grant_site after the user agrees.`,
      { origin },
    );
  }

  markGrokTab(tabId: number): void {
    this.grokTabs.add(tabId);
  }

  isGrokTab(tabId: number): boolean {
    return this.grokTabs.has(tabId);
  }

  unmarkGrokTab(tabId: number): void {
    this.grokTabs.delete(tabId);
    this.snapshots.delete(tabId);
    this.clearTargetIf(tabId);
  }

  clearTargetIf(tabId: number): void {
    if (this.targetTabId === tabId) this.targetTabId = null;
  }

  rememberSnapshot(tabId: number, refs: Map<string, SnapshotRef>): void {
    this.snapshots.set(tabId, refs);
  }

  lookupRef(tabId: number, ref: string): ToolResult<SnapshotRef> {
    const map = this.snapshots.get(tabId);
    const hit = map?.get(ref);
    if (!hit) return fail("stale_ref", `Ref ${ref} is not from the latest snapshot`);
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
