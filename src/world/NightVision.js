import * as THREE from 'three';

/**
 * Two-pass night-vision lens.
 *
 *   1. The whole 3D scene renders into a render target.
 *   2. A full-screen quad samples that target. Pixels within a soft circle in
 *      the centre of the screen get a feline night-vision look (green tint,
 *      gain, gentle scanline + grain) at night; outside the circle the source
 *      is passed through unchanged.
 *
 * Strength fades to zero during daylight, so the effect is invisible at noon
 * and only kicks in when the sun is below the horizon. A small chromatic
 * vignette around the lens edge sells it as a viewer's eye (i.e. the bobcat's
 * gaze) rather than a screen filter.
 */
export function createNightVision(renderer) {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: true,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat
  });

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const uniforms = {
    uScene: { value: target.texture },
    uTime: { value: 0 },
    uNight: { value: 0 },        // 0..1 — 0 = no effect, 1 = full night vision
    uAspect: { value: 1 },
    uLensCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uLensRadius: { value: 0.22 }, // fraction of min(screen w, h)
    uLensFeather: { value: 0.10 }, // soft edge
    uSaturation: { value: 1.0 },   // user grade (1 = no change)
    uBrightness: { value: 1.0 },   // user grade (1 = no change)
    uContrast: { value: 1.0 }      // user grade (1 = no change)
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D uScene;
      uniform float uTime, uNight, uAspect;
      uniform vec2 uLensCenter;
      uniform float uLensRadius, uLensFeather;
      uniform float uSaturation, uBrightness, uContrast;
      varying vec2 vUv;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

      vec3 grade(vec3 c) {
        // saturation around luma
        float lum = dot(c, vec3(0.299, 0.587, 0.114));
        c = mix(vec3(lum), c, uSaturation);
        // contrast around mid-grey
        c = (c - 0.5) * uContrast + 0.5;
        // brightness as a multiplier
        c *= uBrightness;
        return c;
      }

      void main() {
        vec3 src = grade(texture2D(uScene, vUv).rgb);

        // Scaled UV so the lens reads as a circle, not an ellipse.
        vec2 d = vUv - uLensCenter;
        d.x *= uAspect;
        float r = length(d);
        // Lens mask: 1 inside, smooth fade across feather, 0 outside.
        float lens = 1.0 - smoothstep(uLensRadius, uLensRadius + uLensFeather, r);
        float k = lens * uNight;
        if (k <= 0.001) {
          gl_FragColor = vec4(src, 1.0);
          return;
        }

        // Feline rod-vision approximation: gain way up, push toward
        // green-cyan, slight contrast crush in the highlights.
        float lum = dot(src, vec3(0.299, 0.587, 0.114));
        vec3 nv = vec3(lum * 0.18, lum * 1.55, lum * 0.85) + vec3(0.02, 0.05, 0.04);
        nv = pow(nv, vec3(0.85));

        // Subtle grain — animated noise scaled by lens strength.
        float n = hash(floor(vUv * vec2(640.0, 360.0)) + floor(uTime * 18.0));
        nv += (n - 0.5) * 0.06;

        // Soft horizontal scanline so it reads as "viewer", not just a tint.
        float scan = 0.92 + 0.08 * sin(vUv.y * 700.0);
        nv *= scan;

        // Slight CA / chromatic edge: pull the green channel slightly inward
        // toward the lens centre at the lens rim.
        float rimT = smoothstep(uLensRadius - 0.04, uLensRadius + uLensFeather, r);
        vec2 dirCA = normalize(d + 1e-5) * 0.0035 * rimT * uNight;
        float gShift = texture2D(uScene, vUv - dirCA).g;
        vec3 srcShifted = vec3(src.r, mix(src.g, gShift, rimT * uNight), src.b);
        nv = mix(nv, vec3(dot(srcShifted, vec3(0.299, 0.587, 0.114))) * vec3(0.18, 1.55, 0.85), 0.0);

        // Edge darken so the lens reads as an iris, not a hole.
        float vignette = smoothstep(uLensRadius + uLensFeather * 0.6, uLensRadius - 0.02, r);
        nv *= 0.85 + 0.25 * vignette;

        gl_FragColor = vec4(mix(src, nv, k), 1.0);
      }
    `
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  scene.add(quad);

  function resize(w, h) {
    target.setSize(w, h);
    uniforms.uAspect.value = w / h;
  }
  resize(renderer.domElement.width || 1, renderer.domElement.height || 1);

  function render(worldScene, worldCamera, time, nightAmount) {
    uniforms.uTime.value = time;
    uniforms.uNight.value = THREE.MathUtils.clamp(nightAmount, 0, 1);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(worldScene, worldCamera);
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }

  return { render, resize, uniforms };
}
