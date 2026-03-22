/**
 * Round-robin tournament between all JS agents
 *
 * Usage: node agents/tournament.js [gamesPerMatch]
 *
 * Each pair plays N games (default 3), alternating sides.
 * Results exported to agents/tournament-results.txt
 */

const fs = require('fs');
const path = require('path');
const logic = require('../logic');

// Load agents from aibgx
const dumbAgent = require('./dumbAgent');
const smart2Agent = require('./smart2Agent');
const smarterAgent = require('./smarterAgent');
const econAgent = require('./econAgent');
const nnAgent = require('./nnAgent');
const mctsAgent = require('./mctsAgent');

// Load agents from aibgx2 (may differ from local versions)
const econAgent2 = require('../../aibgx2/aibgx/agents/econAgent');
const smarterAgent2 = require('../../aibgx2/aibgx/agents/smarterAgent');

const agents = [
  { key: 'nn', agent: nnAgent, name: 'NNBot' },
  { key: 'econ', agent: econAgent, name: 'EconBot' },
  { key: 'smarter', agent: smarterAgent, name: 'SmarterBot' },
  { key: 'smart2', agent: smart2Agent, name: 'Smart2Bot' },
  // { key: 'mcts', agent: mctsAgent, name: 'MCTSBot' },  // too slow for tournament
  { key: 'dumb', agent: dumbAgent, name: 'DumbBot' },
  { key: 'econ2', agent: econAgent2, name: 'EconBot2(aibgx2)' },
  { key: 'smarter2', agent: smarterAgent2, name: 'SmarterBot2(aibgx2)' },
];

const GAMES_PER_MATCH = parseInt(process.argv[2]) || 3;

function runGame(a0, a1) {
  let state = logic.createInitialState({ mode: 'tournament' });
  const p0Id = state.players[0].id;
  const p1Id = state.players[1].id;

  while (state.turn < state.maxTurns) {
    const p0Cities = state.cities.filter((c) => c.owner === p0Id).length;
    const p1Cities = state.cities.filter((c) => c.owner === p1Id).length;
    if (p0Cities === 0 || p1Cities === 0) break;

    let actions0, actions1;
    try {
      actions0 = a0.generateActions(state, p0Id);
    } catch {
      actions0 = [];
    }
    try {
      actions1 = a1.generateActions(state, p1Id);
    } catch {
      actions1 = [];
    }

    const actionMap = {};
    actionMap[`player${p0Id}`] = actions0;
    actionMap[`player${p1Id}`] = actions1;

    try {
      const result = logic.processTurn(state, actionMap);
      state = result.newState;
    } catch {
      break;
    }
  }

  const p0 = state.players.find((p) => p.id === p0Id);
  const p1 = state.players.find((p) => p.id === p1Id);
  return { score0: p0 ? p0.score : 0, score1: p1 ? p1.score : 0, turns: state.turn };
}

// Standings tracker
const standings = {};
for (const a of agents) {
  standings[a.key] = {
    name: a.name,
    wins: 0,
    losses: 0,
    draws: 0,
    totalScore: 0,
    totalOppScore: 0,
    games: 0,
  };
}

const lines = [];
function log(msg) {
  console.log(msg);
  lines.push(msg);
}

log(
  `\n========== TOURNAMENT: ${agents.length} agents, ${GAMES_PER_MATCH} games per match ==========\n`
);

const matchResults = [];

