/**
 * Returns a debounced version of `fn` that delays invoking it until `delay`
 * milliseconds have elapsed since the last call. All intermediate calls within
 * the quiet period are discarded and the timer resets on each new call.
 */
export function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
	let timer: ReturnType<typeof setTimeout> | undefined;

	return function (this: unknown, ...args: Parameters<T>) {
		clearTimeout(timer);
		timer = setTimeout(() => {
			fn.apply(this, args);
		}, delay);
	} as T;
}
