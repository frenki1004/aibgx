// Game Manager - Owns game state and handles turn processing

const fs = require('fs');
const path = require('path');
const { createInitialState, processTurn, validateAction, MODES, computeVision, filterStateForPlayer, filterEventsForPlayer } = require('../logic');

const GAME_STATES = {
  WAITING: 'waiting',
  PLAYING: 'playing',
  FINISHED: 'finished',
};

const DEFAULT_SETTINGS = {
  mode: MODES.BLITZ,
  turnTimeout: 2000,
  clientOverride: true,
  oversightTimeoutMs: 30000,
  fogOfWar: true,
};

class GameManager {
  constructor(connectionManager, options = {}) {
    this.connectionManager = connectionManager;
    this.settings = { ...DEFAULT_SETTINGS, ...options };
    this.state = null;
    this.gameState = GAME_STATES.WAITING;
    this.paused = false;
    this.turnTimer = null;
    this.pendingActions = new Map();
    this.turnHistory = [];
    this.stateHistory = []; // Full state snapshots for save/load
    this.savesDir = path.join(__dirname, 'saves');
    this.onGameEvent = null;
    this.maxSaves = options.maxSaves || 20; // keep last N save files
    this.oversightTimer = null; // Safety timeout for oversight review

    // Ensure saves directory exists
    if (!fs.existsSync(this.savesDir)) {
      fs.mkdirSync(this.savesDir, { recursive: true });
    }
  }

  setEventCallback(callback) {
    this.onGameEvent = callback;
  }

  emit(event, data) {
    if (this.onGameEvent) {
      this.onGameEvent(event, data);
    }
  }

  updateSettings(settings, fromClient = false) {
    if (fromClient && !this.settings.clientOverride) {
      return { success: false, reason: 'Client override not enabled' };
    }

    const oldMode = this.settings.mode;
    const allowedKeys = ['mode', 'turnTimeout', 'fogOfWar'];
    for (const key of allowedKeys) {
      if (settings[key] !== undefined) {
        this.settings[key] = settings[key];
      }
    }

    // If mode changed during a game, restart with new map
    if (this.gameState === GAME_STATES.PLAYING && settings.mode && settings.mode !== oldMode) {
      console.log(`[GameManager] Mode changed from ${oldMode} to ${settings.mode}, restarting game...`);
      this.emit('settings_changed', this.settings);
      this.restartGame();
      return { success: true, settings: this.settings, restarted: true };
    }

    this.emit('settings_changed', this.settings);
    return { success: true, settings: this.settings };
  }

