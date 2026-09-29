import { Effect, Exit, Layer, Logger } from 'effect';
import { Binary } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TITLE_EMBEDDING_FIELD } from '#common/search';
import { parseTargets } from '#common/targets';
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
          failIf('find');
          const documents = [...server.documents.values()];
          if (filter.id) {
            return documents.filter((document) => filter.id.$in.includes(document.id));
          }
          return documents
            .filter((document) => !(TITLE_EMBEDDING_FIELD in document) && document.title > '')
            .slice(0, options?.limit);
        },
      }),
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

  it('never sets and unsets the same field in one update', () => {
    for (const [emb, retitled] of [
      [embedding, true],
      [undefined, true],
      [undefined, false],
    ] as const) {
      const update = buildStoryUpdate(story, emb, retitled);
      const unset = Object.keys((update as { $unset?: object }).$unset ?? {});
      expect(unset.filter((key) => key in update.$set)).toEqual([]);
    }
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
});
