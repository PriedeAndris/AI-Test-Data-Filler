// The only place that talks to an AI provider. A call goes to exactly one provider: the one the user selected.

export const PROVIDERS = {
  claude: { label: 'Claude (Anthropic)', defaultModel: 'claude-haiku-4-5-20251001', keyHint: 'sk-ant-…' },
  openai: { label: 'ChatGPT (OpenAI)', defaultModel: 'gpt-4o-mini', keyHint: 'sk-…' },
};

export function parseJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The AI did not return JSON. Try again.');
  try {
    return JSON.parse(m[0]);
  } catch {
    throw new Error('The AI returned invalid JSON. Try again.');
  }
}

async function failure(res, label) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
  } catch {
    /* ignore */
  }
  if (res.status === 401) return new Error(`${label}: the API key was rejected (401). Check it in the extension setup.`);
  if (res.status === 429) return new Error(`${label}: rate limit or no credit (429). ${detail}`.trim());
  return new Error(`${label}: request failed (${res.status}). ${detail}`.trim());
}

/**
 * @param {{provider: 'claude'|'openai', apiKey: string, model: string, system: string, prompt: string}} o
 * @returns {Promise<object>} parsed JSON object
 */
export async function askAI({ provider, apiKey, model, system, prompt }) {
  if (!PROVIDERS[provider]) throw new Error(`Unknown provider "${provider}"`);
  const label = PROVIDERS[provider].label;

  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: 8000, system, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw await failure(res, label);
    const data = await res.json();
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return parseJson(text);
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw await failure(res, label);
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content ?? '');
}
