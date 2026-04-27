/**
 * TerrainQuery — single owner of "ask the landscape a question".
 *
 * The DEM is a passive data structure (Float32Array + metadata). Before this
 * layer, every world feature (water pools, vegetation, mob spawn) reached
 * directly into `dem.data[]` and re-derived its own slope/concavity/neighbour
 * helpers. That made adding the next feature a copy-paste job and gave each
 * one its own subtle bugs (sampling conventions, half-pixel offsets, etc.).
 *
 * One TerrainQuery is constructed in main.js once the DEM is loaded, and
 * passed to anything that needs spatial info about the terrain.
 *
 * Two modes of access:
 *
 *   • Point queries — sampleHeight, sampleGroundY, sampleSlope, sampleAspect,
 *     sampleConcavity. World-coordinate (x, z) inputs.
 *
 *   • Cell scans — findCells(predicate, opts). Iterates DEM cells; the
 *     predicate receives a pooled Cell object that lazily computes derived
 *     metrics (slope, aspect, concavity, neighbour heights). Used by
 *     analysis passes that need to *enumerate* matching cells (water pools,
 *     habitat-driven spawn points).
 *
 * The Cell object is reused across iterations to avoid per-cell allocation.
 * Hold onto its (i, j, x, z, height) values, not the cell itself.
 */
export class TerrainQuery {
  constructor({ dem, terrainPlaneSize, terrainSegments }) {
    this.dem = dem;
    this.planeSize = terrainPlaneSize;
    this.segments = terrainSegments;
  }

  get worldWidth()    { return this.dem.worldWidth; }
  get worldHeight()   { return this.dem.worldHeight; }
  get minElevation()  { return this.dem.minZ; }
  get maxElevation()  { return this.dem.maxZ; }
  get pixelSize()     { return this.dem.pixelSizeX; }
  get widthCells()    { return this.dem.width; }
  get heightCells()   { return this.dem.height; }

  // ─── Point queries ─────────────────────────────────────────────────────

  /**
   * Bilinear DEM height at world (x, z). Half-pixel-correct so it matches
   * the GPU's texture sampling convention.
   */
  sampleHeight(x, z) {
    const dem = this.dem;
    const src = dem.renderData || dem.data;
    const u = (x / dem.worldWidth + 0.5) * dem.width - 0.5;
    const v = (z / dem.worldHeight + 0.5) * dem.height - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const fx = u - x0, fy = v - y0;
    const cx0 = clamp(x0, 0, dem.width - 1);
    const cy0 = clamp(y0, 0, dem.height - 1);
    const cx1 = clamp(x0 + 1, 0, dem.width - 1);
    const cy1 = clamp(y0 + 1, 0, dem.height - 1);
    const h00 = src[cy0 * dem.width + cx0];
    const h10 = src[cy0 * dem.width + cx1];
    const h01 = src[cy1 * dem.width + cx0];
    const h11 = src[cy1 * dem.width + cx1];
    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    return h0 * (1 - fy) + h1 * fy;
  }

  /**
   * Height the rendered terrain mesh actually draws at (x, z). Three's
   * PlaneGeometry triangulates with the V01↔V10 diagonal — using the wrong
   * split causes visible floating/sinking on slopes. Use this for character
   * grounding and any visual-alignment query.
   */
  sampleGroundY(x, z) {
    const halfPlane = this.planeSize * 0.5;
    const dx = this.planeSize / this.segments;
    const gx = (x + halfPlane) / dx;
    const gy = (z + halfPlane) / dx;
    const ix0 = Math.floor(gx), iy0 = Math.floor(gy);
    const fx = gx - ix0, fy = gy - iy0;
    const x0w = ix0 * dx - halfPlane;
    const x1w = (ix0 + 1) * dx - halfPlane;
    const y0w = iy0 * dx - halfPlane;
    const y1w = (iy0 + 1) * dx - halfPlane;
    const v00 = this.sampleHeight(x0w, y0w);
    const v10 = this.sampleHeight(x1w, y0w);
    const v01 = this.sampleHeight(x0w, y1w);
    const v11 = this.sampleHeight(x1w, y1w);
    if (fx + fy < 1) {
      return (1 - fx - fy) * v00 + fy * v01 + fx * v10;
    }
    return (1 - fx) * v01 + (fx + fy - 1) * v11 + (1 - fy) * v10;
  }

