/**
 * Neural Network Agent for Civilization Clash
 *
 * Loads a trained NN (from JSON weights exported by train_nn.py)
 * and runs inference locally. Zero API cost, ~1ms per turn.
 *
 * The NN was trained on GPT-4o expert data via knowledge distillation:
 *   GPT-4o plays games → collect winning decisions → train small NN → deploy
 *
 * Usage:
 *   node client.js nn 0 NNBot
 *
 * Environment:
 *   NN_WEIGHTS - Path to weights file (default: training/models/civclash_agent_weights.json)
 */

const fs = require('fs');
const path = require('path');

const {
  ACTIONS, UNIT_TYPES, UNIT_STATS, ECONOMY, TERRAIN,
  validateAction, getCityCost, getTilesAtDistance1,
  chebyshevDistance, isInZoC, getConnectedTerritory,
} = require('../logic');

// Fallback
const smarterAgent = require('./smarterAgent');

// ============================================================
// Pure JS Neural Network Inference (no dependencies)
// ============================================================

class SimpleNN {
  constructor(weightsPath) {
    this.weights = null;
    this.loaded = false;

    try {
      const raw = fs.readFileSync(weightsPath, 'utf-8');
      this.weights = JSON.parse(raw);
      this.loaded = true;
      console.log(`[NN] Loaded weights from ${weightsPath}`);
    } catch (e) {
      console.error(`[NN] Failed to load weights: ${e.message}`);
      console.error(`[NN] Run: python training/train_nn.py training/data/expert_nn_*.jsonl`);
    }
  }

  // Matrix multiply: (1, in) × (out, in)^T → (1, out), then add bias
  linear(input, weightKey, biasKey) {
    const W = this.weights[weightKey]; // [out_dim][in_dim]
    const b = this.weights[biasKey];   // [out_dim]
    const outDim = W.length;

    const output = new Array(outDim);
    for (let i = 0; i < outDim; i++) {
      let sum = b[i];
      const row = W[i];
      for (let j = 0; j < input.length; j++) {
        sum += row[j] * input[j];
      }
      output[i] = sum;
    }
    return output;
  }

  relu(x) {
    return x.map(v => Math.max(0, v));
  }

  sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  softmax(logits) {
    const max = Math.max(...logits);
    const exps = logits.map(v => Math.exp(v - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map(v => v / sum);
  }

  argmax(arr) {
    let best = 0;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] > arr[best]) best = i;
    }
    return best;
  }

  forward(features) {
    if (!this.loaded) return null;

    // Backbone: 3 linear layers with ReLU
    let x = features;
    x = this.relu(this.linear(x, 'backbone.0.weight', 'backbone.0.bias'));
    // Skip dropout (inference mode)
    x = this.relu(this.linear(x, 'backbone.3.weight', 'backbone.3.bias'));
    x = this.relu(this.linear(x, 'backbone.6.weight', 'backbone.6.bias'));

    const shared = x;

    // Build head
    let build = this.relu(this.linear(shared, 'build_head.0.weight', 'build_head.0.bias'));
    build = this.linear(build, 'build_head.2.weight', 'build_head.2.bias');

    // Move head
    let move = this.relu(this.linear(shared, 'move_head.0.weight', 'move_head.0.bias'));
    move = this.linear(move, 'move_head.2.weight', 'move_head.2.bias');

    // Expand head
    let expand = this.relu(this.linear(shared, 'expand_head.0.weight', 'expand_head.0.bias'));
    expand = this.linear(expand, 'expand_head.2.weight', 'expand_head.2.bias');

    // City head
    let city = this.relu(this.linear(shared, 'city_head.0.weight', 'city_head.0.bias'));
    city = this.linear(city, 'city_head.2.weight', 'city_head.2.bias');

    // Value head (win probability) — may not exist in older models
    let value = 0.5;
    if (this.weights['value_head.0.weight']) {
      let v = this.relu(this.linear(shared, 'value_head.0.weight', 'value_head.0.bias'));
      v = this.relu(this.linear(v, 'value_head.2.weight', 'value_head.2.bias'));
      v = this.linear(v, 'value_head.4.weight', 'value_head.4.bias');
      value = this.sigmoid(v[0]);
    }

    return {
      buildLogits: build,   // [MAX_CITIES * 4]
      moveLogits: move,     // [MAX_UNITS * 9]
      expandLogits: expand, // [16]
      cityLogit: city[0],   // scalar
      value,                // win probability [0, 1]
    };
  }
}

