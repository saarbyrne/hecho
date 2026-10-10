// @ts-check
/**
 * One simulated "5 preguntas" session as a pipeline instead of a Live session.
 * The app decides when the learner has finished. Gemini Flash-Lite gets the
 * answer as audio, with the conversation so far as text, and returns what it
 * heard and its reply. Gemini's text-to-speech then says the reply. Each call
 * bills only what it gets, so the cost grows with the minutes instead of with
 * every turn, as it does on the Live API.
 */
import { INPUT_RATE, base64ToPcm, byModality, readWav, writeWav } from './lib.mjs';
import { REACTION_MS, newTurn } from './session.mjs';

export const API = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Prices per 1M tokens from ai.google.dev/gemini-api/docs/pricing on
 * 10 October 2026. Google's text-to-speech prices double on 1 January 2027.
 * Audio is 25 tokens a second.
 */
/** @type {Record<string, { textIn: number, audioIn?: number, textOut?: number, audioOut?: number }>} */
export const PIPELINE_PRICES = {
  'gemini-3.1-flash-lite': { textIn: 0.25, audioIn: 0.5, textOut: 1.5 },
  'gemini-3.8-flash-lite-tts': { textIn: 0.5, audioOut: 6 },
};
export const AUDIO_TOKENS_PER_SECOND = 25;

/** Added to charla's prompt, because the reply comes back as text. */
export const PIPELINE_RULES = `
Formato:
- Recibes lo que digo como audio. Contesta en JSON con dos campos.
- "heard": lo que he dicho, palabra por palabra y sin corregir mis errores. Si no entiendes una parte, escribe [?].
- "reply": tu respuesta, de 25 palabras como mucho. Se va a leer en voz alta, así que escribe solo frases, sin emojis, listas ni símbolos.
- Di «¿Sí?» solo si mi frase acaba a medias, por ejemplo en «pero», «y» o «porque», y entonces no digas nada más. Si mi respuesta está completa, no digas «¿Sí?» ni «Sigue».`;

/** How the text-to-speech should speak. The accent comes from the voice. */
export const SPEECH_STYLE = 'Habla despacio y con claridad, con un tono amable, como un profesor con un alumno de nivel básico.';

/** The fallback voice when no Spain Spanish voice is found or accepted. */
export const FALLBACK_VOICE = 'Kore';

const REPLY_SCHEMA = {
  type: 'OBJECT',
  properties: { heard: { type: 'STRING' }, reply: { type: 'STRING' } },
  required: ['heard', 'reply'],
};

/**
 * @typedef {{ role: 'user' | 'model', text: string }} Message
 * @typedef {{ text: string } | { audio: Int16Array }} Input
 * @typedef {{ heard: string, reply: string, usage: any, cost: number }} Reply
 * @typedef {{ audio: Int16Array[], rate: number, usage: any, cost: number }} Speech
 * @typedef {{
 *   reply: (history: Message[], input: Input, note?: string) => Promise<Reply>,
 *   speak: (text: string, onFirstAudio: () => void) => Promise<Speech>,
 *   notes: string[],
 * }} Pipeline
 */

/** A reply that takes longer than this is given up on and asked once more. */
export const REPLY_TIMEOUT_MS = 20_000;
/** A voice stream that sends nothing for this long is given up on. */
export const STALL_MS = 6_000;

/**
 * The model's JSON reply, even with a code fence or text around it.
 * @param {string} text
 * @returns {{ heard: string, reply: string }}
 */
export function parseReply(text) {
  const match = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/gi, ''));
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      return { heard: String(obj.heard ?? ''), reply: String(obj.reply ?? '') };
    } catch { /* not JSON, so all of it is the reply */ }
  }
  return { heard: '', reply: text.trim() };
}

/**
 * The cost of one text-model call.
 * @param {any} usage usageMetadata
 * @param {{ textIn: number, audioIn: number, textOut: number }} price
 */
export function replyCost(usage, price) {
  const input = byModality(usage?.promptTokensDetails);
  if (!input.audio && !input.text) input.text = Number(usage?.promptTokenCount) || 0;
  const output = (Number(usage?.candidatesTokenCount) || 0) + (Number(usage?.thoughtsTokenCount) || 0);
  return (input.text * price.textIn + input.audio * price.audioIn + output * price.textOut) / 1e6;
}

/**
 * The cost of one text-to-speech call. Without usage counts, the audio is
 * counted from its length.
 * @param {any} usage the Interactions API usage
 * @param {number} seconds of audio returned
 * @param {{ textIn: number, audioOut: number }} price
 */
export function speechCost(usage, seconds, price) {
  const input = Number(usage?.total_input_tokens) || 0;
  const output = Number(usage?.total_output_tokens) || Math.round(seconds * AUDIO_TOKENS_PER_SECOND);
  return (input * price.textIn + output * price.audioOut) / 1e6;
}

