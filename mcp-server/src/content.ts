export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Screenshot pixels go in the image block only. Repeating the base64 in the
 * text block doubles the payload and floods the model's context.
 */
export function screenshotContent(result: unknown): McpContent[] {
  const shot = result as { ok?: boolean; data?: unknown };
  if (!shot?.ok || typeof shot.data !== "string") {
    return [{ type: "text", text: JSON.stringify(result) }];
  }
  const { data, ...rest } = shot as Record<string, unknown> & { data: string };
  return [
    { type: "text", text: JSON.stringify(rest) },
    { type: "image", data, mimeType: "image/png" },
  ];
}