// ============================================================
// Feature encoding (must match generate-expert-data.js exactly)
// ============================================================
function encodeState(state, playerId) {
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

  const W = state.map.width;
  const H = state.map.height;
  const maxTiles = W * H;

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
    if (myUnits.length > 0) {
      myDistToMonument = Math.min(...myUnits.flatMap(u =>
        monuments.map(m => chebyshevDistance(u.x, u.y, m.x, m.y))));
    }
    if (enemyUnits.length > 0) {
      enemyDistToMonument = Math.min(...enemyUnits.flatMap(u =>
        monuments.map(m => chebyshevDistance(u.x, u.y, m.x, m.y))));
    }
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

  // Per-unit features (20 × 7)
  const MAX_UNITS = 20;
  for (let i = 0; i < MAX_UNITS; i++) {
    if (i < myUnits.length) {
      const u = myUnits[i];
      features.push(
        u.type === 'SOLDIER' ? 1 : 0, u.type === 'ARCHER' ? 1 : 0, u.type === 'RAIDER' ? 1 : 0,
        u.x / W, u.y / H, u.hp / 2, (u.canMove ?? u.can_move_next_turn ?? true) ? 1 : 0,
      );
    } else {
      features.push(0, 0, 0, 0, 0, 0, 0);
    }
  }

  // Per-enemy features (20 × 5)
  for (let i = 0; i < MAX_UNITS; i++) {
    if (i < enemyUnits.length) {
      const u = enemyUnits[i];
      features.push(
        u.type === 'SOLDIER' ? 1 : 0, u.type === 'ARCHER' ? 1 : 0, u.type === 'RAIDER' ? 1 : 0,
        u.x / W, u.y / H,
      );
    } else {
      features.push(0, 0, 0, 0, 0);
    }
  }

  // Per-city features (6 × 3)
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

  return features;
}

// ============================================================
// Decode NN output into valid game actions
// ============================================================
const MAX_UNITS = 20;
const MAX_CITIES = 6;
const NUM_BUILD_OPTIONS = 4;
const NUM_MOVE_OPTIONS = 9;

// Direction index → (dx, dy) mapping
const DIR_MAP = [
  [0, 0],   // 0 = stay
  [0, -1],  // 1 = N
  [1, -1],  // 2 = NE
  [1, 0],   // 3 = E
  [1, 1],   // 4 = SE
  [0, 1],   // 5 = S
  [-1, 1],  // 6 = SW
  [-1, 0],  // 7 = W
  [-1, -1], // 8 = NW
];

const UNIT_TYPE_MAP = [null, 'SOLDIER', 'ARCHER', 'RAIDER'];

