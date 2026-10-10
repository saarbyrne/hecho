// @ts-check
/**
 * Helpers for the voice test (Obsidian `Voice test.md`): WAV files, the
 * learner's script, prompts, scoring and cost. Nothing here talks to a server.
 */

/** Live models take 16-bit PCM at 16 kHz. */
export const INPUT_RATE = 16000;
/** Audio goes to the model in chunks of this length, in real time, like a microphone. */
export const CHUNK_MS = 100;

/**
 * Read a 16-bit PCM WAV file. Returns the first channel.
 * @param {Uint8Array} buf
 * @returns {{ rate: number, samples: Int16Array }}
 */
export function readWav(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (/** @type {number} */ o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');
  /** @type {{ format: number, channels: number, rate: number, bits: number } | null} */
  let fmt = null;
  /** @type {{ start: number, size: number } | null} */
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, buf.length - body) };
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('The WAV file has no format or no data.');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('Only 16-bit PCM WAV files are supported.');
  const frames = Math.floor(data.size / (2 * fmt.channels));
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = view.getInt16(data.start + i * 2 * fmt.channels, true);
  return { rate: fmt.rate, samples };
}

/**
 * A mono 16-bit PCM WAV file.
 * @param {Int16Array} samples
 * @param {number} rate
 * @returns {Uint8Array}
 */
export function writeWav(samples, rate) {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const text = (/** @type {number} */ o, /** @type {string} */ s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return out;
}

/**
 * Change the sample rate by linear interpolation.
 * @param {Int16Array} samples
 * @param {number} from
 * @param {number} to
 */
export function resample(samples, from, to) {
  if (from === to) return samples;
  const length = Math.round((samples.length * to) / from);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const pos = (i * from) / to;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, samples.length - 1);
    out[i] = Math.round(samples[a] + (samples[b] - samples[a]) * (pos - a));
  }
  return out;
}

/** @param {Int16Array} samples */
export function pcmToBase64(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
}

/** @param {string} b64 */
export function base64ToPcm(b64) {
  const bytes = Buffer.from(b64, 'base64');
  const copy = new Uint8Array(bytes.length - (bytes.length % 2));
  copy.set(bytes.subarray(0, copy.length));
  return new Int16Array(copy.buffer);
}

/** The sample rate in a mime type like "audio/pcm;rate=24000". @param {string} mime */
export function rateOf(mime) {
  const m = /rate=(\d+)/.exec(mime ?? '');
  return m ? Number(m[1]) : 24000;
}

/**
 * A learner answer. Pauses are written as {1.4}, in seconds.
 * @typedef {{ label: string, say: string }} Line
 */

/** The text of a line without its pause marks. @param {string} say */
export const plainText = (say) => say.replace(/\s*\{\d+(\.\d+)?\}\s*/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The text for the Mac's `say` command, with pauses as [[slnc ms]].
 * @param {string} say
 */
export const sayText = (say) => say.replace(/\{(\d+(?:\.\d+)?)\}/g, (_, s) => `[[slnc ${Math.round(Number(s) * 1000)}]]`);

/** The pauses in a line, in seconds. @param {string} say */
export const pausesOf = (say) => [...say.matchAll(/\{(\d+(?:\.\d+)?)\}/g)].map((m) => Number(m[1]));

/**
 * Lower case, no accents, no punctuation.
 * @param {string} text
 */
export function words(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * How much of what was said the model's transcript got right: 1 minus the word
 * error rate, from 0 to 1.
 * @param {string} said
 * @param {string} heard
 */
export function wordAccuracy(said, heard) {
  const a = words(said);
  const b = words(heard);
  if (!a.length) return b.length ? 0 : 1;
  /** @type {number[]} */
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return Math.max(0, 1 - prev[b.length] / a.length);
}

const ORDINALS = ['primera', 'segunda', 'tercera', 'cuarta', 'quinta'];

/**
 * The question numbers the model said, in order, from "primera pregunta" to
 * "quinta y última pregunta".
 * @param {string[]} replies
 * @returns {number[]}
 */
export function questionNumbers(replies) {
  /** @type {number[]} */
  const found = [];
  for (const reply of replies) {
    const w = words(reply);
    w.forEach((word, i) => {
      const n = ORDINALS.indexOf(word);
      if (n === -1) return;
      const near = w.slice(i + 1, i + 4);
      if (near.includes('pregunta')) found.push(n + 1);
    });
  }
  return found;
}

/**
 * Whether the model asked questions 1 to 5 once each, in order.
 * @param {number[]} numbers from questionNumbers
 */
export function questionOrder(numbers) {
  const repeats = numbers.length - new Set(numbers).size;
  const missing = [1, 2, 3, 4, 5].filter((n) => !numbers.includes(n));
  const inOrder = numbers.every((n, i) => i === 0 || n > numbers[i - 1]);
  return { ok: repeats === 0 && missing.length === 0 && inOrder, repeats, missing, inOrder, numbers };
}

/**
 * Prices per 1M tokens, paid tier, from ai.google.dev/gemini-api/docs/pricing
 * on 10 October 2026. Thinking tokens are billed as text output.
 * @typedef {{ textIn: number, audioIn: number, textOut: number, audioOut: number }} Prices
 * @type {Record<string, Prices>}
 */
export const PRICES = {
  'gemini-3.8-live': { textIn: 0.75, audioIn: 3, textOut: 4.5, audioOut: 12 },
  'gemini-3.1-flash-live-preview': { textIn: 0.75, audioIn: 3, textOut: 4.5, audioOut: 12 },
  'gemini-2.5-flash-native-audio-latest': { textIn: 0.5, audioIn: 3, textOut: 2, audioOut: 12 },
};

/** @param {any} details [{ modality, tokenCount }] */
export function byModality(details) {
  const out = { audio: 0, text: 0 };
  for (const d of Array.isArray(details) ? details : []) {
    const n = Number(d?.tokenCount) || 0;
    if (d?.modality === 'AUDIO') out.audio += n;
    else out.text += n;
  }
  return out;
}

/**
 * The cost of a session from its usage reports, in dollars, two ways.
 * `everyTurn` bills every turn for the whole session so far (the sum of all
 * reports), which is how Google's Live API guide describes it
 * (ai.google.dev/gemini-api/docs/live-api/best-practices, 15 September 2026).
 * `newOnly` bills each token once (the last report's prompt plus every
 * reply), for comparison.
 * @param {any[]} reports usageMetadata objects, in order
 * @param {Prices} price
 */
export function sessionCost(reports, price) {
  const out = { audio: 0, text: 0, thinking: 0 };
  const inSum = { audio: 0, text: 0 };
  for (const r of reports) {
    const i = byModality(r?.promptTokensDetails);
    inSum.audio += i.audio;
    inSum.text += i.text;
    const o = byModality(r?.responseTokensDetails);
    out.audio += o.audio;
    out.text += o.text;
    out.thinking += Number(r?.thoughtsTokenCount) || 0;
  }
  const last = byModality(reports.at(-1)?.promptTokensDetails);
  const replies = (out.audio * price.audioOut + (out.text + out.thinking) * price.textOut) / 1e6;
  return {
    everyTurn: (inSum.audio * price.audioIn + inSum.text * price.textIn) / 1e6 + replies,
    newOnly: (last.audio * price.audioIn + last.text * price.textIn) / 1e6 + replies,
    tokens: { inputEveryTurn: inSum.audio + inSum.text, inputNewOnly: last.audio + last.text, outputAudio: out.audio, outputText: out.text, thinking: out.thinking },
  };
}

/** @param {number[]} xs */
export const average = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
