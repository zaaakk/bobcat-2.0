import { asset } from '../assetPath.js';
import * as THREE from 'three';

/**
 * Loads the ground-texture set used by TerrainMesh: 7 diffuse maps + 7 tile-
 * specific normal maps (sliced from each material's 2x2 atlas), plus a
 * secondary-diffuse slice (BL quad) used to break up the macro tile repeat
 * at close range.
 *
 * Each `*normals.png` is a 2x2 atlas:
 *   TL (0,0)  diffuse copy   — unused; the original PNG is loaded separately
 *   TR (1,0)  normal map     — sliced into `normals`
 *   BL (0,1)  secondary tile — sliced into `secondaries`. NOMINALLY a depth
 *             map (per the source convention) but in practice some atlases
 *             ship a second photographic diffuse here. Treated as sRGB so
 *             both interpretations blend sensibly into the primary diffuse.
 *   BR (1,1)  ORM (RGB PBR)  — reserved for roughness/metalness pass
 *
 * Returns:
 *   { diffuse, normals, secondaries, defaultNormal }
 */
export async function loadGroundTextures(renderer) {
  const texLoader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy?.() || 8;

  const loadDiffuse = url => new Promise((res, rej) => {
    texLoader.load(url, t => {
      // Mirrored-repeat: each tile is flipped at the seam, so the texture's
      // own edges meet themselves and there are no bright wrap lines even
      // when the source PNGs aren't authored to be tileable.
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = maxAniso;
      res(t);
    }, undefined, rej);
  });

  // Slice cell (cellX, cellY) out of a square 2x2 atlas. Linear colour space
  // is critical for normals/ORM — they encode vectors/data, not perceptual
  // colour.
  const loadAtlasCell = (url, cellX, cellY, { srgb = false } = {}) => new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const half = img.width / 2;
      const c = document.createElement('canvas');
      c.width = c.height = half;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, cellX * half, cellY * half, half, half, 0, 0, half, half);
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = maxAniso;
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      res(tex);
    };
    img.onerror = rej;
    img.src = url;
  });

  const loadAtlas = (url, { srgb = false, gridX = 1, gridY = 1, gutter = 0 } = {}) => new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let source = img;
      if (gutter > 0 && gridX > 1 && gridY > 1) {
        const cellW = img.width / gridX;
        const cellH = img.height / gridY;
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');

        for (let y = 0; y < gridY; y++) {
          for (let x = 0; x < gridX; x++) {
            const sx = x * cellW;
            const sy = y * cellH;
            const dx = sx + gutter;
            const dy = sy + gutter;
            const dw = cellW - gutter * 2;
            const dh = cellH - gutter * 2;

            ctx.drawImage(img, sx, sy, cellW, cellH, dx, dy, dw, dh);
            ctx.drawImage(img, sx, sy, cellW, 1, dx, sy, dw, gutter);
            ctx.drawImage(img, sx, sy + cellH - 1, cellW, 1, dx, sy + cellH - gutter, dw, gutter);
            ctx.drawImage(img, sx, sy, 1, cellH, sx, dy, gutter, dh);
            ctx.drawImage(img, sx + cellW - 1, sy, 1, cellH, sx + cellW - gutter, dy, gutter, dh);
            ctx.drawImage(img, sx, sy, 1, 1, sx, sy, gutter, gutter);
            ctx.drawImage(img, sx + cellW - 1, sy, 1, 1, sx + cellW - gutter, sy, gutter, gutter);
            ctx.drawImage(img, sx, sy + cellH - 1, 1, 1, sx, sy + cellH - gutter, gutter, gutter);
            ctx.drawImage(img, sx + cellW - 1, sy + cellH - 1, 1, 1, sx + cellW - gutter, sy + cellH - gutter, gutter, gutter);
          }
        }
        source = c;
      }

      const tex = new THREE.CanvasTexture(source);
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = maxAniso;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      res(tex);
    };
    img.onerror = rej;
    img.src = url;
  });

  // Single grayscale detail texture, tiled across the world. Used for a
  // close-range "grit" multiplier that breaks up the macro tile repeat under
  // the player. One tap, one sampler, mirrored-repeat handles tiling.
  const loadDetail = url => new Promise((res, rej) => {
    texLoader.load(url, t => {
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = maxAniso;
      t.generateMipmaps = true;
      res(t);
    }, undefined, rej);
  });

  const [tRock, tGrass, tGravel, tSand, tRipBed, tRockyZ, tSandyW, tDefaultNormal,
         normalAtlas, groundDetail] = await Promise.all([
    loadDiffuse(asset('ground/rock.png')),
    loadDiffuse(asset('ground/grassdry.png')),
    loadDiffuse(asset('ground/gravel.png')),
    loadDiffuse(asset('ground/sand.png')),
    loadDiffuse(asset('ground/riparianbed.png')),
    loadDiffuse(asset('ground/rocky-zone.png')),
    loadDiffuse(asset('ground/sandywash.png')),
    loadDiffuse(asset('ground/normal.png')),
    // 4×2 atlas of the 7 per-material normal maps. One sampler.
    loadAtlas(asset('ground/normal-atlas.png'), { gridX: 4, gridY: 2, gutter: 2 }),
    loadDetail(asset('ground/ground-detail.png')),
  ]);

  return {
    diffuse: {
      rock: tRock, grass: tGrass, gravel: tGravel, sand: tSand,
      riparianbed: tRipBed, rockyZone: tRockyZ, sandyWash: tSandyW,
    },
    normalAtlas,
    groundDetail,
    defaultNormal: tDefaultNormal
  };
}