function decodeActions(output, state, playerId) {
  const actions = [];
  const myUnits = state.units.filter(u => u.owner === playerId);
  const myCities = state.cities.filter(c => c.owner === playerId);
  const player = state.players.find(p => p.id === playerId);
  let remainingGold = player.gold + player.income;

  // --- Build city? ---
  if (output.cityLogit > 0) { // sigmoid > 0.5
    const cityCost = getCityCost(state, playerId);
    if (remainingGold >= cityCost) {
      // Find best location (on owned FIELD, no city/unit there)
      const connected = getConnectedTerritory(state, playerId);
      let bestTile = null;
      let bestScore = -Infinity;

      for (const tile of state.map.tiles) {
        if (tile.owner !== playerId || tile.type !== TERRAIN.FIELD) continue;
        if (!connected.has(`${tile.x},${tile.y}`)) continue;
        if (state.cities.some(c => c.x === tile.x && c.y === tile.y)) continue;
        if (state.units.some(u => u.x === tile.x && u.y === tile.y)) continue;

        // Simple scoring: prefer center, away from existing cities
        let score = 0;
        const centerX = state.map.width / 2;
        score -= Math.abs(tile.x - centerX) * 0.5;
        for (const c of myCities) {
          score += Math.min(chebyshevDistance(tile.x, tile.y, c.x, c.y), 5);
        }
        if (score > bestScore) {
          bestScore = score;
          bestTile = tile;
        }
      }

      if (bestTile) {
        const action = { action: ACTIONS.BUILD_CITY, x: bestTile.x, y: bestTile.y };
        if (validateAction(state, playerId, action).valid) {
          actions.push(action);
          remainingGold -= cityCost;
        }
      }
    }
  }

  // --- Build units at cities ---
  for (let i = 0; i < Math.min(MAX_CITIES, myCities.length); i++) {
    const city = myCities[i];
    const logitStart = i * NUM_BUILD_OPTIONS;
    const logits = output.buildLogits.slice(logitStart, logitStart + NUM_BUILD_OPTIONS);

    // Find best build option
    let bestIdx = 0;
    for (let j = 1; j < NUM_BUILD_OPTIONS; j++) {
      if (logits[j] > logits[bestIdx]) bestIdx = j;
    }

    if (bestIdx === 0) continue; // nothing

    const unitType = UNIT_TYPE_MAP[bestIdx];
    if (!unitType) continue;

    const cost = UNIT_STATS[unitType].cost;
    if (remainingGold < cost) continue;

    const action = {
      action: ACTIONS.BUILD_UNIT,
      city_x: city.x,
      city_y: city.y,
      unit_type: unitType,
    };

    if (validateAction(state, playerId, action).valid) {
      actions.push(action);
      remainingGold -= cost;
    }
  }

  // --- Move units ---
  for (let i = 0; i < Math.min(MAX_UNITS, myUnits.length); i++) {
    const unit = myUnits[i];
    const canMove = (unit.canMove ?? unit.can_move_next_turn ?? true) && !isInZoC(state, unit);
    if (!canMove) continue;

    const logitStart = i * NUM_MOVE_OPTIONS;
    const logits = output.moveLogits.slice(logitStart, logitStart + NUM_MOVE_OPTIONS);

    // Sort directions by score, try best first
    const dirs = logits.map((score, idx) => ({ idx, score })).sort((a, b) => b.score - a.score);

    for (const dir of dirs) {
      if (dir.idx === 0) break; // stay = no move

      const [dx, dy] = DIR_MAP[dir.idx];
      const movement = UNIT_STATS[unit.type].movement;

      // For raiders (movement 2), try double step first
      const steps = movement > 1 ? [movement, 1] : [1];

      let moved = false;
      for (const step of steps) {
        const action = {
          action: ACTIONS.MOVE,
          from_x: unit.x,
          from_y: unit.y,
          to_x: unit.x + dx * step,
          to_y: unit.y + dy * step,
        };

        if (validateAction(state, playerId, action).valid) {
          actions.push(action);
          moved = true;
          break;
        }
      }
      if (moved) break;
    }
  }

  // --- Expand territory ---
  const expandIdx = output.expandLogits.indexOf(Math.max(...output.expandLogits));
  const expandCount = Math.min(expandIdx, Math.floor(remainingGold / ECONOMY.EXPAND_COST));

  if (expandCount > 0) {
    const connected = getConnectedTerritory(state, playerId);
    const seen = new Set();
    const expandable = [];

    for (const tile of state.map.tiles) {
      if (tile.owner !== playerId || !connected.has(`${tile.x},${tile.y}`)) continue;
      for (const adj of getTilesAtDistance1(tile.x, tile.y)) {
        const key = `${adj.x},${adj.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const t = state.map.tiles.find(tt => tt.x === adj.x && tt.y === adj.y);
        if (t && t.owner === null && t.type === TERRAIN.FIELD) {
          expandable.push({ x: adj.x, y: adj.y });
        }
      }
    }

    // Sort toward center / enemy side
    const centerX = state.map.width / 2;
    expandable.sort((a, b) => Math.abs(a.x - centerX) - Math.abs(b.x - centerX));

    let expanded = 0;
    for (const tile of expandable) {
      if (expanded >= expandCount || remainingGold < ECONOMY.EXPAND_COST) break;

      const action = { action: ACTIONS.EXPAND_TERRITORY, x: tile.x, y: tile.y };
      if (validateAction(state, playerId, action).valid) {
        actions.push(action);
        remainingGold -= ECONOMY.EXPAND_COST;
        expanded++;
      }
    }
  }

  return actions;
}

// ============================================================
// Load model
// ============================================================
const WEIGHTS_PATH = process.env.NN_WEIGHTS ||
  path.join(__dirname, '..', 'training', 'models', 'civclash_agent_weights.json');

const nn = new SimpleNN(WEIGHTS_PATH);

// ============================================================
// Main entry point
// ============================================================
function generateActions(state, playerId) {
  if (!nn.loaded) {
    return smarterAgent.generateActions(state, playerId);
  }

  try {
    const features = encodeState(state, playerId);
    const output = nn.forward(features);

    if (!output) {
      return smarterAgent.generateActions(state, playerId);
    }

    const actions = decodeActions(output, state, playerId);

    // If NN produces nothing useful, fallback
    if (actions.length === 0) {
      return smarterAgent.generateActions(state, playerId);
    }

    return actions;
  } catch (err) {
    console.error(`[NN] Inference error: ${err.message}`);
    return smarterAgent.generateActions(state, playerId);
  }
}

module.exports = { generateActions };
