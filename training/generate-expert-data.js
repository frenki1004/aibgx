/**
 * Expert Data Generator
 *
 * Uses OpenAI GPT-4o as the "expert" player against heuristic bots.
 * Collects expert decisions from WINNING games only.
 * This data is higher quality than heuristic-vs-heuristic since
 * GPT-4o can reason about strategy beyond hardcoded rules.
 *
 * Output:
 *   training/data/expert_<timestamp>.jsonl  - Expert state→action pairs
 *   training/data/expert_nn_<timestamp>.jsonl - Encoded for NN training
 *
 * Usage:
 *   node generate-expert-data.js [numGames] [mode] [model]
 *
 * Examples:
 *   node generate-expert-data.js 50 tournament gpt-4o
 *   node generate-expert-data.js 100 blitz gpt-4o-mini
 *
 * Environment:
 *   OPENAI_API_KEY - Required
 */

const path = require('path');
const fs = require('fs');
const logic = require('../logic');

let OpenAI;
try {
  OpenAI = require('openai').default || require('openai');
} catch (e) {
  console.error('Install openai: npm install openai');
  process.exit(1);
}

const openai = new OpenAI();

// Heuristic opponents
const smarterAgent = require('../agents/smarterAgent');
const smart2Agent = require('../agents/smart2Agent');
const econAgent = require('../agents/econAgent');

const OPPONENTS = [
  { name: 'smarter', fn: smarterAgent },
  { name: 'smart2', fn: smart2Agent },
  { name: 'econ', fn: econAgent },
];

// Parse args
const args = process.argv.slice(2);
const NUM_GAMES = parseInt(args[0]) || 50;
const MODE = args[1] || 'tournament';
const MODEL = args[2] || 'gpt-4o';

const {
  UNIT_TYPES, UNIT_STATS, ECONOMY, TERRAIN,
  validateAction, getCityCost, getTilesAtDistance1,
  chebyshevDistance, getConnectedTerritory, isInZoC,
} = require('../logic');

// Output files
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const timestamp = Date.now();
const expertFile = path.join(dataDir, `expert_${timestamp}.jsonl`);
const nnFile = path.join(dataDir, `expert_nn_${timestamp}.jsonl`);

// ============================================================
// System prompt — detailed enough for GPT-4o to play well
// ============================================================
const SYSTEM_PROMPT = `You are an expert AI playing Civilization Clash, a 2-player turn-based strategy game.

MAP: Grid of FIELD (passable, ownable), WATER/MOUNTAIN (impassable), MONUMENT (impassable but controllable by adjacent units).

UNITS (hard counter triangle — counters deal 2x = instant kill):
- SOLDIER (20G, HP:2, move:1, melee). Zone of Control radius 2 pins enemy archers/raiders. Captures cities. Immune to ZoC. Kills RAIDER in one hit.
- ARCHER (25G, HP:2, move:1, ranged:2). Fires BEFORE movement phase, can't move after shooting. Kills SOLDIER in one hit.
- RAIDER (15G, HP:1, move:2, melee). Plunders 3x3 enemy tiles (3G each, tiles go neutral). Kills ARCHER in one hit. Does 0 damage to soldiers.

ECONOMY:
- Owned tile: 0.5G/turn. City: 5G/turn. Monument: 3G/turn.
- Expand: 5G, must be adjacent to connected territory, neutral FIELD only.
- Build city: 80G × 1.5^(cities_built). Must be on owned FIELD, no unit there.
- Upkeep: 1 free unit/city. Excess: geometric growth (1.5x per extra unit).

TURN PROCESSING ORDER: 1)Income 2)Archer fire 3)Movement+raids 4)Melee combat 5)Building 6)Scoring

SCORING: Hit=5pts, Kill=7pts, Monument=3pts×total_cities/turn.

CRITICAL STRATEGY:
- Economy first: expand + build 2-4 cities before army
- Counter-pick: see enemy soldiers→build archers, archers→build raiders, raiders→build soldiers
- Soldiers screen in front (ZoC traps ranged/raiders), archers behind
- Raiders: flank to plunder economy, never fight soldiers
- Monuments are HUGE late game (3 × total_cities per turn)
- Never overextend upkeep — check gold before building units

RESPOND WITH ONLY A VALID JSON ARRAY OF ACTIONS. No text, no markdown, no explanation.
Actions:
  {"action":"MOVE","from_x":X,"from_y":Y,"to_x":X,"to_y":Y}
  {"action":"BUILD_UNIT","city_x":X,"city_y":Y,"unit_type":"SOLDIER"|"ARCHER"|"RAIDER"}
  {"action":"EXPAND_TERRITORY","x":X,"y":Y}
  {"action":"BUILD_CITY","x":X,"y":Y}`;

