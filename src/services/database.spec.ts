import { Effect, Exit, Layer, Logger } from 'effect';
import { Binary } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTENT_EMBEDDING_FIELD,
  CONTENT_STATUS,
  CONTENT_STATUS_FIELD,
  TITLE_EMBEDDING_FIELD,
} from '#common/search/search.constants';
import { parseTargets, withContentExclusions } from '#common/targets/targets';
import { redactedLogFmt } from '../shared/logger';
import type { Story } from '../shared/model';
import { buildStoryUpdate, Database } from './database';
import { Embedding } from './embedding';

type FakeDocument = Record<string, unknown> & { id: string; title: string };

interface FakeServer {
  readonly documents: Map<string, FakeDocument>;
  failOn?: 'connect' | 'find' | 'write';
  insertedConcurrently?: Array<FakeDocument>;
  opened: number;
  closed: number;
  lastFind?: { filter: Record<string, unknown>; options: Record<string, unknown> | undefined };
  lastCount?: Record<string, unknown>;
}

const servers = vi.hoisted(() => new Map<string, FakeServer>());

vi.mock('mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongodb')>();

  function makeCollection(server: FakeServer) {
    const failIf = (operation: FakeServer['failOn']) => {
      if (server.failOn === operation) {
        throw new Error(`${operation} failed`);
      }
    };

    return {
      find: (filter: Record<string, any>, options?: { limit?: number }) => ({
        toArray: async () => {
          server.lastFind = { filter, options };
          failIf('find');
          const documents = [...server.documents.values()];
          if (CONTENT_STATUS_FIELD in filter) {
            return contentBacklog(documents, filter)
              .sort((a, b) => (b.timestamp as Date).getTime() - (a.timestamp as Date).getTime())
              .slice(0, options?.limit)
              .map(({ id, title, url }) => ({ id, title, url }));
          }
          if (filter.id) {
            return documents.filter((document) => filter.id.$in.includes(document.id));
          }
          return documents
            .filter((document) => !(TITLE_EMBEDDING_FIELD in document) && document.title > '')
            .slice(0, options?.limit);
        },
      }),
      countDocuments: async (filter: Record<string, any>) => {
        server.lastCount = filter;
        failIf('find');
        return contentBacklog([...server.documents.values()], filter).length;
      },
      insertMany: async (documents: Array<FakeDocument>, options?: { ordered?: boolean }) => {
        failIf('write');
        server.insertedConcurrently?.forEach((document) => server.documents.set(document.id, { ...document }));
        const writeErrors: Array<{ index: number; code: number; errmsg: string }> = [];
        for (const [index, document] of documents.entries()) {
          if (server.documents.has(document.id)) {
            writeErrors.push({ index, code: 11000, errmsg: 'E11000 duplicate key error' });
            if (options?.ordered === false) {
              continue;
            }
            break;
          }
          server.documents.set(document.id, { ...document });
        }
        if (writeErrors.length > 0) {
          throw new actual.MongoBulkWriteError(
            { message: 'E11000 duplicate key error', code: 11000, writeErrors: writeErrors as never },
            {} as never,
          );
        }
      },
      bulkWrite: async (operations: Array<{ updateOne: { filter: { id: string }; update: Record<string, any> } }>) => {
        failIf('write');
        for (const { updateOne } of operations) {
          const document = { ...server.documents.get(updateOne.filter.id)!, ...updateOne.update.$set };
          Object.keys(updateOne.update.$unset ?? {}).forEach((key) => delete document[key]);
          server.documents.set(updateOne.filter.id, document);
        }
      },
    };
  }

  function contentBacklog(documents: Array<FakeDocument>, filter: Record<string, any>) {
    return documents.filter(
      (document) =>
        document[CONTENT_STATUS_FIELD] == null &&
        typeof document.url === 'string' &&
        document.url > '' &&
        !(filter.id?.$nin ?? []).includes(document.id),
    );
  }

  return {
    ...actual,
    MongoClient: {
      connect: async (url: string) => {
        const server = servers.get(url);
        if (!server || server.failOn === 'connect') {
          throw new Error(`connect ECONNREFUSED ${url}`);
        }
        server.opened++;
        const collection = makeCollection(server);
        return {
          db: () => ({ collection: () => collection }),
          close: async () => {
            server.closed++;
          },
        };
      },
    },
  };
});

