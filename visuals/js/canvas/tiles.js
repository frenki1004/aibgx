/**
 * Tile rendering utilities
 */
const Tiles = {
  // Terrain colors (spec: FIELD, MOUNTAIN, WATER, MONUMENT)
  colors: {
    field: '#90b060',
    mountain: '#8b8b8b',
    water: '#5b9bd5',
    monument: '#ffd700',
  },

  // Team colors — flat opaque, no blending needed (owned tiles are always field)
  teamColors: {
    0: { tile: '#1a7a66', fill: '#00ccaa' },
    1: { tile: '#c0bdb0', fill: '#e0e0e0' },
  },

  /**
   * Draw an isometric diamond tile
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {number} x - Grid X
   * @param {number} y - Grid Y
   * @param {string} terrain - Terrain type
   * @param {number|null} owner - Owner team (null if unowned)
   * @param {Object} options - Additional options
   */
  drawTile(ctx, x, y, terrain, owner = null, options = {}) {
    const corners = Isometric.getTileCorners(x, y);
    const center = Isometric.gridToScreen(x, y);

    // Build tile path
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) {
      ctx.lineTo(corners[i].x, corners[i].y);
    }
    ctx.closePath();

    // Flat opaque fill — owned tiles use team tile color, unowned use terrain
    const fillColor =
      owner !== null && this.teamColors[owner]
        ? this.teamColors[owner].tile
        : this.colors[terrain] || this.colors.field;
    ctx.fillStyle = fillColor;
    ctx.fill();
    // Stroke same color to seal anti-aliasing gaps (all same-team tiles identical)
    ctx.strokeStyle = fillColor;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw tile border only for selected/hovered tiles
    if (options.selected || options.hover) {
      ctx.strokeStyle = options.selected ? '#ffffff' : '#cccccc';
      ctx.lineWidth = options.selected ? 2 : 1;
      ctx.stroke();
    }

    // Selection highlight (no shadowBlur — it's slow)
    if (options.selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Add valid move indicator
    if (options.validMove) {
      ctx.fillStyle = 'rgba(52, 199, 89, 0.4)';
      ctx.fill();
    }

    // Add valid attack indicator
    if (options.validAttack) {
      ctx.fillStyle = 'rgba(255, 59, 48, 0.4)';
      ctx.fill();
    }

    // Draw terrain details
    this.drawTerrainDetails(ctx, center, terrain, options);
  },

  /**
   * Draw terrain-specific details
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {{x: number, y: number}} center - Tile center
   * @param {string} terrain - Terrain type
   * @param {Object} options - Additional options
   */
  drawTerrainDetails(ctx, center, terrain, options = {}) {
    const scale = Isometric.zoom;

    switch (terrain) {
      case 'mountain': {
        this.drawMountain3D(ctx, center, scale);
        break;
      }

      case 'water':
        // Draw wave pattern
        this.drawWaves(ctx, center, scale);
        break;

      case 'monument':
        // Simple monument marker (no gradient — it's slow)
        ctx.beginPath();
        ctx.arc(center.x, center.y, 10 * scale, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 215, 0, 0.35)';
        ctx.fill();
        break;
    }
  },

  /**
   * Draw a simple tree
   */
  drawTree(ctx, x, y, scale) {
    ctx.fillStyle = '#2d5016';
    ctx.beginPath();
    ctx.moveTo(x, y - 10 * scale);
    ctx.lineTo(x + 6 * scale, y + 4 * scale);
    ctx.lineTo(x - 6 * scale, y + 4 * scale);
    ctx.closePath();
    ctx.fill();

    // Tree trunk
    ctx.fillStyle = '#5c4033';
    ctx.fillRect(x - 2 * scale, y + 4 * scale, 4 * scale, 4 * scale);
  },

  /**
   * Draw a 3D isometric mountain filling the tile diamond
   * 4-face pyramid: back-left, back-right, front-left (lit), front-right (shadow)
   */
  drawMountain3D(ctx, center, scale) {
    const hw = (Isometric.tileWidth / 2) * scale;
    const hh = (Isometric.tileHeight / 2) * scale;
    const cx = center.x;
    const cy = center.y;

    // Tile diamond corners
    const top = { x: cx, y: cy - hh }; // back
    const right = { x: cx + hw, y: cy };
    const bottom = { x: cx, y: cy + hh }; // front
    const left = { x: cx - hw, y: cy };

    // Peak rises above tile center
    const peak = { x: cx, y: cy - hh * 1.8 };

    // Back-left face (medium — partially visible behind peak)
    ctx.fillStyle = '#787880';
    ctx.beginPath();
    ctx.moveTo(peak.x, peak.y);
    ctx.lineTo(top.x, top.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
    ctx.fill();

    // Back-right face (darker)
    ctx.fillStyle = '#58585e';
    ctx.beginPath();
    ctx.moveTo(peak.x, peak.y);
    ctx.lineTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fill();

    // Front-left face (brightest — lit)
    ctx.fillStyle = '#a0a0a8';
    ctx.beginPath();
    ctx.moveTo(peak.x, peak.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.closePath();
    ctx.fill();

    // Front-right face (shadow)
    ctx.fillStyle = '#686870';
    ctx.beginPath();
    ctx.moveTo(peak.x, peak.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.closePath();
    ctx.fill();

    // Snow cap — same 4 faces scaled down
    const sf = 0.28;
    const scy = peak.y + (cy - peak.y) * sf;
    const shw = hw * sf;
    const shh = hh * sf;
    const sTop = { x: cx, y: scy - shh };
    const sRight = { x: cx + shw, y: scy };
    const sBottom = { x: cx, y: scy + shh };
    const sLeft = { x: cx - shw, y: scy };

    ctx.fillStyle = '#d0d8e0';
    ctx.beginPath();
    ctx.moveTo(peak.x, peak.y);
    ctx.lineTo(sTop.x, sTop.y);
    ctx.lineTo(sLeft.x, sLeft.y);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#b8c0c8';
    ctx.beginPath();
    ctx.moveTo(peak.x, peak.y);
    ctx.lineTo(sTop.x, sTop.y);
    ctx.lineTo(sRight.x, sRight.y);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#e8eef5';
    ctx.beginPath();
    ctx.moveTo(peak.x, peak.y);
    ctx.lineTo(sLeft.x, sLeft.y);
    ctx.lineTo(sBottom.x, sBottom.y);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#ccd4dc';
    ctx.beginPath();
    ctx.moveTo(peak.x, peak.y);
    ctx.lineTo(sRight.x, sRight.y);
    ctx.lineTo(sBottom.x, sBottom.y);
    ctx.closePath();
    ctx.fill();
  },

  /**
   * Draw wave pattern for water
   */
  drawWaves(ctx, center, scale) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;
    // Simple straight lines instead of curves
    for (let i = -1; i <= 1; i++) {
      const y = center.y + i * 5 * scale;
      ctx.beginPath();
      ctx.moveTo(center.x - 8 * scale, y);
      ctx.lineTo(center.x + 8 * scale, y);
      ctx.stroke();
    }
  },

  /**
   * Draw a walled settlement with huts inside
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x - Grid X
   * @param {number} y - Grid Y
   * @param {number} owner - Owner team
   * @param {boolean} isCapital - Whether this is the capital city
   */
  drawCity(ctx, x, y, owner, isCapital = false) {
    const center = Isometric.gridToScreen(x, y);
    const s = Isometric.zoom;
    const cx = center.x;
    const cy = center.y;
    const hw = (Isometric.tileWidth / 2) * s;
    const hh = (Isometric.tileHeight / 2) * s;

    // Team accent palette — vibrant, saturated
    const team =
      owner === 0
        ? {
            wallL: '#009980',
            wallR: '#006655',
            top: '#00ccaa',
            bright: '#40ffd0',
            banner: '#00ffdd',
          }
        : {
            wallL: '#8a8a8a',
            wallR: '#5a5a5a',
            top: '#c0c0c0',
            bright: '#eeeeee',
            banner: '#ffffff',
          };

    // Hut palette — warm brown/tan tones
    const hut = {
      wallL: '#c4a882',
      wallR: '#8b7a60',
      roofA: '#7a5c30',
      roofB: '#5e4828',
      roofC: '#6a6058',
    };

    // Tile diamond corners
    const dTop = { x: cx, y: cy - hh };
    const dRight = { x: cx + hw, y: cy };
    const dBottom = { x: cx, y: cy + hh };
    const dLeft = { x: cx - hw, y: cy };

    // ─── Perimeter Wall (extends below tile diamond) ───
    const wallH = hh * 0.56;

    // Front-left wall face (lit)
    ctx.fillStyle = team.wallL;
    ctx.beginPath();
    ctx.moveTo(dLeft.x, dLeft.y);
    ctx.lineTo(dBottom.x, dBottom.y);
    ctx.lineTo(dBottom.x, dBottom.y + wallH);
    ctx.lineTo(dLeft.x, dLeft.y + wallH);
    ctx.closePath();
    ctx.fill();

    // Front-right wall face (shadow)
    ctx.fillStyle = team.wallR;
    ctx.beginPath();
    ctx.moveTo(dRight.x, dRight.y);
    ctx.lineTo(dBottom.x, dBottom.y);
    ctx.lineTo(dBottom.x, dBottom.y + wallH);
    ctx.lineTo(dRight.x, dRight.y + wallH);
    ctx.closePath();
    ctx.fill();

    // Wall top — thick team-colored diamond border
    ctx.strokeStyle = team.top;
    ctx.lineWidth = 2.5 * s;
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    ctx.moveTo(dTop.x, dTop.y);
    ctx.lineTo(dRight.x, dRight.y);
    ctx.lineTo(dBottom.x, dBottom.y);
    ctx.lineTo(dLeft.x, dLeft.y);
    ctx.closePath();
    ctx.stroke();

    // ─── Corner posts at visible diamond corners ───
    const postW = hw * 0.06;
    const postD = hh * 0.06;
    const postH = hh * 0.22;
    for (const corner of [dLeft, dBottom, dRight]) {
      this._isoBox(
        ctx,
        corner.x,
        corner.y,
        postW,
        postD,
        postH,
        team.wallL,
        team.wallR,
        team.bright
      );
    }

    // ─── Buildings inside (back-to-front) ───
    const bw = hw * 0.18;
    const bd = hh * 0.13;
    const bh = hh * 0.4;

    // Main hall (back-center, team-colored roof)
    this._isoBox(
      ctx,
      cx,
      cy - hh * 0.14,
      bw * 1.2,
      bd * 1.2,
      bh * 1.2,
      hut.wallL,
      hut.wallR,
      team.top
    );

    // Right hut (slightly back)
    this._isoBox(
      ctx,
      cx + hw * 0.22,
      cy + hh * 0.06,
      bw * 0.9,
      bd * 0.75,
      bh * 0.9,
      hut.wallL,
      hut.wallR,
      hut.roofB
    );

    // Left hut
    this._isoBox(
      ctx,
      cx - hw * 0.28,
      cy + hh * 0.1,
      bw * 0.85,
      bd * 0.8,
      bh * 0.85,
      hut.wallL,
      hut.wallR,
      hut.roofA
    );

    // Front shop (near gate)
    this._isoBox(
      ctx,
      cx + hw * 0.02,
      cy + hh * 0.3,
      bw * 0.7,
      bd * 0.65,
      bh * 0.7,
      hut.wallL,
      hut.wallR,
      hut.roofC
    );

    // ─── Capital ───
    if (isCapital) {
      // Tall team-colored tower at center
      this._isoBox(
        ctx,
        cx,
        cy + hh * 0.03,
        bw * 0.5,
        bd * 0.5,
        bh * 1.8,
        team.wallL,
        team.wallR,
        team.bright
      );
      // Flag pole + banner
      const towerTopY = cy + hh * 0.03 - bh * 1.8 - bd * 0.5;
      ctx.fillStyle = '#ffd700';
      ctx.fillRect(cx - 1 * s, towerTopY - 10 * s, 1.5 * s, 10 * s);
      ctx.fillStyle = team.banner;
      ctx.fillRect(cx + 0.5 * s, towerTopY - 10 * s, 6 * s, 3.5 * s);
      ctx.fillStyle = '#ffffff';
      ctx.font = `${5 * s}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u2605', cx + 3.5 * s, towerTopY - 8.5 * s);
    }
  },

  /**
   * Draw a small isometric box (used by drawCity for huts/posts)
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} bx - Ground-level center X (screen)
   * @param {number} by - Ground-level center Y (screen)
   * @param {number} halfW - Iso half-width
   * @param {number} halfD - Iso half-depth
   * @param {number} h - Height (extends upward)
   * @param {string} leftColor - Lit wall color
   * @param {string} rightColor - Shadow wall color
   * @param {string} roofColor - Top face color
   */
  _isoBox(ctx, bx, by, halfW, halfD, h, leftColor, rightColor, roofColor) {
    const ry = by - h;
    // Roof corners
    const rT = { x: bx, y: ry - halfD };
    const rR = { x: bx + halfW, y: ry };
    const rB = { x: bx, y: ry + halfD };
    const rL = { x: bx - halfW, y: ry };
    // Ground corners (front-facing)
    const gR = { x: rR.x, y: rR.y + h };
    const gB = { x: rB.x, y: rB.y + h };
    const gL = { x: rL.x, y: rL.y + h };

    // Left wall (lit)
    ctx.fillStyle = leftColor;
    ctx.beginPath();
    ctx.moveTo(rL.x, rL.y);
    ctx.lineTo(rB.x, rB.y);
    ctx.lineTo(gB.x, gB.y);
    ctx.lineTo(gL.x, gL.y);
    ctx.closePath();
    ctx.fill();

    // Right wall (shadow)
    ctx.fillStyle = rightColor;
    ctx.beginPath();
    ctx.moveTo(rR.x, rR.y);
    ctx.lineTo(rB.x, rB.y);
    ctx.lineTo(gB.x, gB.y);
    ctx.lineTo(gR.x, gR.y);
    ctx.closePath();
    ctx.fill();

    // Roof (top face)
    ctx.fillStyle = roofColor;
    ctx.beginPath();
    ctx.moveTo(rT.x, rT.y);
    ctx.lineTo(rR.x, rR.y);
    ctx.lineTo(rB.x, rB.y);
    ctx.lineTo(rL.x, rL.y);
    ctx.closePath();
    ctx.fill();
  },
};

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Tiles;
}
