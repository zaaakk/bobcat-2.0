import * as THREE from 'three';

/**
 * Loads the ground-texture set used by TerrainMesh: 7 diffuse maps + 7 tile-
 * specific normal maps (sliced from each material's 2x2 atlas), plus the
 * legacy `normal.png` (still used as a default).
 *
 * Each `*normals.png` is a 2x2 atlas:
 *   TL (0,0)  diffuse copy   — unused; the original PNG is loaded separately
 *   TR (1,0)  normal map     — what we slice out here
 *   BL (0,1)  depth map      — reserved for parallax pass
 *   BR (1,1)  ORM (RGB PBR)  — reserved for roughness/metalness pass
 *
 * Returns:
 *   { diffuse: { rock, grass, gravel, sand, riparianbed, rockyZone, sandyWash },
 *     normals: { rock, grass, gravel, sand, riparianbed, rockyZone, sandyWash },
 *     defaultNormal }
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

  const [tRock, tGrass, tGravel, tSand, tRipBed, tRockyZ, tSandyW, tDefaultNormal,
         nRock, nGrass, nGravel, nSand, nRipBed, nRockyZ, nSandyW] = await Promise.all([
    loadDiffuse('/assets/ground/rock.png'),
    loadDiffuse('/assets/ground/grassdry.png'),
    loadDiffuse('/assets/ground/gravel.png'),
    loadDiffuse('/assets/ground/sand.png'),
    loadDiffuse('/assets/ground/riparianbed.png'),
    loadDiffuse('/assets/ground/rocky-zone.png'),
    loadDiffuse('/assets/ground/sandywash.png'),
    loadDiffuse('/assets/ground/normal.png'),
    loadAtlasCell('/assets/ground/rocknormals.png', 1, 0),
    loadAtlasCell('/assets/ground/grassdrynormals.png', 1, 0),
    loadAtlasCell('/assets/ground/gravelnormals.png', 1, 0),
    loadAtlasCell('/assets/ground/sandnormals.png', 1, 0),
    loadAtlasCell('/assets/ground/riparianbednormals.png', 1, 0),
    loadAtlasCell('/assets/ground/rockynormals.png', 1, 0),
    loadAtlasCell('/assets/ground/sandywashnormals.png', 1, 0),
  ]);

  return {
    diffuse: {
      rock: tRock, grass: tGrass, gravel: tGravel, sand: tSand,
      riparianbed: tRipBed, rockyZone: tRockyZ, sandyWash: tSandyW,
    },
    normals: {
      rock: nRock, grass: nGrass, gravel: nGravel, sand: nSand,
      riparianbed: nRipBed, rockyZone: nRockyZ, sandyWash: nSandyW,
    },
    defaultNormal: tDefaultNormal
  };
}
