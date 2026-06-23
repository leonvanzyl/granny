// ============================================================================
// lab/studio.ts — neutral render core for the Debug Lab.
//
// Unlike the game's render.ts (fog + dread post-grade + one shadow-casting
// flashlight), this is a clean studio: even three-point lighting, a ground
// shadow catcher, a reference grid + axes, and NO post FX — so we see the TRUE
// colour, shape, and scale of an artifact. It can also switch to a dim "game"
// mood so we can sanity-check how an asset will read in the actual game.
// ============================================================================
import * as THREE from 'three';

export type EnvMode = 'studio' | 'neutral' | 'dark' | 'noir' | 'soft' | 'warm';

const _box = new THREE.Box3();
const _c = new THREE.Vector3();
const _s = new THREE.Vector3();

export class Studio {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Modes add their objects here; clearContent() empties it. */
  content: THREE.Group;

  private lights: THREE.Group;
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private ground: THREE.Mesh;
  /** PointLights created via rigAdapter() (game-style room fixtures). */
  private fixtures: THREE.Group;
  private env: EnvMode = 'studio';

  constructor(canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer:true so capture.ts can read the canvas back as a PNG
    // after a render (the capture pipeline is the whole point of this lab).
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);

    this.content = new THREE.Group(); this.content.name = 'labContent'; scene.add(this.content);
    this.fixtures = new THREE.Group(); this.fixtures.name = 'labFixtures'; scene.add(this.fixtures);

    // ---- lighting rig ----
    this.lights = new THREE.Group(); this.lights.name = 'labLights'; scene.add(this.lights);

    // ---- helpers ----
    this.grid = new THREE.GridHelper(20, 40, 0x4a5260, 0x2a2e36);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.6;
    scene.add(this.grid);

    this.axes = new THREE.AxesHelper(1); // R=+X G=+Y B=+Z — verify "front is +Z"
    (this.axes.material as THREE.Material).depthTest = false;
    this.axes.renderOrder = 999;
    scene.add(this.axes);

