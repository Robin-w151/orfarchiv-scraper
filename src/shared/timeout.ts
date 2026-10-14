import { Effect, type Duration } from 'effect';

export function withTimeout<E2>(duration: Duration.Input, onTimeout: () => E2) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(onTimeout()) }));
}
