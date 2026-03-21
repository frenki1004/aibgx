/**
 * Unit rendering utilities — draws team-colored weapon icons from PNG assets
 */
const Units = {
  // Unit type configurations
  types: {
    SOLDIER: {
      asset: 'sword',
      maxHp: 2,
      figureCount: 8,
      figure: { head: '#aaaaaa', body: '#777777', legs: '#555555' },
    },
    ARCHER: {
      asset: 'bow',
      maxHp: 2,
      figureCount: 6,
      figure: { head: '#c49a6c', body: '#8B5E3C', legs: '#5a3a20' },
    },
    RAIDER: {
      asset: 'axe',
      maxHp: 1,
      figureCount: 4,
      figure: { head: '#bbbbbb', body: '#3a3a3a', legs: '#222222' },
    },
  },

  // Team colors
  teamColors: {
    0: { fill: '#00ccaa', stroke: '#33ddc0', shadow: 'rgba(0, 204, 170, 0.5)' },
    1: { fill: '#e0e0e0', stroke: '#ffffff', shadow: 'rgba(255, 255, 255, 0.4)' },
  },

  // Cached Image objects: { 'sword_0': Image, 'sword_1': Image, ... }
  _images: {},
  _loaded: false,

  /**
   * Pre-load PNG assets. Call once at startup.
   */
  loadAssets(basePath) {
    const assets = ['sword', 'bow', 'axe'];
    const teamIds = [0, 1];
    let remaining = assets.length * teamIds.length;

    for (const name of assets) {
      for (const teamId of teamIds) {
        const key = `${name}_${teamId}`;
        const img = new Image();
        img.onload = () => {
          this._images[key] = img;
          remaining--;
          if (remaining === 0) this._loaded = true;
        };
        img.onerror = () => {
          console.warn(`[Units] Failed to load: ${key}.png`);
          remaining--;
          if (remaining === 0) this._loaded = true;
        };
        img.src = `${basePath}/${key}.png`;
      }
    }
  },

  /**
   * Draw a unit at the specified grid position
   */
  drawUnit(ctx, x, y, unit, options = {}) {
    const center = Isometric.gridToScreen(x, y);
    const scale = Isometric.zoom;
    const teamColor = this.teamColors[unit.owner];
    const unitType = this.types[unit.type];

    if (!teamColor || !unitType) return;

    const unitY = center.y - 8 * scale;

    // Selection bounce
    let bounceOffset = 0;
    if (options.selected) {
      bounceOffset = Math.sin(Date.now() / 150) * 3 * scale;
    }

    const wx = center.x;
    const wy = unitY - bounceOffset;

    // Selection ring (no shadowBlur — it's slow)
    if (options.selected) {
      ctx.strokeStyle = teamColor.fill;
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      ctx.arc(wx, wy, 12 * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Scattered tiny figures on the tile (drawn first, behind icon)
    const fig = unitType.figure;
    if (fig) {
      this.drawFigures(ctx, center.x, center.y, x, y, unitType, scale);
    }

    // Draw weapon icon on top of figures
    const drawSize = 24 * scale;
    const key = `${unitType.asset}_${unit.owner}`;
    const img = this._images[key];

    if (img) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, wx - drawSize / 2, wy - drawSize / 2, drawSize, drawSize);
      ctx.imageSmoothingEnabled = true;
    } else {
      ctx.fillStyle = teamColor.fill;
      ctx.font = `bold ${10 * scale}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(unit.type[0], wx, wy);
    }

    // HP bar (below weapon icon)
    this.drawHpBar(ctx, center.x, wy + drawSize / 2 + 2 * scale, unit.hp, unitType.maxHp, scale);

    // Move/attack indicators
    if (options.showRange && options.validMoves) {
      this.drawMovementIndicators(ctx, options.validMoves);
    }
    if (options.showRange && options.validAttacks) {
      this.drawAttackIndicators(ctx, options.validAttacks);
    }
  },

  /**
   * Simple seeded random — consistent positions per tile
   */
  _seededRand(seed) {
    let s = seed;
    return () => {
      s = (s * 16807 + 0) % 2147483647;
      return (s - 1) / 2147483646;
    };
  },

  /**
   * Draw scattered tiny soldier figures on the tile
   */
  drawFigures(ctx, tileCx, tileCy, gx, gy, unitType, scale) {
    const fig = unitType.figure;
    const count = unitType.figureCount || 4;
    const rand = this._seededRand(gx * 1000 + gy * 37 + 7);

    const hw = (Isometric.tileWidth / 2) * scale;
    const hh = (Isometric.tileHeight / 2) * scale;
    const p = scale; // pixel unit

    for (let i = 0; i < count; i++) {
      // Random position within the isometric diamond
      // Generate random point, reject if outside diamond
      let fx, fy;
      for (let attempt = 0; attempt < 10; attempt++) {
        const rx = (rand() - 0.5) * 1.4; // -0.7 to 0.7
        const ry = (rand() - 0.5) * 1.4;
        if (Math.abs(rx) + Math.abs(ry) <= 0.7) {
          fx = tileCx + rx * hw;
          fy = tileCy + ry * hh;
          break;
        }
      }
      if (fx === undefined) continue;

      // Head (2x2)
      ctx.fillStyle = fig.head;
      ctx.fillRect(fx - p, fy, 2 * p, 2 * p);
      // Body (2x3)
      ctx.fillStyle = fig.body;
      ctx.fillRect(fx - p, fy + 2 * p, 2 * p, 3 * p);
      // Legs (split)
      ctx.fillStyle = fig.legs;
      ctx.fillRect(fx - p, fy + 5 * p, p, 2 * p);
      ctx.fillRect(fx, fy + 5 * p, p, 2 * p);
    }
  },

  /**
   * Draw HP bar below unit — simple colored line
   */
  drawHpBar(ctx, x, y, currentHp, maxHp, scale) {
    const width = 16 * scale;
    const hpPercent = currentHp / maxHp;

    let color = '#34c759';
    if (hpPercent <= 0.33) color = '#ff3b30';
    else if (hpPercent <= 0.66) color = '#ff9f0a';

    // Background line
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 3 * scale;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(x - width / 2, y);
    ctx.lineTo(x + width / 2, y);
    ctx.stroke();

    // HP fill line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.moveTo(x - width / 2, y);
    ctx.lineTo(x - width / 2 + width * hpPercent, y);
    ctx.stroke();
  },

  /**
   * Draw movement range indicators
   */
  drawMovementIndicators(ctx, validMoves) {
    validMoves.forEach((pos) => {
      const corners = Isometric.getTileCorners(pos.x, pos.y);
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(52, 199, 89, 0.35)';
      ctx.fill();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#34c759';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    });
  },

  /**
   * Draw attack range indicators
   */
  drawAttackIndicators(ctx, validAttacks) {
    validAttacks.forEach((pos) => {
      const corners = Isometric.getTileCorners(pos.x, pos.y);
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 59, 48, 0.35)';
      ctx.fill();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ff3b30';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    });
  },

  /**
   * Draw Zone of Control for soldiers
   */
  drawZoneOfControl(ctx, x, y, owner) {
    const teamColor = this.teamColors[owner];
    const zocTiles = this.getDistance2Tiles(x, y);

    zocTiles.forEach((pos) => {
      const corners = Isometric.getTileCorners(pos.x, pos.y);
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = owner === 0 ? 'rgba(0, 204, 170, 0.1)' : 'rgba(255, 255, 255, 0.08)';
      ctx.fill();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = teamColor.fill;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    });
  },

  getDistance2Tiles(x, y) {
    const tiles = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        if (dx === 0 && dy === 0) continue;
        if (Math.abs(dx) + Math.abs(dy) <= 2) tiles.push({ x: x + dx, y: y + dy });
      }
    }
    return tiles;
  },

  getAdjacentTiles(x, y) {
    const tiles = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        tiles.push({ x: x + dx, y: y + dy });
      }
    }
    return tiles;
  },

  /**
   * Draw monument
   */
  drawMonument(ctx, x, y, controlledBy) {
    const center = Isometric.gridToScreen(x, y);
    const s = Isometric.zoom;
    const cx = center.x;
    const cy = center.y;
    const hw = (Isometric.tileWidth / 2) * s;
    const hh = (Isometric.tileHeight / 2) * s;

    const hasOwner = controlledBy !== null && controlledBy !== undefined;
    const tc = hasOwner ? this.teamColors[controlledBy] : null;

    // Accent color — team or gold
    const accent = tc ? tc.fill : '#ffd700';
    const accentDark = hasOwner ? (controlledBy === 0 ? '#008c74' : '#808080') : '#b8860b';

    // ─── Base platform (small isometric diamond, slightly raised) ───
    const baseW = hw * 0.35;
    const baseD = hh * 0.35;
    const baseH = hh * 0.12;
    const baseY = cy + hh * 0.1; // ground level, slightly forward

    // Base left face
    ctx.fillStyle = accentDark;
    ctx.beginPath();
    ctx.moveTo(cx - baseW, baseY - baseH);
    ctx.lineTo(cx, baseY + baseD - baseH);
    ctx.lineTo(cx, baseY + baseD);
    ctx.lineTo(cx - baseW, baseY);
    ctx.closePath();
    ctx.fill();

    // Base right face
    ctx.fillStyle = hasOwner ? (controlledBy === 0 ? '#005540' : '#606060') : '#8B6914';
    ctx.beginPath();
    ctx.moveTo(cx + baseW, baseY - baseH);
    ctx.lineTo(cx, baseY + baseD - baseH);
    ctx.lineTo(cx, baseY + baseD);
    ctx.lineTo(cx + baseW, baseY);
    ctx.closePath();
    ctx.fill();

    // Base top face
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(cx, baseY - baseD - baseH);
    ctx.lineTo(cx + baseW, baseY - baseH);
    ctx.lineTo(cx, baseY + baseD - baseH);
    ctx.lineTo(cx - baseW, baseY - baseH);
    ctx.closePath();
    ctx.fill();

    // ─── Obelisk (tall narrow isometric pillar) ───
    const pillarW = hw * 0.08;
    const pillarD = hh * 0.08;
    const pillarH = hh * 1.4;
    const pillarBase = baseY - baseH; // sits on top of platform

    // Pillar left face (lit)
    ctx.fillStyle = '#e8dcc8';
    ctx.beginPath();
    ctx.moveTo(cx - pillarW, pillarBase - pillarH);
    ctx.lineTo(cx, pillarBase + pillarD - pillarH);
    ctx.lineTo(cx, pillarBase + pillarD);
    ctx.lineTo(cx - pillarW, pillarBase);
    ctx.closePath();
    ctx.fill();

    // Pillar right face (shadow)
    ctx.fillStyle = '#b8a888';
    ctx.beginPath();
    ctx.moveTo(cx + pillarW, pillarBase - pillarH);
    ctx.lineTo(cx, pillarBase + pillarD - pillarH);
    ctx.lineTo(cx, pillarBase + pillarD);
    ctx.lineTo(cx + pillarW, pillarBase);
    ctx.closePath();
    ctx.fill();

    // Pillar top face
    ctx.fillStyle = '#f0e8d8';
    ctx.beginPath();
    ctx.moveTo(cx, pillarBase - pillarD - pillarH);
    ctx.lineTo(cx + pillarW, pillarBase - pillarH);
    ctx.lineTo(cx, pillarBase + pillarD - pillarH);
    ctx.lineTo(cx - pillarW, pillarBase - pillarH);
    ctx.closePath();
    ctx.fill();

    // ─── Gem on top (small diamond, team/gold colored) ───
    const gemS = hh * 0.1;
    const gemY = pillarBase - pillarH - pillarD;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(cx, gemY - gemS);
    ctx.lineTo(cx + gemS * 0.7, gemY);
    ctx.lineTo(cx, gemY + gemS * 0.5);
    ctx.lineTo(cx - gemS * 0.7, gemY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1 * s;
    ctx.stroke();
  },
};

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Units;
}
