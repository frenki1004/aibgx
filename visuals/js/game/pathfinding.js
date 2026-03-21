/**
 * Client-side pathfinding for Civilization Clash.
 * BFS on the isometric grid, respecting game rules.
 */
const Pathfinding = {
  // Impassable terrain types (mirrors logic/constants.js)
  IMPASSABLE: new Set(['MOUNTAIN', 'WATER', 'MONUMENT']),

  // Unit stats relevant to movement (mirrors logic/constants.js UNIT_STATS)
  UNIT_STATS: {
    SOLDIER: { movement: 1, immuneToZoC: true, cost: 20 },
    ARCHER: { movement: 1, immuneToZoC: false, cost: 25 },
    RAIDER: { movement: 2, immuneToZoC: false, cost: 15 },
  },

  ECONOMY: {
    EXPAND_COST: 5,
    CITY_COST: 80,
    CITY_COST_FACTOR: 1.5,
  },

  /**
   * Get the cost of the next city for a player (geometric scaling).
   * Capital doesn't count — first built city costs 80G, second 120G, etc.
   */
  getCityCost(state, playerId) {
    const built = Math.max(0, (state.cities || []).filter((c) => c.owner === playerId).length - 1);
    return Math.round(this.ECONOMY.CITY_COST * Math.pow(this.ECONOMY.CITY_COST_FACTOR, built));
  },

  // 8-directional offsets (Chebyshev distance 1)
  OFFSETS: [
    { dx: -1, dy: -1 },
    { dx: 0, dy: -1 },
    { dx: 1, dy: -1 },
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -1, dy: 1 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 1 },
  ],

  /**
   * Build a passability grid from game state.
   * Returns { grid: 2D array, width, height }
   * grid[y][x] = { passable, occupied, terrain, owner }
   */
  buildGrid(state) {
    const w = state.map.width;
    const h = state.map.height;
    const grid = [];

    for (let y = 0; y < h; y++) {
      grid[y] = [];
      for (let x = 0; x < w; x++) {
        grid[y][x] = { passable: false, occupied: false, terrain: null, owner: null };
      }
    }

    // Fill terrain
    for (const tile of state.map.tiles) {
      const cell = grid[tile.y]?.[tile.x];
      if (cell) {
        cell.terrain = tile.type;
        cell.owner = tile.owner;
        cell.passable = !this.IMPASSABLE.has(tile.type);
      }
    }

    // Mark occupied tiles
    if (state.units) {
      for (const unit of state.units) {
        const cell = grid[unit.y]?.[unit.x];
        if (cell) cell.occupied = true;
      }
    }

    return { grid, width: w, height: h };
  },

  /**
   * BFS shortest path from (sx,sy) to (tx,ty).
   * Ignores the unit at the start position. Treats occupied tiles as blocked.
   * Returns array of {x,y} from start (exclusive) to target (inclusive), or null if no path.
   */
  findPath(gridData, sx, sy, tx, ty) {
    const { grid, width, height } = gridData;

    if (sx === tx && sy === ty) return [];
    if (!this._inBounds(tx, ty, width, height)) return null;

    const target = grid[ty]?.[tx];
    if (!target || !target.passable) return null;

    // BFS
    const visited = new Set();
    const parent = new Map();
    const queue = [{ x: sx, y: sy }];
    const key = (x, y) => `${x},${y}`;

    visited.add(key(sx, sy));

    while (queue.length > 0) {
      const curr = queue.shift();

      for (const { dx, dy } of this.OFFSETS) {
        const nx = curr.x + dx;
        const ny = curr.y + dy;
        const nk = key(nx, ny);

        if (visited.has(nk)) continue;
        if (!this._inBounds(nx, ny, width, height)) continue;

        const cell = grid[ny][nx];
        if (!cell.passable) continue;
        // Block occupied tiles (except the target — unit might be moving there to attack adjacent)
        if (cell.occupied && !(nx === tx && ny === ty)) continue;

        visited.add(nk);
        parent.set(nk, { x: curr.x, y: curr.y });

        if (nx === tx && ny === ty) {
          // Reconstruct path
          const path = [];
          let cx = tx,
            cy = ty;
          while (cx !== sx || cy !== sy) {
            path.unshift({ x: cx, y: cy });
            const p = parent.get(key(cx, cy));
            cx = p.x;
            cy = p.y;
          }
          return path;
        }

        queue.push({ x: nx, y: ny });
      }
    }

    return null; // No path found
  },

  /**
   * Get all reachable tiles within `range` BFS steps from (sx,sy).
   * Ignores unit at start. Returns [{x, y, distance}].
   */
  getReachableTiles(gridData, sx, sy, range) {
    const { grid, width, height } = gridData;
    const result = [];
    const visited = new Set();
    const queue = [{ x: sx, y: sy, dist: 0 }];
    const key = (x, y) => `${x},${y}`;

    visited.add(key(sx, sy));

    while (queue.length > 0) {
      const curr = queue.shift();
      if (curr.dist > 0) {
        result.push({ x: curr.x, y: curr.y, distance: curr.dist });
      }
      if (curr.dist >= range) continue;

      for (const { dx, dy } of this.OFFSETS) {
        const nx = curr.x + dx;
        const ny = curr.y + dy;
        const nk = key(nx, ny);

        if (visited.has(nk)) continue;
        if (!this._inBounds(nx, ny, width, height)) continue;

        const cell = grid[ny][nx];
        if (!cell.passable || cell.occupied) continue;

        visited.add(nk);
        queue.push({ x: nx, y: ny, dist: curr.dist + 1 });
      }
    }

    return result;
  },

  /**
   * Split a path into per-turn segments based on movement stat.
   * Returns array of arrays: [[{x,y},...], [{x,y},...], ...]
   */
  splitPathIntoTurns(path, movementPerTurn) {
    if (!path || path.length === 0) return [];
    const segments = [];
    for (let i = 0; i < path.length; i += movementPerTurn) {
      segments.push(path.slice(i, i + movementPerTurn));
    }
    return segments;
  },

  /**
   * Check if a unit is trapped by enemy Zone of Control.
   * Soldiers with ZoC (range 2) trap non-immune units.
   */
  isUnitInZoC(state, unit) {
    const stats = this.UNIT_STATS[unit.type];
    if (!stats || stats.immuneToZoC) return false;
    if (!unit.can_move_next_turn && unit.can_move_next_turn !== undefined) return false;

    // Check all enemy soldiers
    const enemyTeam = unit.owner === 0 ? 1 : 0;
    for (const other of state.units) {
      if (other.owner !== enemyTeam || other.type !== 'SOLDIER') continue;
      const dist = Math.max(Math.abs(other.x - unit.x), Math.abs(other.y - unit.y));
      if (dist <= 2) return true;
    }
    return false;
  },

  /**
   * Get valid single-turn move destinations for a unit.
   * Checks: movement range, passability, occupation, ZoC, canMove.
   */
  getValidMoves(state, unit) {
    // Can't move if flagged
    if (unit.can_move_next_turn === false) return [];

    // Can't move if in ZoC (unless immune)
    if (this.isUnitInZoC(state, unit)) return [];

    const stats = this.UNIT_STATS[unit.type];
    if (!stats) return [];

    const gridData = this.buildGrid(state);
    return this.getReachableTiles(gridData, unit.x, unit.y, stats.movement);
  },

  /**
   * Get all territory tiles connected to any of the player's cities via owned tiles (BFS).
   * Returns a Set of "x,y" strings.
   */
  getConnectedTerritory(state, playerId) {
    const connected = new Set();
    const queue = [];
    const cities = state.cities || [];

    for (const city of cities) {
      if (city.owner !== playerId) continue;
      const key = `${city.x},${city.y}`;
      if (!connected.has(key)) {
        connected.add(key);
        queue.push({ x: city.x, y: city.y });
      }
    }

    const w = state.map.width;
    const h = state.map.height;
    while (queue.length > 0) {
      const { x, y } = queue.shift();
      for (const { dx, dy } of this.OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this._inBounds(nx, ny, w, h)) continue;
        const key = `${nx},${ny}`;
        if (connected.has(key)) continue;
        const tile = state.map.tiles.find((t) => t.x === nx && t.y === ny);
        if (tile && tile.owner === playerId) {
          connected.add(key);
          queue.push({ x: nx, y: ny });
        }
      }
    }

    return connected;
  },

  /**
   * Get all neutral FIELD tiles adjacent to a player's city-connected territory.
   * These are valid targets for EXPAND_TERRITORY.
   * queuedExpands: optional array of {x,y} tiles already queued for expansion this turn.
   */
  getExpandableTiles(state, playerId, queuedExpands) {
    const expandable = new Set();
    const queuedSet = new Set();
    const w = state.map.width;
    const h = state.map.height;

    if (queuedExpands) {
      for (const q of queuedExpands) queuedSet.add(`${q.x},${q.y}`);
    }

    // Build connected territory set, including queued expansions as virtual owned tiles
    const connected = this.getConnectedTerritory(state, playerId);
    // Also include queued expands that connect to the connected set
    if (queuedExpands) {
      const queueCheck = [...queuedExpands];
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = queueCheck.length - 1; i >= 0; i--) {
          const q = queueCheck[i];
          const key = `${q.x},${q.y}`;
          if (connected.has(key)) {
            queueCheck.splice(i, 1);
            continue;
          }
          // Check if adjacent to connected
          let adj = false;
          for (const { dx, dy } of this.OFFSETS) {
            if (connected.has(`${q.x + dx},${q.y + dy}`)) {
              adj = true;
              break;
            }
          }
          if (adj) {
            connected.add(key);
            queueCheck.splice(i, 1);
            changed = true;
          }
        }
      }
    }

    // Find expandable neighbors of connected tiles
    for (const tile of state.map.tiles) {
      const key = `${tile.x},${tile.y}`;
      if (!connected.has(key)) continue;

      for (const { dx, dy } of this.OFFSETS) {
        const nx = tile.x + dx;
        const ny = tile.y + dy;
        if (!this._inBounds(nx, ny, w, h)) continue;

        const neighbor = state.map.tiles.find((t) => t.x === nx && t.y === ny);
        if (
          neighbor &&
          neighbor.owner === null &&
          neighbor.type === 'FIELD' &&
          !queuedSet.has(`${nx},${ny}`)
        ) {
          expandable.add(`${nx},${ny}`);
        }
      }
    }

    return Array.from(expandable).map((k) => {
      const [x, y] = k.split(',').map(Number);
      return { x, y };
    });
  },

  /**
   * Get valid city build locations for a player.
   * Own FIELD tiles with no city and no unit, player must have >= 80 gold.
   */
  getValidCityLocations(state, playerId) {
    const player = state.players?.find((p) => p.id === playerId);
    if (!player || player.gold < this.getCityCost(state, playerId)) return [];

    return state.map.tiles
      .filter((tile) => {
        if (tile.owner !== playerId || tile.type !== 'FIELD') return false;
        if (state.cities?.some((c) => c.x === tile.x && c.y === tile.y)) return false;
        if (state.units?.some((u) => u.x === tile.x && u.y === tile.y)) return false;
        return true;
      })
      .map((t) => ({ x: t.x, y: t.y }));
  },

  _inBounds(x, y, w, h) {
    return x >= 0 && x < w && y >= 0 && y < h;
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Pathfinding;
}
