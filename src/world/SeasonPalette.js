import * as THREE from 'three';

const PRESET_DEFS = {
  // Brush colours sampled off a photo from the Devils River country. The set
  // runs deep-shadow -> lit-canopy, and it is markedly greyer and less
  // saturated than the golden-dry palette that was here before — that is the
  // whole difference between "generic desert" and this particular limestone
  // country. plantHueColor is the mean of the four, and the strength is up
  // because the sprite photos carry their own greener cast to override.
  summer_dry: {
    grassRootColor: '#535c54',
    grassTipColor: '#80876c',
    woodyUnderstoryColor: '#505c3c',
    woodyCanopyColor: '#5e6b40',
    plantHueColor: '#606b4f',
    plantHueStrength: 0.45,
    plantSaturation: 0.80,
    foliageValueScale: 1.0,
    foliageStrength: 0.0
  },
  late_spring: {
    grassRootColor: '#506a34',
    grassTipColor: '#a1bd63',
    woodyUnderstoryColor: '#20381f',
    woodyCanopyColor: '#627f42',
    plantHueColor: '#8fb65a',
    plantHueStrength: 0.28,
    plantSaturation: 1.04,
    foliageValueScale: 1.03,
    foliageStrength: 0.65
  },
  monsoon: {
    grassRootColor: '#405f2e',
    grassTipColor: '#85aa4f',
    woodyUnderstoryColor: '#1f3522',
    woodyCanopyColor: '#4f7442',
    plantHueColor: '#6ea84e',
    plantHueStrength: 0.36,
    plantSaturation: 1.12,
    foliageValueScale: 0.98,
    foliageStrength: 1.0
  },
  winter_dormant: {
    grassRootColor: '#696047',
    grassTipColor: '#a49669',
    woodyUnderstoryColor: '#2b2f25',
    woodyCanopyColor: '#586047',
    plantHueColor: '#a69875',
    plantHueStrength: 0.18,
    plantSaturation: 0.72,
    foliageValueScale: 0.92,
    foliageStrength: 0.0
  }
};

export const SEASON_IDS = Object.freeze(Object.keys(PRESET_DEFS));

export function getSeasonPalette(id = 'summer_dry') {
  const key = PRESET_DEFS[id] ? id : 'summer_dry';
  const src = PRESET_DEFS[key];
  return {
    id: key,
    grassRootColor: new THREE.Color(src.grassRootColor),
    grassTipColor: new THREE.Color(src.grassTipColor),
    woodyUnderstoryColor: new THREE.Color(src.woodyUnderstoryColor),
    woodyCanopyColor: new THREE.Color(src.woodyCanopyColor),
    plantHueColor: new THREE.Color(src.plantHueColor),
    plantHueStrength: src.plantHueStrength,
    plantSaturation: src.plantSaturation,
    foliageValueScale: src.foliageValueScale,
    foliageStrength: src.foliageStrength
  };
}

export function applySeasonPaletteToUniforms(uniforms, palette) {
  if (!uniforms || !palette) return;
  if (uniforms.uGrassRootColor) uniforms.uGrassRootColor.value.copy(palette.grassRootColor);
  if (uniforms.uGrassTipColor) uniforms.uGrassTipColor.value.copy(palette.grassTipColor);
  if (uniforms.uWoodyUnderstoryColor) uniforms.uWoodyUnderstoryColor.value.copy(palette.woodyUnderstoryColor);
  if (uniforms.uWoodyCanopyColor) uniforms.uWoodyCanopyColor.value.copy(palette.woodyCanopyColor);
  if (uniforms.uPlantHueColor) uniforms.uPlantHueColor.value.copy(palette.plantHueColor);
  if (uniforms.uPlantHueStrength) uniforms.uPlantHueStrength.value = palette.plantHueStrength;
  if (uniforms.uPlantSaturation) uniforms.uPlantSaturation.value = palette.plantSaturation;
  if (uniforms.uFoliageValueScale) uniforms.uFoliageValueScale.value = palette.foliageValueScale;
  if (uniforms.uPlantValueScale) uniforms.uPlantValueScale.value = palette.foliageValueScale;
  if (uniforms.uFoliageStrength) uniforms.uFoliageStrength.value = palette.foliageStrength;
  if (uniforms.uMassStrength) uniforms.uMassStrength.value = palette.foliageStrength;
}
