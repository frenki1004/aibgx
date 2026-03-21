/**
 * Turn processor for Civilization Clash
 * Stateless - takes state and actions, returns new state
 */

const {
  ACTIONS,
  UNIT_TYPES,
  UNIT_STATS,
  TERRAIN,
  TERRAIN_PROPS,
  ECONOMY,
  SCORING,
  DAMAGE_MULTIPLIERS,
  DISTANCE_1_OFFSETS,
} = require('./constants');

const {
  validateAction,
  getCityCost,
  getTile,
  getUnit,
  getCity,
  isInZoC,
  chebyshevDistance,
  manhattanDistance,
  getTilesAtDistance1,
  isAdjacentToOwnTerritory,
  getConnectedTerritory,
} = require('./validation');

/**
 * Deep clone game state
 */
function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Calculate income for a player
 */
function calculateIncome(state, playerId) {
  let income = 0;

  // Territory income
  for (const tile of state.map.tiles) {
    if (tile.owner === playerId && TERRAIN_PROPS[tile.type]?.controllable) {
      income += TERRAIN_PROPS[tile.type].income;
    }
  }

  // City income
  for (const city of state.cities) {
    if (city.owner === playerId) {
      income += ECONOMY.CITY_INCOME;
    }
  }

  return income;
}

/**
 * Calculate unit upkeep for a player (geometrically growing)
 * Each city supports FREE_UNITS_PER_CITY units for free.
 * Excess units cost UPKEEP_BASE * UPKEEP_GROWTH^(i-1) each, summed.
 */
function calculateUpkeep(state, playerId) {
  const unitCount = state.units.filter((u) => u.owner === playerId).length;
  const cityCount = state.cities.filter((c) => c.owner === playerId).length;
  const freeUnits = cityCount * ECONOMY.FREE_UNITS_PER_CITY;
  const excess = Math.max(0, unitCount - freeUnits);
  if (excess <= 0) return 0;

  // Geometric series: sum = base * (growth^excess - 1) / (growth - 1)
  const { UPKEEP_BASE: base, UPKEEP_GROWTH: growth } = ECONOMY;
  return (base * (Math.pow(growth, excess) - 1)) / (growth - 1);
}

/**
 * Phase 1: Income - Collect gold from territory and cities, deduct unit upkeep
 */
function processIncomePhase(state, events) {
  for (const player of state.players) {
    const income = calculateIncome(state, player.id);
    const upkeep = calculateUpkeep(state, player.id);
    const netIncome = income - upkeep;
    player.gold += netIncome;
    player.income = netIncome;

    // If gold goes negative, disband cheapest units until solvent
    while (player.gold < 0) {
      const playerUnits = state.units.filter((u) => u.owner === player.id);
      if (playerUnits.length === 0) break;

      // Disband cheapest unit first (raiders → soldiers → archers)
      playerUnits.sort((a, b) => UNIT_STATS[a.type].cost - UNIT_STATS[b.type].cost);
      const disbanded = playerUnits[0];
      state.units = state.units.filter((u) => u !== disbanded);

      // Refund half the upkeep saved and recalculate
      const newUpkeep = calculateUpkeep(state, player.id);
      player.gold += upkeep - newUpkeep; // Restore the upkeep difference

      events.push({
        type: 'DISBAND',
        data: {
          unit: { x: disbanded.x, y: disbanded.y, type: disbanded.type, owner: player.id },
          reason: 'upkeep',
        },
      });
    }
  }
}

/**
 * Phase 2: Archer - Archers shoot enemies
 */
