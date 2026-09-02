import { Duration } from 'effect';

// Embedding
export const BATCH_SIZE = 100;
export const BATCH_TIMEOUT = Duration.seconds(30);

// Search
export const TITLE_EMBEDDING_FIELD = 'titleEmbedding';
export const TITLE_EMBEDDING_DIMENSIONS = 256;