  /**
   * Restart the game with current settings (keeps players connected)
   */
  restartGame() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }

    this.state = null;
    this.gameState = GAME_STATES.WAITING;
    this.pendingActions.clear();
    this.turnHistory = [];
    this.stateHistory = [];

    this.emit('game_reset', {});

    // Auto-start if not paused and both teams still connected
    if (!this.paused && this.connectionManager.bothTeamsConnected()) {
      this.startGame();
    }
  }

  checkAndStartGame() {
    console.log(`[GameManager] checkAndStartGame - state: ${this.gameState}, paused: ${this.paused}, bothTeams: ${this.connectionManager.bothTeamsConnected()}`);
    if (this.paused) return false;
    if (this.gameState !== GAME_STATES.WAITING) return false;
    if (!this.connectionManager.bothTeamsConnected()) return false;

    console.log('[GameManager] Starting game...');
    this.startGame();
    return true;
  }

  startGame() {
    console.log(`[GameManager] Starting game with mode: ${this.settings.mode}`);
    this.state = createInitialState({ mode: this.settings.mode });
    console.log(`[GameManager] Map size: ${this.state.map.width}x${this.state.map.height}, maxTurns: ${this.state.maxTurns}`);
    this.gameState = GAME_STATES.PLAYING;
    this.pendingActions.clear();
    this.turnHistory = [];
    this.stateHistory = [this.getClientState()]; // Record initial state

    this.emit('game_started', {
      mode: this.settings.mode,
      turnTimeout: this.settings.turnTimeout,
    });

    this.startTurn();
  }

  startTurn() {
    if (this.gameState !== GAME_STATES.PLAYING) return;

    this.pendingActions.clear();

    if (this.settings.fogOfWar) {
      this.emit('turn_started', {
        turn: this.state.turn,
        timeout: this.settings.turnTimeout,
        fogOfWar: true,
        playerStates: {
          0: this.getClientStateForPlayer(0),
          1: this.getClientStateForPlayer(1),
        },
        spectatorState: this.getSpectatorState(),
      });
    } else {
      this.emit('turn_started', {
        turn: this.state.turn,
        timeout: this.settings.turnTimeout,
        state: this.getClientState(),
      });
    }

    if (this.settings.turnTimeout) {
      this.turnTimer = setTimeout(() => {
        this.onTurnTimeout();
      }, this.settings.turnTimeout);
    }
  }

  onTurnTimeout() {
    if (this.connectionManager.getOversightClient()) {
      this.emitOversightReview();
    } else {
      this.processPendingActions();
    }
  }

  submitActions(teamId, actions) {
    if (this.gameState !== GAME_STATES.PLAYING) {
      return { success: false, reason: 'Game not in progress' };
    }

    if (teamId !== 0 && teamId !== 1) {
      return { success: false, reason: 'Invalid team ID' };
    }

    if (this.pendingActions.has(teamId)) {
      return { success: false, reason: 'Actions already submitted for this turn' };
    }

    // Validate actions, tracking expand territory claims so chains work
    const expandClaims = new Set();
    const validation = actions.map((action) => {
      if (action.action === 'EXPAND_TERRITORY') {
        // Temporarily mark previously queued expands as owned for adjacency check
        const claimedTiles = [];
        for (const key of expandClaims) {
          const [cx, cy] = key.split(',').map(Number);
          const tile = this.state.map.tiles.find((t) => t.x === cx && t.y === cy);
          if (tile && tile.owner === null) {
            tile.owner = teamId;
            claimedTiles.push(tile);
          }
        }
        const result = validateAction(this.state, teamId, action);
        // Restore tiles
        for (const tile of claimedTiles) tile.owner = null;
        if (result.valid) expandClaims.add(`${action.x},${action.y}`);
        return result;
      }
      return validateAction(this.state, teamId, action);
    });
    const validActions = actions.filter((_, i) => validation[i].valid);
    this.pendingActions.set(teamId, validActions);

    this.emit('actions_submitted', {
      teamId,
      validCount: validActions.length,
      totalCount: actions.length,
      validation,
    });

    if (this.pendingActions.has(0) && this.pendingActions.has(1)) {
      if (this.turnTimer) {
        clearTimeout(this.turnTimer);
        this.turnTimer = null;
      }
      if (this.connectionManager.getOversightClient()) {
        this.emitOversightReview();
      } else {
        this.processPendingActions();
      }
    }

    return {
      success: true,
      validCount: validActions.length,
      totalCount: actions.length,
      validation,
    };
  }

  emitOversightReview() {
    const actions = {
      team0: this.pendingActions.get(0) || [],
      team1: this.pendingActions.get(1) || [],
    };
    this.emit('oversight_review', { turn: this.state.turn, actions });
    // Safety timeout: if oversight client disconnects or hangs, auto-process
    const timeoutMs = this.settings.oversightTimeoutMs || DEFAULT_SETTINGS.oversightTimeoutMs;
    this.oversightTimer = setTimeout(() => {
      console.log('[GameManager] Oversight timeout, auto-processing');
      this.oversightTimer = null;
      this.processPendingActions();
    }, timeoutMs);
  }

  approveOversight(modifiedActions) {
    if (!this.oversightTimer) return; // Not waiting for oversight
    clearTimeout(this.oversightTimer);
    this.oversightTimer = null;
    if (modifiedActions) {
      this.pendingActions.set(0, modifiedActions.team0 || []);
      this.pendingActions.set(1, modifiedActions.team1 || []);
    }
    this.processPendingActions();
  }

  processPendingActions() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }

    const actions = {
      player0: this.pendingActions.get(0) || [],
      player1: this.pendingActions.get(1) || [],
    };

    const turnNumber = this.state.turn;
    const result = processTurn(this.state, actions);
    this.state = result.newState;

    this.turnHistory.push({
      turn: turnNumber,
      actions,
      events: result.info.turnEvents,
    });

    const clientState = this.getClientState();
    this.stateHistory.push(clientState);

    if (this.settings.fogOfWar) {
      const vision0 = computeVision(this.state, 0);
      const vision1 = computeVision(this.state, 1);
      this.emit('turn_processed', {
        turn: turnNumber,
        fogOfWar: true,
        playerStates: {
          0: filterStateForPlayer(clientState, 0, vision0),
          1: filterStateForPlayer(clientState, 1, vision1),
        },
        playerEvents: {
          0: filterEventsForPlayer(result.info.turnEvents, 0, vision0),
          1: filterEventsForPlayer(result.info.turnEvents, 1, vision1),
        },
        spectatorState: {
          ...clientState,
          _fogEnabled: true,
          _vision0: Array.from(vision0),
          _vision1: Array.from(vision1),
        },
        events: result.info.turnEvents,
      });
    } else {
      this.emit('turn_processed', {
        turn: turnNumber,
        events: result.info.turnEvents,
        state: clientState,
      });
    }

    if (this.state.gameOver) {
      this.endGame();
    } else {
      this.startTurn();
    }
  }

  endGame() {
    this.gameState = GAME_STATES.FINISHED;

    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }

    // Auto-save the game
    const saveId = this.saveGame();

    this.emit('game_ended', {
      winner: this.state.winner,
      reason: this.state.winReason,
      finalState: this.getClientState(),
      history: this.turnHistory,
      saveId,
    });

    // Auto-restart after a short delay if not paused and both teams still connected
    setTimeout(() => {
      if (!this.paused && this.connectionManager.bothTeamsConnected()) {
        console.log('[GameManager] Auto-restarting game...');
        this.reset();
        this.checkAndStartGame();
      }
    }, 3000);
  }

  /**
   * Save current game to a JSON file. Returns the save ID.
   */
  saveGame() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const p0 = this.connectionManager.getPlayerByTeam(0);
    const p1 = this.connectionManager.getPlayerByTeam(1);
    const p0Name = p0?.name || 'Unknown';
    const p1Name = p1?.name || 'Unknown';
    const saveId = `${timestamp}_${p0Name}-vs-${p1Name}`;
    const filename = `${saveId}.json`;

    const saveData = {
      id: saveId,
      timestamp: new Date().toISOString(),
      mode: this.settings.mode,
      players: [
        { id: 0, name: p0Name },
        { id: 1, name: p1Name },
      ],
      winner: this.state?.winner ?? null,
      winReason: this.state?.winReason ?? null,
      finalTurn: this.state?.turn ?? 0,
      maxTurns: this.state?.maxTurns ?? 0,
      states: this.stateHistory,
    };

    try {
      const filePath = path.join(this.savesDir, filename);
      fs.writeFileSync(filePath, JSON.stringify(saveData));
      console.log(`[GameManager] Game saved: ${filename}`);
      this.pruneOldSaves();
      return saveId;
    } catch (err) {
      console.error(`[GameManager] Failed to save game: ${err.message}`);
      return null;
    }
  }

  /**
   * Delete oldest saves if over the maxSaves limit
   */
  pruneOldSaves() {
    try {
      const files = fs.readdirSync(this.savesDir)
        .filter((f) => f.endsWith('.json'))
        .sort(); // ISO timestamps sort chronologically
      const toDelete = files.length - this.maxSaves;
      for (let i = 0; i < toDelete; i++) {
        fs.unlinkSync(path.join(this.savesDir, files[i]));
        console.log(`[GameManager] Pruned old save: ${files[i]}`);
      }
    } catch (err) {
      console.error(`[GameManager] Failed to prune saves: ${err.message}`);
    }
  }

  /**
   * List saved games (metadata only, no full states)
   */
  listSaves() {
    try {
      const files = fs.readdirSync(this.savesDir).filter((f) => f.endsWith('.json'));
      return files.map((f) => {
        try {
          const raw = fs.readFileSync(path.join(this.savesDir, f), 'utf8');
          const data = JSON.parse(raw);
          return {
            id: data.id,
            filename: f,
            timestamp: data.timestamp,
            mode: data.mode,
            players: data.players,
            winner: data.winner,
            winReason: data.winReason,
            finalTurn: data.finalTurn,
            maxTurns: data.maxTurns,
          };
        } catch {
          return { filename: f, error: 'Failed to read' };
        }
      });
    } catch {
      return [];
    }
  }

  /**
   * Load a saved game's state history by ID
   */
  loadSave(saveId) {
    try {
      const files = fs.readdirSync(this.savesDir).filter((f) => f.endsWith('.json'));
      const file = files.find((f) => f.includes(saveId));
      if (!file) return { success: false, reason: 'Save not found' };

      const raw = fs.readFileSync(path.join(this.savesDir, file), 'utf8');
      const data = JSON.parse(raw);
      return {
        success: true,
        id: data.id,
        players: data.players,
        winner: data.winner,
        winReason: data.winReason,
        states: data.states,
      };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }

  getClientState() {
    if (!this.state) return null;

    return {
      turn: this.state.turn,
      maxTurns: this.state.maxTurns,
      gameOver: this.state.gameOver,
      winner: this.state.winner,
      winReason: this.state.winReason,
      players: this.state.players.map((p) => {
        // Get player name from connection manager
        const playerConn = this.connectionManager.getPlayerByTeam(p.id);
        return {
          id: p.id,
          gold: p.gold,
          income: p.income,
          score: p.score,
          name: playerConn?.name || `Player ${p.id + 1}`,
        };
      }),
      map: {
        width: this.state.map.width,
        height: this.state.map.height,
        tiles: this.state.map.tiles,
      },
      units: this.state.units,
      cities: this.state.cities,
      monuments: this.state.monuments,
    };
  }

  /**
   * Get fog-filtered client state for a specific player.
   */
  getClientStateForPlayer(playerId) {
    const fullState = this.getClientState();
    if (!fullState || !this.settings.fogOfWar) return fullState;

    const visibleTiles = computeVision(this.state, playerId);
    return filterStateForPlayer(fullState, playerId, visibleTiles);
  }

  /**
   * Get spectator state with both players' vision borders.
   */
  getSpectatorState() {
    const fullState = this.getClientState();
    if (!fullState || !this.settings.fogOfWar) return fullState;

    const vision0 = computeVision(this.state, 0);
    const vision1 = computeVision(this.state, 1);
    return {
      ...fullState,
      _fogEnabled: true,
      _vision0: Array.from(vision0),
      _vision1: Array.from(vision1),
    };
  }

  getStatus() {
    return {
      gameState: this.gameState,
      paused: this.paused,
      settings: this.settings,
      currentTurn: this.state?.turn ?? null,
      players: this.connectionManager.getConnectedClients(),
      pendingSubmissions: {
        team0: this.pendingActions.has(0),
        team1: this.pendingActions.has(1),
      },
    };
  }

  pause() {
    this.paused = true;
    // Stop current game regardless of state (PLAYING or FINISHED)
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    if (this.gameState !== GAME_STATES.WAITING) {
      this.state = null;
      this.gameState = GAME_STATES.WAITING;
      this.pendingActions.clear();
      this.turnHistory = [];
      this.stateHistory = [];
      this.emit('game_reset', {});
    }
    return { success: true, paused: true };
  }

  resume() {
    this.paused = false;
    this.checkAndStartGame();
    return { success: true, paused: false };
  }

  reset() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    if (this.oversightTimer) {
      clearTimeout(this.oversightTimer);
      this.oversightTimer = null;
    }

    this.state = null;
    this.gameState = GAME_STATES.WAITING;
    this.pendingActions.clear();
    this.turnHistory = [];
    this.stateHistory = [];

    this.emit('game_reset', {});
  }
}

module.exports = { GameManager, GAME_STATES, DEFAULT_SETTINGS };
