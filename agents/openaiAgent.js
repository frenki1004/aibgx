/**
 * OpenAI-Powered Agent for Civilization Clash
 *
 * Uses OpenAI API to make decisions each turn. Supports:
 * 1. Inference mode: plays using a model (base or fine-tuned)
 * 2. Learning mode: collects experience data and can trigger fine-tuning
 *
 * Setup:
 *   npm install openai
 *   export OPENAI_API_KEY=sk-...
 *
 * Usage (with client.js):
 *   node client.js openai 0 OpenAIBot
 *
 * Or standalone:
 *   node openaiAgent.js [team] [model]
 *
 * Environment variables:
 *   OPENAI_API_KEY     - Required
 *   OPENAI_MODEL       - Model to use (default: gpt-4o-mini)
 *   OPENAI_LEARN       - Set to "true" to enable experience collection
 *   EXPERIENCE_DIR     - Where to save experience data (default: training/experience)
 */

const fs = require('fs');
const path = require('path');

// Try to load OpenAI - provide helpful error if missing
let OpenAI;
try {
  OpenAI = require('openai').default || require('openai');
} catch (e) {
  console.error('OpenAI package not found. Install it with: npm install openai');
  console.error('Then set OPENAI_API_KEY environment variable.');
  // Return a dummy agent so the module still loads
  module.exports = {
    generateActions: () => [],
  };
  return;
}

const {
  ACTIONS,
  UNIT_TYPES,
  UNIT_STATS,
  ECONOMY,
  validateAction,
  getCityCost,
  getTilesAtDistance1,
  getUnit,
  chebyshevDistance,
  isInZoC,
  getConnectedTerritory,
} = require('../logic');

// --- Configuration ---
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const LEARN_MODE = process.env.OPENAI_LEARN === 'true';
const EXPERIENCE_DIR = process.env.EXPERIENCE_DIR || path.join(__dirname, '..', 'training', 'experience');
const TEMPERATURE = 0.3; // Low temp for more deterministic play
const MAX_RETRIES = 2;

// --- OpenAI Client ---
const openai = new OpenAI();

// --- Experience Buffer (for learning mode) ---
const experienceBuffer = [];
let currentGameId = Date.now();

// --- Fallback Agent (smarterAgent logic for when API fails) ---
const smarterAgent = require('./smarterAgent');

/**
 * System prompt - teaches the model the game rules and how to output actions
 */
const SYSTEM_PROMPT = `You are an expert AI playing Civilization Clash, a turn-based 2-player strategy game on a grid map.

UNITS (hard counter triangle):
- SOLDIER: cost 20G, HP 2, move 1, melee all adjacent. Zone of Control (radius 2) pins enemy archers/raiders. Captures cities. Immune to ZoC.
- ARCHER: cost 25G, HP 2, move 1, ranged attack dist 2 (fires BEFORE movement, can't move if shot). Deals 2x to soldiers (one-shot kill).
- RAIDER: cost 15G, HP 1, move 2, melee all adjacent. Plunders 3x3 enemy tiles (3G each). Deals 2x to archers (one-shot). Does 0 damage to soldiers.

COUNTER TRIANGLE: Soldier→Raider (2x), Archer→Soldier (2x), Raider→Archer (2x).

ECONOMY:
- Each owned tile: 0.5G/turn. Each city: 5G/turn. Each monument: 3G/turn.
- Expand territory: 5G (must be adjacent to connected territory, neutral field tile).
- Build city: 80G × 1.5^n (n = non-capital cities already built). City on owned field tile.
- Upkeep: 1 free unit per city. Excess costs grow geometrically (1.5x per unit).

ACTIONS (submit all at once, processed simultaneously):
- MOVE: {"action":"MOVE","from_x":X,"from_y":Y,"to_x":X,"to_y":Y}
- BUILD_UNIT: {"action":"BUILD_UNIT","city_x":X,"city_y":Y,"unit_type":"SOLDIER"|"ARCHER"|"RAIDER"}
- EXPAND_TERRITORY: {"action":"EXPAND_TERRITORY","x":X,"y":Y}
- BUILD_CITY: {"action":"BUILD_CITY","x":X,"y":Y}

STRATEGY:
- Early: expand territory, build 2-4 cities
- Mid: build army, counter-pick enemy composition, contest monuments
- Late: push for cities, monument control for score
- Soldiers in front (ZoC screens), archers behind, raiders flank
- Monument scoring = 3 × total_cities per turn — very valuable late game

RESPOND WITH ONLY A JSON ARRAY OF ACTIONS. No explanations, no markdown.`;