for (let i = 0; i < agents.length; i++) {
  for (let j = i + 1; j < agents.length; j++) {
    const a1 = agents[i];
    const a2 = agents[j];

    let a1Wins = 0,
      a2Wins = 0,
      draws = 0;
    let a1Total = 0,
      a2Total = 0;

    log(`--- ${a1.name} vs ${a2.name} (${GAMES_PER_MATCH} games) ---`);

    for (let g = 0; g < GAMES_PER_MATCH; g++) {
      const a1IsLeft = g % 2 === 0;
      const left = a1IsLeft ? a1.agent : a2.agent;
      const right = a1IsLeft ? a2.agent : a1.agent;

      const result = runGame(left, right);

      const a1Score = a1IsLeft ? result.score0 : result.score1;
      const a2Score = a1IsLeft ? result.score1 : result.score0;
      a1Total += a1Score;
      a2Total += a2Score;

      const side = a1IsLeft ? 'L' : 'R';
      if (a1Score > a2Score) {
        a1Wins++;
        log(`  G${g + 1}: ${a1.name}(${side}) WIN  ${a1Score}-${a2Score}  (${result.turns}t)`);
      } else if (a2Score > a1Score) {
        a2Wins++;
        log(`  G${g + 1}: ${a1.name}(${side}) LOSS ${a1Score}-${a2Score}  (${result.turns}t)`);
      } else {
        draws++;
        log(`  G${g + 1}: ${a1.name}(${side}) DRAW ${a1Score}-${a2Score}  (${result.turns}t)`);
      }
    }

    const matchWinner = a1Wins > a2Wins ? a1.name : a2Wins > a1Wins ? a2.name : 'TIE';
    log(
      `  >> ${a1.name} ${a1Wins}W-${a2Wins}L-${draws}D | Avg: ${(a1Total / GAMES_PER_MATCH).toFixed(0)} vs ${(a2Total / GAMES_PER_MATCH).toFixed(0)} | Match: ${matchWinner}\n`
    );

    matchResults.push({
      a1: a1.name,
      a2: a2.name,
      a1Wins,
      a2Wins,
      draws,
      a1Avg: Math.round(a1Total / GAMES_PER_MATCH),
      a2Avg: Math.round(a2Total / GAMES_PER_MATCH),
    });

    // Update standings
    standings[a1.key].wins += a1Wins;
    standings[a1.key].losses += a2Wins;
    standings[a1.key].draws += draws;
    standings[a1.key].totalScore += a1Total;
    standings[a1.key].totalOppScore += a2Total;
    standings[a1.key].games += GAMES_PER_MATCH;

    standings[a2.key].wins += a2Wins;
    standings[a2.key].losses += a1Wins;
    standings[a2.key].draws += draws;
    standings[a2.key].totalScore += a2Total;
    standings[a2.key].totalOppScore += a1Total;
    standings[a2.key].games += GAMES_PER_MATCH;
  }
}

// Final standings sorted by win rate
log(`\n${'='.repeat(70)}`);
log(`FINAL STANDINGS`);
log(`${'='.repeat(70)}`);

const sorted = Object.values(standings).sort((a, b) => {
  const aRate = a.games > 0 ? a.wins / a.games : 0;
  const bRate = b.games > 0 ? b.wins / b.games : 0;
  if (bRate !== aRate) return bRate - aRate;
  return b.totalScore - b.totalOppScore - (a.totalScore - a.totalOppScore);
});

log(
  `${'Rank'.padEnd(5)} ${'Agent'.padEnd(22)} ${'W'.padStart(3)}-${'L'.padStart(3)}-${'D'.padStart(3)}  ${'Win%'.padStart(6)}  ${'AvgScore'.padStart(8)}  ${'AvgOpp'.padStart(8)}  ${'Diff'.padStart(6)}`
);
log('-'.repeat(70));

sorted.forEach((s, idx) => {
  const winRate = s.games > 0 ? ((s.wins / s.games) * 100).toFixed(1) : '0.0';
  const avgScore = s.games > 0 ? (s.totalScore / s.games).toFixed(0) : '0';
  const avgOpp = s.games > 0 ? (s.totalOppScore / s.games).toFixed(0) : '0';
  const diff = s.games > 0 ? ((s.totalScore - s.totalOppScore) / s.games).toFixed(0) : '0';
  log(
    `${String(idx + 1).padEnd(5)} ${s.name.padEnd(22)} ${String(s.wins).padStart(3)}-${String(s.losses).padStart(3)}-${String(s.draws).padStart(3)}  ${winRate.padStart(5)}%  ${avgScore.padStart(8)}  ${avgOpp.padStart(8)}  ${(diff >= 0 ? '+' : '') + diff}`
  );
});

log(`${'='.repeat(70)}\n`);

// Export to file
const outFile = path.join(__dirname, 'tournament-results.txt');
fs.writeFileSync(outFile, lines.join('\n'), 'utf-8');
log(`Results saved to ${outFile}`);
