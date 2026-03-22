/**
 * Run local matches between JS agents (no server needed)
 *
 * Usage:
 *   node agents/local-match.js [agent1] [agent2] [numGames]
 *
 * Agent types: nn, smarter, econ, dumb
 *
 * Examples:
 *   node agents/local-match.js nn econ 10       # NN vs EconBot, 10 games
 *   node agents/local-match.js nn smarter 5     # NN vs SmarterBot, 5 games
 *   node agents/local-match.js smarter econ 20  # SmarterBot vs EconBot, 20 games
 */

const logic = require('../logic');
const smarterAgent = require('./smarterAgent');
const econAgent = require('./econAgent');
const nnAgent = require('./nnAgent');
const dumbAgent = require('./dumbAgent');

const agents = {
  nn: { agent: nnAgent, name: 'NNBot' },
  smarter: { agent: smarterAgent, name: 'SmarterBot' },
  econ: { agent: econAgent, name: 'EconBot' },
  dumb: { agent: dumbAgent, name: 'DumbBot' },
};

const args = process.argv.slice(2);
const agent1Type = args[0] || 'nn';
const agent2Type = args[1] || 'econ';
const numGames = parseInt(args[2]) || 10;

if (!agents[agent1Type] || !agents[agent2Type]) {
  console.error(`Unknown agent. Available: ${Object.keys(agents).join(', ')}`);
  process.exit(1);
}

const a1 = agents[agent1Type];
const a2 = agents[agent2Type];

function runGame(team0Agent, team1Agent, mode) {
  let state = logic.createInitialState(mode);
  const p0Id = state.players[0].id;
  const p1Id = state.players[1].id;

  while (state.turn < state.maxTurns) {
    // Check elimination
    const p0Cities = state.cities.filter((c) => c.owner === p0Id).length;
    const p1Cities = state.cities.filter((c) => c.owner === p1Id).length;
    if (p0Cities === 0 || p1Cities === 0) break;

    let actions0, actions1;
    try {
      actions0 = team0Agent.generateActions(state, p0Id);
    } catch {
      actions0 = [];
    }
    try {
      actions1 = team1Agent.generateActions(state, p1Id);
    } catch {
      actions1 = [];
    }

    const actionMap = {};
    actionMap[`player${p0Id}`] = actions0;
    actionMap[`player${p1Id}`] = actions1;
    const result = logic.processTurn(state, actionMap);
    state = result.newState;
  }

  const p0 = state.players.find((p) => p.id === p0Id);
  const p1 = state.players.find((p) => p.id === p1Id);
  return { score0: p0 ? p0.score : 0, score1: p1 ? p1.score : 0, turns: state.turn };
}

console.log(`\n${a1.name} vs ${a2.name} — ${numGames} games (tournament mode)\n`);

let a1Wins = 0,
  a2Wins = 0,
  draws = 0;
let a1TotalScore = 0,
  a2TotalScore = 0;

for (let g = 0; g < numGames; g++) {
  // Alternate sides so neither agent always goes first
  const a1IsTeam0 = g % 2 === 0;
  const team0 = a1IsTeam0 ? a1.agent : a2.agent;
  const team1 = a1IsTeam0 ? a2.agent : a1.agent;

  const result = runGame(team0, team1, 'tournament');

  const a1Score = a1IsTeam0 ? result.score0 : result.score1;
  const a2Score = a1IsTeam0 ? result.score1 : result.score0;
  a1TotalScore += a1Score;
  a2TotalScore += a2Score;

  const side = a1IsTeam0 ? 'L' : 'R';
  if (a1Score > a2Score) {
    a1Wins++;
    console.log(
      `  Game ${g + 1}: ${a1.name}(${side}) WIN  ${a1Score} - ${a2Score}  (${result.turns} turns)`
    );
  } else if (a2Score > a1Score) {
    a2Wins++;
    console.log(
      `  Game ${g + 1}: ${a1.name}(${side}) LOSS ${a1Score} - ${a2Score}  (${result.turns} turns)`
    );
  } else {
    draws++;
    console.log(
      `  Game ${g + 1}: ${a1.name}(${side}) DRAW ${a1Score} - ${a2Score}  (${result.turns} turns)`
    );
  }
}

const winRate = ((a1Wins / numGames) * 100).toFixed(1);
console.log(`\n${'='.repeat(50)}`);
console.log(`  ${a1.name}: ${a1Wins}W ${a2Wins}L ${draws}D  (${winRate}% win rate)`);
console.log(
  `  Avg score: ${a1.name} ${(a1TotalScore / numGames).toFixed(0)} vs ${a2.name} ${(a2TotalScore / numGames).toFixed(0)}`
);
console.log(`${'='.repeat(50)}\n`);
