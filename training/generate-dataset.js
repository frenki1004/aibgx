/**
 * Dataset Generator for AI Training
 *
 * Runs headless games between existing bots, captures (state, actions, outcome)
 * tuples and exports them in JSONL format suitable for OpenAI fine-tuning.
 *
 * Usage:
 *   node generate-dataset.js [numGames] [mode]
 *
 * Examples:
 *   node generate-dataset.js 100 tournament
 *   node generate-dataset.js 500 blitz
 *   node generate-dataset.js         # defaults: 200 games, tournament mode
 *
 * Output:
 *   training/data/dataset_<timestamp>.jsonl        - OpenAI fine-tuning format
 *   training/data/raw_games_<timestamp>.jsonl       - Raw game data for custom training
 */

const path = require('path');
const fs = require('fs');
const logic = require('../logic');

// Load agents
const smarterAgent = require('../agents/smarterAgent');
const smart2Agent = require('../agents/smart2Agent');
const econAgent = require('../agents/econAgent');
const dumbAgent = require('../agents/dumbAgent');

const AGENTS = {
  smarter: { name: 'smarter', fn: smarterAgent },
  smart2: { name: 'smart2', fn: smart2Agent },
  econ: { name: 'econ', fn: econAgent },
  dumb: { name: 'dumb', fn: dumbAgent },
};

// All matchups (including mirrors)
const MATCHUPS = [];
const agentKeys = Object.keys(AGENTS);
for (const a of agentKeys) {
  for (const b of agentKeys) {
    MATCHUPS.push([a, b]);
  }
}

// Parse args
const args = process.argv.slice(2);
const NUM_GAMES = parseInt(args[0]) || 200;
const MODE = args[1] || 'tournament';

// Ensure output directory
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const timestamp = Date.now();
const finetuneFile = path.join(dataDir, `dataset_${timestamp}.jsonl`);
const rawFile = path.join(dataDir, `raw_games_${timestamp}.jsonl`);

const finetuneStream = fs.createWriteStream(finetuneFile);
const rawStream = fs.createWriteStream(rawFile);

/**
 * Compress game state into a concise representation for the LLM prompt.
 * Removes redundant data to save tokens while keeping all decision-relevant info.
 */
function compressState(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const opponent = state.players.find((p) => p.id !== playerId);

  const myUnits = state.units
    .filter((u) => u.owner === playerId)
    .map((u) => ({
      type: u.type,
      x: u.x,
      y: u.y,
      hp: u.hp,
      canMove: u.canMove ?? u.can_move_next_turn ?? true,
    }));

  const enemyUnits = state.units
    .filter((u) => u.owner !== playerId)
    .map((u) => ({
      type: u.type,
      x: u.x,
      y: u.y,
      hp: u.hp,
    }));

  const myCities = state.cities.filter((c) => c.owner === playerId).map((c) => ({ x: c.x, y: c.y }));

  const enemyCities = state.cities
    .filter((c) => c.owner !== null && c.owner !== playerId)
    .map((c) => ({ x: c.x, y: c.y }));

  const monuments = (state.monuments || []).map((m) => ({
    x: m.x,
    y: m.y,
    controlledBy: m.controlledBy === playerId ? 'me' : m.controlledBy !== null ? 'enemy' : null,
  }));

  // Count territory
  const myTiles = state.map.tiles.filter((t) => t.owner === playerId).length;
  const enemyTiles = state.map.tiles.filter((t) => t.owner !== null && t.owner !== playerId).length;

  return {
    turn: state.turn,
    maxTurns: state.maxTurns,
    mapSize: { w: state.map.width, h: state.map.height },
    me: {
      gold: Math.round(player.gold * 10) / 10,
      score: player.score,
      income: Math.round(player.income * 10) / 10,
      tiles: myTiles,
    },
    enemy: {
      gold: Math.round(opponent.gold * 10) / 10,
      score: opponent.score,
      income: Math.round(opponent.income * 10) / 10,
      tiles: enemyTiles,
    },
    myUnits,
    enemyUnits,
    myCities,
    enemyCities,
    monuments,
  };
}

/**
 * Format actions into a concise representation
 */
function compressActions(actions) {
  return actions.map((a) => {
    switch (a.action) {
      case 'MOVE':
        return { a: 'M', fx: a.from_x, fy: a.from_y, tx: a.to_x, ty: a.to_y };
      case 'BUILD_UNIT':
        return { a: 'B', t: a.unit_type, cx: a.city_x, cy: a.city_y };
      case 'EXPAND_TERRITORY':
        return { a: 'E', x: a.x, y: a.y };
      case 'BUILD_CITY':
        return { a: 'C', x: a.x, y: a.y };
      case 'PASS':
        return { a: 'P' };
      default:
        return a;
    }
  });
}

