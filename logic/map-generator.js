/**
 * Map generation for Civilization Clash
 * Generates symmetrical island maps with starting positions
 */

const { TERRAIN, MODES, MODE_SETTINGS } = require('./constants');

/**
 * Generate a random symmetrical island map
 * @param {number} width - Map width
 * @param {number} height - Map height
 * @param {number} seed - Optional seed for deterministic generation
 * @returns {Object} Map object with tiles, cities, and monuments
 */
function generateMap(width, height, seed = null) {
  // Enforce odd dimensions so the center tile is the true rotational center
  if (width % 2 === 0) width++;
  if (height % 2 === 0) height++;

  // Seeded PRNG for reproducibility
  let randomState = seed !== null ? seed : Date.now();
  const random = () => {
    randomState = (randomState * 1103515245 + 12345) & 0x7fffffff;
    return randomState / 0x7fffffff;
  };

  const tiles = [];
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);

  // --- Biome map ---
  // Horizontal split: above monument = plains, below = rocky.
  // Line symmetric (same biome at (x,y) and (W-1-x,y)).
  // Both biomes touch the monument area.
  // Slight wave on the boundary for a natural feel.
  const biomeWaveAmp = 0.8 + random() * 0.4;
  const biomeWaveFreq = 0.3 + random() * 0.2;
  const getBiome = (x, y) => {
    const wave = Math.sin(x * biomeWaveFreq) * biomeWaveAmp;
    return y - centerY + wave > 0 ? 'rocky' : 'plains';
  };

  // --- Generate left half (x < centerX), then 180° point-symmetric mirror ---
  // Center column handled separately for perfect symmetry.
  const leftHalf = [];

  // Simple 2D noise via scattered seed points
  const noisePoints = [];
  for (let i = 0; i < 8; i++) {
    noisePoints.push({
      x: random() * width,
      y: random() * height,
      v: random() * 0.4 - 0.2,
    });
  }
  const noise = (px, py) => {
    let val = 0;
    for (const np of noisePoints) {
      const d = Math.sqrt((px - np.x) ** 2 + (py - np.y) ** 2);
      val += np.v / (1 + d * 0.3);
    }
    return val;
  };

  // Helper: generate terrain for a tile at (x, y)
  const generateTerrain = (x, y) => {
    // Edge tiles always water
    if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
      return TERRAIN.WATER;
    }

    // Normalized distance from center (elliptical for rectangular maps)
    const nx = (x - centerX) / (width / 2);
    const ny = (y - centerY) / (height / 2);
    const dist = Math.sqrt(nx * nx + ny * ny);

    // Island shape: land probability falls off from center
    const landProb = 1.0 - dist * 0.85 + noise(x, y);

    if (landProb > 0.35) {
      // Determine mountain probability based on biome
      const biome = getBiome(x, y);
      let mountainProb;
      if (biome === 'rocky') {
        mountainProb = 0.22 + noise(x + 50, y + 50) * 0.1;
      } else {
        mountainProb = 0.04;
      }

      // Near the monument center, reduce mountains so both biomes are accessible
      const distToCenter = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
      if (distToCenter < 3) {
        mountainProb = 0;
      }

      if (random() < mountainProb) {
        return TERRAIN.MOUNTAIN;
      } else {
        return TERRAIN.FIELD;
      }
    } else {
      return TERRAIN.WATER;
    }
  };

  // Generate left half (x = 0 to centerX-1)
  for (let y = 0; y < height; y++) {
    leftHalf[y] = [];
    for (let x = 0; x < centerX; x++) {
      leftHalf[y][x] = generateTerrain(x, y);
    }
  }

  // Generate center column (x = centerX) — only top half (y < centerY),
  // bottom half mirrored for perfect symmetry
  const centerCol = [];
  for (let y = 0; y < centerY; y++) {
    centerCol[y] = generateTerrain(centerX, y);
  }

  // Clear area around starting positions (player 0 on left)
  const startY = centerY;
  const player0StartX = 2;
  const player1StartX = width - 3;

  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const y = startY + dy;
      const x = player0StartX + dx;
      if (y >= 0 && y < height && x >= 0 && x < centerX) {
        leftHalf[y][x] = TERRAIN.FIELD;
      }
    }
  }

  // Clear area around monument (in leftHalf and centerCol)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const y = centerY + dy;
      const x = centerX + dx;
      if (y >= 0 && y < height) {
        if (x < centerX && x >= 0) {
          leftHalf[y][x] = TERRAIN.FIELD;
        } else if (x === centerX && y < centerY) {
          centerCol[y] = TERRAIN.FIELD;
        }
      }
    }
  }

  // --- Guarantee a connected land corridor from P0 start to monument ---
  // Carve a 3-tile-wide horizontal path along y=centerY (±1).
  // Point symmetry mirrors this for P1 automatically.
  for (let x = 1; x < centerX; x++) {
    for (let dy = -1; dy <= 1; dy++) {
      const y = startY + dy;
      if (y > 0 && y < height - 1) {
        if (leftHalf[y][x] === TERRAIN.WATER || leftHalf[y][x] === TERRAIN.MOUNTAIN) {
          leftHalf[y][x] = TERRAIN.FIELD;
        }
      }
    }
  }
  // Also ensure the center column at centerY ±1 is passable
  for (let dy = -1; dy <= 1; dy++) {
    const y = centerY + dy;
    if (y > 0 && y < centerY) {
      if (centerCol[y] === TERRAIN.WATER || centerCol[y] === TERRAIN.MOUNTAIN) {
        centerCol[y] = TERRAIN.FIELD;
      }
    }
  }

  // Build full map with 180° point symmetry around center
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let terrain;

      if (x === centerX && y === centerY) {
        terrain = TERRAIN.MONUMENT;
      } else if (x === centerX) {
        // Center column: top half generated, bottom half mirrored
        if (y < centerY) {
          terrain = centerCol[y] || TERRAIN.WATER;
        } else {
          terrain = centerCol[height - 1 - y] || TERRAIN.WATER;
        }
      } else if (x < centerX) {
        // Left half: use generated data
        terrain = leftHalf[y][x] !== undefined ? leftHalf[y][x] : TERRAIN.WATER;
      } else {
        // Right half: 180° rotation from left half
        const mirrorX = width - 1 - x;
        const mirrorY = height - 1 - y;
        terrain =
          leftHalf[mirrorY] && leftHalf[mirrorY][mirrorX] !== undefined
            ? leftHalf[mirrorY][mirrorX]
            : TERRAIN.WATER;
      }

      tiles.push({ x, y, type: terrain, owner: null });
    }
  }

  // Set starting territory (3x3 around starting cities)
  const setStartingTerritory = (cityX, cityY, owner) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tile = tiles.find((t) => t.x === cityX + dx && t.y === cityY + dy);
        if (tile && tile.type === TERRAIN.FIELD) {
          tile.owner = owner;
        }
      }
    }
  };

  setStartingTerritory(player0StartX, startY, 0);
  setStartingTerritory(player1StartX, startY, 1);

  const cities = [
    { x: player0StartX, y: startY, owner: 0 },
    { x: player1StartX, y: startY, owner: 1 },
  ];

  const monuments = [{ x: centerX, y: centerY, controlledBy: null }];

  return { width, height, tiles, cities, monuments };
}

