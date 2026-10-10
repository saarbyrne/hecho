// @ts-check
/**
 * npm run check:gemini
 * Sends one short prompt to Hecho's Gemini text model with the key in .dev.vars, then prints the reply and
 * the token counts. The model is GEMINI_TEXT_MODEL from .dev.vars, or else from vars in wrangler.jsonc.
 * It never prints the key.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './jsonc.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const API = 'https://generativelanguage.googleapis.com/v1beta/models';
export const PROMPT = 'Di hola en una palabra.';

/**
 * Reads KEY=value lines, the format of .dev.vars. Skips blank lines and # comments, and removes quotes.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDevVars(text) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (line.startsWith('#') || eq < 1) continue;
    const value = line.slice(eq + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    vars[line.slice(0, eq).trim()] = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
  }
  return vars;
}

/**
 * GEMINI_TEXT_MODEL from .dev.vars, or else from vars in wrangler.jsonc. '' when neither has it.
 * @param {Record<string, string>} devVars
 * @param {string} wranglerText the contents of wrangler.jsonc
 * @returns {string}
 */
export function textModel(devVars, wranglerText) {
  return devVars.GEMINI_TEXT_MODEL || parseJsonc(wranglerText).vars?.GEMINI_TEXT_MODEL || '';
}

/**
 * The generateContent request for one prompt. The key goes in a header, so it stays out of the address.
 * @param {string} key
 * @param {string} model
 * @param {string} [prompt]
 */
export function geminiRequest(key, model, prompt = PROMPT) {
  return {
    url: `${API}/${encodeURIComponent(model)}:generateContent`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    },
  };
}

/**
 * The reply text and the token counts from a generateContent answer. Thinking is left out of the text.
 * @param {any} body
 */
export function readReply(body) {
  /** @type {{ text?: string, thought?: boolean }[]} */
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const usage = body?.usageMetadata ?? {};
  return {
    text: parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim(),
    tokens: {
      prompt: usage.promptTokenCount ?? 0,
      reply: usage.candidatesTokenCount ?? 0,
      thinking: usage.thoughtsTokenCount ?? 0,
      total: usage.totalTokenCount ?? 0,
    },
  };
}

/** @type {Record<number, string>} What to check for each HTTP status. */
const HINTS = {
  402: 'The prepaid credit has run out. Add credit in Google AI Studio.',
  403: 'The key may not use the Gemini API. Check its restrictions in Google AI Studio.',
  404: 'Google has no model with that name. Check it on ai.google.dev/gemini-api/docs/models.',
  429: 'Too many requests, or no quota left. Check billing for the project in Google AI Studio.',
};

/**
 * What went wrong, in plain words, with Google's own message.
 * @param {number} status
 * @param {any} body
 */
export function explainError(status, body) {
  /** @type {{ reason?: string }[]} */
  const details = body?.error?.details ?? [];
  const hint = details.some((d) => d.reason === 'API_KEY_INVALID')
    ? 'Google refused the key. Check GEMINI_API_KEY in .dev.vars.'
    : HINTS[status] ?? (status >= 500 ? 'Google had a problem. Try again in a minute.' : 'The request failed.');
  const google = body?.error?.message ? ` Google says: ${body.error.message}` : '';
  return `HTTP ${status}. ${hint}${google}`;
}

/**
 * The text with every copy of the key replaced, in case an error message repeats it.
 * @param {string} text
 * @param {string} key
 */
export function hideKey(text, key) {
  return key ? text.split(key).join('(the key)') : text;
}

/**
 * Runs the check and gives the lines to print. Throws an Error with a plain message when something is missing or fails.
 * No message or line ever contains the key.
 * @param {{ root?: string, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<string[]>}
 */
export async function checkGemini({ root = ROOT, fetchFn = fetch } = {}) {
  const file = join(root, '.dev.vars');
  if (!existsSync(file)) throw new Error('There is no .dev.vars file. Copy .dev.vars.example to .dev.vars and put the key in it.');
  const vars = parseDevVars(readFileSync(file, 'utf8'));
  const key = vars.GEMINI_API_KEY ?? '';
  if (!key) throw new Error('.dev.vars has no GEMINI_API_KEY. Add a line that starts with GEMINI_API_KEY= and then the key.');
  if (/^<.*>$/.test(key)) throw new Error('GEMINI_API_KEY in .dev.vars is in angle brackets. Put only the key after GEMINI_API_KEY=.');
  const model = textModel(vars, readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
  if (!model) throw new Error('There is no text model. Add GEMINI_TEXT_MODEL to vars in wrangler.jsonc.');

  const { url, init } = geminiRequest(key, model);
  /** @type {Response} */
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    throw new Error(hideKey(`Could not reach Gemini. Check the internet connection. (${err instanceof Error ? err.message : err})`, key));
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(hideKey(`${model}: ${explainError(res.status, body)}`, key));
  const { text, tokens } = readReply(body);
  const thinking = tokens.thinking ? `, ${tokens.thinking} thinking` : '';
  return [
    `Model: ${model}`,
    `Reply: ${text || '(empty)'}`,
    `Tokens: ${tokens.prompt} in, ${tokens.reply} out${thinking}, ${tokens.total} in total`,
  ].map((line) => hideKey(line, key));
}

async function main() {
  try {
    for (const line of await checkGemini()) console.log(line);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Runs only when called as a script, so tests can import the functions above.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
