/**
 * Vision computation for fog of war in Civilization Clash.
 * Determines which tiles a player can see based on their territory, units, and cities.
 */

const { VISION, UNIT_TYPES } = require('./constants');

/**
 * Add all tiles within Chebyshev radius of (cx, cy) to the visible set.
 * Clamps to map bounds.
 */
function addVisionRadius(visible, cx, cy, radius, mapWidth, mapHeight) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx >= 0 && nx < mapWidth && ny >= 0 && ny < mapHeight) {
        visible.add(`${nx},${ny}`);
      }
    }
  }
}

/**
 * Compute the set of visible tiles for a player.
 * Vision sources:
 *   - Own territory tiles (radius 0 = tile itself)
 *   - Own units (per-type radius: Soldier 2, Archer 3, Raider 2)
 *   - Own cities (radius 5)
 *
 * @param {Object} state - Full game state
 * @param {number} playerId - Player ID (0 or 1)
 * @returns {Set<string>} Set of "x,y" strings for all visible tiles
 */
function computeVision(state, playerId) {
  const visible = new Set();
  const w = state.map.width;
  const h = state.map.height;

  // Own territory — each owned tile reveals itself (radius 0)
  for (const tile of state.map.tiles) {
    if (tile.owner === playerId) {
      visible.add(`${tile.x},${tile.y}`);
    }
  }

  // Own units — per-type vision radius
  for (const unit of state.units) {
    if (unit.owner === playerId) {
      const radius = VISION[unit.type] || 2;
      addVisionRadius(visible, unit.x, unit.y, radius, w, h);
    }
  }

  // Own cities — radius 5
  for (const city of state.cities) {
    if (city.owner === playerId) {
      addVisionRadius(visible, city.x, city.y, VISION.CITY, w, h);
    }
  }

  return visible;
}

module.exports = { computeVision };
