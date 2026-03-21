/**
 * MCTS Dataset Generator
 *
 * Runs MCTS with high simulation counts to generate expert data.
 * MCTS searches deeply and finds moves heuristic bots can't.
 * The data is used to train a neural network (knowledge distillation).
 *
 * Usage:
 *   node mcts-generate.js [numGames] [mode] [simsPerTurn]
 *
 * Examples:
 *   node mcts-generate.js 10 tournament 500   # 10 games, 500 sims/turn
 *   node mcts-generate.js 50 blitz 200        # 50 blitz games, 200 sims
 *   node mcts-generate.js                     # defaults: 20 tournament, 500 sims
 *
 * Output:
 *   training/data/mcts_nn_<timestamp>.jsonl - NN training data (features + visit distributions)
 *   training/data/mcts_raw_<timestamp>.jsonl - Game summaries
 */

const path = require('path');
const fs = require('fs');
const logic = require('../logic');
const { MCTSEngine } = require('../agents/mctsEngine');
const smarterAgent = require('../agents/smarterAgent');
const smart2Agent = require('../agents/smart2Agent');
const econAgent = require('../agents/econAgent');

const {
  UNIT_TYPES, UNIT_STATS, ECONOMY, TERRAIN,
  chebyshevDistance, getConnectedTerritory, getTilesAtDistance1, isInZoC, getCityCost,
} = require('../logic');

// Parse args
const args = process.argv.slice(2);
const NUM_GAMES = parseInt(args[0]) || 20;
const MODE = args[1] || 'tournament';
const SIMS_PER_TURN = parseInt(args[2]) || 500;
const ROLLOUT_DEPTH = 20;

// Opponents for MCTS to play against
const OPPONENTS = [
  { name: 'smarter', fn: smarterAgent },
  { name: 'smart2', fn: smart2Agent },
  { name: 'econ', fn: econAgent },
];

// Output
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const timestamp = Date.now();
const nnFile = path.join(dataDir, `mcts_nn_${timestamp}.jsonl`);
const rawFile = path.join(dataDir, `mcts_raw_${timestamp}.jsonl`);

