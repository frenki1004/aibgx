/**
 * Self-Play Training Loop
 *
 * The AlphaZero loop for Civilization Clash:
 *   1. MCTS generates data (with or without NN guidance)
 *   2. Train NN on the data
 *   3. NN-guided MCTS generates better data
 *   4. Repeat
 *
 * Usage:
 *   node self-play-loop.js [iterations] [gamesPerIteration] [simsPerTurn]
 *
 * Examples:
 *   node self-play-loop.js 5 20 300     # 5 iterations, 20 games each, 300 sims
 *   node self-play-loop.js              # defaults: 3 iterations, 10 games, 500 sims
 *
 * Requirements:
 *   - Python 3 with torch, numpy, onnx installed
 *   - Enough disk space for data + models
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const ITERATIONS = parseInt(args[0]) || 3;
const GAMES_PER_ITER = parseInt(args[1]) || 50;
const SIMS_PER_TURN = parseInt(args[2]) || 500;
const MODE = 'tournament';

const trainingDir = __dirname;
const dataDir = path.join(trainingDir, 'data');
const modelDir = path.join(trainingDir, 'models');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });

function runCommand(cmd, description) {
  console.log(`\n>>> ${description}`);
  console.log(`    ${cmd}\n`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: trainingDir, timeout: 120 * 60 * 1000 }); // 120 min max per command
    return true;
  } catch (err) {
    console.error(`Command failed: ${err.message}`);
    return false;
  }
}

function findLatestFile(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

function getAllDataFiles() {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir)
    .filter(f => f.startsWith('mcts_nn_') && f.endsWith('.jsonl'))
    .map(f => path.join(dataDir, f));
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   MCTS + NN Self-Play Training Loop      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Iterations: ${ITERATIONS}`);
  console.log(`Games per iteration: ${GAMES_PER_ITER}`);
  console.log(`MCTS sims per turn: ${SIMS_PER_TURN}`);
  console.log(`Mode: ${MODE}\n`);

  const results = [];

  for (let iter = 1; iter <= ITERATIONS; iter++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ITERATION ${iter}/${ITERATIONS}`);
    console.log(`${'='.repeat(60)}`);

    // Step 1: Generate MCTS data
    // First iteration: pure MCTS (no NN). Later: NN-guided MCTS.
    const weightsFile = path.join(modelDir, 'civclash_agent_weights.json');
    const hasNN = iter > 1 && fs.existsSync(weightsFile);

    let generateCmd = `node mcts-generate.js ${GAMES_PER_ITER} ${MODE} ${SIMS_PER_TURN}`;

    if (hasNN) {
      // Pass NN weights path as extra CLI arg — use forward slashes for Windows shell safety
      const safeWeightsPath = weightsFile.replace(/\\/g, '/');
      generateCmd += ` "${safeWeightsPath}"`;
      console.log(`  [NN-guided MCTS: using weights from iteration ${iter - 1}]`);
    }

    const genSuccess = runCommand(generateCmd, `Step 1: Generate MCTS data (${GAMES_PER_ITER} games, ${SIMS_PER_TURN} sims/turn)`);
    if (!genSuccess) {
      console.error('Data generation failed. Stopping.');
      break;
    }

    // Step 2: Train NN on ALL accumulated data
    const allData = getAllDataFiles();
    if (allData.length === 0) {
      console.error('No data files found. Stopping.');
      break;
    }

    const epochs = 75;
    const safeModelDir = modelDir.replace(/\\/g, '/');
    const safeDataArgs = allData.map(f => `"${f.replace(/\\/g, '/')}"`).join(' ');
    const trainCmd = `python train_nn.py ${safeDataArgs} --epochs ${epochs} --lr 0.0003 --output "${safeModelDir}"`;
    const trainSuccess = runCommand(trainCmd, `Step 2: Train NN on ${allData.length} data files (${epochs} epochs)`);
    if (!trainSuccess) {
      console.error('Training failed. Stopping.');
      break;
    }

    // Step 3: Quick evaluation - run NN agent vs heuristic bots
    console.log('\n>>> Step 3: Quick evaluation');

    // Count examples
    let totalExamples = 0;
    for (const f of allData) {
      const lines = fs.readFileSync(f, 'utf-8').trim().split('\n').length;
      totalExamples += lines;
    }

    const iterResult = {
      iteration: iter,
      dataFiles: allData.length,
      totalExamples,
      hasNN,
    };
    results.push(iterResult);

    console.log(`  Data files: ${allData.length}`);
    console.log(`  Total examples: ${totalExamples}`);
    console.log(`  NN weights: ${weightsFile}`);
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('  TRAINING COMPLETE');
  console.log(`${'='.repeat(60)}\n`);

  for (const r of results) {
    console.log(`  Iteration ${r.iteration}: ${r.totalExamples} examples, NN-guided: ${r.hasNN}`);
  }

  console.log(`\nFinal model: ${path.join(modelDir, 'civclash_agent_weights.json')}`);
  console.log(`\nDeploy:\n  node agents/client.js nn 0 NNBot\n  node agents/client.js smarter 1 SmarterBot`);
  const nextIter = ITERATIONS + 3;
  console.log(`\nTo continue training:`);
  console.log(`  node self-play-loop.js ${nextIter} ${GAMES_PER_ITER} ${SIMS_PER_TURN}`);
}

main().catch(console.error);
