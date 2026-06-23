// ============================================================================
// ui.js — DOM overlay + HUD manager. All overlays/HUD elements live in
// index.html; this module wires buttons, drives the HUD, and reads settings.
// Pure DOM. No THREE, no cannon.
// ============================================================================

import { COLORS, DIFFICULTY } from './config';

// ---- tiny DOM helpers --------------------------------------------------------

function $(id: string): any {
  return document.getElementById(id);
}

function setHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle('hidden', !!hidden);
}

function setText(el, text) {
  if (!el) return;
  el.textContent = text;
}

function setWidthPct(el, frac) {
  if (!el) return;
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  el.style.width = (f * 100).toFixed(2) + '%';
}

function on(el, ev, fn) {
  if (!el || typeof fn !== 'function') return;
  el.addEventListener(ev, fn);
}

// The set of overlay screens, mapped to their element ids.
const SCREEN_IDS = {
  loading: 'loading',
  menu: 'menu',
  howto: 'howto',
  settings: 'settings',
  pause: 'pause',
  respawn: 'respawn',
  gameover: 'gameover',
  win: 'win',
};

// Module-private state.
interface UICallbacks {
  onPlay?: (seed: any) => void;
  onHowto?: () => void;
  onSettings?: () => void;
  onBack?: () => void;
  onResume?: () => void;
  onQuit?: () => void;
  onRespawn?: () => void;
  onGameoverNew?: () => void;
  onWinRetry?: () => void;
  onWinMenu?: () => void;
  onSettingsChange?: (settings: any) => void;
}

let _cb: UICallbacks = {};

