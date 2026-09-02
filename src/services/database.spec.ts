import { Binary } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { TITLE_EMBEDDING_FIELD } from '../shared/config';
import { buildStoryUpdate } from './database';

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
