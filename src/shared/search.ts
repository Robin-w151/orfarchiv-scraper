import { Schema } from 'effect';

const EmbeddableTitle = Schema.String.check(
  Schema.makeFilter((title) => title.trim().length > 0 || 'Title must not be empty or all whitespace.'),
);

export function toDocumentInput(title: string): string {
  return `title: none | text: ${title}`;
}

export function isEmbeddable(title: string | undefined | null): title is string {
  return Schema.is(EmbeddableTitle)(title);
}
