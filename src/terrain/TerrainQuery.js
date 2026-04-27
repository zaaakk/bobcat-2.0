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
  constructor({ dem, terrainPlaneSize, terrainSegments, detailNoise = null, patchSpacing = null }) {
    this.dem = dem;
    this.planeSize = terrainPlaneSize;
    this.segments = terrainSegments;
    // Optional sub-DEM detail. When set, sampleHeight returns DEM + detail
    // so groundY queries agree with the GPU's vertex displacement.
    this.detailNoise = detailNoise;
    // When the high-res detail patch is in play, sampleGroundY needs to
    // triangulate at the patch's vertex grid (~0.3m), not the base mesh's
    // ~26m grid — otherwise the cat samples a smoothed surface and walks
    // through the visible bumps. World.js sets this from the patch.
    this.patchSpacing = patchSpacing;
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
   * the GPU's texture sampling convention. If a detail noise field is
   * configured, its bilinear contribution is added on top — this keeps the
   * sample in lockstep with the vertex shader's per-vertex displacement.
   *
   * The carve layer (signed bowl depressions for water pools) is also added,
   * outside the detail mask, so the bobcat's grounding tracks into pools
   * even where the macro mask kills surface detail.
   */
  sampleHeight(x, z) {
    const base = this._sampleDemHeight(x, z);
    if (!this.detailNoise) return base;
    return base + this.sampleDetail(x, z) + this.sampleCarve(x, z);
  }

  /** Carve depth in metres at (x, z). Negative or zero. */
  sampleCarve(x, z) {
    const dn = this.detailNoise;
    if (!dn || !dn.carve) return 0;
    const c = dn.carve;
    const src = c.renderData;
    const u = (x / c.worldWidth  + 0.5) * c.width  - 0.5;
    const v = (z / c.worldHeight + 0.5) * c.height - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const fx = u - x0, fy = v - y0;
    const cx0 = clamp(x0, 0, c.width - 1);
    const cy0 = clamp(y0, 0, c.height - 1);
    const cx1 = clamp(x0 + 1, 0, c.width - 1);
    const cy1 = clamp(y0 + 1, 0, c.height - 1);
    const h00 = src[cy0 * c.width + cx0];
    const h10 = src[cy0 * c.width + cx1];
    const h01 = src[cy1 * c.width + cx0];
    const h11 = src[cy1 * c.width + cx1];
    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    return (h0 * (1 - fy) + h1 * fy) * c.amp;
  }

  /** DEM-only height (no detail). Useful for pre-detail analysis. */
  _sampleDemHeight(x, z) {
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
   * Detail-noise displacement in metres at (x, z). Bilinear, half-pixel
   * correct, samples renderData (post-half-float quantisation) so values
   * match the GPU's texture lookup bit-for-bit.
   *
   * Two layers, both sampled the same way the shader does them:
   *
   *   1. Ridged multifractal — the baked texture, in [0, 1]. Multiplied by
   *      ridgeAmp to give caprock-style metre-scale bumps.
   *   2. Bedding pulse — sin(elevation/period) thresholded; gives horizontal
   *      bench lines at fixed vertical intervals. Domain-warped by the
   *      ridge field so the lines wander like real outcrops.
   *
   * Both layers are unsigned (always lift, never lower) so the surface
   * gets bumpier without dipping below the DEM. Returns 0 with no detail.
   *
   * Note: the bedding pulse needs the *base* DEM height as input, not the
   * already-displaced surface — otherwise we'd have a feedback loop. This
   * matches the GPU shader, which reads hDem before adding the pulse.
   */
  sampleDetail(x, z) {
    const dn = this.detailNoise;
    if (!dn) return 0;
    // Broad layer (world-aligned ridged FBM + bedding pulse).
    const ridge = this._sampleRidge01(x, z);
    const baseDem = this._sampleDemHeight(x, z);
    const warpedH = baseDem + ridge * dn.bedWarpAmp;
    const bedTau = 6.283185307179586 / dn.bedPeriod;
    const pulse = Math.max(0, Math.sin(warpedH * bedTau) - 0.5) * 2;
    // Fine layer (tile-wrapped FBM in [-1, 1]), domain-warped by the
    // broad ridge value so the 16m tile pattern doesn't read as regular.
    const fine = dn.fine ? this._sampleFineTile(x + ridge * 4.0, z + ridge * 3.0) : 0;
    const fineAmp = dn.fine ? dn.fine.amp : 0;
    // Two macro masks. The general one gates the smooth ridge + fine
    // layers; the stricter bench mask keeps stairsteps confined to
    // clearly-ridged areas (avoids partial-mask stairsteps in transitions).
    const mask      = smoothstep(dn.maskLo,      dn.maskHi,      ridge);
    const benchMask = smoothstep(dn.benchMaskLo, dn.benchMaskHi, ridge);
    return ridge * dn.ridgeAmp * mask
         + pulse * dn.bedAmp   * benchMask
         + fine  * fineAmp     * mask;
  }

  /**
   * Bilinear lookup of the fine-tile texture in [-1, 1], with repeat wrap.
   * Mirrors the GPU's RepeatWrapping + LinearFilter combination.
   */
  _sampleFineTile(x, z) {
    const fine = this.detailNoise.fine;
    const src = fine.renderData;
    const W = fine.width, H = fine.height;
    // GPU: uv = worldXZ / tileSize, then texel idx = uv * W - 0.5
    const fu = (x / fine.tileSize) * W - 0.5;
    const fv = (z / fine.tileSize) * H - 0.5;
    const x0 = Math.floor(fu), y0 = Math.floor(fv);
    const fx = fu - x0, fy = fv - y0;
    // Repeat wrap (handles negatives via the (% + W) % W idiom).
    const wx0 = ((x0 % W) + W) % W;
    const wx1 = ((x0 + 1) % W + W) % W;
    const wy0 = ((y0 % H) + H) % H;
    const wy1 = ((y0 + 1) % H + H) % H;
    const h00 = src[wy0 * W + wx0];
    const h10 = src[wy0 * W + wx1];
    const h01 = src[wy1 * W + wx0];
    const h11 = src[wy1 * W + wx1];
    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    return h0 * (1 - fy) + h1 * fy;
  }

  /** Bilinear lookup of the ridged FBM texture in [0, 1]. */
  _sampleRidge01(x, z) {
    const dn = this.detailNoise;
    const src = dn.renderData;
    const u = (x / dn.worldWidth  + 0.5) * dn.width  - 0.5;
    const v = (z / dn.worldHeight + 0.5) * dn.height - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const fx = u - x0, fy = v - y0;
    const cx0 = clamp(x0, 0, dn.width - 1);
    const cy0 = clamp(y0, 0, dn.height - 1);
    const cx1 = clamp(x0 + 1, 0, dn.width - 1);
    const cy1 = clamp(y0 + 1, 0, dn.height - 1);
    const h00 = src[cy0 * dn.width + cx0];
    const h10 = src[cy0 * dn.width + cx1];
    const h01 = src[cy1 * dn.width + cx0];
    const h11 = src[cy1 * dn.width + cx1];
    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    return h0 * (1 - fy) + h1 * fy;
  }

  /**
   * Height the rendered terrain mesh actually draws at (x, z). Three's
   * PlaneGeometry triangulates with the V01↔V10 diagonal — using the wrong
   * split causes visible floating/sinking on slopes. Use this for character
   * grounding and any visual-alignment query.
   *
   * When a detail patch is configured (patchSpacing set), we triangulate at
   * the patch's vertex grid (~0.29m), since that's the highest-resolution
   * mesh covering the cat's position — its surface has 2-5m bumps that the
   * coarse base-mesh triangulation (~26m) averages away. Without this fix
   * the cat visibly clips through bedding shelves and ridges.
   */
  sampleGroundY(x, z) {
    const dx = this.patchSpacing != null
      ? this.patchSpacing
      : this.planeSize / this.segments;
    // Anchor the cell at multiples of dx (matches both the base mesh's
    // PlaneGeometry vertex grid AND the patch's grid-snapped vertices).
    const x0w = Math.floor(x / dx) * dx;
    const y0w = Math.floor(z / dx) * dx;
    const x1w = x0w + dx;
    const y1w = y0w + dx;
    const fx = (x - x0w) / dx;
    const fy = (z - y0w) / dx;
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

function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