/**
 * Every audio part in a response or a stream event, wherever it sits.
 * @param {any} obj
 * @param {{ data: string, mime: string, rate: number }[]} [out]
 */
export function audioParts(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (obj.type === 'audio' && typeof obj.data === 'string' && obj.data) {
    out.push({ data: obj.data, mime: String(obj.mime_type ?? obj.mimeType ?? ''), rate: Number(obj.sample_rate ?? obj.sampleRate) || 0 });
    return out;
  }
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) if (v && typeof v === 'object') audioParts(v, out);
  return out;
}

/** The first `usage` object anywhere in a response or event. @param {any} obj @returns {any} */
export function findUsage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.usage && typeof obj.usage === 'object') return obj.usage;
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    const u = findUsage(v);
    if (u) return u;
  }
  return null;
}

/** How rough a signal is: speech read with the wrong byte order is close to noise. @param {Int16Array} s */
const roughness = (s) => {
  let sum = 0;
  for (let i = 1; i < s.length; i++) sum += Math.abs(s[i] - s[i - 1]);
  return s.length > 1 ? sum / (s.length - 1) : 0;
};

/**
 * 16-bit PCM from one audio part. WAV is read with its header. Raw PCM
 * ("audio/l16") may be big-endian, as its standard says, or little-endian, so
 * both are tried and the smoother one is kept.
 * @param {{ data: string, mime: string, rate: number }} part
 * @returns {{ samples: Int16Array, rate: number }}
 */
export function decodeAudio(part) {
  const bytes = Buffer.from(part.data, 'base64');
  if (/wav/i.test(part.mime) || bytes.subarray(0, 4).toString('latin1') === 'RIFF') {
    const { rate, samples } = readWav(new Uint8Array(bytes));
    return { samples, rate };
  }
  const little = base64ToPcm(part.data);
  const big = new Int16Array(little.length);
  for (let i = 0; i < little.length; i++) big[i] = ((little[i] & 0xff) << 8) | ((little[i] >> 8) & 0xff);
  const rate = part.rate || Number(/rate=(\d+)/.exec(part.mime)?.[1]) || 24000;
  return { samples: roughness(big) < roughness(little) ? big : little, rate };
}

/**
 * Server-sent events from a response body, each data payload parsed as JSON
 * and passed to `onEvent`. If nothing arrives for `stallMs`, it stops and
 * calls `onStall`. Google's voice stream sometimes stops sending without
 * closing, and on 10 October one waited 10 minutes before it closed.
 * @param {ReadableStream<Uint8Array>} body
 * @param {(event: any) => void} onEvent
 * @param {{ stallMs?: number, onStall?: () => void }} [opts]
 * @returns {Promise<{ stalled: boolean }>}
 */
export async function readSse(body, onEvent, { stallMs = STALL_MS, onStall = () => {} } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  /** @param {string} block */
  const parse = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    onEvent(event);
  };
  for (;;) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const stall = new Promise((resolve) => { timer = setTimeout(() => resolve('stall'), stallMs); });
    const next = await Promise.race([reader.read(), stall]);
    clearTimeout(timer);
    if (next === 'stall') {
      onStall();
      reader.cancel().catch(() => {});
      return { stalled: true };
    }
    const { value, done } = /** @type {ReadableStreamReadResult<Uint8Array>} */ (next);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      parse(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
  }
  parse(buf + decoder.decode());
  return { stalled: false };
}

/**
 * The error message from a failed call, without the key.
 * @param {Response} res
 * @param {string} what
 */
async function failure(res, what) {
  const body = await res.text().catch(() => '');
  let message = body;
  try {
    message = JSON.parse(body)?.error?.message ?? body;
  } catch { /* plain text */ }
  const err = new Error(`${what}: HTTP ${res.status} ${String(message).slice(0, 300)}`);
  return Object.assign(err, { status: res.status });
}

/** Worth asking once more: no answer, a timeout, too many requests, or a server error. @param {any} err */
const retryable = (err) => !err?.status || err.status === 429 || err.status >= 500;

/**
 * @typedef {{ id: string, name: string, gender: string, description: string }} Voice
 */

/**
 * The Spain Spanish voices in Google's voice library.
 * @param {{ fetch: typeof fetch, key: string }} p
 * @returns {Promise<Voice[]>}
 */
