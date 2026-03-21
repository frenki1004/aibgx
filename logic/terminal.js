/**
 * Terminal-based visualization for Civilization Clash
 * Used for debugging and testing
 */

const { TERRAIN, UNIT_TYPES } = require('./constants');

// ANSI color codes
const COLORS = {
  RESET: '\x1b[0m',
  RED: '\x1b[31m',
  BLUE: '\x1b[34m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
  GRAY: '\x1b[90m',
  BG_RED: '\x1b[41m',
  BG_BLUE: '\x1b[44m',
  BOLD: '\x1b[1m',
};

// Terrain symbols
const TERRAIN_SYMBOLS = {
  [TERRAIN.FIELD]: '.',
  [TERRAIN.MOUNTAIN]: '^',
  [TERRAIN.WATER]: '~',
  [TERRAIN.MONUMENT]: 'M',
};

// Unit symbols
const UNIT_SYMBOLS = {
  [UNIT_TYPES.SOLDIER]: 'S',
  [UNIT_TYPES.ARCHER]: 'A',
  [UNIT_TYPES.RAIDER]: 'R',
};

/**
 * Get color for player
 */
function getPlayerColor(playerId) {
  return playerId === 0 ? COLORS.RED : COLORS.BLUE;
}

/**
 * Render game state to terminal string
 */
