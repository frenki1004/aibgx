/**
 * Economy Agent - Farms economy aggressively, then launches assault
 *
 * Phase 1 (economy): Expand territory, build cities, hoard gold.
 *   Only builds a token garrison soldier per city for defense.
 * Phase 2 (assault): Once income is high enough or time is running out,
 *   dumps gold into a full army and pushes toward enemies and monument.
 */

const {
  ACTIONS,
  UNIT_TYPES,
  UNIT_STATS,
  ECONOMY,
  TERRAIN,
  validateAction,
  getCityCost,
  getTilesAtDistance1,
  getUnit,
  chebyshevDistance,
  isInZoC,
  getConnectedTerritory,
} = require('../logic');

/**
 * Get the x-coordinate of the enemy side (for forward push direction)
 */
function getEnemySideX(state, playerId) {
  const centerX = Math.floor(state.map.width / 2);
  const myCities = state.cities.filter((c) => c.owner === playerId);
  if (myCities.length === 0) return centerX;
  const capital = myCities.reduce(
    (best, c) => (Math.abs(c.x - centerX) > Math.abs(best.x - centerX) ? c : best),
    myCities[0]
  );
  return capital.x < centerX ? state.map.width - 1 : 0;
}

/**
 * Map-size scale factor (1 for blitz, ~1.5 for standard, ~2.8 for tournament)
 */
function getMapScale(state) {
  return Math.max(1, Math.sqrt((state.map.width * state.map.height) / 165));
}

// --- Helpers (shared patterns from other agents) ---

function getValidMoves(state, unit) {
  const canMove = unit.can_move_next_turn ?? unit.canMove;
  if (!canMove) return [];
  if (isInZoC(state, unit)) return [];

  const moves = [];
  const movement = UNIT_STATS[unit.type].movement;

  for (let dx = -movement; dx <= movement; dx++) {
    for (let dy = -movement; dy <= movement; dy++) {
      if (dx === 0 && dy === 0) continue;
      if (chebyshevDistance(0, 0, dx, dy) > movement) continue;

      const action = {
        action: ACTIONS.MOVE,
        from_x: unit.x,
        from_y: unit.y,
        to_x: unit.x + dx,
        to_y: unit.y + dy,
      };

      if (validateAction(state, unit.owner, action).valid) {
        moves.push(action);
      }
    }
  }
  return moves;
}

function getValidBuildsForType(state, playerId, unitType) {
  const player = state.players.find((p) => p.id === playerId);
  if (player.gold < UNIT_STATS[unitType].cost) return [];

  const builds = [];
  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    if (state.units.some((u) => u.x === city.x && u.y === city.y)) continue;
    builds.push({
      action: ACTIONS.BUILD_UNIT,
      city_x: city.x,
      city_y: city.y,
      unit_type: unitType,
    });
  }
  return builds;
}

