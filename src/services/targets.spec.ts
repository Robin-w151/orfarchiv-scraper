import { ConfigProvider, Effect, Exit, Layer, Logger, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { Environment } from './env';
import { Targets } from './targets';

function select(env: Record<string, string>, label: Option.Option<string>, logs: Array<string> = []) {
  return Effect.gen(function* () {
    const targets = yield* Targets;
    yield* targets.select(Option.none());
    return yield* targets.select(label);
  }).pipe(
    Effect.provide(Targets.layerWithoutDependencies.pipe(Layer.provide(Environment.layer))),
    Effect.provide(
      Logger.layer([
        Logger.make(({ message }) => logs.push(Array.isArray(message) ? message.join(' ') : String(message))),
      ]),
    ),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    Effect.exit,
    Effect.runPromise,
  );
}

const urls = {
  ORFARCHIV_DB_URLS: 'mongodb://user:pw@a:27017/\nmongodb://user:pw@b:27017/',
  ORFARCHIV_DB_URL: 'mongodb://fallback/',
};

describe('Targets', () => {
  it('selects every target without a label', async () => {
    const exit = await select(urls, Option.none());
    expect(Exit.isSuccess(exit) && exit.value.map((target) => target.label)).toEqual(['a:27017', 'b:27017']);
  });

  it('selects the target matching the label', async () => {
    const exit = await select(urls, Option.some('b:27017'));
    expect(Exit.isSuccess(exit) && exit.value.map((target) => target.url)).toEqual(['mongodb://user:pw@b:27017/']);
  });

  it('fails for an unknown label and lists the available ones', async () => {
    const exit = await select(urls, Option.some('nope'));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("Unknown target 'nope'. Available targets: a:27017, b:27017");
  });

  it('falls back to ORFARCHIV_DB_URL when ORFARCHIV_DB_URLS is unset', async () => {
    const exit = await select({ ORFARCHIV_DB_URL: 'mongodb://fallback/' }, Option.none());
    expect(Exit.isSuccess(exit) && exit.value).toEqual([
      { url: 'mongodb://fallback/', label: 'fallback', content: true },
    ]);
  });

  it('defaults to localhost when nothing is configured', async () => {
    const exit = await select({}, Option.none());
    expect(Exit.isSuccess(exit) && exit.value).toEqual([
      { url: 'mongodb://localhost', label: 'localhost', content: true },
    ]);
  });

  it('marks the targets excluded from content embeddings', async () => {
    const exit = await select({ ...urls, ORFARCHIV_CONTENT_EMBEDDING_EXCLUDED_TARGETS: 'b:27017' }, Option.none());
    expect(Exit.isSuccess(exit) && exit.value.map(({ label, content }) => [label, content])).toEqual([
      ['a:27017', true],
      ['b:27017', false],
    ]);
  });

  it('warns once about an excluded label that matches no target', async () => {
    const logs: Array<string> = [];
    const exit = await select(
      { ...urls, ORFARCHIV_CONTENT_EMBEDDING_EXCLUDED_TARGETS: 'typo.mongodb.net' },
      Option.none(),
      logs,
    );
    expect(Exit.isSuccess(exit) && exit.value.every((target) => target.content)).toBe(true);
    expect(logs).toEqual([
      "ORFARCHIV_CONTENT_EMBEDDING_EXCLUDED_TARGETS: 'typo.mongodb.net' matches no configured target.",
    ]);
  });
});
