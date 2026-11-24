// Monitoring settings.
import { num } from './env.js';

/**
 * @type {{priceInputPer1M: number, priceOutputPer1M: number, latencyWindow: number}}
 */
export const telemetryConfig = {
  /** USD per 1M input tokens, for cost estimates. Default is an ESTIMATE for gpt-4.1-mini. Env: PRICE_INPUT_PER_1M */
  priceInputPer1M: num('PRICE_INPUT_PER_1M', 0.4),
  /** USD per 1M output tokens. Env: PRICE_OUTPUT_PER_1M */
  priceOutputPer1M: num('PRICE_OUTPUT_PER_1M', 1.6),
  /** How many recent turn latencies are kept for p50/p95 in /api/metrics */
  latencyWindow: 1000,
};