export async function spainVoices({ fetch, key }) {
  const res = await fetch(`${API}/voices?language_code=es-ES&page_size=100`, { headers: { 'x-goog-api-key': key } }).catch(() => null);
  if (!res || !res.ok) return [];
  const body = await res.json().catch(() => ({}));
  /** @type {any[]} */
  const list = Array.isArray(body?.voices) ? body.voices : (Object.values(body ?? {}).find(Array.isArray) ?? []);
  return list
    .filter((v) => /^es[-_]ES$/i.test(String(v?.language_code ?? v?.languageCode ?? '')) || /spain|españa|castil|peninsular/i.test(String(v?.accent ?? '')))
    .map((v) => ({
      id: String(v.id ?? v.name ?? ''),
      name: String(v.display_name ?? v.displayName ?? v.id ?? v.name ?? ''),
      gender: String(v.gender ?? ''),
      description: String(v.description ?? ''),
    }))
    .filter((v) => v.id);
}

/**
 * The voice that suits a conversation best: one described as conversational,
 * friendly or natural, and not one made for adverts, news or reading aloud.
 * A woman's voice wins a tie, like charla's default.
 * @param {Voice[]} voices
 */
export function chooseVoice(voices) {
  const score = (/** @type {Voice} */ v) => {
    const text = `${v.id} ${v.name} ${v.description}`.toLowerCase();
    return (/tutor|teacher|profesor/.test(text) ? 5 : 0)
      + (/conversa|friendly|casual|warm|natural|amable|cercan/.test(text) ? 3 : 0)
      - (/commercial|advert|announc|news|narrat|audiobook|promo/.test(text) ? 3 : 0)
      + (/female|mujer/.test(v.gender.toLowerCase()) ? 1 : 0);
  };
  return [...voices].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/**
 * A Spain Spanish voice from Google's voice library, or null.
 * @param {{ fetch: typeof fetch, key: string }} p
 * @returns {Promise<{ id: string, name: string } | null>}
 */
export async function pickSpainVoice(p) {
  const pick = chooseVoice(await spainVoices(p));
  return pick ? { id: pick.id, name: pick.name } : null;
}

/**
 * The pipeline with Google's REST APIs: generateContent for the replies and
 * the Interactions API for the voice.
 * @param {{ fetch: typeof fetch, key: string, model: string, ttsModel: string, voice: string, system: string, stallMs?: number }} p
 * @returns {Pipeline}
 */
export function geminiPipeline({ fetch, key, model, ttsModel, voice, system, stallMs = STALL_MS }) {
  /** @type {string[]} */
  const notes = [];
  const headers = { 'x-goog-api-key': key, 'content-type': 'application/json' };
  const rp = PIPELINE_PRICES[model];
  const sp = PIPELINE_PRICES[ttsModel];
  if (!rp || rp.audioIn === undefined || rp.textOut === undefined) throw new Error(`No prices for ${model} in PIPELINE_PRICES.`);
  if (!sp || sp.audioOut === undefined) throw new Error(`No prices for ${ttsModel} in PIPELINE_PRICES.`);
  const replyPrice = { textIn: rp.textIn, audioIn: rp.audioIn, textOut: rp.textOut };
  const speechPrice = { textIn: sp.textIn, audioOut: sp.audioOut };
  let thinking = true;
  let currentVoice = voice;

  /** @type {Pipeline['reply']} */
  async function reply(history, input, note = '') {
    const last = 'audio' in input
      ? { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from(writeWav(input.audio, INPUT_RATE)).toString('base64') } }] }
      : { role: 'user', parts: [{ text: input.text }] };
    const contents = [...history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })), last];
    const call = async () => {
      const res = await fetch(`${API}/models/${model}:generateContent`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system + note }] },
          contents,
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: REPLY_SCHEMA,
            ...(thinking ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
          },
        }),
      });
      if (!res.ok) throw await failure(res, model);
      return res.json();
    };
    /** @type {any} */
    let body;
    for (let attempt = 1; ; attempt++) {
      try {
        body = await call();
        break;
      } catch (err) {
        const e = /** @type {any} */ (err);
        if (thinking && e?.status === 400 && /thinking/i.test(String(e.message))) {
          thinking = false;
          notes.push(`${model} doesn't take a thinking level, so none was sent`);
          continue;
        }
        if (attempt >= 2 || !retryable(e)) throw err;
        notes.push(`${model} failed once (${e?.message ?? e}), so it was asked again`);
      }
    }
    const text = (body?.candidates?.[0]?.content?.parts ?? []).map((/** @type {any} */ p) => p?.text ?? '').join('');
    const { heard, reply: said } = parseReply(text);
    return { heard, reply: said, usage: body?.usageMetadata ?? null, cost: replyCost(body?.usageMetadata, replyPrice) };
  }

  /** @type {Pipeline['speak']} */
  async function speak(text, onFirstAudio) {
    for (let attempt = 1; ; attempt++) {
      const ctl = new AbortController();
      /** @type {Int16Array[]} */
      const audio = [];
      let rate = 24000;
      /** @type {any} */
      let usage = null;
      /** @param {any} obj */
      const take = (obj) => {
        for (const part of audioParts(obj)) {
          const decoded = decodeAudio(part);
          if (!decoded.samples.length) continue;
          if (!audio.length) onFirstAudio();
          audio.push(decoded.samples);
          rate = decoded.rate;
        }
        usage = findUsage(obj) ?? usage;
      };
      let stalled = false;
      try {
        const res = await fetch(`${API}/interactions`, {
          method: 'POST',
          headers: { ...headers, accept: 'text/event-stream' },
          signal: ctl.signal,
          body: JSON.stringify({
            model: ttsModel,
            input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: SPEECH_STYLE }] }] }],
            response_format: { type: 'audio' },
            generation_config: { speech_config: [{ voice: currentVoice }] },
            stream: true,
            store: false,
          }),
        });
        if (!res.ok) {
          const err = await failure(res, ttsModel);
          if (res.status === 400 && currentVoice !== FALLBACK_VOICE) {
            notes.push(`${ttsModel} didn't take the voice ${currentVoice} (${err.message}), so ${FALLBACK_VOICE} was used`);
            currentVoice = FALLBACK_VOICE;
            attempt -= 1;
            continue;
          }
          throw err;
        }
        if (/event-stream/i.test(res.headers.get('content-type') ?? '') && res.body) {
          ({ stalled } = await readSse(res.body, take, { stallMs, onStall: () => ctl.abort() }));
        } else {
          take(await res.json());
        }
      } catch (err) {
        // "terminated": the connection closed in the middle of the stream.
        if (!audio.length && (attempt >= 2 || !retryable(err))) throw err;
        stalled = true;
      }
      if (audio.length) {
        if (stalled) notes.push(`${ttsModel} stopped sending in the middle of a reply, so the reply was cut short`);
        const seconds = audio.reduce((n, a) => n + a.length, 0) / rate;
        return { audio, rate, usage, cost: speechCost(usage, seconds, speechPrice) };
      }
      if (attempt >= 2) throw new Error(`${ttsModel}: no audio came back`);
      notes.push(`${ttsModel} sent no audio, so it was asked again`);
    }
  }

  return { reply, speak, notes };
}

