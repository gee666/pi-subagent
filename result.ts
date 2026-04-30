/**
 * result.ts – A lightweight Result<T, E> type for explicit error handling.
 *
 * Inspired by Rust's std::result::Result.  Instead of throwing exceptions,
 * functions return either an Ok variant (success) or an Err variant (failure).
 * The caller is forced to inspect the discriminant before accessing the value,
 * making error paths visible in the type system.
 *
 * Usage examples
 * --------------
 *
 * // 1. Basic success / failure
 * const good: Result<number, string> = ok(42);
 * const bad:  Result<number, string> = err("something went wrong");
 *
 * // 2. Narrowing with the discriminant
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) return err("division by zero");
 *   return ok(a / b);
 * }
 *
 * const result = divide(10, 2);
 * if (result.ok) {
 *   console.log("Answer:", result.value);   // 5
 * } else {
 *   console.error("Error:", result.error);
 * }
 *
 * // 3. Propagating errors through a pipeline
 * function parsePort(raw: string): Result<number, string> {
 *   const n = Number(raw);
 *   if (!Number.isInteger(n) || n < 1 || n > 65535) {
 *     return err(`Invalid port: "${raw}"`);
 *   }
 *   return ok(n);
 * }
 *
 * function connect(raw: string): Result<string, string> {
 *   const portResult = parsePort(raw);
 *   if (!portResult.ok) return portResult;             // propagate
 *   return ok(`Connected on port ${portResult.value}`);
 * }
 *
 * // 4. Collecting multiple Results
 * const results = ["8080", "abc", "443"].map(parsePort);
 * const successes = results.filter((r): r is Ok<number> => r.ok).map((r) => r.value);
 * // successes → [8080, 443]
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** The success variant – carries a value of type T. */
export type Ok<T> = { readonly ok: true; readonly value: T };

/** The failure variant – carries an error of type E. */
export type Err<E> = { readonly ok: false; readonly error: E };

/**
 * A discriminated union representing either success (Ok<T>) or failure (Err<E>).
 *
 * Narrow the variant with `result.ok` before accessing `value` or `error`:
 *
 *   if (result.ok) {
 *     use(result.value);   // T is accessible here
 *   } else {
 *     handle(result.error); // E is accessible here
 *   }
 */
export type Result<T, E> = Ok<T> | Err<E>;

// ---------------------------------------------------------------------------
// Constructor helpers
// ---------------------------------------------------------------------------

/**
 * Construct a successful Result wrapping `value`.
 *
 * @example
 * const r = ok(123);          // Result<number, never>
 * const r2: Result<number, string> = ok(123);
 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/**
 * Construct a failed Result wrapping `error`.
 *
 * @example
 * const r = err("oops");      // Result<never, string>
 * const r2: Result<number, string> = err("oops");
 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}
