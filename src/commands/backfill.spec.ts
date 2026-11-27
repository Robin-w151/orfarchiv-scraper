import { Cron, Effect, Fiber, Layer, Logger } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';
import { DatabaseError } from '../shared/errors';
import { backfillOnSchedule } from './backfill';

describe('backfillOnSchedule', () => {
  it('runs on every cron tick and keeps running after a failed run', async () => {
    const runs: Array<number> = [];
    const logs: Array<string> = [];
    const backfill = Effect.gen(function* () {
      runs.push(runs.length + 1);
      if (runs.length === 1) {
        return yield* new DatabaseError({
          message: 'Failed to backfill embeddings on any database target.',
          cause: undefined,
        });
      }
    });

    await Effect.gen(function* () {
      const fiber = yield* backfillOnSchedule(backfill, Cron.parseUnsafe('0 0 * * * *')).pipe(Effect.forkChild);
      yield* TestClock.adjust('30 minutes');
      expect(runs).toEqual([]);
      yield* TestClock.adjust('3 hours');
      yield* Fiber.interrupt(fiber);
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          Logger.layer([
            Logger.make(({ message }) => {
              logs.push(Array.isArray(message) ? message.join(' ') : String(message));
            }),
          ]),
        ),
      ),
      Effect.runPromise,
    );

    expect(runs).toEqual([1, 2, 3]);
    expect(logs.join('\n')).toContain('Failed to backfill embeddings on any database target.');
  });
});
