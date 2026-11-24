// Retrieval tuning. Defaults are standard values; change them only with an eval to back it up.

/**
 * @type {{bm25: {k1: number, b: number}, rrfK: number, vectorCandidates: number, vectorKeep: number,
 *   defaultLimit: number, maxLimit: number, defaultStatuses: string[]}}
 */
export const searchConfig = {
  bm25: {
    /** Term-frequency saturation: the 10th mention of a word adds little. Standard 1.2 */
    k1: 1.2,
    /** Length normalization: long descriptions don't win just by being long. Standard 0.75 */
    b: 0.75,
  },
  /** Reciprocal Rank Fusion damping constant (60 = value from the original RRF paper) */
  rrfK: 60,
  /** How many nearest neighbours to ask the vector store for */
  vectorCandidates: 100,
  /** How many of those take part in fusion (stops weak semantic matches flooding results) */
  vectorKeep: 50,
  /** Results returned by search_products when the model doesn't specify a limit */
  defaultLimit: 8,
  /** Hard cap on results per search (keeps tool output and tokens small) */
  maxLimit: 15,
  /** Statuses searched by default — discontinued products are hidden unless asked for */
  defaultStatuses: ['Active', 'Temporarily Out of Stock', 'Coming Soon'],
};
