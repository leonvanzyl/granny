// ============================================================================
// lab/ui.ts — tiny dependency-free control-panel toolkit for the Debug Lab.
//
// Panel builds labelled rows (select / slider / toggle / button / buttonRow /
// info) and returns a typed handle so a mode can read and *drive* the control
// (e.g. move a timeline scrubber as an animation plays). Readout is the HUD.
// Styling lives in lab.html; here we only assign class names.
// ============================================================================

export interface SliderHandle {
  el: HTMLElement;
  get(): number;
  set(v: number): void;
  setLabel(text: string): void;
  onChange(fn: (v: number) => void): void;
}
export interface SelectHandle {
  el: HTMLElement;
  get(): string;
  set(v: string): void;
  setOptions(opts: Array<string | { value: string; label: string }>): void;
}
export interface ToggleHandle {
  el: HTMLElement;
  get(): boolean;
  set(v: boolean): void;
}
export interface ButtonHandle {
  el: HTMLButtonElement;
  setLabel(text: string): void;
  setActive(on: boolean): void;
  setDisabled(on: boolean): void;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export class Panel {
  root: HTMLElement;
  private cursor: HTMLElement;
  constructor(root: HTMLElement) { this.root = root; this.cursor = root; }

  clear() {
    this.root.innerHTML = '';
    this.cursor = this.root;
  }

  /** Start a collapsible-ish titled section. Subsequent controls nest in it. */
  section(title: string): this {
    const sec = h('div', 'lab-section');
    sec.appendChild(h('div', 'lab-section-title', title));
    const body = h('div', 'lab-section-body');
    sec.appendChild(body);
    this.root.appendChild(sec);
    this.cursor = body;
    return this;
  }

  /** Return to the panel root (controls added after this sit outside sections). */
  end(): this { this.cursor = this.root; return this; }

  heading(text: string) {
    this.cursor.appendChild(h('div', 'lab-heading', text));
  }

  info(html: string): HTMLElement {
    const e = h('div', 'lab-info');
    e.innerHTML = html;
    this.cursor.appendChild(e);
    return e;
  }

  select(
    label: string,
    options: Array<string | { value: string; label: string }>,
    onChange: (v: string) => void,
    initial?: string,
  ): SelectHandle {
    const row = h('div', 'lab-row');
    row.appendChild(h('label', 'lab-label', label));
    const sel = document.createElement('select');
    sel.className = 'lab-select';
    const fill = (opts: typeof options) => {
      sel.innerHTML = '';
      for (const o of opts) {
        const opt = document.createElement('option');
        if (typeof o === 'string') { opt.value = o; opt.textContent = o; }
        else { opt.value = o.value; opt.textContent = o.label; }
        sel.appendChild(opt);
      }
    };
    fill(options);
    if (initial != null) sel.value = initial;
    sel.addEventListener('change', () => onChange(sel.value));
    row.appendChild(sel);
    this.cursor.appendChild(row);
    return {
      el: row,
      get: () => sel.value,
      set: (v) => { sel.value = v; },
      setOptions: (opts) => fill(opts),
    };
  }

  slider(
    label: string,
    min: number, max: number, step: number, value: number,
    onChange: (v: number) => void,
  ): SliderHandle {
    const row = h('div', 'lab-row lab-row-slider');
    const head = h('div', 'lab-slider-head');
    const lab = h('label', 'lab-label', label);
    const val = h('span', 'lab-val', fmt(value));
    head.appendChild(lab); head.appendChild(val);
    row.appendChild(head);
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'lab-range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(value);
    let cb = onChange;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      val.textContent = fmt(v);
      cb(v);
    });
    row.appendChild(input);
    this.cursor.appendChild(row);
    return {
      el: row,
      get: () => parseFloat(input.value),
      set: (v) => { input.value = String(v); val.textContent = fmt(v); },
      setLabel: (t) => { lab.textContent = t; },
      onChange: (fn) => { cb = fn; },
    };
  }

  toggle(label: string, value: boolean, onChange: (v: boolean) => void): ToggleHandle {
    const row = h('div', 'lab-row lab-row-toggle');
    row.appendChild(h('label', 'lab-label', label));
    const btn = h('button', 'lab-toggle');
    const paint = (v: boolean) => { btn.classList.toggle('on', v); btn.textContent = v ? 'ON' : 'OFF'; };
    let state = value; paint(state);
    btn.addEventListener('click', () => { state = !state; paint(state); onChange(state); });
    row.appendChild(btn);
    this.cursor.appendChild(row);
    return { el: row, get: () => state, set: (v) => { state = v; paint(v); } };
  }

  button(label: string, onClick: () => void): ButtonHandle {
    const btn = h('button', 'lab-button', label) as HTMLButtonElement;
    btn.addEventListener('click', onClick);
    this.cursor.appendChild(btn);
    return {
      el: btn,
      setLabel: (t) => { btn.textContent = t; },
      setActive: (on) => btn.classList.toggle('active', on),
      setDisabled: (on) => { btn.disabled = on; },
    };
  }

  /** A horizontal row of small buttons (e.g. view presets). */
  buttonRow(labels: string[], onClick: (label: string, index: number) => void): HTMLElement {
    const row = h('div', 'lab-btnrow');
    labels.forEach((l, i) => {
      const b = h('button', 'lab-button lab-button-sm', l) as HTMLButtonElement;
      b.addEventListener('click', () => onClick(l, i));
      row.appendChild(b);
    });
    this.cursor.appendChild(row);
    return row;
  }
}

function fmt(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(Math.abs(v) < 1 ? 3 : 2);
}

// ---------------------------------------------------------------------------

export class Readout {
  root: HTMLElement;
  constructor(root: HTMLElement) { this.root = root; }
  set(text: string) { this.root.textContent = text; }
  html(html: string) { this.root.innerHTML = html; }
  /** Render a key/value table from a plain object. */
  kv(obj: Record<string, string | number>) {
    let s = '';
    for (const k in obj) s += `${k.padEnd(10)} ${obj[k]}\n`;
    this.root.textContent = s;
  }
  clear() { this.root.textContent = ''; }
}
