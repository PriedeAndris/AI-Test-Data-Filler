import { PROVIDERS } from './providers.js';

const $ = (id) => document.getElementById(id);
const status = (text, cls = '') => {
  $('status').className = `status ${cls}`;
  $('status').textContent = text;
};

function refreshProviderChoices(selected) {
  const withKey = Object.keys(PROVIDERS).filter((p) => $(`${p}Key`).value.trim());
  $('provider').innerHTML = withKey.length
    ? withKey.map((p) => `<option value="${p}">${PROVIDERS[p].label}</option>`).join('')
    : '<option value="">(enter a key first)</option>';
  $('provider').disabled = withKey.length === 0;
  if (withKey.includes(selected)) $('provider').value = selected;
}

async function load() {
  const s = await chrome.storage.local.get(['keys', 'provider', 'models']);
  for (const p of Object.keys(PROVIDERS)) {
    $(`${p}Key`).value = s.keys?.[p] ?? '';
    $(`${p}Model`).value = s.models?.[p] ?? '';
    $(`${p}Model`).placeholder = PROVIDERS[p].defaultModel;
    $(`${p}Key`).addEventListener('input', () => refreshProviderChoices($('provider').value));
  }
  refreshProviderChoices(s.provider);
}

async function save() {
  const keys = {};
  const models = {};
  for (const p of Object.keys(PROVIDERS)) {
    keys[p] = $(`${p}Key`).value.trim();
    models[p] = $(`${p}Model`).value.trim();
  }
  await chrome.storage.local.set({ keys, models, provider: $('provider').value });
}

$('save').onclick = async () => {
  await save();
  status('Saved.', 'ok');
};

$('test').onclick = async () => {
  await save();
  status('Testing…', 'muted');
  const r = await chrome.runtime.sendMessage({ type: 'test' });
  if (r.error) status(r.error, 'err');
  else status(r.ok ? `Connected to ${r.provider} (${r.model}).` : `${r.provider} answered, but not as expected.`, r.ok ? 'ok' : 'err');
};

load();
