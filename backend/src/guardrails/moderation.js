// Content moderation with the OpenAI Moderation API (omni-moderation-latest, free to use).
// Classifies text for hate, harassment, violence, self-harm, sexual content, illicit activity, etc.
import OpenAI from 'openai';
import { guardrailsConfig, openaiConfig } from '../configs/index.js';
import { getLogger } from '../logger.js';

const logger = getLogger('guardrails');
const cfg = guardrailsConfig.moderation;

let client = null;
/**
 * Lazily created OpenAI client (reads OPENAI_API_KEY).
 * @returns {OpenAI}
 */
function getClient() {
  if (!client) client = new OpenAI();
  return client;
}

/**
 * Moderate one piece of text.
 * Never throws: if the moderation API fails, the result follows MODERATION_FAIL_OPEN
 * (default: allow, and log a warning) so an outage of this check doesn't take the chatbot down.
 * @param {string} text
 * @returns {Promise<{flagged: boolean, categories: string[], skipped?: string, ms: number}>}
 *   categories: names of the flagged categories, e.g. ["violence", "harassment/threatening"]
 */
export async function moderate(text) {
  const t0 = Date.now();
  if (!cfg.enabled) return { flagged: false, categories: [], skipped: 'disabled', ms: 0 };
  if (!openaiConfig.hasApiKey) return { flagged: false, categories: [], skipped: 'no api key', ms: 0 };
  if (!text || !text.trim()) return { flagged: false, categories: [], ms: 0 };
  try {
    const res = await getClient().moderations.create({ model: cfg.model, input: text });
    const r = res.results?.[0] ?? {};
    const categories = Object.entries(r.categories ?? {}).filter(([, v]) => v).map(([k]) => k);
    return { flagged: Boolean(r.flagged), categories, ms: Date.now() - t0 };
  } catch (e) {
    logger.warn(`Moderation API failed (${e.message}) — ${cfg.failOpen ? 'allowing' : 'blocking'} the message (MODERATION_FAIL_OPEN=${cfg.failOpen})`);
    return { flagged: !cfg.failOpen, categories: cfg.failOpen ? [] : ['moderation_unavailable'], skipped: 'error', ms: Date.now() - t0 };
  }
}