// ============================================================
// Feature encoding (same as generate-expert-data.js)
// ============================================================
function encodeStateForNN(state, playerId) {
  const player = state.players.find(p => p.id === playerId);
  const opponent = state.players.find(p => p.id !== playerId);
  const myUnits = state.units.filter(u => u.owner === playerId);
  const enemyUnits = state.units.filter(u => u.owner !== playerId);
  const myCities = state.cities.filter(c => c.owner === playerId);
  const enemyCities = state.cities.filter(c => c.owner !== null && c.owner !== playerId);
  const myTiles = state.map.tiles.filter(t => t.owner === playerId).length;
  const enemyTiles = state.map.tiles.filter(t => t.owner !== null && t.owner !== playerId).length;

  const mySoldiers = myUnits.filter(u => u.type === 'SOLDIER').length;
  const myArchers = myUnits.filter(u => u.type === 'ARCHER').length;
  const myRaiders = myUnits.filter(u => u.type === 'RAIDER').length;
  const enemySoldiers = enemyUnits.filter(u => u.type === 'SOLDIER').length;
  const enemyArchers = enemyUnits.filter(u => u.type === 'ARCHER').length;
  const enemyRaiders = enemyUnits.filter(u => u.type === 'RAIDER').length;

  const monuments = state.monuments || [];
  const myMonuments = monuments.filter(m => m.controlledBy === playerId).length;
  const enemyMonuments = monuments.filter(m => m.controlledBy !== null && m.controlledBy !== playerId).length;

  const W = state.map.width, H = state.map.height, maxTiles = W * H;

  let myUnitCenterX = 0, myUnitCenterY = 0;
  if (myUnits.length > 0) {
    myUnitCenterX = myUnits.reduce((s, u) => s + u.x, 0) / myUnits.length;
    myUnitCenterY = myUnits.reduce((s, u) => s + u.y, 0) / myUnits.length;
  }
  let enemyUnitCenterX = 0, enemyUnitCenterY = 0;
  if (enemyUnits.length > 0) {
    enemyUnitCenterX = enemyUnits.reduce((s, u) => s + u.x, 0) / enemyUnits.length;
    enemyUnitCenterY = enemyUnits.reduce((s, u) => s + u.y, 0) / enemyUnits.length;
  }

  let avgArmyDist = W;
  if (myUnits.length > 0 && enemyUnits.length > 0) {
    let totalDist = 0, pairs = 0;
    for (const u of myUnits) {
      for (const e of enemyUnits) {
        totalDist += chebyshevDistance(u.x, u.y, e.x, e.y);
        pairs++;
      }
    }
    avgArmyDist = totalDist / pairs;
  }

  let myDistToMonument = W, enemyDistToMonument = W;
  if (monuments.length > 0) {
    if (myUnits.length > 0) myDistToMonument = Math.min(...myUnits.flatMap(u => monuments.map(m => chebyshevDistance(u.x, u.y, m.x, m.y))));
    if (enemyUnits.length > 0) enemyDistToMonument = Math.min(...enemyUnits.flatMap(u => monuments.map(m => chebyshevDistance(u.x, u.y, m.x, m.y))));
  }

  const excess = Math.max(0, myUnits.length - myCities.length);
  const enemyExcess = Math.max(0, enemyUnits.length - enemyCities.length);

  const features = [
    state.turn / state.maxTurns,
    player.gold / 500, player.income / 50, player.score / 1000,
    opponent.gold / 500, opponent.income / 50, opponent.score / 1000,
    myTiles / maxTiles, enemyTiles / maxTiles, (myTiles - enemyTiles) / maxTiles,
    mySoldiers / 10, myArchers / 10, myRaiders / 10, myUnits.length / 20,
    enemySoldiers / 10, enemyArchers / 10, enemyRaiders / 10, enemyUnits.length / 20,
    myCities.length / 6, enemyCities.length / 6,
    myMonuments / 3, enemyMonuments / 3,
    monuments.length > 0 ? (myMonuments - enemyMonuments) / monuments.length : 0,
    excess / 10, enemyExcess / 10,
    myUnitCenterX / W, myUnitCenterY / H,
    enemyUnitCenterX / W, enemyUnitCenterY / H,
    avgArmyDist / W, myDistToMonument / W, enemyDistToMonument / W,
  ];

  const MAX_UNITS = 20;
  for (let i = 0; i < MAX_UNITS; i++) {
    if (i < myUnits.length) {
      const u = myUnits[i];
      features.push(
        u.type === 'SOLDIER' ? 1 : 0, u.type === 'ARCHER' ? 1 : 0, u.type === 'RAIDER' ? 1 : 0,
        u.x / W, u.y / H, u.hp / 2, (u.canMove ?? u.can_move_next_turn ?? true) ? 1 : 0,
      );
    } else features.push(0, 0, 0, 0, 0, 0, 0);
  }

  for (let i = 0; i < MAX_UNITS; i++) {
    if (i < enemyUnits.length) {
      const u = enemyUnits[i];
      features.push(u.type === 'SOLDIER' ? 1 : 0, u.type === 'ARCHER' ? 1 : 0, u.type === 'RAIDER' ? 1 : 0, u.x / W, u.y / H);
    } else features.push(0, 0, 0, 0, 0);
  }

  const MAX_CITIES = 6;
  for (let i = 0; i < MAX_CITIES; i++) {
    if (i < myCities.length) {
      const c = myCities[i];
      features.push(c.x / W, c.y / H, !state.units.some(u => u.x === c.x && u.y === c.y) ? 1 : 0);
    } else features.push(0, 0, 0);
  }

  return features;
}

// ============================================================
// Encode MCTS visit distribution as NN targets
// ============================================================
function encodeVisitsForNN(rootVisits, selectedActions, state, playerId) {
  const myUnits = state.units.filter(u => u.owner === playerId);
  const myCities = state.cities.filter(c => c.owner === playerId);
  const MAX_UNITS = 20, MAX_CITIES = 6;

  // Convert visit counts to probability distribution
  const entries = Object.entries(rootVisits);
  const totalVisits = entries.reduce((s, [, v]) => s + v.visits, 0) || 1;
  const visitDistribution = {};
  for (const [name, data] of entries) {
    visitDistribution[name] = data.visits / totalVisits;
  }

  // Extract build/move/expand decisions from the selected (most-visited) macro-action
  const buildDecisions = new Array(MAX_CITIES).fill(0);
  const moveDecisions = new Array(MAX_UNITS).fill(0);
  let expandCount = 0;
  let buildCity = 0;

  for (const a of selectedActions) {
    if (a.action === 'BUILD_UNIT') {
      const cityIdx = myCities.findIndex(c => c.x === a.city_x && c.y === a.city_y);
      if (cityIdx >= 0 && cityIdx < MAX_CITIES) {
        buildDecisions[cityIdx] = a.unit_type === 'SOLDIER' ? 1 : a.unit_type === 'ARCHER' ? 2 : 3;
      }
    }
    if (a.action === 'MOVE') {
      const unitIdx = myUnits.findIndex(u => u.x === a.from_x && u.y === a.from_y);
      if (unitIdx >= 0 && unitIdx < MAX_UNITS) {
        const dx = Math.sign(a.to_x - a.from_x);
        const dy = Math.sign(a.to_y - a.from_y);
        const dirMap = { '0,0': 0, '0,-1': 1, '1,-1': 2, '1,0': 3, '1,1': 4, '0,1': 5, '-1,1': 6, '-1,0': 7, '-1,-1': 8 };
        moveDecisions[unitIdx] = dirMap[`${dx},${dy}`] || 0;
      }
    }
    if (a.action === 'EXPAND_TERRITORY') expandCount++;
    if (a.action === 'BUILD_CITY') buildCity = 1;
  }

  return {
    buildDecisions,
    moveDecisions,
    expandCount: Math.min(15, expandCount),
    buildCity,
    visitDistribution,   // Full MCTS visit distribution (richer signal)
  };
}

