import { asset } from '../assetPath.js';
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

/**
 * Slope gates are calibrated against the real DEM's measured slopeT
 * distribution, NOT against a 0..1 intuition. The Mapzen z13 tile this world
 * loads is heavily smoothed: slopeT p50 = 0.09, p90 = 0.21, p99 = 0.28, and
 * the single steepest point on 21km of terrain is 0.50. Gates written for
 * textbook values ("rocky slope = 0.55") therefore never open at all, which
 * is what had lechuguilla, sotol and yucca sitting at 0% of placements.
 *
 * Read the numbers below as percentiles of this terrain:
 *   0.04  p27    0.10  p55    0.18  p83    0.22  p92    0.28  p99
 *
 * If the carved-displacement detail layer ever lands and steepens the local
 * relief, these want re-measuring rather than re-guessing.
 */
/**
 * Fixed size of the per-species uniform arrays in the vegetation shaders.
 * Must be >= SPECIES.length; there is an assert for that below.
 */
export const MAX_SPECIES = 16;

const HABITAT = {
  smooth(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  },

  /**
   * Chihuahuan influence at this point, 0..1 — the ecotone axis.
   *
   * The setting is the Devils River country on the western Edwards Plateau,
   * where the plateau's juniper-grassland grades into Chihuahuan desert
   * scrub. That grade is a mosaic, not a line: the two floras interfinger
   * over kilometres, with the desert element taking the hot low ground and
   * the plateau element holding the canyons and higher divides. `macro` is
   * the broad regional axis; low elevation reinforces it.
   *
   * Lechuguilla is the species that actually marks this boundary on the
   * ground — its eastern limit runs through exactly this country — so it
   * leans on this hardest, with creosote close behind.
   */
  desert(macro, elevT) {
    return HABITAT.smooth(0.22, 0.78, macro * 0.72 + (1 - elevT) * 0.28);
  }
};

