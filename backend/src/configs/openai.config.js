// OpenAI models. The API key itself is read by the OpenAI SDK from OPENAI_API_KEY.
import { num, str } from './env.js';

/**
 * @type {{hasApiKey: boolean, chatModel: string, temperature: number, isReasoningModel: boolean,
 *   embeddingModel: string, embeddingDim: number, embeddingBatchSize: number}}
 */
export const openaiConfig = {
  /** Is OPENAI_API_KEY set? (the value is never copied into config) */
  hasApiKey: Boolean(str('OPENAI_API_KEY')),
  /** Chat model used by the agent; any model with tool calling. Env: OPENAI_MODEL */
  chatModel: str('OPENAI_MODEL', 'gpt-4.1-mini'),
  /** Low = consistent, factual answers. Ignored for reasoning models. Env: OPENAI_TEMPERATURE */
  temperature: num('OPENAI_TEMPERATURE', 0.2),
  /** Reasoning models (o-series, gpt-5) reject the temperature parameter */
  get isReasoningModel() { return /^(o\d|gpt-5)/.test(this.chatModel); },
  /** Embedding model for products AND queries (must match what's stored). Changing it re-embeds everything. */
  embeddingModel: 'text-embedding-3-small',
  /** Vector length produced by embeddingModel */
  embeddingDim: 1536,
  /** Texts per embeddings API call in `npm run embed` */
  embeddingBatchSize: 200,
};
