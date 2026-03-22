#!/usr/bin/env node
/**
 * Head-to-head eval between two econ weight files.
 *
 * Usage:
 *   node training/eval-econ.js --a=path/to/a.json --b=path/to/b.json \
 *       [--label-a=W0] [--label-b=W1] [--games=6] [--port=8082]
 *
 * Runs --games games with A always team 0, B always team 1 (map is symmetric).
 * Exits with code 0 and prints winner. For ties, exits with code 2.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT       = path.join(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');

// ── CLI ───────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const get = (flag, def) => {
  const m = argv.find(a => a.startsWith(`--${flag}=`));
  return m ? m.split('=').slice(1).join('=') : def;
};

const WEIGHTS_A  = get('a',       path.join(AGENTS_DIR, 'econ_best_weights.json'));
const WEIGHTS_B  = get('b',       path.join(AGENTS_DIR, 'econ_best_weights.json'));
const LABEL_A    = get('label-a', 'A');
const LABEL_B    = get('label-b', 'B');
const GAMES      = parseInt(get('games', '6'));
const PORT       = parseInt(get('port',  '8082'));
const POLL_MS    = 2000;
const GAME_TIMEOUT_MS = 12 * 60 * 1000;  // 12 min per game max

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function kill(proc) {
  if (!proc || proc.exitCode !== null) return;
  try { proc.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch {} }, 2000);
}

function readHistory(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

// ── Process spawning ──────────────────────────────────────────────────────────

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
    proc.on('error', e => console.error(`server: ${e.message}`));
    setTimeout(() => resolve(proc), 3500);
  });
}

function spawnEconBot(team, port, weightsFile, dataDir) {
  // Copy weight files into dataDir so the bot loads and evolves only those copies
  const weightsInDir = path.join(dataDir, 'weights.json');
  const bestInDir    = path.join(dataDir, 'best.json');
  const histFile     = path.join(dataDir, 'history.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(weightsFile, weightsInDir);
  fs.copyFileSync(weightsFile, bestInDir);
  // Seed history as empty array so no prior context
  if (!fs.existsSync(histFile)) fs.writeFileSync(histFile, '[]');

  const env = {
    ...process.env,
    SERVER_URL:        `ws://localhost:${port}`,
    TEAM:              String(team),
    BOT_NAME:          `Econ${team === 0 ? 'A' : 'B'}`,
    OPPONENT:          'eval',
    ECON_WEIGHTS_FILE: weightsInDir,
    ECON_BEST_FILE:    bestInDir,
    ECON_HISTORY_FILE: histFile,
  };

  const proc = spawn('python3', [path.join(AGENTS_DIR, 'econ_example.py')], {
    cwd: AGENTS_DIR, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.resume();
  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg && !msg.startsWith('Traceback') && !msg.includes('asyncio')) return; // suppress noise
  });
  return { proc, histFile };
}

// ── Main eval ─────────────────────────────────────────────────────────────────

async function main() {
  // Validate weight files
  for (const [label, file] of [[LABEL_A, WEIGHTS_A], [LABEL_B, WEIGHTS_B]]) {
    if (!fs.existsSync(file)) {
      console.error(`Weight file not found for ${label}: ${file}`);
      process.exit(1);
    }
  }

  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Econ Agent Head-to-Head Eval       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`${LABEL_A}: ${WEIGHTS_A}`);
  console.log(`${LABEL_B}: ${WEIGHTS_B}`);
  console.log(`Games: ${GAMES} | Port: ${PORT}\n`);

  const tmpBase = path.join(os.tmpdir(), `econ_eval_${Date.now()}`);
  const dirA    = path.join(tmpBase, 'a');
  const dirB    = path.join(tmpBase, 'b');

  log('Starting server...');
  const server = await startServer(PORT);
  await sleep(500);

  const { proc: botA, histFile: histA } = spawnEconBot(0, PORT, WEIGHTS_A, dirA);
  await sleep(600);
  const { proc: botB }                  = spawnEconBot(1, PORT, WEIGHTS_B, dirB);

  log(`Both bots running. Waiting for ${GAMES} games...\n`);

  let aWins = 0, bWins = 0, ties = 0;
  let seen = 0;
  const deadline = Date.now() + GAMES * GAME_TIMEOUT_MS;

  while (seen < GAMES && Date.now() < deadline) {
    await sleep(POLL_MS);
    const history = readHistory(histA);
    while (seen < history.length && seen < GAMES) {
      const g       = history[seen];
      const outcome = g.outcome;
      if (outcome === 'win')        { aWins++; log(`Game ${seen + 1}: ${LABEL_A} wins (delta=${g.score_delta})`); }
      else if (outcome === 'loss')  { bWins++; log(`Game ${seen + 1}: ${LABEL_B} wins (delta=${-g.score_delta})`); }
      else                          { ties++;  log(`Game ${seen + 1}: tie`); }
      seen++;
    }
    if (seen < GAMES) {
      process.stdout.write(`  [${aWins}W-${bWins}L-${ties}T after ${seen}/${GAMES}] waiting...\r`);
    }
  }

  kill(botA);
  kill(botB);
  kill(server);
  await sleep(1000);

  console.log(`\n${'═'.repeat(40)}`);
  console.log('RESULTS');
  console.log('═'.repeat(40));
  console.log(`  ${LABEL_A}: ${aWins} wins`);
  console.log(`  ${LABEL_B}: ${bWins} wins`);
  if (ties) console.log(`  Ties: ${ties}`);

  if (aWins > bWins) {
    console.log(`\nWINNER: ${LABEL_A}`);
    console.log(`WINNER_FILE: ${WEIGHTS_A}`);
    process.exit(0);
  } else if (bWins > aWins) {
    console.log(`\nWINNER: ${LABEL_B}`);
    console.log(`WINNER_FILE: ${WEIGHTS_B}`);
    process.exit(0);
  } else {
    console.log(`\nRESULT: TIE — keeping ${LABEL_A}`);
    console.log(`WINNER_FILE: ${WEIGHTS_A}`);
    process.exit(2);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