// ============================================================
// Run one MCTS game
// ============================================================
function runMCTSGame(opponentAgent, opponentName, mode, mctsTeam) {
  const engine = new MCTSEngine({
    simulations: SIMS_PER_TURN,
    rolloutDepth: ROLLOUT_DEPTH,
    cExplore: 1.41,
  });

  let state = logic.createInitialState({ mode });
  const turnRecords = [];
  const opponentId = 1 - mctsTeam;
  let totalSimTime = 0;

  while (!state.gameOver) {
    // MCTS player
    const mctsResult = engine.search(state, mctsTeam);
    totalSimTime += mctsResult.timeMs;

    // Record for training
    turnRecords.push({
      turn: state.turn,
      features: encodeStateForNN(state, mctsTeam),
      targets: encodeVisitsForNN(mctsResult.rootVisits, mctsResult.actions, state, mctsTeam),
    });

    // Opponent plays heuristic
    let oppActions;
    try {
      oppActions = opponentAgent.generateActions(state, opponentId);
    } catch { oppActions = []; }

    const actionMap = {
      player0: mctsTeam === 0 ? mctsResult.actions : oppActions,
      player1: mctsTeam === 1 ? mctsResult.actions : oppActions,
    };

    const result = logic.processTurn(state, actionMap);
    state = result.newState;

    // Progress logging
    if (state.turn % 50 === 0) {
      const me = state.players[mctsTeam];
      const opp = state.players[opponentId];
      process.stdout.write(`  t${state.turn} ${me.score}-${opp.score} `);
    }
  }

  const mctsScore = state.players[mctsTeam].score;
  const oppScore = state.players[opponentId].score;

  return {
    won: mctsScore > oppScore,
    mctsScore,
    oppScore,
    opponent: opponentName,
    turns: turnRecords,
    totalTurns: state.turn,
    avgSimTimeMs: Math.round(totalSimTime / state.turn),
  };
}

// ============================================================
// Run MCTS self-play (both sides use MCTS)
// ============================================================
function runMCTSSelfPlay(mode) {
  const engine0 = new MCTSEngine({ simulations: SIMS_PER_TURN, rolloutDepth: ROLLOUT_DEPTH, cExplore: 1.41 });
  const engine1 = new MCTSEngine({ simulations: SIMS_PER_TURN, rolloutDepth: ROLLOUT_DEPTH, cExplore: 1.41 });

  let state = logic.createInitialState({ mode });
  const turnRecords0 = [];
  const turnRecords1 = [];

  while (!state.gameOver) {
    const result0 = engine0.search(state, 0);
    const result1 = engine1.search(state, 1);

    // Record both sides
    turnRecords0.push({
      turn: state.turn,
      features: encodeStateForNN(state, 0),
      targets: encodeVisitsForNN(result0.rootVisits, result0.actions, state, 0),
    });
    turnRecords1.push({
      turn: state.turn,
      features: encodeStateForNN(state, 1),
      targets: encodeVisitsForNN(result1.rootVisits, result1.actions, state, 1),
    });

    const actionMap = { player0: result0.actions, player1: result1.actions };
    const result = logic.processTurn(state, actionMap);
    state = result.newState;

    if (state.turn % 50 === 0) {
      process.stdout.write(`  t${state.turn} ${state.players[0].score}-${state.players[1].score} `);
    }
  }

  const score0 = state.players[0].score;
  const score1 = state.players[1].score;

  return {
    score0, score1,
    winner: score0 > score1 ? 0 : score1 > score0 ? 1 : -1,
    turns0: turnRecords0,
    turns1: turnRecords1,
    totalTurns: state.turn,
  };
}

