/**
 * Manual Play - central state machine for playing the game manually.
 * Handles selection, action queue, pathfinding, multi-turn plans, auto-submit.
 */
const ManualPlay = {
  // --- State ---
  active: false,
  teamId: null,

  // Selection
  selectedUnits: [],
  _cachedValidMoves: [],
  _cachedValidAttacks: [],

  // Mode: 'select' | 'expand' | 'build_city'
  mode: 'select',

  // Oversight mode (dual-team manual play with bot-prefilled actions)
  oversightMode: false,
  _oversightQueues: null, // { 0: [], 1: [] }

  // Action queue
  actionQueue: [],
  projectedGold: 0,

  // Multi-turn path plans: Map<"x,y", { path, turnSegments, currentSegment, unitType }>
  pathPlans: new Map(),

  // Auto-submit
  autoSubmitTimer: null,
  autoSubmitInterval: null,
  autoSubmitDeadline: null,
  turnSubmitted: false,
  AUTO_SUBMIT_BUFFER_MS: 500,

  // Inline build
  _pendingBuildCity: null,

  // --- Lifecycle ---

  activate(teamId) {
    this.active = true;
    this.teamId = teamId;
    this.selectedUnits = [];
    this._cachedValidMoves = [];
    this._cachedValidAttacks = [];
    this.mode = 'select';
    this.actionQueue = [];
    this.projectedGold = 0;
    this.pathPlans.clear();
    this.turnSubmitted = false;
    this.stopAutoSubmit();
    Panels.addTerminalMessage(`Manual play activated for Team ${teamId}`, 'success');
  },

  deactivate() {
    this.active = false;
    this.teamId = null;
    this.oversightMode = false;
    this._oversightQueues = null;
    this.clearSelection();
    this.actionQueue = [];
    this.cancelAllPathPlans();
    this.stopAutoSubmit();
    this.mode = 'select';
    Panels.addTerminalMessage('Manual play deactivated', 'info');
  },

  // --- Oversight Mode ---

  activateOversight(team0Actions, team1Actions) {
    this.oversightMode = true;
    this.active = true;
    this.teamId = 0;
    this.selectedUnits = [];
    this._cachedValidMoves = [];
    this._cachedValidAttacks = [];
    this.mode = 'select';
    this.pathPlans.clear();
    this.turnSubmitted = false;
    this.stopAutoSubmit();

    this._oversightQueues = {
      0: [...team0Actions],
      1: [...team1Actions],
    };
    this.actionQueue = this._oversightQueues[0];

    this._refreshProjectedGold();
    this._updateQueueUI();
    Panels.showGameplayPanel(this.teamId);
    Panels.updateOversightTeam(0);
    Panels.addTerminalMessage('Oversight: reviewing actions (Cyan)', 'success');
  },

  deactivateOversight() {
    this.oversightMode = false;
    this._oversightQueues = null;
    this.active = false;
    this.teamId = null;
    this.clearSelection();
    this.actionQueue = [];
    this.mode = 'select';
    Panels.hideGameplayPanel();
  },

  switchTeam(newTeamId) {
    if (!this.oversightMode || !this._oversightQueues) return;
    this.clearSelection();
    this.teamId = newTeamId;
    this.actionQueue = this._oversightQueues[newTeamId];
    this._refreshProjectedGold();
    this._updateQueueUI();
    Panels.showGameplayPanel(newTeamId);
    Panels.updateOversightTeam(newTeamId);
    Panels.addTerminalMessage(`Switched to ${newTeamId === 0 ? 'Cyan' : 'White'} team`, 'info');
  },

  // --- Click Dispatch ---

  handleClick(x, y, tile, unit, city, shiftKey) {
    if (!this.active) return;

    // 1. Expand mode — queue expand, stay in mode for multi-expand
    if (this.mode === 'expand') {
      this.queueExpand(x, y);
      return;
    }

    // 2. Build city mode
    if (this.mode === 'build_city') {
      this.queueBuildCity(x, y);
      this.setMode('select');
      return;
    }

    // 3. Click own unit — select (shift to add)
    if (unit && unit.owner === this.teamId) {
      if (shiftKey) {
        this.addToSelection(unit);
      } else {
        this.selectUnit(unit);
      }
      return;
    }

    // 4. With units selected, click elsewhere → move
    if (this.selectedUnits.length > 0) {
      if (this.selectedUnits.length === 1) {
        this.queueMove(this.selectedUnits[0], x, y);
      } else {
        this.queueGroupMove(x, y);
      }
      this.clearSelection();
      return;
    }

    // 5. Click own city (no unit on it) → inline build popup
    if (city && city.owner === this.teamId) {
      Panels.showInlineBuildPopup(city);
      return;
    }

    // 6. Click empty → deselect
    this.clearSelection();
  },

  handleDoubleClick(x, y, tile) {
    if (!this.active) return;
    this.queueExpand(x, y);
  },

  // --- Selection ---

  selectUnit(unit) {
    this.selectedUnits = [unit];
    Renderer.selectedUnit = unit;
    this._computeValidTiles();
    Panels.addTerminalMessage(`Selected ${unit.type} at (${unit.x}, ${unit.y})`, 'info');
  },

  addToSelection(unit) {
    // Don't add duplicates
    if (this.selectedUnits.some((u) => u.x === unit.x && u.y === unit.y)) {
      // Toggle off
      this.selectedUnits = this.selectedUnits.filter((u) => !(u.x === unit.x && u.y === unit.y));
    } else {
      this.selectedUnits.push(unit);
    }
    Renderer.selectedUnit = this.selectedUnits[0] || null;
    this._computeValidTiles();
    Panels.addTerminalMessage(`${this.selectedUnits.length} unit(s) selected`, 'info');
  },

  clearSelection() {
    this.selectedUnits = [];
    this._cachedValidMoves = [];
    this._cachedValidAttacks = [];
    Renderer.selectedUnit = null;
  },

  _computeValidTiles() {
    const state = App.gameState;
    if (!state) {
      this._cachedValidMoves = [];
      this._cachedValidAttacks = [];
      return;
    }

    // For single selection, compute valid moves
    if (this.selectedUnits.length === 1) {
      const unit = this.selectedUnits[0];
      this._cachedValidMoves = Pathfinding.getValidMoves(state, unit);

      // Valid attacks: enemy units within attack range
      this._cachedValidAttacks = [];
      const stats = Pathfinding.UNIT_STATS[unit.type];
      if (stats) {
        const range = unit.type === 'ARCHER' ? 2 : 1;
        for (const enemy of state.units) {
          if (enemy.owner === this.teamId) continue;
          const dist = Math.max(Math.abs(enemy.x - unit.x), Math.abs(enemy.y - unit.y));
          if (dist <= range) {
            this._cachedValidAttacks.push({ x: enemy.x, y: enemy.y });
          }
        }
      }
    } else {
      // Multi-select: union of valid moves for all selected units
      const allMoves = new Set();
      for (const unit of this.selectedUnits) {
        const moves = Pathfinding.getValidMoves(state, unit);
        for (const m of moves) allMoves.add(`${m.x},${m.y}`);
      }
      this._cachedValidMoves = Array.from(allMoves).map((k) => {
        const [x, y] = k.split(',').map(Number);
        return { x, y };
      });
      this._cachedValidAttacks = [];
    }
  },

  // --- Mode ---

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'select') {
      this.clearSelection();
    }
    Panels.updateGameplayMode(mode);

    if (mode === 'expand') {
      Panels.addTerminalMessage('Click neutral tiles to expand territory (5g each)', 'info');
    } else if (mode === 'build_city') {
      Panels.addTerminalMessage('Click your territory to build a city (80g)', 'info');
    }
  },

  // --- Action Queue ---

  queueMove(unit, tx, ty) {
    const state = App.gameState;
    if (!state) return;

    const gridData = Pathfinding.buildGrid(state);
    const fullPath = Pathfinding.findPath(gridData, unit.x, unit.y, tx, ty);

    if (!fullPath || fullPath.length === 0) {
      Panels.addTerminalMessage(`No path to (${tx}, ${ty})`, 'warning');
      return;
    }

    // Remove any existing move for this unit (replaces old arrow)
    this._removeMovesForUnit(unit.x, unit.y);

    const stats = Pathfinding.UNIT_STATS[unit.type];
    const movement = stats ? stats.movement : 1;

    if (fullPath.length <= movement) {
      // Single-turn move
      const dest = fullPath[fullPath.length - 1];
      this._addAction({
        action: 'MOVE',
        from_x: unit.x,
        from_y: unit.y,
        to_x: dest.x,
        to_y: dest.y,
      });
    } else {
      // Multi-turn: create path plan + queue first segment
      this.createPathPlan(unit, fullPath);
      const firstDest = fullPath[Math.min(movement - 1, fullPath.length - 1)];
      this._addAction({
        action: 'MOVE',
        from_x: unit.x,
        from_y: unit.y,
        to_x: firstDest.x,
        to_y: firstDest.y,
      });
    }
  },

  queueGroupMove(tx, ty) {
    const state = App.gameState;
    if (!state) return;

    // Build grid once, then pathfind for each unit
    const gridData = Pathfinding.buildGrid(state);
    const assigned = new Set(); // Track assigned destination tiles to avoid overlap

    for (const unit of this.selectedUnits) {
      // Find a target tile: prefer exact target, fall back to nearest unoccupied neighbor
      let target = { x: tx, y: ty };
      const targetKey = `${target.x},${target.y}`;

      if (assigned.has(targetKey)) {
        // Find nearest free neighbor
        let found = false;
        for (const { dx, dy } of Pathfinding.OFFSETS) {
          const nx = tx + dx;
          const ny = ty + dy;
          const nk = `${nx},${ny}`;
          if (!assigned.has(nk) && Pathfinding._inBounds(nx, ny, gridData.width, gridData.height)) {
            const cell = gridData.grid[ny][nx];
            if (cell.passable) {
              target = { x: nx, y: ny };
              found = true;
              break;
            }
          }
        }
        if (!found) continue; // No free tile nearby
      }

      assigned.add(`${target.x},${target.y}`);

      // Remove any existing move for this unit
      this._removeMovesForUnit(unit.x, unit.y);

      const fullPath = Pathfinding.findPath(gridData, unit.x, unit.y, target.x, target.y);
      if (!fullPath || fullPath.length === 0) continue;

      const stats = Pathfinding.UNIT_STATS[unit.type];
      const movement = stats ? stats.movement : 1;

      if (fullPath.length <= movement) {
        const dest = fullPath[fullPath.length - 1];
        this._addAction({
          action: 'MOVE',
          from_x: unit.x,
          from_y: unit.y,
          to_x: dest.x,
          to_y: dest.y,
        });
      } else {
        this.createPathPlan(unit, fullPath);
        const firstDest = fullPath[Math.min(movement - 1, fullPath.length - 1)];
        this._addAction({
          action: 'MOVE',
          from_x: unit.x,
          from_y: unit.y,
          to_x: firstDest.x,
          to_y: firstDest.y,
        });
      }
    }
  },

  queueExpand(x, y) {
    const cost = Pathfinding.ECONOMY.EXPAND_COST;
    if (this.projectedGold < cost) {
      Panels.addTerminalMessage(
        `Not enough gold to expand (need ${cost}, have ${this.projectedGold})`,
        'warning'
      );
      return;
    }
    this._addAction({ action: 'EXPAND_TERRITORY', x, y }, cost);
  },

  queueBuildCity(x, y) {
    const cost = Pathfinding.getCityCost(App.gameState, this.teamId);
    if (this.projectedGold < cost) {
      Panels.addTerminalMessage(
        `Not enough gold for city (need ${cost}, have ${this.projectedGold})`,
        'warning'
      );
      return;
    }
    this._addAction({ action: 'BUILD_CITY', x, y }, cost);
  },

  queueBuildUnit(cx, cy, unitType) {
    // Use pending build city if coords not provided
    if (cx === null || cy === null) {
      if (this._pendingBuildCity) {
        cx = this._pendingBuildCity.x;
        cy = this._pendingBuildCity.y;
      } else {
        Panels.addTerminalMessage('No city selected for build', 'warning');
        return;
      }
    }

    const stats = Pathfinding.UNIT_STATS[unitType];
    const cost = stats ? stats.cost : 20;
    if (this.projectedGold < cost) {
      Panels.addTerminalMessage(
        `Not enough gold for ${unitType} (need ${cost}, have ${this.projectedGold})`,
        'warning'
      );
      return;
    }

    this._addAction(
      {
        action: 'BUILD_UNIT',
        city_x: cx,
        city_y: cy,
        unit_type: unitType,
      },
      cost
    );

    // Close inline popup
    const popup = document.getElementById('inline-build-popup');
    if (popup) popup.classList.add('hidden');
  },

  removeAction(index) {
    if (index < 0 || index >= this.actionQueue.length) return;
    const removed = this.actionQueue.splice(index, 1)[0];
    // Restore projected gold
    const cost = this._getActionCost(removed);
    this.projectedGold += cost;
    this._updateQueueUI();
    Panels.addTerminalMessage(`Removed: ${removed.action}`, 'info');
  },

  clearQueue() {
    if (this.oversightMode && this._oversightQueues) {
      // Only clear current team's queue
      this.actionQueue.length = 0;
      this._oversightQueues[this.teamId] = this.actionQueue;
    } else {
      this.actionQueue = [];
    }
    this._refreshProjectedGold();
    this._updateQueueUI();
  },

  _addAction(action, cost) {
    cost = cost || 0;
    this.actionQueue.push(action);
    this.projectedGold -= cost;
    this._updateQueueUI();
    Panels.addTerminalMessage(`Queued: ${action.action}`, 'action');
  },

  /**
   * Remove existing MOVE actions for a unit at (ux, uy) and cancel its path plan.
   * Called before queuing a new move so old arrows are replaced.
   */
  _removeMovesForUnit(ux, uy) {
    // Cancel path plan keyed by this position
    this.pathPlans.delete(`${ux},${uy}`);

    // Remove queued MOVE actions from this unit
    for (let i = this.actionQueue.length - 1; i >= 0; i--) {
      const a = this.actionQueue[i];
      if (a.action === 'MOVE' && a.from_x === ux && a.from_y === uy) {
        this.actionQueue.splice(i, 1);
      }
    }
  },

  _getActionCost(action) {
    switch (action.action) {
      case 'EXPAND_TERRITORY':
        return Pathfinding.ECONOMY.EXPAND_COST;
      case 'BUILD_CITY':
        return Pathfinding.getCityCost(App.gameState, this.teamId);
      case 'BUILD_UNIT': {
        const stats = Pathfinding.UNIT_STATS[action.unit_type];
        return stats ? stats.cost : 0;
      }
      default:
        return 0;
    }
  },

  _refreshProjectedGold() {
    const state = App.gameState;
    if (!state || !state.players) {
      this.projectedGold = 0;
      return;
    }
    const player = state.players.find((p) => p.id === this.teamId);
    this.projectedGold = player ? player.gold : 0;
  },

  _updateQueueUI() {
    Panels.updateGameplayQueue(this.actionQueue);
    Panels.updateGameplayGold(this.projectedGold);
  },

  // --- Multi-Turn Path Plans ---

  createPathPlan(unit, fullPath) {
    const stats = Pathfinding.UNIT_STATS[unit.type];
    const movement = stats ? stats.movement : 1;
    const segments = Pathfinding.splitPathIntoTurns(fullPath, movement);

    // Key by unit's current position
    const key = `${unit.x},${unit.y}`;
    this.pathPlans.set(key, {
      unitType: unit.type,
      path: fullPath,
      turnSegments: segments,
      currentSegment: 1, // Segment 0 is being queued now
      expectedPos: segments[0][segments[0].length - 1], // Where unit should be after this turn
    });

    const totalTurns = segments.length;
    Panels.addTerminalMessage(
      `Path planned: ${fullPath.length} tiles over ${totalTurns} turns`,
      'info'
    );
  },

  /**
   * Called on TURN_START to auto-queue the next step of each path plan.
   */
  advancePathPlans(state) {
    if (!state || !state.units) return;

    // Snapshot keys to avoid mutating the Map during iteration
    const entries = Array.from(this.pathPlans.entries());
    const newPlans = new Map();

    for (const [key, plan] of entries) {
      // Find the unit at expected position
      const ep = plan.expectedPos;
      const unit = state.units.find(
        (u) => u.x === ep.x && u.y === ep.y && u.owner === this.teamId && u.type === plan.unitType
      );

      if (!unit) {
        Panels.addTerminalMessage(
          `Path plan cancelled: unit not found at (${ep.x},${ep.y})`,
          'warning'
        );
        continue;
      }

      if (plan.currentSegment >= plan.turnSegments.length) {
        // Plan complete
        continue;
      }

      const segment = plan.turnSegments[plan.currentSegment];
      if (!segment || segment.length === 0) {
        continue;
      }

      // Check if the next step is still valid
      const dest = segment[segment.length - 1];
      const gridData = Pathfinding.buildGrid(state);
      const cell = gridData.grid[dest.y]?.[dest.x];

      if (!cell || !cell.passable || cell.occupied) {
        Panels.addTerminalMessage(
          `Path blocked at (${dest.x},${dest.y}) — plan cancelled`,
          'warning'
        );
        continue;
      }

      // Queue the move
      this._addAction({
        action: 'MOVE',
        from_x: unit.x,
        from_y: unit.y,
        to_x: dest.x,
        to_y: dest.y,
      });

      // Update plan for next turn
      plan.expectedPos = dest;
      plan.currentSegment++;

      // Re-key by new position if more segments remain
      if (plan.currentSegment < plan.turnSegments.length) {
        newPlans.set(`${dest.x},${dest.y}`, plan);
      }
    }

    // Replace pathPlans with only the surviving plans
    this.pathPlans.clear();
    for (const [k, v] of newPlans) {
      this.pathPlans.set(k, v);
    }
  },

  cancelPathPlan(unitKey) {
    this.pathPlans.delete(unitKey);
  },

  cancelAllPathPlans() {
    this.pathPlans.clear();
  },

  // --- Auto-Submit ---

  startAutoSubmit(turnTimeout, turnStartTime) {
    this.stopAutoSubmit();
    this.turnSubmitted = false;

    if (!turnTimeout || turnTimeout <= 0) {
      this.autoSubmitDeadline = null;
      Panels.updateGameplayCountdown(null);
      return;
    }

    this.autoSubmitDeadline = turnStartTime + turnTimeout;
    const delay = turnTimeout - this.AUTO_SUBMIT_BUFFER_MS;

    if (delay > 0) {
      this.autoSubmitTimer = setTimeout(() => {
        this.executeAutoSubmit();
      }, delay);
    }

    // Update countdown display every 100ms
    this.autoSubmitInterval = setInterval(() => {
      const remaining = this.autoSubmitDeadline - Date.now();
      Panels.updateGameplayCountdown(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(this.autoSubmitInterval);
        this.autoSubmitInterval = null;
      }
    }, 100);
  },

  stopAutoSubmit() {
    if (this.autoSubmitTimer) {
      clearTimeout(this.autoSubmitTimer);
      this.autoSubmitTimer = null;
    }
    if (this.autoSubmitInterval) {
      clearInterval(this.autoSubmitInterval);
      this.autoSubmitInterval = null;
    }
    this.autoSubmitDeadline = null;
  },

  executeAutoSubmit() {
    if (this.turnSubmitted) return;
    Panels.addTerminalMessage('Auto-submitting actions...', 'info');
    this.submitActions();
  },

  // --- Submit ---

  submitActions() {
    if (!this.active) return;

    // In oversight mode, "submit" means approve both teams' actions
    if (this.oversightMode) {
      if (typeof Oversight !== 'undefined') Oversight.approve();
      return;
    }

    if (this.turnSubmitted) {
      Panels.addTerminalMessage('Actions already submitted this turn', 'warning');
      return;
    }

    this.stopAutoSubmit();
    this.turnSubmitted = true;

    App.send({
      type: 'SUBMIT_ACTIONS',
      actions: this.actionQueue,
    });

    const count = this.actionQueue.length;
    Panels.addTerminalMessage(`Submitted ${count} action(s)`, 'success');
    // Don't clear queue yet — handleTurnResult will do that
  },

  // --- Render Overlays ---

  getRenderOverlays(state) {
    if (!this.active || !state) return null;
    if (typeof Replay !== 'undefined' && !Replay.isViewingLive()) return null;

    const overlays = {
      selectedUnits: this.selectedUnits,
      validMoves: this._cachedValidMoves,
      validAttacks: this._cachedValidAttacks,
      expandableTiles: null,
      validCityLocations: null,
      queuedMoveArrows: [],
      queuedBuildMarkers: [],
      pathPlanLines: [],
    };

    // Mode-specific overlays
    if (this.mode === 'expand') {
      // Include queued expand actions so chained expansions show correctly
      const queuedExpands = this.actionQueue
        .filter((a) => a.action === 'EXPAND_TERRITORY')
        .map((a) => ({ x: a.x, y: a.y }));
      overlays.expandableTiles = Pathfinding.getExpandableTiles(state, this.teamId, queuedExpands);
    } else if (this.mode === 'build_city') {
      overlays.validCityLocations = Pathfinding.getValidCityLocations(state, this.teamId);
    }

    // Queued action overlays — in oversight mode, show both teams
    const queuesWithTeam =
      this.oversightMode && this._oversightQueues
        ? [
            { actions: this._oversightQueues[0], teamId: 0 },
            { actions: this._oversightQueues[1], teamId: 1 },
          ]
        : [{ actions: this.actionQueue, teamId: this.teamId }];

    for (const { actions, teamId } of queuesWithTeam) {
      for (const action of actions) {
        if (action.action === 'MOVE') {
          overlays.queuedMoveArrows.push({
            fromX: action.from_x,
            fromY: action.from_y,
            toX: action.to_x,
            toY: action.to_y,
            teamId,
          });
        } else if (action.action === 'BUILD_UNIT') {
          overlays.queuedBuildMarkers.push({
            x: action.city_x,
            y: action.city_y,
            type: 'BUILD_UNIT',
            detail: action.unit_type,
            teamId,
          });
        } else if (action.action === 'BUILD_CITY') {
          overlays.queuedBuildMarkers.push({
            x: action.x,
            y: action.y,
            type: 'BUILD_CITY',
            teamId,
          });
        } else if (action.action === 'EXPAND_TERRITORY') {
          overlays.queuedBuildMarkers.push({
            x: action.x,
            y: action.y,
            type: 'EXPAND_TERRITORY',
            teamId,
          });
        }
      }
    }

    // Path plan lines
    for (const [, plan] of this.pathPlans) {
      if (plan.path && plan.path.length > 0) {
        // Include the current position as the start
        const points = [
          plan.expectedPos,
          ...plan.path.slice(
            plan.turnSegments.slice(0, plan.currentSegment).reduce((sum, s) => sum + s.length, 0)
          ),
        ];

        // Turn break indices
        const turnBreaks = [];
        let idx = 0;
        for (let i = plan.currentSegment; i < plan.turnSegments.length; i++) {
          idx += plan.turnSegments[i].length;
          turnBreaks.push(idx);
        }

        overlays.pathPlanLines.push({
          points,
          teamId: this.teamId,
          turnBreaks,
        });
      }
    }

    return overlays;
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ManualPlay;
}
