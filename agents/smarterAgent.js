/**
 * Smarter Agent - Has advanced strategy
 * - Builds cities for income and spawn points
 * - Builds soldiers to control map
 * - Expands territory for income
 * - Moves toward monument and enemies
 * - Prioritizes city capture
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

/**
 * Get all valid moves for a unit
 */
function getValidMoves(state, unit) {
  // Handle both canMove (legacy) and can_move_next_turn (spec)
  const canMove = unit.can_move_next_turn ?? unit.canMove;
  if (!canMove) return [];
  if (isInZoC(state, unit)) return [];

  const moves = [];
  const movement = UNIT_STATS[unit.type].movement;

  // Check tiles within movement range
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

      const result = validateAction(state, unit.owner, action);
      if (result.valid) {
        moves.push(action);
      }
    }
  }

  return moves;
}

/**
 * Get valid build unit actions for a specific unit type
 */
function getValidBuildsForType(state, playerId, unitType) {
  const player = state.players.find((p) => p.id === playerId);
  if (player.gold < UNIT_STATS[unitType].cost) return [];

  const builds = [];

  for (const city of state.cities) {
    if (city.owner !== playerId) continue;

    const unitAtCity = state.units.find((u) => u.x === city.x && u.y === city.y);
    if (unitAtCity) continue;

    builds.push({
      action: ACTIONS.BUILD_UNIT,
      city_x: city.x,
      city_y: city.y,
      unit_type: unitType,
    });
  }

  return builds;
}

/**
 * Get valid expand actions sorted by distance to center
 */
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
      if (player.gold < ECONOMY.EXPAND_COST) continue;

      expands.push({
        action: { action: ACTIONS.EXPAND_TERRITORY, x: pos.x, y: pos.y },
        forwardDist: Math.abs(pos.x - enemyX),
      });
    }
  }

  // Sort by forward distance (expand toward enemy side first)
  expands.sort((a, b) => a.forwardDist - b.forwardDist);
  return expands.map((e) => e.action);
}

/**
 * Get valid city build locations, scored by strategic value
 */
function getValidCityLocations(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (player.gold < getCityCost(state, playerId)) return [];

  const enemyX = getEnemySideX(state, playerId);
  const myCities = state.cities.filter((c) => c.owner === playerId);
  const locations = [];

  // Find all owned field tiles that could have a city
  for (const tile of state.map.tiles) {
    if (tile.owner !== playerId) continue;
    if (tile.type !== TERRAIN.FIELD) continue;

    // Check no city already there
    const hasCity = state.cities.some((c) => c.x === tile.x && c.y === tile.y);
    if (hasCity) continue;

    // Check no unit blocking
    const hasUnit = state.units.some((u) => u.x === tile.x && u.y === tile.y);
    if (hasUnit) continue;

    // Score the location
    let score = 0;

    // Prefer forward positions (closer to enemy side)
    const forwardDist = Math.abs(tile.x - enemyX);
    score += (state.map.width - forwardDist) * 2;

    // Prefer locations away from existing cities (spread out)
    let minDistToOwnCity = Infinity;
    for (const city of myCities) {
      const dist = chebyshevDistance(tile.x, tile.y, city.x, city.y);
      minDistToOwnCity = Math.min(minDistToOwnCity, dist);
    }
    score += Math.min(minDistToOwnCity, 5) * 3;

    // Prefer locations closer to enemy territory (front line)
    const enemyTiles = state.map.tiles.filter((t) => t.owner !== null && t.owner !== playerId);
    if (enemyTiles.length > 0) {
      let minDistToEnemy = Infinity;
      for (const et of enemyTiles) {
        const dist = chebyshevDistance(tile.x, tile.y, et.x, et.y);
        minDistToEnemy = Math.min(minDistToEnemy, dist);
      }
      score += (10 - minDistToEnemy) * 2;
    }

    locations.push({
      action: {
        action: ACTIONS.BUILD_CITY,
        x: tile.x,
        y: tile.y,
      },
      score,
    });
  }

  // Sort by score descending
  locations.sort((a, b) => b.score - a.score);
  return locations;
}

