// HTTP server settings.
import { bool, num, str } from './env.js';

/**
 * @type {{port: number, host: string, trustProxy: boolean, jsonBodyLimit: string, corsOrigins: string[]}}
 */
export const serverConfig = {
  /** Port the API listens on. Env: PORT */
  port: num('PORT', 3001),
  /** Network interface to listen on. 0.0.0.0 = all (needed inside Docker). Env: HOST */
  host: str('HOST', '0.0.0.0'),
  /**
   * Running behind a reverse proxy (nginx)? Then trust its X-Forwarded-* headers so req.ip is the
   * visitor's IP, not nginx's. Set true in production behind nginx. Env: TRUST_PROXY
   */
  trustProxy: bool('TRUST_PROXY', false),
  /**
   * Browser origins allowed to call the API (CORS). Default "*" = allow access from everywhere.
   * To restrict, set a comma-separated list. Env: CORS_ORIGINS
   * @example CORS_ORIGINS=*                                            (any origin — current default)
   * @example CORS_ORIGINS=http://localhost:5173,https://www.example.com (only these sites)
   */
  corsOrigins: (str('CORS_ORIGINS', '*') ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  /** Max JSON request body. Chat history is sent each turn, so keep headroom but block abuse. Env: JSON_BODY_LIMIT */
  jsonBodyLimit: str('JSON_BODY_LIMIT', '200kb'),
};
