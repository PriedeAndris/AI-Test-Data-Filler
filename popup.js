const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const status = (html, cls = '') => {
  $('status').className = `status ${cls}`;
  $('status').innerHTML = html;
};

async function init() {
  const prefs = await chrome.storage.local.get(['lang', 'notes', 'overwrite', 'randomChoices']);
  $('lang').value = prefs.lang ?? '';
  $('notes').value = prefs.notes ?? '';
  $('overwrite').checked = Boolean(prefs.overwrite);
  $('randomChoices').checked = prefs.randomChoices ?? true;

  const cfg = await chrome.runtime.sendMessage({ type: 'config' });
  if (cfg.provider) {
    $('provider').textContent = `Using ${cfg.label} · ${cfg.model}`;
  } else {
    $('provider').innerHTML = '<span class="err">No API key yet.</span>';
    $('fill').disabled = true;
    $('fillMax').disabled = true;
    status('Open <b>Setup</b> and choose Claude or ChatGPT.', 'muted');
  }
}

const activeTabId = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;

function report(r) {
  if (r.error) return status(esc(r.error), 'err');

  const lines = [`<span class="ok">Filled ${r.filled.length} of ${r.scanned} fields</span> via ${esc(r.provider)}.`];
  if (r.limits?.length) {
    lines.push(`<b>Filled to the stated limit:</b> ${esc(r.limits.map((x) => `${x.field} (${x.length})`).join(', '))}`);
  }
  if (r.rejected.length) lines.push(`Rejected: ${esc(r.rejected.map((x) => `${x.field} (${x.reason})`).join(', '))}`);
  if (r.notFilled) lines.push(`${r.notFilled} field(s) left empty by the AI.`);
  if (r.capped) lines.push('Page has many fields; only the first 80 were sent.');
  lines.push('<span class="muted">Click again for a new random set.</span>');
  status(lines.join('<br>'));
}

async function start(button, mode, message) {
  const lang = $('lang').value.trim();
  const notes = $('notes').value.trim();
  const overwrite = $('overwrite').checked;
  const randomChoices = $('randomChoices').checked;
  await chrome.storage.local.set({ lang, notes, overwrite, randomChoices });

  button.disabled = true;
  status(message, 'muted');
  const r = await chrome.runtime.sendMessage({ type: 'run', tabId: await activeTabId(), lang, notes, overwrite, randomChoices, mode });
  button.disabled = false;
  report(r);
}

$('fill').onclick = () => start($('fill'), 'normal', 'Reading the form and asking the AI…');
$('fillMax').onclick = () => start($('fillMax'), 'max', 'Reading the form and asking the AI for long texts…');

$('setup').onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

init();