  /** Slope in radians. `step` is in DEM cells. */
  sampleSlope(x, z, step = 4) {
    const ds = step * this.dem.pixelSizeX;
    const hL = this.sampleHeight(x - ds, z);
    const hR = this.sampleHeight(x + ds, z);
    const hD = this.sampleHeight(x, z - ds);
    const hU = this.sampleHeight(x, z + ds);
    const dzdx = (hR - hL) / (2 * ds);
    const dzdy = (hU - hD) / (2 * ds);
    return Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
  }

  /**
   * Aspect: azimuth (radians) of the steepest *descent* direction.
   *   0 = south (+z downhill), π/2 = west, π = north, -π/2 = east.
   * Returns NaN on near-flat cells (slope < ~0.5°), since aspect is undefined.
   *
   * Convention matches `playerYaw` in the rest of the engine (yaw=0 → +Z).
   */
  sampleAspect(x, z, step = 4) {
    const ds = step * this.dem.pixelSizeX;
    const hL = this.sampleHeight(x - ds, z);
    const hR = this.sampleHeight(x + ds, z);
    const hD = this.sampleHeight(x, z - ds);
    const hU = this.sampleHeight(x, z + ds);
    const dzdx = (hR - hL) / (2 * ds);
    const dzdz = (hU - hD) / (2 * ds);
    const slope = Math.sqrt(dzdx * dzdx + dzdz * dzdz);
    if (slope < 0.0087) return NaN;     // tan(0.5°) ≈ 0.0087
    // Downhill direction is opposite the gradient: descend = -∇h.
    return Math.atan2(-dzdx, -dzdz);
  }

  /**
   * Concavity: average-of-4-neighbours minus centre, in metres.
   * Positive = bowl/depression (water collects); negative = ridge.
   * `step` in DEM cells controls scale; use larger steps to find broader bowls.
   */
  sampleConcavity(x, z, step = 8) {
    const ds = step * this.dem.pixelSizeX;
    const hC = this.sampleHeight(x, z);
    const hL = this.sampleHeight(x - ds, z);
    const hR = this.sampleHeight(x + ds, z);
    const hD = this.sampleHeight(x, z - ds);
    const hU = this.sampleHeight(x, z + ds);
    return (hL + hR + hD + hU) * 0.25 - hC;
  }

  // ─── Cell scans ────────────────────────────────────────────────────────

  /**
   * Iterate cells. For each, call `predicate(cell)`; if it returns truthy,
   * push a snapshot into the result array.
   *
   * The cell is pooled — its fields are overwritten each iteration. The
   * snapshot we push contains only `{ i, j, x, z, height }`. If you need
   * derived values (slope, concavity, etc.) inside the predicate, call the
   * lazy methods on `cell`; if you need them in the result, compute them
   * yourself with the snapshot.
   *
   * Options:
   *   stride — visit every `stride`th cell in each axis (default 1).
   *   margin — skip cells within `margin` of any edge (default 0). Useful
   *            when the predicate uses neighbour offsets.
   */
  findCells(predicate, { stride = 1, margin = 0 } = {}) {
    const dem = this.dem;
    const W = dem.width, H = dem.height;
    const ww = dem.worldWidth, wh = dem.worldHeight;
    const cell = new TerrainCell(this);
    const out = [];
    for (let j = margin; j < H - margin; j += stride) {
      for (let i = margin; i < W - margin; i += stride) {
        cell.i = i; cell.j = j;
        cell.x = (i / (W - 1) - 0.5) * ww;
        cell.z = (j / (H - 1) - 0.5) * wh;
        cell.height = dem.data[j * W + i];
        if (predicate(cell)) {
          out.push({ i, j, x: cell.x, z: cell.z, height: cell.height });
        }
      }
    }
    return out;
  }

