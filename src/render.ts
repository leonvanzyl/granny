// ============================================================================
// render.js — WebGLRenderer + scene + camera + lighting rig + flashlight + post.
// ONE shadow-casting light (the flashlight). FogExp2 matched to camera far.
// Silent Hill / P.T. dread grade driven by a 0..1 `dread` scalar (set from main).
// ============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RENDER } from './config';

const P = RENDER.post;
const BASE_FOG = new THREE.Color(RENDER.fogColor);
const DREAD_FOG = new THREE.Color(RENDER.fogColorDread);

const PostShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: new THREE.Vector3(P.vignetteRadius, P.vignetteSoftness, P.vignetteStrength) },
    uChroma: { value: P.chroma },
    uDread: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDesat: { value: new THREE.Vector2(P.desatCalm, P.desatDread) },
    uLift: { value: new THREE.Vector2(P.liftCalm, P.liftDread) },
    uCrush: { value: P.crushGain },
    uTintShadow: { value: new THREE.Color().fromArray(P.tintShadow) },
    uTintHi: { value: new THREE.Color().fromArray(P.tintHi) },
    uTintAmt: { value: new THREE.Vector2(P.tintAmtCalm, P.tintAmtDread) },
    uBreathRate: { value: P.breathRateCalm },
    uGrainScale: { value: P.grainScale },
    uGrainSeed: { value: 0 },
    uMobile: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uChroma, uDread, uCrush, uBreathRate, uGrainScale, uGrainSeed, uMobile;
    uniform vec3 uVignette, uTintShadow, uTintHi;
    uniform vec2 uResolution, uDesat, uLift, uTintAmt;
    float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv; vec2 d = uv - 0.5; float r = length(d);
      // chromatic aberration
      float ca = uChroma * r * 2.0;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + d*ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - d*ca).b;
      // ---- dread color grade (linear, pre-ACES OutputPass) ----
      float luma = dot(col, vec3(0.299,0.587,0.114));
      float ds = mix(uDesat.x, uDesat.y, uDread); if (uMobile > 0.5) ds = min(ds, 0.40);
      col = mix(col, vec3(luma), ds);
      col = col * uCrush + mix(uLift.x, uLift.y, uDread);
      float ta = mix(uTintAmt.x, uTintAmt.y, uDread); if (uMobile > 0.5) ta = min(ta, uTintAmt.x);
      vec3 tint = mix(uTintShadow, uTintHi, smoothstep(0.15, 0.85, luma));
      col = mix(col, col * tint * 2.0, ta);
      // ---- film grain (per-frame integer seed) ----
      vec2 cell = floor(vUv * uResolution * uGrainScale);
      float gAmp = uMobile > 0.5 ? 0.035 : mix(0.045, 0.085, uDread);
      col += (rand(cell + uGrainSeed * 1.37) - 0.5) * gAmp;
      // ---- breathing vignette ----
      float br = uVignette.x - mix(0.0, 0.06, uDread) * 0.5 - (0.025 + 0.03*uDread) * sin(uTime * uBreathRate * 6.2831);
      float vstr = mix(uVignette.z, 0.92, uDread);
      float vig = smoothstep(br, br - uVignette.y, r);
      col *= mix(1.0, vig, vstr);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export function createRenderCore(canvas) {
  const _coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  const _fine = !!(window.matchMedia && matchMedia('(pointer: fine)').matches);
  const mobile = (_coarse && !_fine) || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.0 : RENDER.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDER.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(RENDER.fogColor);
  scene.fog = new THREE.FogExp2(RENDER.fogColor, RENDER.fogDensity);

  const camera = new THREE.PerspectiveCamera(RENDER.fov, window.innerWidth / window.innerHeight, RENDER.near, RENDER.far);

  // ---- composer ----
  const rtSamples = (!mobile && renderer.capabilities.isWebGL2) ? 4 : 0;
  const rt = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType, samples: rtSamples });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const postPass = new ShaderPass(PostShader);
  composer.addPass(postPass);
  composer.addPass(new OutputPass());
  postPass.uniforms.uMobile.value = mobile ? 1 : 0;
  postPass.uniforms.uGrainScale.value = mobile ? P.grainScaleMobile : P.grainScale;

  // ---- lighting rig ----
  scene.add(new THREE.HemisphereLight(RENDER.hemi.sky, RENDER.hemi.ground, RENDER.hemi.intensity));
  scene.add(new THREE.AmbientLight(RENDER.ambient.color, RENDER.ambient.intensity));

  const fixtures = [];
  const rig = {
    addFixture(pos, color = RENDER.fixture.color, intensity = RENDER.fixture.intensity, distance = RENDER.fixture.distance) {
      const l = new THREE.PointLight(color, intensity, distance, RENDER.fixture.decay);
      l.position.set(pos[0], pos[1], pos[2]); l.castShadow = false; scene.add(l);
      fixtures.push({ light: l, base: intensity, phase: Math.random() * 6.28 });
      return l;
    },
  };

  // ---- flashlight (the ONLY shadow caster) ----
  const flashlight = new THREE.SpotLight(RENDER.flashlight.color, RENDER.flashlight.intensity,
    RENDER.flashlight.distance, RENDER.flashlight.angle, RENDER.flashlight.penumbra, 2);
  flashlight.castShadow = true;
  flashlight.shadow.mapSize.set(mobile ? 1024 : RENDER.shadowMapSize, mobile ? 1024 : RENDER.shadowMapSize);
  flashlight.shadow.bias = -0.0008; flashlight.shadow.normalBias = 0.04;
  flashlight.shadow.camera.near = 0.2; flashlight.shadow.camera.far = RENDER.flashlight.distance;
  const flashTarget = new THREE.Object3D();
  scene.add(flashlight, flashTarget);
  flashlight.target = flashTarget;
  let flashlightOn = true;

  const _fwd = new THREE.Vector3(), _pos = new THREE.Vector3();

  function updateLighting(t, dt) {
    const d = core._dread, flickerOK = !core._reduceFlicker;
    for (const f of fixtures) {
      f.phase += dt * (2 + Math.random() * 0.5);
      f.light.intensity = f.base * (1 - 0.55 * d) * (1 + 0.05 * Math.sin(t * 11 + f.phase) + 0.03 * Math.sin(t * 27));
    }
    camera.getWorldPosition(_pos); camera.getWorldDirection(_fwd);
    flashlight.position.copy(_pos).addScaledVector(_fwd, 0.1);
    flashTarget.position.copy(_pos).addScaledVector(_fwd, 5);
    core._fnoise = core._fnoise * 0.92 + (Math.random() - 0.5) * 0.10;
    const flick = 1 + 0.04 * Math.sin(t * 13) + 0.03 * Math.sin(t * 31) + core._fnoise * (0.10 + 0.35 * d);
    core._dropGap -= dt;
    if (flickerOK && core._dropT <= 0 && core._dropGap <= 0 && Math.random() < dt * (0.15 + 2.2 * d * d)) {
      core._dropT = 0.08 + Math.random() * 0.14; core._dropGap = 0.25;
    }
    let drop = 1.0;
    if (core._dropT > 0) { core._dropT -= dt; drop = 0.04; } // never literal 0 (keeps shadow map warm)
    flashlight.intensity = flashlightOn ? RENDER.flashlight.intensity * flick * drop : 0;
  }

  const core = {
    renderer, scene, camera, composer, rig, flashlight, fixtures, mobile,
    _dread: 0, _dreadFed: false, _reduceFlicker: false, _fnoise: 0, _dropT: 0, _dropGap: 0, _grainFrame: 0, _res: new THREE.Vector2(),
    setFlashlight(on) { flashlightOn = on; },
    toggleFlashlight() { flashlightOn = !flashlightOn; return flashlightOn; },
    isFlashlightOn() { return flashlightOn; },
    setReduceFlicker(b) { core._reduceFlicker = !!b; },
    setDread(target, dt) {
      if (!isFinite(target)) target = 0;
      const tc = (target > core._dread) ? 0.30 : 1.8;
      core._dread += (target - core._dread) * (1 - Math.exp(-dt / Math.max(0.001, tc)));
      core._dreadFed = true;
      const d = core._dread;
      postPass.uniforms.uDread.value = d;
      postPass.uniforms.uBreathRate.value = P.breathRateCalm + (P.breathRateDread - P.breathRateCalm) * d;
    },
    render(t, dt) {
      if (!core._dreadFed) core.setDread(0, dt); // menu/pause bleed back to calm
      core._dreadFed = false;
      updateLighting(t, dt);
      core._grainFrame = (core._grainFrame + 1) % 8192;
      postPass.uniforms.uGrainSeed.value = core._grainFrame;
      postPass.uniforms.uTime.value = t % 1000;
      // animate fog density + sickly color shift with dread
      let dens = RENDER.fogDensity * (1 + 0.06 * Math.sin(t * 0.13)) + RENDER.fogDensityDread * core._dread;
      (scene.fog as THREE.FogExp2).density = Math.min(dens, RENDER.fogDensityCap);
      scene.fog.color.lerpColors(BASE_FOG, DREAD_FOG, Math.min(1, 0.9 * core._dread));
      (scene.background as THREE.Color).copy(scene.fog.color);
      composer.render();
    },
    resize() {
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h); composer.setSize(w, h);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      postPass.uniforms.uResolution.value.copy(renderer.getDrawingBufferSize(core._res));
    },
  };
  postPass.uniforms.uResolution.value.copy(renderer.getDrawingBufferSize(core._res));
  window.addEventListener('resize', () => core.resize());
  return core;
}