/**
 * Build the system prompt that teaches the model how to play
 */
function getSystemPrompt() {
  return `You are an expert AI playing Civilization Clash, a turn-based 2-player strategy game.

GAME RULES:
- Grid-based map. Units: SOLDIER (cost 20, HP 2, move 1, melee, captures cities, Zone of Control radius 2), ARCHER (cost 25, HP 2, move 1, ranged dist 2, fires before movement), RAIDER (cost 15, HP 1, move 2, melee, plunders 3x3 area).
- Hard counter triangle: SOLDIER kills RAIDER (2x), ARCHER kills SOLDIER (2x), RAIDER kills ARCHER (2x). Raiders do 0 damage to soldiers.
- Economy: tiles give 0.5G/turn, cities give 5G/turn, monuments give 3G/turn. Expand costs 5G. Cities cost 80G * 1.5^n. Unit upkeep grows geometrically above free_units (1 per city).
- Actions per turn: MOVE, BUILD_UNIT, BUILD_CITY, EXPAND_TERRITORY, PASS. All submitted simultaneously.
- Scoring: damage dealt = 5pts, kill = 7pts, monument = 3pts * total_cities/turn. Highest score wins.

STRATEGY GUIDELINES:
- Early game: expand territory, build 2-4 cities for economy
- Mid game: build army with counter-picks based on enemy composition
- Late game: push for monuments, capture enemy cities
- Keep soldiers in front to project ZoC (traps enemy archers/raiders)
- Use raiders to flank and plunder enemy economy
- Counter-pick: if enemy has soldiers→build archers, archers→build raiders, raiders→build soldiers

OUTPUT FORMAT: Return a JSON array of actions. Each action is one of:
- {"action":"MOVE","from_x":X,"from_y":Y,"to_x":X,"to_y":Y}
- {"action":"BUILD_UNIT","city_x":X,"city_y":Y,"unit_type":"SOLDIER"|"ARCHER"|"RAIDER"}
- {"action":"EXPAND_TERRITORY","x":X,"y":Y}
- {"action":"BUILD_CITY","x":X,"y":Y}
Return ONLY the JSON array, no explanation.`;
}

/**
 * Run a single headless game and collect training data
 */
function runGame(agent0Key, agent1Key, mode) {
  const agent0 = AGENTS[agent0Key].fn;
  const agent1 = AGENTS[agent1Key].fn;

  let state = logic.createInitialState({ mode });
  const turnData = []; // Collect per-turn data for both players

  while (!state.gameOver) {
    // Get fog-filtered states
    const vision0 = logic.computeVision(state, 0);
    const vision1 = logic.computeVision(state, 1);
    const state0 = logic.filterStateForPlayer(state, 0, vision0);
    const state1 = logic.filterStateForPlayer(state, 1, vision1);

    // Get actions
    let actions0, actions1;
    try {
      actions0 = agent0.generateActions(state0, 0);
    } catch (e) {
      actions0 = [];
    }
    try {
      actions1 = agent1.generateActions(state1, 1);
    } catch (e) {
      actions1 = [];
    }

    // Record turn data for both players
    turnData.push({
      turn: state.turn,
      player0: {
        state: compressState(state0, 0),
        actions: actions0,
        actionsCompressed: compressActions(actions0),
      },
      player1: {
        state: compressState(state1, 1),
        actions: actions1,
        actionsCompressed: compressActions(actions1),
      },
    });

    // Process turn
    const result = logic.processTurn(state, {
      player0: actions0,
      player1: actions1,
    });
    state = result.newState;
  }

  // Determine outcome
  const score0 = state.players[0].score;
  const score1 = state.players[1].score;
  const winner = score0 > score1 ? 0 : score1 > score0 ? 1 : -1;
  const scoreDiff = Math.abs(score0 - score1);

  return {
    agent0: agent0Key,
    agent1: agent1Key,
    mode,
    winner,
    score0,
    score1,
    scoreDiff,
    totalTurns: turnData.length,
    turns: turnData,
  };
}

/**
 * Convert a game's turn data into OpenAI fine-tuning examples.
 * Only uses turns from winning players (or both in close games).
 * Labels quality based on outcome margin.
 */
