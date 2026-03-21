/**
 * Dumb Agent - Makes random valid actions
 * Used for testing basic game functionality
 */

const {
  ACTIONS,
  UNIT_TYPES,
  UNIT_STATS,
  ECONOMY,
  validateAction,
  getTilesAtDistance1,
  getUnit,
  getCity,
  isInZoC,
} = require('../logic');

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

  // For simplicity, just check distance 1 tiles (even for raiders)
  const adjacent = getTilesAtDistance1(unit.x, unit.y);

  for (const pos of adjacent) {
    const action = {
      action: ACTIONS.MOVE,
      from_x: unit.x,
      from_y: unit.y,
      to_x: pos.x,
      to_y: pos.y,
    };

    const result = validateAction(state, unit.owner, action);
    if (result.valid) {
      moves.push(action);
    }
  }

  return moves;
}

/**
 * Get valid build unit actions
 */
function getValidBuilds(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const builds = [];

  for (const city of state.cities) {
    if (city.owner !== playerId) continue;

    // Check if city is blocked
    const unitAtCity = getUnit(state, city.x, city.y);
    if (unitAtCity) continue;

    // Try each unit type
    for (const unitType of Object.values(UNIT_TYPES)) {
      if (player.gold >= UNIT_STATS[unitType].cost) {
        builds.push({
          action: ACTIONS.BUILD_UNIT,
          city_x: city.x,
          city_y: city.y,
          unit_type: unitType,
        });
      }
    }
  }

  return builds;
}

/**
 * Get valid expand actions
 */
function getValidExpands(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (player.gold < ECONOMY.EXPAND_COST) return [];

  const expands = [];
  const ownedTiles = state.map.tiles.filter((t) => t.owner === playerId);

  for (const tile of ownedTiles) {
    const adjacent = getTilesAtDistance1(tile.x, tile.y);
    for (const pos of adjacent) {
      const action = {
        action: ACTIONS.EXPAND_TERRITORY,
        x: pos.x,
        y: pos.y,
      };

      const result = validateAction(state, playerId, action);
      if (result.valid) {
        // Avoid duplicates
        if (!expands.find((e) => e.x === pos.x && e.y === pos.y)) {
          expands.push(action);
        }
      }
    }
  }

  return expands;
}

/**
 * Pick a random element from array
 */
function randomPick(arr) {
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate actions for a turn - dumb random strategy
 */
function generateActions(state, playerId) {
  const actions = [];
  const myUnits = state.units.filter((u) => u.owner === playerId);

  // Move units randomly
  for (const unit of myUnits) {
    const moves = getValidMoves(state, unit);
    const move = randomPick(moves);
    if (move) {
      actions.push(move);
    }
  }

  // Maybe build a unit (50% chance)
  if (Math.random() < 0.5) {
    const builds = getValidBuilds(state, playerId);
    const build = randomPick(builds);
    if (build) {
      actions.push(build);
    }
  }

  // Maybe expand territory (30% chance)
  if (Math.random() < 0.3) {
    const expands = getValidExpands(state, playerId);
    const expand = randomPick(expands);
    if (expand) {
      actions.push(expand);
    }
  }

  return actions;
}

module.exports = {
  generateActions,
  getValidMoves,
  getValidBuilds,
  getValidExpands,
};
