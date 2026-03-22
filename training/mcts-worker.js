/**
 * MCTS Worker Thread
 *
 * Runs individual MCTS games in a separate thread.
 * Receives job messages from the parent, runs game, sends results back.
 */

const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const logic = require('../logic');
const { MCTSEngine } = require('../agents/mctsEngine');
const smarterAgent = require('../agents/smarterAgent');
const { encodeStateForNN, encodeVisitsForNN } = require('./mcts-encoding');

// Redirect console.log to parent
console.log = (...args) => {
  parentPort.postMessage({ type: 'log', message: args.join(' ') });
};
process.stdout.write = (str) => {
  parentPort.postMessage({ type: 'log', message: String(str) });
  return true;
};

// ============================================================
// NN loading (per-worker, independent instance)
// ============================================================
let nnValueFunction = null;
let loadedWeightsPath = null;

function loadNN(weightsPath) {
  if (!weightsPath || loadedWeightsPath === weightsPath) return;
  if (!fs.existsSync(weightsPath)) {
    nnValueFunction = null;
    return;
  }
  try {
    const nnAgent = require('../agents/nnAgent');
    const loaded = nnAgent.loadWeights(weightsPath);
    if (loaded) {
      nnValueFunction = (state, playerId) => {
        try { return nnAgent.getValueEstimate(state, playerId); }
        catch { return null; }
      };
      loadedWeightsPath = weightsPath;
    }
  } catch (e) {
    nnValueFunction = null;
  }
}

// ============================================================
// Run one MCTS game vs heuristic bot
// ============================================================
function runMCTSGame(opponentName, mode, mctsTeam, simsPerTurn, rolloutDepth) {
  const engine = new MCTSEngine({
    simulations: simsPerTurn,
    rolloutDepth,
    timeLimitMs: 200,
    cExplore: 1.41,
    valueFunction: nnValueFunction,
    // opponentFunction: null — use smarterAgent (matches actual game opponent)
  });

  let state = logic.createInitialState({ mode });
  const turnRecords = [];
  const opponentId = 1 - mctsTeam;
  let totalSimTime = 0;
  const gameStartTime = Date.now();
  const MAX_GAME_TIME_MS = 120_000;

  while (!state.gameOver) {
    if (Date.now() - gameStartTime > MAX_GAME_TIME_MS) {
      console.log(`  TIMEOUT after ${state.turn} turns`);
      break;
    }

    let mctsResult;
    try {
      mctsResult = engine.search(state, mctsTeam);
    } catch { mctsResult = { actions: [], rootVisits: {}, timeMs: 0 }; }
    totalSimTime += mctsResult.timeMs;

    if (mctsResult.actions.length > 0) {
      turnRecords.push({
        turn: state.turn,
        features: encodeStateForNN(state, mctsTeam),
        targets: encodeVisitsForNN(mctsResult.rootVisits, mctsResult.actions, state, mctsTeam),
      });
    }

    let oppActions;
    try {
      oppActions = smarterAgent.generateActions(state, opponentId);
    } catch { oppActions = []; }

    const actionMap = {
      player0: mctsTeam === 0 ? mctsResult.actions : oppActions,
      player1: mctsTeam === 1 ? mctsResult.actions : oppActions,
    };

    try {
      const result = logic.processTurn(state, actionMap);
      state = result.newState;
    } catch {
      console.log(`  CRASH at turn ${state.turn}`);
      break;
    }

    if (state.turn % 50 === 0) {
      const me = state.players[mctsTeam];
      const opp = state.players[opponentId];
      process.stdout.write(`  t${state.turn}(${me.score}-${opp.score})`);
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
    avgSimTimeMs: state.turn > 0 ? Math.round(totalSimTime / state.turn) : 0,
  };
}

// ============================================================
// Run MCTS self-play
// ============================================================
function runMCTSSelfPlay(mode, simsPerTurn, rolloutDepth) {
  const engineOpts = {
    simulations: simsPerTurn, rolloutDepth, timeLimitMs: 200, cExplore: 1.41,
    valueFunction: nnValueFunction,
    // opponentFunction: null
  };
  const engine0 = new MCTSEngine(engineOpts);
  const engine1 = new MCTSEngine(engineOpts);

  let state = logic.createInitialState({ mode });
  const turnRecords0 = [];
  const turnRecords1 = [];
  const gameStartTime = Date.now();
  const MAX_GAME_TIME_MS = 180_000;

  while (!state.gameOver) {
    if (Date.now() - gameStartTime > MAX_GAME_TIME_MS) {
      console.log(`  TIMEOUT after ${state.turn} turns`);
      break;
    }

    let result0, result1;
    try { result0 = engine0.search(state, 0); } catch { result0 = { actions: [], rootVisits: {}, timeMs: 0 }; }
    try { result1 = engine1.search(state, 1); } catch { result1 = { actions: [], rootVisits: {}, timeMs: 0 }; }

    if (result0.actions.length > 0) {
      turnRecords0.push({
        turn: state.turn,
        features: encodeStateForNN(state, 0),
        targets: encodeVisitsForNN(result0.rootVisits, result0.actions, state, 0),
      });
    }
    if (result1.actions.length > 0) {
      turnRecords1.push({
        turn: state.turn,
        features: encodeStateForNN(state, 1),
        targets: encodeVisitsForNN(result1.rootVisits, result1.actions, state, 1),
      });
    }

    const actionMap = { player0: result0.actions, player1: result1.actions };
    try {
      const result = logic.processTurn(state, actionMap);
      state = result.newState;
    } catch {
      console.log(`  CRASH at turn ${state.turn}`);
      break;
    }

    if (state.turn % 50 === 0) {
      process.stdout.write(`  t${state.turn}(${state.players[0].score}-${state.players[1].score})`);
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
// Message handler
// ============================================================
parentPort.on('message', (msg) => {
  if (msg.type === 'run_game') {
    try {
      loadNN(msg.nnWeightsPath);

      if (msg.jobType === 'self_play') {
        const result = runMCTSSelfPlay(msg.mode, msg.simsPerTurn, msg.rolloutDepth);
        parentPort.postMessage({
          type: 'game_result',
          gameId: msg.gameId,
          jobType: 'self_play',
          result: { score0: result.score0, score1: result.score1, winner: result.winner, totalTurns: result.totalTurns },
          turnRecords0: result.turns0,
          turnRecords1: result.turns1,
        });
      } else {
        const result = runMCTSGame(msg.opponentName, msg.mode, msg.mctsTeam, msg.simsPerTurn, msg.rolloutDepth);
        parentPort.postMessage({
          type: 'game_result',
          gameId: msg.gameId,
          jobType: 'vs_heuristic',
          result: { won: result.won, mctsScore: result.mctsScore, oppScore: result.oppScore, opponent: result.opponent, totalTurns: result.totalTurns, avgSimTimeMs: result.avgSimTimeMs },
          turnRecords: result.turns,
          mctsTeam: msg.mctsTeam,
        });
      }
    } catch (err) {
      parentPort.postMessage({ type: 'error', gameId: msg.gameId, error: err.message });
    }
  }
});
