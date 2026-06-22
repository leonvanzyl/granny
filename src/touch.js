// ============================================================================
// touch.js — mobile touch controls. Left thumb = virtual joystick (analog move),
// right side = drag to look, on-screen buttons map to the existing key actions.
// Everything routes through Input so the rest of the game is unchanged.
// ============================================================================
import { Input } from './input.js';

const LOOK_SENS = 1.5;   // touch-px -> mouse-px equivalent (player applies its own sensitivity)
const JOY_RADIUS = 56;   // px to full deflection

export const Touch = {
  active: false,        // is this a touch device?
  _joyId: null, _joyOrigin: null,
  _lookId: null, _lookLast: null,

  // returns true if this is a touch device (controls were enabled)
  init() {
    // mobile-PRIMARY only: coarse pointer with NO fine pointer, or a mobile UA. This avoids
    // disabling keyboard/mouse on touchscreen laptops (which report touch points but also a mouse).
    const coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    const fine = !!(window.matchMedia && matchMedia('(pointer: fine)').matches);
    const ua = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    const mobile = (coarse && !fine) || ua;
    if (!mobile) return false;
    this.active = true;
    Input.touchMode = true;
    document.body.classList.add('touch');
    this._wire();
    return true;
  },

  // show/hide the on-screen controls (called when entering/leaving gameplay)
  setPlaying(on) {
    if (!this.active) return;
    document.body.classList.toggle('playing', !!on);
    if (!on) {
      this._endJoy(); this._endLook();
      // release latched modifiers so we never resume/respawn stuck crouched or sprinting,
      // and resync button visuals (a finger held when the UI hides never gets a touchend)
      Input.keysDown.delete('KeyC');
      Input.keysDown.delete('ShiftLeft');
      document.querySelectorAll('#touch .tbtn.active').forEach((b) => b.classList.remove('active'));
    }
  },

  _wire() {
    const moveZone = document.getElementById('touch-move');
    const lookZone = document.getElementById('touch-look');
    const joy = document.getElementById('joy');
    const knob = document.getElementById('joy-knob');
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

    // ---- joystick (left) ----
    moveZone.addEventListener('touchstart', (e) => {
      stop(e);
      if (this._joyId !== null) return;
      const t = e.changedTouches[0];
      this._joyId = t.identifier;
      this._joyOrigin = { x: t.clientX, y: t.clientY };
      joy.style.left = t.clientX + 'px'; joy.style.top = t.clientY + 'px';
      joy.style.display = 'block';
      knob.style.transform = 'translate(-50%, -50%)';
    }, { passive: false });

    // ---- look (right) ----
    lookZone.addEventListener('touchstart', (e) => {
      stop(e);
      if (this._lookId !== null) return;
      const t = e.changedTouches[0];
      this._lookId = t.identifier;
      this._lookLast = { x: t.clientX, y: t.clientY };
    }, { passive: false });

    // shared move/end on document so a finger that drifts off-zone keeps working
    document.addEventListener('touchmove', (e) => {
      if (!this.active) return;
      let handled = false;
      for (const t of e.changedTouches) {
        if (t.identifier === this._joyId) {
          handled = true;
          let dx = t.clientX - this._joyOrigin.x, dy = t.clientY - this._joyOrigin.y;
          const len = Math.hypot(dx, dy);
          if (len > JOY_RADIUS) { dx *= JOY_RADIUS / len; dy *= JOY_RADIUS / len; }
          knob.style.transform = `translate(${dx - 28}px, ${dy - 28}px)`;
          Input.moveX = dx / JOY_RADIUS;
          Input.moveY = -dy / JOY_RADIUS; // up on screen = forward
        } else if (t.identifier === this._lookId) {
          handled = true;
          Input.mouseDX += (t.clientX - this._lookLast.x) * LOOK_SENS;
          Input.mouseDY += (t.clientY - this._lookLast.y) * LOOK_SENS;
          this._lookLast.x = t.clientX; this._lookLast.y = t.clientY;
        }
      }
      if (handled) e.preventDefault();
    }, { passive: false });

    const inZone = (t, zone) => { const r = zone.getBoundingClientRect(); return t.clientX >= r.left && t.clientX <= r.right && t.clientY >= r.top && t.clientY <= r.bottom; };
    const onEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._joyId) {
          // if another finger is still resting in the move zone, hand the joystick to it
          const other = [...e.touches].find((o) => o.identifier !== this._lookId && inZone(o, moveZone));
          if (other) {
            this._joyId = other.identifier; this._joyOrigin = { x: other.clientX, y: other.clientY };
            joy.style.left = other.clientX + 'px'; joy.style.top = other.clientY + 'px';
            knob.style.transform = 'translate(-50%, -50%)'; Input.moveX = 0; Input.moveY = 0;
          } else this._endJoy();
        } else if (t.identifier === this._lookId) {
          const other = [...e.touches].find((o) => o.identifier !== this._joyId && inZone(o, lookZone));
          if (other) { this._lookId = other.identifier; this._lookLast = { x: other.clientX, y: other.clientY }; }
          else this._endLook();
        }
      }
    };
    document.addEventListener('touchend', onEnd, { passive: false });
    document.addEventListener('touchcancel', onEnd, { passive: false });

    // ---- action buttons ----
    const press = (code) => Input._pressed.add(code);
    for (const btn of document.querySelectorAll('#touch .tbtn')) {
      const act = btn.dataset.act;
      btn.addEventListener('touchstart', (e) => {
        stop(e);
        if (act === 'sprint') { Input.keysDown.add('ShiftLeft'); btn.classList.add('active'); }
        else if (act === 'crouch') {
          if (Input.keysDown.has('KeyC')) { Input.keysDown.delete('KeyC'); btn.classList.remove('active'); }
          else { Input.keysDown.add('KeyC'); btn.classList.add('active'); }
        }
        else {
          btn.classList.add('active');
          if (act === 'interact') press('KeyE');
          else if (act === 'hide') press('KeyG');
          else if (act === 'throw') press('mouse2');
          else if (act === 'drop') press('KeyQ');
          else if (act === 'flashlight') press('KeyF');
        }
      }, { passive: false });
      const end = (e) => {
        stop(e);
        if (act === 'sprint') { Input.keysDown.delete('ShiftLeft'); btn.classList.remove('active'); }
        else if (act !== 'crouch') btn.classList.remove('active'); // crouch is a toggle: leave it latched
      };
      btn.addEventListener('touchend', end, { passive: false });
      btn.addEventListener('touchcancel', end, { passive: false }); // OS interruption (call/notification) must release RUN
    }

    const pauseBtn = document.getElementById('touch-pause');
    pauseBtn.addEventListener('touchstart', (e) => { stop(e); Input._pressed.add('Escape'); }, { passive: false });
  },

  _endJoy() {
    this._joyId = null; this._joyOrigin = null;
    Input.moveX = 0; Input.moveY = 0;
    const joy = document.getElementById('joy'); if (joy) joy.style.display = 'none';
    // clear any latched crouch is NOT done here (crouch is a toggle)
  },
  _endLook() { this._lookId = null; this._lookLast = null; },
};
