/**
 * Shared feature encoding for MCTS data generation.
 * Used by both mcts-generate.js (sequential) and mcts-worker.js (parallel).
 */

const {
  UNIT_TYPES, UNIT_STATS, ECONOMY, TERRAIN,
  chebyshevDistance, getConnectedTerritory, getTilesAtDistance1, isInZoC, getCityCost,
} = require('../logic');

// ============================================================
// Feature encoding: state → 290-dim feature vector
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

  const entries = Object.entries(rootVisits);
  const totalVisits = entries.reduce((s, [, v]) => s + v.visits, 0) || 1;
  const visitDistribution = {};
  for (const [name, data] of entries) {
    visitDistribution[name] = data.visits / totalVisits;
  }

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
    visitDistribution,
  };
}

module.exports = { encodeStateForNN, encodeVisitsForNN };