function processArcherPhase(state, events) {
  const archers = state.units.filter((u) => u.type === UNIT_TYPES.ARCHER);
  // Shuffle archers so neither team consistently fires first
  for (let i = archers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [archers[i], archers[j]] = [archers[j], archers[i]];
  }

  for (const archer of archers) {
    // Find living enemies within range 2
    // Find targets — skip any with 0x damage multiplier (can't damage them)
    const enemies = state.units.filter((u) => {
      if (u.owner === archer.owner || u.hp <= 0) return false;
      const mult = DAMAGE_MULTIPLIERS[UNIT_TYPES.ARCHER][u.type];
      if (mult <= 0) return false;
      const dist = chebyshevDistance(archer.x, archer.y, u.x, u.y);
      return dist >= 1 && dist <= UNIT_STATS[UNIT_TYPES.ARCHER].rangedRange;
    });

    if (enemies.length === 0) continue;

    // Select target: nearest (Manhattan distance), then lowest HP, then random
    enemies.sort((a, b) => {
      const distA = manhattanDistance(archer.x, archer.y, a.x, a.y);
      const distB = manhattanDistance(archer.x, archer.y, b.x, b.y);
      if (distA !== distB) return distA - distB;
      if (a.hp !== b.hp) return a.hp - b.hp;
      // Random tiebreaker to avoid spatial bias
      return Math.random() - 0.5;
    });

    const target = enemies[0];
    const baseDamage = UNIT_STATS[UNIT_TYPES.ARCHER].damage;
    const mult = DAMAGE_MULTIPLIERS[UNIT_TYPES.ARCHER][target.type];
    const damage = Math.floor(baseDamage * mult);

    // Apply damage immediately (sequential — allows archers to spread damage)
    target.hp -= damage;

    // Mark archer as unable to move
    archer.canMove = false;

    // Score for damage
    const attackerOwner = state.players.find((p) => p.id === archer.owner);
    const isKill = target.hp <= 0;
    const scoreGain = isKill ? SCORING.KILL_BONUS : SCORING.DAMAGE_DEALT;
    attackerOwner.score += scoreGain;

    events.push({
      type: 'COMBAT',
      data: {
        phase: 'archer',
        attacker: { x: archer.x, y: archer.y, type: archer.type, owner: archer.owner },
        target: { x: target.x, y: target.y, type: target.type, owner: target.owner },
        damage,
        isKill,
        scoreGain,
      },
    });

    // If killed, give death bonus to target owner
    if (isKill) {
      const targetOwner = state.players.find((p) => p.id === target.owner);
      const deathScore = UNIT_STATS[target.type].deathScore;
      targetOwner.score += deathScore;

      events.push({
        type: 'DEATH',
        data: {
          unit: { x: target.x, y: target.y, type: target.type, owner: target.owner },
          deathScore,
        },
      });
    }
  }

  // Remove dead units
  state.units = state.units.filter((u) => u.hp > 0);
}

/**
 * Phase 3: Movement - Process move actions
 */