/**
 * Compress game state for the prompt (save tokens)
 */
function compressStateForPrompt(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const opponent = state.players.find((p) => p.id !== playerId);

  const myUnits = state.units
    .filter((u) => u.owner === playerId)
    .map((u) => `${u.type[0]}(${u.x},${u.y})hp${u.hp}${(u.canMove ?? u.can_move_next_turn) ? '' : '*'}`);

  const enemyUnits = state.units
    .filter((u) => u.owner !== playerId)
    .map((u) => `${u.type[0]}(${u.x},${u.y})hp${u.hp}`);

  const myCities = state.cities
    .filter((c) => c.owner === playerId)
    .map((c) => `(${c.x},${c.y})`);

  const enemyCities = state.cities
    .filter((c) => c.owner !== null && c.owner !== playerId)
    .map((c) => `(${c.x},${c.y})`);

  const monuments = (state.monuments || []).map(
    (m) => `(${m.x},${m.y}):${m.controlledBy === playerId ? 'mine' : m.controlledBy !== null ? 'enemy' : 'none'}`
  );

  const myTiles = state.map.tiles.filter((t) => t.owner === playerId).length;
  const enemyTiles = state.map.tiles.filter((t) => t.owner !== null && t.owner !== playerId).length;

  // Find expandable tiles (adjacent to my territory, neutral field)
  const connected = getConnectedTerritory(state, playerId);
  const expandable = new Set();
  for (const tile of state.map.tiles) {
    if (tile.owner !== playerId || !connected.has(`${tile.x},${tile.y}`)) continue;
    for (const adj of getTilesAtDistance1(tile.x, tile.y)) {
      const t = state.map.tiles.find((tt) => tt.x === adj.x && tt.y === adj.y);
      if (t && t.owner === null && t.type === 'FIELD') {
        expandable.add(`(${adj.x},${adj.y})`);
      }
    }
  }
  // Only include first 15 expandable tiles to save tokens
  const expandList = [...expandable].slice(0, 15);

  // Empty cities (can build units there)
  const emptyCities = myCities.filter((cityStr) => {
    const match = cityStr.match(/\((\d+),(\d+)\)/);
    if (!match) return false;
    const cx = parseInt(match[1]), cy = parseInt(match[2]);
    return !state.units.some((u) => u.x === cx && u.y === cy);
  });

  const cityCost = getCityCost(state, playerId);

  return `Turn ${state.turn}/${state.maxTurns} | Map ${state.map.width}x${state.map.height}
Me: ${Math.round(player.gold)}G score:${player.score} income:${Math.round(player.income * 10) / 10} tiles:${myTiles}
Enemy: ${Math.round(opponent.gold)}G score:${opponent.score} income:${Math.round(opponent.income * 10) / 10} tiles:${enemyTiles}
My units[${myUnits.length}]: ${myUnits.join(' ') || 'none'}
Enemy units[${enemyUnits.length}]: ${enemyUnits.join(' ') || 'none'}
My cities: ${myCities.join(' ')} | Empty: ${emptyCities.join(' ') || 'none'}
Enemy cities: ${enemyCities.join(' ') || 'unknown'}
Monuments: ${monuments.join(' ') || 'none'}
Expandable: ${expandList.join(' ') || 'none'}
Next city cost: ${cityCost}G | Unit costs: S=20 A=25 R=15
* = can't move this turn`;
}

/**
 * Parse the model's response into valid actions
 */
