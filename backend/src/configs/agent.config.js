// Agent loop limits: these bound latency, cost and context size.
import { num } from './env.js';

/**
 * @type {{maxSteps: number, maxHistory: number, maxMessageChars: number, maxToolChars: number}}
 */
export const agentConfig = {
  /** Max tool rounds per turn; the last round forces a text answer. Env: AGENT_MAX_STEPS */
  maxSteps: num('AGENT_MAX_STEPS', 6),
  /** How many recent messages are sent back to the model. Env: AGENT_MAX_HISTORY */
  maxHistory: num('AGENT_MAX_HISTORY', 16),
  /** Each message is cut to this many characters. Env: AGENT_MAX_MESSAGE_CHARS */
  maxMessageChars: num('AGENT_MAX_MESSAGE_CHARS', 4000),
  /** A single tool result is cut to this many characters. Env: AGENT_MAX_TOOL_CHARS */
  maxToolChars: num('AGENT_MAX_TOOL_CHARS', 14000),
};
