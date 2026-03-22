/**
 * MCTS Dataset Generator (with Worker Threads)
 *
 * Runs MCTS with high simulation counts to generate expert data.
 * Supports parallel game generation via worker threads.
 *
 * Usage:
 *   node mcts-generate.js [numGames] [mode] [simsPerTurn] [nnWeightsPath] [--workers=N] [--no-workers]
 *
 * Examples:
 *   node mcts-generate.js 50 tournament 300             # 50 games, auto worker count
 *   node mcts-generate.js 50 tournament 300 --workers=4 # 4 workers
 *   node mcts-generate.js 20 tournament 500 --no-workers # sequential mode
 *
 * Output:
 *   training/data/mcts_nn_<timestamp>.jsonl - NN training data
 *   training/data/mcts_raw_<timestamp>.jsonl - Game summaries
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');
const logic = require('../logic');
const { MCTSEngine } = require('../agents/mctsEngine');
const smarterAgent = require('../agents/smarterAgent');
const econAgent = require('../agents/econAgent');
const { encodeStateForNN, encodeVisitsForNN } = require('./mcts-encoding');

// Parse args — separate positional from flags
const args = process.argv.slice(2);
const positionalArgs = args.filter((a) => !a.startsWith('--'));
const NUM_GAMES = parseInt(positionalArgs[0]) || 20;
const MODE = positionalArgs[1] || 'tournament';
const SIMS_PER_TURN = parseInt(positionalArgs[2]) || 500;
const ROLLOUT_DEPTH = 4;
const NN_WEIGHTS_PATH =
  positionalArgs[3] || path.join(__dirname, 'models', 'civclash_agent_weights.json');

const NO_WORKERS = args.includes('--no-workers');
const WORKER_COUNT_FLAG = args.find((a) => a.startsWith('--workers='));
const MAX_WORKERS = WORKER_COUNT_FLAG
  ? parseInt(WORKER_COUNT_FLAG.split('=')[1])
  : Math.min(os.cpus().length - 1, 6);
const USE_WORKERS = !NO_WORKERS && MAX_WORKERS > 1 && NUM_GAMES > 1;

// ============================================================
// Load NN for sequential mode (workers load their own)
// ============================================================
let nnValueFunction = null;

if (!USE_WORKERS) {
  try {
    if (fs.existsSync(NN_WEIGHTS_PATH)) {
      const nnAgent = require('../agents/nnAgent');
      const loaded = nnAgent.loadWeights(NN_WEIGHTS_PATH);
      if (loaded) {
        console.log(`[NN-MCTS] Loaded NN weights from ${NN_WEIGHTS_PATH}`);
        console.log(`[NN-MCTS] MCTS will use NN value head (smarterAgent as opponent model)`);
        nnValueFunction = (state, playerId) => {
          try {
            return nnAgent.getValueEstimate(state, playerId);
          } catch {
            return null;
          }
        };
      } else {
        console.log(`[NN-MCTS] Failed to load NN from ${NN_WEIGHTS_PATH}, using pure heuristic`);
      }
    } else {
      console.log(`[NN-MCTS] No weights file at ${NN_WEIGHTS_PATH}, using pure heuristic MCTS`);
    }
  } catch (e) {
    console.log(`[NN-MCTS] No NN available (${e.message}), using pure heuristic MCTS`);
  }
}

// Output
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const timestamp = Date.now();
const nnFile = path.join(dataDir, `mcts_nn_${timestamp}.jsonl`);
const rawFile = path.join(dataDir, `mcts_raw_${timestamp}.jsonl`);

// ============================================================
// Sequential game functions (fallback when --no-workers)
// ============================================================
function runMCTSGame(opponentAgent, opponentName, mode, mctsTeam) {
  const engine = new MCTSEngine({
    simulations: SIMS_PER_TURN,
    rolloutDepth: ROLLOUT_DEPTH,
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
      console.log(`\n  TIMEOUT after ${state.turn} turns`);
      break;
    }

    let mctsResult;
    try {
      mctsResult = engine.search(state, mctsTeam);
    } catch {
      mctsResult = { actions: [], rootVisits: {}, timeMs: 0 };
    }
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
      oppActions = opponentAgent.generateActions(state, opponentId);
    } catch {
      oppActions = [];
    }

    const actionMap = {
      player0: mctsTeam === 0 ? mctsResult.actions : oppActions,
      player1: mctsTeam === 1 ? mctsResult.actions : oppActions,
    };

    try {
      const result = logic.processTurn(state, actionMap);
      state = result.newState;
    } catch {
      console.log(`\n  CRASH at turn ${state.turn}`);
      break;
    }

    if (state.turn % 10 === 0) {
      const me = state.players[mctsTeam];
      const opp = state.players[opponentId];
      process.stdout.write(`  t${state.turn}(${me.score}-${opp.score}) `);
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

function runMCTSSelfPlay(mode) {
  const engineOpts = {
    simulations: SIMS_PER_TURN,
    rolloutDepth: ROLLOUT_DEPTH,
    timeLimitMs: 200,
    cExplore: 1.41,
    valueFunction: nnValueFunction,
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
      console.log(`\n  TIMEOUT after ${state.turn} turns`);
      break;
    }

    let result0, result1;
    try {
      result0 = engine0.search(state, 0);
    } catch {
      result0 = { actions: [], rootVisits: {}, timeMs: 0 };
    }
    try {
      result1 = engine1.search(state, 1);
    } catch {
      result1 = { actions: [], rootVisits: {}, timeMs: 0 };
    }

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
      console.log(`\n  CRASH at turn ${state.turn}`);
      break;
    }

    if (state.turn % 10 === 0) {
      process.stdout.write(
        `  t${state.turn}(${state.players[0].score}-${state.players[1].score}) `
      );
    }
  }

  return {
    score0: state.players[0].score,
    score1: state.players[1].score,
    winner:
      state.players[0].score > state.players[1].score
        ? 0
        : state.players[1].score > state.players[0].score
          ? 1
          : -1,
    turns0: turnRecords0,
    turns1: turnRecords1,
    totalTurns: state.turn,
  };
}

// ============================================================
// Worker pool
// ============================================================
function runWithWorkers(jobs) {
  return new Promise((resolveAll) => {
    const workerCount = Math.min(MAX_WORKERS, jobs.length);
    const workers = [];
    const results = [];
    let nextJob = 0;
    let completed = 0;
    const total = jobs.length;

    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(path.join(__dirname, 'mcts-worker.js'));

      w.on('message', (msg) => {
        if (msg.type === 'log') {
          process.stdout.write(`[W${i}] ${msg.message}`);
          return;
        }
        if (msg.type === 'game_result') {
          completed++;
          const r = msg.result;
          if (msg.jobType === 'vs_heuristic') {
            const outcome = r.won ? 'WIN' : 'LOSS';
            console.log(
              `  Game ${completed}/${total}: ${outcome} ${r.mctsScore}-${r.oppScore} (${r.totalTurns}t)`
            );
          } else {
            console.log(
              `  Game ${completed}/${total}: Self-Play ${r.score0}-${r.score1} (${r.totalTurns}t)`
            );
          }
          results.push(msg);
          dispatchNext(i);
        }
        if (msg.type === 'error') {
          completed++;
          console.log(`  Game ${completed}/${total}: ERROR - ${msg.error}`);
          dispatchNext(i);
        }
      });

      w.on('error', (err) => {
        console.error(`Worker ${i} error: ${err.message}`);
        completed++;
        dispatchNext(i);
      });

      w.on('exit', (code) => {
        if (code !== 0 && code !== 1) {
          console.error(`Worker ${i} exited with code ${code}`);
        }
      });

      workers.push(w);
    }

    function dispatchNext(workerIdx) {
      if (nextJob < jobs.length) {
        workers[workerIdx].postMessage(jobs[nextJob]);
        nextJob++;
      } else if (completed >= total) {
        // All done — terminate workers
        for (const w of workers) w.terminate();
        resolveAll(results);
      }
    }

    // Dispatch initial batch
    for (let i = 0; i < workerCount && i < jobs.length; i++) {
      workers[i].postMessage(jobs[nextJob]);
      nextJob++;
    }
  });
}

// ============================================================
// Write game results to streams
// ============================================================
function writeGameResult(msg, nnStream, rawStream, stats) {
  stats.games++;

  if (msg.jobType === 'vs_heuristic') {
    const r = msg.result;
    if (r.won) stats.wins++;
    else stats.losses++;
    // Score-margin value: reward domination, not just winning
    // 0.5 = draw, 1.0 = crushing win, 0.0 = crushing loss
    const scoreDiff = r.mctsScore - r.oppScore;
    const totalScore = Math.max(r.mctsScore + r.oppScore, 1);
    const value = Math.max(
      0.05,
      Math.min(0.95, 0.5 + 0.5 * Math.tanh(scoreDiff / (totalScore * 0.3)))
    );

    for (const turn of msg.turnRecords) {
      nnStream.write(
        JSON.stringify({
          features: turn.features,
          targets: turn.targets,
          turn: turn.turn,
          value,
        }) + '\n'
      );
      stats.examples++;
    }

    rawStream.write(
      JSON.stringify({
        gameId: msg.gameId,
        type: 'vs_heuristic',
        opponent: r.opponent,
        mctsTeam: msg.mctsTeam,
        won: r.won,
        mctsScore: r.mctsScore,
        oppScore: r.oppScore,
        totalTurns: r.totalTurns,
      }) + '\n'
    );
  } else if (msg.jobType === 'self_play') {
    stats.selfplay++;
    const r = msg.result;

    // Score-margin values for both sides
    const scoreDiff0 = r.score0 - r.score1;
    const totalScore = Math.max(r.score0 + r.score1, 1);
    const value0 = Math.max(
      0.05,
      Math.min(0.95, 0.5 + 0.5 * Math.tanh(scoreDiff0 / (totalScore * 0.3)))
    );
    const value1 = 1.0 - value0;

    for (const turn of msg.turnRecords0 || []) {
      nnStream.write(
        JSON.stringify({
          features: turn.features,
          targets: turn.targets,
          turn: turn.turn,
          value: value0,
        }) + '\n'
      );
      stats.examples++;
    }
    for (const turn of msg.turnRecords1 || []) {
      nnStream.write(
        JSON.stringify({
          features: turn.features,
          targets: turn.targets,
          turn: turn.turn,
          value: value1,
        }) + '\n'
      );
      stats.examples++;
    }

    rawStream.write(
      JSON.stringify({
        gameId: msg.gameId,
        type: 'self_play',
        score0: r.score0,
        score1: r.score1,
        winner: r.winner,
        totalTurns: r.totalTurns,
      }) + '\n'
    );
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  const hasNN = fs.existsSync(NN_WEIGHTS_PATH);
  console.log('=== MCTS Dataset Generator ===');
  console.log(
    `Games: ${NUM_GAMES} | Mode: ${MODE} | Sims/turn: ${SIMS_PER_TURN} | Rollout: ${ROLLOUT_DEPTH}`
  );
  console.log(`NN: ${hasNN ? NN_WEIGHTS_PATH : 'none (pure heuristic)'}`);
  console.log(`Workers: ${USE_WORKERS ? MAX_WORKERS : 'disabled (sequential)'}`);
  console.log(`Output: ${nnFile}\n`);

  const nnStream = fs.createWriteStream(nnFile);
  const rawStream = fs.createWriteStream(rawFile);
  const stats = { games: 0, wins: 0, losses: 0, selfplay: 0, examples: 0 };

  // Build job list
  // 40% econ, 40% smarter, 20% self-play
  const vsHeuristicGames = Math.ceil(NUM_GAMES * 0.8);
  const selfPlayGames = NUM_GAMES - vsHeuristicGames;
  const jobs = [];
  let gameId = 0;

  const opponents = ['econ', 'smarter'];
  for (let g = 0; g < vsHeuristicGames; g++) {
    gameId++;
    jobs.push({
      type: 'run_game',
      gameId,
      jobType: 'vs_heuristic',
      opponentName: opponents[g % opponents.length],
      mode: MODE,
      mctsTeam: g % 2,
      nnWeightsPath: hasNN ? NN_WEIGHTS_PATH : null,
      simsPerTurn: SIMS_PER_TURN,
      rolloutDepth: ROLLOUT_DEPTH,
    });
  }

  for (let g = 0; g < selfPlayGames; g++) {
    gameId++;
    jobs.push({
      type: 'run_game',
      gameId,
      jobType: 'self_play',
      mode: MODE,
      nnWeightsPath: hasNN ? NN_WEIGHTS_PATH : null,
      simsPerTurn: SIMS_PER_TURN,
      rolloutDepth: ROLLOUT_DEPTH,
    });
  }

  if (USE_WORKERS) {
    // --- Parallel mode ---
    console.log(
      `--- Running ${jobs.length} games with ${Math.min(MAX_WORKERS, jobs.length)} workers ---\n`
    );
    const results = await runWithWorkers(jobs);

    // Write results sorted by gameId
    results.sort((a, b) => a.gameId - b.gameId);
    for (const msg of results) {
      writeGameResult(msg, nnStream, rawStream, stats);
    }
  } else {
    // --- Sequential mode (original behavior) ---
    console.log(`--- Phase 1: MCTS vs Heuristic Bots (${vsHeuristicGames} games) ---\n`);

    // 50/50 econ and smarter
    const seqOpponents = [
      { agent: econAgent, name: 'econ' },
      { agent: smarterAgent, name: 'smarter' },
    ];
    for (let g = 0; g < vsHeuristicGames; g++) {
      const mctsTeam = g % 2;
      const opp = seqOpponents[g % seqOpponents.length];
      stats.games++;
      console.log(`Game ${stats.games}/${NUM_GAMES}: MCTS(team ${mctsTeam}) vs ${opp.name}`);

      const result = runMCTSGame(opp.agent, opp.name, MODE, mctsTeam);

      if (result.won) stats.wins++;
      else stats.losses++;
      const scoreDiff = result.mctsScore - result.oppScore;
      const totalScore = Math.max(result.mctsScore + result.oppScore, 1);
      const value = Math.max(
        0.05,
        Math.min(0.95, 0.5 + 0.5 * Math.tanh(scoreDiff / (totalScore * 0.3)))
      );
      for (const turn of result.turns) {
        nnStream.write(
          JSON.stringify({
            features: turn.features,
            targets: turn.targets,
            turn: turn.turn,
            value,
          }) + '\n'
        );
        stats.examples++;
      }
      console.log(
        `\n  ${result.won ? 'WIN' : 'LOSS'} ${result.mctsScore}-${result.oppScore} (${result.totalTurns} turns, avg ${result.avgSimTimeMs}ms/turn)`
      );

      rawStream.write(
        JSON.stringify({
          gameId: stats.games,
          type: 'vs_heuristic',
          opponent: opp.name,
          mctsTeam,
          won: result.won,
          mctsScore: result.mctsScore,
          oppScore: result.oppScore,
          totalTurns: result.totalTurns,
        }) + '\n'
      );
    }

    if (selfPlayGames > 0) {
      console.log(`\n--- Phase 2: MCTS Self-Play (${selfPlayGames} games) ---\n`);

      for (let g = 0; g < selfPlayGames; g++) {
        stats.games++;
        stats.selfplay++;
        console.log(`Game ${stats.games}/${NUM_GAMES}: MCTS Self-Play`);

        const result = runMCTSSelfPlay(MODE);

        const sd = result.score0 - result.score1;
        const ts = Math.max(result.score0 + result.score1, 1);
        const val0 = Math.max(0.05, Math.min(0.95, 0.5 + 0.5 * Math.tanh(sd / (ts * 0.3))));
        const val1 = 1.0 - val0;

        for (const turn of result.turns0) {
          nnStream.write(
            JSON.stringify({
              features: turn.features,
              targets: turn.targets,
              turn: turn.turn,
              value: val0,
            }) + '\n'
          );
          stats.examples++;
        }
        for (const turn of result.turns1) {
          nnStream.write(
            JSON.stringify({
              features: turn.features,
              targets: turn.targets,
              turn: turn.turn,
              value: val1,
            }) + '\n'
          );
          stats.examples++;
        }

        console.log(
          `\n  ${result.score0}-${result.score1} (winner: ${result.winner === -1 ? 'tie' : 'player ' + result.winner})`
        );

        rawStream.write(
          JSON.stringify({
            gameId: stats.games,
            type: 'self_play',
            score0: result.score0,
            score1: result.score1,
            winner: result.winner,
            totalTurns: result.totalTurns,
          }) + '\n'
        );
      }
    }
  }

  nnStream.end();
  rawStream.end();

  console.log('\n=== MCTS Dataset Generation Complete ===');
  console.log(
    `Games: ${stats.games} (${stats.wins}W-${stats.losses}L vs bots, ${stats.selfplay} self-play)`
  );
  console.log(`Training examples: ${stats.examples}`);
  console.log(`\nFiles:`);
  console.log(`  NN data: ${nnFile}`);
  console.log(`  Raw:     ${rawFile}`);
  console.log(`\nNext: python train_nn.py ${nnFile}`);
}

main().catch(console.error);