export const SPECIES = [
  {
    id: 0,
    name: 'mesquite',
    file: asset('plants/mesquite.png'),
    atlasIndex: 0,
    height: [2.0, 4.4],
    aspect: 1.4,
    // Honey mesquite runs the low ground the way juniper runs the slopes, so
    // it gets the second-heaviest weight and its own banded carpet. Where the
    // two overlap juniper wins (see ECOLOGY) and the mesquite thins out,
    // which keeps the two carpets reading as separate stands.
    densityScale: 2.8,
    clumpSeed: 0.13, clumpFreq: 0.0014, clumpSharpness: 1.0, clumpFloor: 0.04,
    clumpBand: [0.42, 0.60], clumpDetail: 0.34,
    suitability: (slopeT, elevT, drainage) =>
      (0.30 + 0.70 * HABITAT.smooth(0.14, 0.02, slopeT)) *
      HABITAT.smooth(0.30, 0.75, 1 - elevT) *
      (0.55 + 0.45 * drainage)
  },
  {
    id: 1,
    name: 'yucca',
    file: asset('plants/yucca.png'),
    atlasIndex: 1,
    height: [2.0, 3.4],
    aspect: 0.7,
    densityScale: 1.9,
    // Solitary on rocky slopes; Torrey yucca runs right across the ecotone.
    clumpSeed: 0.27, clumpFreq: 0.003, clumpSharpness: 2.2, clumpFloor: 0.05,
    suitability: (slopeT, elevT, drainage, macro) =>
      HABITAT.smooth(0.08, 0.22, slopeT) * HABITAT.smooth(0.2, 0.7, elevT) *
      (0.6 + 0.4 * HABITAT.desert(macro, elevT))
  },
  {
    id: 2,
    name: 'sotol',
    file: asset('plants/sotol.png'),
    atlasIndex: 2,
    height: [1.2, 2.0],
    aspect: 1.0,
    densityScale: 1.3,
    // Clumped on rocky slopes. Sotol spans the whole ecotone — it is as much
    // a Stockton Plateau plant as a Chihuahuan one — so it only leans mildly.
    clumpSeed: 0.41, clumpFreq: 0.002, clumpSharpness: 1.5, clumpFloor: 0.10,
    suitability: (slopeT, elevT, drainage, macro) =>
      HABITAT.smooth(0.05, 0.17, slopeT) * HABITAT.smooth(0.1, 0.6, elevT) *
      (0.55 + 0.45 * HABITAT.desert(macro, elevT))
  },
  {
    id: 3,
    name: 'pricklypear',
    file: asset('plants/pricklypear.png'),
    atlasIndex: 3,
    height: [0.8, 1.5],
    aspect: 1.1,
    densityScale: 2.6,
    // Big patches — broad clump field with high contrast inside the patch.
    // Inside an accepted cell, drop a small cluster of pads at varying radii.
    clumpSeed: 0.59, clumpFreq: 0.0007, clumpSharpness: 2.4, clumpFloor: 0.10,
    clusterCount: [3, 7],
    clusterRadius: [0.4, 2.4],
    suitability: (slopeT, elevT, drainage) =>
      HABITAT.smooth(0.22, 0.0, slopeT) * (0.6 + 0.4 * (1 - drainage)) *
      HABITAT.smooth(0.0, 0.8, 1 - elevT)
  },
  {
    id: 4,
    name: 'bunchgrass',
    file: asset('plants/bunchgrass.png'),
    atlasIndex: 4,
    height: [0.45, 0.85],
    aspect: 1.2,
    densityScale: 2.6,
    // Tight multi-stem clumps instead of a single tuft every few metres.
    clumpSeed: 0.71, clumpFreq: 0.0046, clumpSharpness: 2.8, clumpFloor: 0.05,
    clusterCount: [3, 6],
    clusterRadius: [0.35, 1.15],
    // Plateau grassland element — gives way to desert scrub westward.
    suitability: (slopeT, elevT, drainage, macro) =>
      HABITAT.smooth(0.25, 0.0, slopeT) * (0.4 + 0.6 * elevT) *
      (1 - 0.40 * HABITAT.desert(macro, elevT))
  },
  {
    id: 5,
    name: 'juniper',
    file: asset('plants/juniper.png'),
    atlasIndex: 5,
    // Wide range on purpose: a brake is a lumpy canopy of half-grown mounds
    // crowded around mature trees, not a row of matched cones.
    height: [1.4, 5.2],
    aspect: 0.9,
    // The plant that defines the Edwards Plateau. Cedar brakes close into a
    // continuous canopy across whole hillsides, so this is the heaviest
    // weight in the set — it has to beat the understory in the per-cell
    // lottery everywhere it grows, not merely place well.
    densityScale: 3.2,
    // clumpBand (not clumpSharpness) is what makes a brake a carpet: the
    // field saturates over most of the patch and drops to the floor within a
    // few tens of metres. clumpDetail ravels the edge so it follows the
    // ground instead of reading as a simplex oval. The near-zero floor is
    // what lets the caliche openings between brakes be genuinely bare.
    clumpSeed: 0.83, clumpFreq: 0.0016, clumpSharpness: 1.8, clumpFloor: 0.02,
    clumpBand: [0.38, 0.56], clumpDetail: 0.3,
    suitability: (slopeT, elevT, drainage, macro) => {
      // Cedar takes slopes, canyon rims and mesa caps alike — the clump field
      // carves it into brakes, so suitability only has to rule out the places
      // it genuinely can't hold: sheer bluff faces and the low bare flats.
      const relief = 0.15 + 0.85 * HABITAT.smooth(0.04, 0.18, slopeT);
      // Redberry juniper carries well into the desert end, so the brakes
      // thin rather than stop — they just stop closing into solid carpet.
      return relief * HABITAT.smooth(0.18, 0.42, elevT) *
        (1 - HABITAT.smooth(0.28, 0.45, slopeT)) *   // not on cliffs
        (1 - 0.62 * HABITAT.desert(macro, elevT));
    }
  },
  {
    id: 6,
    name: 'creosote',
    file: asset('plants/creosote.png'),
    atlasIndex: 6,
    height: [0.9, 1.6],
    aspect: 1.2,
    // Larrea tridentata — the dominant Chihuahuan shrub. Widespread and
    // common, scatters through bajadas and flats but thins on rock + at high
    // elev. Low clumpFreq → broad, gentle bands of preferred density.
    densityScale: 1.8,
    clumpSeed: 0.97, clumpFreq: 0.0010, clumpSharpness: 1.4, clumpFloor: 0.09,
    // Furthest into the desert end of anything here — creosote flats are a
    // Trans-Pecos signature, so it barely registers on the plateau side.
    suitability: (slopeT, elevT, drainage, macro) =>
      Math.max(0, 1.0 - slopeT * 1.6) *
      HABITAT.smooth(0.0, 0.6, 1 - elevT) *
      (0.6 + 0.4 * (1 - drainage)) *
      (0.06 + 0.94 * HABITAT.desert(macro, elevT))
  },
  {
    id: 7,
    name: 'lechugilla',
    file: asset('plants/lechugilla.png'),
    atlasIndex: 7,
    height: [0.5, 0.9],
    aspect: 0.95,
    // Agave lechuguilla — the indicator species of the Chihuahuan desert.
    // Rocky limestone slopes; small, spiny, clusters tightly. Heavy clumps
    // because they reproduce by offsets.
    densityScale: 5.5,
    clumpSeed: 0.05, clumpFreq: 0.0030, clumpSharpness: 2.6, clumpFloor: 0.12,
    clusterCount: [3, 6],
    clusterRadius: [0.25, 1.1],
    // The species that marks the ecotone: near-absent at the plateau end,
    // carpeting rocky limestone slopes at the Chihuahuan end.
    suitability: (slopeT, elevT, drainage, macro) =>
      HABITAT.smooth(0.06, 0.20, slopeT) * HABITAT.smooth(0.15, 0.7, elevT) *
      (1 - HABITAT.smooth(0.26, 0.40, slopeT)) *   // not on sheer cliffs
      (0.12 + 0.88 * HABITAT.desert(macro, elevT))
  },
  {
    id: 8,
    name: 'velvetmesquite',
    file: asset('plants/velvetmesquite.png?v=2'),
    atlasIndex: 8,
    height: [4.0, 6.5],
    aspect: 1.1,
    // Prosopis velutina — bigger tree-form mesquite. Less common than the
    // shrubby form (id 0), follows arroyos and lowland drainage where there's
    // more water. Sparse + tall reads as a different layer.
    densityScale: 0.45,
    clumpSeed: 0.34, clumpFreq: 0.0009, clumpSharpness: 1.6, clumpFloor: 0.10,
    suitability: (slopeT, elevT, drainage) =>
      Math.max(0, drainage * 1.6 - slopeT * 1.8) *
      HABITAT.smooth(0.0, 0.45, 1 - elevT)
  },
  // ---------------------------------------------------------------------
  // Sprites generated with scripts/generate_plant_sprites.py. These six use a
  // different sprite convention from the nine above: their art fills the whole
  // atlas cell and `aspect` is the plant's true width/height, so `height` here
  // is the plant's actual height in metres rather than the height of a mostly
  // empty card. Don't copy height values between the two groups.
  // ---------------------------------------------------------------------
  {
    id: 9,
    name: 'liveoak',
    file: asset('plants/liveoak.png'),
    atlasIndex: 9,
    height: [5.0, 9.5],
    aspect: 1.63,
    // Plateau live oak motts — the other canopy tree of this country, and the
    // one that reads as Hill Country rather than desert. Sparse but large, and
    // it holds the draws and north slopes where there's a little more water.
    densityScale: 0.85,
    clumpSeed: 0.62, clumpFreq: 0.0011, clumpSharpness: 1.6, clumpFloor: 0.03,
    clumpBand: [0.52, 0.70], clumpDetail: 0.30,
    suitability: (slopeT, elevT, drainage, macro) =>
      (0.35 + 0.65 * drainage) *
      HABITAT.smooth(0.02, 0.16, slopeT) * (1 - HABITAT.smooth(0.24, 0.42, slopeT)) *
      HABITAT.smooth(0.15, 0.45, elevT) *
      (1 - 0.75 * HABITAT.desert(macro, elevT))
  },
  {
    id: 10,
    name: 'cenizo',
    file: asset('plants/cenizo.png'),
    atlasIndex: 10,
    height: [0.9, 1.7],
    aspect: 1.37,
    // Silvery grey — the one shrub here that isn't green, so it does a lot of
    // work breaking up the foliage mass. Limestone slopes, right across the
    // ecotone, leaning slightly desertward.
    densityScale: 1.5,
    clumpSeed: 0.18, clumpFreq: 0.0024, clumpSharpness: 1.9, clumpFloor: 0.08,
    suitability: (slopeT, elevT, drainage, macro) =>
      HABITAT.smooth(0.04, 0.18, slopeT) * (1 - HABITAT.smooth(0.30, 0.48, slopeT)) *
      HABITAT.smooth(0.10, 0.50, elevT) *
      (0.65 + 0.35 * HABITAT.desert(macro, elevT))
  },
  {
    id: 11,
    name: 'blackbrush',
    file: asset('plants/blackbrush.png'),
    atlasIndex: 11,
    height: [1.1, 2.2],
    aspect: 1.31,
    // Forms near-impenetrable low thickets on shallow caliche, so it gets a
    // canopy of its own (see ECOLOGY) and a banded clump field like the
    // juniper and mesquite carpets.
    densityScale: 1.25,
    clumpSeed: 0.46, clumpFreq: 0.0018, clumpSharpness: 1.7, clumpFloor: 0.05,
    clumpBand: [0.46, 0.64], clumpDetail: 0.32,
    suitability: (slopeT, elevT, drainage, macro) =>
      (0.40 + 0.60 * HABITAT.smooth(0.20, 0.03, slopeT)) *
      HABITAT.smooth(0.05, 0.40, elevT) *
      (0.45 + 0.55 * HABITAT.desert(macro, elevT))
  },
  {
    id: 12,
    name: 'persimmon',
    file: asset('plants/persimmon.png'),
    atlasIndex: 12,
    height: [2.2, 4.2],
    aspect: 0.76,
    // Texas persimmon — pale smooth multi-trunk understory tree. Genuinely
    // shade-tolerant, so unlike everything else it survives inside the brakes
    // and along their edges.
    densityScale: 0.8,
    clumpSeed: 0.31, clumpFreq: 0.0026, clumpSharpness: 2.0, clumpFloor: 0.06,
    suitability: (slopeT, elevT, drainage, macro) =>
      (0.45 + 0.55 * drainage) *
      HABITAT.smooth(0.03, 0.20, slopeT) * (1 - HABITAT.smooth(0.34, 0.50, slopeT)) *
      HABITAT.smooth(0.12, 0.45, elevT) *
      (1 - 0.45 * HABITAT.desert(macro, elevT))
  },
  {
    id: 13,
    name: 'ocotillo',
    file: asset('plants/ocotillo.png'),
    atlasIndex: 13,
    height: [2.2, 4.0],
    aspect: 0.52,
    // Tall thin wands — a strong vertical accent against all the mounded
    // shrubs. Rocky slopes at the desert end only; it has no business on the
    // plateau side, so it is gated harder than anything except creosote.
    densityScale: 1.2,
    clumpSeed: 0.88, clumpFreq: 0.0027, clumpSharpness: 2.3, clumpFloor: 0.04,
    suitability: (slopeT, elevT, drainage, macro) =>
      HABITAT.smooth(0.05, 0.19, slopeT) * (1 - HABITAT.smooth(0.28, 0.44, slopeT)) *
      HABITAT.smooth(0.12, 0.55, elevT) *
      (0.05 + 0.95 * HABITAT.desert(macro, elevT))
  },
  {
    id: 14,
    name: 'agarita',
    file: asset('plants/agarita.png'),
    atlasIndex: 14,
    height: [0.8, 1.5],
    aspect: 1.10,
    // Stiff blue-grey understory shrub, the usual thing growing out from under
    // a cedar on the plateau side. Clusters because birds drop the berries.
    densityScale: 1.8,
    clumpSeed: 0.74, clumpFreq: 0.0032, clumpSharpness: 2.1, clumpFloor: 0.07,
    clusterCount: [2, 4],
    clusterRadius: [0.6, 2.2],
    suitability: (slopeT, elevT, drainage, macro) =>
      HABITAT.smooth(0.03, 0.17, slopeT) * (1 - HABITAT.smooth(0.30, 0.46, slopeT)) *
      HABITAT.smooth(0.12, 0.48, elevT) *
      (1 - 0.60 * HABITAT.desert(macro, elevT))
  }
];

