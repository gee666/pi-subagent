/**
 * Shared constants and utilities used by both runner.ts and runner-sdk.ts.
 *
 * Single source of truth for parallel-execution defaults and the small helpers
 * that both runners need. Change a value here and it propagates everywhere.
 */

// ---------------------------------------------------------------------------
// Parallel execution limits
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_PARALLEL_TASKS = 16;
export const DEFAULT_MAX_CONCURRENCY = 8;
export const PARALLEL_HEARTBEAT_MS = 1000;
export const SUBAGENT_MAX_PARALLEL_TASKS_ENV = "PI_SUBAGENT_MAX_PARALLEL_TASKS";
export const SUBAGENT_MAX_CONCURRENCY_ENV = "PI_SUBAGENT_MAX_CONCURRENCY";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Parse a string into a non-negative safe integer, or null on failure. */
export function parseNonNegativeInt(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Map over items with a bounded number of concurrent async workers.
 * Order of results matches order of input regardless of completion order.
 */
export async function mapConcurrent<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const worker = async () => {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: limit }, () => worker()));
	return results;
}