/**
 * Score a move based on strategic value
 */
function scoreMoveTarget(state, unit, targetX, targetY) {
  let score = 0;
  const enemyX = getEnemySideX(state, unit.owner);
  const centerX = Math.floor(state.map.width / 2);
  const centerY = Math.floor(state.map.height / 2);

  // Push forward toward enemy side
  const currentForwardDist = Math.abs(unit.x - enemyX);
  const newForwardDist = Math.abs(targetX - enemyX);
  score += (currentForwardDist - newForwardDist) * 8;

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
      const newDistMon = chebyshevDistance(targetX, targetY, bestMonX, bestMonY);
      score += (bestMonDist - newDistMon) * 5;
    }
  }

  // Soldiers: prefer moving toward nearby enemy cities
  if (UNIT_STATS[unit.type].canCaptureCities) {
    const enemyCities = state.cities.filter((c) => c.owner !== unit.owner);
    for (const city of enemyCities) {
      const currentDist = chebyshevDistance(unit.x, unit.y, city.x, city.y);
      if (currentDist > 15) continue;
      const newDist = chebyshevDistance(targetX, targetY, city.x, city.y);
      score += (currentDist - newDist) * 15;
    }
  }

  // Prefer moving toward nearby enemies
  const enemies = state.units.filter((u) => u.owner !== unit.owner);
  for (const enemy of enemies) {
    const currentDist = chebyshevDistance(unit.x, unit.y, enemy.x, enemy.y);
    if (currentDist > 10) continue;
    const newDist = chebyshevDistance(targetX, targetY, enemy.x, enemy.y);
    score += (currentDist - newDist) * 5;
  }

  // Check if target is enemy territory (raiding)
  const targetTile = state.map.tiles.find((t) => t.x === targetX && t.y === targetY);
  if (targetTile && targetTile.owner !== null && targetTile.owner !== unit.owner) {
    score += 8;
  }

  // Check if target is enemy city (capture!)
  const targetCity = state.cities.find((c) => c.x === targetX && c.y === targetY);
  if (targetCity && targetCity.owner !== unit.owner && UNIT_STATS[unit.type].canCaptureCities) {
    score += 100;
  }

  return score;
}

/**
 * Get best move for a unit
 */
function getBestMove(state, unit) {
  const moves = getValidMoves(state, unit);
  if (moves.length === 0) return null;

  let bestMove = null;
  let bestScore = -Infinity;

  for (const move of moves) {
    const score = scoreMoveTarget(state, unit, move.to_x, move.to_y);
    if (score > bestScore || (score === bestScore && Math.random() < 0.5)) {
      bestScore = score;
      bestMove = move;
    }
  }

  // Only move if it improves position
  return bestScore > 0 ? bestMove : null;
}

/**
 * Generate actions for a turn - strategic approach
 */