function processMovementPhase(state, actions, events) {
  // Collect all valid move actions per player
  const moveQueues = [[], []];

  for (const playerId of [0, 1]) {
    const playerActions = actions[`player${playerId}`] || [];
    for (const action of playerActions) {
      if (action.action !== ACTIONS.MOVE) continue;

      const result = validateAction(state, playerId, action);
      if (!result.valid) continue;

      const unit = state.units.find(
        (u) => u.x === action.from_x && u.y === action.from_y && u.owner === playerId
      );
      if (!unit || !unit.canMove) continue;

      // Check ZoC
      if (isInZoC(state, unit)) continue;

      moveQueues[playerId].push({ playerId, action, unit });
    }
  }

  // Interleave moves: alternate between players, random who goes first
  const moves = [];
  const first = Math.random() < 0.5 ? 0 : 1;
  const second = 1 - first;
  const mi = [0, 0];
  while (mi[0] < moveQueues[0].length || mi[1] < moveQueues[1].length) {
    for (const pid of [first, second]) {
      if (mi[pid] < moveQueues[pid].length) {
        moves.push(moveQueues[pid][mi[pid]]);
        mi[pid]++;
      }
    }
  }

  // Process moves
  for (const { playerId, action, unit } of moves) {
    const { to_x, to_y } = action;

    // Check if target still available (no collision with other moved units)
    const unitAtTarget = state.units.find((u) => u.x === to_x && u.y === to_y);
    if (unitAtTarget) continue;

    // Get target tile
    const targetTile = state.map.tiles.find((t) => t.x === to_x && t.y === to_y);
    if (!targetTile) continue;

    // Move unit
    unit.x = to_x;
    unit.y = to_y;

    // Check for city capture (soldier walking into enemy city)
    if (UNIT_STATS[unit.type].canCaptureCities) {
      const city = state.cities.find((c) => c.x === to_x && c.y === to_y);
      if (city && city.owner !== playerId) {
        const previousOwner = city.owner;
        city.owner = playerId;

        // Transfer city's tile to captor
        targetTile.owner = playerId;

        events.push({
          type: 'CITY_CAPTURED',
          data: {
            city: { x: city.x, y: city.y },
            previousOwner,
            newOwner: playerId,
            capturedBy: { x: unit.x, y: unit.y, type: unit.type },
          },
        });
      }
    }

    // Check for territory raiding (non-raiders only — raiders plunder in bulk below)
    if (
      unit.type !== UNIT_TYPES.RAIDER &&
      targetTile.owner !== null &&
      targetTile.owner !== playerId
    ) {
      // Raid: make neutral and stop movement
      const previousOwner = targetTile.owner;
      targetTile.owner = null;
      unit.canMove = false; // Stop further movement this turn

      events.push({
        type: 'CAPTURE',
        data: {
          tile: { x: to_x, y: to_y },
          previousOwner,
          raidedBy: { x: unit.x, y: unit.y, type: unit.type, owner: playerId },
        },
      });
    }
  }

  // --- Raider plunder pass: every raider plunders 3x3 around its position ---
  for (const unit of state.units) {
    if (unit.type !== UNIT_TYPES.RAIDER) continue;
    const plunderOffsets = [{ dx: 0, dy: 0 }, ...DISTANCE_1_OFFSETS];
    let plunderCount = 0;
    for (const { dx, dy } of plunderOffsets) {
      const tx = unit.x + dx;
      const ty = unit.y + dy;
      const tile = getTile(state, tx, ty);
      if (!tile) continue;
      if (tile.owner !== null && tile.owner !== unit.owner && tile.type === TERRAIN.FIELD) {
        // Don't plunder city tiles
        const isCity = state.cities.some((c) => c.x === tx && c.y === ty);
        if (isCity) continue;
        tile.owner = null;
        plunderCount++;
      }
    }
    if (plunderCount > 0) {
      const player = state.players.find((p) => p.id === unit.owner);
      player.gold += plunderCount * ECONOMY.PLUNDER_GOLD;
      events.push({
        type: 'PLUNDER',
        data: {
          raider: { x: unit.x, y: unit.y, owner: unit.owner },
          tilesPlundered: plunderCount,
          goldGained: plunderCount * ECONOMY.PLUNDER_GOLD,
        },
      });
    }
  }
}

/**
 * Phase 4: Combat - Melee combat resolves
 */
function processCombatPhase(state, events) {
  // Collect all damage to apply (simultaneous resolution)
  const damageQueue = []; // { target, damage, attacker }

  for (const unit of state.units) {
    // Only soldiers and raiders do melee
    if (!UNIT_STATS[unit.type].meleeAttack) continue;

    const baseDamage = UNIT_STATS[unit.type].damage;

    // Find all adjacent enemies
    const adjacent = getTilesAtDistance1(unit.x, unit.y);
    for (const pos of adjacent) {
      const enemy = state.units.find(
        (u) => u.x === pos.x && u.y === pos.y && u.owner !== unit.owner
      );
      if (enemy) {
        // Apply counter triangle damage multiplier
        const mult = DAMAGE_MULTIPLIERS[unit.type][enemy.type];
        const damage = Math.floor(baseDamage * mult);
        if (damage > 0) {
          damageQueue.push({ target: enemy, damage, attacker: unit });
        }
      }
    }
  }

  // Apply all damage simultaneously
  for (const { target, damage, attacker } of damageQueue) {
    target.hp -= damage;

    const attackerOwner = state.players.find((p) => p.id === attacker.owner);
    const isKill = target.hp <= 0;
    const scoreGain = isKill ? SCORING.KILL_BONUS : SCORING.DAMAGE_DEALT;
    attackerOwner.score += scoreGain;

    events.push({
      type: 'COMBAT',
      data: {
        phase: 'melee',
        attacker: { x: attacker.x, y: attacker.y, type: attacker.type, owner: attacker.owner },
        target: { x: target.x, y: target.y, type: target.type, owner: target.owner },
        damage,
        isKill,
        scoreGain,
      },
    });
  }

  // Process deaths and give death bonuses
  const deadUnits = state.units.filter((u) => u.hp <= 0);
  for (const unit of deadUnits) {
    const owner = state.players.find((p) => p.id === unit.owner);
    const deathScore = UNIT_STATS[unit.type].deathScore;
    owner.score += deathScore;

    events.push({
      type: 'DEATH',
      data: {
        unit: { x: unit.x, y: unit.y, type: unit.type, owner: unit.owner },
        deathScore,
      },
    });
  }

  // Remove dead units
  state.units = state.units.filter((u) => u.hp > 0);
}

