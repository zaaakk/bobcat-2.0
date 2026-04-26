/**
 * Species definitions.
 *
 * Each species declares:
 *   - habitat suitability(slopeT, elevT, drainage, macro) → 0..1
 *   - clumping field: which low-frequency noise drives its density and how
 *     sharply it concentrates. Bunchgrass forms broad carpets, prickly pear
 *     forms big patches, juniper is sparse and isolated, mesquite scattered.
 *
 * Each species has its OWN noise seed and length-scale so different species
 * cluster in different places, not in lock-step.
 */

const HABITAT = {
  smooth(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }
};

export const SPECIES = [
  {
    id: 0,
    name: 'mesquite',
    file: '/assets/plants/mesquite.png',
    atlasIndex: 0,
    height: [3.2, 5.0],
    aspect: 1.4,
    densityScale: 0.9,
    // Scattered individuals — broad noise, mild contrast
    clumpSeed: 0.13, clumpFreq: 0.0012, clumpSharpness: 1.0, clumpFloor: 0.18,
    suitability: (slopeT, elevT, drainage) =>
      Math.max(0, drainage * 1.4 - slopeT * 1.5) *
      HABITAT.smooth(0.0, 0.55, 1 - elevT)
  },
  {
    id: 1,
    name: 'yucca',
    file: '/assets/plants/yucca.png',
    atlasIndex: 1,
    height: [2.0, 3.4],
    aspect: 0.7,
    densityScale: 0.7,
    // Solitary on rocky slopes
    clumpSeed: 0.27, clumpFreq: 0.003, clumpSharpness: 2.2, clumpFloor: 0.05,
    suitability: (slopeT, elevT) =>
      HABITAT.smooth(0.18, 0.55, slopeT) * HABITAT.smooth(0.2, 0.7, elevT)
  },
  {
    id: 2,
    name: 'sotol',
    file: '/assets/plants/sotol.png',
    atlasIndex: 2,
    height: [1.2, 2.0],
    aspect: 1.0,
    densityScale: 0.8,
    // Clumped on rocky slopes
    clumpSeed: 0.41, clumpFreq: 0.002, clumpSharpness: 1.5, clumpFloor: 0.10,
    suitability: (slopeT, elevT) =>
      HABITAT.smooth(0.10, 0.45, slopeT) * HABITAT.smooth(0.1, 0.6, elevT)
  },
  {
    id: 3,
    name: 'pricklypear',
    file: '/assets/plants/pricklypear.png',
    atlasIndex: 3,
    height: [0.8, 1.5],
    aspect: 1.1,
    densityScale: 1.5,
    // Big patches — large clumps with sharp boundaries
    clumpSeed: 0.59, clumpFreq: 0.0006, clumpSharpness: 2.6, clumpFloor: 0.04,
    suitability: (slopeT, elevT, drainage) =>
      HABITAT.smooth(0.20, 0.0, slopeT) * (0.6 + 0.4 * (1 - drainage)) *
      HABITAT.smooth(0.0, 0.7, 1 - elevT)
  },
  {
    id: 4,
    name: 'bunchgrass',
    file: '/assets/plants/bunchgrass.png',
    atlasIndex: 4,
    height: [0.45, 0.85],
    aspect: 1.2,
    densityScale: 2.4,
    // Carpets — gentle low-frequency variation, high baseline so it always
    // appears, plus high-frequency micro-clump for texture inside the carpet
    clumpSeed: 0.71, clumpFreq: 0.0008, clumpSharpness: 0.8, clumpFloor: 0.45,
    suitability: (slopeT, elevT) =>
      HABITAT.smooth(0.25, 0.0, slopeT) * (0.4 + 0.6 * elevT)
  },
  {
    id: 5,
    name: 'juniper',
    file: '/assets/plants/juniper.png',
    atlasIndex: 5,
    height: [2.5, 4.5],
    aspect: 0.9,
    densityScale: 0.45,
    // Isolated trees on mid-elev slopes — sparse, no clumping
    clumpSeed: 0.83, clumpFreq: 0.0025, clumpSharpness: 1.8, clumpFloor: 0.06,
    suitability: (slopeT, elevT) =>
      HABITAT.smooth(0.06, 0.30, slopeT) * HABITAT.smooth(0.25, 0.85, elevT) *
      (1 - HABITAT.smooth(0.55, 0.90, slopeT))   // not on cliffs
  }
];