/**
 * Canopy normals — the "transfer normals from a sphere" trick, in-shader.
 *
 * Real plant-asset workflows bake this in Blender: you wrap the plant in a
 * sphere and transfer the sphere's normals onto the leaves, so the canopy
 * shades as one soft volume instead of each flat leaf catching light on its
 * own. Our foliage is sprite cards, not leaf meshes, but the fix is the same
 * one: shade each vertex with the normal of an implicit blob centred inside
 * the plant rather than with the card's own facing.
 *
 * The blob lives in the plant's unit-height local space (y 0..1, half-width
 * 0.5), so these are all fractions of plant height:
 *   blend        0 = card's own normal, 1 = pure blob normal.
 *                Low for genuinely flat plants (prickly pear pads).
 *   center       height of the blob centre. Tall tree-forms put it high so
 *                the trunk region shades downward, not outward.
 *   radiusY      vertical radius of the blob. Small = squashed/wide canopy.
 *   translucency strength of the backlit transmission glow. Grass and thin
 *                shrubs glow when you look toward the sun; dense conifer
 *                and woody pads barely do.
 */
/**
 * Who closes over whom.
 *
 * canopyWeight    how completely this species' patch shades the ground when
 *                 its clump field saturates. 0 = never closes a canopy.
 * shadeTolerance  what fraction of this species survives under someone
 *                 else's closed canopy. Low = confined to the openings.
 *
 * This is the pair that turns a dense scatter into carpets. Placement draws
 * one species per cell from a score-weighted lottery, so without suppression
 * every cell is an independent draw and nine species come out evenly
 * interleaved — a salt-and-pepper mix — however the densities are tuned. With
 * it, a saturated juniper clump drives the understory scores to near zero and
 * the brake comes out as a solid stand with bare caliche at its edge.
 *
 * Juniper is deliberately the most aggressive and the most tolerant: on the
 * real plateau it invades mesquite and grassland alike and little grows back
 * under a closed cedar canopy. Mesquite closes a canopy of its own but yields
 * to juniper (0.34), so the two form neighbouring stands rather than blending
 * into one mixed thicket.
 */
