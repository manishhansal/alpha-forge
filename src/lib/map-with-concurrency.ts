/**
 * Map an array through an async function with a fixed concurrency cap.
 *
 * Use when fanning out to a third-party API that rate-limits — `Promise.all`
 * on a 170-element array will fire all 170 requests at once, which is great
 * for low-latency providers but a recipe for 429s on Yahoo / NSE / etc.
 *
 * - Results come back in the **original input order**, regardless of which
 *   task settles first.
 * - Errors are handled per-item: pass `onError` to translate a thrown error
 *   into a fallback value (e.g. an empty array). Without `onError` the first
 *   rejection is re-thrown.
 */
export interface MapWithConcurrencyOptions<T> {
  /**
   * Called when a task throws. Return value is substituted for the failing
   * item. When omitted, errors are re-thrown.
   */
  onError?: (err: unknown, item: T, index: number) => unknown;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  opts?: MapWithConcurrencyOptions<T>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.min(concurrency | 0, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const item = items[idx];
      try {
        results[idx] = await fn(item, idx);
      } catch (err) {
        if (opts?.onError) {
          results[idx] = opts.onError(err, item, idx) as R;
        } else {
          throw err;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}