// ============================================================
// State compression for GPT-4o prompt
// ============================================================
function compressStateForPrompt(state, playerId) {
  const player = state.players.find(p => p.id === playerId);
  const opponent = state.players.find(p => p.id !== playerId);

  const myUnits = state.units.filter(u => u.owner === playerId);
  const enemyUnits = state.units.filter(u => u.owner !== playerId);
  const myCities = state.cities.filter(c => c.owner === playerId);
  const enemyCities = state.cities.filter(c => c.owner !== null && c.owner !== playerId);
  const myTiles = state.map.tiles.filter(t => t.owner === playerId).length;
  const enemyTiles = state.map.tiles.filter(t => t.owner !== null && t.owner !== playerId).length;

  // Expandable tiles
  const connected = getConnectedTerritory(state, playerId);
  const expandable = [];
  const seen = new Set();
  for (const tile of state.map.tiles) {
    if (tile.owner !== playerId || !connected.has(`${tile.x},${tile.y}`)) continue;
    for (const adj of getTilesAtDistance1(tile.x, tile.y)) {
      const key = `${adj.x},${adj.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = state.map.tiles.find(tt => tt.x === adj.x && tt.y === adj.y);
      if (t && t.owner === null && t.type === 'FIELD') {
        expandable.push(`(${adj.x},${adj.y})`);
      }
    }
  }

  const emptyCities = myCities.filter(c => !state.units.some(u => u.x === c.x && u.y === c.y));

  // Unit ZoC info
  const unitStrs = myUnits.map(u => {
    const pinned = isInZoC(state, u);
    const canMove = (u.canMove ?? u.can_move_next_turn ?? true) && !pinned;
    return `${u.type}(${u.x},${u.y})hp${u.hp}${canMove ? '' : '[stuck]'}`;
  });

  const enemyStrs = enemyUnits.map(u => `${u.type}(${u.x},${u.y})hp${u.hp}`);

  const cityCost = getCityCost(state, playerId);
  const freeUnits = myCities.length;
  const excess = Math.max(0, myUnits.length - freeUnits);

  return `Turn ${state.turn}/${state.maxTurns} | Map ${state.map.width}x${state.map.height}
Me: ${Math.round(player.gold)}G score:${player.score} income:${Math.round(player.income*10)/10}/turn tiles:${myTiles}
Enemy: ${Math.round(opponent.gold)}G score:${opponent.score} income:${Math.round(opponent.income*10)/10}/turn tiles:${enemyTiles}
My units(${myUnits.length}, ${excess} over free): ${unitStrs.join(' ') || 'none'}
Enemy units(${enemyUnits.length}): ${enemyStrs.join(' ') || 'none'}
My cities(${myCities.length}): ${myCities.map(c=>`(${c.x},${c.y})`).join(' ')} | Empty for building: ${emptyCities.map(c=>`(${c.x},${c.y})`).join(' ')||'none'}
Enemy cities: ${enemyCities.map(c=>`(${c.x},${c.y})`).join(' ')||'hidden'}
Monuments: ${(state.monuments||[]).map(m=>`(${m.x},${m.y}):${m.controlledBy===playerId?'mine':m.controlledBy!==null?'enemy':'none'}`).join(' ')||'none'}
Can expand to(${Math.min(expandable.length,20)} of ${expandable.length}): ${expandable.slice(0,20).join(' ')||'none'}
Costs: unit S=20 A=25 R=15 | expand=5 | next city=${cityCost}`;
}

// ============================================================
// Parse and validate GPT response
// ============================================================
function parseActions(text, state, playerId) {
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const actions = JSON.parse(match[0]);
    if (!Array.isArray(actions)) return [];
    return actions.filter(a => a && a.action && validateAction(state, playerId, a).valid);
  } catch {
    return [];
  }
}

// ============================================================
// Encode state as NN feature vector (for Python training)
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

  // Spatial features
  const mapCenterX = state.map.width / 2;
  const mapCenterY = state.map.height / 2;

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

  // Distance between armies
  let avgArmyDist = state.map.width; // default far
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

  // Distance to nearest monument for each army
  let myDistToMonument = state.map.width;
  let enemyDistToMonument = state.map.width;
  if (monuments.length > 0) {
    if (myUnits.length > 0) {
      myDistToMonument = Math.min(...myUnits.flatMap(u =>
        monuments.map(m => chebyshevDistance(u.x, u.y, m.x, m.y))
      ));
    }
    if (enemyUnits.length > 0) {
      enemyDistToMonument = Math.min(...enemyUnits.flatMap(u =>
        monuments.map(m => chebyshevDistance(u.x, u.y, m.x, m.y))
      ));
    }
  }

  const excess = Math.max(0, myUnits.length - myCities.length);
  const enemyExcess = Math.max(0, enemyUnits.length - enemyCities.length);

  // Normalize features to roughly [0, 1] range
  const W = state.map.width;
  const H = state.map.height;
  const maxTiles = W * H;

  // Global features (32 features)
  const features = [
    // Turn progress
    state.turn / state.maxTurns,

    // Economy (normalized)
    player.gold / 500,
    player.income / 50,
    player.score / 1000,
    opponent.gold / 500,
    opponent.income / 50,
    opponent.score / 1000,

    // Territory
    myTiles / maxTiles,
    enemyTiles / maxTiles,
    (myTiles - enemyTiles) / maxTiles,

    // Unit counts (normalized)
    mySoldiers / 10,
    myArchers / 10,
    myRaiders / 10,
    myUnits.length / 20,
    enemySoldiers / 10,
    enemyArchers / 10,
    enemyRaiders / 10,
    enemyUnits.length / 20,

    // Cities
    myCities.length / 6,
    enemyCities.length / 6,

    // Monuments
    myMonuments / 3,
    enemyMonuments / 3,
    monuments.length > 0 ? (myMonuments - enemyMonuments) / monuments.length : 0,

    // Upkeep pressure
    excess / 10,
    enemyExcess / 10,

    // Spatial
    myUnitCenterX / W,
    myUnitCenterY / H,
    enemyUnitCenterX / W,
    enemyUnitCenterY / H,
    avgArmyDist / W,
    myDistToMonument / W,
    enemyDistToMonument / W,
  ];

  // Per-unit features (up to 20 units × 7 features = 140)
  const MAX_UNITS = 20;
  const UNIT_FEATURES = 7; // type_s, type_a, type_r, x/W, y/H, hp/2, canMove

  for (let i = 0; i < MAX_UNITS; i++) {
    if (i < myUnits.length) {
      const u = myUnits[i];
      features.push(
        u.type === 'SOLDIER' ? 1 : 0,
        u.type === 'ARCHER' ? 1 : 0,
        u.type === 'RAIDER' ? 1 : 0,
        u.x / W,
        u.y / H,
        u.hp / 2,
        (u.canMove ?? u.can_move_next_turn ?? true) ? 1 : 0,
      );
    } else {
      features.push(0, 0, 0, 0, 0, 0, 0);
    }
  }

  // Per-enemy-unit features (up to 20 × 5 = 100)
  const ENEMY_FEATURES = 5;
  for (let i = 0; i < MAX_UNITS; i++) {
    if (i < enemyUnits.length) {
      const u = enemyUnits[i];
      features.push(
        u.type === 'SOLDIER' ? 1 : 0,
        u.type === 'ARCHER' ? 1 : 0,
        u.type === 'RAIDER' ? 1 : 0,
        u.x / W,
        u.y / H,
      );
    } else {
      features.push(0, 0, 0, 0, 0);
    }
  }

  // Per-city features (up to 6 × 3 = 18)
  const MAX_CITIES = 6;
  for (let i = 0; i < MAX_CITIES; i++) {
    if (i < myCities.length) {
      const c = myCities[i];
      const empty = !state.units.some(u => u.x === c.x && u.y === c.y);
      features.push(c.x / W, c.y / H, empty ? 1 : 0);
    } else {
      features.push(0, 0, 0);
    }
  }

  return features; // Total: 32 + 140 + 100 + 18 = 290 features
}

// ============================================================
// Encode expert actions as NN target labels
// ============================================================
function encodeActionsForNN(actions, state, playerId) {
  const myUnits = state.units.filter(u => u.owner === playerId);
  const myCities = state.cities.filter(c => c.owner === playerId);
  const MAX_UNITS = 20;
  const MAX_CITIES = 6;

  // Build head: per-city decision [nothing=0, soldier=1, archer=2, raider=3]
  const buildDecisions = new Array(MAX_CITIES).fill(0);
  for (const a of actions) {
    if (a.action === 'BUILD_UNIT') {
      const cityIdx = myCities.findIndex(c => c.x === a.city_x && c.y === a.city_y);
      if (cityIdx >= 0 && cityIdx < MAX_CITIES) {
        buildDecisions[cityIdx] = a.unit_type === 'SOLDIER' ? 1 : a.unit_type === 'ARCHER' ? 2 : 3;
      }
    }
  }

  // Move head: per-unit direction [stay=0, N=1, NE=2, E=3, SE=4, S=5, SW=6, W=7, NW=8]
  // For raiders with move 2: encode as direction (same 9 options but double step)
  const moveDecisions = new Array(MAX_UNITS).fill(0);
  for (const a of actions) {
    if (a.action === 'MOVE') {
      const unitIdx = myUnits.findIndex(u => u.x === a.from_x && u.y === a.from_y);
      if (unitIdx >= 0 && unitIdx < MAX_UNITS) {
        const dx = Math.sign(a.to_x - a.from_x);
        const dy = Math.sign(a.to_y - a.from_y);
        // Encode direction: 0=stay, 1=N(0,-1), 2=NE(1,-1), 3=E(1,0), 4=SE(1,1), 5=S(0,1), 6=SW(-1,1), 7=W(-1,0), 8=NW(-1,-1)
        const dirMap = {
          '0,0': 0, '0,-1': 1, '1,-1': 2, '1,0': 3, '1,1': 4,
          '0,1': 5, '-1,1': 6, '-1,0': 7, '-1,-1': 8,
        };
        moveDecisions[unitIdx] = dirMap[`${dx},${dy}`] || 0;
      }
    }
  }

  // Expand head: number of expand actions (0-15)
  const expandCount = Math.min(15, actions.filter(a => a.action === 'EXPAND_TERRITORY').length);

  // City build head: 0 or 1
  const buildCity = actions.some(a => a.action === 'BUILD_CITY') ? 1 : 0;

  return {
    buildDecisions,   // [MAX_CITIES] - categorical per city
    moveDecisions,    // [MAX_UNITS] - categorical per unit
    expandCount,      // scalar 0-15
    buildCity,        // binary
  };
}

// ============================================================
// Call GPT-4o for expert decisions
// ============================================================
async function getExpertActions(state, playerId) {
  const prompt = compressStateForPrompt(state, playerId);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 2000,
      });

      const content = response.choices[0]?.message?.content || '[]';
      const actions = parseActions(content, state, playerId);
      const usage = response.usage || {};

      return { actions, content, tokens: usage.total_tokens || 0 };
    } catch (err) {
      console.error(`  API error (attempt ${attempt + 1}): ${err.message}`);
      if (attempt === 2) return null;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null;
}

// ============================================================
// Run one game: GPT-4o (expert) vs heuristic opponent
// ============================================================
async function runExpertGame(opponentAgent, opponentName, mode, expertTeam) {
  let state = logic.createInitialState({ mode });
  const turnRecords = [];
  let totalTokens = 0;
  let fallbackTurns = 0;

  while (!state.gameOver) {
    const vision0 = logic.computeVision(state, 0);
    const vision1 = logic.computeVision(state, 1);
    const state0 = logic.filterStateForPlayer(state, 0, vision0);
    const state1 = logic.filterStateForPlayer(state, 1, vision1);

    let expertActions, opponentActions;
    const expertState = expertTeam === 0 ? state0 : state1;
    const oppState = expertTeam === 0 ? state1 : state0;

    // Expert (GPT-4o) plays
    const expertResult = await getExpertActions(expertState, expertTeam);

    if (expertResult && expertResult.actions.length > 0) {
      expertActions = expertResult.actions;
      totalTokens += expertResult.tokens;

      // Record this turn for training
      turnRecords.push({
        turn: state.turn,
        state: expertState,
        statePrompt: compressStateForPrompt(expertState, expertTeam),
        actions: expertActions,
        rawResponse: expertResult.content,
        features: encodeStateForNN(expertState, expertTeam),
        targets: encodeActionsForNN(expertActions, expertState, expertTeam),
      });
    } else {
      // Fallback to heuristic if API fails
      expertActions = smarterAgent.generateActions(expertState, expertTeam);
      fallbackTurns++;
    }

    // Opponent plays with heuristic
    try {
      opponentActions = opponentAgent.generateActions(oppState, 1 - expertTeam);
    } catch {
      opponentActions = [];
    }

    const actionMap = {
      player0: expertTeam === 0 ? expertActions : opponentActions,
      player1: expertTeam === 1 ? expertActions : opponentActions,
    };

    const result = logic.processTurn(state, actionMap);
    state = result.newState;

    // Brief progress per turn
    if (state.turn % 50 === 0) {
      const ep = state.players[expertTeam];
      const op = state.players[1 - expertTeam];
      process.stdout.write(`  t${state.turn} expert:${ep.score} opp:${op.score} | `);
    }
  }

  const expertScore = state.players[expertTeam].score;
  const oppScore = state.players[1 - expertTeam].score;
  const won = expertScore > oppScore;

  return {
    won,
    expertScore,
    oppScore,
    opponent: opponentName,
    turns: turnRecords,
    totalTurns: state.turn,
    totalTokens,
    fallbackTurns,
  };
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('=== Expert Data Generator ===');
  console.log(`Model: ${MODEL} | Games: ${NUM_GAMES} | Mode: ${MODE}`);
  console.log(`Opponents: ${OPPONENTS.map(o => o.name).join(', ')}\n`);

  const expertStream = fs.createWriteStream(expertFile);
  const nnStream = fs.createWriteStream(nnFile);

  const stats = {
    totalGames: 0,
    wins: 0,
    losses: 0,
    totalExamples: 0,
    totalTokens: 0,
    totalFallbacks: 0,
  };

  const gamesPerOpponent = Math.ceil(NUM_GAMES / OPPONENTS.length);

  for (const opp of OPPONENTS) {
    for (let g = 0; g < gamesPerOpponent; g++) {
      if (stats.totalGames >= NUM_GAMES) break;

      // Alternate sides for fairness
      const expertTeam = g % 2;
      stats.totalGames++;

      console.log(`Game ${stats.totalGames}/${NUM_GAMES}: Expert(team ${expertTeam}) vs ${opp.name}`);

      const result = await runExpertGame(opp.fn, opp.name, MODE, expertTeam);

      stats.totalTokens += result.totalTokens;
      stats.totalFallbacks += result.fallbackTurns;

      if (result.won) {
        stats.wins++;
        console.log(`  WIN ${result.expertScore}-${result.oppScore} (${result.turns.length} expert turns, ${result.totalTokens} tokens)`);

        // Save expert turns from winning games only
        for (const turn of result.turns) {
          stats.totalExamples++;

          // Fine-tuning format
          expertStream.write(JSON.stringify({
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: turn.statePrompt },
              { role: 'assistant', content: JSON.stringify(turn.actions) },
            ],
          }) + '\n');

          // NN training format
          nnStream.write(JSON.stringify({
            features: turn.features,
            targets: turn.targets,
            turn: turn.turn,
          }) + '\n');
        }
      } else {
        stats.losses++;
        console.log(`  LOSS ${result.expertScore}-${result.oppScore} (discarded)`);
      }

      // Cost estimate (GPT-4o pricing: $2.50/M input, $10/M output)
      const estCost = (stats.totalTokens * 5) / 1_000_000; // rough avg
      console.log(`  Running: ${stats.wins}W-${stats.losses}L | ${stats.totalExamples} examples | ~$${estCost.toFixed(2)} spent\n`);
    }
  }

  expertStream.end();
  nnStream.end();

  console.log('\n=== Expert Data Generation Complete ===');
  console.log(`Games: ${stats.totalGames} (${stats.wins}W-${stats.losses}L, ${((stats.wins/stats.totalGames)*100).toFixed(0)}% win rate)`);
  console.log(`Training examples: ${stats.totalExamples} (from winning games only)`);
  console.log(`Total tokens: ${stats.totalTokens} | Fallback turns: ${stats.totalFallbacks}`);
  console.log(`\nFiles:`);
  console.log(`  Fine-tune JSONL:  ${expertFile}`);
  console.log(`  NN training data: ${nnFile}`);
  console.log(`\nNext steps:`);
  console.log(`  Fine-tune OpenAI: node finetune.js upload ${expertFile}`);
  console.log(`  Train local NN:   python train_nn.py ${nnFile}`);
}

main().catch(console.error);
