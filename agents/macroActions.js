/**
 * Macro-Actions for MCTS
 *
 * Instead of searching over individual actions (billions of combinations),
 * we define ~30-50 "turn templates" that combine build+expand+move into
 * a single strategic choice. MCTS picks between these templates.
 *
 * Each macro-action is a function: (state, playerId) → actions[]
 */

const {
  ACTIONS, UNIT_TYPES, UNIT_STATS, ECONOMY, TERRAIN,
  validateAction, getCityCost, getTilesAtDistance1,
  chebyshevDistance, isInZoC, getConnectedTerritory, getUnit,
} = require('../logic');

// ============================================================
// Helpers
// ============================================================

function getMyUnits(state, pid) { return state.units.filter(u => u.owner === pid); }
function getEnemyUnits(state, pid) { return state.units.filter(u => u.owner !== pid); }
function getMyCities(state, pid) { return state.cities.filter(c => c.owner === pid); }
function getEnemyCities(state, pid) { return state.cities.filter(c => c.owner !== null && c.owner !== pid); }
function getPlayer(state, pid) { return state.players.find(p => p.id === pid); }

function getEmptyCities(state, pid) {
  return getMyCities(state, pid).filter(c => !state.units.some(u => u.x === c.x && u.y === c.y));
}

function canAfford(state, pid, cost) {
  return getPlayer(state, pid).gold >= cost;
}