/**
 * Generate a 3-lane tournament map with wavy water rivers separating lanes.
 * Top/bot lanes run base-to-base independently; monuments in side lanes, no monument in mid lane.
 * Lanes connect only at base areas (no mid-map crossover).
 */
function generateTournamentMap(width, height, seed = null) {
  if (width % 2 === 0) width++;
  if (height % 2 === 0) height++;

  let randomState = seed !== null ? seed : Date.now();
  const random = () => {
    randomState = (randomState * 1103515245 + 12345) & 0x7fffffff;
    return randomState / 0x7fffffff;
  };

  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);

  // --- Noise system (same pattern as generateMap) ---
  const noisePoints = [];
  for (let i = 0; i < 12; i++) {
    noisePoints.push({
      x: random() * width,
      y: random() * height,
      v: random() * 0.4 - 0.2,
    });
  }
  const noise = (px, py) => {
    let val = 0;
    for (const np of noisePoints) {
      const d = Math.sqrt((px - np.x) ** 2 + (py - np.y) ** 2);
      val += np.v / (1 + d * 0.3);
    }
    return val;
  };

  // --- River geometry ---
  // Upper river: wavy band ~4 rows above center
  const riverOffset = Math.max(4, Math.floor(height / 7));
  const upperRiverBaseY = centerY - riverOffset;
  const riverWaveAmp = 0.6 + random() * 0.6;
  const riverWaveFreq = 0.15 + random() * 0.1;
  const riverPhase = random() * Math.PI * 2;

  // Base gap: no river in first/last few columns (base area)
  const baseGapWidth = Math.max(5, Math.floor(width / 9));

  // Generate the FULL upper river across the entire map width using a random walk.
  // Center shifts by at most ±1 per column, ensuring a continuous barrier.
  // Then we project all river tiles into the left half:
  //   - Upper river positions with x <= centerX go directly into leftHalf
  //   - Upper river positions with x > centerX get 180°-mirrored to left-half
  //     positions of the LOWER river (so the right half assembly picks them up)
  const riverTilesForLeftHalf = new Set(); // all (x, y) to mark as WATER in leftHalf
  const riverStartX = baseGapWidth + 1;
  const riverEndX = width - 1 - riverStartX;
  let currentRiverY = upperRiverBaseY;

  // Walk the upper river from left to right
  const upperRiverCols = []; // store {x, centerY, halfWidth} per column
  for (let x = riverStartX; x <= riverEndX; x++) {
    const targetY =
      upperRiverBaseY +
      Math.sin(x * riverWaveFreq + riverPhase) * riverWaveAmp +
      noise(x, upperRiverBaseY) * 1.5;
    const drift = Math.max(-1, Math.min(1, Math.round(targetY - currentRiverY)));
    currentRiverY += drift;
    const halfWidth = 1 + Math.floor((0.5 + noise(x + 50, upperRiverBaseY + 50)) * 0.5);
    upperRiverCols.push({ x, cy: currentRiverY, hw: halfWidth });
  }

  // Project upper river into leftHalf coordinates
  for (const { x, cy, hw } of upperRiverCols) {
    for (let y = cy - hw; y <= cy + hw; y++) {
      if (y <= 0 || y >= height - 1) continue;
      if (x <= centerX) {
        // Left half or center column: mark directly
        if (x === centerX && y >= centerY) continue; // center col only stores y < centerY
        riverTilesForLeftHalf.add(`${x},${y}`);
      } else {
        // Right half: 180° mirror to get left-half lower-river position
        const mx = width - 1 - x;
        const my = height - 1 - y;
        if (mx >= 0 && mx < centerX && my > 0 && my < height - 1) {
          riverTilesForLeftHalf.add(`${mx},${my}`);
        } else if (mx === centerX && my > centerY && my < height - 1) {
          // Center column lower half — stored via mirror in centerCol
          riverTilesForLeftHalf.add(`${mx},${my}`);
        }
      }
    }
  }

  // --- Biome system (similar to generateMap) ---
  const biomeWaveAmp = 0.6 + random() * 0.3;
  const biomeWaveFreq = 0.2 + random() * 0.15;
  const getBiome = (x, y) => {
    const wave = Math.sin(x * biomeWaveFreq) * biomeWaveAmp;
    return y - centerY + wave > 0 ? 'rocky' : 'plains';
  };

  // --- Lane corridor Y positions (for guaranteed paths) ---
  const topLaneCenterY = Math.round((1 + upperRiverBaseY - 1) / 2);
  const midLaneCenterY = centerY;

  // --- Generate left half + center column ---
  const leftHalf = [];
  const centerCol = [];

  const player0StartX = 2;
  const player1StartX = width - 3;

  for (let y = 0; y < height; y++) {
    leftHalf[y] = [];
    for (let x = 0; x < centerX; x++) {
      let terrain;

      // Edge tiles
      if (x === 0 || y === 0 || y === height - 1) {
        terrain = TERRAIN.WATER;
      }
      // River tiles
      else if (riverTilesForLeftHalf.has(`${x},${y}`)) {
        terrain = TERRAIN.WATER;
      }
      // Lane interiors
      else {
        const biome = getBiome(x, y);
        let mountainProb;
        if (biome === 'rocky') {
          mountainProb = 0.18 + noise(x + 50, y + 50) * 0.08;
        } else {
          mountainProb = 0.05 + noise(x + 30, y + 30) * 0.03;
        }

        // Small water ponds (rare, scattered)
        const pondChance = 0.02 + noise(x + 80, y + 80) * 0.02;

        // Reduce obstacles near cities and monument
        const distToCity = Math.max(Math.abs(x - player0StartX), Math.abs(y - centerY));
        const distToMon = Math.max(Math.abs(x - centerX), Math.abs(y - centerY));
        if (distToCity <= 3 || distToMon <= 2) {
          mountainProb = 0;
        }

        if (random() < mountainProb) {
          terrain = TERRAIN.MOUNTAIN;
        } else if (random() < pondChance && distToCity > 4 && distToMon > 3) {
          terrain = TERRAIN.WATER;
        } else {
          terrain = TERRAIN.FIELD;
        }
      }

      leftHalf[y][x] = terrain;
    }
  }

  // Center column (only top half, bottom mirrored)
  for (let y = 0; y < centerY; y++) {
    if (y === 0) {
      centerCol[y] = TERRAIN.WATER;
    } else if (riverTilesForLeftHalf.has(`${centerX},${y}`)) {
      centerCol[y] = TERRAIN.WATER;
    } else {
      const biome = getBiome(centerX, y);
      const mountainProb = biome === 'rocky' ? 0.15 : 0.04;
      const distToMon = Math.abs(y - centerY);
      if (distToMon <= 2) {
        centerCol[y] = TERRAIN.FIELD;
      } else if (random() < mountainProb) {
        centerCol[y] = TERRAIN.MOUNTAIN;
      } else {
        centerCol[y] = TERRAIN.FIELD;
      }
    }
  }

  // --- Clear starting area (keep edge water) ---
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const y = centerY + dy;
      const x = player0StartX + dx;
      if (y > 0 && y < height - 1 && x > 0 && x < centerX) {
        leftHalf[y][x] = TERRAIN.FIELD;
      }
    }
  }

  // --- Clear monument surroundings (side-lane monuments) ---
  const bottomLaneCenterY = height - 1 - topLaneCenterY;
  for (const monY of [topLaneCenterY, bottomLaneCenterY]) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const y = monY + dy;
        const x = centerX + dx;
        if (y >= 0 && y < height) {
          if (x < centerX && x >= 0) leftHalf[y][x] = TERRAIN.FIELD;
          else if (x === centerX && y < centerY) centerCol[y] = TERRAIN.FIELD;
        }
      }
    }
  }

  // --- Carve guaranteed 3-tile-wide corridors through each lane ---
  // Mid lane corridor (along centerY ± 1)
  for (let x = 1; x < centerX; x++) {
    for (let dy = -1; dy <= 1; dy++) {
      const y = midLaneCenterY + dy;
      if (y > 0 && y < height - 1) {
        if (leftHalf[y][x] !== TERRAIN.FIELD) leftHalf[y][x] = TERRAIN.FIELD;
      }
    }
  }
  for (let dy = -1; dy <= 1; dy++) {
    const y = midLaneCenterY + dy;
    if (y > 0 && y < centerY) {
      if (centerCol[y] !== TERRAIN.FIELD) centerCol[y] = TERRAIN.FIELD;
    }
  }

  // Top lane corridor (along topLaneCenterY ± 1)
  for (let x = 1; x < centerX; x++) {
    for (let dy = -1; dy <= 1; dy++) {
      const y = topLaneCenterY + dy;
      if (y > 0 && y < height - 1 && !riverTilesForLeftHalf.has(`${x},${y}`)) {
        if (leftHalf[y][x] !== TERRAIN.FIELD) leftHalf[y][x] = TERRAIN.FIELD;
      }
    }
  }
  for (let dy = -1; dy <= 1; dy++) {
    const y = topLaneCenterY + dy;
    if (y > 0 && y < centerY && !riverTilesForLeftHalf.has(`${centerX},${y}`)) {
      if (centerCol[y] !== TERRAIN.FIELD) centerCol[y] = TERRAIN.FIELD;
    }
  }

  // Bot lane corridor — will be mirrored from top lane via 180° rotation

  // --- Carve base-area vertical corridor ---
  // Ensure a 3-tile-wide vertical path through the base area
  // so units can move between all 3 lanes near their base
  const baseCorridorX = player0StartX; // x=2
  for (let y = 1; y < height - 1; y++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = baseCorridorX + dx;
      if (x > 0 && x < centerX) {
        if (leftHalf[y][x] === TERRAIN.WATER || leftHalf[y][x] === TERRAIN.MOUNTAIN) {
          leftHalf[y][x] = TERRAIN.FIELD;
        }
      }
    }
  }

  // --- Assemble full map with 180° point symmetry ---
  const tiles = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let terrain;
      if (x === centerX && (y === topLaneCenterY || y === bottomLaneCenterY)) {
        terrain = TERRAIN.MONUMENT;
      } else if (x === centerX) {
        if (y < centerY) {
          terrain = centerCol[y] || TERRAIN.WATER;
        } else {
          terrain = centerCol[height - 1 - y] || TERRAIN.WATER;
        }
      } else if (x < centerX) {
        terrain = leftHalf[y][x] !== undefined ? leftHalf[y][x] : TERRAIN.WATER;
      } else {
        const mirrorX = width - 1 - x;
        const mirrorY = height - 1 - y;
        terrain =
          leftHalf[mirrorY] && leftHalf[mirrorY][mirrorX] !== undefined
            ? leftHalf[mirrorY][mirrorX]
            : TERRAIN.WATER;
      }
      tiles.push({ x, y, type: terrain, owner: null });
    }
  }

  // --- Corner rounding: smooth the rectangular edges into rounded corners ---
  const cornerR = 7;
  for (const tile of tiles) {
    if (tile.type === TERRAIN.MONUMENT) continue;
    const edgeDistX = Math.min(tile.x, width - 1 - tile.x);
    const edgeDistY = Math.min(tile.y, height - 1 - tile.y);
    if (edgeDistX < cornerR && edgeDistY < cornerR) {
      const dx = cornerR - edgeDistX;
      const dy = cornerR - edgeDistY;
      if (Math.sqrt(dx * dx + dy * dy) > cornerR) {
        tile.type = TERRAIN.WATER;
        tile.owner = null;
      }
    }
  }

  // --- Starting territory ---
  const setStartingTerritory = (cityX, cityY, owner) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tile = tiles.find((t) => t.x === cityX + dx && t.y === cityY + dy);
        if (tile && tile.type === TERRAIN.FIELD) {
          tile.owner = owner;
        }
      }
    }
  };

  setStartingTerritory(player0StartX, centerY, 0);
  setStartingTerritory(player1StartX, centerY, 1);

  const cities = [
    { x: player0StartX, y: centerY, owner: 0 },
    { x: player1StartX, y: centerY, owner: 1 },
  ];

  const monuments = [
    { x: centerX, y: topLaneCenterY, controlledBy: null },
    { x: centerX, y: bottomLaneCenterY, controlledBy: null },
  ];

  return { width, height, tiles, cities, monuments };
}

