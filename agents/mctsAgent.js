/**
 * MCTS Agent for Civilization Clash
 *
 * Uses Monte Carlo Tree Search with macro-actions.
 *
 * Usage:
 *   node client.js mcts 0 MCTSBot
 *
 * Environment:
 *   MCTS_SIMS     - Simulations per turn (default: 100)
 *   MCTS_TIME_MS  - Time limit per turn in ms (default: 250 for live play)
 *   MCTS_ROLLOUT  - Rollout depth in turns (default: 8)
 *   MCTS_FAST     - "true" to skip rollout (just evaluate position). Much faster.
 */

const { MCTSEngine } = require('./mctsEngine');

const SIMS = parseInt(process.env.MCTS_SIMS) || 100;
const TIME_MS = parseInt(process.env.MCTS_TIME_MS) || 250;
const ROLLOUT_DEPTH = parseInt(process.env.MCTS_ROLLOUT) || 8;
const FAST_MODE = process.env.MCTS_FAST === 'true';

const engine = new MCTSEngine({
  simulations: SIMS,
  rolloutDepth: ROLLOUT_DEPTH,
  timeLimitMs: TIME_MS,
  cExplore: 1.41,
  fastMode: FAST_MODE,
});

function generateActions(state, playerId) {
  const result = engine.search(state, playerId);

  // Log every 10 turns
  if (state.turn % 10 === 1 || state.turn <= 3) {
    const top3 = Object.entries(result.rootVisits)
      .sort((a, b) => b[1].visits - a[1].visits)
      .slice(0, 3)
      .map(([name, d]) => `${name}(${d.visits})`)
      .join(', ');
    console.log(`  [MCTS] t${state.turn}: ${result.macroName} | ${result.totalSimulations} sims ${result.timeMs}ms | ${top3}`);
  }

  return result.actions;
}

module.exports = { generateActions };