export const UI = {
  // --------------------------------------------------------------------------
  init(callbacks) {
    _cb = callbacks || {};

    // --- Main menu --------------------------------------------------------
    on($('btn-play'), 'click', () => {
      if (typeof _cb.onPlay !== 'function') return;
      const input = $('seed-input');
      let seed = null;
      if (input) {
        const v = (input.value || '').trim();
        seed = v.length ? v : null;
      }
      _cb.onPlay(seed);
    });
    on($('btn-howto'), 'click', () => { if (_cb.onHowto) _cb.onHowto(); });
    on($('btn-settings'), 'click', () => { if (_cb.onSettings) _cb.onSettings(); });

    // --- How-to / settings back ------------------------------------------
    on($('btn-howto-back'), 'click', () => { if (_cb.onBack) _cb.onBack(); });
    on($('btn-settings-back'), 'click', () => { if (_cb.onBack) _cb.onBack(); });

    // --- Pause ------------------------------------------------------------
    on($('btn-resume'), 'click', () => { if (_cb.onResume) _cb.onResume(); });
    on($('btn-quit'), 'click', () => { if (_cb.onQuit) _cb.onQuit(); });

    // --- Respawn ----------------------------------------------------------
    on($('btn-respawn'), 'click', () => { if (_cb.onRespawn) _cb.onRespawn(); });

    // --- Game over --------------------------------------------------------
    on($('btn-gameover'), 'click', () => { if (_cb.onGameoverNew) _cb.onGameoverNew(); });

    // --- Win --------------------------------------------------------------
    on($('btn-win-retry'), 'click', () => { if (_cb.onWinRetry) _cb.onWinRetry(); });
    on($('btn-win-menu'), 'click', () => { if (_cb.onWinMenu) _cb.onWinMenu(); });

    // --- Settings inputs: update labels live + notify -------------------
    const notifySettings = () => {
      this._refreshSettingLabels();
      if (_cb.onSettingsChange) _cb.onSettingsChange(this.getSettings());
    };

    on($('set-sens'), 'input', notifySettings);
    on($('set-vol'), 'input', notifySettings);
    on($('set-pulse'), 'input', notifySettings);
    on($('set-invert'), 'input', notifySettings);
    on($('set-pulse'), 'change', notifySettings);
    on($('set-invert'), 'change', notifySettings);

    // Initialize label spans to match the default input values.
    this._refreshSettingLabels();
  },

  // --------------------------------------------------------------------------
  // Internal: sync the *-val spans with the current input values.
  _refreshSettingLabels() {
    const sens = $('set-sens');
    const sensVal = $('set-sens-val');
    if (sens && sensVal) {
      const v = parseFloat(sens.value);
      sensVal.textContent = (isNaN(v) ? 1.0 : v).toFixed(1);
    }
    const vol = $('set-vol');
    const volVal = $('set-vol-val');
    if (vol && volVal) {
      const v = parseFloat(vol.value);
      const pct = Math.round((isNaN(v) ? 0.9 : v) * 100);
      volVal.textContent = pct + '%';
    }
  },

  // --------------------------------------------------------------------------
  showScreen(name) {
    // Hide all known overlays, then reveal the requested one.
    for (const key in SCREEN_IDS) {
      setHidden($(SCREEN_IDS[key]), true);
    }
    if (name === 'none') return;
    const id = SCREEN_IDS[name];
    if (id) setHidden($(id), false);
  },

  // --------------------------------------------------------------------------
  showHud(on) {
    setHidden($('hud'), !on);
    setHidden($('pause-hint'), !on);
  },

  // --------------------------------------------------------------------------
  setLoadProgress(frac, label) {
    setWidthPct($('load-bar'), frac);
    if (label != null) setText($('load-label'), label);
  },

  // --------------------------------------------------------------------------
  setDay(day, maxDays) {
    const m = (maxDays != null) ? maxDays : (DIFFICULTY.maxDays || 5);
    setText($('daycount'), 'DAY ' + day + ' OF ' + m);
  },

  // --------------------------------------------------------------------------
  setAwareness(value0to100, stateLabel) {
    const el = $('awareness');
    const v = Math.max(0, Math.min(100, Number(value0to100) || 0));
    if (el) {
      el.style.width = v.toFixed(2) + '%';
      let color;
      if (v >= 100) color = COLORS.awarenessHigh;
      else if (v >= 40) color = COLORS.awarenessMid;
      else color = COLORS.awarenessLow;
      el.style.background = color;
    }
    const lbl = $('state-label');
    if (lbl) lbl.textContent = stateLabel ? String(stateLabel).toUpperCase() : '';
  },

  // --------------------------------------------------------------------------
  setStamina(frac) {
    const wrap = $('stamina-bar');
    if (!wrap) return;
    setWidthPct(wrap.firstElementChild, frac);
  },

  // --------------------------------------------------------------------------
  setBreath(fracOrNull) {
    const meter = $('breath-meter');
    if (fracOrNull == null) {
      setHidden(meter, true);
      return;
    }
    setHidden(meter, false);
    const bar = $('breath-bar');
    if (bar) setWidthPct(bar.firstElementChild, fracOrNull);
  },

  // --------------------------------------------------------------------------
  setObjectives(list) {
    const host = $('obj-list');
    if (!host) return;
    host.textContent = '';
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item) continue;
      const div = document.createElement('div');
      div.textContent = item.text != null ? String(item.text) : '';
      if (item.done) div.className = 'done';
      host.appendChild(div);
    }
  },

  // --------------------------------------------------------------------------
  setPrompt(textOrNull) {
    const el = $('prompt');
    if (!el) return;
    if (textOrNull == null) {
      setHidden(el, true);
      el.textContent = '';
      return;
    }
    el.textContent = String(textOrNull);
    setHidden(el, false);
  },

  // --------------------------------------------------------------------------
  setInventory(names) {
    const host = $('inventory');
    if (!host) return;
    host.textContent = '';
    if (!Array.isArray(names)) return;
    for (const name of names) {
      const chip = document.createElement('div');
      chip.className = 'inv-item';
      chip.textContent = name != null ? String(name) : '';
      host.appendChild(chip);
    }
  },

  // --------------------------------------------------------------------------
  setHeldName(nameOrNull) {
    const el = $('held-name');
    if (!el) return;
    if (nameOrNull == null) {
      setHidden(el, true);
      el.textContent = '';
      return;
    }
    el.textContent = 'Holding: ' + String(nameOrNull);
    setHidden(el, false);
  },

  // --------------------------------------------------------------------------
  setSeed(seed) {
    setText($('seed-hud'), 'SEED ' + seed);
  },

  // --------------------------------------------------------------------------
  setRedVignette(intensity0to1) {
    const el = $('vignette-red');
    if (!el) return;
    const i = Math.max(0, Math.min(1, Number(intensity0to1) || 0));
    // Grow both spread and alpha with intensity for a pulsing blood glow.
    const spread = Math.round(20 + i * 70);   // px
    const blur = Math.round(120 + i * 120);   // px
    const alpha = (i * 0.7).toFixed(3);
    el.style.boxShadow =
      'inset 0 0 ' + blur + 'px ' + spread + 'px rgba(120,10,10,' + alpha + ')';
  },

  // --------------------------------------------------------------------------
  setDangerPulse(enabled, angleRadOrNull, intensity0to1) {
    const host = $('danger-pulse');
    if (!host) return;
    const arrow = host.querySelector('.arrow') as any;
    if (!enabled || angleRadOrNull == null) {
      setHidden(host, true);
      if (arrow) arrow.style.opacity = '0';
      return;
    }
    setHidden(host, false);
    if (!arrow) return;
    const deg = (Number(angleRadOrNull) || 0) * 180 / Math.PI;
    const i = Math.max(0, Math.min(1, Number(intensity0to1) || 0));
    // The arrow's natural border-bottom points up (0 = up/forward); rotate
    // clockwise about its transform-origin (below the screen center).
    arrow.style.transform = 'translate(-50%, 0) rotate(' + deg.toFixed(2) + 'deg)';
    arrow.style.opacity = i.toFixed(3);
  },

  // --------------------------------------------------------------------------
  showRespawnStats(html) {
    const el = $('respawn-stats');
    if (el) el.innerHTML = html != null ? html : '';
  },

  // --------------------------------------------------------------------------
  setGameoverSub(text) {
    setText($('gameover-sub'), text != null ? text : '');
  },

  // --------------------------------------------------------------------------
  setWinStats(html) {
    const el = $('win-sub');
    if (el) el.innerHTML = html != null ? html : '';
  },

  // --------------------------------------------------------------------------
  fade(show) {
    const el = $('fade');
    if (!el) return;
    el.classList.toggle('show', !!show);
  },

  // --------------------------------------------------------------------------
  getSettings() {
    // Read from inputs and clamp to documented ranges. Also refresh labels so
    // the displayed values always reflect what we return.
    const sensEl = $('set-sens');
    const volEl = $('set-vol');
    const pulseEl = $('set-pulse');
    const invertEl = $('set-invert');

    let sensitivity = sensEl ? parseFloat(sensEl.value) : 1.0;
    if (isNaN(sensitivity)) sensitivity = 1.0;
    sensitivity = Math.max(0.4, Math.min(2.5, sensitivity));

    let volume = volEl ? parseFloat(volEl.value) : 0.9;
    if (isNaN(volume)) volume = 0.9;
    volume = Math.max(0, Math.min(1, volume));

    const dangerPulse = pulseEl ? !!pulseEl.checked : false;
    const invertY = invertEl ? !!invertEl.checked : false;

    this._refreshSettingLabels();

    return { sensitivity, volume, dangerPulse, invertY };
  },
};
