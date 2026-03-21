/**
 * Comprehensive tests for Civilization Clash game logic
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  processTurn,
  createInitialState,
  generateMap,
  validateActions,
  validateAction,
  getCityCost,
  cloneState,
  getTilesAtDistance1,
  chebyshevDistance,
  manhattanDistance,
  isInZoC,
  calculateIncome,
  computeVision,
  filterStateForPlayer,
  filterEventsForPlayer,
  MODES,
  TERRAIN,
  UNIT_TYPES,
  UNIT_STATS,
  ACTIONS,
  ECONOMY,
  SCORING,
  VISION,
  getConnectedTerritory,
} = require('../index');

// Helper to create a minimal test state
function createTestState(overrides = {}) {
  const state = {
    turn: 1,
    maxTurns: 200,
    gameOver: false,
    winner: null,
    mode: MODES.STANDARD,
    players: [
      { id: 0, gold: 100, score: 0, income: 5 },
      { id: 1, gold: 100, score: 0, income: 5 },
    ],
    map: {
      width: 10,
      height: 10,
      tiles: [],
    },
    units: [],
    cities: [
      { x: 1, y: 5, owner: 0 },
      { x: 8, y: 5, owner: 1 },
    ],
    monuments: [{ x: 5, y: 5, controlledBy: null }],
  };

  // Create tiles
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      let type = TERRAIN.FIELD;
      let owner = null;

      // Make edges water
      if (x === 0 || x === 9 || y === 0 || y === 9) {
        type = TERRAIN.WATER;
      }
      // Monument at center
      else if (x === 5 && y === 5) {
        type = TERRAIN.MONUMENT;
      }
      // Starting territories
      else if (x >= 1 && x <= 2 && y >= 4 && y <= 6) {
        owner = 0;
      } else if (x >= 7 && x <= 8 && y >= 4 && y <= 6) {
        owner = 1;
      }

      state.map.tiles.push({ x, y, type, owner });
    }
  }

  // Apply overrides
  return { ...state, ...overrides };
}

// ===== DISTANCE TESTS =====

describe('Distance calculations', () => {
  it('chebyshevDistance calculates correct distance', () => {
    assert.strictEqual(chebyshevDistance(0, 0, 0, 0), 0);
    assert.strictEqual(chebyshevDistance(0, 0, 1, 0), 1);
    assert.strictEqual(chebyshevDistance(0, 0, 1, 1), 1); // Diagonal is distance 1
    assert.strictEqual(chebyshevDistance(0, 0, 2, 2), 2);
    assert.strictEqual(chebyshevDistance(0, 0, 3, 1), 3);
  });

  it('manhattanDistance calculates correct distance', () => {
    assert.strictEqual(manhattanDistance(0, 0, 0, 0), 0);
    assert.strictEqual(manhattanDistance(0, 0, 1, 0), 1);
    assert.strictEqual(manhattanDistance(0, 0, 1, 1), 2); // Manhattan: 1+1=2
    assert.strictEqual(manhattanDistance(0, 0, 2, 3), 5);
  });

  it('getTilesAtDistance1 returns 8 tiles', () => {
    const tiles = getTilesAtDistance1(5, 5);
    assert.strictEqual(tiles.length, 8);

    // Check all expected positions
    const expected = [
      { x: 4, y: 4 },
      { x: 5, y: 4 },
      { x: 6, y: 4 },
      { x: 4, y: 5 },
      { x: 6, y: 5 },
      { x: 4, y: 6 },
      { x: 5, y: 6 },
      { x: 6, y: 6 },
    ];

    for (const exp of expected) {
      const found = tiles.find((t) => t.x === exp.x && t.y === exp.y);
      assert.ok(found, `Expected tile at (${exp.x}, ${exp.y})`);
    }
  });
});

// ===== MAP GENERATION TESTS =====

describe('Map generation', () => {
  it('generates map with correct dimensions', () => {
    const map = generateMap(25, 15);
    assert.strictEqual(map.width, 25);
    assert.strictEqual(map.height, 15);
    assert.strictEqual(map.tiles.length, 25 * 15);
  });

  it('places monument at center', () => {
    const map = generateMap(25, 15);
    const centerX = Math.floor(25 / 2);
    const centerY = Math.floor(15 / 2);

    const monumentTile = map.tiles.find((t) => t.x === centerX && t.y === centerY);
    assert.strictEqual(monumentTile.type, TERRAIN.MONUMENT);
  });

  it('creates two starting cities', () => {
    const map = generateMap(25, 15);
    assert.strictEqual(map.cities.length, 2);
    assert.strictEqual(map.cities[0].owner, 0);
    assert.strictEqual(map.cities[1].owner, 1);
  });

  it('generates deterministic map with same seed', () => {
    const map1 = generateMap(15, 10, 12345);
    const map2 = generateMap(15, 10, 12345);

    assert.deepStrictEqual(map1.tiles, map2.tiles);
  });
});

// ===== INITIAL STATE TESTS =====

describe('Initial state creation', () => {
  it('creates standard mode state correctly', () => {
    const state = createInitialState({ mode: MODES.STANDARD });

    assert.strictEqual(state.turn, 1);
    assert.strictEqual(state.maxTurns, 200);
    assert.strictEqual(state.map.width, 25);
    assert.strictEqual(state.map.height, 15);
    assert.strictEqual(state.players[0].gold, 20);
    assert.strictEqual(state.players[1].gold, 20);
  });

  it('creates blitz mode state correctly', () => {
    const state = createInitialState({ mode: MODES.BLITZ });

    assert.strictEqual(state.maxTurns, 50);
    assert.strictEqual(state.map.width, 15);
    assert.strictEqual(state.map.height, 11);
    assert.strictEqual(state.players[0].gold, 50);
    assert.strictEqual(state.players[1].gold, 50);
  });

  it('starts with no units', () => {
    const state = createInitialState({ mode: MODES.BLITZ });
    assert.strictEqual(state.units.length, 0);
  });
});

// ===== VALIDATION TESTS =====

describe('Action validation', () => {
  let state;

  beforeEach(() => {
    state = createTestState();
  });

  describe('MOVE validation', () => {
    it('validates valid move', () => {
      state.units.push({
        x: 2,
        y: 5,
        owner: 0,
        type: UNIT_TYPES.SOLDIER,
        hp: 2,
        canMove: true,
      });

      const result = validateAction(state, 0, {
        action: ACTIONS.MOVE,
        from_x: 2,
        from_y: 5,
        to_x: 3,
        to_y: 5,
      });

      assert.ok(result.valid);
    });

    it('rejects move from empty tile', () => {
      const result = validateAction(state, 0, {
        action: ACTIONS.MOVE,
        from_x: 3,
        from_y: 3,
        to_x: 4,
        to_y: 3,
      });

      assert.ok(!result.valid);
      assert.ok(result.error.includes('No unit'));
    });

    it('rejects move of enemy unit', () => {
      state.units.push({
        x: 2,
        y: 5,
        owner: 1,
        type: UNIT_TYPES.SOLDIER,
        hp: 2,
        canMove: true,
      });

      const result = validateAction(state, 0, {
        action: ACTIONS.MOVE,
        from_x: 2,
        from_y: 5,
        to_x: 3,
        to_y: 5,
      });

      assert.ok(!result.valid);
      assert.ok(result.error.includes('another player'));
    });

    it('rejects move to occupied tile', () => {
      state.units.push(
        { x: 2, y: 5, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true },
        { x: 3, y: 5, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true }
      );

      const result = validateAction(state, 0, {
        action: ACTIONS.MOVE,
        from_x: 2,
        from_y: 5,
        to_x: 3,
        to_y: 5,
      });

      assert.ok(!result.valid);
      assert.ok(result.error.includes('occupied'));
    });

    it('rejects move to impassable terrain', () => {
      state.units.push({
        x: 1,
        y: 1,
        owner: 0,
        type: UNIT_TYPES.SOLDIER,
        hp: 2,
        canMove: true,
      });

      const result = validateAction(state, 0, {
        action: ACTIONS.MOVE,
        from_x: 1,
        from_y: 1,
        to_x: 0,
        to_y: 1,
      });

      assert.ok(!result.valid);
      assert.ok(result.error.includes('not passable'));
    });

    it('rejects move exceeding movement distance', () => {
      state.units.push({
        x: 2,
        y: 5,
        owner: 0,
        type: UNIT_TYPES.SOLDIER,
        hp: 2,
        canMove: true,
      });

      const result = validateAction(state, 0, {
        action: ACTIONS.MOVE,
        from_x: 2,
        from_y: 5,
        to_x: 4,
        to_y: 5,
      });

      assert.ok(!result.valid);
      assert.ok(result.error.includes('exceeds'));
    });

    it('allows raider to move 2 tiles', () => {
      state.units.push({
        x: 2,
        y: 5,
        owner: 0,
        type: UNIT_TYPES.RAIDER,
        hp: 1,
        canMove: true,
      });

      const result = validateAction(state, 0, {
        action: ACTIONS.MOVE,
        from_x: 2,
        from_y: 5,
        to_x: 4,
        to_y: 5,
      });

      assert.ok(result.valid);
    });
  });

  describe('BUILD_UNIT validation', () => {
    it('validates valid unit build', () => {
      const result = validateAction(state, 0, {
        action: ACTIONS.BUILD_UNIT,
        city_x: 1,
        city_y: 5,
        unit_type: UNIT_TYPES.SOLDIER,
      });

      assert.ok(result.valid);
    });

    it('rejects build at non-existent city', () => {
      const result = validateAction(state, 0, {
        action: ACTIONS.BUILD_UNIT,
        city_x: 5,
        city_y: 5,
        unit_type: UNIT_TYPES.SOLDIER,
      });

      assert.ok(!result.valid);
      assert.ok(result.error.includes('No city'));
    });

    it('rejects build at enemy city', () => {
      const result = validateAction(state, 0, {
        action: ACTIONS.BUILD_UNIT,
        city_x: 8,
        city_y: 5,
        unit_type: UNIT_TYPES.SOLDIER,
      });

      assert.ok(!result.valid);
      assert.ok(result.error.includes('another player'));
    });

    it('rejects build when city blocked', () => {
      state.units.push({
        x: 1,
        y: 5,
        owner: 0,
        type: UNIT_TYPES.SOLDIER,
        hp: 2,
        canMove: true,
      });

      const result = validateAction(state, 0, {
        action: ACTIONS.BUILD_UNIT,
        city_x: 1,
        city_y: 5,
        unit_type: UNIT_TYPES.SOLDIER,
      });

      assert.ok(!result.valid);
      assert.ok(result.error.includes('blocked'));
    });

    it('rejects build with insufficient gold', () => {
      state.players[0].gold = 10;

      const result = validateAction(state, 0, {
        action: ACTIONS.BUILD_UNIT,
        city_x: 1,
        city_y: 5,
        unit_type: UNIT_TYPES.SOLDIER,
      });

      assert.ok(!result.valid);
      assert.ok(result.error.includes('Not enough gold'));
    });
  });

  describe('EXPAND_TERRITORY validation', () => {
    it('validates valid expansion', () => {
      const result = validateAction(state, 0, {
        action: ACTIONS.EXPAND_TERRITORY,
        x: 3,
        y: 5,
      });

      assert.ok(result.valid);
    });

    it('rejects expansion to already owned tile', () => {
      const result = validateAction(state, 0, {
        action: ACTIONS.EXPAND_TERRITORY,
        x: 2,
        y: 5,
      });

      assert.ok(!result.valid);
      assert.ok(result.error.includes('already owned'));
    });

    it('rejects expansion not adjacent to territory', () => {
      const result = validateAction(state, 0, {
        action: ACTIONS.EXPAND_TERRITORY,
        x: 5,
        y: 3,
      });

      assert.ok(!result.valid);
      assert.ok(result.error.includes('not adjacent'));
    });
  });
});

// ===== ZONE OF CONTROL TESTS =====

describe('Zone of Control', () => {
  let state;

  beforeEach(() => {
    state = createTestState();
  });

  it('soldier traps raider within 2 tiles', () => {
    // Enemy soldier at (5, 3)
    state.units.push({
      x: 5,
      y: 3,
      owner: 1,
      type: UNIT_TYPES.SOLDIER,
      hp: 2,
      canMove: true,
    });

    // Friendly raider at (5, 5) - within 2 tiles
    const raider = {
      x: 5,
      y: 5,
      owner: 0,
      type: UNIT_TYPES.RAIDER,
      hp: 1,
      canMove: true,
    };
    state.units.push(raider);

    assert.ok(isInZoC(state, raider));
  });

  it('soldier does not trap other soldiers', () => {
    state.units.push({
      x: 5,
      y: 3,
      owner: 1,
      type: UNIT_TYPES.SOLDIER,
      hp: 2,
      canMove: true,
    });

    const soldier = {
      x: 5,
      y: 5,
      owner: 0,
      type: UNIT_TYPES.SOLDIER,
      hp: 2,
      canMove: true,
    };
    state.units.push(soldier);

    assert.ok(!isInZoC(state, soldier));
  });

  it('raider outside ZoC range can move', () => {
    state.units.push({
      x: 5,
      y: 3,
      owner: 1,
      type: UNIT_TYPES.SOLDIER,
      hp: 2,
      canMove: true,
    });

    // Raider at (5, 6) - 3 tiles away
    const raider = {
      x: 5,
      y: 6,
      owner: 0,
      type: UNIT_TYPES.RAIDER,
      hp: 1,
      canMove: true,
    };
    state.units.push(raider);

    assert.ok(!isInZoC(state, raider));
  });
});

// ===== TURN PROCESSING TESTS =====

describe('Turn processing', () => {
  let state;

  beforeEach(() => {
    state = createTestState();
  });

  describe('Income phase', () => {
    it('collects gold from territory and cities', () => {
      const initialGold = state.players[0].gold;
      const { newState } = processTurn(state, { player0: [], player1: [] });

      // Player 0 has 6 field tiles + 1 city = 0.5*6 + 5 = 8 income
      assert.ok(newState.players[0].gold > initialGold);
    });
  });

  describe('Archer phase', () => {
    it('archer shoots nearest enemy', () => {
      // Use raider target (1x multiplier) to test basic archer shooting
      state.units.push(
        { x: 2, y: 5, owner: 0, type: UNIT_TYPES.ARCHER, hp: 2, canMove: true },
        { x: 4, y: 5, owner: 1, type: UNIT_TYPES.RAIDER, hp: 1, canMove: true }
      );

      const { newState, info } = processTurn(state, { player0: [], player1: [] });

      // Raider (1HP) should be killed by archer (1 damage * 1x multiplier)
      const enemy = newState.units.find((u) => u.owner === 1);
      assert.strictEqual(enemy, undefined); // Killed

      // Archer should be marked as able to move (reset at end of turn)
      const archer = newState.units.find((u) => u.type === UNIT_TYPES.ARCHER);
      assert.ok(archer.canMove);

      // Check combat event
      const combatEvent = info.turnEvents.find((e) => e.type === 'COMBAT');
      assert.ok(combatEvent);
      assert.strictEqual(combatEvent.data.phase, 'archer');
    });

    it('archer prioritizes lowest HP on tie', () => {
      state.units.push(
        { x: 3, y: 5, owner: 0, type: UNIT_TYPES.ARCHER, hp: 2, canMove: true },
        { x: 4, y: 4, owner: 1, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true },
        { x: 4, y: 6, owner: 1, type: UNIT_TYPES.SOLDIER, hp: 1, canMove: true }
      );

      const { newState } = processTurn(state, { player0: [], player1: [] });

      // Lower HP soldier (at 4,6 with 1hp) should be targeted and killed
      const lowHpSoldier = newState.units.find((u) => u.x === 4 && u.y === 6);
      assert.strictEqual(lowHpSoldier, undefined); // killed (1hp - 1dmg = 0)

      const highHpSoldier = newState.units.find((u) => u.x === 4 && u.y === 4);
      assert.strictEqual(highHpSoldier.hp, 2); // untouched
    });
  });

  describe('Movement phase', () => {
    it('processes valid move', () => {
      state.units.push({
        x: 2,
        y: 5,
        owner: 0,
        type: UNIT_TYPES.SOLDIER,
        hp: 2,
        canMove: true,
      });

      const { newState } = processTurn(state, {
        player0: [{ action: ACTIONS.MOVE, from_x: 2, from_y: 5, to_x: 3, to_y: 5 }],
        player1: [],
      });

      const unit = newState.units.find((u) => u.owner === 0);
      assert.strictEqual(unit.x, 3);
      assert.strictEqual(unit.y, 5);
    });

    it('raiding enemy territory makes it neutral', () => {
      state.units.push({
        x: 6,
        y: 5,
        owner: 0,
        type: UNIT_TYPES.SOLDIER,
        hp: 2,
        canMove: true,
      });

      const { newState, info } = processTurn(state, {
        player0: [{ action: ACTIONS.MOVE, from_x: 6, from_y: 5, to_x: 7, to_y: 5 }],
        player1: [],
      });

      const raidedTile = newState.map.tiles.find((t) => t.x === 7 && t.y === 5);
      assert.strictEqual(raidedTile.owner, null);

      const captureEvent = info.turnEvents.find((e) => e.type === 'CAPTURE');
      assert.ok(captureEvent);
    });
  });

  describe('Combat phase', () => {
    it('soldiers auto-attack adjacent enemies', () => {
      state.units.push(
        { x: 3, y: 5, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true },
        { x: 4, y: 5, owner: 1, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true }
      );

      const { newState, info } = processTurn(state, { player0: [], player1: [] });

      // Both should have taken damage (simultaneous)
      const unit0 = newState.units.find((u) => u.owner === 0);
      const unit1 = newState.units.find((u) => u.owner === 1);

      assert.strictEqual(unit0.hp, 1);
      assert.strictEqual(unit1.hp, 1);
    });

    it('killing unit awards kill bonus', () => {
      state.units.push(
        { x: 3, y: 5, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true },
        { x: 4, y: 5, owner: 1, type: UNIT_TYPES.RAIDER, hp: 1, canMove: true }
      );

      const { newState, info } = processTurn(state, { player0: [], player1: [] });

      // Raider should be dead
      assert.strictEqual(newState.units.filter((u) => u.owner === 1).length, 0);

      // Check for kill score (7 instead of 5)
      const combatEvent = info.turnEvents.find((e) => e.type === 'COMBAT' && e.data.isKill);
      assert.ok(combatEvent);
      assert.strictEqual(combatEvent.data.scoreGain, SCORING.KILL_BONUS);

      // Death bonus should go to raider owner
      const deathEvent = info.turnEvents.find((e) => e.type === 'DEATH');
      assert.ok(deathEvent);
      assert.strictEqual(deathEvent.data.deathScore, UNIT_STATS[UNIT_TYPES.RAIDER].deathScore);
    });
  });

  describe('Build phase', () => {
    it('builds unit at city', () => {
      const { newState } = processTurn(state, {
        player0: [
          { action: ACTIONS.BUILD_UNIT, city_x: 1, city_y: 5, unit_type: UNIT_TYPES.SOLDIER },
        ],
        player1: [],
      });

      const newUnit = newState.units.find((u) => u.x === 1 && u.y === 5);
      assert.ok(newUnit);
      assert.strictEqual(newUnit.type, UNIT_TYPES.SOLDIER);
      assert.strictEqual(newUnit.owner, 0);
      assert.strictEqual(newUnit.hp, 2);

      // Gold should be deducted
      assert.strictEqual(newState.players[0].gold, state.players[0].gold + 8 - 20); // +income -cost
    });

    it('expands territory', () => {
      const { newState } = processTurn(state, {
        player0: [{ action: ACTIONS.EXPAND_TERRITORY, x: 3, y: 5 }],
        player1: [],
      });

      const tile = newState.map.tiles.find((t) => t.x === 3 && t.y === 5);
      assert.strictEqual(tile.owner, 0);

      // Gold deducted
      assert.strictEqual(newState.players[0].gold, state.players[0].gold + 8 - 5);
    });
  });

  describe('Scoring phase', () => {
    it('awards monument control to adjacent unit owner', () => {
      state.units.push({
        x: 5,
        y: 4,
        owner: 0,
        type: UNIT_TYPES.SOLDIER,
        hp: 2,
        canMove: true,
      });

      const { newState, info } = processTurn(state, { player0: [], player1: [] });

      assert.strictEqual(newState.monuments[0].controlledBy, 0);

      const monumentEvent = info.turnEvents.find((e) => e.type === 'MONUMENT_CONTROL');
      assert.ok(monumentEvent);
    });
  });

  describe('City capture', () => {
    it('soldier captures enemy city instantly', () => {
      state.units.push({
        x: 7,
        y: 5,
        owner: 0,
        type: UNIT_TYPES.SOLDIER,
        hp: 2,
        canMove: true,
      });

      const { newState, info } = processTurn(state, {
        player0: [{ action: ACTIONS.MOVE, from_x: 7, from_y: 5, to_x: 8, to_y: 5 }],
        player1: [],
      });

      const city = newState.cities.find((c) => c.x === 8 && c.y === 5);
      assert.strictEqual(city.owner, 0);

      const captureEvent = info.turnEvents.find((e) => e.type === 'CITY_CAPTURED');
      assert.ok(captureEvent);
    });
  });

  describe('Game end', () => {
    it('ends game when player loses all cities', () => {
      // Give player 0 a soldier next to player 1's only city
      state.units.push({
        x: 7,
        y: 5,
        owner: 0,
        type: UNIT_TYPES.SOLDIER,
        hp: 2,
        canMove: true,
      });

      // Remove player 0's city from state (to simulate they only have one)
      // Actually let's capture the enemy city
      const { newState, info } = processTurn(state, {
        player0: [{ action: ACTIONS.MOVE, from_x: 7, from_y: 5, to_x: 8, to_y: 5 }],
        player1: [],
      });

      // After capture, player 1 has no cities
      const player1Cities = newState.cities.filter((c) => c.owner === 1);
      assert.strictEqual(player1Cities.length, 0);

      // Game should be over
      assert.ok(newState.gameOver);
      assert.strictEqual(newState.winner, 0);
    });

    it('ends game at max turns with score comparison', () => {
      state.turn = 200;
      state.players[0].score = 100;
      state.players[1].score = 50;

      const { newState } = processTurn(state, { player0: [], player1: [] });

      assert.ok(newState.gameOver);
      assert.strictEqual(newState.winner, 0);
    });

    it('handles tie at max turns', () => {
      state.turn = 200;
      state.players[0].score = 100;
      state.players[1].score = 100;

      const { newState } = processTurn(state, { player0: [], player1: [] });

      assert.ok(newState.gameOver);
      assert.strictEqual(newState.winner, null);
    });
  });
});

describe('Monument rewards', () => {
  it('awards both gold and score to monument controller', () => {
    const state = createTestState();
    state.units = [{ x: 5, y: 4, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true }];

    const { newState, info } = processTurn(state, { player0: [], player1: [] });

    assert.strictEqual(newState.monuments[0].controlledBy, 0);
    const monumentEvent = info.turnEvents.find((e) => e.type === 'MONUMENT_CONTROL');
    assert.ok(monumentEvent);
    assert.strictEqual(monumentEvent.data.goldAwarded, ECONOMY.MONUMENT_GOLD);
    assert.strictEqual(monumentEvent.data.scoreAwarded, 2 * SCORING.MONUMENT_PER_CITY);
  });

  it('gold is flat 3G, score scales with cities', () => {
    const state = createTestState();
    state.units = [{ x: 5, y: 4, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true }];
    state.cities.push({ x: 3, y: 3, owner: 0 });
    state.cities.push({ x: 7, y: 7, owner: 1 });

    const { info } = processTurn(state, { player0: [], player1: [] });
    const monumentEvent = info.turnEvents.find((e) => e.type === 'MONUMENT_CONTROL');
    assert.ok(monumentEvent);
    // Flat 3G gold
    assert.strictEqual(monumentEvent.data.goldAwarded, ECONOMY.MONUMENT_GOLD);
    // Score scales: 4 cities * 3 = 12
    assert.strictEqual(monumentEvent.data.scoreAwarded, 4 * SCORING.MONUMENT_PER_CITY);
  });
});

// ===== IMMUTABILITY TEST =====

describe('State immutability', () => {
  it('processTurn does not modify original state', () => {
    const state = createTestState();
    const originalGold = state.players[0].gold;
    const originalTurn = state.turn;

    processTurn(state, { player0: [], player1: [] });

    assert.strictEqual(state.players[0].gold, originalGold);
    assert.strictEqual(state.turn, originalTurn);
  });
});

// ===== GEOMETRIC CITY COST TESTS =====

describe('Geometric city cost', () => {
  let state;

  beforeEach(() => {
    state = createTestState({
      players: [
        { id: 0, gold: 500, score: 0, income: 5 },
        { id: 1, gold: 500, score: 0, income: 5 },
      ],
    });
  });

  it('first built city costs base price (capital does not count)', () => {
    // State starts with 1 city (capital) per player
    const cost = getCityCost(state, 0);
    assert.strictEqual(cost, ECONOMY.CITY_COST, 'First built city should cost base 80G');
  });

  it('second built city costs 1.5x base', () => {
    // Add a second city for P0
    state.cities.push({ x: 2, y: 4, owner: 0 });
    const cost = getCityCost(state, 0);
    assert.strictEqual(
      cost,
      Math.round(ECONOMY.CITY_COST * 1.5),
      'Second built city should cost 120G'
    );
  });

  it('third built city costs 2.25x base', () => {
    state.cities.push({ x: 2, y: 4, owner: 0 });
    state.cities.push({ x: 2, y: 6, owner: 0 });
    const cost = getCityCost(state, 0);
    assert.strictEqual(
      cost,
      Math.round(ECONOMY.CITY_COST * 1.5 * 1.5),
      'Third built city should cost 180G'
    );
  });

  it('each player scales independently', () => {
    state.cities.push({ x: 2, y: 4, owner: 0 });
    const costP0 = getCityCost(state, 0);
    const costP1 = getCityCost(state, 1);
    assert.strictEqual(costP0, 120, 'P0 with 2 cities should pay 120G for next');
    assert.strictEqual(costP1, 80, 'P1 with 1 city should still pay 80G');
  });

  it('validation rejects BUILD_CITY when gold < scaled cost', () => {
    state.cities.push({ x: 2, y: 4, owner: 0 });
    // P0 now needs 120G for next city, set gold to 100
    state.players[0].gold = 100;

    const action = { action: ACTIONS.BUILD_CITY, x: 2, y: 6 };
    // Tile must be owned
    const tile = state.map.tiles.find((t) => t.x === 2 && t.y === 6);
    tile.owner = 0;

    const result = validateAction(state, 0, action);
    assert.ok(!result.valid, 'Should reject city build when gold < scaled cost');
  });

  it('processor deducts scaled cost when building city', () => {
    state.cities.push({ x: 2, y: 4, owner: 0 });
    // P0 needs 120G for next city
    state.players[0].gold = 200;

    const tile = state.map.tiles.find((t) => t.x === 2 && t.y === 6);
    tile.owner = 0;

    // First, run a turn with no actions to measure income
    const baseline = processTurn(cloneState(state), { player0: [], player1: [] });
    const goldAfterIncome = baseline.newState.players.find((p) => p.id === 0).gold;

    // Now run with city build
    const actions = {
      player0: [{ action: ACTIONS.BUILD_CITY, x: 2, y: 6 }],
      player1: [],
    };
    const result = processTurn(state, actions);
    const p0 = result.newState.players.find((p) => p.id === 0);
    // Should deduct 120G (scaled cost for 2nd built city)
    assert.strictEqual(p0.gold, goldAfterIncome - 120, 'Should deduct scaled city cost (120G)');
  });
});

// ===== MULTIPLE MONUMENTS TESTS =====

describe('Multiple monuments', () => {
  it('each monument awards gold and score independently', () => {
    const state = createTestState();
    // Add a second monument
    state.monuments.push({ x: 5, y: 8, controlledBy: null });
    state.map.tiles.find((t) => t.x === 5 && t.y === 8).type = TERRAIN.MONUMENT;

    // Place P0 soldiers adjacent to both monuments
    state.units = [
      { x: 5, y: 4, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true },
      { x: 5, y: 7, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true },
    ];

    const { newState, info } = processTurn(state, { player0: [], player1: [] });
    const monumentEvents = info.turnEvents.filter((e) => e.type === 'MONUMENT_CONTROL');
    assert.strictEqual(monumentEvents.length, 2, 'Should have 2 monument control events');

    // Each monument awards flat MONUMENT_GOLD and score scaled by cities
    const totalGold = monumentEvents.reduce((sum, e) => sum + e.data.goldAwarded, 0);
    assert.strictEqual(totalGold, 2 * ECONOMY.MONUMENT_GOLD);
    const totalScore = monumentEvents.reduce((sum, e) => sum + e.data.scoreAwarded, 0);
    assert.strictEqual(totalScore, 2 * 2 * SCORING.MONUMENT_PER_CITY);
  });

  it('different players can control different monuments', () => {
    const state = createTestState();
    state.monuments.push({ x: 5, y: 8, controlledBy: null });
    state.map.tiles.find((t) => t.x === 5 && t.y === 8).type = TERRAIN.MONUMENT;

    // P0 near monument 0, P1 near monument 1
    state.units = [
      { x: 5, y: 4, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true },
      { x: 5, y: 7, owner: 1, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true },
    ];

    const { newState } = processTurn(state, { player0: [], player1: [] });
    assert.strictEqual(newState.monuments[0].controlledBy, 0);
    assert.strictEqual(newState.monuments[1].controlledBy, 1);
  });
});

// ===== RAIDER PLUNDER TESTS =====

describe('Raider plunder', () => {
  it('raider does not stop on enemy territory', () => {
    const state = createTestState();
    // Place raider at (3, 5) on enemy territory
    state.units = [{ x: 3, y: 5, owner: 0, type: UNIT_TYPES.RAIDER, hp: 1, canMove: true }];
    // Set tiles (4,5) and (5,5) as enemy territory (but 5,5 is monument)
    const tile4 = state.map.tiles.find((t) => t.x === 4 && t.y === 5);
    tile4.owner = 1;
    const tile5 = state.map.tiles.find((t) => t.x === 4 && t.y === 4);
    tile5.owner = 1;

    // Move raider to enemy territory at (4, 5)
    const actions = {
      player0: [{ action: ACTIONS.MOVE, from_x: 3, from_y: 5, to_x: 4, to_y: 5 }],
      player1: [],
    };
    const { newState } = processTurn(state, actions);
    const raider = newState.units.find((u) => u.owner === 0 && u.type === UNIT_TYPES.RAIDER);
    assert.ok(raider, 'Raider should still exist');
    assert.strictEqual(raider.x, 4, 'Raider should be at target x');
    assert.strictEqual(raider.y, 5, 'Raider should be at target y');
  });

  it('raider plunders 3x3 area around position', () => {
    const state = createTestState();
    state.players[0].gold = 50;

    // Place raider in middle of enemy territory
    state.units = [{ x: 6, y: 5, owner: 0, type: UNIT_TYPES.RAIDER, hp: 1, canMove: true }];

    // Set 3x3 area around (6,5) as enemy territory
    let enemyTiles = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tile = state.map.tiles.find((t) => t.x === 6 + dx && t.y === 5 + dy);
        if (tile && tile.type === TERRAIN.FIELD) {
          tile.owner = 1;
          enemyTiles++;
        }
      }
    }

    const { newState, info } = processTurn(state, { player0: [], player1: [] });

    // Check plunder event
    const plunderEvent = info.turnEvents.find((e) => e.type === 'PLUNDER');
    assert.ok(plunderEvent, 'Should have plunder event');
    assert.ok(plunderEvent.data.tilesPlundered > 0, 'Should plunder some tiles');
    assert.strictEqual(
      plunderEvent.data.goldGained,
      plunderEvent.data.tilesPlundered * ECONOMY.PLUNDER_GOLD,
      'Gold should be 3G per tile'
    );
  });

  it('raider plunder does not affect city tiles', () => {
    const state = createTestState();
    // Place raider next to enemy city at (8, 5)
    state.units = [{ x: 7, y: 5, owner: 0, type: UNIT_TYPES.RAIDER, hp: 1, canMove: true }];

    // Ensure enemy city tile is owned
    const cityTile = state.map.tiles.find((t) => t.x === 8 && t.y === 5);
    cityTile.owner = 1;

    const { newState } = processTurn(state, { player0: [], player1: [] });

    // City should still belong to P1
    const city = newState.cities.find((c) => c.x === 8 && c.y === 5);
    assert.strictEqual(city.owner, 1, 'City should not be plundered');
  });

  it('non-raider units still stop on enemy territory', () => {
    const state = createTestState();
    // Place soldier, set target as enemy territory
    state.units = [{ x: 3, y: 5, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true }];
    const tile = state.map.tiles.find((t) => t.x === 4 && t.y === 5);
    tile.owner = 1;

    const actions = {
      player0: [{ action: ACTIONS.MOVE, from_x: 3, from_y: 5, to_x: 4, to_y: 5 }],
      player1: [],
    };
    const { newState, info } = processTurn(state, actions);

    // Tile should be neutralized (raided)
    const raidedTile = newState.map.tiles.find((t) => t.x === 4 && t.y === 5);
    assert.strictEqual(raidedTile.owner, null, 'Tile should be neutralized by soldier raid');

    // Should have CAPTURE event (not PLUNDER)
    const captureEvent = info.turnEvents.find((e) => e.type === 'CAPTURE');
    assert.ok(captureEvent, 'Should have CAPTURE event for non-raider raid');
  });
});

// ===== TERRITORY CONNECTIVITY TESTS =====

describe('Territory connectivity', () => {
  it('getConnectedTerritory returns tiles connected to cities', () => {
    const state = createTestState();
    // P0 city at (1,5), territory at (0,5), (1,4), (1,5), (1,6), (2,5)
    const connected = getConnectedTerritory(state, 0);
    assert.ok(connected.has('1,5'), 'City tile should be connected');
    assert.ok(connected.has('2,5'), 'Adjacent owned tile should be connected');
  });

  it('disconnected territory is not in connected set', () => {
    const state = createTestState();
    // Create an isolated owned tile far from city
    const tile = state.map.tiles.find((t) => t.x === 7 && t.y === 2);
    tile.owner = 0;

    const connected = getConnectedTerritory(state, 0);
    assert.ok(!connected.has('7,2'), 'Isolated tile should NOT be connected');
  });

  it('expansion from disconnected territory is rejected', () => {
    const state = createTestState();
    // Create isolated P0 territory at (7,2)
    const tile = state.map.tiles.find((t) => t.x === 7 && t.y === 2);
    tile.owner = 0;

    // Try to expand from this isolated tile to (7,3) which is neutral
    const action = { action: ACTIONS.EXPAND_TERRITORY, x: 7, y: 3 };
    const result = validateAction(state, 0, action);
    assert.ok(!result.valid, 'Should reject expansion from disconnected territory');
  });

  it('expansion from connected territory still works', () => {
    const state = createTestState();
    // (3,5) should be neutral and adjacent to P0's connected territory at (2,5)
    const tile3 = state.map.tiles.find((t) => t.x === 3 && t.y === 5);
    // Make sure it's neutral
    tile3.owner = null;

    const action = { action: ACTIONS.EXPAND_TERRITORY, x: 3, y: 5 };
    const result = validateAction(state, 0, action);
    assert.ok(result.valid, 'Should allow expansion from connected territory');
  });

  it('processor rejects expansion from disconnected territory', () => {
    const state = createTestState();
    // Create isolated P0 territory at (7,2)
    const tile = state.map.tiles.find((t) => t.x === 7 && t.y === 2);
    tile.owner = 0;

    // Try to process expansion from isolated territory
    const actions = {
      player0: [{ action: ACTIONS.EXPAND_TERRITORY, x: 7, y: 3 }],
      player1: [],
    };
    const { newState } = processTurn(state, actions);

    // (7,3) should still be neutral — expansion rejected
    const targetTile = newState.map.tiles.find((t) => t.x === 7 && t.y === 3);
    assert.strictEqual(
      targetTile.owner,
      null,
      'Disconnected expansion should be rejected by processor'
    );
  });
});

// ===== FOG OF WAR TESTS =====

describe('Fog of War - computeVision', () => {
  it('own territory tiles are visible (radius 0)', () => {
    const state = createTestState();
    const vision = computeVision(state, 0);

    // P0 owns tiles at (1,4), (1,5), (1,6), (2,4), (2,5), (2,6)
    assert.ok(vision.has('1,5'), 'Own territory tile should be visible');
    assert.ok(vision.has('2,5'), 'Own territory tile should be visible');
    // Neutral tile far away should not be visible (outside city radius 5 from (1,5))
    // (8,1): Chebyshev from city (1,5) = max(7,4) = 7 > 5
    assert.ok(!vision.has('8,1'), 'Distant neutral tile should not be visible without units');
  });

  it('soldier provides vision radius 2', () => {
    const state = createTestState();
    state.units.push({ x: 4, y: 4, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true });

    const vision = computeVision(state, 0);

    // Chebyshev distance 2 from (4,4)
    assert.ok(vision.has('4,4'), 'Soldier tile visible');
    assert.ok(vision.has('6,6'), 'Chebyshev distance 2 visible');
    assert.ok(vision.has('2,2'), 'Chebyshev distance 2 visible');
    assert.ok(!vision.has('7,4'), 'Chebyshev distance 3 NOT visible');
  });

  it('archer provides vision radius 3', () => {
    const state = createTestState();
    state.units.push({ x: 5, y: 5, owner: 0, type: UNIT_TYPES.ARCHER, hp: 2, canMove: true });

    const vision = computeVision(state, 0);

    assert.ok(vision.has('8,5'), 'Chebyshev distance 3 visible for archer');
    assert.ok(vision.has('2,5'), 'Chebyshev distance 3 visible for archer');
    // (9,9): Chebyshev from archer (5,5) = 4 > 3, from city (1,5) = max(8,4) = 8 > 5
    assert.ok(!vision.has('9,9'), 'Chebyshev distance 4 NOT visible for archer');
  });

  it('city provides vision radius 5', () => {
    const state = createTestState();
    // P0 city at (1,5)
    const vision = computeVision(state, 0);

    assert.ok(vision.has('6,5'), 'Chebyshev distance 5 from city visible');
    assert.ok(vision.has('1,0'), 'Chebyshev distance 5 from city visible (clamped)');
    assert.ok(!vision.has('7,5'), 'Chebyshev distance 6 from city NOT visible');
  });

  it('enemy units do not provide vision', () => {
    const state = createTestState();
    state.units.push({ x: 5, y: 5, owner: 1, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true });

    const vision = computeVision(state, 0);
    // (5,5) is the monument tile — should only be visible if in P0's range
    // P0 city at (1,5) has radius 5, so (5,5) is exactly distance 4 — visible from city
    // But (7,5) should not be visible (distance 6 from city, 2 from enemy soldier)
    assert.ok(!vision.has('7,7'), 'Tile near enemy soldier should not be visible to P0');
  });

  it('clamps to map bounds', () => {
    const state = createTestState();
    state.units.push({ x: 1, y: 1, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true });

    const vision = computeVision(state, 0);

    // Should not contain negative coords
    assert.ok(!vision.has('-1,0'), 'Should not have negative x');
    assert.ok(!vision.has('0,-1'), 'Should not have negative y');
    assert.ok(vision.has('0,0'), 'Edge tile should be visible');
  });
});

describe('Fog of War - filterStateForPlayer', () => {
  it('keeps own units, hides enemy units outside vision', () => {
    const state = createTestState();
    state.units.push(
      { x: 2, y: 5, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true },
      { x: 8, y: 5, owner: 1, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true }
    );

    const vision = computeVision(state, 0);
    const filtered = filterStateForPlayer(state, 0, vision);

    // Own unit always visible
    assert.ok(
      filtered.units.some((u) => u.owner === 0),
      'Own unit should be visible'
    );

    // Enemy unit at (8,5) — is it in vision? P0 city at (1,5) has radius 5, so (8,5) is Chebyshev 7 away
    // P0 soldier at (2,5) has radius 2, so (8,5) is Chebyshev 6 away
    // So enemy should be hidden
    const enemyVisible = filtered.units.some((u) => u.owner === 1);
    assert.ok(!enemyVisible, 'Enemy unit far from vision should be hidden');
  });

  it('shows enemy units inside vision', () => {
    const state = createTestState();
    state.units.push(
      { x: 4, y: 5, owner: 0, type: UNIT_TYPES.SOLDIER, hp: 2, canMove: true },
      { x: 5, y: 4, owner: 1, type: UNIT_TYPES.RAIDER, hp: 1, canMove: true }
    );

    const vision = computeVision(state, 0);
    const filtered = filterStateForPlayer(state, 0, vision);

    // Enemy raider at (5,4) — within soldier vision radius 2
    const enemyVisible = filtered.units.some((u) => u.owner === 1);
    assert.ok(enemyVisible, 'Enemy unit inside vision should be visible');
  });

  it('hides territory ownership outside vision', () => {
    const state = createTestState();
    const vision = computeVision(state, 0);
    const filtered = filterStateForPlayer(state, 0, vision);

    // P1 territory at (8,5) should have owner hidden (set to null)
    const enemyTile = filtered.map.tiles.find((t) => t.x === 8 && t.y === 5);
    // Check if (8,5) is in vision — P0 city at (1,5) radius 5, so (8,5) is Chebyshev 7 — NOT visible
    if (!vision.has('8,5')) {
      assert.strictEqual(
        enemyTile.owner,
        null,
        'Territory outside vision should have owner hidden'
      );
    }
  });

  it('injects _fogEnabled and _visibleTiles', () => {
    const state = createTestState();
    const vision = computeVision(state, 0);
    const filtered = filterStateForPlayer(state, 0, vision);

    assert.strictEqual(filtered._fogEnabled, true);
    assert.ok(Array.isArray(filtered._visibleTiles));
    assert.ok(filtered._visibleTiles.length > 0);
  });

  it('keeps monuments visible even outside vision', () => {
    const state = createTestState();
    // Monument at (5,5) — check it stays as-is even if outside a player's narrow vision
    const smallVision = new Set(['1,5']);
    const filtered = filterStateForPlayer(state, 0, smallVision);

    const monumentTile = filtered.map.tiles.find((t) => t.x === 5 && t.y === 5);
    assert.strictEqual(monumentTile.type, TERRAIN.MONUMENT, 'Monument tile should keep its type');
  });
});

describe('Fog of War - filterEventsForPlayer', () => {
  it('MONUMENT_CONTROL events always visible', () => {
    const events = [
      { type: 'MONUMENT_CONTROL', data: { controlledBy: 1, goldAwarded: 3, scoreAwarded: 6 } },
    ];
    const filtered = filterEventsForPlayer(events, 0, new Set());
    assert.strictEqual(filtered.length, 1, 'Monument events should always be visible');
  });

  it('COMBAT event visible if own unit involved', () => {
    const events = [
      {
        type: 'COMBAT',
        data: {
          attacker: { x: 3, y: 3, owner: 0, type: 'SOLDIER' },
          target: { x: 4, y: 3, owner: 1, type: 'RAIDER' },
          damage: 1,
          isKill: true,
        },
      },
    ];
    const filtered = filterEventsForPlayer(events, 0, new Set());
    assert.strictEqual(filtered.length, 1, 'Combat with own unit should be visible');
  });

  it('COMBAT event hidden if no own units and outside vision', () => {
    const events = [
      {
        type: 'COMBAT',
        data: {
          attacker: { x: 8, y: 8, owner: 1, type: 'SOLDIER' },
          target: { x: 7, y: 8, owner: 1, type: 'RAIDER' },
          damage: 1,
          isKill: false,
        },
      },
    ];
    const filtered = filterEventsForPlayer(events, 0, new Set(['1,1']));
    assert.strictEqual(
      filtered.length,
      0,
      'Combat between enemies outside vision should be hidden'
    );
  });
});

console.log('All tests loaded. Run with: node --test');
