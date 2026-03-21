/**
 * Game constants for Civilization Clash
 */

// Game modes
const MODES = {
  STANDARD: 'standard',
  BLITZ: 'blitz',
  TOURNAMENT: 'tournament',
};

// Mode-specific settings
const MODE_SETTINGS = {
  [MODES.STANDARD]: {
    maxTurns: 200,
    mapWidth: 25,
    mapHeight: 15,
    startingGold: 20,
  },
  [MODES.BLITZ]: {
    maxTurns: 50,
    mapWidth: 15,
    mapHeight: 11,
    startingGold: 50,
  },
  [MODES.TOURNAMENT]: {
    maxTurns: 350,
    mapWidth: 25,
    mapHeight: 23,
    startingGold: 40,
  },
};

// Terrain types
const TERRAIN = {
  FIELD: 'FIELD',
  MOUNTAIN: 'MOUNTAIN',
  WATER: 'WATER',
  MONUMENT: 'MONUMENT',
};

// Terrain properties
const TERRAIN_PROPS = {
  [TERRAIN.FIELD]: { passable: true, controllable: true, income: 0.5 },
  [TERRAIN.MOUNTAIN]: { passable: false, controllable: false, income: 0 },
  [TERRAIN.WATER]: { passable: false, controllable: false, income: 0 },
  [TERRAIN.MONUMENT]: { passable: false, controllable: false, income: 0 },
};

// Unit types
const UNIT_TYPES = {
  SOLDIER: 'SOLDIER',
  ARCHER: 'ARCHER',
  RAIDER: 'RAIDER',
};

// Unit stats
const UNIT_STATS = {
  [UNIT_TYPES.SOLDIER]: {
    cost: 20,
    hp: 2,
    damage: 1,
    movement: 1,
    deathScore: 10, // Score given to owner when this unit dies
    hasZoC: true, // Projects Zone of Control
    zocRange: 2, // ZoC radius
    immuneToZoC: true, // Ignores enemy ZoC
    canCaptureCities: true,
    meleeAttack: true, // Auto-attacks adjacent enemies
    rangedAttack: false,
  },
  [UNIT_TYPES.ARCHER]: {
    cost: 25,
    hp: 2,
    damage: 1,
    movement: 1,
    deathScore: 12,
    hasZoC: false,
    zocRange: 0,
    immuneToZoC: false,
    canCaptureCities: false,
    meleeAttack: false, // Does NOT melee
    rangedAttack: true,
    rangedRange: 2, // Can shoot up to distance 2
  },
  [UNIT_TYPES.RAIDER]: {
    cost: 15,
    hp: 1,
    damage: 1,
    movement: 2,
    deathScore: 3,
    hasZoC: false,
    zocRange: 0,
    immuneToZoC: false,
    canCaptureCities: false,
    meleeAttack: true,
    rangedAttack: false,
  },
};

// Economy
const ECONOMY = {
  FIELD_INCOME: 0.5, // Gold per turn per controlled field
  CITY_INCOME: 5, // Gold per turn per city
  EXPAND_COST: 5, // Cost to expand territory by one tile
  CITY_COST: 80, // Base cost to build a city (scales geometrically)
  CITY_COST_FACTOR: 1.5, // Each additional city costs this much more (80 → 120 → 180 → 270...)
  PLUNDER_GOLD: 3, // Gold gained per tile plundered by raiders
  MONUMENT_GOLD: 3, // Gold per turn per controlled monument
  // Unit upkeep — geometrically growing cost per unit
  UPKEEP_BASE: 1.0, // Base upkeep cost for the first excess unit
  UPKEEP_GROWTH: 1.5, // Each additional unit costs 50% more upkeep than the last
  FREE_UNITS_PER_CITY: 1, // Each city supports this many units for free (no upkeep)
};

// Counter triangle: damage multipliers [attacker_type][target_type]
// HARD triangle: every counter is a one-shot kill (2x damage)
// Soldiers beat raiders, Raiders beat archers, Archers beat soldiers
const DAMAGE_MULTIPLIERS = {
  [UNIT_TYPES.SOLDIER]: {
    [UNIT_TYPES.SOLDIER]: 1.0,
    [UNIT_TYPES.ARCHER]: 1.0,
    [UNIT_TYPES.RAIDER]: 2.0, // Soldiers crush raiders (2 dmg = instant kill 1HP raider)
  },
  [UNIT_TYPES.ARCHER]: {
    [UNIT_TYPES.SOLDIER]: 2.0, // Archers pierce soldier armor (2 dmg = instant kill 2HP soldier)
    [UNIT_TYPES.ARCHER]: 1.0,
    [UNIT_TYPES.RAIDER]: 1.0, // Archers CAN shoot raiders (1 dmg = kill 1HP raider)
  },
  [UNIT_TYPES.RAIDER]: {
    [UNIT_TYPES.SOLDIER]: 0.0, // Raiders bounce off soldier armor (0 damage)
    [UNIT_TYPES.ARCHER]: 2.0, // Raiders assassinate archers (2 dmg = instant kill 2HP archer)
    [UNIT_TYPES.RAIDER]: 1.0,
  },
};

// Scoring
const SCORING = {
  DAMAGE_DEALT: 5, // Score per damage dealt
  KILL_BONUS: 7, // Score when killing an enemy unit (instead of 5)
  MONUMENT_PER_CITY: 3, // Monument awards this much score per city on the map
};

// Action types
const ACTIONS = {
  MOVE: 'MOVE',
  BUILD_UNIT: 'BUILD_UNIT',
  BUILD_CITY: 'BUILD_CITY',
  EXPAND_TERRITORY: 'EXPAND_TERRITORY',
  PASS: 'PASS',
};

// Direction offsets for distance 1 (8 surrounding tiles)
const DISTANCE_1_OFFSETS = [
  { dx: -1, dy: -1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 1 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
];

// Vision radii (Chebyshev distance) for fog of war
const VISION = {
  [UNIT_TYPES.SOLDIER]: 2,
  [UNIT_TYPES.ARCHER]: 3,
  [UNIT_TYPES.RAIDER]: 2,
  CITY: 5,
  TERRITORY: 0, // Own territory tiles see only themselves
};

module.exports = {
  MODES,
  MODE_SETTINGS,
  TERRAIN,
  TERRAIN_PROPS,
  UNIT_TYPES,
  UNIT_STATS,
  ECONOMY,
  SCORING,
  ACTIONS,
  DAMAGE_MULTIPLIERS,
  VISION,
  DISTANCE_1_OFFSETS,
};
