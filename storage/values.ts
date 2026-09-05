/** Narrow decoded JSON and caught filesystem errors before reading fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sanitizePathComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}