function gameToFineTuneExamples(game) {
  const examples = [];
  const systemPrompt = getSystemPrompt();

  for (const turn of game.turns) {
    // Generate examples for each player
    for (const pid of [0, 1]) {
      const playerKey = pid === 0 ? 'player0' : 'player1';
      const data = turn[playerKey];
      const isWinner = game.winner === pid;
      const isTie = game.winner === -1;

      // Quality filter: only use winning player's data, or both in close games
      if (!isWinner && !isTie && game.scoreDiff > 50) continue;

      // Weight: winning with large margin = high quality
      const quality = isWinner ? (game.scoreDiff > 100 ? 'dominant' : 'winning') : isTie ? 'tied' : 'losing';

      // Skip turns with no meaningful actions
      if (data.actions.length === 0) continue;

      const userMessage = JSON.stringify(data.state);
      const assistantMessage = JSON.stringify(data.actions);

      examples.push({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
          { role: 'assistant', content: assistantMessage },
        ],
        // Metadata (not sent to OpenAI, but useful for filtering)
        _meta: {
          quality,
          turn: turn.turn,
          agent: pid === 0 ? game.agent0 : game.agent1,
          scoreDiff: game.scoreDiff,
        },
      });
    }
  }

  return examples;
}

/**
 * Main execution
 */
function main() {
  console.log(`=== Dataset Generator ===`);
  console.log(`Games: ${NUM_GAMES}, Mode: ${MODE}`);
  console.log(`Matchups: ${MATCHUPS.length} combinations`);
  console.log(`Output: ${finetuneFile}`);
  console.log(`Raw: ${rawFile}\n`);

  const stats = {
    totalGames: 0,
    totalExamples: 0,
    winsByAgent: {},
    qualityCounts: { dominant: 0, winning: 0, tied: 0, losing: 0 },
  };

  for (const key of agentKeys) stats.winsByAgent[key] = 0;

  const gamesPerMatchup = Math.ceil(NUM_GAMES / MATCHUPS.length);

  for (let matchIdx = 0; matchIdx < MATCHUPS.length; matchIdx++) {
    const [a0, a1] = MATCHUPS[matchIdx];

    for (let g = 0; g < gamesPerMatchup; g++) {
      if (stats.totalGames >= NUM_GAMES) break;

      try {
        const game = runGame(a0, a1, MODE);
        stats.totalGames++;

        // Write raw game data (without full turn details for size)
        const rawRecord = {
          gameId: stats.totalGames,
          agent0: game.agent0,
          agent1: game.agent1,
          winner: game.winner,
          score0: game.score0,
          score1: game.score1,
          totalTurns: game.totalTurns,
          mode: game.mode,
        };
        rawStream.write(JSON.stringify(rawRecord) + '\n');

        // Generate fine-tuning examples
        const examples = gameToFineTuneExamples(game);
        for (const ex of examples) {
          stats.totalExamples++;
          stats.qualityCounts[ex._meta.quality]++;

          // Write OpenAI format (strip _meta for actual fine-tuning)
          const openaiRecord = { messages: ex.messages };
          finetuneStream.write(JSON.stringify(openaiRecord) + '\n');
        }

        // Update stats
        if (game.winner === 0) stats.winsByAgent[game.agent0]++;
        else if (game.winner === 1) stats.winsByAgent[game.agent1]++;

        // Progress
        if (stats.totalGames % 10 === 0) {
          process.stdout.write(
            `\rGames: ${stats.totalGames}/${NUM_GAMES} | Examples: ${stats.totalExamples} | Current: ${a0} vs ${a1}`
          );
        }
      } catch (err) {
        console.error(`\nError in game ${stats.totalGames + 1} (${a0} vs ${a1}):`, err.message);
      }
    }
  }

  finetuneStream.end();
  rawStream.end();

  console.log('\n\n=== Dataset Generation Complete ===');
  console.log(`Total games: ${stats.totalGames}`);
  console.log(`Total training examples: ${stats.totalExamples}`);
  console.log(`\nQuality distribution:`);
  for (const [q, count] of Object.entries(stats.qualityCounts)) {
    console.log(`  ${q}: ${count} (${((count / stats.totalExamples) * 100).toFixed(1)}%)`);
  }
  console.log(`\nWin rates:`);
  const totalWins = Object.values(stats.winsByAgent).reduce((a, b) => a + b, 0);
  for (const [agent, wins] of Object.entries(stats.winsByAgent)) {
    console.log(`  ${agent}: ${wins} wins (${((wins / stats.totalGames) * 100).toFixed(1)}%)`);
  }
  console.log(`\nFiles:`);
  console.log(`  Fine-tune: ${finetuneFile}`);
  console.log(`  Raw games: ${rawFile}`);
  console.log(`\nTo fine-tune with OpenAI:`);
  console.log(`  openai api fine_tuning.jobs.create -t ${finetuneFile} -m gpt-4o-mini-2024-07-18`);
}

main();
