import assert from "node:assert/strict";

/** A partial host double, not a full host implementation. Unexpected API access fails immediately. */
export function hostDouble<T extends object>(members: Partial<T>): T {
  return new Proxy(members, {
    get(target, key, receiver) {
      assert.ok(key in target, `Unexpected test host access: ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  }) as T;
}
