/**
 * Fog of war state filtering for Civilization Clash.
 * Produces per-player views that hide information outside their vision.
 */

const { TERRAIN } = require('./constants');

/**
 * Filter game state for a specific player's vision.
 * - Terrain types always visible (map layout is public knowledge)
 * - Monuments always visible (landmarks)
 * - Enemy units outside vision are removed
 * - Enemy cities outside vision are removed
 * - Territory ownership outside vision is hidden (set to null)
 * - Injects _visibleTiles array and _fogEnabled flag for frontend
 *
 * @param {Object} state - Full game state
 * @param {number} playerId - Player ID (0 or 1)
 * @param {Set<string>} visibleTiles - Set of "x,y" strings the player can see
 * @returns {Object} Filtered state (shallow copy with filtered arrays)
 */
function filterStateForPlayer(state, playerId, visibleTiles) {
  // Filter map tiles — keep terrain type, hide ownership outside vision
  const filteredTiles = state.map.tiles.map((tile) => {
    const key = `${tile.x},${tile.y}`;
    if (visibleTiles.has(key)) {
      return tile; // Fully visible
    }
    // Outside vision: keep terrain type, hide ownership
    // Monuments stay as-is (landmark)
    if (tile.type === TERRAIN.MONUMENT) {
      return tile;
    }
    return { ...tile, owner: null };
  });

  // Filter units — keep own units, only show enemy units in vision
  const filteredUnits = state.units.filter((unit) => {
    if (unit.owner === playerId) return true;
    return visibleTiles.has(`${unit.x},${unit.y}`);
  });

  // Filter cities — keep own cities, only show enemy cities in vision
  const filteredCities = state.cities.filter((city) => {
    if (city.owner === playerId) return true;
    return visibleTiles.has(`${city.x},${city.y}`);
  });

  return {
    ...state,
    map: { ...state.map, tiles: filteredTiles },
    units: filteredUnits,
    cities: filteredCities,
    // monuments pass through unfiltered — always visible including controlledBy (tripwire mechanic)
    _visibleTiles: Array.from(visibleTiles),
    _fogEnabled: true,
  };
}

/**
 * Filter turn events for a player's vision.
 * - MONUMENT_CONTROL: always visible (public event)
 * - COMBAT/DEATH: visible if any participant is yours or in vision
 * - CITY_CAPTURED: visible if city location is in vision
 * - CAPTURE (raid): visible if actor is yours or tile is in vision
 *
 * @param {Array} events - Full event list
 * @param {number} playerId - Player ID (0 or 1)
 * @param {Set<string>} visibleTiles - Set of "x,y" strings the player can see
 * @returns {Array} Filtered events
 */
function filterEventsForPlayer(events, playerId, visibleTiles) {
  return events.filter((event) => {
    switch (event.type) {
      case 'MONUMENT_CONTROL':
        return true; // Always public

      case 'COMBAT': {
        const { attacker, target } = event.data;
        if (attacker.owner === playerId || target.owner === playerId) return true;
        if (visibleTiles.has(`${attacker.x},${attacker.y}`)) return true;
        if (visibleTiles.has(`${target.x},${target.y}`)) return true;
        return false;
      }

      case 'DEATH': {
        const { unit } = event.data;
        if (unit.owner === playerId) return true;
        return visibleTiles.has(`${unit.x},${unit.y}`);
      }

      case 'CITY_CAPTURED': {
        const { city } = event.data;
        return visibleTiles.has(`${city.x},${city.y}`);
      }

      case 'CAPTURE': {
        const { tile, raidedBy } = event.data;
        if (raidedBy && raidedBy.owner === playerId) return true;
        return visibleTiles.has(`${tile.x},${tile.y}`);
      }

      default:
        return true; // Unknown events pass through
    }
  });
}

module.exports = { filterStateForPlayer, filterEventsForPlayer };