/**
 * Create initial game state
 * @param {Object} options - Game options
 * @returns {Object} Initial game state
 */
function createInitialState(options = {}) {
  const mode = options.mode || MODES.STANDARD;
  const settings = MODE_SETTINGS[mode];

  const mapWidth = options.mapWidth || settings.mapWidth;
  const mapHeight = options.mapHeight || settings.mapHeight;
  const startingGold = settings.startingGold;
  const maxTurns = settings.maxTurns;

  // Generate or use custom map
  let mapData;
  if (options.customMap) {
    mapData = options.customMap;
  } else {
    if (mode === MODES.TOURNAMENT) {
      mapData = generateTournamentMap(mapWidth, mapHeight, options.seed);
    } else {
      mapData = generateMap(mapWidth, mapHeight, options.seed);
    }
  }

  // Calculate initial income for each player
  const calculateIncome = (playerId) => {
    let income = 0;
    // Territory income
    for (const tile of mapData.tiles) {
      if (tile.owner === playerId && tile.type === TERRAIN.FIELD) {
        income += 0.5;
      }
    }
    // City income
    for (const city of mapData.cities) {
      if (city.owner === playerId) {
        income += 5;
      }
    }
    return income;
  };

  return {
    turn: 1,
    maxTurns,
    gameOver: false,
    winner: null,
    mode,
    players: [
      {
        id: 0,
        gold: startingGold,
        score: 0,
        income: calculateIncome(0),
      },
      {
        id: 1,
        gold: startingGold,
        score: 0,
        income: calculateIncome(1),
      },
    ],
    map: {
      width: mapData.width,
      height: mapData.height,
      tiles: mapData.tiles,
    },
    units: [],
    cities: mapData.cities,
    monuments: mapData.monuments,
  };
}

/**
 * Validate a map structure
 * @param {Object} map - Map to validate
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateMap(map) {
  const errors = [];

  if (!map.width || !map.height) {
    errors.push('Map must have width and height');
  }

  if (!Array.isArray(map.tiles)) {
    errors.push('Map must have tiles array');
  }

  // Check all tiles exist
  const expectedTiles = map.width * map.height;
  if (map.tiles.length !== expectedTiles) {
    errors.push(`Expected ${expectedTiles} tiles, got ${map.tiles.length}`);
  }

  // Check at least one monument tile exists
  const monumentTiles = map.tiles.filter((t) => t.type === TERRAIN.MONUMENT);
  if (monumentTiles.length === 0) {
    errors.push('Map must have at least one monument tile');
  }

  // Check starting cities
  if (!Array.isArray(map.cities) || map.cities.length < 2) {
    errors.push('Map must have at least 2 starting cities');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  generateMap,
  generateTournamentMap,
  createInitialState,
  validateMap,
};