/** @type {import('./session.mjs').Clock} */
const realClock = { now: () => Date.now(), setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) };

/**
 * Run one session through a pipeline. The learner's line takes as long as its
 * audio, and the next line starts REACTION_MS after the reply has come back.
 * `turnNote` adds to the instructions on each turn, for example which
 * question the conversation is on.
 * @param {{
 *   pipeline: Pipeline,
 *   kickoff: string,
 *   clips: import('./session.mjs').Clip[],
 *   turnNote?: (history: Message[]) => string,
 *   clock?: import('./session.mjs').Clock,
 *   wait?: (ms: number) => Promise<void>,
 * }} p
 * @returns {Promise<import('./session.mjs').Result>}
 */
export async function runPipeline({ pipeline, kickoff, clips, turnNote = () => '', clock = realClock, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const t0 = clock.now();
  const at = () => clock.now() - t0;
  /** @type {import('./session.mjs').Turn[]} */
  const turns = [];
  /** @type {Message[]} */
  const history = [];
  /** @type {any[]} */
  const reports = [];
  /** @type {string[]} */
  const notes = [];
  let total = 0;

  /**
   * @param {import('./session.mjs').Turn} turn
   * @param {Input} input
   */
  async function answer(turn, input) {
    const asked = at();
    const r = await pipeline.reply(history, input, turnNote(history));
    turn.replyMs = at() - asked;
    turn.heard = 'audio' in input ? r.heard : '';
    turn.reply = r.reply;
    history.push({ role: 'user', text: 'text' in input ? input.text : r.heard }, { role: 'model', text: r.reply });
    const spoken = at();
    const speech = await pipeline.speak(r.reply, () => {
      if (turn.firstReplyAt === undefined) turn.firstReplyAt = at();
      if (turn.speechFirstMs === undefined) turn.speechFirstMs = at() - spoken;
    });
    turn.audio = speech.audio;
    turn.audioRate = speech.rate;
    turn.doneAt = at();
    reports.push({ reply: r.usage, speech: speech.usage });
    total += r.cost + speech.cost;
  }

  try {
    const intro = newTurn('intro', '');
    turns.push(intro);
    await answer(intro, { text: kickoff });
    for (const clip of clips) {
      await wait(REACTION_MS);
      const turn = newTurn(clip.label, clip.text);
      turn.startedAt = at();
      turns.push(turn);
      // The learner speaks. Nothing is sent until the line is over.
      await wait(Math.round((clip.samples.length / INPUT_RATE) * 1000));
      turn.endedAt = at();
      await answer(turn, { audio: clip.samples });
    }
  } catch (err) {
    notes.push(err instanceof Error ? err.message : String(err));
  }
  notes.unshift(...pipeline.notes);
  return { turns, reports, notes, close: null, durationMs: at(), cost: { everyTurn: total, newOnly: total } };
}
