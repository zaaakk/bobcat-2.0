/**
 * Species definitions. Each species has a habitat function that returns 0..1
 * suitability given (slopeT, elevT, drainage, noise). PlacementEngine multiplies
 * suitability by base density to decide whether to spawn at a candidate point.
 *
 * slopeT: 0 (flat) → 1 (cliff)
 * elevT:  0 (lowest in DEM) → 1 (highest)
 * drainage: 0 (ridge) → 1 (concave wash)
 *
 * AVAILABLE PNGS map to closest Chihuahuan-desert ecotypes:
 *   mesquite     — drainage / arroyo edges (stand-in for cottonwood)
 *   yucca        — rocky slopes
 *   sotol        — rocky slopes
 *   pricklypear  — gravel flats
 *   bunchgrass   — grass clumps on mid-elev flats
 */

export const SPECIES = [
  {
    id: 0,
    name: 'mesquite',
    file: '/assets/plants/mesquite.png',
    atlasIndex: 0,
    height: [3.5, 5.5],
    aspect: 1.4,    // wider than tall
    crossQuads: 2,  // mid-tier crossed quads
    densityScale: 1.0,
    suitability: (slopeT, elevT, drainage) =>
      Math.max(0, drainage * 1.4 - slopeT * 1.5) *
      smooth(0.0, 0.55, 1 - elevT)
  },
  {
    id: 1,
    name: 'yucca',
    file: '/assets/plants/yucca.png',
    atlasIndex: 1,
    height: [2.2, 3.6],
    aspect: 0.7,
    crossQuads: 2,
    densityScale: 0.8,
    suitability: (slopeT, elevT) =>
      smooth(0.18, 0.55, slopeT) * smooth(0.2, 0.7, elevT)
  },
  {
    id: 2,
    name: 'sotol',
    file: '/assets/plants/sotol.png',
    atlasIndex: 2,
    height: [1.4, 2.2],
    aspect: 1.0,
    crossQuads: 2,
    densityScale: 0.9,
    suitability: (slopeT, elevT) =>
      smooth(0.10, 0.45, slopeT) * smooth(0.1, 0.6, elevT)
  },
  {
    id: 3,
    name: 'pricklypear',
    file: '/assets/plants/pricklypear.png',
    atlasIndex: 3,
    height: [0.9, 1.6],
    aspect: 1.1,
    crossQuads: 2,
    densityScale: 1.3,
    suitability: (slopeT, elevT, drainage) =>
      smooth(0.20, 0.0, slopeT) * (0.6 + 0.4 * (1 - drainage)) * smooth(0.0, 0.7, 1 - elevT)
  },
  {
    id: 4,
    name: 'bunchgrass',
    file: '/assets/plants/bunchgrass.png',
    atlasIndex: 4,
    height: [0.5, 0.9],
    aspect: 1.2,
    crossQuads: 1,
    densityScale: 1.6,
    suitability: (slopeT, elevT) =>
      smooth(0.25, 0.0, slopeT) * (0.4 + 0.6 * elevT)
  }
];

function smooth(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
