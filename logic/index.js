/**
 * Civilization Clash - Game Logic
 * Main entry point and exports
 */

const { processTurn, cloneState, calculateIncome } = require('./processor');
const {
  generateMap,
  generateTournamentMap,
  createInitialState,
  validateMap,
} = require('./map-generator');
const {
  validateAction,
  validateActions,
  getCityCost,
  getTilesAtDistance1,
  chebyshevDistance,
  manhattanDistance,
  isInBounds,
  getTile,
  getUnit,
  getCity,
  isPassable,
  isInZoC,
  isAdjacentToOwnTerritory,
  getConnectedTerritory,
} = require('./validation');
const { renderState, printState, renderEvents, printEvents } = require('./terminal');
const { computeVision } = require('./vision');
const { filterStateForPlayer, filterEventsForPlayer } = require('./fog');
const constants = require('./constants');

// Re-export everything
module.exports = {
  // Core functions
  processTurn,
  createInitialState,
  generateMap,
  generateTournamentMap,
  validateActions,

  // Utility functions
  validateAction,
  validateMap,
  cloneState,
  calculateIncome,
  getCityCost,

  // Helper functions
  getTilesAtDistance1,
  chebyshevDistance,
  manhattanDistance,
  isInBounds,
  getTile,
  getUnit,
  getCity,
  isPassable,
  isInZoC,
  isAdjacentToOwnTerritory,
  getConnectedTerritory,

  // Fog of war
  computeVision,
  filterStateForPlayer,
  filterEventsForPlayer,

  // Terminal visualization
  renderState,
  printState,
  renderEvents,
  printEvents,

  // Constants
  ...constants,
};
