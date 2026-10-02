// Orchestrates one run: inject content script -> scan form fields -> ask the selected AI -> fill.
import { askAI, PROVIDERS } from './providers.js';

const MAX_FIELDS = 80;

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

/** Active provider = the selected one if it has a key, otherwise the only one that has a key. */
export async function getConfig() {
  const s = await chrome.storage.local.get(['keys', 'provider', 'models']);
  const keys = s.keys ?? {};
  const withKey = Object.keys(PROVIDERS).filter((p) => keys[p]);
  const provider = withKey.includes(s.provider) ? s.provider : withKey.length === 1 ? withKey[0] : null;
  if (!provider) return { provider: null };
  return {
    provider,
    apiKey: keys[provider],
    model: s.models?.[provider] || PROVIDERS[provider].defaultModel,
  };
}

const SYSTEM = `You generate fictional test data for filling web forms during software testing.
You receive a JSON list of form fields and return ONE JSON object: keys are the field "id" values, values are what to type or select.
Rules:
- Invent one coherent fictional person or company per run (same first name in the name fields and email), and make each run clearly different from typical output. Avoid generic names like John Doe or Jane Smith.
- CONSISTENCY: if the form asks for details of a person or company, keep them all in ONE country. A country, state or region already selected on the page ("Selections already made") decides it. If none is selected, pick any country at random and vary it between runs. Then make everything match it: first name and surname typical for that country, address and city in it, postal code in that country's format, and a phone number with that country's dialing code and national format. If the form is not about a person or company (a product, search or settings form, for example), ignore this rule.
- The language of field labels, and of the page, says nothing about the person's country. Never infer the country from label language.
- The "Language for free text" setting applies only to descriptive text (comments, descriptions, messages), not to names or addresses.
- All data is fictional. Emails must use example.com, example.org or example.net. Phone numbers must look valid for the country but be fictional. Addresses must look plausible but not belong to real people.
- RELATED FIELDS MUST AGREE. Use the given "Today's date" for anything date-related. An age must equal the full years between the date of birth and today (check whether the birthday has already passed this year). Event or booking dates must be in the future unless the label implies the past. Start times come before end times, and a total must match its parts. Decide one person first, then derive every dependent value from it.
- Values are strings. For checkbox fields use true or false.
- For select and radio fields return exactly one of the listed option "value" strings.
- Respect each field's type, format, maxlength, min, max and pattern. For date, time and number types follow the stated format.
- A field with "fitTo" and "aim" is part of a large-data test: write a realistic, natural value for that field that is as long as is plausible, close to "aim" characters, and never longer than "fitTo". For a description, comment or message write coherent sentences or paragraphs in the free-text language, on a topic that fits the label. For a single-line field such as a name or title write the longest plausible realistic value. No lorem ipsum, no filler, no repeated sentences, no markers. The extension adjusts the final length itself.
- Give a value for EVERY field in the list. The extension has already removed fields that must not be touched, so never skip a field because its label or name sounds like it should be left alone (for example "prefilled" or "already filled"). Leave an id out only when no test value could ever be valid, such as a CAPTCHA.
- Never invent passwords, payment card numbers or security codes.
Reply with the JSON object only, no markdown and no commentary.`;

function buildPrompt({ fields, choices, lang, notes }) {
  const variation = Math.random().toString(36).slice(2, 10);
  return [
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    `Language for free text: ${lang || 'English'}`,
    choices.length
      ? `Selections already made on the page (fixed, keep all data consistent with them):\n${JSON.stringify(choices)}`
      : 'Selections already made on the page: none',
    `Variation token (makes this run differ from previous ones): ${variation}`,
    notes ? `User instructions: ${notes}` : '',
    `Fields:\n${JSON.stringify(fields)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return null;
  } catch {
    return "This page can't be filled (browser pages, the Web Store and PDFs are blocked).";
  }
}

/**
 * Picks drop-downs/radios at random. A choice (a country, say) can load a dependent list or reveal new fields, so after
 * each pass wait for the page to settle and pick again, until a pass finds nothing new.
 */
async function pickRandomChoices(tabId, overwrite) {
  const chosen = [];
  for (let pass = 0; pass < 4; pass++) {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'randomize', overwrite });
    if (!r.chosen.length) break;
    chosen.push(...r.chosen);
    await chrome.tabs.sendMessage(tabId, { type: 'settle' });
  }
  return chosen;
}

/**
 * One run for both buttons. mode "max" is the large-data test: fields that state a length limit get real AI text
 * fitted to exactly that length, everything else gets normal AI data.
 */
async function run({ tabId, lang, notes, overwrite, randomChoices, mode }) {
  const cfg = await getConfig();
  if (!cfg.provider) return { error: 'Set up an API key first (Claude or ChatGPT).', needSetup: true };

  const failed = await inject(tabId);
  if (failed) return { error: failed };

  // 1. Pick drop-downs/radios first, so the AI can match its data to them.
  const chosen = randomChoices ? await pickRandomChoices(tabId, overwrite) : [];

  // 2. Read the rest of the form plus the selections now on the page, and let the AI match its data to them.
  const scan = await chrome.tabs.sendMessage(tabId, { type: 'scan', overwrite, randomChoices, mode });
  if (!scan.fields.length && !scan.fixedCount && !chosen.length) {
    return { error: 'No fillable fields found on this page (already-filled fields are skipped).' };
  }

  // Only drop-downs/radios on the page: nothing for the AI to write, so no API call.
  const fields = scan.fields.slice(0, MAX_FIELDS);
  const values = fields.length
    ? await askAI({
        provider: cfg.provider,
        apiKey: cfg.apiKey,
        model: cfg.model,
        system: SYSTEM,
        prompt: buildPrompt({ fields, choices: scan.choices, lang, notes }),
      })
    : {};

  const result = await chrome.tabs.sendMessage(tabId, { type: 'fill', values });
  return {
    provider: PROVIDERS[cfg.provider].label,
    model: cfg.model,
    scanned: fields.length + scan.fixedCount + chosen.length,
    capped: scan.fields.length > MAX_FIELDS,
    chosen,
    filled: [...result.filled, ...chosen.map((c) => c.field)],
    rejected: result.rejected,
    notFilled: result.notFilled,
    limits: result.limits,
  };
}

async function testKey() {
  const cfg = await getConfig();
  if (!cfg.provider) return { error: 'No API key saved.' };
  const r = await askAI({
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    model: cfg.model,
    system: 'Reply with the JSON object {"ok": true} and nothing else.',
    prompt: 'ping',
  });
  return { ok: r.ok === true, provider: PROVIDERS[cfg.provider].label, model: cfg.model };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = { run, test: testKey, config: async () => {
    const c = await getConfig();
    return c.provider ? { provider: c.provider, label: PROVIDERS[c.provider].label, model: c.model } : { provider: null };
  } };
  const h = handlers[msg.type];
  if (!h) return false;
  h(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: e.message }));
  return true;
});
