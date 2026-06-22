// ============================================================================
// input.js — keyboard + mouse + pointer-lock. Player/main read from here.
// ============================================================================
export const Input = {
  canvas: null,
  keysDown: new Set(),
  _pressed: new Set(),     // edge presses this frame (keys + mouse0/mouse2)
  mouseDX: 0, mouseDY: 0,
  locked: false,
  _onLock: null,
  // touch (mobile): analog move axes (-1..1) + flag; look feeds mouseDX/DY; buttons feed keysDown/_pressed
  touchMode: false, moveX: 0, moveY: 0,

  init(canvas, opts = {}) {
    this.canvas = canvas;
    this._onLock = opts.onLockChange || null;

    window.addEventListener('keydown', (e) => {
      if (!this.keysDown.has(e.code)) this._pressed.add(e.code);
      this.keysDown.add(e.code);
      if (['Tab', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keysDown.delete(e.code));
    window.addEventListener('blur', () => { this.keysDown.clear(); });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    window.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this._pressed.add('mouse' + e.button);
    });
    document.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });

    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.canvas;
      this.mouseDX = this.mouseDY = 0; // discard first deltas after (re)lock
      if (this._onLock && was !== this.locked) this._onLock(this.locked);
    });
  },

  requestLock() { if (this.canvas) this.canvas.requestPointerLock(); },
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); },

  down(code) { return this.keysDown.has(code); },
  pressed(code) { return this._pressed.has(code); },
  readMouse() { const d = { dx: this.mouseDX, dy: this.mouseDY }; this.mouseDX = this.mouseDY = 0; return d; },
  endFrame() { this._pressed.clear(); },
};