function parseActions(response, state, playerId) {
  // Try to extract JSON array from the response
  let text = response.trim();

  // Remove markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  // Try to find JSON array
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  try {
    const actions = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(actions)) return [];

    // Validate each action
    const validActions = [];
    for (const action of actions) {
      if (!action || !action.action) continue;

      const result = validateAction(state, playerId, action);
      if (result.valid) {
        validActions.push(action);
      }
    }

    return validActions;
  } catch (e) {
    return [];
  }
}

/**
 * Call OpenAI API to get actions for this turn
 */
async function getActionsFromOpenAI(state, playerId) {
  const userMessage = compressStateForPrompt(state, playerId);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: TEMPERATURE,
        max_tokens: 2000,
      });

      const content = response.choices[0]?.message?.content || '[]';
      const actions = parseActions(content, state, playerId);

      // Log token usage
      const usage = response.usage;
      if (usage) {
        const cost =
          (usage.prompt_tokens * 0.00015 + usage.completion_tokens * 0.0006) / 1000;
        // Minimal logging - only every 10 turns
        if (state.turn % 10 === 0) {
          console.log(
            `  [OpenAI] Turn ${state.turn}: ${actions.length} actions, ${usage.total_tokens} tokens (~$${cost.toFixed(5)})`
          );
        }
      }

      // Save experience if learning
      if (LEARN_MODE) {
        experienceBuffer.push({
          gameId: currentGameId,
          turn: state.turn,
          playerId,
          state: userMessage,
          rawResponse: content,
          actions,
          validActionCount: actions.length,
          model: MODEL,
          timestamp: Date.now(),
        });
      }

      return actions;
    } catch (err) {
      console.error(`  [OpenAI] API error (attempt ${attempt + 1}): ${err.message}`);
      if (attempt === MAX_RETRIES) return null; // Signal to use fallback
    }
  }

  return null;
}

/**
 * Main action generator - async wrapper with sync fallback
 *
 * Since the game client expects synchronous generateActions(),
 * we use a blocking approach with a pending promise.
 */

// For sync client.js compatibility: we store the pending result
let pendingActions = null;
let pendingResolve = null;

/**
 * Async version - call this directly if you have an async game loop
 */
async function generateActionsAsync(state, playerId) {
  const actions = await getActionsFromOpenAI(state, playerId);

  if (actions === null || actions.length === 0) {
    // Fallback to heuristic agent
    console.log(`  [OpenAI] Falling back to heuristic agent for turn ${state.turn}`);
    return smarterAgent.generateActions(state, playerId);
  }

  return actions;
}

/**
 * Sync version for client.js compatibility
 * Uses smarterAgent as fallback since we can't await in sync context
 *
 * For proper async OpenAI usage, use the standalone runner below
 * or the openaiClient.js wrapper
 */
function generateActions(state, playerId) {
  // In sync mode, we fire-and-forget the API call for learning
  // but use the heuristic agent for actual play
  if (LEARN_MODE) {
    // Fire async call for data collection, but don't wait for it
    getActionsFromOpenAI(state, playerId).catch(() => {});
  }

  // Always use heuristic for sync mode - the real power is in openaiClient.js
  return smarterAgent.generateActions(state, playerId);
}

/**
 * Save collected experience to disk
 */
function saveExperience() {
  if (experienceBuffer.length === 0) return;

  if (!fs.existsSync(EXPERIENCE_DIR)) fs.mkdirSync(EXPERIENCE_DIR, { recursive: true });

  const filename = path.join(EXPERIENCE_DIR, `experience_${currentGameId}.jsonl`);
  const stream = fs.createWriteStream(filename);

  for (const exp of experienceBuffer) {
    stream.write(JSON.stringify(exp) + '\n');
  }

  stream.end();
  console.log(`[OpenAI] Saved ${experienceBuffer.length} experience records to ${filename}`);
}

// Save on exit
process.on('exit', saveExperience);
process.on('SIGINT', () => {
  saveExperience();
  process.exit(0);
});

module.exports = {
  generateActions,
  generateActionsAsync,
  compressStateForPrompt,
  parseActions,
  SYSTEM_PROMPT,
};
