/**
 * Pick a spawn point for the player: prefer a flattish spot inside the
 * dense inner vegetation zone (so the bobcat lands somewhere with cover and
 * visible plants, not on a bare ridge). The outer DEM also has a coarser
 * vegetation pass for long-distance roaming.
 */
export function chooseSpawnPoint(terrainQuery, maxRadius = 2800) {
  let fallback = {
    x: 0, y: terrainQuery.sampleGroundY(0, 0), z: 0,
    yaw: Math.random() * Math.PI * 2
  };
  let bestScore = -Infinity;

  for (let i = 0; i < 28; i++) {
    const r = Math.sqrt(Math.random()) * maxRadius;
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = terrainQuery.sampleGroundY(x, z);
    const slope = terrainQuery.sampleSlope(x, z, 4);
    const edge = maxRadius - r;
    const score = edge - slope * 1400;
    if (score > bestScore) {
      bestScore = score;
      fallback = { x, y, z, yaw: Math.random() * Math.PI * 2 };
    }
    if (slope < 0.32 && r < maxRadius - 80) {
      return { x, y, z, yaw: Math.random() * Math.PI * 2 };
    }
  }
  return fallback;
}
