import { Schema } from 'effect';

export const Story = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  category: Schema.optional(Schema.String),
  url: Schema.String,
  timestamp: Schema.Date,
  source: Schema.String,
});
export type Story = Schema.Schema.Type<typeof Story>;
export const isStory = Schema.is(Story);

export interface Source {
  source: string;
  rssUrl: string;
}
