import * as THREE from 'three';

/**
 * A procedural day sky: vertical gradient with horizon haze and sun glow.
 * Rendered as a large inverted box so the camera is always inside.
 */
export function createSky(scene) {
  const geo = new THREE.SphereGeometry(20000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTopColor:    { value: new THREE.Color('#57b5ff') },
      uHorizonColor:{ value: new THREE.Color('#94dcff') },
      uHazeColor:   { value: new THREE.Color('#94dcff') },
      uSunDir: { value: new THREE.Vector3(0.5, 0.85, 0.2).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.95, 0.78) }
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vWorld = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uTopColor, uHorizonColor, uHazeColor, uSunDir, uSunColor;
      varying vec3 vWorld;
      void main() {
        vec3 dir = normalize(vWorld);
        float t = clamp(dir.y * 1.0 + 0.05, 0.0, 1.0);
        vec3 base = mix(uHorizonColor, uTopColor, smoothstep(0.0, 0.6, t));
        // Horizon haze (lower band)
        float haze = smoothstep(0.25, -0.05, dir.y);
        base = mix(base, uHazeColor, haze * 0.6);
        // Sun disk + glow
        float sd = max(0.0, dot(dir, uSunDir));
        float disk = smoothstep(0.998, 0.9995, sd);
        float glow = pow(sd, 64.0) * 0.55;
        base += uSunColor * (disk * 1.6 + glow);
        gl_FragColor = vec4(base, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  scene.add(mesh);
  return { mesh, material: mat };
}