/**
 * Process a single build/city/unit action for a player. Returns true if processed.
 */
function processSingleBuildAction(state, playerId, action) {
  const player = state.players.find((p) => p.id === playerId);

  const result = validateAction(state, playerId, action);
  if (!result.valid) return false;

  if (action.action === ACTIONS.BUILD_UNIT) {
    const cost = UNIT_STATS[action.unit_type].cost;
    if (player.gold < cost) return false;

    const unitAtCity = state.units.find((u) => u.x === action.city_x && u.y === action.city_y);
    if (unitAtCity) return false;

    player.gold -= cost;
    state.units.push({
      x: action.city_x,
      y: action.city_y,
      owner: playerId,
      type: action.unit_type,
      hp: UNIT_STATS[action.unit_type].hp,
      canMove: false,
    });
    return true;
  } else if (action.action === ACTIONS.BUILD_CITY) {
    const cityCost = getCityCost(state, playerId);
    if (player.gold < cityCost) return false;

    const unitAtPos = state.units.find((u) => u.x === action.x && u.y === action.y);
    const cityAtPos = state.cities.find((c) => c.x === action.x && c.y === action.y);
    if (unitAtPos || cityAtPos) return false;

    player.gold -= cityCost;
    state.cities.push({ x: action.x, y: action.y, owner: playerId });
    return true;
  } else if (action.action === ACTIONS.EXPAND_TERRITORY) {
    if (player.gold < ECONOMY.EXPAND_COST) return false;

    const tile = state.map.tiles.find((t) => t.x === action.x && t.y === action.y);
    if (!tile || tile.owner !== null) return false;

    // Must be adjacent to city-connected territory
    const connected = getConnectedTerritory(state, playerId);
    const adj = getTilesAtDistance1(action.x, action.y);
    if (!adj.some((pos) => connected.has(`${pos.x},${pos.y}`))) return false;

    player.gold -= ECONOMY.EXPAND_COST;
    tile.owner = playerId;
    return true;
  }
  return false;
}

/**
 * Phase 5: Build - Process builds and expansions
 * Interleaves expand actions between players to prevent P0 bias.
 */
function processBuildPhase(state, actions, events) {
  const BUILD_ACTIONS = [ACTIONS.BUILD_UNIT, ACTIONS.BUILD_CITY, ACTIONS.EXPAND_TERRITORY];

  // Separate expand actions from other build actions for each player
  const buildQueues = [[], []];
  const expandQueues = [[], []];

  for (const playerId of [0, 1]) {
    for (const action of actions[`player${playerId}`] || []) {
      if (!BUILD_ACTIONS.includes(action.action)) continue;
      if (action.action === ACTIONS.EXPAND_TERRITORY) {
        expandQueues[playerId].push(action);
      } else {
        buildQueues[playerId].push(action);
      }
    }
  }

  // Process unit builds and city builds first (order doesn't matter — no contested tiles)
  for (const playerId of [0, 1]) {
    for (const action of buildQueues[playerId]) {
      processSingleBuildAction(state, playerId, action);
    }
  }

  // Interleave expand actions: alternate between players, random who goes first
  const first = Math.random() < 0.5 ? 0 : 1;
  const second = 1 - first;
  const indices = [0, 0];

  while (indices[0] < expandQueues[0].length || indices[1] < expandQueues[1].length) {
    for (const pid of [first, second]) {
      if (indices[pid] < expandQueues[pid].length) {
        processSingleBuildAction(state, pid, expandQueues[pid][indices[pid]]);
        indices[pid]++;
      }
    }
  }
}

