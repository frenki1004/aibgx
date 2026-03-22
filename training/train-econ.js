#!/usr/bin/env node
/**
 * Econ Agent Parallel Training Orchestrator
 *
 * Runs 2 independent workers in parallel, each evolving its own weights:
 *   Worker 0 (port 8080): econ_example.py (learning) vs hybrid Python bot
 *   Worker 1 (port 8081): econ_example.py (learning) vs JS econ agent (fixed)
 *
 * After --games games per worker, prints a summary and picks best weights
 * across both workers, updating agents/econ_best_weights.json.
 *
 * Usage:
 *   node training/train-econ.js [--games=100] [--base-port=8080]
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT       = path.join(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const DATA_DIR   = path.join(__dirname, 'econ_data');

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const get = (flag, def) => {
  const m = argv.find(a => a.startsWith(`--${flag}=`));
  return m ? m.split('=').slice(1).join('=') : def;
};

const TARGET_GAMES = parseInt(get('games', '100'));
const BASE_PORT    = parseInt(get('base-port', '8080'));
const POLL_MS      = 5000;
const SERVER_BOOT  = 3500;

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Process helpers ───────────────────────────────────────────────────────────

function kill(proc, label) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  setTimeout(() => {
    try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch {}
  }, 3000);
  if (label) log(`Stopped ${label}`);
}

function startServer(port) {
  return new Promise(resolve => {
    const proc = spawn('node', [
      path.join(ROOT, 'server', 'server.js'),
      '--tournament', `--port=${port}`, '--max-saves=1',
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', d => {
      if (d.toString().match(/listening|started/i)) resolve(proc);
    });
    proc.stderr.resume();
    proc.on('error', e => { console.error(`[server:${port}]`, e.message); resolve(proc); });
    setTimeout(() => resolve(proc), SERVER_BOOT);
  });
}

function spawnEconBot(port, dataDir, opponent) {
  const env = {
    ...process.env,
    SERVER_URL:        `ws://localhost:${port}`,
    TEAM:              '0',
    BOT_NAME:          'EconBot',
    OPPONENT:          opponent,
    ECON_WEIGHTS_FILE: path.join(dataDir, 'weights.json'),
    ECON_BEST_FILE:    path.join(dataDir, 'best.json'),
    ECON_HISTORY_FILE: path.join(dataDir, 'history.json'),
  };
  const proc = spawn('python3', [path.join(AGENTS_DIR, 'econ_example.py')], {
    cwd: AGENTS_DIR, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.resume();
  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg && !msg.includes('asyncio')) process.stderr.write(`[econ:${port}] ${msg}\n`);
  });
  return proc;
}

function spawnHybridBot(port) {
  const env = {
    ...process.env,
    SERVER_URL: `ws://localhost:${port}`,
    TEAM:       '1',
    BOT_NAME:   'HybridOpp',
  };
  const proc = spawn('python3', [path.join(AGENTS_DIR, 'hybrid_example.py')], {
    cwd: AGENTS_DIR, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.resume();
  proc.stderr.resume();
  return proc;
}

function spawnJSBot(agent, team, port) {
  const proc = spawn('node', [
    path.join(AGENTS_DIR, 'client.js'), agent, String(team), `${agent}Opp`,
  ], {
    cwd: ROOT,
    env: { ...process.env, SERVER_URL: `ws://localhost:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.resume();
  proc.stderr.resume();
  return proc;
}

// ── History helpers ───────────────────────────────────────────────────────────

function readHistory(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

function computeStats(history) {
  if (!history.length) return { games: 0, winRate: 0, fitness: 0 };
  const window = history.slice(-20);
  const wins = window.filter(g => g.outcome === 'win').length;
  const fitness = window.reduce((s, g) => s + (g.score_delta || 0), 0) / window.length;
  return { games: history.length, winRate: (wins / window.length * 100).toFixed(0), fitness: fitness.toFixed(0) };
}

// ── Worker state ──────────────────────────────────────────────────────────────

class Worker {
  constructor(id, port, dataDir, opponent, spawnOpp) {
    this.id       = id;
    this.port     = port;
    this.dataDir  = dataDir;
    this.opponent = opponent;
    this.spawnOpp = spawnOpp;
    this.histFile = path.join(dataDir, 'history.json');
    this.server   = null;
    this.econBot  = null;
    this.oppBot   = null;
    this.done     = false;
    this.lastGames = 0;
  }

  async start() {
    fs.mkdirSync(this.dataDir, { recursive: true });

    // Seed weights from global best if not already present
    const bestSrc = path.join(AGENTS_DIR, 'econ_best_weights.json');
    const weightsFile = path.join(this.dataDir, 'weights.json');
    const bestFile    = path.join(this.dataDir, 'best.json');
    if (!fs.existsSync(weightsFile) && fs.existsSync(bestSrc)) {
      fs.copyFileSync(bestSrc, weightsFile);
      log(`[w${this.id}] Seeded weights from econ_best_weights.json`);
    }
    if (!fs.existsSync(bestFile) && fs.existsSync(bestSrc)) {
      fs.copyFileSync(bestSrc, bestFile);
    }

    log(`[w${this.id}] Starting server on port ${this.port}...`);
    this.server = await startServer(this.port);
    await sleep(500);

    this.econBot = spawnEconBot(this.port, this.dataDir, this.opponent);
    await sleep(600);
    this.oppBot = this.spawnOpp(this.port);

    log(`[w${this.id}] Running econ vs ${this.opponent} on port ${this.port}`);
  }

  checkCrashes() {
    if (this.done) return;
    if (this.econBot && this.econBot.exitCode !== null) {
      log(`[w${this.id}] EconBot crashed (exit ${this.econBot.exitCode}) — restarting`);
      this.econBot = spawnEconBot(this.port, this.dataDir, this.opponent);
    }
    if (this.oppBot && this.oppBot.exitCode !== null) {
      log(`[w${this.id}] Opponent crashed — restarting`);
      this.oppBot = this.spawnOpp(this.port);
    }
  }

  stop() {
    kill(this.econBot, `w${this.id} econ`);
    kill(this.oppBot, `w${this.id} ${this.opponent}`);
    kill(this.server, `w${this.id} server`);
    this.done = true;
  }

  status() {
    const stats = computeStats(readHistory(this.histFile));
    return `w${this.id}[vs ${this.opponent}]: ${stats.games}/${TARGET_GAMES} games | win%=${stats.winRate} | fitness=${stats.fitness}`;
  }
}

// ── Final analysis ────────────────────────────────────────────────────────────

function analyzeFinal(workers) {
  console.log('\n' + '═'.repeat(60));
  console.log('  TRAINING COMPLETE — RESULTS');
  console.log('═'.repeat(60));

  let bestFitness = -Infinity;
  let bestWeightsFile = null;
  let bestWorker = null;

  for (const w of workers) {
    const history = readHistory(w.histFile);
    const stats   = computeStats(history);
    const bestFile = path.join(w.dataDir, 'best.json');

    console.log(`\nWorker ${w.id} (vs ${w.opponent}):`);
    console.log(`  Games played : ${history.length}`);
    console.log(`  Win rate     : ${stats.winRate}% (last 20)`);
    console.log(`  Avg fitness  : ${stats.fitness} (last 20)`);

    // Wins by reason
    const wins  = history.filter(g => g.outcome === 'win');
    const elims = wins.filter(g => g.reason === 'elimination').length;
    const score = wins.filter(g => g.reason !== 'elimination').length;
    console.log(`  Wins         : ${wins.length} (${elims} elim, ${score} score)`);

    // Peak stats
    const peakCities    = Math.max(...history.map(g => g.peak_cities    || 0));
    const peakTerritory = Math.max(...history.map(g => g.peak_territory || 0));
    console.log(`  Peak cities  : ${peakCities}  Peak territory: ${peakTerritory}`);

    const fitness = parseFloat(stats.fitness);
    if (!isNaN(fitness) && fitness > bestFitness && fs.existsSync(bestFile)) {
      bestFitness     = fitness;
      bestWeightsFile = bestFile;
      bestWorker      = w.id;
    }
  }

  // Update global best if we found better weights
  if (bestWeightsFile) {
    const globalBest = path.join(AGENTS_DIR, 'econ_best_weights.json');
    const newWeights = JSON.parse(fs.readFileSync(bestWeightsFile, 'utf8'));
    const oldWeights = fs.existsSync(globalBest)
      ? JSON.parse(fs.readFileSync(globalBest, 'utf8'))
      : {};

    console.log(`\n[Best weights from worker ${bestWorker} (fitness=${bestFitness.toFixed(0)})]`);
    console.log('\nWeight changes from original:');
    for (const [k, v] of Object.entries(newWeights)) {
      const old = oldWeights[k];
      if (old !== undefined) {
        const delta = v - old;
        const sign  = delta >= 0 ? '+' : '';
        console.log(`  ${k.padEnd(20)} ${old.toFixed(2)} → ${v.toFixed(2)}  (${sign}${delta.toFixed(2)})`);
      }
    }

    fs.copyFileSync(bestWeightsFile, globalBest);
    log(`\nUpdated agents/econ_best_weights.json from worker ${bestWorker}`);
  } else {
    log('No improved weights found — global best unchanged');
  }

  console.log('\nTo play with the new weights:');
  console.log('  python3 agents/econ_example.py  (uses econ_best_weights.json automatically)');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        Econ Agent Parallel Training              ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Target games : ${TARGET_GAMES} per worker`);
  console.log(`Workers      : 2`);
  console.log(`Ports        : ${BASE_PORT}, ${BASE_PORT + 1}\n`);

  const workers = [
    new Worker(0, BASE_PORT,     path.join(DATA_DIR, 'w0'), 'hybrid', port => spawnHybridBot(port)),
    new Worker(1, BASE_PORT + 1, path.join(DATA_DIR, 'w1'), 'econ',   port => spawnJSBot('econ', 1, port)),
  ];

  // Graceful shutdown
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log('\nShutting down...');
    for (const w of workers) w.stop();
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  // Start both workers
  await Promise.all(workers.map(w => w.start()));
  log('Both workers running. Press Ctrl+C to stop early.\n');

  // Poll loop
  while (!stopping) {
    await sleep(POLL_MS);
    if (stopping) break;

    let allDone = true;
    for (const w of workers) {
      w.checkCrashes();
      console.log(`  ${w.status()}`);

      const history = readHistory(w.histFile);
      if (history.length >= TARGET_GAMES && !w.done) {
        log(`[w${w.id}] Reached ${TARGET_GAMES} games — stopping worker`);
        w.stop();
      }
      if (!w.done) allDone = false;
    }
    console.log('');

    if (allDone) break;
  }

  if (!stopping) {
    analyzeFinal(workers);
    for (const w of workers) w.stop();
    await sleep(1000);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message, err.stack);
  process.exit(1);
});