const ECOLOGY_DEFAULT = { canopyWeight: 0, shadeTolerance: 0.25 };

const ECOLOGY = {
  juniper:        { canopyWeight: 0.92, shadeTolerance: 0.90 },
  mesquite:       { canopyWeight: 0.74, shadeTolerance: 0.34 },
  velvetmesquite: { canopyWeight: 0.55, shadeTolerance: 0.40 },
  // Understory. Bunchgrass hangs on in dappled shade better than the
  // desert succulents, which need open sun and bare rock.
  bunchgrass:     { canopyWeight: 0, shadeTolerance: 0.12 },
  pricklypear:    { canopyWeight: 0, shadeTolerance: 0.10 },
  creosote:       { canopyWeight: 0, shadeTolerance: 0.06 },
  // Colonises rocky slopes so densely it excludes the understory around
  // it, even at half a metre tall — the desert-end counterpart to a brake.
  lechugilla:     { canopyWeight: 0.45, shadeTolerance: 0.10 },
  sotol:          { canopyWeight: 0, shadeTolerance: 0.14 },
  yucca:          { canopyWeight: 0, shadeTolerance: 0.16 },
  // Live oak motts close over as completely as a cedar brake does.
  liveoak:        { canopyWeight: 0.88, shadeTolerance: 0.72 },
  blackbrush:     { canopyWeight: 0.62, shadeTolerance: 0.30 },
  // The one real understory tree here — it is what you actually find growing
  // inside a closed brake, so it is by far the most shade-tolerant.
  persimmon:      { canopyWeight: 0.25, shadeTolerance: 0.85 },
  cenizo:         { canopyWeight: 0, shadeTolerance: 0.20 },
  ocotillo:       { canopyWeight: 0, shadeTolerance: 0.18 },
  agarita:        { canopyWeight: 0, shadeTolerance: 0.55 }
};

