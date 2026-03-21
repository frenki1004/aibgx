/**
 * Civilization Clash - Main Application
 */
const App = {
  // WebSocket connection
  ws: null,
  wsUrl: 'ws://localhost:8080',
  reconnectAttempts: 0,
  maxReconnectAttempts: 5,
  reconnectDelay: 2000,

  // Game state
  gameState: null,
  isSpectator: true,
  teamId: null,
  playerName: 'Spectator',

  // Player names (stored separately to avoid being overwritten by replay states)
  playerNames: {
    0: null,
    1: null,
  },

  // Timer
  timerInterval: null,
  turnStartTime: null,
  turnTimeout: 2000,

  /**
   * Initialize the application
   */
  init() {
    // Initialize panels
    Panels.init();

    // Load unit weapon assets
    if (typeof Units !== 'undefined') {
      Units.loadAssets('assets/units');
    }

    // Initialize renderer
    const canvas = document.getElementById('game-canvas');
    if (canvas) {
      Renderer.init(canvas);
    }

    // Log initialization
    Panels.addTerminalMessage('Application initialized', 'success');
    Panels.addTerminalMessage('Press T to toggle terminal', 'info');
    Panels.addTerminalMessage('Use mouse wheel to zoom, right-click drag to pan', 'info');

    // Sync server URL input with current value
    const urlInput = document.getElementById('server-url');
    if (urlInput) urlInput.value = this.wsUrl;

    // Connect to WebSocket server
    this.connectWebSocket();
  },

  /**
   * Load demo data for testing (can be called manually from console)
   */
  loadDemo() {
    this.loadMockGameState();
  },

  /**
   * Connect to WebSocket server
   */
  /**
   * Change server URL and reconnect
   */
  changeServerUrl(url) {
    url = url.trim();
    if (!url) return;
    if (this.ws) {
      this.ws.onclose = null; // Prevent auto-reconnect to old URL
      this.ws.close();
      this.ws = null;
    }
    this.wsUrl = url;
    this.reconnectAttempts = 0;
    Panels.addTerminalMessage(`Switching to ${url}`, 'info');
    this.connectWebSocket();
  },

  connectWebSocket() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    Panels.addTerminalMessage(`Connecting to ${this.wsUrl}...`, 'info');
    Panels.updateConnectionStatus('connecting');

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => this.onWebSocketOpen();
      this.ws.onmessage = (e) => this.onWebSocketMessage(e);
      this.ws.onclose = () => this.onWebSocketClose();
      this.ws.onerror = (e) => this.onWebSocketError(e);
    } catch (error) {
      Panels.addTerminalMessage(`Connection error: ${error.message}`, 'error');
      Panels.updateConnectionStatus('disconnected');
    }
  },

  /**
   * WebSocket open handler
   */
  onWebSocketOpen() {
    Panels.addTerminalMessage('Connected to server', 'success');
    Panels.updateConnectionStatus('connected');
    this.reconnectAttempts = 0;

    // Check if we have pending player auth (from connectAsPlayer)
    if (this.pendingPlayerAuth) {
      const auth = this.pendingPlayerAuth;
      this.pendingPlayerAuth = null;
      this.send({
        type: 'AUTH',
        password: auth.password,
        name: auth.name,
        preferredTeam: auth.preferredTeam,
      });
    } else {
      // Authenticate as spectator
      this.send({
        type: 'AUTH',
        password: 'spectator',
        name: this.playerName,
      });
    }
  },

  /**
   * WebSocket message handler
   */
  onWebSocketMessage(event) {
    try {
      const data = JSON.parse(event.data);
      this.handleServerMessage(data);
    } catch (error) {
      Panels.addTerminalMessage(`Invalid message: ${error.message}`, 'error');
    }
  },

  /**
   * WebSocket close handler
   */
  onWebSocketClose() {
    Panels.addTerminalMessage('Disconnected from server', 'warning');
    Panels.updateConnectionStatus('disconnected');

    // Attempt reconnection
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      Panels.updateConnectionStatus('reconnecting');
      Panels.addTerminalMessage(
        `Reconnecting in ${this.reconnectDelay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
        'info'
      );
      setTimeout(() => this.connectWebSocket(), this.reconnectDelay);
    } else {
      Panels.addTerminalMessage('Max reconnection attempts reached', 'error');
      Panels.updateConnectionStatus('disconnected');
    }
  },

  /**
   * WebSocket error handler
   */
  onWebSocketError(error) {
    Panels.addTerminalMessage('WebSocket error', 'error');
  },

  /**
   * Send message to server
   */
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  },

  /**
   * Handle server message
   */
  handleServerMessage(data) {
    console.log('[WS] Received:', data.type, data);

    switch (data.type) {
      case 'AUTH_SUCCESS':
        this.handleAuthSuccess(data);
        break;

      case 'AUTH_FAILED':
        Panels.addTerminalMessage(`Authentication failed: ${data.reason}`, 'error');
        break;

      case 'GAME_STATE':
        this.handleGameState(data);
        break;

      case 'GAME_STARTED':
        Panels.addTerminalMessage(`Game started! Mode: ${data.mode}`, 'success');
        // Reset live buffer — doesn't interrupt save replays
        if (typeof Replay !== 'undefined') {
          Replay.resetLiveBuffer();
        }
        break;

      case 'TURN_START':
        this.handleTurnStart(data);
        break;

      case 'TURN_RESULT':
        this.handleTurnResult(data);
        break;

      case 'GAME_OVER':
        this.handleGameOver(data);
        break;

      case 'SERVER_STATUS':
        this.handleServerStatus(data);
        break;

      case 'PLAYER_JOINED':
        Panels.addTerminalMessage(`Player joined: ${data.name} (Team ${data.team})`, 'info');
        this.playerNames[data.team] = data.name;
        // Update connection dot in server panel
        Panels.updatePlayerConnection(data.team, true);
        // If viewing live, update name immediately (next state will also have it)
        if (typeof Replay === 'undefined' || Replay.isViewingLive()) {
          Panels.updatePlayerInfo(data.team, { name: data.name });
        }
        break;

      case 'PLAYER_LEFT':
        Panels.addTerminalMessage(`Player left: ${data.name} (Team ${data.team})`, 'warning');
        this.playerNames[data.team] = null;
        // Update connection dot in server panel
        Panels.updatePlayerConnection(data.team, false);
        // If viewing live, reset name to default
        if (typeof Replay === 'undefined' || Replay.isViewingLive()) {
          Panels.updatePlayerInfo(data.team, { name: `Player ${data.team + 1}` });
        }
        break;

      case 'GAME_RESET':
        Panels.addTerminalMessage('Game reset - waiting for players', 'info');
        this.gameState = null;
        this.stopTimer();
        Panels.updateTimerDisplay('reset');
        // Don't blank the canvas here — keep the last frame visible
        // until the next game's first state arrives. This prevents the
        // visual flash/refresh between games.
        break;

      case 'SETTINGS_UPDATED':
        if (data.success) {
          const msg = data.restarted
            ? `Settings updated & game restarted: mode=${data.settings?.mode}, timeout=${data.settings?.turnTimeout}ms`
            : `Settings updated: mode=${data.settings?.mode}, timeout=${data.settings?.turnTimeout}ms`;
          Panels.addTerminalMessage(msg, 'success');
        } else {
          Panels.addTerminalMessage(`Failed to update settings: ${data.reason}`, 'error');
        }
        break;

      case 'SETTINGS_CHANGED':
        Panels.addTerminalMessage(
          `Settings changed: mode=${data.settings?.mode}, timeout=${data.settings?.turnTimeout}ms`,
          'info'
        );
        break;

      case 'PAUSE_UPDATED':
        this.updatePauseButton(data.paused);
        if (data.paused) {
          this.stopTimer();
          Panels.updateTimerDisplay('paused');
        }
        Panels.addTerminalMessage(data.paused ? 'Server paused' : 'Server resumed', 'info');
        break;

      case 'OVERSIGHT_REVIEW':
        this.handleOversightReview(data);
        break;

      case 'SAVES_LIST':
        this.handleSavesList(data);
        break;

      case 'SAVE_LOADED':
        this.handleSaveLoaded(data);
        break;

      case 'ERROR':
        Panels.addTerminalMessage(`Server error: ${data.error || data.message}`, 'error');
        break;

      default:
        Panels.addTerminalMessage(`Unknown message type: ${data.type}`, 'warning');
    }
  },

  /**
   * Handle successful authentication
   */
  handleAuthSuccess(data) {
    this.teamId = data.teamId;
    this.playerName = data.assignedName;
    this.isSpectator = data.isSpectator;

    const roleLabel = data.isOversight
      ? 'Oversight'
      : this.isSpectator
        ? 'Spectator'
        : `Team ${this.teamId}`;
    Panels.addTerminalMessage(`Authenticated as: ${this.playerName} (${roleLabel})`, 'success');

    // Activate oversight if connected as oversight
    if (data.isOversight) {
      if (typeof Oversight !== 'undefined') Oversight.activate();
      Panels.showOversightConnected();
      // Command bar will appear when ManualPlay.activateOversight is called on first review
    }
    // Activate manual play if connected as player
    else if (!this.isSpectator) {
      if (typeof ManualPlay !== 'undefined') ManualPlay.activate(this.teamId);
      Panels.showManualConnected(this.teamId);
      Panels.showGameplayPanel(this.teamId);
    }

    // Request current state and server status (for pause state)
    this.send({ type: 'GET_STATE' });
    this.requestStatus();
  },

  /**
   * Connect as a player (manual play)
   */
  connectAsPlayer() {
    const teamSelect = document.getElementById('manual-team');
    const passwordInput = document.getElementById('manual-password');

    const preferredTeam = teamSelect ? parseInt(teamSelect.value) : 0;
    const password = passwordInput ? passwordInput.value : '';

    if (!password) {
      Panels.addTerminalMessage('Password required to connect as player', 'warning');
      return;
    }

    // Store credentials for reconnection
    this.pendingPlayerAuth = {
      password,
      preferredTeam,
      name: 'ManualPlayer',
    };

    // Close current connection and reconnect with player credentials
    if (this.ws) {
      this.reconnectAttempts = 0; // Reset so we don't hit max
      this.ws.close();
    }

    Panels.addTerminalMessage(`Reconnecting as Team ${preferredTeam}...`, 'info');
  },

  /**
   * Disconnect from player mode
   */
  disconnectPlayer() {
    if (typeof ManualPlay !== 'undefined') ManualPlay.deactivate();
    if (typeof Oversight !== 'undefined') Oversight.deactivate();
    this.isSpectator = true;
    this.teamId = null;
    Panels.showManualDisconnected();
    Panels.showOversightDisconnected();
    Panels.hideGameplayPanel();
    Panels.addTerminalMessage('Disconnected, reconnecting as spectator...', 'info');

    // Reconnect as spectator
    if (this.ws) {
      this.reconnectAttempts = 0;
      this.ws.close();
    }
  },

  /**
   * Connect as oversight client
   */
  connectAsOversight() {
    const passwordInput = document.getElementById('oversight-password');
    const password = passwordInput ? passwordInput.value : 'oversight';

    if (!password) {
      Panels.addTerminalMessage('Oversight password required', 'warning');
      return;
    }

    this.pendingPlayerAuth = {
      password,
      name: 'Oversight',
    };

    if (this.ws) {
      this.reconnectAttempts = 0;
      this.ws.close();
    }

    Panels.addTerminalMessage('Connecting as Oversight...', 'info');
  },

  /**
   * Handle oversight review from server
   */
  handleOversightReview(data) {
    if (typeof Oversight !== 'undefined' && Oversight.active) {
      Oversight.handleReview(data);
    }
    Panels.addTerminalMessage(
      `Turn ${data.turn}: Oversight review (${data.actions.team0.length}+${data.actions.team1.length} actions)`,
      'info'
    );
  },

  // --- Manual Play Delegators ---

  startExpandMode() {
    if (typeof ManualPlay !== 'undefined') ManualPlay.setMode('expand');
  },

  startCityMode() {
    if (typeof ManualPlay !== 'undefined') ManualPlay.setMode('build_city');
  },

  cancelInteractionMode() {
    if (typeof ManualPlay !== 'undefined') ManualPlay.setMode('select');
  },

  handleTileClick(x, y, tile, unit, city, shiftKey) {
    if (typeof ManualPlay !== 'undefined' && ManualPlay.active) {
      ManualPlay.handleClick(x, y, tile, unit, city, shiftKey);
      return;
    }
  },

  handleTileDoubleClick(x, y, tile) {
    if (typeof ManualPlay !== 'undefined' && ManualPlay.active) {
      ManualPlay.handleDoubleClick(x, y, tile);
      return;
    }
  },

  confirmBuild() {
    if (typeof ManualPlay !== 'undefined' && ManualPlay.active) {
      const unitType = (Panels.selectedUnitType || 'soldier').toUpperCase();
      const select = document.getElementById('build-city');
      let city = this.selectedBuildCity;
      if (!city && select && this.gameState) {
        const myCities = this.gameState.cities.filter((c) => c.owner === this.teamId);
        city = myCities[parseInt(select.value)];
      }
      if (city) {
        ManualPlay.queueBuildUnit(city.x, city.y, unitType);
        Panels.closeAllModals();
      }
      return;
    }
  },

  showBuildModalForCity(city) {
    const select = document.getElementById('build-city');
    if (select && this.gameState) {
      const myCities = this.gameState.cities.filter((c) => c.owner === this.teamId);
      const cityIndex = myCities.findIndex((c) => c.x === city.x && c.y === city.y);
      if (cityIndex >= 0) select.value = cityIndex;
    }
    this.selectedBuildCity = city;
    toggleModal('modal-build');
  },

  /**
   * Apply settings from the settings modal
   */
  applySettings() {
    const modeSelect = document.getElementById('setting-map-size');
    const timeoutInput = document.getElementById('setting-timeout');
    const noTimeoutCheck = document.getElementById('setting-no-timeout');
    const oversightTimeoutInput = document.getElementById('setting-oversight-timeout');
    const autosubmitBufferInput = document.getElementById('setting-autosubmit-buffer');

    const mode = modeSelect ? modeSelect.value : 'blitz';
    const turnTimeout =
      noTimeoutCheck && noTimeoutCheck.checked
        ? 0
        : timeoutInput
          ? parseInt(timeoutInput.value) || 2000
          : 2000;
    const oversightTimeoutMs = oversightTimeoutInput
      ? parseInt(oversightTimeoutInput.value) || 30000
      : 30000;

    // Apply auto-submit buffer locally
    const autosubmitBuffer = autosubmitBufferInput
      ? parseInt(autosubmitBufferInput.value) || 500
      : 500;
    if (typeof ManualPlay !== 'undefined') {
      ManualPlay.AUTO_SUBMIT_BUFFER_MS = autosubmitBuffer;
    }

    // Apply oversight auto-approve delay locally
    const oversightApproveInput = document.getElementById('setting-oversight-approve');
    const oversightApproveDelay = oversightApproveInput
      ? parseInt(oversightApproveInput.value) || 500
      : 500;
    if (typeof Oversight !== 'undefined') {
      Oversight.autoApproveDelay = oversightApproveDelay;
    }

    Panels.addTerminalMessage(
      `Applying settings: mode=${mode}, timeout=${turnTimeout || 'none'}, oversight=${oversightTimeoutMs}ms, autosubmit=${autosubmitBuffer}ms`,
      'info'
    );

    const fogCheckbox = document.getElementById('setting-fog');
    const fogOfWar = fogCheckbox ? fogCheckbox.checked : true;

    this.send({
      type: 'GAME_CONTROL',
      command: 'update_settings',
      settings: {
        mode: mode,
        turnTimeout: turnTimeout,
        oversightTimeoutMs: oversightTimeoutMs,
        fogOfWar: fogOfWar,
      },
    });
  },

  /**
   * Cycle fog view mode via toolbar button (visuals only, no server change)
   * off → P0 → P1 → spectator → off
   */
  toggleFog() {
    if (typeof Renderer === 'undefined') return;
    const mode = Renderer.fogViewMode;
    const next = mode === null ? 0 : mode === 0 ? 1 : mode === 1 ? 'spectator' : null;
    Renderer.fogViewMode = next;
    Renderer._applyFogView();
    Renderer._stateVersion++;

    const labels = { 0: 'Player 1 POV', 1: 'Player 2 POV', spectator: 'Spectator borders' };
    Panels.addTerminalMessage(`Fog view: ${labels[next] || 'OFF'}`, 'info');
  },

  /**
   * Toggle server pause state
   */
  togglePause() {
    const btn = document.getElementById('btn-pause');
    const isPaused = btn && btn.dataset.paused === 'true';
    this.send({
      type: 'GAME_CONTROL',
      command: isPaused ? 'resume' : 'pause',
    });
  },

  /**
   * Update pause button UI
   */
  updatePauseButton(paused) {
    const btn = document.getElementById('btn-pause');
    const icon = document.getElementById('pause-icon');
    const label = document.getElementById('pause-label');
    if (!btn) return;

    btn.dataset.paused = paused ? 'true' : 'false';
    if (label) label.textContent = paused ? 'Start' : 'Stop';
    if (icon) {
      icon.setAttribute('data-lucide', paused ? 'play' : 'square');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    btn.classList.toggle('btn-paused', paused);
  },

  /**
   * Handle game state update
   */
  handleGameState(data) {
    // Server sends { type, state, gameState }
    const state = data.state;
    if (!state) {
      console.error('[App] GAME_STATE message has no state:', data);
      return;
    }

    this.gameState = state;

    // Add to replay history (always buffers to liveStates)
    if (typeof Replay !== 'undefined') {
      Replay.addState(state);
    }

    // Only update renderer if viewing live
    if (typeof Replay === 'undefined' || Replay.isViewingLive()) {
      Renderer.setGameState(state);
      this.updateUI();
    }

    Panels.addTerminalMessage(
      `Game state received: Turn ${state.turn}/${state.maxTurns || state.max_turns}`,
      'info'
    );
  },

  /**
   * Handle turn start
   */
  handleTurnStart(data) {
    this.turnStartTime = Date.now();
    this.turnTimeout = data.timeout || 0;

    // Process state if included
    if (data.state) {
      this.gameState = data.state;

      // Add to replay (deduplicates by turn number)
      if (typeof Replay !== 'undefined') {
        Replay.addState(data.state);
      }

      // Only update renderer if viewing live
      if (typeof Replay === 'undefined' || Replay.isViewingLive()) {
        Renderer.setGameState(data.state);
        this.updateUI();
      }
    }

    // Only start timer when there's a timeout and we're viewing live
    const isLive = typeof Replay === 'undefined' || Replay.isViewingLive();
    if (this.turnTimeout > 0 && isLive) {
      this.startTimer();
    } else if (this.turnTimeout <= 0) {
      this.stopTimer();
      Panels.updateTimerDisplay('no-timeout');
    } else {
      this.stopTimer();
      Panels.updateTimerDisplay('replay');
    }

    // ManualPlay: advance path plans, reset submit flag, start auto-submit
    if (typeof ManualPlay !== 'undefined' && ManualPlay.active) {
      ManualPlay._refreshProjectedGold();
      ManualPlay.turnSubmitted = false;
      if (data.state) ManualPlay.advancePathPlans(data.state);
      ManualPlay.startAutoSubmit(this.turnTimeout, this.turnStartTime);
    }

    Panels.addTerminalMessage(`Turn ${data.turn} started`, 'info');
  },

  /**
   * Handle turn result (end of turn with new state)
   */
  handleTurnResult(data) {
    this.stopTimer();

    if (data.state) {
      this.gameState = data.state;

      // Attach events to state for replay
      if (data.events) data.state._events = data.events;

      // Add to replay (deduplicates by turn number)
      if (typeof Replay !== 'undefined') {
        Replay.addState(data.state);
      }

      // Only update renderer if viewing live
      if (typeof Replay === 'undefined' || Replay.isViewingLive()) {
        Renderer.setGameState(data.state);
        if (data.events) Renderer.applyTurnEvents(data.events);
        this.updateUI();

        // Log events to terminal
        if (data.events) this.logTurnEvents(data.events, data.state.turn);
      }
    }

    // ManualPlay: stop auto-submit and clear queue for next turn
    if (typeof ManualPlay !== 'undefined' && ManualPlay.active) {
      if (ManualPlay.oversightMode) {
        // In oversight mode, deactivate ManualPlay between turns.
        // The next OVERSIGHT_REVIEW will re-activate it with fresh actions.
        Oversight.stopAutoApprove();
        ManualPlay.deactivateOversight();
      } else {
        ManualPlay.stopAutoSubmit();
        ManualPlay.clearQueue();
      }
    }

    Panels.addTerminalMessage(`Turn ${data.turn} processed`, 'info');
  },

  /**
   * Handle game over
   */
  handleGameOver(data) {
    this.stopTimer();

    const winner = data.winner !== null ? (data.winner === 0 ? 'Cyan' : 'White') : 'Draw';
    const reasons = { score: 'by score', elimination: 'by domination', tie: 'draw' };
    const reason = reasons[data.reason] || data.reason || '';

    Panels.addTerminalMessage(`Game Over! ${winner} wins ${reason}`, 'success');
  },

  /**
   * Log turn events to the terminal
   */
  logTurnEvents(events, turn) {
    const team = (id) => (id === 0 ? 'Cyan' : 'White');

    for (const e of events) {
      switch (e.type) {
        case 'COMBAT': {
          const { phase, attacker, target, damage } = e.data;
          const dmg = damage !== undefined ? damage : '?';
          Panels.addTerminalMessage(
            `T${turn} ${phase === 'archer' ? 'Ranged' : 'Melee'}: ${team(attacker.owner)} ${attacker.type} (${attacker.x},${attacker.y}) → ${team(target.owner)} ${target.type} (${target.x},${target.y}) [${dmg} dmg]`,
            'action'
          );
          break;
        }
        case 'DEATH': {
          const { unit } = e.data;
          Panels.addTerminalMessage(
            `T${turn} Kill: ${team(unit.owner)} ${unit.type} died at (${unit.x},${unit.y})`,
            'error'
          );
          break;
        }
        case 'CITY_CAPTURED': {
          const { city, newOwner } = e.data;
          Panels.addTerminalMessage(
            `T${turn} City captured at (${city.x},${city.y}) by ${team(newOwner)}`,
            'warning'
          );
          break;
        }
        case 'MONUMENT_CONTROL': {
          const { x, y, controlledBy } = e.data;
          Panels.addTerminalMessage(
            `T${turn} Monument (${x},${y}): ${controlledBy !== null ? team(controlledBy) : 'contested'}`,
            'info'
          );
          break;
        }
        case 'PLUNDER': {
          const { raider, tilesPlundered, goldGained } = e.data;
          Panels.addTerminalMessage(
            `T${turn} Plunder: ${team(raider.owner)} raider (${raider.x},${raider.y}) looted ${tilesPlundered} tiles (+${goldGained}G)`,
            'warning'
          );
          break;
        }
        case 'DISBAND': {
          const { unit, reason } = e.data;
          Panels.addTerminalMessage(
            `T${turn} Disband: ${team(unit.owner)} ${unit.type} at (${unit.x},${unit.y}) [${reason}]`,
            'error'
          );
          break;
        }
      }
    }
  },

  /**
   * Request server status (includes current settings)
   */
  requestStatus() {
    this.send({ type: 'GET_STATUS' });
  },

  /**
   * Handle server status
   */
  handleServerStatus(data) {
    Panels.addTerminalMessage(`Server status: ${data.gameState || 'unknown'}`, 'info');

    // Sync pause button
    if (data.paused !== undefined) {
      this.updatePauseButton(data.paused);
    }

    // Sync player connection dots from server status
    if (data.players) {
      const team0Connected = data.players.some((p) => p.type === 'player' && p.team === 0);
      const team1Connected = data.players.some((p) => p.type === 'player' && p.team === 1);
      Panels.updatePlayerConnection(0, team0Connected);
      Panels.updatePlayerConnection(1, team1Connected);

      // Store names of connected players
      data.players.forEach((p) => {
        if (p.type === 'player' && (p.team === 0 || p.team === 1)) {
          this.playerNames[p.team] = p.name;
        }
      });
      // Clear names for disconnected teams
      if (!team0Connected) this.playerNames[0] = null;
      if (!team1Connected) this.playerNames[1] = null;
    }

    // Populate settings fields from server
    if (data.settings) {
      const modeSelect = document.getElementById('setting-map-size');
      const timeoutInput = document.getElementById('setting-timeout');
      const noTimeoutCheck = document.getElementById('setting-no-timeout');

      if (modeSelect) modeSelect.value = data.settings.mode || 'blitz';
      if (timeoutInput) {
        timeoutInput.value = data.settings.turnTimeout || 2000;
        timeoutInput.disabled = !data.settings.turnTimeout;
      }
      if (noTimeoutCheck) noTimeoutCheck.checked = !data.settings.turnTimeout;

      const fogCheckbox = document.getElementById('setting-fog');
      if (fogCheckbox && data.settings.fogOfWar !== undefined) {
        fogCheckbox.checked = data.settings.fogOfWar;
      }
    }
  },

  /**
   * Request saved games list from server
   */
  requestSavesList() {
    this.send({ type: 'LIST_SAVES' });
  },

  /**
   * Load a saved game for replay
   */
  loadSavedGame(saveId) {
    this.send({ type: 'LOAD_SAVE', saveId });
  },

  /**
   * Handle saves list response
   */
  handleSavesList(data) {
    const saves = data.saves || [];
    Panels.updateReplaysModal(saves);
    Panels.addTerminalMessage(`Loaded ${saves.length} saved games`, 'info');
  },

  /**
   * Handle loaded save response
   */
  handleSaveLoaded(data) {
    if (!data.success) {
      Panels.addTerminalMessage(`Failed to load save: ${data.reason}`, 'error');
      return;
    }

    const label = `${data.players[0].name} vs ${data.players[1].name}`;
    Panels.addTerminalMessage(`Loaded replay: ${label}`, 'success');

    // Load the state history into replay (separate from live buffer)
    if (data.states && data.states.length > 0) {
      Replay.loadHistory(data.states, data.id, label);
    }

    // Close the modal
    Panels.closeAllModals();
  },

  /**
   * Update UI with current game state
   */
  updateUI() {
    if (!this.gameState) return;

    const state = this.gameState;

    // Update player stats and names from the viewed game state
    if (state.players) {
      state.players.forEach((player) => {
        const cities = state.cities ? state.cities.filter((c) => c.owner === player.id).length : 0;
        const units = state.units ? state.units.filter((u) => u.owner === player.id).length : 0;
        const tiles =
          state.map && state.map.tiles
            ? state.map.tiles.filter((t) => t.owner === player.id).length
            : 0;

        // Always show names from the displayed state (live or replay)
        if (player.name) {
          Panels.updatePlayerInfo(player.id, { name: player.name });
        }

        Panels.updatePlayerStats(player.id, {
          gold: player.gold,
          income: player.income,
          score: player.score,
          cities,
          units,
          tiles,
        });
      });
    }

    // Update turn info
    // Get monument owners from the displayed state
    const monuments = state.monuments || [];
    const monumentOwners = monuments.map((m) => {
      if (m.controlledBy === null) return { id: null, name: null };
      const player = state.players?.find((p) => p.id === m.controlledBy);
      return { id: m.controlledBy, name: player?.name || `Player ${m.controlledBy + 1}` };
    });

    Panels.updateTurnInfo({
      current: state.turn,
      max: state.maxTurns || state.max_turns,
      monumentOwners,
    });

    // Update build modal cities
    if (state.cities && this.teamId !== null) {
      Panels.updateBuildCities(state.cities, this.teamId);
    }

    // Update command bar gold and queue
    if (typeof ManualPlay !== 'undefined' && ManualPlay.active) {
      ManualPlay._refreshProjectedGold();
      ManualPlay._updateQueueUI();
    }
  },

  /**
   * Start turn timer
   */
  startTimer() {
    this.stopTimer();

    if (this.turnTimeout <= 0) {
      Panels.updateTimerDisplay('no-timeout');
      return;
    }

    this.timerInterval = setInterval(() => {
      // Stop if we switched away from live
      if (typeof Replay !== 'undefined' && !Replay.isViewingLive()) {
        this.stopTimer();
        Panels.updateTimerDisplay('replay');
        return;
      }

      const elapsed = Date.now() - this.turnStartTime;
      const remaining = Math.max(0, this.turnTimeout - elapsed);
      Panels.updateTimer(remaining);

      if (remaining <= 0) {
        this.stopTimer();
      }
    }, 100);
  },

  /**
   * Stop turn timer
   */
  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  },

  removeAction(index) {
    if (typeof ManualPlay !== 'undefined') ManualPlay.removeAction(index);
  },

  clearActionQueue() {
    if (typeof ManualPlay !== 'undefined') ManualPlay.clearQueue();
  },

  submitActions() {
    if (typeof ManualPlay !== 'undefined') ManualPlay.submitActions();
  },

  /**
   * Load mock game state for demo
   */
  loadMockGameState() {
    const mockState = {
      turn: 12,
      maxTurns: 200,
      gameOver: false,
      winner: null,
      players: [
        { id: 0, name: 'Cyan Empire', gold: 145, score: 320, income: 12 },
        { id: 1, name: 'White Dynasty', gold: 98, score: 280, income: 8 },
      ],
      map: {
        width: 15,
        height: 10,
        tiles: this.generateMockTiles(15, 10),
      },
      cities: [
        { x: 2, y: 2, owner: 0 },
        { x: 12, y: 7, owner: 1 },
        { x: 6, y: 4, owner: 0 },
      ],
      units: [
        { x: 3, y: 3, owner: 0, type: 'SOLDIER', hp: 2, can_move_next_turn: true },
        { x: 4, y: 2, owner: 0, type: 'ARCHER', hp: 2, can_move_next_turn: true },
        { x: 5, y: 4, owner: 0, type: 'RAIDER', hp: 1, can_move_next_turn: true },
        { x: 11, y: 6, owner: 1, type: 'SOLDIER', hp: 2, can_move_next_turn: true },
        { x: 10, y: 7, owner: 1, type: 'SOLDIER', hp: 2, can_move_next_turn: false },
        { x: 9, y: 5, owner: 1, type: 'ARCHER', hp: 1, can_move_next_turn: true },
      ],
      monuments: [{ x: 7, y: 5, controlledBy: 0 }],
    };

    this.handleGameState(mockState);
    Panels.addTerminalMessage('Loaded demo game state', 'success');
  },

  /**
   * Generate mock tiles for demo
   */
  generateMockTiles(width, height) {
    const tiles = [];
    const centerX = Math.floor(width / 2);
    const centerY = Math.floor(height / 2);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Determine terrain type
        let type = 'FIELD';

        // Water around edges
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
          type = 'WATER';
        }
        // Monument at center
        else if (x === centerX && y === centerY) {
          type = 'MONUMENT';
        }
        // Some mountains
        else if ((x === 5 && y === 3) || (x === 9 && y === 6) || (x === 4 && y === 7)) {
          type = 'MOUNTAIN';
        }

        // Determine owner
        let owner = null;
        if (type !== 'WATER' && type !== 'MOUNTAIN' && type !== 'MONUMENT') {
          // Blue territory on left
          if (x < centerX - 1) {
            owner = 0;
          }
          // Orange territory on right
          else if (x > centerX + 1) {
            owner = 1;
          }
        }

        tiles.push({ x, y, type, owner });
      }
    }

    return tiles;
  },
};

/**
 * Replay — game-list architecture with global timeline slider.
 *
 * games[] stores an array of state-arrays, one per game played this session.
 * The global slider treats all states across all games as one flat timeline.
 * Red dots on the slider mark game boundaries.
 */
const Replay = {
  games: [], // [[state, state, ...], [...], ...]
  currentGameIndex: -1, // which game is being viewed (0-based)
  history: [], // points to games[currentGameIndex]
  currentIndex: -1, // turn index within history
  isPlaying: false,
  playTimer: null,
  speed: 8,
  followLive: true,

  init() {
    this.games = [];
    this.currentGameIndex = -1;
    this.history = [];
    this.currentIndex = -1;
    this.followLive = true;
    this.pause();
    this.updateUI();
  },

  maxGames: 25,

  resetLiveBuffer() {
    // Prune oldest non-live games if at the limit
    while (this.games.length >= this.maxGames) {
      this.games.shift();
      if (this.currentGameIndex > 0) this.currentGameIndex--;
    }
    this.games.push([]);
    if (this.followLive) {
      this.currentGameIndex = this.games.length - 1;
      this.history = this.games[this.currentGameIndex];
      this.currentIndex = -1;
      this.pause();
    }
    this.updateUI();
  },

  addState(state) {
    if (!state || state.turn === undefined) return;
    if (this.games.length === 0) this.games.push([]);

    const liveGame = this.games[this.games.length - 1];
    const last = liveGame[liveGame.length - 1];
    if (last && last.turn === state.turn) return;

    liveGame.push(JSON.parse(JSON.stringify(state)));

    if (this.followLive) {
      this.currentGameIndex = this.games.length - 1;
      this.history = this.games[this.currentGameIndex];
      this.currentIndex = this.history.length - 1;
    } else if (this.isPlaying && !this.playTimer) {
      // Was waiting at global end for new states — resume playback
      this.scheduleNextFrame();
    }
    this.updateUI();
  },

  isViewingLive() {
    return this.followLive;
  },

  // --- Global timeline helpers ---

  getTotalStates() {
    let n = 0;
    for (const g of this.games) n += g.length;
    return n;
  },

  getGlobalIndex() {
    let idx = 0;
    for (let i = 0; i < this.currentGameIndex; i++) idx += this.games[i].length;
    return idx + Math.max(0, this.currentIndex);
  },

  /** Seek to a flat position across all games. */
  seekGlobal(flat) {
    flat = parseInt(flat);
    if (flat < 0) return;
    let remaining = flat;
    for (let i = 0; i < this.games.length; i++) {
      if (remaining < this.games[i].length) {
        this.pause();
        this.currentGameIndex = i;
        this.history = this.games[i];
        this.currentIndex = remaining;
        this.followLive = false;
        if (this.history[this.currentIndex]) {
          this.showState(this.history[this.currentIndex]);
        }
        this.updateUI();
        return;
      }
      remaining -= this.games[i].length;
    }
  },

  /** Returns flat indices of the last state of each game (except the last game). */
  getGameBoundaries() {
    const out = [];
    let offset = 0;
    for (let i = 0; i < this.games.length - 1; i++) {
      offset += this.games[i].length;
      if (offset > 0) out.push(offset - 1);
    }
    return out;
  },

  // --- Game navigation ---

  goToGame(num) {
    num = parseInt(num);
    if (isNaN(num) || num < 1 || num > this.games.length) return;
    this.pause();
    this.currentGameIndex = num - 1;
    this.history = this.games[this.currentGameIndex];
    this.currentIndex = 0;
    this.followLive = false;
    if (this.history.length > 0) this.showState(this.history[0]);
    this.updateUI();
  },

  prevGame() {
    if (this.currentGameIndex > 0) this.goToGame(this.currentGameIndex);
  },

  nextGame() {
    if (this.currentGameIndex < this.games.length - 1) this.goToGame(this.currentGameIndex + 2);
  },

  // --- Turn navigation (within current game) ---

  prevTurn() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.followLive = false;
      this.showState(this.history[this.currentIndex]);
      this.updatePlayButton();
      this.updateUI();
    }
  },

  nextTurn() {
    if (this.currentIndex < this.history.length - 1) {
      this.currentIndex++;
      this.followLive = false;
      this.showState(this.history[this.currentIndex]);
      this.updatePlayButton();
      this.updateUI();
    }
  },

  seekTurn(turnNum) {
    turnNum = parseInt(turnNum);
    if (isNaN(turnNum)) return;
    const idx = this.history.findIndex((s) => s.turn === turnNum);
    if (idx >= 0) {
      this.pause();
      this.currentIndex = idx;
      this.followLive = false;
      this.showState(this.history[idx]);
      this.updateUI();
    }
  },

  goToLive() {
    this.pause();
    this.followLive = true;
    if (this.games.length > 0) {
      this.currentGameIndex = this.games.length - 1;
      this.history = this.games[this.currentGameIndex];
      this.currentIndex = this.history.length > 0 ? this.history.length - 1 : -1;
      if (this.currentIndex >= 0) this.showState(this.history[this.currentIndex]);
    }
    this.updatePlayButton();
    this.updateUI();
  },

  // --- Playback ---

  togglePlay() {
    if (this.followLive) {
      // Exit live mode → pause at current position
      this.followLive = false;
      this.updatePlayButton();
      this.updateUI();
      return;
    }
    this.isPlaying ? this.pause() : this.play();
  },

  play() {
    const total = this.getTotalStates();
    if (total < 2) return;
    // If at global end, rewind to start
    if (this.getGlobalIndex() >= total - 1) {
      this.currentGameIndex = 0;
      this.history = this.games[0];
      this.currentIndex = 0;
      if (this.history.length > 0) this.showState(this.history[0]);
    }
    this.followLive = false;
    this.isPlaying = true;
    this.updatePlayButton();
    this.scheduleNextFrame();
  },

  scheduleNextFrame() {
    if (this.playTimer) clearTimeout(this.playTimer);
    if (!this.isPlaying) return;
    this.playTimer = setTimeout(() => {
      if (this.currentIndex < this.history.length - 1) {
        this.currentIndex++;
      } else if (this.currentGameIndex < this.games.length - 1) {
        this.currentGameIndex++;
        this.history = this.games[this.currentGameIndex];
        this.currentIndex = 0;
      } else {
        // At global end — stay playing, wait for new states
        // addState() will call scheduleNextFrame() when data arrives
        this.playTimer = null;
        return;
      }
      this.showState(this.history[this.currentIndex]);
      this.updateUI();
      if (this.isPlaying) this.scheduleNextFrame();
    }, 1000 / this.speed);
  },

  pause() {
    this.isPlaying = false;
    if (this.playTimer) {
      clearTimeout(this.playTimer);
      this.playTimer = null;
    }
    this.updatePlayButton();
  },

  setSpeed(speed) {
    if (speed === 'live') {
      this.goToLive();
      return;
    }
    this.speed = parseFloat(speed) || 4;
    this.followLive = false;
    this.isPlaying = true;
    this.updatePlayButton();
    this.scheduleNextFrame();
  },

  showState(state) {
    if (state) {
      App.gameState = state;
      Renderer.setGameState(state);
      if (state._events) Renderer.applyTurnEvents(state._events);
      App.updateUI();
    }
  },

  loadHistory(states, saveId, label) {
    this.pause();
    // Insert before the current live game (last entry) so live game stays last
    const insertIdx = this.games.length > 0 ? this.games.length - 1 : 0;
    const saved = states.map((s) => JSON.parse(JSON.stringify(s)));
    this.games.splice(insertIdx, 0, saved);
    this.currentGameIndex = insertIdx;
    this.history = this.games[this.currentGameIndex];
    this.currentIndex = 0;
    this.followLive = false;
    if (this.history.length > 0) this.showState(this.history[0]);
    this.updatePlayButton();
    this.updateUI();
  },

  // --- UI ---

  updateUI() {
    const gameInput = document.getElementById('game-number-input');
    const gameTotal = document.getElementById('game-total');
    const goLiveBtn = document.getElementById('btn-go-live');
    const slider = document.getElementById('global-slider');
    const dotsContainer = document.getElementById('global-slider-dots');

    // Game counter
    if (gameInput) {
      gameInput.value = this.games.length > 0 ? this.currentGameIndex + 1 : 0;
      gameInput.max = this.games.length;
    }
    if (gameTotal) gameTotal.textContent = this.games.length;
    if (goLiveBtn) goLiveBtn.classList.toggle('hidden', this.followLive);

    // Global slider
    const total = this.getTotalStates();
    if (slider) {
      slider.max = Math.max(0, total - 1);
      slider.value = total > 0 ? this.getGlobalIndex() : 0;
    }

    // Game-boundary dots
    if (dotsContainer) {
      if (total > 1) {
        const boundaries = this.getGameBoundaries();
        dotsContainer.innerHTML = boundaries
          .map((idx) => {
            const pct = (idx / (total - 1)) * 100;
            return `<span class="slider-game-dot" style="left:${pct}%"></span>`;
          })
          .join('');
      } else {
        dotsContainer.innerHTML = '';
      }
    }

    // Turn navigation in top bar
    const turnPrev = document.getElementById('turn-prev');
    const turnNext = document.getElementById('turn-next');
    const turnInput = document.getElementById('turn-input');
    const turnCurrent = document.getElementById('turn-current');

    if (this.followLive) {
      // Live mode: hide nav arrows and input, show static text
      if (turnPrev) turnPrev.classList.add('hidden');
      if (turnNext) turnNext.classList.add('hidden');
      if (turnInput) turnInput.classList.add('hidden');
      if (turnCurrent) turnCurrent.classList.remove('hidden');
    } else {
      // Replay mode: show nav arrows and editable input, hide static text
      if (turnPrev) turnPrev.classList.remove('hidden');
      if (turnNext) turnNext.classList.remove('hidden');
      if (turnInput) {
        turnInput.classList.remove('hidden');
        const state = this.history[this.currentIndex];
        if (state) turnInput.value = state.turn;
      }
      if (turnCurrent) turnCurrent.classList.add('hidden');
    }
  },

  updatePlayButton() {
    const btn = document.getElementById('btn-play');
    const label = document.getElementById('play-btn-label');
    if (!label) return;

    if (this.followLive) {
      label.textContent = '\u25B6 Live';
      if (btn) btn.classList.add('play-btn-live');
    } else {
      label.textContent = (this.isPlaying ? '\u23F8' : '\u25B6') + ' ' + this.speed + 'x';
      if (btn) btn.classList.remove('play-btn-live');
    }

    // Highlight active speed in popup
    document.querySelectorAll('.speed-option').forEach((el) => {
      if (el.classList.contains('speed-option-live')) {
        el.classList.toggle('active', this.followLive);
      } else {
        el.classList.toggle(
          'active',
          !this.followLive && parseFloat(el.textContent) === this.speed
        );
      }
    });
  },
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
  Replay.init();
});

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { App, Replay };
}
