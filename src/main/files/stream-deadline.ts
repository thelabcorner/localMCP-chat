/** Bounded async-iterator wrapper for remote response streams. No buffering beyond one source chunk. */
import { Readable } from 'node:stream';

export interface StreamDeadlineOptions {
  idleMs: number;
  totalMs: number;
  timeoutError: () => Error;
}

export function withStreamDeadline(source: Readable, options: StreamDeadlineOptions): Readable {
  const { idleMs, totalMs, timeoutError } = options;
  if (!Number.isSafeInteger(idleMs) || idleMs <= 0 || !Number.isSafeInteger(totalMs) || totalMs <= 0) {
    throw new Error('Stream deadlines must be positive integers.');
  }
  const deadline = Date.now() + totalMs;

  async function* timed(): AsyncGenerator<unknown> {
    const iterator = source[Symbol.asyncIterator]();
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timeoutError();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(timeoutError()), Math.min(idleMs, remaining));
          timer.unref?.();
        });
        let next: IteratorResult<unknown>;
        try { next = await Promise.race([iterator.next(), timeout]); }
        finally { if (timer) clearTimeout(timer); }
        if (next.done) return;
        yield next.value;
      }
    } finally {
      source.destroy();
      await iterator.return?.().catch(() => undefined);
    }
  }

  return Readable.from(timed());
}