const CANOPY_DEFAULT = { blend: 0.82, center: 0.55, radiusY: 0.45, translucency: 0.50 };

const CANOPY = {
  mesquite:       { blend: 0.90, center: 0.62, radiusY: 0.42, translucency: 0.55 },
  yucca:          { blend: 0.72, center: 0.50, radiusY: 0.48, translucency: 0.35 },
  sotol:          { blend: 0.80, center: 0.46, radiusY: 0.44, translucency: 0.45 },
  // Pads are actually flat slabs — keep a good share of the card normal or
  // they lose the edge-on/face-on contrast that makes a pad read as a pad.
  pricklypear:    { blend: 0.45, center: 0.50, radiusY: 0.50, translucency: 0.40 },
  // Tuft: wide and low, and very thin — the strongest backlight in the set.
  bunchgrass:     { blend: 0.85, center: 0.38, radiusY: 0.36, translucency: 0.80 },
  // Dense evergreen — nearly opaque, so almost no transmission.
  juniper:        { blend: 0.95, center: 0.58, radiusY: 0.44, translucency: 0.22 },
  creosote:       { blend: 0.86, center: 0.54, radiusY: 0.44, translucency: 0.62 },
  lechugilla:     { blend: 0.70, center: 0.42, radiusY: 0.42, translucency: 0.40 },
  velvetmesquite: { blend: 0.90, center: 0.68, radiusY: 0.34, translucency: 0.50 },
  liveoak:        { blend: 0.94, center: 0.66, radiusY: 0.36, translucency: 0.42 },
  cenizo:         { blend: 0.88, center: 0.52, radiusY: 0.46, translucency: 0.58 },
  blackbrush:     { blend: 0.86, center: 0.52, radiusY: 0.44, translucency: 0.66 },
  persimmon:      { blend: 0.90, center: 0.62, radiusY: 0.40, translucency: 0.48 },
  // Bare vertical wands, not a canopy — the blob normal would flatten them,
  // so this one keeps most of its card normal.
  ocotillo:       { blend: 0.35, center: 0.55, radiusY: 0.50, translucency: 0.30 },
  agarita:        { blend: 0.88, center: 0.48, radiusY: 0.44, translucency: 0.40 }
};

if (SPECIES.length > MAX_SPECIES) {
  throw new Error(
    `${SPECIES.length} species exceeds MAX_SPECIES (${MAX_SPECIES}); ` +
    'raise it here and the shader uniform arrays follow automatically.');
}

for (const s of SPECIES) {
  s.canopy = { ...CANOPY_DEFAULT, ...(CANOPY[s.name] || {}) };
  Object.assign(s, ECOLOGY_DEFAULT, ECOLOGY[s.name] || {});

  // Placement draws ONE species per candidate cell, but a species with
  // clusterCount then emits several stems from that one win. Left uncorrected
  // that silently multiplies a clustered species' real abundance by its mean
  // cluster size — bunchgrass at densityScale 3.4 and 3-6 stems per win was
  // outnumbering everything else roughly 4.5x more than its number implied,
  // which is why the openings flooded with grass. Dividing it back out makes
  // densityScale mean "how much of this ends up on the ground", which is what
  // it reads as, for clustered and unclustered species alike.
  const meanCluster = s.clusterCount ? (s.clusterCount[0] + s.clusterCount[1]) * 0.5 : 1;
  s.lotteryWeight = s.densityScale / meanCluster;
}
