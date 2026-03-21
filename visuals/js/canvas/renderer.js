/**
 * Main canvas renderer for the game
 */
const Renderer = {
  canvas: null,
  ctx: null,
  animationId: null,
  lastTime: 0,

  // State references
  gameState: null,
  selectedTile: null,
  hoveredTile: null,
  selectedUnit: null,

  // Spatial index — O(1) lookups
  _tileGrid: null, // _tileGrid[y][x] = tile
  _unitGrid: null, // _unitGrid[`x,y`] = unit
  _cityGrid: null, // _cityGrid[`x,y`] = city
  _capitalCache: null, // Set of "owner" ids whose first city has been found

  // Fog of war vision sets
  _visionSet: null, // Set<"x,y"> — player's own vision
  _vision0Set: null, // Set<"x,y"> — P0 vision (spectator mode)
  _vision1Set: null, // Set<"x,y"> — P1 vision (spectator mode)

  // Tile layer cache — offscreen canvas redrawn only on state/zoom change
  _tileCacheCanvas: null,
  _tileCacheZoom: -1,
  _tileCacheVersion: 0,
  _tileCacheMinX: 0,
  _tileCacheMinY: 0,
  _tileCacheW: 0,
  _tileCacheH: 0,
  _stateVersion: 0,

  // Damage effects (blood drops)
  _damageEffects: [],

  // Render settings
  showGrid: true,
  showZoC: false,

  // Fog view mode: null = off, 0 = P0 POV, 1 = P1 POV, 'spectator' = omniscient + both borders
  fogViewMode: null,

  // Interaction state
  isPanning: false,
  isLeftDown: false,
  lastDragTile: null, // tracks last tile during drag-expand
  lastMousePos: { x: 0, y: 0 },
  lastClickTime: 0,
  lastClickPos: { x: -1, y: -1 },
  doubleClickDelay: 300, // ms

  /**
   * Initialize the renderer
   * @param {HTMLCanvasElement} canvas - The canvas element
   */
  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Set up high DPI canvas
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());

    // Set up mouse/touch events
    this.setupInputHandlers();

    // Start render loop
    this.startRenderLoop();
  },

  /**
   * Resize canvas for high DPI displays
   */
  resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    // Set canvas size (this resets the context transform)
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;

    // Reset and apply DPI scale
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);

    // Center camera on map center if we have a game state
    if (this.gameState && this.gameState.map) {
      this.centerCamera();
    }
  },

  /**
   * Center camera on the map
   */
  centerCamera() {
    if (!this.gameState || !this.gameState.map) return;

    const rect = this.canvas.getBoundingClientRect();
    const mapWidth = this.gameState.map.width;
    const mapHeight = this.gameState.map.height;

    // Center on map center
    Isometric.offsetX = rect.width / 2;
    Isometric.offsetY = rect.height / 2 - ((mapWidth + mapHeight) * Isometric.tileHeight) / 4;
  },

  /**
   * Set up mouse and touch input handlers
   */
  setupInputHandlers() {
    const canvas = this.canvas;

    // Mouse events
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
    canvas.addEventListener('mouseleave', () => this.onMouseLeave());
    canvas.addEventListener('wheel', (e) => this.onWheel(e));

    // Touch events
    canvas.addEventListener('touchstart', (e) => this.onTouchStart(e));
    canvas.addEventListener('touchmove', (e) => this.onTouchMove(e));
    canvas.addEventListener('touchend', (e) => this.onTouchEnd(e));

    // Context menu (right click) - prevent default
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  },

  /**
   * Get mouse position relative to canvas
   */
  getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  },

  /**
   * Mouse down handler
   */
  onMouseDown(e) {
    const pos = this.getMousePos(e);

    if (e.button === 2 || e.button === 1) {
      // Right click or middle mouse = pan
      this.isPanning = true;
      this.lastMousePos = pos;
      this.canvas.style.cursor = 'grabbing';
    } else if (e.button === 0) {
      // Left click = select tile (store shift state for multi-select)
      this.pendingClickShift = e.shiftKey;
      this.isLeftDown = true;
      const gridPos = Isometric.getGridCell(pos.x, pos.y);
      this.lastDragTile = `${gridPos.x},${gridPos.y}`;
      this.handleTileClick(gridPos.x, gridPos.y);
    }
  },

  /**
   * Mouse move handler
   */
  onMouseMove(e) {
    const pos = this.getMousePos(e);

    if (this.isPanning) {
      const dx = pos.x - this.lastMousePos.x;
      const dy = pos.y - this.lastMousePos.y;
      Isometric.pan(dx, dy);
      this.lastMousePos = pos;
    } else {
      // Update hovered tile
      const gridPos = Isometric.getGridCell(pos.x, pos.y);
      if (this.isValidTile(gridPos.x, gridPos.y)) {
        this.hoveredTile = gridPos;
        this.canvas.style.cursor = 'pointer';

        // Drag-expand: if left button held in expand mode, expand tiles as we drag
        if (
          this.isLeftDown &&
          typeof ManualPlay !== 'undefined' &&
          ManualPlay.active &&
          ManualPlay.mode === 'expand'
        ) {
          const tileKey = `${gridPos.x},${gridPos.y}`;
          if (tileKey !== this.lastDragTile) {
            this.lastDragTile = tileKey;
            ManualPlay.queueExpand(gridPos.x, gridPos.y);
          }
        }
      } else {
        this.hoveredTile = null;
        this.canvas.style.cursor = 'default';
      }
    }
  },

  /**
   * Mouse up handler
   */
  onMouseUp(e) {
    this.isPanning = false;
    this.isLeftDown = false;
    this.lastDragTile = null;
    this.canvas.style.cursor = 'default';
  },

  /**
   * Mouse leave handler
   */
  onMouseLeave() {
    this.isPanning = false;
    this.isLeftDown = false;
    this.lastDragTile = null;
    this.hoveredTile = null;
    this.canvas.style.cursor = 'default';
  },

  /**
   * Mouse wheel handler (zoom)
   */
  onWheel(e) {
    e.preventDefault();
    const pos = this.getMousePos(e);
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    Isometric.setZoom(Isometric.zoom * zoomFactor, pos.x, pos.y);
  },

  /**
   * Touch start handler
   */
  onTouchStart(e) {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const rect = this.canvas.getBoundingClientRect();
      this.lastMousePos = {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      };
    }
  },

  /**
   * Touch move handler
   */
  onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const rect = this.canvas.getBoundingClientRect();
      const pos = {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      };

      const dx = pos.x - this.lastMousePos.x;
      const dy = pos.y - this.lastMousePos.y;
      Isometric.pan(dx, dy);
      this.lastMousePos = pos;
    }
  },

  /**
   * Touch end handler
   */
  onTouchEnd(e) {
    if (e.changedTouches.length === 1 && !this.isPanning) {
      const touch = e.changedTouches[0];
      const rect = this.canvas.getBoundingClientRect();
      const pos = {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      };
      const gridPos = Isometric.getGridCell(pos.x, pos.y);
      this.handleTileClick(gridPos.x, gridPos.y);
    }
  },

  /**
   * Handle tile click
   */
  handleTileClick(x, y) {
    if (!this.isValidTile(x, y)) return;

    const now = Date.now();
    const tile = this.getTileAt(x, y);
    const unit = this.getUnitAt(x, y);
    const city = this.getCityAt(x, y);

    // Check for double-click
    const isDoubleClick =
      now - this.lastClickTime < this.doubleClickDelay &&
      this.lastClickPos.x === x &&
      this.lastClickPos.y === y;

    this.lastClickTime = now;
    this.lastClickPos = { x, y };

    if (isDoubleClick) {
      // Double-click - expand territory
      if (typeof App !== 'undefined') {
        App.handleTileDoubleClick(x, y, tile);
      }
      return;
    }

    // Single click
    this.selectedTile = { x, y };

    // Check if there's a unit at this tile
    if (unit) {
      this.selectedUnit = unit;
    } else {
      this.selectedUnit = null;
    }

    // Call App's handler for manual play (pass shift state for multi-select)
    if (typeof App !== 'undefined') {
      App.handleTileClick(x, y, tile, unit, city, this.pendingClickShift || false);
    }

    // Inspector panel disabled — was too intrusive
  },

  /**
   * Check if coordinates are within map bounds
   */
  isValidTile(x, y) {
    if (!this.gameState || !this.gameState.map) return false;
    return x >= 0 && x < this.gameState.map.width && y >= 0 && y < this.gameState.map.height;
  },

  /**
   * Get tile at position — O(1) grid lookup
   */
  getTileAt(x, y) {
    if (!this._tileGrid) return null;
    const row = this._tileGrid[y];
    return row ? row[x] || null : null;
  },

  /**
   * Get unit at position — O(1) hash lookup
   */
  getUnitAt(x, y) {
    return this._unitGrid ? this._unitGrid[`${x},${y}`] || null : null;
  },

  /**
   * Get city at position — O(1) hash lookup
   */
  getCityAt(x, y) {
    return this._cityGrid ? this._cityGrid[`${x},${y}`] || null : null;
  },

  /**
   * Update game state
   */
  setGameState(state) {
    const firstLoad = !this.gameState;
    this.gameState = state;
    console.log(
      '[Renderer] setGameState called, state:',
      state ? `Turn ${state.turn}, ${state.map?.tiles?.length} tiles` : 'null'
    );

    // Rebuild spatial indexes for O(1) lookups
    this._stateVersion++;
    this._buildSpatialIndexes(state);

    if (firstLoad && state) {
      console.log('[Renderer] First load, centering camera');
      this.centerCamera();
    }
  },

  /**
   * Spawn blood effects from turn events (COMBAT and DEATH).
   */
  applyTurnEvents(events) {
    if (!events) return;
    for (const evt of events) {
      if (evt.type === 'COMBAT' && evt.data) {
        const t = evt.data.target;
        let x = t.x,
          y = t.y;
        // Archer shots fire before movement (phase 2). The target may have
        // moved in phase 3, so look up its final position in the current state.
        if (evt.data.phase === 'archer' && !evt.data.isKill && this.gameState) {
          const final = this.gameState.units.find(
            (u) =>
              u.owner === t.owner &&
              u.type === t.type &&
              Math.abs(u.x - t.x) <= 2 &&
              Math.abs(u.y - t.y) <= 2
          );
          if (final) {
            x = final.x;
            y = final.y;
          }
        }
        this._spawnBloodEffect(x, y, evt.data.damage);
      } else if (evt.type === 'DEATH' && evt.data) {
        this._spawnSkullEffect(evt.data.unit.x, evt.data.unit.y);
      }
    }
  },

  /**
   * Spawn blood drop particles at a grid position
   */
  _spawnBloodEffect(gx, gy, hpLost) {
    const now = Date.now();
    const count = Math.min(hpLost * 5, 12); // more drops for more damage
    for (let i = 0; i < count; i++) {
      this._damageEffects.push({
        gx,
        gy,
        // Random offset within tile
        ox: (Math.random() - 0.5) * 16,
        oy: (Math.random() - 0.5) * 8,
        // Velocity (pixels per second) — float upward
        vx: (Math.random() - 0.5) * 20,
        vy: -(20 + Math.random() * 30),
        // Gravity
        gravity: 60,
        spawn: now,
        life: 500 + Math.random() * 300, // ms
        size: 2 + Math.floor(Math.random() * 2), // 2-3 px
      });
    }
  },

  /**
   * Spawn a skull icon that floats up and fades
   */
  _spawnSkullEffect(gx, gy) {
    this._damageEffects.push({
      gx,
      gy,
      ox: 0,
      oy: 0,
      vx: 0,
      vy: -18,
      gravity: 0,
      spawn: Date.now(),
      life: 1200,
      size: 0,
      skull: true,
    });
  },

  /**
   * Draw a tiny pixel-art skull at the given screen position and size
   */
  _drawSkull(ctx, cx, cy, s) {
    // Cranium (5x4 top)
    ctx.fillRect(cx - 2 * s, cy - 4 * s, 5 * s, 4 * s);
    // Jaw (3x2 bottom)
    ctx.fillRect(cx - 1 * s, cy, 3 * s, 2 * s);
    // Eye holes (dark)
    ctx.fillStyle = '#000000';
    ctx.fillRect(cx - 1 * s, cy - 3 * s, s, s);
    ctx.fillRect(cx + 1 * s, cy - 3 * s, s, s);
    // Nose
    ctx.fillRect(cx, cy - 1 * s, s, s);
  },

  /**
   * Update and draw blood drop effects
   */
  _drawDamageEffects(ctx, time) {
    const now = Date.now();
    const dt = 1 / 60; // approximate per-frame dt

    for (let i = this._damageEffects.length - 1; i >= 0; i--) {
      const e = this._damageEffects[i];
      const age = now - e.spawn;
      if (age > e.life) {
        this._damageEffects.splice(i, 1);
        continue;
      }

      // Update position
      e.vy += e.gravity * dt;
      e.ox += e.vx * dt;
      e.oy += e.vy * dt;

      // Screen position
      const screen = Isometric.gridToScreen(e.gx, e.gy);
      const s = Isometric.zoom;
      const px = screen.x + e.ox * s;
      const py = screen.y + e.oy * s - 8 * s; // offset up from tile center

      // Fade out in last 30%
      const lifeFrac = age / e.life;
      const alpha = lifeFrac > 0.7 ? 1 - (lifeFrac - 0.7) / 0.3 : 1;

      ctx.globalAlpha = alpha;
      if (e.skull) {
        // Floating skull icon
        const ps = Math.ceil(s * 1.2); // pixel scale
        ctx.fillStyle = '#dddddd';
        this._drawSkull(ctx, Math.round(px), Math.round(py), ps);
      } else {
        // Blood drop particle
        const sz = e.size * s;
        ctx.fillStyle = '#cc1111';
        ctx.fillRect(
          Math.round(px - sz / 2),
          Math.round(py - sz / 2),
          Math.ceil(sz),
          Math.ceil(sz)
        );
        if (e.size > 2) {
          ctx.fillStyle = '#880000';
          const core = Math.ceil(s);
          ctx.fillRect(Math.round(px - core / 2), Math.round(py - core / 2), core, core);
        }
      }
      ctx.globalAlpha = 1;
    }
  },

  /**
   * Build spatial lookup grids from game state — called once per state update, not per frame
   */
  _buildSpatialIndexes(state) {
    if (!state || !state.map) {
      this._tileGrid = null;
      this._unitGrid = null;
      this._cityGrid = null;
      this._capitalCache = null;
      this._visionSet = null;
      this._vision0Set = null;
      this._vision1Set = null;
      return;
    }

    // Tile grid: 2D array [y][x]
    const w = state.map.width;
    const h = state.map.height;
    const grid = new Array(h);
    for (let y = 0; y < h; y++) grid[y] = new Array(w).fill(null);
    for (const tile of state.map.tiles) {
      if (tile.y >= 0 && tile.y < h && tile.x >= 0 && tile.x < w) {
        grid[tile.y][tile.x] = tile;
      }
    }
    this._tileGrid = grid;

    // Unit grid: key → unit
    this._unitGrid = {};
    if (state.units) {
      for (const u of state.units) {
        this._unitGrid[`${u.x},${u.y}`] = u;
      }
    }

    // City grid + capital cache
    this._cityGrid = {};
    this._capitalCache = {};
    if (state.cities) {
      const seenOwner = {};
      for (const c of state.cities) {
        this._cityGrid[`${c.x},${c.y}`] = c;
        if (!seenOwner[c.owner]) {
          seenOwner[c.owner] = true;
          this._capitalCache[`${c.x},${c.y}`] = true;
        }
      }
    }

    // Fog of war vision sets
    if (state._fogEnabled) {
      if (state._visibleTiles) {
        // Player view — own vision
        this._visionSet = new Set(state._visibleTiles);
      } else {
        this._visionSet = null;
      }
      // Spectator view — both players' vision
      this._vision0Set = state._vision0 ? new Set(state._vision0) : null;
      this._vision1Set = state._vision1 ? new Set(state._vision1) : null;
    } else {
      this._visionSet = null;
      this._vision0Set = null;
      this._vision1Set = null;
    }

    // Client-side fog view override (keyboard 1/2/3 toggle)
    // When fogViewMode is set, override server fog data.
    // When fogViewMode is null, also clear server fog data so spectator sees clean view by default.
    this._applyFogView();
  },

  /**
   * Start the render loop
   */
  startRenderLoop() {
    const animate = (time) => {
      this.render(time);
      this.animationId = requestAnimationFrame(animate);
    };
    this.animationId = requestAnimationFrame(animate);
  },

  /**
   * Stop the render loop
   */
  stopRenderLoop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  },

  /**
   * Main render function
   */
  render(time) {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();

    // Clear canvas
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Draw background
    this.drawBackground(ctx, rect);

    // If no game state, draw placeholder
    if (!this.gameState || !this.gameState.map) {
      this.drawPlaceholder(ctx, rect);
      return;
    }

    // Draw map tiles
    this.drawTiles(ctx);

    // Draw cities
    this.drawCities(ctx);

    // Draw monument
    this.drawMonument(ctx);

    // Draw units
    this.drawUnits(ctx, time);

    // Draw vision borders (after everything, so they're on top)
    this.drawVisionBorder(ctx);

    // Draw blood drop effects (damage indicators)
    if (this._damageEffects.length > 0) {
      this._drawDamageEffects(ctx, time);
    }

    // Draw selection/hover highlights
    this.drawInteractionHighlights(ctx);

    // Draw manual play overlays (valid moves, arrows, path plans, etc.)
    // In oversight mode, ManualPlay.getRenderOverlays includes both teams' actions
    if (typeof ManualPlay !== 'undefined' && ManualPlay.active) {
      this.drawManualPlayOverlays(ctx, time);
    }
  },

  /**
   * Draw background — flat color, no gradient per frame
   */
  drawBackground(ctx, rect) {
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, rect.width, rect.height);
  },

  /**
   * Draw placeholder when no game loaded
   */
  drawPlaceholder(ctx, rect) {
    ctx.fillStyle =
      document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'rgba(255, 255, 255, 0.3)'
        : 'rgba(0, 0, 0, 0.3)';
    ctx.font = '24px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Waiting for game state...', rect.width / 2, rect.height / 2);
  },

  /**
   * Build the offscreen tile cache when state or zoom changes
   */
  _ensureTileCache() {
    const zoom = Isometric.zoom;
    if (
      this._tileCacheCanvas &&
      this._tileCacheZoom === zoom &&
      this._tileCacheVersion === this._stateVersion
    ) {
      return;
    }

    const map = this.gameState.map;
    const W = map.width;
    const H = map.height;
    const grid = this._tileGrid;
    if (!grid) return;

    const tw = Isometric.tileWidth;
    const th = Isometric.tileHeight;

    // Bounding box of all tiles with offset (0,0)
    // Extra top padding for terrain sprites (mountains) that extend above tiles
    const spritePad = (tw / 2) * zoom;
    const minX = -H * (tw / 2) * zoom;
    const maxX = W * (tw / 2) * zoom;
    const minY = -(th / 2) * zoom - spritePad;
    const maxY = (W + H) * (th / 2) * zoom;

    const cw = Math.ceil(maxX - minX);
    const ch = Math.ceil(maxY - minY);

    // Create or resize offscreen canvas (at device pixel ratio for crispness)
    const dpr = window.devicePixelRatio || 1;
    if (!this._tileCacheCanvas) {
      this._tileCacheCanvas = document.createElement('canvas');
    }
    this._tileCacheCanvas.width = cw * dpr;
    this._tileCacheCanvas.height = ch * dpr;

    const tctx = this._tileCacheCanvas.getContext('2d');
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.scale(dpr, dpr);
    tctx.clearRect(0, 0, cw, ch);

    // Temporarily shift Isometric offset so tiles render into positive coords
    const savedOffX = Isometric.offsetX;
    const savedOffY = Isometric.offsetY;
    Isometric.offsetX = -minX;
    Isometric.offsetY = -minY;

    // Draw all tiles (no hover/selection — those are drawn dynamically)
    const fogVision = this._visionSet; // null if no fog or spectator
    for (let y = 0; y < H; y++) {
      const row = grid[y];
      for (let x = 0; x < W; x++) {
        const tile = row[x];
        if (!tile) continue;
        // In player fog view, hide territory ownership outside vision
        const inVision = !fogVision || fogVision.has(`${x},${y}`);
        const drawOwner = inVision ? tile.owner : null;
        Tiles.drawTile(tctx, x, y, tile.type.toLowerCase(), drawOwner, {});

        // Fog overlay: desaturate non-visible tiles (player view only)
        if (fogVision && !fogVision.has(`${x},${y}`)) {
          const isMountain = tile.type === 'MOUNTAIN';
          const isMonument = tile.type === 'MONUMENT';
          // Mountains and monuments "peak above" fog — lighter overlay
          const alpha = isMountain || isMonument ? 0.3 : 0.55;
          const corners = Isometric.getTileCorners(x, y);
          tctx.beginPath();
          tctx.moveTo(corners[0].x, corners[0].y);
          for (let i = 1; i < 4; i++) tctx.lineTo(corners[i].x, corners[i].y);
          tctx.closePath();
          tctx.fillStyle = `rgba(15, 15, 25, ${alpha})`;
          tctx.fill();
        }
      }
    }

    // Restore
    Isometric.offsetX = savedOffX;
    Isometric.offsetY = savedOffY;

    this._tileCacheZoom = zoom;
    this._tileCacheVersion = this._stateVersion;
    this._tileCacheMinX = minX;
    this._tileCacheMinY = minY;
    this._tileCacheW = cw;
    this._tileCacheH = ch;
  },

  /**
   * Draw all tiles — uses offscreen cache, redraws only on state/zoom change
   */
  drawTiles(ctx) {
    this._ensureTileCache();

    if (this._tileCacheCanvas) {
      // Single drawImage for the entire tile layer
      ctx.drawImage(
        this._tileCacheCanvas,
        Isometric.offsetX + this._tileCacheMinX,
        Isometric.offsetY + this._tileCacheMinY,
        this._tileCacheW,
        this._tileCacheH
      );
    }

    // Draw hover/selection highlights dynamically (at most 2 tiles)
    if (this.hoveredTile) {
      const tile = this.getTileAt(this.hoveredTile.x, this.hoveredTile.y);
      if (tile) {
        const corners = Isometric.getTileCorners(this.hoveredTile.x, this.hoveredTile.y);
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (this.selectedTile) {
      const corners = Isometric.getTileCorners(this.selectedTile.x, this.selectedTile.y);
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  },

  /**
   * Draw all cities
   */
  drawCities(ctx) {
    if (!this.gameState || !this.gameState.cities) return;

    for (const city of this.gameState.cities) {
      // In player fog view, hide enemy cities outside vision
      if (this._visionSet && city.owner !== this.fogViewMode) {
        if (!this._visionSet.has(`${city.x},${city.y}`)) continue;
      }
      const isCapital = (this._capitalCache && this._capitalCache[`${city.x},${city.y}`]) || false;
      Tiles.drawCity(ctx, city.x, city.y, city.owner, isCapital);
    }
  },

  /**
   * Draw monument
   */
  drawMonument(ctx) {
    if (!this.gameState || !this.gameState.monuments) return;

    for (const monument of this.gameState.monuments) {
      // Monuments always visible including controller (tripwire mechanic)
      Units.drawMonument(ctx, monument.x, monument.y, monument.controlledBy);
    }
  },

  /**
   * Draw all units
   */
  drawUnits(ctx, time) {
    if (!this.gameState || !this.gameState.units) return;

    this.gameState.units.forEach((unit) => {
      // In player fog view, hide enemy units outside vision
      if (this._visionSet && unit.owner !== this.fogViewMode) {
        if (!this._visionSet.has(`${unit.x},${unit.y}`)) return;
      }

      const isSelected =
        this.selectedUnit && this.selectedUnit.x === unit.x && this.selectedUnit.y === unit.y;

      Units.drawUnit(ctx, unit.x, unit.y, unit, {
        selected: isSelected,
        showRange: isSelected,
      });
    });
  },

  /**
   * Draw vision border outlines.
   * Player view: single border around own vision edge.
   * Spectator view: teal border for P0, white border for P1.
   */
  drawVisionBorder(ctx) {
    if (!this.gameState) return;
    if (!this.gameState._fogEnabled && this.fogViewMode === null) return;

    const w = this.gameState.map.width;
    const h = this.gameState.map.height;

    // Direction offsets and which tile edge they correspond to
    // For each adjacent direction, define the two corner indices that form that edge
    const edgeMap = [
      { dx: 0, dy: -1, corners: [0, 1] }, // top-right edge (N)
      { dx: 1, dy: 0, corners: [1, 2] }, // bottom-right edge (E)
      { dx: 0, dy: 1, corners: [2, 3] }, // bottom-left edge (S)
      { dx: -1, dy: 0, corners: [3, 0] }, // top-left edge (W)
    ];

    const drawBorderForVision = (visionSet, color) => {
      if (!visionSet) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const key = `${x},${y}`;
          if (!visionSet.has(key)) continue;

          const corners = Isometric.getTileCorners(x, y);
          // Check each neighbor — if neighbor is outside vision, draw that edge
          for (const edge of edgeMap) {
            const nx = x + edge.dx;
            const ny = y + edge.dy;
            const nKey = `${nx},${ny}`;
            const neighborOutside = nx < 0 || nx >= w || ny < 0 || ny >= h || !visionSet.has(nKey);
            if (neighborOutside) {
              const c0 = corners[edge.corners[0]];
              const c1 = corners[edge.corners[1]];
              ctx.moveTo(c0.x, c0.y);
              ctx.lineTo(c1.x, c1.y);
            }
          }
        }
      }

      ctx.stroke();
      ctx.restore();
    };

    if (this._vision0Set || this._vision1Set) {
      // Spectator view — draw both players' vision borders
      drawBorderForVision(this._vision0Set, '#22eedd'); // bright teal for P0
      drawBorderForVision(this._vision1Set, '#e0e0e0'); // white for P1
    } else if (this._visionSet) {
      // Player view — draw vision border in team color
      const borderColor =
        this.fogViewMode === 0 ? '#22eedd' : this.fogViewMode === 1 ? '#e0e0e0' : '#88aaff';
      drawBorderForVision(this._visionSet, borderColor);
    }
  },

  /**
   * Draw interaction highlights (selection, hover, valid moves)
   */
  drawInteractionHighlights(ctx) {
    // This could be expanded to show valid moves, attacks, etc.
    // when implementing manual play mode
  },

  /**
   * Toggle grid visibility
   */
  toggleGrid() {
    this.showGrid = !this.showGrid;
  },

  /**
   * Toggle ZoC visibility
   */
  toggleZoC() {
    this.showZoC = !this.showZoC;
  },

  /**
   * Compute vision for a player client-side (mirrors logic/vision.js)
   */
  computeVisionClient(playerId) {
    const state = this.gameState;
    if (!state || !state.map) return new Set();

    const visible = new Set();
    const w = state.map.width;
    const h = state.map.height;
    const VISION = { SOLDIER: 2, ARCHER: 3, RAIDER: 2, CITY: 5 };

    const addRadius = (cx, cy, radius) => {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            visible.add(`${nx},${ny}`);
          }
        }
      }
    };

    // Own territory (radius 0 = tile itself)
    for (const tile of state.map.tiles) {
      if (tile.owner === playerId) visible.add(`${tile.x},${tile.y}`);
    }

    // Own units (per-type radius)
    for (const unit of state.units) {
      if (unit.owner === playerId) {
        addRadius(unit.x, unit.y, VISION[unit.type] || 2);
      }
    }

    // Own cities (radius 5)
    for (const city of state.cities) {
      if (city.owner === playerId) {
        addRadius(city.x, city.y, VISION.CITY);
      }
    }

    return visible;
  },

  /**
   * Apply fog view mode — recompute vision sets from full game state
   */
  _applyFogView() {
    if (!this.gameState) return;

    if (this.fogViewMode === 0 || this.fogViewMode === 1) {
      // Player POV — fog on non-visible tiles, hide enemy outside vision
      this._visionSet = this.computeVisionClient(this.fogViewMode);
      this._vision0Set = null;
      this._vision1Set = null;
    } else if (this.fogViewMode === 'spectator') {
      // Omniscient + both vision borders
      this._visionSet = null;
      this._vision0Set = this.computeVisionClient(0);
      this._vision1Set = this.computeVisionClient(1);
    } else {
      this._visionSet = null;
      this._vision0Set = null;
      this._vision1Set = null;
    }
  },

  /**
   * Set fog view mode (0 = P0, 1 = P1, 'spectator' = both borders, null = off)
   * Pressing same mode again toggles off.
   */
  setFogViewMode(mode) {
    if (this.fogViewMode === mode) {
      this.fogViewMode = null;
    } else {
      this.fogViewMode = mode;
    }
    this._applyFogView();
    this._stateVersion++; // Invalidate tile cache
  },

  // --- Manual Play Overlay Drawing ---

  drawManualPlayOverlays(ctx, time) {
    const overlays = ManualPlay.getRenderOverlays(this.gameState);
    if (!overlays) return;

    // Valid move tiles (green)
    if (overlays.validMoves && overlays.validMoves.length > 0) {
      for (const tile of overlays.validMoves) {
        this.drawTileOverlay(
          ctx,
          tile.x,
          tile.y,
          'rgba(52, 199, 89, 0.3)',
          'rgba(52, 199, 89, 0.6)'
        );
      }
    }

    // Valid attack tiles (red)
    if (overlays.validAttacks && overlays.validAttacks.length > 0) {
      for (const tile of overlays.validAttacks) {
        this.drawTileOverlay(
          ctx,
          tile.x,
          tile.y,
          'rgba(255, 59, 48, 0.3)',
          'rgba(255, 59, 48, 0.6)'
        );
      }
    }

    // Expandable tiles (blue)
    if (overlays.expandableTiles && overlays.expandableTiles.length > 0) {
      for (const tile of overlays.expandableTiles) {
        this.drawTileOverlay(
          ctx,
          tile.x,
          tile.y,
          'rgba(59, 130, 246, 0.25)',
          'rgba(59, 130, 246, 0.5)'
        );
      }
    }

    // Valid city locations (gold)
    if (overlays.validCityLocations && overlays.validCityLocations.length > 0) {
      for (const tile of overlays.validCityLocations) {
        this.drawTileOverlay(
          ctx,
          tile.x,
          tile.y,
          'rgba(255, 215, 0, 0.25)',
          'rgba(255, 215, 0, 0.5)'
        );
      }
    }

    // Queued move arrows
    if (overlays.queuedMoveArrows && overlays.queuedMoveArrows.length > 0) {
      for (const arrow of overlays.queuedMoveArrows) {
        this.drawMoveArrow(ctx, arrow);
      }
    }

    // Build markers
    if (overlays.queuedBuildMarkers && overlays.queuedBuildMarkers.length > 0) {
      for (const marker of overlays.queuedBuildMarkers) {
        this.drawBuildMarker(ctx, marker);
      }
    }

    // Path plan lines
    if (overlays.pathPlanLines && overlays.pathPlanLines.length > 0) {
      for (const plan of overlays.pathPlanLines) {
        this.drawPathPlanLine(ctx, plan, time);
      }
    }

    // Selection glow for all selected units
    if (overlays.selectedUnits && overlays.selectedUnits.length > 0) {
      for (const unit of overlays.selectedUnits) {
        this.drawSelectionGlow(ctx, unit);
      }
    }
  },

  drawTileOverlay(ctx, x, y, fillColor, strokeColor) {
    const screen = Isometric.gridToScreen(x, y);
    const tw = Isometric.tileWidth * Isometric.zoom;
    const th = Isometric.tileHeight * Isometric.zoom;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y - th / 2);
    ctx.lineTo(screen.x + tw / 2, screen.y);
    ctx.lineTo(screen.x, screen.y + th / 2);
    ctx.lineTo(screen.x - tw / 2, screen.y);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  },

  drawMoveArrow(ctx, arrow) {
    const from = Isometric.gridToScreen(arrow.fromX, arrow.fromY);
    const to = Isometric.gridToScreen(arrow.toX, arrow.toY);
    const teamColor = arrow.teamId === 0 ? '#00ccaa' : '#e0e0e0';

    ctx.save();
    ctx.strokeStyle = teamColor;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrowhead
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const headLen = 10;
    ctx.fillStyle = teamColor;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(
      to.x - headLen * Math.cos(angle - Math.PI / 6),
      to.y - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      to.x - headLen * Math.cos(angle + Math.PI / 6),
      to.y - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },

  drawBuildMarker(ctx, marker) {
    const screen = Isometric.gridToScreen(marker.x, marker.y);
    const teamColors = { 0: '#00ccaa', 1: '#e0e0e0' };
    const colors = {
      BUILD_UNIT: (marker.teamId !== undefined ? teamColors[marker.teamId] : null) || '#00ccaa',
      BUILD_CITY: '#ffd700',
      EXPAND_TERRITORY:
        (marker.teamId !== undefined ? teamColors[marker.teamId] : null) || '#3b82f6',
    };
    const letters = {
      BUILD_UNIT: marker.detail ? marker.detail[0] : 'U',
      BUILD_CITY: 'C',
      EXPAND_TERRITORY: 'E',
    };

    const color = colors[marker.type] || '#888';
    const letter = letters[marker.type] || '?';
    const r = 12;

    ctx.save();
    ctx.beginPath();
    ctx.arc(screen.x, screen.y - 8, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = 'white';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, screen.x, screen.y - 8);
    ctx.restore();
  },

  drawPathPlanLine(ctx, plan, time) {
    if (!plan.points || plan.points.length < 2) return;
    const teamColor = plan.teamId === 0 ? '#00ccaa' : '#e0e0e0';

    ctx.save();
    ctx.strokeStyle = teamColor;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.6;

    // Animated dash offset
    const dashOffset = (time / 50) % 20;
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -dashOffset;

    ctx.beginPath();
    for (let i = 0; i < plan.points.length; i++) {
      const p = Isometric.gridToScreen(plan.points[i].x, plan.points[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Dots at each point
    ctx.globalAlpha = 0.8;
    for (let i = 0; i < plan.points.length; i++) {
      const p = Isometric.gridToScreen(plan.points[i].x, plan.points[i].y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = teamColor;
      ctx.fill();
    }

    // Turn break circles
    if (plan.turnBreaks) {
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      for (const idx of plan.turnBreaks) {
        if (idx >= 0 && idx < plan.points.length) {
          const p = Isometric.gridToScreen(plan.points[idx].x, plan.points[idx].y);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  },

  drawSelectionGlow(ctx, unit) {
    const screen = Isometric.gridToScreen(unit.x, unit.y);
    const teamColor = unit.owner === 0 ? '#00ccaa' : '#e0e0e0';

    ctx.save();
    ctx.strokeStyle = teamColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y - 6, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  },

  /**
   * Zoom to fit the entire map
   */
  zoomToFit() {
    if (!this.gameState || !this.gameState.map) return;

    const rect = this.canvas.getBoundingClientRect();
    const mapWidth = this.gameState.map.width;
    const mapHeight = this.gameState.map.height;

    // Calculate required zoom to fit
    const mapScreenWidth = ((mapWidth + mapHeight) * Isometric.tileWidth) / 2;
    const mapScreenHeight = ((mapWidth + mapHeight) * Isometric.tileHeight) / 2;

    const zoomX = (rect.width * 0.8) / mapScreenWidth;
    const zoomY = (rect.height * 0.8) / mapScreenHeight;

    Isometric.zoom = Math.min(zoomX, zoomY, 1.5);
    this.centerCamera();
  },
};

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Renderer;
}