  /** Raw DEM height at integer cell (i, j), edge-clamped. */
  cellHeight(i, j) {
    const dem = this.dem;
    const ci = i < 0 ? 0 : (i >= dem.width ? dem.width - 1 : i);
    const cj = j < 0 ? 0 : (j >= dem.height ? dem.height - 1 : j);
    return dem.data[cj * dem.width + ci];
  }

  /**
   * Rejection-sample scattered world-space points matching the given filters.
   * Useful for "spawn N things spread across the map, optionally not near
   * some anchor / on flat ground / in a particular elevation band."
   *
   * Returns Array<{ x, y, z, slope }>. Each point has y = sampleGroundY,
   * so callers can place meshes on the ground without re-sampling.
   *
   * If maxAttempts is exhausted before count is satisfied, returns whatever
   * was found — caller decides whether to error.
   *
   * Options:
   *   count          — how many points to return.
   *   worldFraction  — stay inside (-w/2*frac, +w/2*frac) of the DEM extent.
   *                    Default 0.85 keeps points clear of the edge fade.
   *   awayFrom       — { x, z, distance } — reject points within `distance`
   *                    metres of (x, z). Used to keep things off the spawn.
   *   minSlope/maxSlope — slope-radian band. Default: any.
   *   minElevation/maxElevation — height band in metres. Default: any.
   *   maxAttempts    — give up after this many random rolls (default 200).
   */
  samplePoints({
    count,
    worldFraction = 0.85,
    awayFrom = null,
    minSlope = -Infinity,
    maxSlope = Infinity,
    minElevation = -Infinity,
    maxElevation = Infinity,
    maxAttempts = 200,
  } = {}) {
    if (!count || count <= 0) return [];
    const out = [];
    const halfW = this.dem.worldWidth * 0.5 * worldFraction;
    const halfH = this.dem.worldHeight * 0.5 * worldFraction;
    const minDist2 = awayFrom ? awayFrom.distance * awayFrom.distance : 0;

    for (let attempt = 0; attempt < maxAttempts && out.length < count; attempt++) {
      const x = (Math.random() * 2 - 1) * halfW;
      const z = (Math.random() * 2 - 1) * halfH;
      if (awayFrom) {
        const dx = x - awayFrom.x, dz = z - awayFrom.z;
        if (dx * dx + dz * dz < minDist2) continue;
      }
      const y = this.sampleGroundY(x, z);
      if (y < minElevation || y > maxElevation) continue;
      // Slope check is only worth running if the caller asked for one — it
      // costs 4 sampleHeight calls.
      let slope = 0;
      if (minSlope > -Infinity || maxSlope < Infinity) {
        slope = this.sampleSlope(x, z);
        if (slope < minSlope || slope > maxSlope) continue;
      }
      out.push({ x, y, z, slope });
    }
    return out;
  }

  /** Convert a DEM cell index to world (x, z). */
  cellToWorld(i, j) {
    const dem = this.dem;
    return {
      x: (i / (dem.width - 1) - 0.5) * dem.worldWidth,
      z: (j / (dem.height - 1) - 0.5) * dem.worldHeight,
    };
  }

  /** Convert metres to whole DEM cells, rounded. */
  metresToCells(m) {
    return Math.max(1, Math.round(m / this.dem.pixelSizeX));
  }
}

/**
 * Pooled cell handle passed to findCells predicates. Each lazy method
 * recomputes from the cell's current (i, j, x, z) — fine for predicates,
 * but don't cache the cell itself across iterations.
 */
class TerrainCell {
  constructor(query) {
    this._q = query;
    this.i = 0; this.j = 0;
    this.x = 0; this.z = 0;
    this.height = 0;
  }
  slope(step = 4)      { return this._q.sampleSlope(this.x, this.z, step); }
  aspect(step = 4)     { return this._q.sampleAspect(this.x, this.z, step); }
  concavity(step = 8)  { return this._q.sampleConcavity(this.x, this.z, step); }
  /** Raw DEM height at neighbour offset (di, dj), edge-clamped. */
  neighbourHeight(di, dj) {
    const dem = this._q.dem;
    const ni = clamp(this.i + di, 0, dem.width - 1);
    const nj = clamp(this.j + dj, 0, dem.height - 1);
    return dem.data[nj * dem.width + ni];
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
