export type ErrorCode =
  | "extension_disconnected"
  | "bridge_bind_failed"
  | "no_tab"
  | "blocked_origin"
  | "needs_permission"
  | "invalid_origin"
  | "invalid_input"
  | "stale_ref"
  | "timeout"
  | "debugger_failed";

export type ToolError = {
  ok: false;
  code: ErrorCode;
  message: string;
  origin?: string;
};

export type ToolOk<T extends object> = { ok: true } & T;
export type ToolResult<T extends object> = ToolOk<T> | ToolError;

export function fail(
  code: ErrorCode,
  message: string,
  extra?: { origin?: string },
): ToolError {
  return { ok: false, code, message, ...extra };
}
