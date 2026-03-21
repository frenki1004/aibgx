/**
 * UI Panel controls and management
 */
const Panels = {
  // Panel references
  elements: {
    player0: null,
    player1: null,
    turn: null,
    replay: null,
    manual: null,
    inspector: null,
    terminal: null,
  },

  // Modal references
  modals: {
    replays: null,
    build: null,
  },

  // State
  terminalOpen: false,
  inspectorOpen: false,
  rightPanelOpen: false,
  rightPanelMode: null, // 'manual' | 'oversight'
  selectedUnitType: null,

  /**
   * Initialize all panel references
   */
  init() {
    // Get panel elements
    this.elements.player0 = document.getElementById('panel-player0');
    this.elements.player1 = document.getElementById('panel-player1');
    this.elements.turn = document.getElementById('panel-turn');
    this.elements.replay = document.getElementById('panel-replay');
    this.elements.manual = document.getElementById('right-panel');
    this.elements.inspector = document.getElementById('panel-inspector');
    this.elements.terminal = document.getElementById('terminal');

    // Get modal elements
    this.modals.replays = document.getElementById('modal-replays');
    this.modals.build = document.getElementById('modal-build');

    // Initialize Lucide icons
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }

    // Set up event listeners
    this.setupEventListeners();

    // Set up unit card selection
    this.setupUnitCards();
  },

  /**
   * Set up event listeners for panels
   */
  setupEventListeners() {
    // Listen for tile selection events from renderer
    window.addEventListener('tile-selected', (e) => {
      this.showInspector(e.detail);
    });

    window.addEventListener('tile-deselected', () => {
      this.hideInspector();
    });

    // Close modals when clicking overlay
    Object.values(this.modals).forEach((modal) => {
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            modal.classList.add('hidden');
          }
        });
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      this.handleKeyboard(e);
    });
  },

  /**
   * Set up unit card selection in build modal
   */
  setupUnitCards() {
    const unitCards = document.querySelectorAll('.unit-card');
    unitCards.forEach((card) => {
      card.addEventListener('click', () => {
        // Remove selection from all cards
        unitCards.forEach((c) => c.classList.remove('selected'));
        // Select clicked card
        card.classList.add('selected');
        this.selectedUnitType = card.dataset.unit;
      });
    });
  },

  /**
   * Handle keyboard shortcuts
   */
  handleKeyboard(e) {
    // Escape to close modals/inspector/cancel interaction
    if (e.key === 'Escape') {
      this.closeAllModals();
      this.hideInspector();
      // Close inline build popup
      const popup = document.getElementById('inline-build-popup');
      if (popup) popup.classList.add('hidden');
      if (this.terminalOpen) {
        this.toggleTerminal();
      }
      // Cancel any interaction mode
      if (typeof ManualPlay !== 'undefined' && ManualPlay.active) {
        ManualPlay.setMode('select');
      }
    }

    // Skip shortcuts if an input is focused
    if (this.isInputFocused()) return;
    if (e.ctrlKey || e.metaKey) return;

    // T for terminal
    if (e.key === 't') {
      this.toggleTerminal();
    }

    // Space for zoom to fit
    if (e.key === ' ') {
      e.preventDefault();
      if (typeof Renderer !== 'undefined') {
        Renderer.zoomToFit();
      }
    }

    // Manual play shortcuts
    const mp = typeof ManualPlay !== 'undefined' && ManualPlay.active;

    // S for select mode
    if (e.key === 's' && mp) {
      ManualPlay.setMode('select');
    }

    // E for expand mode
    if (e.key === 'e' && mp) {
      ManualPlay.setMode('expand');
    }

    // C for build city mode
    if (e.key === 'c' && mp) {
      ManualPlay.setMode('build_city');
    }

    // B for build unit modal
    if (e.key === 'b' && mp) {
      toggleModal('modal-build');
    }

    // Enter to submit
    if (e.key === 'Enter' && mp) {
      ManualPlay.submitActions();
    }

    // Fog view modes: 1 = P0 POV, 2 = P1 POV, 3 = spectator (both vision borders)
    if (e.key === '1' && typeof Renderer !== 'undefined') {
      Renderer.setFogViewMode(0);
    }
    if (e.key === '2' && typeof Renderer !== 'undefined') {
      Renderer.setFogViewMode(1);
    }
    if (e.key === '3' && typeof Renderer !== 'undefined') {
      Renderer.setFogViewMode('spectator');
    }
  },

  /**
   * Check if an input element is focused
   */
  isInputFocused() {
    const active = document.activeElement;
    return (
      active &&
      (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')
    );
  },

  /**
   * Toggle panel minimized state
   */
  togglePanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    const isMinimized = panel.getAttribute('data-minimized') === 'true';
    panel.setAttribute('data-minimized', !isMinimized);

    // Update icon
    const icon = panel.querySelector('[data-lucide]');
    if (icon && typeof lucide !== 'undefined') {
      icon.setAttribute('data-lucide', isMinimized ? 'minus' : 'plus');
      lucide.createIcons();
    }
  },

  /**
   * Toggle modal visibility
   */
  toggleModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    const isHidden = modal.classList.contains('hidden');

    // Close all modals first
    this.closeAllModals();

    // Toggle this modal
    if (isHidden) {
      modal.classList.remove('hidden');
    }
  },

  /**
   * Close all modals
   */
  closeAllModals() {
    Object.values(this.modals).forEach((modal) => {
      if (modal) {
        modal.classList.add('hidden');
      }
    });
  },

  /**
   * Toggle terminal visibility
   */
  toggleTerminal() {
    this.terminalOpen = !this.terminalOpen;

    if (this.elements.terminal) {
      this.elements.terminal.classList.toggle('hidden', !this.terminalOpen);
    }

    // Update button state
    const btn = document.getElementById('btn-terminal');
    if (btn) {
      btn.classList.toggle('active', this.terminalOpen);
    }
  },

  /**
   * Show inspector panel with tile/unit details
   */
  showInspector(details) {
    const inspector = this.elements.inspector;
    if (!inspector) return;

    // Update position
    document.getElementById('inspect-pos').textContent = `(${details.x}, ${details.y})`;

    // Update terrain
    const terrain = details.tile ? details.tile.type : 'Unknown';
    document.getElementById('inspect-terrain').textContent =
      terrain.charAt(0).toUpperCase() + terrain.slice(1).toLowerCase();

    // Update owner
    const ownerEl = document.getElementById('inspect-owner');
    if (details.tile && details.tile.owner !== null) {
      ownerEl.textContent = details.tile.owner === 0 ? 'Cyan' : 'White';
      ownerEl.className = details.tile.owner === 0 ? 'text-team0' : 'text-team1';
    } else {
      ownerEl.textContent = 'Neutral';
      ownerEl.className = '';
    }

    // Update income (spec: Field=0.5 GOLD/turn, Cities=5 GOLD/turn)
    const incomeMap = {
      FIELD: '+0.5/turn',
      MOUNTAIN: 'None',
      WATER: 'None',
      MONUMENT: 'Special',
    };
    document.getElementById('inspect-income').textContent = incomeMap[details.tile?.type] || 'None';

    // Update unit section
    const unitSection = document.getElementById('inspect-unit');
    if (details.unit) {
      unitSection.style.display = 'block';
      document.getElementById('inspect-unit-type').textContent =
        details.unit.type.charAt(0).toUpperCase() + details.unit.type.slice(1).toLowerCase();

      const maxHp = { SOLDIER: 2, ARCHER: 2, RAIDER: 1 }[details.unit.type] || 2;
      const hpPercent = (details.unit.hp / maxHp) * 100;
      document.getElementById('inspect-unit-hp-bar').style.width = hpPercent + '%';
      document.getElementById('inspect-unit-hp').textContent = `${details.unit.hp}/${maxHp}`;

      // Update HP bar color
      const hpBar = document.getElementById('inspect-unit-hp-bar');
      hpBar.classList.remove('low', 'critical');
      if (hpPercent <= 33) {
        hpBar.classList.add('critical');
      } else if (hpPercent <= 66) {
        hpBar.classList.add('low');
      }

      // Handle both canMove (legacy) and can_move_next_turn (spec)
      const canMove = details.unit.can_move_next_turn ?? details.unit.canMove;
      document.getElementById('inspect-unit-move').textContent = canMove !== false ? 'Yes' : 'No';
    } else {
      unitSection.style.display = 'none';
    }

    // Show inspector with animation
    inspector.classList.remove('hidden');
    inspector.classList.add('visible');
    this.inspectorOpen = true;
  },

  /**
   * Hide inspector panel
   */
  hideInspector() {
    const inspector = this.elements.inspector;
    if (!inspector) return;

    inspector.classList.remove('visible');
    inspector.classList.add('hidden');
    this.inspectorOpen = false;
  },

  /**
   * Close inspector (called from button)
   */
  closeInspector() {
    this.hideInspector();

    // Deselect tile in renderer
    if (typeof Renderer !== 'undefined') {
      Renderer.selectedTile = null;
      Renderer.selectedUnit = null;
    }
  },

  /**
   * Update player stats panel
   */
  updatePlayerStats(playerId, stats) {
    const prefix = `p${playerId}`;

    if (stats.gold !== undefined) {
      const el = document.getElementById(`${prefix}-gold`);
      if (el) el.textContent = Number(stats.gold).toFixed(1);
    }

    if (stats.income !== undefined) {
      const el = document.getElementById(`${prefix}-income`);
      if (el) el.textContent = `+${Number(stats.income).toFixed(1)}`;
    }

    if (stats.score !== undefined) {
      const el = document.getElementById(`${prefix}-score`);
      if (el) el.textContent = stats.score;
    }

    if (stats.cities !== undefined) {
      const el = document.getElementById(`${prefix}-cities`);
      if (el) el.textContent = stats.cities;
    }

    if (stats.units !== undefined) {
      const el = document.getElementById(`${prefix}-units`);
      if (el) el.textContent = stats.units;
    }

    if (stats.tiles !== undefined) {
      const el = document.getElementById(`${prefix}-tiles`);
      if (el) el.textContent = stats.tiles;
    }
  },

  /**
   * Update turn info panel
   */
  updateTurnInfo(turnInfo) {
    if (turnInfo.current !== undefined) {
      const el = document.getElementById('turn-current');
      if (el) el.textContent = turnInfo.current;
    }

    if (turnInfo.max !== undefined) {
      const el = document.getElementById('turn-max');
      if (el) el.textContent = turnInfo.max;
    }

    if (turnInfo.monumentOwners !== undefined) {
      const el = document.getElementById('monument-owner');
      if (el) {
        const owners = turnInfo.monumentOwners;
        if (owners.length === 0) {
          el.textContent = 'None';
          el.className = 'text-slate-500';
        } else if (owners.length === 1) {
          // Single monument — same as before
          if (owners[0].id === null) {
            el.textContent = 'Contested';
            el.className = 'text-slate-500';
          } else {
            el.textContent = owners[0].name || `Player ${owners[0].id + 1}`;
            el.className =
              owners[0].id === 0 ? 'text-team0 font-semibold' : 'text-team1 font-semibold';
          }
        } else {
          // Multiple monuments — show count per controller
          const p0 = owners.filter((o) => o.id === 0).length;
          const p1 = owners.filter((o) => o.id === 1).length;
          const contested = owners.filter((o) => o.id === null).length;
          const parts = [];
          if (p0 > 0) parts.push(`${owners.find((o) => o.id === 0).name}: ${p0}`);
          if (p1 > 0) parts.push(`${owners.find((o) => o.id === 1).name}: ${p1}`);
          if (contested > 0) parts.push(`Contested: ${contested}`);
          el.textContent = parts.join(' | ');
          el.className =
            p0 > p1
              ? 'text-team0 font-semibold'
              : p1 > p0
                ? 'text-team1 font-semibold'
                : 'text-slate-500';
        }
      }
    }
  },

  /**
   * Update timer display to a special state (no-timeout, paused, replay, reset)
   */
  updateTimerDisplay(mode) {
    const el = document.getElementById('timer');
    if (!el) return;

    el.classList.remove('timer-warning', 'timer-critical', 'timer-paused', 'timer-no-timeout');

    switch (mode) {
      case 'no-timeout':
        el.textContent = '\u221E';
        el.classList.add('timer-no-timeout');
        break;
      case 'paused':
        el.textContent = 'PAUSED';
        el.classList.add('timer-paused');
        break;
      case 'replay':
      case 'reset':
      case 'stopped':
        el.textContent = '--:--';
        break;
    }
  },

  /**
   * Update timer display
   */
  updateTimer(timeMs) {
    const el = document.getElementById('timer');
    if (!el) return;

    const totalSeconds = Math.ceil(timeMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    el.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    // Add warning/critical classes
    el.classList.remove('timer-warning', 'timer-critical');
    if (totalSeconds <= 5) {
      el.classList.add('timer-critical');
    } else if (totalSeconds <= 10) {
      el.classList.add('timer-warning');
    }
  },

  /**
   * Update connection status
   */
  updateConnectionStatus(status) {
    // status can be: 'connected', 'connecting', 'disconnected', 'reconnecting'
    const connected = status === 'connected';
    const mainDot = document.getElementById('connection-status');
    const statusText = document.getElementById('connection-text');

    if (mainDot) {
      mainDot.classList.toggle('connected', connected);
      mainDot.classList.toggle('connecting', status === 'connecting' || status === 'reconnecting');
    }

    if (statusText) {
      const textMap = {
        connected: 'Live',
        connecting: 'Connecting...',
        reconnecting: 'Reconnecting...',
        disconnected: 'Disconnected',
      };
      statusText.textContent = textMap[status] || 'Disconnected';
    }
  },

  /**
   * Update player display name (in player panel header)
   */
  updatePlayerInfo(playerId, info) {
    const nameEl = document.getElementById(`p${playerId}-name`);
    if (nameEl && info.name !== undefined) {
      nameEl.textContent = info.name || 'Waiting...';
    }
  },

  /**
   * Update player connection dot (in server panel)
   */
  updatePlayerConnection(playerId, connected) {
    const dotEl = document.getElementById(`p${playerId}-connection-dot`);
    if (dotEl) {
      dotEl.classList.toggle('connected', connected);
    }
  },

  // updateQueuedCount removed — gameplay panel handles queue display now

  /**
   * Add message to terminal
   */
  addTerminalMessage(message, type = 'info') {
    const content = document.getElementById('terminal-content');
    if (!content) return;

    const colorMap = {
      info: 'text-slate-400',
      success: 'text-green-500',
      warning: 'text-yellow-500',
      error: 'text-red-500',
      action: 'text-blue-500',
    };

    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const div = document.createElement('div');
    div.className = colorMap[type] || 'text-slate-400';
    div.textContent = `[${timestamp}] ${message}`;

    content.appendChild(div);
    content.scrollTop = content.scrollHeight;

    // Limit terminal history
    while (content.children.length > 100) {
      content.removeChild(content.firstChild);
    }
  },

  /**
   * Update build modal city dropdown
   */
  updateBuildCities(cities, teamId) {
    const select = document.getElementById('build-city');
    if (!select) return;

    select.innerHTML = '';
    cities
      .filter((c) => c.owner === teamId)
      .forEach((city, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent =
          index === 0 ? `Capital (${city.x}, ${city.y})` : `City (${city.x}, ${city.y})`;
        select.appendChild(option);
      });
  },

  /**
   * Update the replays modal with saved games
   */
  updateReplaysModal(saves) {
    const container = document.getElementById('replays-list');
    if (!container) return;

    if (saves.length === 0) {
      container.innerHTML = '<div class="text-slate-400 text-sm italic">No saved games yet</div>';
      return;
    }

    // Sort newest first
    saves.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

    container.innerHTML = saves
      .map((save) => {
        const p0 = save.players?.[0]?.name || '?';
        const p1 = save.players?.[1]?.name || '?';
        const winnerText =
          save.winner === null ? 'Tie' : save.winner === 0 ? `${p0} won` : `${p1} won`;
        const date = save.timestamp ? new Date(save.timestamp).toLocaleString() : 'Unknown date';
        return `
          <div class="replay-item cursor-pointer" onclick="App.loadSavedGame('${save.id}')">
            <div>
              <div class="flex items-center gap-2">
                <i data-lucide="file-video" class="w-4 h-4"></i>
                <span class="font-medium">${p0} vs ${p1}</span>
              </div>
              <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">${date} &middot; ${save.mode || '?'} &middot; Turn ${save.finalTurn || '?'}/${save.maxTurns || '?'}</div>
            </div>
            <span class="text-xs text-slate-500 dark:text-slate-400">${winnerText}</span>
          </div>
        `;
      })
      .join('');

    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  },

  /**
   * Open right panel with specified mode
   */
  openRightPanel(mode) {
    const panel = this.elements.manual;
    const manualContent = document.getElementById('panel-manual-content');
    const oversightContent = document.getElementById('panel-oversight-content');

    // Show correct content pane
    if (manualContent) manualContent.classList.toggle('hidden', mode !== 'manual');
    if (oversightContent) oversightContent.classList.toggle('hidden', mode !== 'oversight');

    // Open drawer
    if (panel) panel.classList.add('open');
    this.rightPanelOpen = true;
    this.rightPanelMode = mode;
  },

  /**
   * Close right panel
   */
  closeRightPanel() {
    const panel = this.elements.manual;
    if (panel) panel.classList.remove('open');
    this.rightPanelOpen = false;
    this.rightPanelMode = null;
  },

  /**
   * Toggle manual play panel (backward compat)
   */
  toggleManualPanel() {
    if (this.rightPanelOpen && this.rightPanelMode === 'manual') {
      this.closeRightPanel();
    } else {
      this.openRightPanel('manual');
    }
  },

  /**
   * Show manual play connected state
   */
  showManualConnected(teamId) {
    const connectSection = document.getElementById('manual-connect');
    const actionsSection = document.getElementById('manual-actions');
    const teamName = document.getElementById('manual-team-name');

    if (connectSection) connectSection.classList.add('hidden');
    if (actionsSection) actionsSection.classList.remove('hidden');

    if (teamName) {
      teamName.textContent = teamId === 0 ? 'Cyan' : 'White';
      teamName.className = teamId === 0 ? 'font-semibold text-team0' : 'font-semibold text-team1';
    }

    // Hide oversight tab, highlight manual tab
    const tabOversight = document.getElementById('tab-oversight');
    const tabManual = document.getElementById('tab-manual');
    if (tabOversight) tabOversight.classList.add('hidden');
    if (tabManual) tabManual.classList.add('active');

    // Open the right panel and show gameplay panel on the left
    this.openRightPanel('manual');
    this.showGameplayPanel(teamId);
  },

  /**
   * Show manual play disconnected state
   */
  showManualDisconnected() {
    const connectSection = document.getElementById('manual-connect');
    const actionsSection = document.getElementById('manual-actions');

    if (connectSection) connectSection.classList.remove('hidden');
    if (actionsSection) actionsSection.classList.add('hidden');

    // Restore oversight tab, remove manual tab highlight
    const tabOversight = document.getElementById('tab-oversight');
    const tabManual = document.getElementById('tab-manual');
    if (tabOversight) tabOversight.classList.remove('hidden');
    if (tabManual) tabManual.classList.remove('active');

    // Hide gameplay panel and clear pin state on disconnect
    this.unpinGameplayPanel();
    this.hideGameplayPanel();
  },

  // updateActionQueue removed — gameplay panel handles queue display now

  /**
   * Format action details for display
   */
  formatActionDetails(action) {
    switch (action.action) {
      case 'MOVE':
        return `(${action.from_x},${action.from_y}) → (${action.to_x},${action.to_y})`;
      case 'BUILD_UNIT':
        return `${action.unit_type} at (${action.city_x},${action.city_y})`;
      case 'BUILD_CITY':
        return `at (${action.x},${action.y})`;
      case 'EXPAND_TERRITORY':
        return `to (${action.x},${action.y})`;
      default:
        return '';
    }
  },

  // --- Gameplay Panel (Left Side) ---

  showGameplayPanel(teamId) {
    const panel = document.getElementById('panel-gameplay');
    if (panel) panel.classList.remove('hidden');

    if (typeof lucide !== 'undefined') lucide.createIcons();

    // Set team name (after lucide so it doesn't get overwritten)
    const teamName = document.getElementById('gp-team-name');
    if (teamName) {
      teamName.textContent = teamId === 0 ? 'Cyan' : 'White';
      teamName.className =
        teamId === 0 ? 'font-semibold text-xs text-team0' : 'font-semibold text-xs text-team1';
    }

    // Set team color on panel and indicator strip
    const teamColor = teamId === 0 ? 'var(--team-0)' : 'var(--team-1)';
    if (panel) {
      panel.style.setProperty('--active-team-color', teamColor);
    }
    const trigger = document.getElementById('gameplay-hover-trigger');
    if (trigger) {
      trigger.style.setProperty('--indicator-color', teamColor);
    }
  },

  hideGameplayPanel() {
    const panel = document.getElementById('panel-gameplay');
    if (panel) {
      panel.classList.add('hidden');
      // Don't remove 'pinned' here — preserve pin state across turns.
      // Only unpinGameplayPanel() or full disconnect should clear it.
    }
    // Also hide inline build popup
    const popup = document.getElementById('inline-build-popup');
    if (popup) popup.classList.add('hidden');
  },

  pinGameplayPanel() {
    const panel = document.getElementById('panel-gameplay');
    if (panel) panel.classList.add('pinned');
  },

  unpinGameplayPanel() {
    const panel = document.getElementById('panel-gameplay');
    if (panel) panel.classList.remove('pinned');
  },

  updateGameplayMode(mode) {
    const modes = ['select', 'expand', 'build_city'];
    const ids = { select: 'gp-select', expand: 'gp-expand', build_city: 'gp-city' };
    for (const m of modes) {
      const btn = document.getElementById(ids[m]);
      if (btn) btn.classList.toggle('active', m === mode);
    }
  },

  updateGameplayGold(gold) {
    const el = document.getElementById('gp-gold');
    if (el) el.textContent = Math.floor(gold);
  },

  updateGameplayActionCount(count) {
    const el = document.getElementById('gp-action-count');
    if (el) el.textContent = `${count} action${count !== 1 ? 's' : ''}`;
  },

  updateGameplayCountdown(remainingMs) {
    const el = document.getElementById('gp-countdown');
    if (!el) return;
    if (remainingMs === null || remainingMs === undefined) {
      el.textContent = '';
      el.classList.remove('timer-warning', 'timer-critical');
      return;
    }
    const sec = Math.ceil(remainingMs / 1000);
    el.textContent = `${sec}s`;
    el.classList.remove('timer-warning', 'timer-critical');
    if (sec <= 3) el.classList.add('timer-critical');
    else if (sec <= 5) el.classList.add('timer-warning');
  },

  updateGameplayQueue(actions) {
    // Update count
    this.updateGameplayActionCount(actions.length);

    // Update queue list
    const list = document.getElementById('gp-queue-list');
    if (!list) return;

    if (actions.length === 0) {
      list.innerHTML = '<div class="text-slate-400 italic text-xs">No actions queued</div>';
    } else {
      list.innerHTML = actions
        .map(
          (action, i) => `
        <div class="action-queue-item">
          <span class="action-type">${action.action}</span>
          <span class="action-details text-slate-500">${this.formatActionDetails(action)}</span>
          <span class="action-remove" onclick="if(typeof ManualPlay!=='undefined') ManualPlay.removeAction(${i})">
            <i data-lucide="x" class="w-3 h-3"></i>
          </span>
        </div>
      `
        )
        .join('');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  },

  // --- Oversight Controls in Side Panel ---

  showOversightConnected() {
    const oversightConnect = document.getElementById('oversight-connect');
    const oversightControls = document.getElementById('oversight-controls');

    if (oversightConnect) oversightConnect.classList.add('hidden');
    if (oversightControls) oversightControls.classList.remove('hidden');

    // Hide manual tab, highlight oversight tab
    const tabManual = document.getElementById('tab-manual');
    const tabOversight = document.getElementById('tab-oversight');
    if (tabManual) tabManual.classList.add('hidden');
    if (tabOversight) tabOversight.classList.add('active');

    // Open panel in oversight mode
    this.openRightPanel('oversight');

    if (typeof lucide !== 'undefined') lucide.createIcons();
  },

  showOversightDisconnected() {
    const oversightConnect = document.getElementById('oversight-connect');
    const oversightControls = document.getElementById('oversight-controls');

    if (oversightConnect) oversightConnect.classList.remove('hidden');
    if (oversightControls) oversightControls.classList.add('hidden');

    // Restore manual tab, remove oversight tab highlight
    const tabManual = document.getElementById('tab-manual');
    const tabOversight = document.getElementById('tab-oversight');
    if (tabManual) tabManual.classList.remove('hidden');
    if (tabOversight) tabOversight.classList.remove('active');
  },

  updateOversightTeam(teamId) {
    const btn0 = document.getElementById('oversight-team-0');
    const btn1 = document.getElementById('oversight-team-1');
    if (btn0) btn0.classList.toggle('oversight-team-active', teamId === 0);
    if (btn1) btn1.classList.toggle('oversight-team-active', teamId === 1);
  },

  updateOversightCountdown(ms) {
    const el = document.getElementById('oversight-countdown');
    if (!el) return;
    if (ms === null || ms === undefined) {
      el.textContent = '';
    } else {
      el.textContent = (ms / 1000).toFixed(1) + 's';
    }
  },

  updateOversightPause(paused) {
    const label = document.getElementById('oversight-pause-label');
    if (label) label.textContent = paused ? 'Resume' : 'Pause';
  },

  // --- Inline Build Popup ---

  showInlineBuildPopup(city) {
    if (typeof ManualPlay !== 'undefined') {
      ManualPlay._pendingBuildCity = city;
    }

    const popup = document.getElementById('inline-build-popup');
    if (!popup) return;

    // Position near the city on screen
    if (typeof Isometric !== 'undefined') {
      const canvas = document.getElementById('game-canvas');
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const screen = Isometric.gridToScreen(city.x, city.y);
        popup.style.left = rect.left + screen.x - 90 + 'px';
        popup.style.top = rect.top + screen.y - 70 + 'px';
      }
    }

    popup.classList.remove('hidden');

    // Close on outside click (one-time listener)
    const closeHandler = (e) => {
      if (!popup.contains(e.target)) {
        popup.classList.add('hidden');
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeHandler), 10);
  },
};

// Global functions for onclick handlers in HTML
function togglePanel(panelId) {
  Panels.togglePanel(panelId);
}

function toggleModal(modalId) {
  Panels.toggleModal(modalId);
}

function toggleTerminal() {
  Panels.toggleTerminal();
}

function closeInspector() {
  Panels.closeInspector();
}

function toggleManualPanel() {
  Panels.toggleManualPanel();
}

function toggleServerSettings() {
  const el = document.getElementById('server-settings');
  if (!el) return;
  const wasHidden = el.classList.contains('hidden');
  el.classList.toggle('hidden');

  // Flip chevron
  const chevron = document.getElementById('settings-chevron');
  if (chevron) {
    chevron.setAttribute('data-lucide', wasHidden ? 'chevron-up' : 'chevron-down');
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  // Fetch latest settings from server when opening
  if (wasHidden && typeof App !== 'undefined') {
    App.requestStatus();
  }
}

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Panels;
}
