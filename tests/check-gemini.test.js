import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API, PROMPT, checkGemini, explainError, geminiRequest, hideKey, parseDevVars, readReply, textModel } from '../scripts/check-gemini.mjs';
import { parseJsonc } from '../scripts/jsonc.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const WRANGLER = read('wrangler.jsonc');
const KEY = 'test-key-123';

// A generateContent answer from a thinking model, shaped like ai.google.dev/api/generate-content on 9 Oct 2026.
const ANSWER = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'Pensando…', thought: true }, { text: '¡Hola!' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 20, totalTokenCount: 30 },
  modelVersion: 'gemini-3.8-flash',
};

/** A folder with wrangler.jsonc and, when given, a .dev.vars file. @param {string} [devVars] */
function repo(devVars) {
  const dir = mkdtempSync(join(tmpdir(), 'hecho-gemini-'));
  copyFileSync(new URL('../wrangler.jsonc', import.meta.url), join(dir, 'wrangler.jsonc'));
  if (devVars !== undefined) writeFileSync(join(dir, '.dev.vars'), devVars);
  return dir;
}

test('git ignores .dev.vars, and the example has no key', () => {
  assert.ok(read('.gitignore').split('\n').includes('.dev.vars'));
  assert.equal(parseDevVars(read('.dev.vars.example')).GEMINI_API_KEY, '');
});

test('wrangler.jsonc names the Gemini models', () => {
  assert.equal(textModel({}, WRANGLER), 'gemini-3.8-flash');
  assert.equal(parseJsonc(WRANGLER).vars.GEMINI_LIVE_MODEL, 'gemini-3.8-live');
});

test('parseDevVars reads KEY=value lines', () => {
  const vars = parseDevVars('# a comment\n\nGEMINI_API_KEY = abc=123 \r\nexport A="quoted # kept"\nB=\'single\'\nC=plain # note\nnot a line\n');
  assert.deepEqual(vars, { GEMINI_API_KEY: 'abc=123', A: 'quoted # kept', B: 'single', C: 'plain' });
});

test('textModel takes .dev.vars first, then wrangler.jsonc', () => {
  assert.equal(textModel({ GEMINI_TEXT_MODEL: 'gemini-3.1-flash-lite' }, WRANGLER), 'gemini-3.1-flash-lite');
  assert.equal(textModel({}, '{ "vars": {} }'), '');
});

test('geminiRequest sends the key in a header, never in the address', () => {
  const { url, init } = geminiRequest(KEY, 'gemini-3.8-flash');
  assert.equal(url, `${API}/gemini-3.8-flash:generateContent`);
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-goog-api-key'], KEY);
  assert.deepEqual(JSON.parse(init.body), { contents: [{ role: 'user', parts: [{ text: PROMPT }] }] });
  assert.ok(!url.includes(KEY));
});

test('readReply gives the reply without the thinking, and the token counts', () => {
  assert.deepEqual(readReply(ANSWER), { text: '¡Hola!', tokens: { prompt: 7, reply: 3, thinking: 20, total: 30 } });
  assert.deepEqual(readReply({}), { text: '', tokens: { prompt: 0, reply: 0, thinking: 0, total: 0 } });
});

test('explainError says what to check', () => {
  const badKey = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } };
  assert.match(explainError(400, badKey), /^HTTP 400\. Google refused the key\. Check GEMINI_API_KEY in \.dev\.vars\. Google says: API key not valid/);
  assert.match(explainError(404, null), /no model with that name/);
  assert.match(explainError(503, null), /Try again in a minute/);
});

test('checkGemini says what is missing before it calls Google', async () => {
  const fail = async () => assert.fail('no request expected');
  for (const [devVars, message] of [
    [undefined, /There is no \.dev\.vars file\. Copy \.dev\.vars\.example/],
    ['OTHER=1\n', /\.dev\.vars has no GEMINI_API_KEY/],
    ['GEMINI_API_KEY=\n', /\.dev\.vars has no GEMINI_API_KEY/],
    ['GEMINI_API_KEY=<AIza-secret-123>\n', /: GEMINI_API_KEY in \.dev\.vars is in angle brackets\. Put only the key after GEMINI_API_KEY=\.$/],
  ]) {
    const dir = repo(devVars);
    try {
      await assert.rejects(checkGemini({ root: dir, fetchFn: fail }), message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('checkGemini hides the key when Google or the network repeats it', async () => {
  const dir = repo(`GEMINI_API_KEY=${KEY}\n`);
  try {
    const echoed = { error: { message: `Key ${KEY} was refused.` } };
    await assert.rejects(
      checkGemini({ root: dir, fetchFn: async () => Response.json(echoed, { status: 400 }) }),
      (err) => err.message.includes('Key (the key) was refused.') && !err.message.includes(KEY));
    await assert.rejects(
      checkGemini({ root: dir, fetchFn: async () => { throw new Error(`proxy refused ${KEY}`); } }),
      (err) => err.message.includes('proxy refused (the key)') && !err.message.includes(KEY));
    const lines = await checkGemini({ root: dir, fetchFn: async () => Response.json({ ...ANSWER, candidates: [{ content: { parts: [{ text: KEY }] } }] }) });
    assert.ok(!lines.join('\n').includes(KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hideKey leaves text alone when there is no key', () => {
  assert.equal(hideKey('abc', ''), 'abc');
  assert.equal(hideKey('a-k-b-k', 'k'), 'a-(the key)-b-(the key)');
});

test('checkGemini prints the reply and token counts, and never the key', async () => {
  const dir = repo(`GEMINI_API_KEY=${KEY}\n`);
  try {
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    const lines = await checkGemini({ root: dir, fetchFn: async (url, init) => { calls.push({ url, init }); return Response.json(ANSWER); } });
    assert.deepEqual(lines, ['Model: gemini-3.8-flash', 'Reply: ¡Hola!', 'Tokens: 7 in, 3 out, 20 thinking, 30 in total']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers['x-goog-api-key'], KEY);
    assert.ok(!lines.join('\n').includes(KEY));

    const refused = { error: { message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } };
    await assert.rejects(
      checkGemini({ root: dir, fetchFn: async () => Response.json(refused, { status: 400 }) }),
      (err) => err.message.startsWith('gemini-3.8-flash: HTTP 400. Google refused the key.') && !err.message.includes(KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
