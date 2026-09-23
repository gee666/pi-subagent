import assert from "node:assert/strict";
import type { JsonValue } from "@earendil-works/pi-ai";

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

export function serializedDetails(value: unknown): JsonValue {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  assert.ok(isJsonValue(parsed));
  return parsed;
}