function getExpandableTiles(state, pid) {
  const connected = getConnectedTerritory(state, pid);
  const seen = new Set();
  const tiles = [];
  for (const tile of state.map.tiles) {
    if (tile.owner !== pid || !connected.has(`${tile.x},${tile.y}`)) continue;
    for (const adj of getTilesAtDistance1(tile.x, tile.y)) {
      const key = `${adj.x},${adj.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = state.map.tiles.find(tt => tt.x === adj.x && tt.y === adj.y);
      if (t && t.owner === null && t.type === TERRAIN.FIELD) tiles.push(t);
    }
  }
  return tiles;
}

function getEnemySideX(state, pid) {
  const cx = Math.floor(state.map.width / 2);
  const cities = getMyCities(state, pid);
  if (cities.length === 0) return cx;
  return cities[0].x < cx ? state.map.width - 1 : 0;
}

function canUnitMove(state, unit) {
  return (unit.canMove ?? unit.can_move_next_turn ?? true) && !isInZoC(state, unit);
}

// ============================================================
// Build strategies
// ============================================================

function buildNothing() { return []; }

function buildSoldiers(state, pid) {
  const actions = [];
  const emptyCities = getEmptyCities(state, pid);
  let gold = getPlayer(state, pid).gold;
  for (const city of emptyCities) {
    if (gold < UNIT_STATS.SOLDIER.cost) break;
    const a = { action: ACTIONS.BUILD_UNIT, city_x: city.x, city_y: city.y, unit_type: UNIT_TYPES.SOLDIER };
    if (validateAction(state, pid, a).valid) { actions.push(a); gold -= UNIT_STATS.SOLDIER.cost; }
  }
  return actions;
}

function buildArchers(state, pid) {
  const actions = [];
  const emptyCities = getEmptyCities(state, pid);
  let gold = getPlayer(state, pid).gold;
  for (const city of emptyCities) {
    if (gold < UNIT_STATS.ARCHER.cost) break;
    const a = { action: ACTIONS.BUILD_UNIT, city_x: city.x, city_y: city.y, unit_type: UNIT_TYPES.ARCHER };
    if (validateAction(state, pid, a).valid) { actions.push(a); gold -= UNIT_STATS.ARCHER.cost; }
  }
  return actions;
}

function buildRaiders(state, pid) {
  const actions = [];
  const emptyCities = getEmptyCities(state, pid);
  let gold = getPlayer(state, pid).gold;
  for (const city of emptyCities) {
    if (gold < UNIT_STATS.RAIDER.cost) break;
    const a = { action: ACTIONS.BUILD_UNIT, city_x: city.x, city_y: city.y, unit_type: UNIT_TYPES.RAIDER };
    if (validateAction(state, pid, a).valid) { actions.push(a); gold -= UNIT_STATS.RAIDER.cost; }
  }
  return actions;
}

function buildMixed(state, pid) {
  const actions = [];
  const emptyCities = getEmptyCities(state, pid);
  let gold = getPlayer(state, pid).gold;
  const types = [UNIT_TYPES.SOLDIER, UNIT_TYPES.ARCHER, UNIT_TYPES.SOLDIER, UNIT_TYPES.RAIDER];
  let ti = 0;
  for (const city of emptyCities) {
    const t = types[ti % types.length]; ti++;
    if (gold < UNIT_STATS[t].cost) continue;
    const a = { action: ACTIONS.BUILD_UNIT, city_x: city.x, city_y: city.y, unit_type: t };
    if (validateAction(state, pid, a).valid) { actions.push(a); gold -= UNIT_STATS[t].cost; }
  }
  return actions;
}

function buildCounterPick(state, pid) {
  const enemies = getEnemyUnits(state, pid);
  const eSoldiers = enemies.filter(u => u.type === UNIT_TYPES.SOLDIER).length;
  const eArchers = enemies.filter(u => u.type === UNIT_TYPES.ARCHER).length;
  const eRaiders = enemies.filter(u => u.type === UNIT_TYPES.RAIDER).length;

  // Pick counter to most common enemy type
  let buildType = UNIT_TYPES.SOLDIER;
  if (eSoldiers >= eArchers && eSoldiers >= eRaiders) buildType = UNIT_TYPES.ARCHER;
  else if (eArchers >= eRaiders) buildType = UNIT_TYPES.RAIDER;

  const actions = [];
  const emptyCities = getEmptyCities(state, pid);
  let gold = getPlayer(state, pid).gold;
  for (const city of emptyCities) {
    if (gold < UNIT_STATS[buildType].cost) break;
    const a = { action: ACTIONS.BUILD_UNIT, city_x: city.x, city_y: city.y, unit_type: buildType };
    if (validateAction(state, pid, a).valid) { actions.push(a); gold -= UNIT_STATS[buildType].cost; }
  }
  return actions;
}

function buildOneSoldier(state, pid) {
  const emptyCities = getEmptyCities(state, pid);
  if (emptyCities.length === 0 || !canAfford(state, pid, UNIT_STATS.SOLDIER.cost)) return [];
  const a = { action: ACTIONS.BUILD_UNIT, city_x: emptyCities[0].x, city_y: emptyCities[0].y, unit_type: UNIT_TYPES.SOLDIER };
  return validateAction(state, pid, a).valid ? [a] : [];
}

function buildCity(state, pid) {
  const cost = getCityCost(state, pid);
  if (!canAfford(state, pid, cost)) return [];
  const connected = getConnectedTerritory(state, pid);
  const myCities = getMyCities(state, pid);

  let best = null, bestScore = -Infinity;
  for (const tile of state.map.tiles) {
    if (tile.owner !== pid || tile.type !== TERRAIN.FIELD) continue;
    if (!connected.has(`${tile.x},${tile.y}`)) continue;
    if (state.cities.some(c => c.x === tile.x && c.y === tile.y)) continue;
    if (state.units.some(u => u.x === tile.x && u.y === tile.y)) continue;

    let score = 0;
    for (const c of myCities) score += Math.min(chebyshevDistance(tile.x, tile.y, c.x, c.y), 6);
    if (score > bestScore) { bestScore = score; best = tile; }
  }

  if (!best) return [];
  const a = { action: ACTIONS.BUILD_CITY, x: best.x, y: best.y };
  return validateAction(state, pid, a).valid ? [a] : [];
}

// ============================================================
// Expand strategies
// ============================================================

function expandNone() { return []; }

function expandAggressive(state, pid, budget) {
  const gold = budget || getPlayer(state, pid).gold;
  const maxExpand = Math.min(10, Math.floor(gold / ECONOMY.EXPAND_COST));
  if (maxExpand <= 0) return [];

  const tiles = getExpandableTiles(state, pid);
  const enemyX = getEnemySideX(state, pid);
  tiles.sort((a, b) => Math.abs(a.x - enemyX) - Math.abs(b.x - enemyX));

  const actions = [];
  for (let i = 0; i < Math.min(maxExpand, tiles.length); i++) {
    actions.push({ action: ACTIONS.EXPAND_TERRITORY, x: tiles[i].x, y: tiles[i].y });
  }
  return actions;
}

function expandDefensive(state, pid, budget) {
  const gold = budget || getPlayer(state, pid).gold;
  const maxExpand = Math.min(5, Math.floor(gold / ECONOMY.EXPAND_COST));
  if (maxExpand <= 0) return [];

  const tiles = getExpandableTiles(state, pid);
  const myCities = getMyCities(state, pid);
  // Expand near own cities
  tiles.sort((a, b) => {
    const aDist = Math.min(...myCities.map(c => chebyshevDistance(a.x, a.y, c.x, c.y)));
    const bDist = Math.min(...myCities.map(c => chebyshevDistance(b.x, b.y, c.x, c.y)));
    return aDist - bDist;
  });

  const actions = [];
  for (let i = 0; i < Math.min(maxExpand, tiles.length); i++) {
    actions.push({ action: ACTIONS.EXPAND_TERRITORY, x: tiles[i].x, y: tiles[i].y });
  }
  return actions;
}

function expandModerate(state, pid, budget) {
  const gold = budget || getPlayer(state, pid).gold;
  const maxExpand = Math.min(7, Math.floor(gold / ECONOMY.EXPAND_COST));
  if (maxExpand <= 0) return [];

  const tiles = getExpandableTiles(state, pid);
  const centerX = state.map.width / 2;
  tiles.sort((a, b) => Math.abs(a.x - centerX) - Math.abs(b.x - centerX));

  const actions = [];
  for (let i = 0; i < Math.min(maxExpand, tiles.length); i++) {
    actions.push({ action: ACTIONS.EXPAND_TERRITORY, x: tiles[i].x, y: tiles[i].y });
  }
  return actions;
}

// ============================================================
// Move strategies
// ============================================================

function moveStay() { return []; }

function moveAllPush(state, pid) {
  const actions = [];
  const enemyX = getEnemySideX(state, pid);
  const myUnits = getMyUnits(state, pid);

  for (const unit of myUnits) {
    if (!canUnitMove(state, unit)) continue;
    const dx = Math.sign(enemyX - unit.x);
    const movement = UNIT_STATS[unit.type].movement;

    // Try forward, then diagonal, then lateral
    const candidates = [
      { x: unit.x + dx * movement, y: unit.y },
      { x: unit.x + dx * movement, y: unit.y - 1 },
      { x: unit.x + dx * movement, y: unit.y + 1 },
      { x: unit.x + dx, y: unit.y },
    ];

    for (const c of candidates) {
      const a = { action: ACTIONS.MOVE, from_x: unit.x, from_y: unit.y, to_x: c.x, to_y: c.y };
      if (validateAction(state, pid, a).valid) { actions.push(a); break; }
    }
  }
  return actions;
}

function moveTowardMonuments(state, pid) {
  const actions = [];
  const monuments = state.monuments || [];
  if (monuments.length === 0) return moveAllPush(state, pid);

  const myUnits = getMyUnits(state, pid);
  for (const unit of myUnits) {
    if (!canUnitMove(state, unit)) continue;

    // Find nearest monument
    let nearestMon = monuments[0];
    let nearestDist = Infinity;
    for (const m of monuments) {
      const d = chebyshevDistance(unit.x, unit.y, m.x, m.y);
      if (d < nearestDist) { nearestDist = d; nearestMon = m; }
    }

    const dx = Math.sign(nearestMon.x - unit.x);
    const dy = Math.sign(nearestMon.y - unit.y);
    const movement = UNIT_STATS[unit.type].movement;

    const candidates = [
      { x: unit.x + dx * movement, y: unit.y + dy * movement },
      { x: unit.x + dx, y: unit.y + dy },
      { x: unit.x + dx, y: unit.y },
      { x: unit.x, y: unit.y + dy },
    ];

    for (const c of candidates) {
      const a = { action: ACTIONS.MOVE, from_x: unit.x, from_y: unit.y, to_x: c.x, to_y: c.y };
      if (validateAction(state, pid, a).valid) { actions.push(a); break; }
    }
  }
  return actions;
}

function moveTowardEnemyCities(state, pid) {
  const actions = [];
  const enemyCities = getEnemyCities(state, pid);
  if (enemyCities.length === 0) return moveAllPush(state, pid);

  const myUnits = getMyUnits(state, pid);
  for (const unit of myUnits) {
    if (!canUnitMove(state, unit)) continue;

    let target = enemyCities[0];
    let best = Infinity;
    for (const c of enemyCities) {
      const d = chebyshevDistance(unit.x, unit.y, c.x, c.y);
      if (d < best) { best = d; target = c; }
    }

    const dx = Math.sign(target.x - unit.x);
    const dy = Math.sign(target.y - unit.y);
    const movement = UNIT_STATS[unit.type].movement;

    const candidates = [
      { x: unit.x + dx * movement, y: unit.y + dy * movement },
      { x: unit.x + dx, y: unit.y + dy },
      { x: unit.x + dx, y: unit.y },
    ];

    for (const c of candidates) {
      const a = { action: ACTIONS.MOVE, from_x: unit.x, from_y: unit.y, to_x: c.x, to_y: c.y };
      if (validateAction(state, pid, a).valid) { actions.push(a); break; }
    }
  }
  return actions;
}

function moveTowardEnemyUnits(state, pid) {
  const actions = [];
  const enemies = getEnemyUnits(state, pid);
  if (enemies.length === 0) return moveAllPush(state, pid);

  const myUnits = getMyUnits(state, pid);
  for (const unit of myUnits) {
    if (!canUnitMove(state, unit)) continue;

    let target = enemies[0];
    let best = Infinity;
    for (const e of enemies) {
      const d = chebyshevDistance(unit.x, unit.y, e.x, e.y);
      if (d < best) { best = d; target = e; }
    }

    const dx = Math.sign(target.x - unit.x);
    const dy = Math.sign(target.y - unit.y);
    const movement = UNIT_STATS[unit.type].movement;

    const candidates = [
      { x: unit.x + dx * movement, y: unit.y + dy * movement },
      { x: unit.x + dx, y: unit.y + dy },
      { x: unit.x + dx, y: unit.y },
    ];

    for (const c of candidates) {
      const a = { action: ACTIONS.MOVE, from_x: unit.x, from_y: unit.y, to_x: c.x, to_y: c.y };
      if (validateAction(state, pid, a).valid) { actions.push(a); break; }
    }
  }
  return actions;
}

function moveDefend(state, pid) {
  const actions = [];
  const myCities = getMyCities(state, pid);
  if (myCities.length === 0) return [];

  const myUnits = getMyUnits(state, pid);
  for (const unit of myUnits) {
    if (!canUnitMove(state, unit)) continue;

    // Move toward nearest own city
    let target = myCities[0];
    let best = Infinity;
    for (const c of myCities) {
      const d = chebyshevDistance(unit.x, unit.y, c.x, c.y);
      if (d < best) { best = d; target = c; }
    }

    if (best <= 2) continue; // Already defending

    const dx = Math.sign(target.x - unit.x);
    const dy = Math.sign(target.y - unit.y);

    const a = { action: ACTIONS.MOVE, from_x: unit.x, from_y: unit.y, to_x: unit.x + dx, to_y: unit.y + dy };
    if (validateAction(state, pid, a).valid) actions.push(a);
  }
  return actions;
}

function moveRaiderFlank(state, pid) {
  const actions = [];
  const myUnits = getMyUnits(state, pid);
  const enemyX = getEnemySideX(state, pid);

  for (const unit of myUnits) {
    if (!canUnitMove(state, unit)) continue;

    if (unit.type === UNIT_TYPES.RAIDER) {
      // Raiders go to top or bottom lane, then push toward enemy
      const targetY = unit.y < state.map.height / 2 ? 2 : state.map.height - 3;
      const dx = Math.sign(enemyX - unit.x);
      const dy = Math.sign(targetY - unit.y);
      const movement = UNIT_STATS[unit.type].movement;

      const candidates = [
        { x: unit.x + dx * movement, y: unit.y + dy * movement },
        { x: unit.x + dx * movement, y: unit.y + dy },
        { x: unit.x + dx, y: unit.y + dy },
        { x: unit.x + dx * movement, y: unit.y },
      ];

      for (const c of candidates) {
        const a = { action: ACTIONS.MOVE, from_x: unit.x, from_y: unit.y, to_x: c.x, to_y: c.y };
        if (validateAction(state, pid, a).valid) { actions.push(a); break; }
      }
    } else {
      // Non-raiders push forward normally
      const dx = Math.sign(enemyX - unit.x);
      const a = { action: ACTIONS.MOVE, from_x: unit.x, from_y: unit.y, to_x: unit.x + dx, to_y: unit.y };
      if (validateAction(state, pid, a).valid) actions.push(a);
    }
  }
  return actions;
}

function moveSmart(state, pid) {
  // Use smarterAgent's movement logic
  const smarterAgent = require('./smarterAgent');
  const allActions = smarterAgent.generateActions(state, pid);
  return allActions.filter(a => a.action === ACTIONS.MOVE);
}

// ============================================================
// Compose macro-actions: build + expand + move combinations
// ============================================================

const BUILD_STRATEGIES = [
  { name: 'nothing', fn: buildNothing },
  { name: 'soldiers', fn: buildSoldiers },
  { name: 'archers', fn: buildArchers },
  { name: 'raiders', fn: buildRaiders },
  { name: 'mixed', fn: buildMixed },
  { name: 'counter', fn: buildCounterPick },
  { name: 'one_soldier', fn: buildOneSoldier },
  { name: 'city', fn: buildCity },
];

const EXPAND_STRATEGIES = [
  { name: 'none', fn: expandNone },
  { name: 'aggressive', fn: expandAggressive },
  { name: 'defensive', fn: expandDefensive },
  { name: 'moderate', fn: expandModerate },
];

const MOVE_STRATEGIES = [
  { name: 'stay', fn: moveStay },
  { name: 'push', fn: moveAllPush },
  { name: 'monuments', fn: moveTowardMonuments },
  { name: 'enemy_cities', fn: moveTowardEnemyCities },
  { name: 'enemy_units', fn: moveTowardEnemyUnits },
  { name: 'defend', fn: moveDefend },
  { name: 'raider_flank', fn: moveRaiderFlank },
  { name: 'smart', fn: moveSmart },
];

/**
 * Generate macro-actions for MCTS.
 *
 * OPTIMIZED: Instead of all build×expand×move combos (~200+),
 * we generate ~10-15 strategic PRESETS based on game phase.
 * This means each macro gets ~10 visits with 100 sims — enough to differentiate.
 */
function generateMacroActions(state, playerId) {
  const macros = [];
  const player = getPlayer(state, playerId);
  const myUnits = getMyUnits(state, playerId);
  const myCities = getMyCities(state, playerId);
  const enemyUnits = getEnemyUnits(state, playerId);
  const hasUnits = myUnits.length > 0;
  const emptyCities = getEmptyCities(state, playerId);
  const canBuild = emptyCities.length > 0;
  const gold = player.gold;
  const progress = state.turn / state.maxTurns; // 0..1

  function makeMacro(name, buildFn, expandFn, moveFn) {
    try {
      const buildActions = buildFn(state, playerId);
      let goldLeft = gold;
      for (const a of buildActions) {
        if (a.action === ACTIONS.BUILD_UNIT) goldLeft -= UNIT_STATS[a.unit_type].cost;
        if (a.action === ACTIONS.BUILD_CITY) goldLeft -= getCityCost(state, playerId);
      }
      const expandActions = expandFn(state, playerId, goldLeft);
      const moveActions = moveFn(state, playerId);
      macros.push({ name, actions: [...buildActions, ...expandActions, ...moveActions] });
    } catch (e) { /* skip broken */ }
  }

  // --- Always available: smarterAgent full baseline ---
  try {
    const smarterAgent = require('./smarterAgent');
    const smartActions = smarterAgent.generateActions(state, playerId);
    if (smartActions.length > 0) {
      macros.push({ name: 'smart_baseline', actions: smartActions });
    }
  } catch (e) { /* skip */ }

  // --- Early game (0-25%): economy focus ---
  if (progress < 0.25) {
    makeMacro('econ_expand', buildNothing, expandAggressive, moveStay);
    if (canBuild && gold >= 20) makeMacro('soldier+expand', buildOneSoldier, expandModerate, moveStay);
    if (canBuild && gold >= 20) makeMacro('soldiers+expand_def', buildSoldiers, expandDefensive, moveStay);
    if (gold >= getCityCost(state, playerId)) makeMacro('build_city+expand', buildCity, expandDefensive, moveStay);
    if (canBuild && gold >= 20) makeMacro('soldiers+push', buildSoldiers, expandModerate, hasUnits ? moveAllPush : moveStay);
    makeMacro('full_expand', buildNothing, expandAggressive, hasUnits ? moveAllPush : moveStay);
    // Always try building units from turn 1 — never pass early game
    if (canBuild) {
      makeMacro('soldiers_only', buildSoldiers, expandNone, moveStay);
      makeMacro('mixed_build', buildMixed, expandNone, hasUnits ? moveAllPush : moveStay);
    }
  }

  // --- Mid game (25-65%): army building + movement ---
  if (progress >= 0.15 && progress < 0.65) {
    if (canBuild && gold >= 20) makeMacro('soldiers+smart', buildSoldiers, expandModerate, moveSmart);
    if (canBuild && gold >= 25) makeMacro('archers+smart', buildArchers, expandModerate, moveSmart);
    if (canBuild && gold >= 15) makeMacro('raiders+flank', buildRaiders, expandModerate, hasUnits ? moveRaiderFlank : moveStay);
    if (canBuild && enemyUnits.length > 0) makeMacro('counter+push', buildCounterPick, expandModerate, hasUnits ? moveAllPush : moveStay);
    if (canBuild && gold >= 20) makeMacro('mixed+monuments', buildMixed, expandModerate, hasUnits ? moveTowardMonuments : moveStay);
    if (gold >= getCityCost(state, playerId)) makeMacro('city+defend', buildCity, expandDefensive, hasUnits ? moveDefend : moveStay);
  }

  // --- Late game (50%+): aggression + monuments ---
  if (progress >= 0.5) {
    if (canBuild && gold >= 20) makeMacro('soldiers+cities', buildSoldiers, expandNone, hasUnits ? moveTowardEnemyCities : moveStay);
    if (canBuild && gold >= 20) makeMacro('soldiers+monuments', buildSoldiers, expandNone, hasUnits ? moveTowardMonuments : moveStay);
    if (canBuild && enemyUnits.length > 0) makeMacro('counter+enemies', buildCounterPick, expandNone, hasUnits ? moveTowardEnemyUnits : moveStay);
    if (hasUnits) makeMacro('allout_push', buildNothing, expandNone, moveAllPush);
    if (hasUnits) makeMacro('allout_cities', buildNothing, expandNone, moveTowardEnemyCities);
    if (hasUnits) makeMacro('defend_hold', buildNothing, expandNone, moveDefend);
  }

  // --- Always: key combos that span all phases ---
  if (canBuild && gold >= 20 && hasUnits) {
    makeMacro('soldiers+expand+push', buildSoldiers, expandAggressive, moveAllPush);
  }
  if (canBuild && enemyUnits.length > 0 && hasUnits) {
    makeMacro('counter+expand+smart', buildCounterPick, expandModerate, moveSmart);
  }

  // Filter out empty-action macros (MCTS should never choose "do nothing")
  const nonEmpty = macros.filter(m => m.actions.length > 0);

  // Deduplicate by action content (different names can produce same actions)
  const seen = new Set();
  const deduped = [];
  for (const m of nonEmpty) {
    const key = JSON.stringify(m.actions);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(m);
    }
  }

  // Fallback: if everything produced empty actions, use expand-only as minimum action
  if (deduped.length === 0) {
    const expandActions = expandAggressive(state, playerId);
    if (expandActions.length > 0) {
      deduped.push({ name: 'expand_fallback', actions: expandActions });
    } else {
      // True last resort: just pass
      deduped.push({ name: 'pass', actions: [] });
    }
  }

  return deduped;
}

module.exports = {
  generateMacroActions,
  BUILD_STRATEGIES,
  EXPAND_STRATEGIES,
  MOVE_STRATEGIES,
};