function renderState(state, options = {}) {
  const { showGrid = true, showLegend = true, useColors = true } = options;
  const lines = [];

  // Header
  lines.push('');
  const turnInfo = `Turn ${state.turn}/${state.maxTurns}`;
  const gameStatus = state.gameOver
    ? state.winner !== null
      ? `Game Over - Player ${state.winner} wins!`
      : 'Game Over - Tie!'
    : 'In Progress';
  lines.push(`${turnInfo} | ${gameStatus}`);
  lines.push('');

  // Player info
  for (const player of state.players) {
    const color = useColors ? getPlayerColor(player.id) : '';
    const reset = useColors ? COLORS.RESET : '';
    const cityCount = state.cities.filter((c) => c.owner === player.id).length;
    const unitCount = state.units.filter((u) => u.owner === player.id).length;
    lines.push(
      `${color}Player ${player.id}${reset}: ` +
        `Gold: ${player.gold.toFixed(1)} (+${player.income.toFixed(1)}/turn) | ` +
        `Score: ${player.score} | ` +
        `Cities: ${cityCount} | Units: ${unitCount}`
    );
  }

  // Monument info
  for (let mi = 0; mi < state.monuments.length; mi++) {
    const monumentCtrl = state.monuments[mi].controlledBy;
    const monumentColor = monumentCtrl !== null ? getPlayerColor(monumentCtrl) : COLORS.GRAY;
    const monumentStatus = monumentCtrl !== null ? `Player ${monumentCtrl}` : 'Uncontrolled';
    const label = state.monuments.length > 1 ? `Monument ${mi + 1}` : 'Monument';
    if (useColors) {
      lines.push(`${monumentColor}${label}: ${monumentStatus}${COLORS.RESET}`);
    } else {
      lines.push(`${label}: ${monumentStatus}`);
    }
  }

  lines.push('');

  // Build tile lookup
  const tileMap = new Map();
  for (const tile of state.map.tiles) {
    tileMap.set(`${tile.x},${tile.y}`, tile);
  }

  // Build unit lookup
  const unitMap = new Map();
  for (const unit of state.units) {
    unitMap.set(`${unit.x},${unit.y}`, unit);
  }

  // Build city lookup
  const cityMap = new Map();
  for (const city of state.cities) {
    cityMap.set(`${city.x},${city.y}`, city);
  }

  // Render map
  if (showGrid) {
    // Column numbers
    let header = '   ';
    for (let x = 0; x < state.map.width; x++) {
      header += (x % 10).toString();
    }
    lines.push(header);
  }

  for (let y = 0; y < state.map.height; y++) {
    let row = showGrid ? `${y.toString().padStart(2, ' ')} ` : '';

    for (let x = 0; x < state.map.width; x++) {
      const key = `${x},${y}`;
      const tile = tileMap.get(key);
      const unit = unitMap.get(key);
      const city = cityMap.get(key);

      let char = TERRAIN_SYMBOLS[tile?.type] || '?';
      let color = '';
      let bgColor = '';

      // Determine what to show
      if (unit) {
        char = UNIT_SYMBOLS[unit.type] || '?';
        color = getPlayerColor(unit.owner);
      } else if (city) {
        char = 'C';
        color = getPlayerColor(city.owner);
      } else if (tile?.type === TERRAIN.MONUMENT) {
        char = 'M';
        const mon = state.monuments.find((m) => m.x === x && m.y === y);
        color = mon && mon.controlledBy !== null ? getPlayerColor(mon.controlledBy) : COLORS.YELLOW;
      } else if (tile?.owner !== null) {
        // Owned territory - show in player color
        color = getPlayerColor(tile.owner);
      } else if (tile?.type === TERRAIN.MOUNTAIN) {
        color = COLORS.GRAY;
      } else if (tile?.type === TERRAIN.WATER) {
        color = COLORS.CYAN;
      }

      if (useColors && color) {
        row += `${bgColor}${color}${char}${COLORS.RESET}`;
      } else {
        row += char;
      }
    }

    lines.push(row);
  }

  // Legend
  if (showLegend) {
    lines.push('');
    lines.push('Legend:');
    lines.push('  . = Field  ^ = Mountain  ~ = Water  M = Monument');
    lines.push('  S = Soldier  A = Archer  R = Raider  C = City');
    if (useColors) {
      lines.push(
        `  ${COLORS.RED}Red = Player 0${COLORS.RESET}  ${COLORS.BLUE}Blue = Player 1${COLORS.RESET}`
      );
    }
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * Print game state to console
 */
function printState(state, options = {}) {
  console.log(renderState(state, options));
}

/**
 * Render turn events
 */
function renderEvents(events, useColors = true) {
  const lines = [];

  if (events.length === 0) {
    lines.push('No events this turn.');
    return lines.join('\n');
  }

  lines.push('Turn Events:');

  for (const event of events) {
    switch (event.type) {
      case 'COMBAT': {
        const { attacker, target, damage, isKill, scoreGain, phase } = event.data;
        const atkColor = useColors ? getPlayerColor(attacker.owner) : '';
        const tgtColor = useColors ? getPlayerColor(target.owner) : '';
        const reset = useColors ? COLORS.RESET : '';
        const killText = isKill ? ' (KILLED)' : '';
        lines.push(
          `  [${phase.toUpperCase()}] ${atkColor}${attacker.type}${reset} at (${attacker.x},${attacker.y}) ` +
            `-> ${tgtColor}${target.type}${reset} at (${target.x},${target.y}) ` +
            `for ${damage} damage${killText} (+${scoreGain} score)`
        );
        break;
      }
      case 'DEATH': {
        const { unit, deathScore } = event.data;
        const color = useColors ? getPlayerColor(unit.owner) : '';
        const reset = useColors ? COLORS.RESET : '';
        lines.push(
          `  [DEATH] ${color}${unit.type}${reset} at (${unit.x},${unit.y}) died ` +
            `(+${deathScore} score to owner)`
        );
        break;
      }
      case 'CAPTURE': {
        const { tile, previousOwner, raidedBy } = event.data;
        const color = useColors ? getPlayerColor(raidedBy.owner) : '';
        const reset = useColors ? COLORS.RESET : '';
        lines.push(
          `  [RAID] ${color}${raidedBy.type}${reset} raided tile (${tile.x},${tile.y}) from Player ${previousOwner}`
        );
        break;
      }
      case 'CITY_CAPTURED': {
        const { city, previousOwner, newOwner, capturedBy } = event.data;
        const color = useColors ? getPlayerColor(newOwner) : '';
        const reset = useColors ? COLORS.RESET : '';
        lines.push(
          `  [CITY] ${color}Player ${newOwner}${reset} captured city at (${city.x},${city.y}) from Player ${previousOwner}`
        );
        break;
      }
      case 'MONUMENT_CONTROL': {
        const { controlledBy, goldAwarded, scoreAwarded, x, y } = event.data;
        const color = useColors ? getPlayerColor(controlledBy) : '';
        const reset = useColors ? COLORS.RESET : '';
        const pos = x !== undefined ? ` at (${x},${y})` : '';
        lines.push(
          `  [MONUMENT] ${color}Player ${controlledBy}${reset} controls monument${pos} (+${goldAwarded}G, +${scoreAwarded} score)`
        );
        break;
      }
      default:
        lines.push(`  [${event.type}] ${JSON.stringify(event.data)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Print turn events to console
 */
function printEvents(events, useColors = true) {
  console.log(renderEvents(events, useColors));
}

module.exports = {
  renderState,
  printState,
  renderEvents,
  printEvents,
  COLORS,
};