/**
 * Phase 6: Scoring - Monument control and end-of-turn scoring
 */
function processScoringPhase(state, events) {
  for (const monument of state.monuments) {
    // Find units adjacent to this monument
    const adjacent = getTilesAtDistance1(monument.x, monument.y);
    const adjacentUnits = { 0: [], 1: [] };

    for (const pos of adjacent) {
      const unit = state.units.find((u) => u.x === pos.x && u.y === pos.y);
      if (unit) {
        adjacentUnits[unit.owner].push(unit);
      }
    }

    const team0Adjacent = adjacentUnits[0].length > 0;
    const team1Adjacent = adjacentUnits[1].length > 0;

    if (team0Adjacent && team1Adjacent) {
      monument.controlledBy = Math.random() < 0.5 ? 0 : 1;
    } else if (team0Adjacent) {
      monument.controlledBy = 0;
    } else if (team1Adjacent) {
      monument.controlledBy = 1;
    }
    // If no one adjacent, keep previous control

    if (monument.controlledBy !== null) {
      const controller = state.players.find((p) => p.id === monument.controlledBy);
      const goldAwarded = ECONOMY.MONUMENT_GOLD;
      const scoreAwarded = state.cities.length * SCORING.MONUMENT_PER_CITY;
      controller.gold += goldAwarded;
      controller.score += scoreAwarded;

      events.push({
        type: 'MONUMENT_CONTROL',
        data: {
          x: monument.x,
          y: monument.y,
          controlledBy: monument.controlledBy,
          goldAwarded,
          scoreAwarded,
        },
      });
    }
  }
}

/**
 * Check for game end conditions
 */
function checkGameEnd(state) {
  // Check elimination (no cities)
  for (const player of state.players) {
    const playerCities = state.cities.filter((c) => c.owner === player.id);
    if (playerCities.length === 0) {
      state.gameOver = true;
      state.winner = player.id === 0 ? 1 : 0;
      state.winReason = 'elimination';
      return;
    }
  }

  // Check max turns
  if (state.turn >= state.maxTurns) {
    state.gameOver = true;

    const score0 = state.players[0].score;
    const score1 = state.players[1].score;

    if (score0 > score1) {
      state.winner = 0;
      state.winReason = 'score';
    } else if (score1 > score0) {
      state.winner = 1;
      state.winReason = 'score';
    } else {
      state.winner = null;
      state.winReason = 'tie';
    }
  }
}

/**
 * Reset unit movement flags for next turn
 */
function resetUnitFlags(state) {
  for (const unit of state.units) {
    unit.canMove = true;
  }
}

/**
 * Main turn processor - stateless function
 * @param {Object} state - Current game state
 * @param {Object} actions - Actions from both players { player0: [], player1: [] }
 * @returns {Object} { newState, errors, info }
 */
function processTurn(state, actions) {
  // Clone state for immutability
  const newState = cloneState(state);
  const events = [];
  const errors = [];

  // Don't process if game is over
  if (newState.gameOver) {
    return {
      newState,
      errors: ['Game is already over'],
      info: {
        gameOver: true,
        winner: newState.winner,
        turnEvents: [],
      },
    };
  }

  // Process all phases in order
  processIncomePhase(newState, events);
  processArcherPhase(newState, events);
  processMovementPhase(newState, actions, events);
  processCombatPhase(newState, events);
  processBuildPhase(newState, actions, events);
  processScoringPhase(newState, events);

  // Check game end
  checkGameEnd(newState);

  // If game not over, prepare for next turn
  if (!newState.gameOver) {
    resetUnitFlags(newState);
    newState.turn++;

    // Recalculate income for display
    for (const player of newState.players) {
      player.income = calculateIncome(newState, player.id);
    }
  }

  return {
    newState,
    errors,
    info: {
      gameOver: newState.gameOver,
      winner: newState.winner,
      turnEvents: events,
    },
  };
}

module.exports = {
  processTurn,
  cloneState,
  calculateIncome,
  calculateUpkeep,
};