// ============================================================
// Main
// ============================================================
function main() {
  console.log('=== MCTS Dataset Generator ===');
  console.log(`Games: ${NUM_GAMES} | Mode: ${MODE} | Sims/turn: ${SIMS_PER_TURN} | Rollout: ${ROLLOUT_DEPTH}`);
  console.log(`Output: ${nnFile}\n`);

  const nnStream = fs.createWriteStream(nnFile);
  const rawStream = fs.createWriteStream(rawFile);

  const stats = { games: 0, wins: 0, losses: 0, selfplay: 0, examples: 0 };

  // Split: 70% vs heuristic bots, 30% self-play
  const vsHeuristicGames = Math.ceil(NUM_GAMES * 0.7);
  const selfPlayGames = NUM_GAMES - vsHeuristicGames;

  // --- MCTS vs Heuristic Bots ---
  console.log(`--- Phase 1: MCTS vs Heuristic Bots (${vsHeuristicGames} games) ---\n`);
  const gamesPerOpp = Math.ceil(vsHeuristicGames / OPPONENTS.length);

  for (const opp of OPPONENTS) {
    for (let g = 0; g < gamesPerOpp; g++) {
      if (stats.games >= vsHeuristicGames) break;
      const mctsTeam = g % 2;
      stats.games++;

      console.log(`Game ${stats.games}/${NUM_GAMES}: MCTS(team ${mctsTeam}) vs ${opp.name}`);

      const result = runMCTSGame(opp.fn, opp.name, MODE, mctsTeam);

      if (result.won) {
        stats.wins++;
        // Save winning game data
        for (const turn of result.turns) {
          nnStream.write(JSON.stringify({
            features: turn.features,
            targets: turn.targets,
            turn: turn.turn,
            value: 1.0, // Won the game
          }) + '\n');
          stats.examples++;
        }
        console.log(`\n  WIN ${result.mctsScore}-${result.oppScore} (${result.totalTurns} turns, avg ${result.avgSimTimeMs}ms/turn)`);
      } else {
        stats.losses++;
        // Save losing data with value=0 (still useful for value head)
        for (const turn of result.turns) {
          nnStream.write(JSON.stringify({
            features: turn.features,
            targets: turn.targets,
            turn: turn.turn,
            value: 0.0,
          }) + '\n');
          stats.examples++;
        }
        console.log(`\n  LOSS ${result.mctsScore}-${result.oppScore}`);
      }

      rawStream.write(JSON.stringify({
        gameId: stats.games, type: 'vs_heuristic',
        opponent: opp.name, mctsTeam, won: result.won,
        mctsScore: result.mctsScore, oppScore: result.oppScore,
        totalTurns: result.totalTurns,
      }) + '\n');
    }
  }

  // --- MCTS Self-Play ---
  if (selfPlayGames > 0) {
    console.log(`\n--- Phase 2: MCTS Self-Play (${selfPlayGames} games) ---\n`);

    for (let g = 0; g < selfPlayGames; g++) {
      stats.games++;
      stats.selfplay++;
      console.log(`Game ${stats.games}/${NUM_GAMES}: MCTS Self-Play`);

      const result = runMCTSSelfPlay(MODE);

      // Save BOTH sides with value labels
      const winnerTurns = result.winner === 0 ? result.turns0 : result.turns1;
      const loserTurns = result.winner === 0 ? result.turns1 : result.turns0;

      for (const turn of winnerTurns) {
        nnStream.write(JSON.stringify({
          features: turn.features, targets: turn.targets,
          turn: turn.turn, value: 1.0,
        }) + '\n');
        stats.examples++;
      }
      for (const turn of loserTurns) {
        nnStream.write(JSON.stringify({
          features: turn.features, targets: turn.targets,
          turn: turn.turn, value: 0.0,
        }) + '\n');
        stats.examples++;
      }

      console.log(`\n  ${result.score0}-${result.score1} (winner: ${result.winner === -1 ? 'tie' : 'player ' + result.winner})`);

      rawStream.write(JSON.stringify({
        gameId: stats.games, type: 'self_play',
        score0: result.score0, score1: result.score1,
        winner: result.winner, totalTurns: result.totalTurns,
      }) + '\n');
    }
  }

  nnStream.end();
  rawStream.end();

  console.log('\n=== MCTS Dataset Generation Complete ===');
  console.log(`Games: ${stats.games} (${stats.wins}W-${stats.losses}L vs bots, ${stats.selfplay} self-play)`);
  console.log(`Training examples: ${stats.examples}`);
  console.log(`\nFiles:`);
  console.log(`  NN data: ${nnFile}`);
  console.log(`  Raw:     ${rawFile}`);
  console.log(`\nNext: python train_nn.py ${nnFile}`);
}

main();