const story = {
  id: 'news:1',
  title: 'Neue Überschrift',
  category: 'Chronik',
  url: 'https://orf.at/stories/1/',
  timestamp: new Date('2026-01-01T00:00:00.000Z'),
  source: 'news',
};
const embedding = Binary.fromInt8Array(Int8Array.from([1, 2, 3]));

describe('buildStoryUpdate', () => {
  it('writes the new embedding when one was produced', () => {
    const update = buildStoryUpdate(story, embedding, true);
    expect(update.$set[TITLE_EMBEDDING_FIELD]).toBe(embedding);
    expect(update).not.toHaveProperty('$unset');
  });

  it('removes the stale vector when a retitled story has no new embedding', () => {
    const update = buildStoryUpdate(story, undefined, true);
    expect(update.$unset).toEqual({ [TITLE_EMBEDDING_FIELD]: '' });
    expect(update.$set).not.toHaveProperty(TITLE_EMBEDDING_FIELD);
  });

  it('keeps the existing vector when only the category or url changed', () => {
    const update = buildStoryUpdate(story, undefined, false);
    expect(update).not.toHaveProperty('$unset');
    expect(update.$set).not.toHaveProperty(TITLE_EMBEDDING_FIELD);
  });

  const updateCases = [
    { name: 'new embedding', emb: embedding, retitled: true },
    { name: 'retitled without embedding', emb: undefined, retitled: true },
    { name: 'category or url changed', emb: undefined, retitled: false },
  ];

  it.each(updateCases)('never touches the content fields ($name)', ({ emb, retitled }) => {
    const update = buildStoryUpdate(story, emb, retitled) as { $set: object; $unset?: object };
    const unset = update.$unset ?? {};
    expect(update.$set).not.toHaveProperty(CONTENT_EMBEDDING_FIELD);
    expect(update.$set).not.toHaveProperty(CONTENT_STATUS_FIELD);
    expect(unset).not.toHaveProperty(CONTENT_EMBEDDING_FIELD);
    expect(unset).not.toHaveProperty(CONTENT_STATUS_FIELD);
  });

  it.each(updateCases)('never sets and unsets the same field in one update ($name)', ({ emb, retitled }) => {
    const update = buildStoryUpdate(story, emb, retitled);
    const unset = Object.keys((update as { $unset?: object }).$unset ?? {});
    expect(unset.filter((key) => key in update.$set)).toEqual([]);
  });
});

const s1: Story = {
  id: 'news:1',
  title: 'Erste',
  category: 'Chronik',
  url: 'https://orf.at/stories/1/',
  timestamp: new Date('2026-01-01T00:00:00.000Z'),
  source: 'news',
};
const s2: Story = { ...s1, id: 'news:2', title: 'Zweite', url: 'https://orf.at/stories/2/' };
const s3: Story = { ...s1, id: 'news:3', title: 'Dritte', url: 'https://orf.at/stories/3/' };

const oldVector = Binary.fromInt8Array(Int8Array.from([9]));

function vectorOf(title: string) {
  return Binary.fromInt8Array(Int8Array.from([...title].map((char) => char.charCodeAt(0) % 128)));
}

