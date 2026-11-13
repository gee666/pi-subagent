/**
 * Version of every live-runtime shape shared across a Pi reload: the process registries below
 * and the handed-off ExtensionState (extension/reload-handoff.ts). Bump it whenever one of them
 * changes shape, so a newer release never adopts runtime objects it cannot drive.
 */
export const RUNTIME_PROTOCOL = 1;

/**
 * A Pi reload re-imports this extension with a fresh module graph. Registries of live workers
 * live on globalThis instead, so the reloaded instance controls the same schedulers and brokers.
 */
export function processRegistry<T extends object>(name: string, create: () => T): T {
  const key = Symbol.for(`pi-subagent.runtime.v${RUNTIME_PROTOCOL}.${name}`);
  const existing: unknown = Reflect.get(globalThis, key);
  // Only this function writes the key, and the protocol in the key pins the value's shape.
  if (typeof existing === "object" && existing !== null) return existing as T;
  const created = create();
  Reflect.set(globalThis, key, created);
  return created;
}
