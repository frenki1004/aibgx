/**
 * Isometric coordinate system utilities
 */
const Isometric = {
  // Tile dimensions (width/height ratio is 2:1 for isometric)
  tileWidth: 64,
  tileHeight: 32,

  // Camera offset (center of canvas)
  offsetX: 0,
  offsetY: 0,

  // Zoom level
  zoom: 1,

  /**
   * Convert grid coordinates to screen position
   * @param {number} x - Grid X coordinate
   * @param {number} y - Grid Y coordinate
   * @returns {{x: number, y: number}} Screen position
   */
  gridToScreen(x, y) {
    const screenX = (x - y) * (this.tileWidth / 2) * this.zoom + this.offsetX;
    const screenY = (x + y) * (this.tileHeight / 2) * this.zoom + this.offsetY;
    return { x: screenX, y: screenY };
  },

  /**
   * Convert screen position to grid coordinates
   * @param {number} screenX - Screen X position
   * @param {number} screenY - Screen Y position
   * @returns {{x: number, y: number}} Grid coordinates (may need rounding)
   */
  screenToGrid(screenX, screenY) {
    // Adjust for camera offset
    const adjX = (screenX - this.offsetX) / this.zoom;
    const adjY = (screenY - this.offsetY) / this.zoom;

    // Inverse transformation
    const x = (adjX / (this.tileWidth / 2) + adjY / (this.tileHeight / 2)) / 2;
    const y = (adjY / (this.tileHeight / 2) - adjX / (this.tileWidth / 2)) / 2;

    return { x, y };
  },

  /**
   * Get the grid cell at a screen position (rounded)
   * @param {number} screenX - Screen X position
   * @param {number} screenY - Screen Y position
   * @returns {{x: number, y: number}} Grid cell coordinates
   */
  getGridCell(screenX, screenY) {
    const { x, y } = this.screenToGrid(screenX, screenY);
    return {
      x: Math.round(x),
      y: Math.round(y),
    };
  },

  /**
   * Get the four corners of a tile in screen coordinates
   * @param {number} x - Grid X coordinate
   * @param {number} y - Grid Y coordinate
   * @returns {Array<{x: number, y: number}>} Array of 4 corner points
   */
  getTileCorners(x, y) {
    const center = this.gridToScreen(x, y);
    const hw = (this.tileWidth / 2) * this.zoom;
    const hh = (this.tileHeight / 2) * this.zoom;

    return [
      { x: center.x, y: center.y - hh }, // Top
      { x: center.x + hw, y: center.y }, // Right
      { x: center.x, y: center.y + hh }, // Bottom
      { x: center.x - hw, y: center.y }, // Left
    ];
  },

  /**
   * Check if a screen point is inside a tile
   * @param {number} screenX - Screen X position
   * @param {number} screenY - Screen Y position
   * @param {number} tileX - Tile grid X
   * @param {number} tileY - Tile grid Y
   * @returns {boolean} True if point is inside tile
   */
  isPointInTile(screenX, screenY, tileX, tileY) {
    const center = this.gridToScreen(tileX, tileY);
    const hw = (this.tileWidth / 2) * this.zoom;
    const hh = (this.tileHeight / 2) * this.zoom;

    // Transform to tile-local coordinates
    const dx = Math.abs(screenX - center.x) / hw;
    const dy = Math.abs(screenY - center.y) / hh;

    // Diamond shape: |dx| + |dy| <= 1
    return dx + dy <= 1;
  },

  /**
   * Set camera to center on a grid position
   * @param {number} x - Grid X coordinate
   * @param {number} y - Grid Y coordinate
   * @param {number} canvasWidth - Canvas width
   * @param {number} canvasHeight - Canvas height
   */
  centerOn(x, y, canvasWidth, canvasHeight) {
    const screen = this.gridToScreen(x, y);
    this.offsetX = canvasWidth / 2 - (screen.x - this.offsetX);
    this.offsetY = canvasHeight / 2 - (screen.y - this.offsetY);
  },

  /**
   * Pan the camera
   * @param {number} dx - Delta X
   * @param {number} dy - Delta Y
   */
  pan(dx, dy) {
    this.offsetX += dx;
    this.offsetY += dy;
  },

  /**
   * Zoom the camera
   * @param {number} factor - Zoom factor (1 = no change, >1 = zoom in)
   * @param {number} centerX - Center X for zoom
   * @param {number} centerY - Center Y for zoom
   */
  setZoom(factor, centerX, centerY) {
    const oldZoom = this.zoom;
    this.zoom = Math.max(0.5, Math.min(2, factor));

    // Adjust offset to zoom towards center point
    const zoomRatio = this.zoom / oldZoom;
    this.offsetX = centerX - (centerX - this.offsetX) * zoomRatio;
    this.offsetY = centerY - (centerY - this.offsetY) * zoomRatio;
  },

  /**
   * Get visible grid bounds based on canvas size
   * @param {number} canvasWidth - Canvas width
   * @param {number} canvasHeight - Canvas height
   * @returns {{minX: number, maxX: number, minY: number, maxY: number}}
   */
  getVisibleBounds(canvasWidth, canvasHeight) {
    const topLeft = this.screenToGrid(0, 0);
    const topRight = this.screenToGrid(canvasWidth, 0);
    const bottomLeft = this.screenToGrid(0, canvasHeight);
    const bottomRight = this.screenToGrid(canvasWidth, canvasHeight);

    return {
      minX: Math.floor(Math.min(topLeft.x, bottomLeft.x)) - 1,
      maxX: Math.ceil(Math.max(topRight.x, bottomRight.x)) + 1,
      minY: Math.floor(Math.min(topLeft.y, topRight.y)) - 1,
      maxY: Math.ceil(Math.max(bottomLeft.y, bottomRight.y)) + 1,
    };
  },
};

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Isometric;
}