describe('Database', () => {
  const embedCalls: Array<ReadonlyArray<string>> = [];
  const logs: Array<string> = [];

  beforeEach(() => {
    servers.clear();
    embedCalls.length = 0;
    logs.length = 0;
  });

  function addServer(url: string, documents: Array<FakeDocument> = [], failOn?: FakeServer['failOn']) {
    const server: FakeServer = {
      documents: new Map(documents.map((document) => [document.id, document])),
      failOn,
      opened: 0,
      closed: 0,
    };
    servers.set(url, server);
    return server;
  }

  const embeddingStub = Layer.succeed(Embedding, {
    embed: (texts: ReadonlyArray<string>) =>
      Effect.sync(() => {
        embedCalls.push([...texts]);
        return texts.map(vectorOf);
      }),
    embedContent: () => Effect.die('unused'),
    truncateToTokens: () => Effect.die('unused'),
    health: () => Effect.die('unused'),
  });

  const captureLogs = Logger.layer([
    Logger.make(({ message }) => {
      logs.push(Array.isArray(message) ? message.join(' ') : String(message));
    }),
  ]);

  function run<A, E>(
    effect: (database: typeof Database.Service) => Effect.Effect<A, E>,
    loggerLayer: Layer.Layer<never> = captureLogs,
  ) {
    return Effect.gen(function* () {
      const database = yield* Database;
      return yield* effect(database);
    }).pipe(
      Effect.provide(Database.layerWithoutDependencies),
      Effect.provide(embeddingStub),
      Effect.provide(loggerLayer),
      Effect.exit,
      Effect.runPromise,
    );
  }

  const A = 'mongodb://user:s3cr3t@a:27017/';
  const B = 'mongodb://user:s3cr3t@b:27017/';
  const C = 'mongodb://user:s3cr3t@c:27017/';

  describe('persistOrfNews', () => {
    it('inserts and updates per target according to its own state', async () => {
      const a = addServer(A, [
        { ...s1, [TITLE_EMBEDDING_FIELD]: oldVector },
        { ...s2, title: 'Alte Zweite', [TITLE_EMBEDDING_FIELD]: oldVector },
      ]);
      const b = addServer(B);

      const exit = await run((database) => database.persistOrfNews([s1, s2, s3], parseTargets(`${A}\n${B}`)));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(a.documents.get(s1.id)![TITLE_EMBEDDING_FIELD]).toBe(oldVector);
      expect(a.documents.get(s2.id)).toMatchObject({ title: 'Zweite', [TITLE_EMBEDDING_FIELD]: vectorOf('Zweite') });
      expect(a.documents.get(s3.id)).toMatchObject({ title: 'Dritte', [TITLE_EMBEDDING_FIELD]: vectorOf('Dritte') });
      expect([...b.documents.keys()].sort()).toEqual([s1.id, s2.id, s3.id]);
      expect(b.documents.get(s1.id)![TITLE_EMBEDDING_FIELD]).toEqual(vectorOf('Erste'));
      expect(logs).toContain(`Inserted story IDs: [${s3.id}]`);
      expect(logs).toContain(`Updated story IDs: [${s2.id}]`);
      expect(logs).toContain(`Inserted story IDs: [${s1.id}, ${s2.id}, ${s3.id}]`);
    });

    it('embeds once regardless of the number of targets', async () => {
      addServer(A);
      await run((database) => database.persistOrfNews([s1, s2], parseTargets(A)));
      const singleTarget = [...embedCalls];

      embedCalls.length = 0;
      addServer(A);
      addServer(B, [s1]);
      addServer(C, [{ ...s2, title: 'Alte Zweite' }]);
      await run((database) => database.persistOrfNews([s1, s2], parseTargets(`${A}\n${B}\n${C}`)));

      expect(singleTarget).toEqual([['Erste', 'Zweite']]);
      expect(embedCalls).toEqual([['Erste', 'Zweite']]);
    });

    it('keeps writing to the other targets when one cannot connect', async () => {
      addServer(A, [], 'connect');
      const b = addServer(B);

      const exit = await run((database) => database.persistOrfNews([s1], parseTargets(`${A}\n${B}`)));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(b.documents.has(s1.id)).toBe(true);
      expect(logs.some((log) => log.startsWith("Database target 'a:27017' failed"))).toBe(true);
    });

    it.each(['find', 'write'] as const)('keeps writing to the other targets when one fails on %s', async (failOn) => {
      const a = addServer(A, [], failOn);
      const b = addServer(B);

      const exit = await run((database) => database.persistOrfNews([s1], parseTargets(`${A}\n${B}`)));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(b.documents.has(s1.id)).toBe(true);
      expect(a.closed).toBe(1);
      expect(logs.some((log) => log.startsWith("Database target 'a:27017' failed"))).toBe(true);
    });

    it('skips stories another writer inserted in the meantime', async () => {
      const a = addServer(A);
      a.insertedConcurrently = [{ ...s2, [TITLE_EMBEDDING_FIELD]: oldVector }];

      const exit = await run((database) => database.persistOrfNews([s1, s2, s3], parseTargets(A)));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect([...a.documents.keys()].sort()).toEqual([s1.id, s2.id, s3.id]);
      expect(a.documents.get(s2.id)![TITLE_EMBEDDING_FIELD]).toBe(oldVector);
      expect(logs).toContain(`Inserted story IDs: [${s1.id}, ${s3.id}]`);
      expect(logs).toContain(`Skipped already existing story IDs: [${s2.id}]`);
      expect(logs.some((log) => log.startsWith('Database target'))).toBe(false);
    });

    it('fails when every target fails', async () => {
      addServer(A, [], 'connect');
      addServer(B, [], 'write');

      const exit = await run((database) => database.persistOrfNews([s1], parseTargets(`${A}\n${B}`)));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain('Failed to persist stories to any database target.');
    });

    it('closes every opened client', async () => {
      const a = addServer(A);
      const b = addServer(B);

      await run((database) => database.persistOrfNews([s1], parseTargets(`${A}\n${B}`)));

      expect([a.opened, a.closed, b.opened, b.closed]).toEqual([1, 1, 1, 1]);
    });

    it('never logs credentials', async () => {
      addServer(A, [], 'connect');
      addServer(B);
      const redactedLogs = Logger.layer([redactedLogFmt.pipe(Logger.map((line) => logs.push(line)))]);

      await run((database) => database.persistOrfNews([s1], parseTargets(`${A}\n${B}`)), redactedLogs);

      expect(logs.join('\n')).toContain('ECONNREFUSED mongodb://***@a:27017/');
      expect(logs.join('\n')).not.toContain('s3cr3t');
    });
  });

  describe('backfillEmbeddings', () => {
    it('embeds a title missing on several targets only once', async () => {
      const a = addServer(A, [s1, s2]);
      const b = addServer(B, [s1, s3]);

      const exit = await run((database) => database.backfillEmbeddings({ batchSize: 100 }, parseTargets(`${A}\n${B}`)));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(embedCalls).toEqual([['Erste', 'Zweite'], ['Dritte']]);
      expect(a.documents.get(s1.id)![TITLE_EMBEDDING_FIELD]).toEqual(vectorOf('Erste'));
      expect(b.documents.get(s1.id)![TITLE_EMBEDDING_FIELD]).toEqual(vectorOf('Erste'));
      expect(b.documents.get(s3.id)![TITLE_EMBEDDING_FIELD]).toEqual(vectorOf('Dritte'));
    });

    it('continues with the next target when one fails', async () => {
      addServer(A, [s1], 'connect');
      const b = addServer(B, [s1]);

      const exit = await run((database) => database.backfillEmbeddings({ batchSize: 100 }, parseTargets(`${A}\n${B}`)));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(b.documents.get(s1.id)![TITLE_EMBEDDING_FIELD]).toEqual(vectorOf('Erste'));
    });

    it('fails when every target fails', async () => {
      addServer(A, [s1], 'find');

      const exit = await run((database) => database.backfillEmbeddings({ batchSize: 100 }, parseTargets(A)));

      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  describe('content', () => {
    const at = (day: number) => new Date(`2026-01-0${day}T00:00:00.000Z`);

    it('selects stories without content status and url, newest first, skipping excluded ids', async () => {
      const a = addServer(A, [
        { ...s1, timestamp: at(1) },
        { ...s2, timestamp: at(3) },
        { ...s3, timestamp: at(2) },
        { ...s1, id: 'news:4', timestamp: at(4), [CONTENT_STATUS_FIELD]: CONTENT_STATUS.failed },
        { ...s1, id: 'news:5', timestamp: at(5), url: '' },
        { ...s1, id: 'news:6', timestamp: at(6) },
      ]);

      const exit = await run((database) =>
        database.findStoriesWithoutContent(parseTargets(A)[0], { limit: 2, excludeIds: ['news:6'] }),
      );

      expect(exit).toEqual(
        Exit.succeed([
          { id: s2.id, title: s2.title, url: s2.url },
          { id: s3.id, title: s3.title, url: s3.url },
        ]),
      );
      expect(a.lastFind).toEqual({
        filter: { [CONTENT_STATUS_FIELD]: null, url: { $gt: '' }, id: { $nin: ['news:6'] } },
        options: { projection: { _id: 0, id: 1, title: 1, url: 1 }, sort: { timestamp: -1 }, limit: 2 },
      });
    });

    it('selects without an id filter when no ids are excluded', async () => {
      const a = addServer(A, [s1]);

      await run((database) => database.findStoriesWithoutContent(parseTargets(A)[0], { limit: 20, excludeIds: [] }));

      expect(a.lastFind?.filter).toEqual({ [CONTENT_STATUS_FIELD]: null, url: { $gt: '' } });
    });

    it.each([
      { operation: 'selection', failOn: 'find' as const },
      { operation: 'selection', failOn: 'connect' as const },
      { operation: 'backlog count', failOn: 'find' as const },
    ])('names the target when the $operation fails on $failOn', async ({ operation, failOn }) => {
      addServer(A, [s1], failOn);
      const [target] = parseTargets(A);

      const exit = await run((database) =>
        operation === 'selection'
          ? database.findStoriesWithoutContent(target, { limit: 1, excludeIds: [] }).pipe(Effect.asVoid)
          : database.countStoriesWithoutContent(target).pipe(Effect.asVoid),
      );

      expect(exit).toMatchObject({
        _tag: 'Failure',
        cause: { reasons: [{ error: { message: expect.stringMatching(/^Database target 'a:27017' failed: /) } }] },
      });
    });

    it('counts the remaining backlog', async () => {
      const a = addServer(A, [s1, s2, { ...s3, [CONTENT_STATUS_FIELD]: CONTENT_STATUS.embedded }]);

      const exit = await run((database) => database.countStoriesWithoutContent(parseTargets(A)[0]));

      expect(exit).toEqual(Exit.succeed(2));
      expect(a.lastCount).toEqual({ [CONTENT_STATUS_FIELD]: null, url: { $gt: '' } });
    });

    it('writes embedded and failed results to content targets', async () => {
      const a = addServer(A, [s1, s2]);

      const exit = await run((database) =>
        database.writeContentResults(
          [
            { id: s1.id, contentEmbedding: embedding },
            { id: s2.id, failed: true },
          ],
          parseTargets(A),
        ),
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(a.documents.get(s1.id)).toMatchObject({
        [CONTENT_EMBEDDING_FIELD]: embedding,
        [CONTENT_STATUS_FIELD]: CONTENT_STATUS.embedded,
      });
      expect(a.documents.get(s2.id)![CONTENT_STATUS_FIELD]).toBe(CONTENT_STATUS.failed);
      expect(a.documents.get(s2.id)).not.toHaveProperty(CONTENT_EMBEDDING_FIELD);
    });

    it('never writes to an excluded target, even when it is passed', async () => {
      const a = addServer(A, [s1]);
      const b = addServer(B, [s1]);
      const { targets } = withContentExclusions(parseTargets(`${A}\n${B}`), 'b:27017');

      const exit = await run((database) =>
        database.writeContentResults([{ id: s1.id, contentEmbedding: embedding }], targets),
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(a.documents.get(s1.id)![CONTENT_STATUS_FIELD]).toBe(CONTENT_STATUS.embedded);
      expect(b.documents.get(s1.id)).not.toHaveProperty(CONTENT_EMBEDDING_FIELD);
      expect(b.documents.get(s1.id)).not.toHaveProperty(CONTENT_STATUS_FIELD);
      expect(b.opened).toBe(0);
      expect(logs).toContain("Skipping content results for 'b:27017': excluded from content embeddings.");
    });

    it('fails when only excluded targets are passed', async () => {
      const b = addServer(B, [s1]);
      const { targets } = withContentExclusions(parseTargets(B), 'b:27017');

      const exit = await run((database) => database.writeContentResults([{ id: s1.id, failed: true }], targets));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(b.opened).toBe(0);
    });

    it('skips a failing target and fails only when every target fails', async () => {
      addServer(A, [s1], 'write');
      const b = addServer(B, [s1]);

      const partial = await run((database) =>
        database.writeContentResults([{ id: s1.id, failed: true }], parseTargets(`${A}\n${B}`)),
      );
      const total = await run((database) =>
        database.writeContentResults([{ id: s1.id, failed: true }], parseTargets(A)),
      );

      expect(Exit.isSuccess(partial)).toBe(true);
      expect(b.documents.get(s1.id)![CONTENT_STATUS_FIELD]).toBe(CONTENT_STATUS.failed);
      expect(logs.some((log) => log.startsWith("Database target 'a:27017' failed"))).toBe(true);
      expect(Exit.isFailure(total)).toBe(true);
    });
  });
});