function getValidExpands(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (player.gold < ECONOMY.EXPAND_COST) return [];

  const expands = [];
  const seen = new Set();
  // Only expand from territory connected to a city
  const connected = getConnectedTerritory(state, playerId);
  const connectedTiles = state.map.tiles.filter(
    (t) => t.owner === playerId && connected.has(`${t.x},${t.y}`)
  );
  const capital = getCapital(state, playerId);
  const anchorX = capital ? capital.x : Math.floor(state.map.width / 2);
  const anchorY = capital ? capital.y : Math.floor(state.map.height / 2);
  const enemyX = getEnemySideX(state, playerId);

  for (const tile of connectedTiles) {
    const adjacent = getTilesAtDistance1(tile.x, tile.y);
    for (const pos of adjacent) {
      const key = `${pos.x},${pos.y}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const targetTile = state.map.tiles.find((t) => t.x === pos.x && t.y === pos.y);
      if (!targetTile || targetTile.owner !== null) continue;
      if (targetTile.type !== TERRAIN.FIELD) continue;

      expands.push({
        action: { action: ACTIONS.EXPAND_TERRITORY, x: pos.x, y: pos.y },
        dist: chebyshevDistance(pos.x, pos.y, anchorX, anchorY),
        forwardDist: Math.abs(pos.x - enemyX),
      });
    }
  }

  // Expand closest to capital first, break ties by forward distance (toward enemy)
  expands.sort((a, b) => a.dist - b.dist || a.forwardDist - b.forwardDist);
  return expands.map((e) => e.action);
}

function getCapital(state, playerId) {
  // Capital is the first city (starting city, furthest from center)
  const myCities = state.cities.filter((c) => c.owner === playerId);
  if (myCities.length === 0) return null;
  const centerX = Math.floor(state.map.width / 2);
  const centerY = Math.floor(state.map.height / 2);
  let best = myCities[0];
  let bestDist = 0;
  for (const c of myCities) {
    const d = chebyshevDistance(c.x, c.y, centerX, centerY);
    if (d > bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function getValidCityLocations(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (player.gold < getCityCost(state, playerId)) return [];

  const myCities = state.cities.filter((c) => c.owner === playerId);
  const capital = getCapital(state, playerId);
  const locations = [];

  for (const tile of state.map.tiles) {
    if (tile.owner !== playerId || tile.type !== TERRAIN.FIELD) continue;
    if (state.cities.some((c) => c.x === tile.x && c.y === tile.y)) continue;
    if (state.units.some((u) => u.x === tile.x && u.y === tile.y)) continue;

    let score = 0;
    const enemyX = getEnemySideX(state, playerId);
    // Strong preference for close to capital
    if (capital) {
      score -= chebyshevDistance(tile.x, tile.y, capital.x, capital.y) * 10;
    }
    // Tiebreaker: prefer forward positions (closer to enemy side)
    score -= Math.abs(tile.x - enemyX) * 0.5;
    // Small bonus for not being right on top of another city (min spacing 2)
    let minDistToOwn = Infinity;
    for (const c of myCities) {
      minDistToOwn = Math.min(minDistToOwn, chebyshevDistance(tile.x, tile.y, c.x, c.y));
    }
    if (minDistToOwn >= 2) score += 5;

    locations.push({ action: { action: ACTIONS.BUILD_CITY, x: tile.x, y: tile.y }, score });
  }

  locations.sort((a, b) => b.score - a.score);
  return locations;
}

// --- Decision logic ---

function isAssaultTime(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const maxTurns = state.maxTurns || 200;
  const turnsLeft = maxTurns - state.turn;
  const myIncome = player.income;
  const scale = getMapScale(state);

  // Assault if: time is running out (proportional to game length)
  if (turnsLeft <= Math.floor(maxTurns * 0.2)) return true;
  // Income threshold scales with map size
  if (myIncome >= Math.floor(30 * scale)) return true;

  // Assault if enemy units are threatening our cities
  const myCities = state.cities.filter((c) => c.owner === playerId);
  const enemyUnits = state.units.filter((u) => u.owner !== playerId);
  for (const city of myCities) {
    for (const enemy of enemyUnits) {
      if (chebyshevDistance(city.x, city.y, enemy.x, enemy.y) <= 3) return true;
    }
  }

  return false;
}

function scoreMoveEcon(state, unit, tx, ty) {
  let score = 0;
  const enemyX = getEnemySideX(state, unit.owner);

  // During econ: garrison near own cities, nudge forward
  const myCities = state.cities.filter((c) => c.owner === unit.owner);
  let minCityDist = Infinity;
  for (const c of myCities) {
    minCityDist = Math.min(minCityDist, chebyshevDistance(tx, ty, c.x, c.y));
  }
  // Stay within 2 tiles of a city
  if (minCityDist <= 2) score += 10;
  else score -= minCityDist * 3;

  // Slight bias toward enemy side
  const curDist = Math.abs(unit.x - enemyX);
  const newDist = Math.abs(tx - enemyX);
  score += (curDist - newDist) * 2;

  return score;
}

function scoreMoveAssault(state, unit, tx, ty) {
  let score = 0;
  const enemyX = getEnemySideX(state, unit.owner);
  const centerX = Math.floor(state.map.width / 2);
  const centerY = Math.floor(state.map.height / 2);

  // Push forward toward enemy side
  const curForward = Math.abs(unit.x - enemyX);
  const newForward = Math.abs(tx - enemyX);
  score += (curForward - newForward) * 8;

  // Pull toward nearest monument when reasonably close
  if (state.monuments) {
    let bestMonDist = Infinity;
    let bestMonX, bestMonY;
    for (const m of state.monuments) {
      const d = chebyshevDistance(unit.x, unit.y, m.x, m.y);
      if (d < bestMonDist) {
        bestMonDist = d;
        bestMonX = m.x;
        bestMonY = m.y;
      }
    }
    if (bestMonDist <= 10) {
      const newDistMon = chebyshevDistance(tx, ty, bestMonX, bestMonY);
      score += (bestMonDist - newDistMon) * 5;
    }
  }

  // Soldiers push toward nearby enemy cities
  if (UNIT_STATS[unit.type].canCaptureCities) {
    const enemyCities = state.cities.filter((c) => c.owner !== unit.owner);
    for (const city of enemyCities) {
      const cd = chebyshevDistance(unit.x, unit.y, city.x, city.y);
      if (cd > 15) continue;
      const nd = chebyshevDistance(tx, ty, city.x, city.y);
      score += (cd - nd) * 15;
    }
  }

  // Move toward nearby enemies
  const enemies = state.units.filter((u) => u.owner !== unit.owner);
  for (const enemy of enemies) {
    const cd = chebyshevDistance(unit.x, unit.y, enemy.x, enemy.y);
    if (cd > 10) continue;
    const nd = chebyshevDistance(tx, ty, enemy.x, enemy.y);
    score += (cd - nd) * 5;
  }

  // Raid enemy territory
  const tile = state.map.tiles.find((t) => t.x === tx && t.y === ty);
  if (tile && tile.owner !== null && tile.owner !== unit.owner) score += 8;

  // Capture enemy city
  const city = state.cities.find((c) => c.x === tx && c.y === ty);
  if (city && city.owner !== unit.owner && UNIT_STATS[unit.type].canCaptureCities) score += 100;

  return score;
}

// --- Main entry ---

function generateActions(state, playerId) {
  const actions = [];
  const player = state.players.find((p) => p.id === playerId);
  let gold = player.gold + player.income;

  const myUnits = state.units.filter((u) => u.owner === playerId);
  const myCities = state.cities.filter((c) => c.owner === playerId);
  const myTiles = state.map.tiles.filter((t) => t.owner === playerId);
  const citiesUsed = new Set();

  const assault = isAssaultTime(state, playerId);

  if (!assault) {
    // === ECONOMY PHASE ===

    // 1. Build cities aggressively — target 1 city per ~12 tiles, scaled by map size
    const scale = getMapScale(state);
    const targetCities = Math.min(Math.floor(6 * scale), Math.floor(myTiles.length / 12) + 1);
    const cityCostEcon = getCityCost(state, playerId);
    if (myCities.length < targetCities && gold >= cityCostEcon) {
      const locs = getValidCityLocations(state, playerId);
      if (locs.length > 0) {
        actions.push(locs[0].action);
        gold -= cityCostEcon;
      }
    }

    // 2. Build one garrison soldier per city that doesn't have a nearby defender
    for (const city of myCities) {
      const nearbyDefender = myUnits.some(
        (u) => u.type === UNIT_TYPES.SOLDIER && chebyshevDistance(u.x, u.y, city.x, city.y) <= 2
      );
      if (!nearbyDefender && gold >= UNIT_STATS[UNIT_TYPES.SOLDIER].cost) {
        const builds = getValidBuildsForType(state, playerId, UNIT_TYPES.SOLDIER);
        const build = builds.find((b) => b.city_x === city.x && b.city_y === city.y);
        if (build && !citiesUsed.has(`${city.x},${city.y}`)) {
          actions.push(build);
          gold -= UNIT_STATS[UNIT_TYPES.SOLDIER].cost;
          citiesUsed.add(`${city.x},${city.y}`);
        }
      }
    }

    // 3. Expand territory — dump remaining gold into expansion
    const expands = getValidExpands(state, playerId);
    for (const expand of expands) {
      if (gold < ECONOMY.EXPAND_COST) break;
      actions.push(expand);
      gold -= ECONOMY.EXPAND_COST;
    }

    // 4. Move garrison units — stay near cities, drift toward center
    for (const unit of myUnits) {
      const moves = getValidMoves(state, unit);
      if (moves.length === 0) continue;

      let bestScore = -Infinity;
      let bestMoves = [];
      for (const m of moves) {
        const s = scoreMoveEcon(state, unit, m.to_x, m.to_y);
        if (s > bestScore) {
          bestScore = s;
          bestMoves = [m];
        } else if (s === bestScore) bestMoves.push(m);
      }
      if (bestMoves.length > 0 && bestScore > 0) {
        actions.push(bestMoves[Math.floor(Math.random() * bestMoves.length)]);
      }
    }
  } else {
    // === ASSAULT PHASE ===

    // 1. Still build a city if we can and have few
    const scale = getMapScale(state);
    const cityCostAssault = getCityCost(state, playerId);
    if (myCities.length < Math.floor(3 * scale) && gold >= cityCostAssault + 60) {
      const locs = getValidCityLocations(state, playerId);
      if (locs.length > 0) {
        actions.push(locs[0].action);
        gold -= cityCostAssault;
      }
    }

    // 2. Build army — soldiers first, then archers, then raiders
    const soldierCount = myUnits.filter((u) => u.type === UNIT_TYPES.SOLDIER).length;
    const archerCount = myUnits.filter((u) => u.type === UNIT_TYPES.ARCHER).length;

    // Soldiers
    const targetSoldiers = myCities.length * 2;
    if (soldierCount < targetSoldiers) {
      const builds = getValidBuildsForType(state, playerId, UNIT_TYPES.SOLDIER);
      for (const build of builds) {
        const key = `${build.city_x},${build.city_y}`;
        if (citiesUsed.has(key)) continue;
        if (gold < UNIT_STATS[UNIT_TYPES.SOLDIER].cost) break;
        actions.push(build);
        gold -= UNIT_STATS[UNIT_TYPES.SOLDIER].cost;
        citiesUsed.add(key);
      }
    }

    // Archers
    if (archerCount < Math.ceil(myCities.length * 1.5)) {
      const builds = getValidBuildsForType(state, playerId, UNIT_TYPES.ARCHER);
      for (const build of builds) {
        const key = `${build.city_x},${build.city_y}`;
        if (citiesUsed.has(key)) continue;
        if (gold < UNIT_STATS[UNIT_TYPES.ARCHER].cost) break;
        actions.push(build);
        gold -= UNIT_STATS[UNIT_TYPES.ARCHER].cost;
        citiesUsed.add(key);
      }
    }

    // Raiders from remaining cities
    const rBuilds = getValidBuildsForType(state, playerId, UNIT_TYPES.RAIDER);
    for (const build of rBuilds) {
      const key = `${build.city_x},${build.city_y}`;
      if (citiesUsed.has(key)) continue;
      if (gold < UNIT_STATS[UNIT_TYPES.RAIDER].cost) break;
      actions.push(build);
      gold -= UNIT_STATS[UNIT_TYPES.RAIDER].cost;
      citiesUsed.add(key);
    }

    // 3. Expand with leftover gold
    const expands = getValidExpands(state, playerId);
    for (const expand of expands) {
      if (gold < ECONOMY.EXPAND_COST) break;
      actions.push(expand);
      gold -= ECONOMY.EXPAND_COST;
    }

    // 4. Move units aggressively
    for (const unit of myUnits) {
      const moves = getValidMoves(state, unit);
      if (moves.length === 0) continue;

      let bestScore = -Infinity;
      let bestMoves = [];
      for (const m of moves) {
        const s = scoreMoveAssault(state, unit, m.to_x, m.to_y);
        if (s > bestScore) {
          bestScore = s;
          bestMoves = [m];
        } else if (s === bestScore) bestMoves.push(m);
      }
      if (bestMoves.length > 0 && bestScore > 0) {
        actions.push(bestMoves[Math.floor(Math.random() * bestMoves.length)]);
      }
    }
  }

  return actions;
}

module.exports = {
  generateActions,
};
