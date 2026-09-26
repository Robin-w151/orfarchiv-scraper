import { Context, Effect, Layer, Option } from 'effect';
import { TargetError } from '../shared/errors';
import { Environment } from './env';

export class Targets extends Context.Service<Targets>()('Targets', {
  make: Effect.gen(function* () {
    const environment = yield* Environment;
    return defineService({ environment });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(Environment.layer));
}

function defineService({ environment }: { environment: typeof Environment.Service }) {
  function select(label: Option.Option<string>) {
    return Effect.gen(function* () {
      const targets = yield* environment.dbTargets;
      if (targets.length === 0) {
        return yield* new TargetError({ message: 'No database targets configured.' });
      }

      if (Option.isNone(label)) {
        return targets;
      }

      const selected = targets.filter((target) => target.label === label.value);
      if (selected.length === 0) {
        const available = targets.map((target) => target.label).join(', ');
        return yield* new TargetError({
          message: `Unknown target '${label.value}'. Available targets: ${available}`,
        });
      }

      return selected;
    });
  }

  return {
    select,
  };
}