function generateActions(state, playerId) {
  const actions = [];
  const player = state.players.find((p) => p.id === playerId);
  let remainingGold = player.gold + player.income; // After income phase

  const myUnits = state.units.filter((u) => u.owner === playerId);
  const myCities = state.cities.filter((c) => c.owner === playerId);
  const myTiles = state.map.tiles.filter((t) => t.owner === playerId);
  const enemyUnits = state.units.filter((u) => u.owner !== playerId);

  // Track which cities will have units built this turn
  const citiesUsedForBuilding = new Set();

  // === CITY BUILDING STRATEGY ===
  // Build cities when:
  // - Have enough gold (80+)
  // - Have enough territory (at least 15 tiles per city)
  // - Scale max cities by map size
  const scale = getMapScale(state);
  const targetCities = Math.min(Math.floor(4 * scale), Math.floor(myTiles.length / 15) + 1);

  const cityCost = getCityCost(state, playerId);
  if (myCities.length < targetCities && remainingGold >= cityCost) {
    const cityLocations = getValidCityLocations(state, playerId);
    if (cityLocations.length > 0) {
      const bestLocation = cityLocations[0];
      actions.push(bestLocation.action);
      remainingGold -= cityCost;
    }
  }

  // === UNIT BUILDING STRATEGY ===
  // With multiple cities, we can build multiple units per turn!
  const soldierCount = myUnits.filter((u) => u.type === UNIT_TYPES.SOLDIER).length;
  const archerCount = myUnits.filter((u) => u.type === UNIT_TYPES.ARCHER).length;
  const raiderCount = myUnits.filter((u) => u.type === UNIT_TYPES.RAIDER).length;

  // Target army composition based on city count (scaled by map size)
  const targetSoldiers = Math.min(Math.floor(6 * scale), myCities.length * 2);
  const targetArchers = Math.min(Math.floor(3 * scale), Math.floor(myCities.length * 1.5));
  const targetRaiders = Math.min(Math.floor(2 * scale), myCities.length);

  // Build soldiers (main combat unit)
  if (soldierCount < targetSoldiers) {
    const soldierBuilds = getValidBuildsForType(state, playerId, UNIT_TYPES.SOLDIER);
    for (const build of soldierBuilds) {
      const cityKey = `${build.city_x},${build.city_y}`;
      if (citiesUsedForBuilding.has(cityKey)) continue;

      if (remainingGold >= UNIT_STATS[UNIT_TYPES.SOLDIER].cost) {
        actions.push(build);
        remainingGold -= UNIT_STATS[UNIT_TYPES.SOLDIER].cost;
        citiesUsedForBuilding.add(cityKey);

        if (soldierCount + citiesUsedForBuilding.size >= targetSoldiers) break;
      }
    }
  }

  // Build archers (ranged support)
  if (archerCount < targetArchers && soldierCount >= 2) {
    const archerBuilds = getValidBuildsForType(state, playerId, UNIT_TYPES.ARCHER);
    for (const build of archerBuilds) {
      const cityKey = `${build.city_x},${build.city_y}`;
      if (citiesUsedForBuilding.has(cityKey)) continue;

      if (remainingGold >= UNIT_STATS[UNIT_TYPES.ARCHER].cost) {
        actions.push(build);
        remainingGold -= UNIT_STATS[UNIT_TYPES.ARCHER].cost;
        citiesUsedForBuilding.add(cityKey);
        break; // One archer per turn
      }
    }
  }

  // Build raiders (fast flankers) if we have spare cities
  if (raiderCount < targetRaiders && myCities.length > 2) {
    const raiderBuilds = getValidBuildsForType(state, playerId, UNIT_TYPES.RAIDER);
    for (const build of raiderBuilds) {
      const cityKey = `${build.city_x},${build.city_y}`;
      if (citiesUsedForBuilding.has(cityKey)) continue;

      if (remainingGold >= UNIT_STATS[UNIT_TYPES.RAIDER].cost) {
        actions.push(build);
        remainingGold -= UNIT_STATS[UNIT_TYPES.RAIDER].cost;
        citiesUsedForBuilding.add(cityKey);
        break; // One raider per turn
      }
    }
  }

  // === TERRITORY EXPANSION ===
  // Expand territory if we have gold left (important for income and city building)
  const expands = getValidExpands(state, playerId);
  const maxExpansions = Math.min(
    Math.floor(5 * scale),
    Math.floor(remainingGold / ECONOMY.EXPAND_COST)
  );
  let expansionCount = 0;

  for (const expand of expands) {
    if (remainingGold >= ECONOMY.EXPAND_COST && expansionCount < maxExpansions) {
      actions.push(expand);
      remainingGold -= ECONOMY.EXPAND_COST;
      expansionCount++;
    } else {
      break;
    }
  }

  // === UNIT MOVEMENT ===
  // Move units strategically
  for (const unit of myUnits) {
    const move = getBestMove(state, unit);
    if (move) {
      actions.push(move);
    }
  }

  return actions;
}

module.exports = {
  generateActions,
  getValidMoves,
  getBestMove,
  scoreMoveTarget,
};
