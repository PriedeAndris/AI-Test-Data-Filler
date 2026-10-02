// Injected on demand into the current tab (after the user clicks the extension). Never submits anything.
(() => {
  if (window.__aiTestDataFiller) return;
  window.__aiTestDataFiller = true;

  const registry = new Map(); // id -> { kind, el | els }  (fields the AI writes)
  const randomized = new WeakSet(); // selects/radios already picked at random
  let nextId = 1;

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'range', 'color']);
  const SENSITIVE = /(card.?(number|no|num)|cc-?(num|csc|exp)|cvv|cvc|security.?code|passw|passcode|\botp\b|one.?time|2fa)/i;
  const FORMATS = {
    date: 'YYYY-MM-DD',
    time: 'HH:MM',
    'datetime-local': 'YYYY-MM-DDTHH:MM',
    month: 'YYYY-MM',
    week: 'YYYY-Www',
  };

  const text = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim();
  const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  function labelOf(el) {
    const parts = [];
    if (el.labels) for (const l of el.labels) parts.push(text(l));
    const al = el.getAttribute('aria-label');
    if (al) parts.push(al);
    const by = el.getAttribute('aria-labelledby');
    if (by) by.split(/\s+/).forEach((id) => parts.push(text(document.getElementById(id))));
    return [...new Set(parts.filter(Boolean))].join(' / ').slice(0, 120);
  }

  const isSensitive = (el, label) =>
    (el.autocomplete || '').startsWith('cc-') || SENSITIVE.test(`${el.name} ${el.id} ${label}`);

  function describe(el, label) {
    const d = { id: null, kind: 'text', type: el.type, label };
    if (el.name) d.name = el.name;
    if (el.placeholder) d.placeholder = el.placeholder;
    if (el.required) d.required = true;
    if (el.autocomplete && el.autocomplete !== 'on' && el.autocomplete !== 'off') d.autocomplete = el.autocomplete;
    if (el.maxLength > 0 && el.maxLength < 100000) d.maxlength = el.maxLength;
    if (el.min) d.min = el.min;
    if (el.max) d.max = el.max;
    if (el.pattern) d.pattern = el.pattern;
    if (FORMATS[el.type]) d.format = FORMATS[el.type];
    return d;
  }

  /** Finds the fillable controls on the page, grouped by kind. */
  function collect(overwrite) {
    const out = { text: [], checkboxes: [], selects: [], radioGroups: [] };
    const groups = new Map();

    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.disabled || el.readOnly) continue;
      const tag = el.tagName;
      const type = (el.type || '').toLowerCase();
      if (tag === 'INPUT' && SKIP_TYPES.has(type)) continue;

      const choice = type === 'checkbox' || type === 'radio';
      if (choice ? el.closest('[hidden]') : !visible(el)) continue;

      const label = labelOf(el);
      if (isSensitive(el, label)) continue;

      if (type === 'radio') {
        const key = `${el.form ? [...document.forms].indexOf(el.form) : 'x'}:${el.name || el.id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ el, label });
        continue;
      }
      if (type === 'checkbox') {
        if (!(el.checked && !overwrite)) out.checkboxes.push({ el, label });
        continue;
      }
      if (tag === 'SELECT') {
        if (randomized.has(el)) continue;
        const all = [...el.options].filter((o) => o.value !== '' && !o.disabled).map((o) => ({ value: o.value, text: o.text.trim() }));
        if (!all.length) continue;
        if (el.value && el.selectedIndex > 0 && !overwrite) continue;
        out.selects.push({ el, label, all });
        continue;
      }
      if (el.value && !overwrite) continue;
      out.text.push({ el, label });
    }

    for (const g of groups.values()) {
      if (g.some((x) => randomized.has(x.el))) continue;
      if (!overwrite && g.some((x) => x.el.checked)) continue;
      out.radioGroups.push(g);
    }
    return out;
  }

  const legendOf = (el) => text(el.closest('fieldset')?.querySelector('legend'));

  /** Selections currently made on the page (drop-downs and radios). The AI must keep its data consistent with them. */
  function currentChoices() {
    const out = [];
    for (const el of document.querySelectorAll('select')) {
      if (el.disabled || !visible(el)) continue;
      const label = labelOf(el);
      if (isSensitive(el, label)) continue;
      const opt = el.selectedOptions[0];
      if (opt && opt.value !== '') out.push({ field: label || el.name || 'select', value: opt.text.trim() });
    }
    for (const el of document.querySelectorAll('input[type=radio]:checked')) {
      if (el.disabled) continue;
      out.push({ field: legendOf(el) || el.name || 'choice', value: labelOf(el) || el.value });
    }
    return out.slice(0, 30);
  }

  const textLike = (el) => el.tagName === 'TEXTAREA' || ['text', 'search', ''].includes(el.type);

  /**
   * mode "max" (large-data test): text fields replace what is there; a field whose limit is stated gets real AI text
   * that is fitted to exactly that length; emails/URLs/phones/numbers/dates with a stated limit are built locally.
   * Fields that state no limit get normal AI data.
   */
  function scan({ overwrite, randomChoices, mode }) {
    registry.clear();
    nextId = 1;
    const max = mode === 'max';
    const c = collect(overwrite);
    if (max) c.text = collect(true).text;
    const fields = [];

    for (const { el, label } of c.text) {
      const id = `f${nextId++}`;
      const entry = { kind: 'text', el };
      const d = { ...describe(el, label), id, kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'text' };

      if (max) {
        const fixed = fixedMaxValue(el);
        if (fixed != null) {
          registry.set(id, { ...entry, fixed });
          continue;
        }
        const limit = textLike(el) ? statedLimit(el) : null;
        if (limit) {
          entry.fit = limit;
          d.fitTo = limit;
          d.aim = Math.min(limit, 1500);
        }
      }
      registry.set(id, entry);
      fields.push(d);
    }
    for (const { el, label } of c.checkboxes) {
      const id = `f${nextId++}`;
      registry.set(id, { kind: 'checkbox', el });
      fields.push({ ...describe(el, label), id, kind: 'checkbox' });
    }

    if (!randomChoices) {
      for (const { el, label, all } of c.selects) {
        const id = `f${nextId++}`;
        registry.set(id, { kind: 'select', el });
        fields.push({ ...describe(el, label), id, kind: 'select', options: all.slice(0, 60) });
      }
      for (const g of c.radioGroups) {
        const id = `f${nextId++}`;
        registry.set(id, { kind: 'radio', els: g.map((x) => x.el) });
        fields.push({
          id,
          kind: 'radio',
          name: g[0].el.name || undefined,
          label: legendOf(g[0].el) || g[0].el.name || '',
          options: g.slice(0, 30).map((x) => ({ value: x.el.value, text: x.label || x.el.value })),
        });
      }
    }

    const fixedCount = [...registry.values()].filter((e) => e.fixed != null).length;
    return { fields, fixedCount, choices: currentChoices() };
  }

  /** Picks drop-downs and radios first, so the AI can then match everything else to them. */
  function randomize({ overwrite }) {
    const c = collect(overwrite);
    const chosen = [];

    for (const s of c.selects) {
      const opt = randomItem(s.all);
      setNative(s.el, opt.value);
      randomized.add(s.el);
      chosen.push({ field: s.label || s.el.name || 'select', value: opt.text });
    }
    for (const g of c.radioGroups) {
      const opts = g.map((x) => ({ value: x.el.value, text: x.label || x.el.value, el: x.el }));
      const hit = randomItem(opts);
      hit.el.click();
      g.forEach((x) => randomized.add(x.el));
      chosen.push({ field: legendOf(g[0].el) || g[0].el.name || 'choice', value: hit.text });
    }
    return { chosen };
  }

  function setNative(el, value) {
    const proto =
      el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /** Returns null when applied, or a reason string when the value was rejected. */
  function apply(entry, value) {
    if (entry.kind === 'checkbox') {
      const want = value === true || same(value, 'true');
      if (entry.el.checked !== want) entry.el.click();
      return null;
    }

    if (entry.kind === 'radio') {
      const hit = entry.els.find((r) => same(r.value, value));
      if (!hit) return 'no matching option';
      hit.click();
      return null;
    }

    if (entry.kind === 'select') {
      const opt = [...entry.el.options].find((o) => same(o.value, value) || same(o.text, value));
      if (!opt) return 'no matching option';
      setNative(entry.el, opt.value);
      return null;
    }

    const el = entry.el;
    let v = String(value);
    if (el.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return 'not a valid email';
    if (el.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) return 'not a number';
      if (el.min !== '' && n < Number(el.min)) return 'below min';
      if (el.max !== '' && n > Number(el.max)) return 'above max';
    }
    if (el.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'wrong date format';
    if (el.type === 'time' && !/^\d{2}:\d{2}/.test(v)) return 'wrong time format';
    if (el.maxLength > 0 && v.length > el.maxLength) v = v.slice(0, el.maxLength);
    if (el.pattern) {
      try {
        if (!new RegExp(`^(?:${el.pattern})$`).test(v)) return 'does not match pattern';
      } catch {
        /* unusable pattern, ignore */
      }
    }
    setNative(el, v);
    return null;
  }

  function fill({ values }) {
    const filled = [];
    const rejected = [];
    const limits = []; // fields filled to their stated limit (large-data test)

    for (const [id, entry] of registry) {
      let value = entry.fixed ?? values?.[id];
      if (value == null || value === '') continue;
      if (entry.fit) value = fitLength(String(value), entry.fit);

      const label = entry.el?.name || entry.els?.[0]?.name || id;
      const reason = apply(entry, value);
      if (reason) {
        rejected.push({ field: label, reason });
        continue;
      }
      filled.push(label);
      if (entry.fit || entry.fixed != null) limits.push({ field: label, length: String(entry.el.value).length });
    }

    const notFilled = [...registry.entries()].filter(([id, e]) => e.fixed == null && !(id in (values ?? {}))).length;
    return { filled, rejected, notFilled, limits };
  }

  // ---- Large-data test helpers ----

  /**
   * Fits real text to exactly n characters: cut at a word boundary or extend by repeating the text.
   * From 40 characters up it ends with " END", so a form that cuts input shows no END after saving.
   */
  function fitLength(raw, n) {
    const s = raw.replace(/[ \t]+/g, ' ').trim();
    if (!s) return '';
    let out = s;
    if (s.length > n) {
      out = s.slice(0, n);
      const cut = out.lastIndexOf(' ');
      if (cut > n * 0.6) out = out.slice(0, cut);
    }
    while (out.length < n) out += ` ${s}`;
    out = out.slice(0, n);

    const bodyLen = n >= 40 ? n - 4 : n;
    let body = out.slice(0, bodyLen);
    if (/\s$/.test(body)) body = `${body.slice(0, -1)}.`;
    return n >= 40 ? `${body} END` : body;
  }

  /** Valid email of exactly `len` chars (local part max 64, labels max 63, total max 254), or null if too short. */
  function maxEmail(len) {
    len = Math.min(len, 254);
    const tail = '@example.com';
    if (len <= tail.length) return null;
    if (len - tail.length <= 64) return `${'a'.repeat(len - tail.length)}${tail}`;
    let local = 64;
    let rest = len - local - 1; // domain length
    if (rest < 13) {
      local -= 13 - rest;
      rest = 13;
    }
    const prefixLen = rest - 'example.com'.length - 1; // chars incl. dots before ".example.com"
    let n = prefixLen;
    while (n > 0 && n + Math.ceil(n / 63) - 1 > prefixLen) n--;
    const labels = [];
    for (let left = n; left > 0; left -= 63) labels.push('b'.repeat(Math.min(63, left)));
    return `${'a'.repeat(local)}@${labels.join('.')}.example.com`;
  }

  // Visible text that states a length limit: "max 500 characters", "līdz 200 simboliem", a "0 / 500" counter.
  const LIMIT_PATTERNS = [
    /(?:max(?:imum)?|līdz|ne vairāk kā|up to|no more than|limit)\D{0,30}?(\d{1,6})\s*(?:char|symbol|letter|simbol|zīm|rakstz)/i,
    /(\d{1,6})\s*(?:characters?|chars?|symbols?|simbol\w*|zīm\w*|rakstz\w*)\s*(?:max|maximum|limit)/i,
    /maksim\w*\D{0,40}(\d{1,6})/i,
  ];
  const COUNTER = /^\s*\d{1,6}\s*\/\s*(\d{1,6})\s*$/;

  /** Texts that belong to this field only: its label, placeholder, aria-describedby, and short text in its own wrapper. */
  function hintTexts(el) {
    const out = [];
    if (el.labels) for (const l of el.labels) out.push(text(l));
    if (el.placeholder) out.push(el.placeholder);
    if (el.title) out.push(el.title);
    const by = el.getAttribute('aria-describedby');
    if (by) by.split(/\s+/).forEach((id) => out.push(text(document.getElementById(id))));

    let node = el;
    for (let i = 0; i < 3; i++) {
      node = node.parentElement;
      // stop before a wrapper that holds other fields, so we never read another field's hint
      if (!node || node.querySelectorAll('input, textarea, select').length > 1) break;
      for (const n of node.querySelectorAll('*')) {
        if (n === el || n.children.length || ['SCRIPT', 'STYLE', 'OPTION'].includes(n.tagName)) continue;
        const t = text(n);
        if (t && t.length <= 100) out.push(t);
      }
    }
    return out.filter(Boolean);
  }

  /** The limit the page states: the maxlength attribute and/or text near the field. Null when it states none. */
  function statedLimit(el) {
    const attr = el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength : null;
    let hint = null;
    for (const t of hintTexts(el)) {
      const found = [COUNTER, ...LIMIT_PATTERNS].map((re) => t.match(re)).find(Boolean);
      const n = found ? parseInt(found[1], 10) : 0;
      if (n >= 1 && n <= 100000) hint = hint == null ? n : Math.min(hint, n);
    }
    return attr != null && hint != null ? Math.min(attr, hint) : attr ?? hint;
  }

  /**
   * Values that cannot be "real text" and are built locally: a number/date at its max attribute, or an email/URL/phone
   * of exactly the stated length. Returns null when this field should get AI data instead.
   */
  function fixedMaxValue(el) {
    const type = el.type;
    if (type === 'number') return el.max !== '' ? el.max : null;
    if (['date', 'time', 'datetime-local', 'month', 'week'].includes(type)) return el.max || null;
    if (!['email', 'url', 'tel'].includes(type)) return null;

    const len = statedLimit(el);
    if (!len) return null;
    if (type === 'email') return maxEmail(len);
    if (type === 'url') {
      const base = 'https://example.com/';
      return len > base.length ? base + 'a'.repeat(len - base.length) : null;
    }
    return '1234567890'.repeat(Math.ceil(len / 10)).slice(0, len);
  }

  /**
   * Waits for the page to react to a choice (dependent lists, fields that appear). Resolves after at least `minWait` ms
   * and once the DOM has been quiet for `quiet` ms, or after `max` ms at the latest.
   */
  function settle({ minWait = 800, quiet = 400, max = 4000 } = {}) {
    return new Promise((resolve) => {
      const start = Date.now();
      let timer;
      const finish = () => {
        obs.disconnect();
        resolve({});
      };
      const check = () => {
        const left = minWait - (Date.now() - start);
        if (left > 0) timer = setTimeout(check, left);
        else finish();
      };
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(check, quiet);
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(check, quiet);
      setTimeout(finish, max);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'settle') {
      settle(msg).then(sendResponse);
      return true; // async response
    }
    if (msg.type === 'scan') sendResponse(scan(msg));
    else if (msg.type === 'randomize') sendResponse(randomize(msg));
    else if (msg.type === 'fill') sendResponse(fill(msg));
    return false;
  });
})();