    // ground shadow catcher (invisible except for shadows)
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.ShadowMaterial({ opacity: 0.35 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 0;
    this.ground.receiveShadow = true;
    scene.add(this.ground);

    this.setEnvironment('studio');
    this.resize();
  }

  // ---- environment / lighting --------------------------------------------

  setEnvironment(mode: EnvMode) {
    this.env = mode;
    // wipe current lights
    for (let i = this.lights.children.length - 1; i >= 0; i--) {
      const l = this.lights.children[i] as any;
      if (l.dispose) l.dispose();
      this.lights.remove(l);
    }
    const add = (l: THREE.Light) => { this.lights.add(l); return l; };

    if (mode === 'studio' || mode === 'neutral') {
      this.scene.background = new THREE.Color(mode === 'studio' ? 0x23262c : 0x10121a);
      add(new THREE.HemisphereLight(0xdde6ff, 0x33302c, mode === 'studio' ? 0.55 : 0.4));
      add(new THREE.AmbientLight(0xffffff, 0.18));

      const key = new THREE.DirectionalLight(0xfff2e0, mode === 'studio' ? 1.7 : 1.2);
      key.position.set(4, 8, 6);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.near = 0.5; key.shadow.camera.far = 40;
      const sc = key.shadow.camera as THREE.OrthographicCamera;
      sc.left = -8; sc.right = 8; sc.top = 8; sc.bottom = -8; sc.updateProjectionMatrix();
      key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02;
      add(key);

      const fill = new THREE.DirectionalLight(0xbcd0ff, 0.55); fill.position.set(-6, 4, -2); add(fill);
      const rim = new THREE.DirectionalLight(0xffffff, 0.7); rim.position.set(-1, 5, -8); add(rim);
      this.ground.visible = true;
    } else if (mode === 'noir') {
      // single hard key, deep shadows, near-black bg, high contrast
      this.scene.background = new THREE.Color(0x040405);
      add(new THREE.AmbientLight(0xffffff, 0.025));
      const key = new THREE.DirectionalLight(0xffffff, 2.6);
      key.position.set(6, 9, 4);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.near = 0.5; key.shadow.camera.far = 40;
      const sc = key.shadow.camera as THREE.OrthographicCamera;
      sc.left = -8; sc.right = 8; sc.top = 8; sc.bottom = -8; sc.updateProjectionMatrix();
      key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02;
      add(key);
      this.ground.visible = true;
    } else if (mode === 'soft') {
      // flat, even fill from several sides — light-grey bg, minimal shadows
      this.scene.background = new THREE.Color(0xc6cad0);
      add(new THREE.HemisphereLight(0xffffff, 0xaab0b8, 0.7));
      add(new THREE.AmbientLight(0xffffff, 0.5));
      const dirs: [number, number, number][] = [
        [5, 6, 5], [-5, 6, 5], [5, 6, -5], [-5, 6, -5], [0, 9, 0],
      ];
      for (const p of dirs) {
        const d = new THREE.DirectionalLight(0xffffff, 0.45);
        d.position.set(p[0], p[1], p[2]);
        add(d);
      }
      this.ground.visible = true;
    } else if (mode === 'warm') {
      // dim warm amber key, house-like — softer than 'dark', still cosy
      this.scene.background = new THREE.Color(0x18120c);
      add(new THREE.HemisphereLight(0x3a2c1a, 0x140d06, 0.35));
      add(new THREE.AmbientLight(0xffd9a0, 0.12));
      const key = new THREE.DirectionalLight(0xffb866, 0.95);
      key.position.set(3, 6, 4);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.near = 0.5; key.shadow.camera.far = 40;
      const sc = key.shadow.camera as THREE.OrthographicCamera;
      sc.left = -8; sc.right = 8; sc.top = 8; sc.bottom = -8; sc.updateProjectionMatrix();
      key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02;
      add(key);
      const fill = new THREE.DirectionalLight(0xff9d4d, 0.3); fill.position.set(-4, 3, -2); add(fill);
      this.ground.visible = true;
    } else {
      // dim "game" mood — closer to how assets read in the actual house
      this.scene.background = new THREE.Color(0x05060a);
      add(new THREE.HemisphereLight(0x202838, 0x0a0806, 0.18));
      add(new THREE.AmbientLight(0x14161f, 0.1));
      const key = new THREE.DirectionalLight(0xffb060, 0.5); key.position.set(2, 6, 3);
      key.castShadow = true; key.shadow.mapSize.set(1024, 1024); add(key);
      this.ground.visible = false;
    }
  }

  get environment() { return this.env; }
  setGrid(on: boolean) { this.grid.visible = on; }
  setAxes(on: boolean) { this.axes.visible = on; }
  setGround(on: boolean) { this.ground.visible = on; }

  /**
   * world.ts expects a `rig` with addFixture(pos, color?, intensity?, distance?).
   * Returns one backed by this studio so the World Inspector can build the real
   * house with its real room lights.
   */
  rigAdapter() {
    const fixtures = this.fixtures;
    return {
      addFixture(pos: number[], color = 0xffb060, intensity = 18, distance = 6) {
        const l = new THREE.PointLight(color, intensity, distance, 2);
        l.position.set(pos[0], pos[1], pos[2]);
        l.castShadow = false;
        fixtures.add(l);
        return l;
      },
    };
  }

  clearFixtures() {
    for (let i = this.fixtures.children.length - 1; i >= 0; i--) {
      const l = this.fixtures.children[i] as any;
      if (l.dispose) l.dispose();
      this.fixtures.remove(l);
    }
  }

  // ---- content management -------------------------------------------------

  /** Empty the content group, disposing lab-created geometry (not shared mats). */
  clearContent() {
    this.disposeChildren(this.content);
    this.clearFixtures();
  }

  private disposeChildren(group: THREE.Object3D) {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const o = group.children[i];
      o.traverse((c: any) => {
        if (c.isMesh || c.isLine || c.isLineSegments || c.isPoints) {
          if (c.geometry) c.geometry.dispose();
          // only dispose materials flagged as lab-owned (shared MaterialLibrary
          // / TextureFactory materials must survive across mode switches)
          const m = c.material;
          if (m && m.userData && m.userData.labOwned) {
            if (Array.isArray(m)) m.forEach((x: any) => x.dispose()); else m.dispose();
          }
        }
        if (c.isLight && c.dispose) c.dispose();
      });
      group.remove(o);
    }
  }

  // ---- measurement / framing ---------------------------------------------

  measure(obj: THREE.Object3D) {
    obj.updateWorldMatrix(true, true);
    _box.setFromObject(obj);
    const center = _box.getCenter(new THREE.Vector3());
    const size = _box.getSize(new THREE.Vector3());
    const radius = Math.max(1e-3, size.length() / 2);
    return { box: _box.clone(), center, size, radius };
  }

  // ---- loop ---------------------------------------------------------------

  render() { this.renderer.render(this.scene, this.camera); }

  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
