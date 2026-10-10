import test from 'node:test';
import assert from 'node:assert/strict';
import { average, pausesOf, plainText, questionNumbers, questionOrder, readWav, resample, sayText, sessionCost, wordAccuracy, writeWav, PRICES } from '../scripts/voice-bench/lib.mjs';
import { ANSWERS, LINES, OPTIONS, prompt, questionNote, setupFor } from '../scripts/voice-bench/script.mjs';
import { runSession } from '../scripts/voice-bench/session.mjs';
import { report, score } from '../scripts/voice-bench/report.mjs';
import { pickVoice } from '../scripts/voice-bench/run.mjs';
import { GAP_MS, SAMPLE, dailyLimit, nextReset, retryAfterMs } from '../scripts/voice-bench/voices.mjs';
import { PIPELINE_PRICES, FALLBACK_VOICE, chooseVoice, decodeAudio, geminiPipeline, parseReply, pickSpainVoice, readSse, replyCost, runPipeline, speechCost } from '../scripts/voice-bench/pipeline.mjs';

test('WAV files round-trip, and extra chunks and stereo are read', () => {
  const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
  const back = readWav(writeWav(samples, 16000));
  assert.equal(back.rate, 16000);
  assert.deepEqual([...back.samples], [...samples]);

  // A stereo file with a LIST chunk before the data, like some Mac files.
  const list = new Uint8Array([...Buffer.from('LIST'), 4, 0, 0, 0, ...Buffer.from('INFO')]);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(2, 10);
  fmt.writeUInt32LE(22050, 12); fmt.writeUInt32LE(22050 * 4, 16); fmt.writeUInt16LE(4, 20); fmt.writeUInt16LE(16, 22);
  const data = Buffer.alloc(8 + 8);
  data.write('data', 0); data.writeUInt32LE(8, 4);
  data.writeInt16LE(5, 8); data.writeInt16LE(-5, 10); data.writeInt16LE(7, 12); data.writeInt16LE(-7, 14);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, Buffer.from(list), data]);
  const head = Buffer.alloc(8); head.write('RIFF', 0); head.writeUInt32LE(body.length, 4);
  const stereo = readWav(new Uint8Array(Buffer.concat([head, body])));
  assert.equal(stereo.rate, 22050);
  assert.deepEqual([...stereo.samples], [5, 7]);
  assert.throws(() => readWav(new Uint8Array(10)), /Not a WAV file/);
});

test('resample keeps the length right', () => {
  const s = Int16Array.from({ length: 441 }, (_, i) => i);
  assert.equal(resample(s, 22050, 16000).length, 320);
  assert.equal(resample(s, 16000, 16000), s);
});

test('pauses become silences for the Mac voice and leave the plain text', () => {
  const say = 'Me gusta, pero {1.6} antes {0.8} sí.';
  assert.equal(plainText(say), 'Me gusta, pero antes sí.');
  assert.equal(sayText(say), 'Me gusta, pero [[slnc 1600]] antes [[slnc 800]] sí.');
  assert.deepEqual(pausesOf(say), [1.6, 0.8]);
  for (const a of ANSWERS) assert.ok(pausesOf(a.say).every((p) => p > 0.8), `${a.label} has a pause Google's default would cut`);
});

test('the learner alternates answers and «siguiente pregunta»', () => {
  assert.deepEqual(LINES.map((l) => l.label), ['answer 1', 'siguiente', 'answer 2', 'siguiente', 'answer 3', 'siguiente', 'answer 4', 'siguiente', 'answer 5']);
});

test('word accuracy ignores case, accents and punctuation', () => {
  assert.equal(wordAccuracy('Sí, me gusta mucho.', 'si me gusta mucho'), 1);
  assert.equal(wordAccuracy('me gusta mucho viajar', 'me gusta viajar'), 0.75);
  assert.equal(wordAccuracy('hola', 'Aussehen'), 0);
  assert.equal(wordAccuracy('', ''), 1);
});

test('question order finds repeats and gaps, as in the 10 October session', () => {
  const replies = [
    '¡Hola! El tema de hoy es el ciclismo. Primera pregunta: ¿Te gusta montar en bicicleta?',
    'Te entiendo. Segunda pregunta: ¿Montabas en bicicleta?',
    'Esas son las carreras más famosas. Quinta y última pregunta: ¿Tienes una bicicleta?',
    'Es verdad. Quinta y última pregunta: ¿Prefieres usar la bicicleta para hacer deporte?',
  ];
  const o = questionOrder(questionNumbers(replies));
  assert.equal(o.ok, false);
  assert.equal(o.repeats, 1);
  assert.deepEqual(o.missing, [3, 4]);
  const good = questionOrder(questionNumbers(['Primera pregunta', 'Segunda pregunta', 'Tercera pregunta', 'Cuarta pregunta', 'Quinta pregunta']));
  assert.equal(good.ok, true);
  assert.deepEqual(questionNumbers(['La primera vez que fui, la pregunta era otra']), [], 'needs «pregunta» right after the number');
});

test('cost counts every turn or new tokens only', () => {
  const reports = [
    { promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1000 }, { modality: 'AUDIO', tokenCount: 0 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }], thoughtsTokenCount: 50 },
    { promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1000 }, { modality: 'AUDIO', tokenCount: 2000 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }], thoughtsTokenCount: 50 },
  ];
  const c = sessionCost(reports, PRICES['gemini-3.8-live']);
  const replies = (200 * 12 + 100 * 4.5) / 1e6;
  assert.ok(Math.abs(c.everyTurn - ((2000 * 0.75 + 2000 * 3) / 1e6 + replies)) < 1e-12);
  assert.ok(Math.abs(c.newOnly - ((1000 * 0.75 + 2000 * 3) / 1e6 + replies)) < 1e-12);
  assert.equal(c.tokens.inputEveryTurn, 4000);
  assert.equal(c.tokens.inputNewOnly, 3000);
  for (const o of OPTIONS.filter((x) => x.kind !== 'pipeline')) assert.ok(PRICES[o.model], `${o.model} has prices`);
  for (const o of OPTIONS.filter((x) => x.kind === 'pipeline')) {
    assert.ok(PIPELINE_PRICES[o.model], `${o.model} has prices`);
    assert.ok(PIPELINE_PRICES[o.tts ?? ''], `${o.tts} has prices`);
  }
});

test('the tuned prompt adds the learner rules and numbered questions', () => {
  const today = prompt('today');
  const tuned = prompt('tuned');
  assert.match(today, /Tema: Los viajes/);
  assert.doesNotMatch(today, /Usa cada número una sola vez/);
  assert.match(tuned, /Usa cada número una sola vez/);
  assert.match(tuned, /Hago pausas para pensar/);
  assert.equal(OPTIONS.find((o) => o.id === 'today')?.turns, undefined, 'today uses Google\'s default turn-taking');
  assert.equal(OPTIONS.find((o) => o.id === 'tuned')?.turns?.automaticActivityDetection.silenceDurationMs, 1500);
});

test('each option sends the setup it says', () => {
  const byId = Object.fromEntries(OPTIONS.map((o) => [o.id, setupFor(o)]));
  assert.equal(new Set(OPTIONS.map((o) => o.id)).size, OPTIONS.length, 'ids are unique');

  assert.deepEqual(byId.today.inputAudioTranscription, {}, 'today lets Google guess the language');
  assert.equal(byId.today.realtimeInputConfig, undefined);
  assert.equal(byId.today.model, 'models/gemini-3.8-live');

  assert.deepEqual(byId.tuned.inputAudioTranscription, { languageCodes: ['es-ES'] });
  assert.equal(byId.tuned.contextWindowCompression, undefined);
  assert.deepEqual(byId['short-context'].contextWindowCompression, { triggerTokens: 4000, slidingWindow: { targetTokens: 2000 } });

  for (const id of ['speech-only', 'flash-speech-only']) {
    assert.deepEqual(byId[id].realtimeInputConfig, { automaticActivityDetection: { disabled: true } });
    assert.equal(OPTIONS.find((o) => o.id === id)?.speechOnly, true);
  }
  assert.equal(byId['flash-speech-only'].model, 'models/gemini-3.1-flash-live-preview');
  for (const o of OPTIONS.filter((x) => !x.speechOnly)) {
    assert.notEqual(setupFor(o).realtimeInputConfig?.automaticActivityDetection?.disabled, true, `${o.id} leaves turn-taking to Google`);
  }
});

test('pickVoice takes a Spain Spanish voice first', () => {
  const list = [
    'Daniel              en_GB    # Hello! My name is Daniel.',
    'Paulina             es_MX    # Hola, me llamo Paulina.',
    'Mónica              es_ES    # Hola, me llamo Mónica.',
    'Eddy (Spanish (Spain)) es_ES    # Hola',
  ].join('\n');
  assert.equal(pickVoice(list), 'Mónica');
  assert.equal(pickVoice('Paulina             es_MX    # Hola'), 'Paulina');
  assert.equal(pickVoice('Daniel              en_GB    # Hello'), null);
});

/**
 * A fake Gemini Live server. It ends the learner's turn after a pause as long
 * as the setup's silenceDurationMs (800 ms when there is none), like Google's
 * turn-taking, and then speaks the next scripted reply. When the setup turns
 * activity detection off, it replies after activityEnd instead.
 */
function fakeLive() {
  const replies = [
    'Muy bien.',
    'Segunda pregunta: ¿Qué tipo de vacaciones prefieres?',
    '¡Qué bonito!',
    'Tercera pregunta: ¿Hotel o apartamento?',
    'Vale.',
  ];
  const sent = [];
  let vadMs = 800;
  let manual = false;
  let speaking = false;
  let silentMs = 0;
  let replyIndex = 0;
  const audio = (n) => Buffer.from(new Int16Array(n).fill(100).buffer).toString('base64');
  const ws = {
    readyState: 0,
    binaryType: '',
    sent,
    send(text) {
      const msg = JSON.parse(text);
      sent.push(msg);
      const reply = (transcript) => {
        this.onmessage({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: audio(2400) } }] } } }) });
        this.onmessage({ data: JSON.stringify({ serverContent: { outputTranscription: { text: transcript } } }) });
        this.onmessage({ data: new TextEncoder().encode(JSON.stringify({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 100, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 80 }, { modality: 'TEXT', tokenCount: 20 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 25 }] } })).buffer });
      };
      if (msg.setup) {
        vadMs = msg.setup.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs ?? 800;
        manual = msg.setup.realtimeInputConfig?.automaticActivityDetection?.disabled === true;
        this.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
      } else if (msg.realtimeInput?.text) {
        reply('Hola. El tema de hoy es Los viajes. Primera pregunta: ¿Te gusta viajar?');
      } else if (manual) {
        if (msg.realtimeInput?.activityEnd) reply(replies[replyIndex++ % replies.length]);
      } else if (msg.realtimeInput?.audio) {
        const pcm = new Int16Array(Buffer.from(msg.realtimeInput.audio.data, 'base64').buffer.slice(0));
        const loud = pcm.some((s) => s !== 0);
        if (loud) {
          if (!speaking) this.onmessage({ data: JSON.stringify({ serverContent: { inputTranscription: { text: 'sí ' } } }) });
          speaking = true;
          silentMs = 0;
        } else if (speaking) {
          silentMs += 100;
          if (silentMs >= vadMs) {
            speaking = false;
            silentMs = 0;
            reply(replies[replyIndex++ % replies.length]);
          }
        }
      }
    },
    close(code) {
      this.readyState = 3;
      this.onclose?.({ code, reason: '' });
    },
  };
  return ws;
}

function fakeClock() {
  const clock = { t: 0, fn: null, now: () => clock.t, setInterval: (fn) => { clock.fn = fn; return 1; }, clearInterval: () => { clock.fn = null; } };
  return clock;
}

/** A clip: speech, a pause, speech. Speech is any non-zero sound. */
const clip = (label, pauseMs) => {
  const tone = new Int16Array(8000).fill(500);
  const gap = new Int16Array((16000 * pauseMs) / 1000);
  const samples = new Int16Array(tone.length * 2 + gap.length);
  samples.set(tone, 0);
  samples.set(gap, tone.length);
  samples.set(tone, tone.length + gap.length);
  return { label, text: 'sí me gusta', samples };
};

async function simulate(setup, speechOnly = false) {
  const clock = fakeClock();
  let ws;
  let done = null;
  const clips = [clip('answer 1', 1200), { label: 'siguiente', text: 'siguiente pregunta', samples: new Int16Array(6400).fill(500) }, clip('answer 2', 1200)];
  const running = runSession({
    url: 'wss://example.test',
    setup,
    kickoff: 'Hola',
    clips,
    connect: () => (ws = fakeLive()),
    clock,
    speechOnly,
  }).then((r) => { done = r; });
  ws.readyState = 1;
  ws.onopen();
  for (let i = 0; i < 2000 && !done; i++) {
    clock.t += 100;
    clock.fn?.();
    await Promise.resolve();
  }
  await running;
  return { result: done, ws };
}

test('a pause longer than the default turn-taking lets the model cut in', async () => {
  const { result } = await simulate({ model: 'models/gemini-3.8-live' });
  const lines = result.turns.filter((t) => t.label !== 'intro');
  assert.equal(lines.length, 3);
  assert.ok(lines.filter((t) => t.cutInAt !== undefined).length >= 2, 'both answers were cut');
  const s = score(result, OPTIONS[0]);
  assert.ok(s.cutIns >= 2);
});

test('learner turn-taking waits through the same pause, and the session is scored', async () => {
  const { result, ws } = await simulate({ model: 'models/gemini-3.8-live', realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 1500 } } });
  const lines = result.turns.filter((t) => t.label !== 'intro');
  assert.deepEqual(lines.map((t) => t.label), ['answer 1', 'siguiente', 'answer 2']);
  assert.ok(lines.every((t) => t.cutInAt === undefined), 'no cut-ins');
  assert.ok(lines.every((t) => t.firstReplyAt !== undefined && t.doneAt !== undefined));
  assert.ok(lines.every((t) => (t.firstReplyAt ?? 0) - (t.endedAt ?? 0) >= 1500), 'the reply comes after the 1.5 s pause');
  assert.equal(result.turns[0].reply, 'Hola. El tema de hoy es Los viajes. Primera pregunta: ¿Te gusta viajar?');
  assert.equal(lines[1].reply, 'Segunda pregunta: ¿Qué tipo de vacaciones prefieres?');
  assert.equal(result.reports.length, 4);
  assert.ok(result.turns.every((t) => t.audio.length > 0));
  assert.deepEqual(ws.sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  assert.equal(ws.sent[0].setup.model, 'models/gemini-3.8-live');
  assert.deepEqual(ws.sent[1], { realtimeInput: { text: 'Hola' } });

  const option = OPTIONS.find((o) => o.id === 'tuned');
  const s = score(result, option);
  assert.equal(s.cutIns, 0);
  assert.ok(s.waitAvg >= 1.5);
  assert.deepEqual(s.order.numbers, [1, 2]);
  assert.equal(s.billedTurns, 4);
  assert.ok(s.cost && s.cost.everyTurn > s.cost.newOnly);
  const md = report({ date: '2026-10-10 10:00', voice: 'Mónica', runs: [{ option, run: 1, folder: 'scripts/voice-bench/out/x/tuned-1', result, scores: s }] });
  assert.match(md, /\| Gemini 3\.8 Live, tuned \| 1 \| 0 of 3 \|/);
  assert.match(md, new RegExp(`\\| ${s.minutes.toFixed(1)} \\| 4 \\| \\$${s.cost.everyTurn.toFixed(3)} \\| \\$${s.cost.newOnly.toFixed(3)} \\|`));
  assert.match(md, /## Replies/);
  assert.ok(Number.isFinite(average([1, 2])));
});

test('speech only sends sound only during lines, and marks where each line starts and ends', async () => {
  const option = OPTIONS.find((o) => o.id === 'speech-only');
  const { result, ws } = await simulate(setupFor(option), true);
  const lines = result.turns.filter((t) => t.label !== 'intro');
  assert.deepEqual(lines.map((t) => t.label), ['answer 1', 'siguiente', 'answer 2']);
  assert.ok(lines.every((t) => t.cutInAt === undefined && t.doneAt !== undefined), 'every line gets a reply after it ends');

  // Between the setup and the end, the messages go: kickoff text, then for each
  // line activityStart, its audio, activityEnd. No sound in between.
  const kinds = ws.sent.slice(1).map((m) => (m.realtimeInput?.audio ? 'audio' : Object.keys(m.realtimeInput ?? {})[0]));
  const squeezed = kinds.filter((k, i) => k !== 'audio' || kinds[i - 1] !== 'audio');
  assert.deepEqual(squeezed, ['text', 'activityStart', 'audio', 'activityEnd', 'activityStart', 'audio', 'activityEnd', 'activityStart', 'audio', 'activityEnd']);
  const audioChunks = kinds.filter((k) => k === 'audio').length;
  const clipChunks = [16000 + 19200, 6400, 16000 + 19200].reduce((n, len) => n + Math.ceil(len / 1600), 0);
  assert.equal(audioChunks, clipChunks, 'only the lines were sent');
  assert.ok(!ws.sent.some((m) => m.realtimeInput?.audioStreamEnd), 'no audioStreamEnd without Google\'s activity detection');
});

test('a session that never starts stops on its own', async () => {
  const clock = fakeClock();
  let done = null;
  const silent = { readyState: 1, send() {}, close() { this.readyState = 3; } };
  const running = runSession({ url: 'wss://example.test', setup: {}, kickoff: 'Hola', clips: [], connect: () => silent, clock }).then((r) => { done = r; });
  for (let i = 0; i < 400 && !done; i++) {
    clock.t += 100;
    clock.fn?.();
    await Promise.resolve();
  }
  await running;
  assert.deepEqual(done.notes, ['the session never started']);
});

// The pipeline: Gemini Flash-Lite writes the replies, Gemini's text-to-speech says them.

test('the pipeline reads the model\'s JSON, even inside a code fence', () => {
  assert.deepEqual(parseReply('{"heard":"me gusta","reply":"¡Qué bien!"}'), { heard: 'me gusta', reply: '¡Qué bien!' });
  assert.deepEqual(parseReply('```json\n{"heard": "sí", "reply": "Vale."}\n```'), { heard: 'sí', reply: 'Vale.' });
  assert.deepEqual(parseReply('  Hola, ¿qué tal?  '), { heard: '', reply: 'Hola, ¿qué tal?' });
});

test('pipeline costs: text model by modality, voice by audio length when there are no counts', () => {
  const price = PIPELINE_PRICES['gemini-3.1-flash-lite'];
  const usage = { promptTokensDetails: [{ modality: 'TEXT', tokenCount: 2000 }, { modality: 'AUDIO', tokenCount: 400 }], candidatesTokenCount: 60, thoughtsTokenCount: 20 };
  assert.ok(Math.abs(replyCost(usage, price) - (2000 * 0.25 + 400 * 0.5 + 80 * 1.5) / 1e6) < 1e-12);
  assert.ok(Math.abs(replyCost({ promptTokenCount: 1000 }, price) - (1000 * 0.25) / 1e6) < 1e-12, 'no details counts as text');
  const tts = PIPELINE_PRICES['gemini-3.8-flash-lite-tts'];
  assert.ok(Math.abs(speechCost(null, 10, tts) - (250 * 6) / 1e6) < 1e-12, '10 s of audio is 250 tokens');
  assert.ok(Math.abs(speechCost({ total_input_tokens: 30, total_output_tokens: 300 }, 10, tts) - (30 * 0.5 + 300 * 6) / 1e6) < 1e-12);
});

/** A smooth tone, as speech is, in raw bytes of either order. */
function toneBytes(bigEndian) {
  const n = 480;
  const bytes = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 24000));
    if (bigEndian) bytes.writeInt16BE(v, i * 2); else bytes.writeInt16LE(v, i * 2);
  }
  return bytes;
}

test('voice audio is read as WAV, or as raw PCM in whichever byte order sounds like speech', () => {
  const expected = [...new Int16Array(toneBytes(false).buffer.slice(0))];
  for (const big of [false, true]) {
    const { samples, rate } = decodeAudio({ data: toneBytes(big).toString('base64'), mime: 'audio/l16', rate: 0 });
    assert.deepEqual([...samples], expected, big ? 'big-endian' : 'little-endian');
    assert.equal(rate, 24000);
  }
  const wav = Buffer.from(writeWav(Int16Array.from([1, 2, 3]), 16000)).toString('base64');
  const fromWav = decodeAudio({ data: wav, mime: 'audio/wav', rate: 0 });
  assert.deepEqual([...fromWav.samples], [1, 2, 3]);
  assert.equal(fromWav.rate, 16000);
});

/** A response body that arrives in the given pieces. */
const bodyOf = (pieces) => new ReadableStream({ start(c) { for (const p of pieces) c.enqueue(new TextEncoder().encode(p)); c.close(); } });

test('server-sent events are read across chunk boundaries', async () => {
  const events = [];
  const r = await readSse(bodyOf(['event: step.delta\r\ndata: {"a"', ':1}\r\n\r\ndata: {"b":2}\n\n', 'data: [DONE]\n\ndata: {"c":3}']), (e) => events.push(e));
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.equal(r.stalled, false);
});

/** A stream that sends these pieces and then nothing, without closing, as Google's voice did on 10 October. */
const stuckBodyOf = (pieces) => new ReadableStream({ start(c) { for (const p of pieces) c.enqueue(new TextEncoder().encode(p)); } });

test('a stream that stops sending is given up on', async () => {
  const events = [];
  let stalls = 0;
  const r = await readSse(stuckBodyOf(['data: {"a":1}\n\n']), (e) => events.push(e), { stallMs: 30, onStall: () => { stalls += 1; } });
  assert.deepEqual(events, [{ a: 1 }]);
  assert.equal(r.stalled, true);
  assert.equal(stalls, 1);
});

test('the voice suits a conversation: not an advert voice, a woman\'s first on a tie', () => {
  const voices = [
    { id: 'es-es-commercial-3', name: 'Commercial Voiceover 3', gender: 'female', description: '' },
    { id: 'es-es-friendly-1', name: 'Lucía', gender: 'female', description: 'Warm and friendly, for conversations' },
    { id: 'es-es-2', name: 'Álvaro', gender: 'male', description: '' },
  ];
  assert.equal(chooseVoice(voices)?.id, 'es-es-friendly-1');
  assert.equal(chooseVoice([...voices, { id: 'es-es-tutor-12', name: 'Tutor 12', gender: 'female', description: '' }])?.id, 'es-es-tutor-12', 'a tutor\'s voice first');
  assert.equal(chooseVoice(voices.filter((v) => v.id !== 'es-es-friendly-1'))?.id, 'es-es-2', 'a plain voice beats an advert voice');
  assert.equal(chooseVoice([]), null);
});

test('the question note follows «siguiente pregunta», so the model doesn\'t have to', () => {
  assert.match(questionNote([]), /primera pregunta/);
  const h = [{ role: 'user', text: 'Hola. Empecemos.' }, { role: 'model', text: 'Primera pregunta: ¿Te gusta viajar?' }];
  assert.match(questionNote(h), /vamos por la primera pregunta\. Si en este turno digo «siguiente pregunta», haz la segunda/);
  const at3 = [...h, { role: 'user', text: 'Siguiente pregunta.' }, { role: 'model', text: 'x' }, { role: 'user', text: 'Me gusta.' }, { role: 'model', text: 'y' }, { role: 'user', text: 'SIGUIENTE pregunta' }, { role: 'model', text: 'z' }];
  assert.match(questionNote(at3), /vamos por la tercera pregunta/);
  assert.match(questionNote(at3), /no hagas una pregunta nueva con número/);
  const at5 = [...at3, { role: 'user', text: 'siguiente pregunta' }, { role: 'model', text: 'a' }, { role: 'user', text: 'siguiente pregunta' }, { role: 'model', text: 'b' }];
  assert.match(questionNote(at5), /quinta y última/);
  assert.match(questionNote([...at5, { role: 'user', text: 'Siguiente pregunta' }, { role: 'model', text: 'c' }]), /ya hemos hecho las 5/);
  assert.match(questionNote([{ role: 'model', text: 'Siguiente pregunta: la segunda' }, ...h]), /primera pregunta/, 'only the learner\'s words count');
});

/**
 * A fake Google: generateContent answers with JSON, the Interactions API streams
 * audio, and the voice list has one Spain voice. Each call is recorded.
 */
function fakeGoogle({ thinkingError = false, voiceError = false, failReplies = 0, stuckVoices = 0 } = {}) {
  const calls = [];
  let replies = 0;
  let voices = 0;
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: init.headers });
    if (url.includes('/voices')) {
      return Response.json({ voices: [{ id: 'es-ES-Chirp-Male', display_name: 'Álvaro', language_code: 'es-ES', gender: 'male' }, { id: 'es-ES-Chirp-Female', display_name: 'Lucía', language_code: 'es-ES', gender: 'female' }, { id: 'es-MX-1', language_code: 'es-MX', gender: 'female' }] });
    }
    if (url.includes(':generateContent')) {
      if (thinkingError && body.generationConfig.thinkingConfig) return Response.json({ error: { message: 'Thinking level is not supported for this model.' } }, { status: 400 });
      if (failReplies > 0) {
        failReplies -= 1;
        return Response.json({ error: { message: 'The service is currently unavailable.' } }, { status: 503 });
      }
      replies += 1;
      const text = JSON.stringify({ heard: replies === 1 ? '' : 'me gusta viajar', reply: replies === 1 ? 'Hola. Primera pregunta: ¿Te gusta viajar?' : 'Segunda pregunta: ¿Playa o montaña?' });
      return Response.json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokensDetails: [{ modality: 'TEXT', tokenCount: 600 }], candidatesTokenCount: 40 } });
    }
    if (url.endsWith('/interactions')) {
      if (voiceError && body.generation_config.speech_config[0].voice !== FALLBACK_VOICE) return Response.json({ error: { message: 'Voice not found' } }, { status: 400 });
      voices += 1;
      if (voices <= stuckVoices) return new Response(stuckBodyOf([]), { headers: { 'content-type': 'text/event-stream' } });
      const chunk = toneBytes(false).toString('base64');
      const events = [
        `event: step.delta\ndata: ${JSON.stringify({ event_type: 'step.delta', delta: { type: 'audio', data: chunk, mime_type: 'audio/l16', sample_rate: 24000 } })}\n\n`,
        `event: step.delta\ndata: ${JSON.stringify({ event_type: 'step.delta', delta: { type: 'audio', data: chunk, mime_type: 'audio/l16', sample_rate: 24000 } })}\n\n`,
        `event: interaction.completed\ndata: ${JSON.stringify({ event_type: 'interaction.completed', interaction: { status: 'completed', usage: { total_input_tokens: 20, total_output_tokens: 25 } } })}\n\n`,
      ];
      return new Response(bodyOf(events), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls };
}

test('the pipeline asks Flash-Lite with the conversation as text and the answer as audio, then streams the voice', async () => {
  const google = fakeGoogle();
  const voice = await pickSpainVoice({ fetch: google.fetch, key: 'k' });
  assert.deepEqual(voice, { id: 'es-ES-Chirp-Female', name: 'Lucía' }, 'a Spain voice, female first');
  assert.match(google.calls[0].url, /voices\?language_code=es-ES/);
  assert.equal(await pickSpainVoice({ fetch: async () => new Response('', { status: 403 }), key: 'k' }), null);

  const p = geminiPipeline({ fetch: google.fetch, key: 'k', model: 'gemini-3.1-flash-lite', ttsModel: 'gemini-3.8-flash-lite-tts', voice: voice.id, system: 'Eres mi compañero.' });
  const first = await p.reply([], { text: 'Hola. Empecemos.' });
  assert.equal(first.reply, 'Hola. Primera pregunta: ¿Te gusta viajar?');
  const second = await p.reply([{ role: 'user', text: 'Hola. Empecemos.' }, { role: 'model', text: first.reply }], { audio: Int16Array.from([1, 2, 3]) });
  assert.equal(second.heard, 'me gusta viajar');
  assert.ok(Math.abs(second.cost - (600 * 0.25 + 40 * 1.5) / 1e6) < 1e-12);

  const asked = google.calls.filter((c) => c.url.includes(':generateContent')).at(-1);
  assert.match(asked.url, /models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(asked.headers['x-goog-api-key'], 'k', 'the key goes in a header');
  assert.ok(!asked.url.includes('key='), 'never in the URL');
  assert.deepEqual(asked.body.systemInstruction, { parts: [{ text: 'Eres mi compañero.' }] });
  assert.deepEqual(asked.body.contents.slice(0, 2), [{ role: 'user', parts: [{ text: 'Hola. Empecemos.' }] }, { role: 'model', parts: [{ text: first.reply }] }]);
  const audioPart = asked.body.contents[2].parts[0].inlineData;
  assert.equal(audioPart.mimeType, 'audio/wav');
  assert.equal(Buffer.from(audioPart.data, 'base64').subarray(0, 4).toString(), 'RIFF');
  assert.equal(asked.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(asked.body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });

  let firsts = 0;
  const speech = await p.speak('Segunda pregunta.', () => { firsts += 1; });
  assert.equal(firsts, 1, 'first audio is reported once');
  assert.equal(speech.audio.length, 2);
  assert.equal(speech.rate, 24000);
  assert.ok(Math.abs(speech.cost - (20 * 0.5 + 25 * 6) / 1e6) < 1e-12, 'uses the counts Google returns');
  const spoken = google.calls.at(-1);
  assert.equal(spoken.body.model, 'gemini-3.8-flash-lite-tts');
  assert.deepEqual(spoken.body.generation_config.speech_config, [{ voice: 'es-ES-Chirp-Female' }]);
  assert.equal(spoken.body.store, false, 'Google is asked not to keep the conversation');
  assert.equal(spoken.body.stream, true);
  assert.deepEqual(p.notes, []);
});

test('the pipeline drops a setting Google refuses and says so', async () => {
  const google = fakeGoogle({ thinkingError: true, voiceError: true });
  const p = geminiPipeline({ fetch: google.fetch, key: 'k', model: 'gemini-3.1-flash-lite', ttsModel: 'gemini-3.8-flash-lite-tts', voice: 'es-ES-Chirp-Female', system: '' });
  const r = await p.reply([], { text: 'Hola' });
  assert.equal(r.reply, 'Hola. Primera pregunta: ¿Te gusta viajar?');
  await p.reply([], { text: 'Hola' });
  assert.equal(google.calls.filter((c) => c.url.includes(':generateContent') && c.body.generationConfig.thinkingConfig).length, 1, 'tried once with thinking, then never again');
  await p.speak('Hola', () => {});
  assert.equal(google.calls.at(-1).body.generation_config.speech_config[0].voice, FALLBACK_VOICE);
  assert.equal(p.notes.length, 2);
  assert.match(p.notes[0], /thinking/);
  assert.match(p.notes[1], /didn't take the voice es-ES-Chirp-Female/);
  assert.throws(() => geminiPipeline({ fetch: google.fetch, key: 'k', model: 'unknown', ttsModel: 'gemini-3.8-flash-lite-tts', voice: 'Kore', system: '' }), /No prices for unknown/);
});

test('the pipeline asks once more when Google fails or the voice stalls, and adds the turn note', async () => {
  const google = fakeGoogle({ failReplies: 1, stuckVoices: 1 });
  const p = geminiPipeline({ fetch: google.fetch, key: 'k', model: 'gemini-3.1-flash-lite', ttsModel: 'gemini-3.8-flash-lite-tts', voice: 'v', system: 'Eres mi compañero.', stallMs: 30 });
  const r = await p.reply([], { text: 'Hola' }, '\n\nAhora: haz la primera pregunta.');
  assert.equal(r.reply, 'Hola. Primera pregunta: ¿Te gusta viajar?');
  const asked = google.calls.filter((c) => c.url.includes(':generateContent'));
  assert.equal(asked.length, 2, 'asked again after a 503');
  assert.equal(asked[1].body.systemInstruction.parts[0].text, 'Eres mi compañero.\n\nAhora: haz la primera pregunta.');
  const speech = await p.speak('Hola', () => {});
  assert.equal(speech.audio.length, 2);
  assert.equal(google.calls.filter((c) => c.url.endsWith('/interactions')).length, 2, 'asked again after a stall');
  assert.equal(p.notes.length, 2);
  assert.match(p.notes[0], /failed once/);
  assert.match(p.notes[1], /sent no audio/);

  const broken = geminiPipeline({ fetch: fakeGoogle({ stuckVoices: 2 }).fetch, key: 'k', model: 'gemini-3.1-flash-lite', ttsModel: 'gemini-3.8-flash-lite-tts', voice: 'v', system: '', stallMs: 30 });
  await assert.rejects(broken.speak('Hola', () => {}), /no audio came back/, 'it gives up after the second stall');
});

test('a pipeline session waits for each line, then measures the reply and adds up the cost', async () => {
  const clock = fakeClock();
  const wait = async (ms) => { clock.t += ms; };
  const answers = ['Hola. Primera pregunta: ¿Te gusta viajar?', 'Muy bien. Segunda pregunta: ¿Playa o montaña?', 'Vale.'];
  const seen = [];
  const pipeline = {
    notes: [],
    async reply(history, input, note) {
      seen.push({ history: history.map((m) => m.text), input: 'audio' in input ? `audio ${input.audio.length}` : input.text, note });
      clock.t += 700;
      return { heard: 'audio' in input ? 'sí me gusta' : '', reply: answers[seen.length - 1], usage: {}, cost: 0.001 };
    },
    async speak(text, onFirstAudio) {
      clock.t += 300;
      onFirstAudio();
      clock.t += 200;
      return { audio: [new Int16Array(24000)], rate: 24000, usage: {}, cost: 0.002 };
    },
  };
  const clips = [clip('answer 1', 1200), { label: 'siguiente', text: 'siguiente pregunta', samples: new Int16Array(16000) }];
  const result = await runPipeline({ pipeline, kickoff: 'Hola', clips, clock, wait, turnNote: (h) => `note ${h.length}` });
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.turns.map((t) => t.label), ['intro', 'answer 1', 'siguiente']);
  assert.deepEqual(seen[0], { history: [], input: 'Hola', note: 'note 0' });
  assert.deepEqual(seen[1], { history: ['Hola', answers[0]], input: 'audio 35200', note: 'note 2' });
  assert.deepEqual(seen[2].history, ['Hola', answers[0], 'sí me gusta', answers[1]], 'what the model heard goes into the history');
  const [, a1, next] = result.turns;
  assert.equal(a1.endedAt - a1.startedAt, 2200, 'the learner takes as long as the line');
  assert.equal(a1.firstReplyAt - a1.endedAt, 1000, 'the wait is the text model plus the first audio');
  assert.equal(a1.replyMs, 700);
  assert.equal(a1.speechFirstMs, 300);
  assert.equal(next.startedAt - a1.doneAt, 800, 'the next line starts after the reaction time');
  assert.equal(a1.heard, 'sí me gusta');
  assert.ok(Math.abs(result.cost.everyTurn - 0.009) < 1e-12);

  const option = OPTIONS.find((o) => o.id === 'pipeline');
  const s = score(result, option);
  assert.equal(s.cutIns, 0);
  assert.ok(Math.abs(s.waitAvg - 1) < 1e-9);
  assert.ok(Math.abs(s.cost.everyTurn - 0.009) < 1e-12, 'the report takes the pipeline\'s own cost');
  const md = report({ date: '2026-10-10 12:00', voice: 'Mónica', runs: [{ option, run: 1, folder: 'x', result, scores: s }], ttsVoice: 'Lucía' });
  assert.match(md, /The pipeline speaks with the voice "Lucía"/);
  assert.match(md, /\| Pipeline: Gemini 3\.1 Flash-Lite and 3\.8 Flash-Lite TTS \| 1 \| 0 of 2 \| 1\.0 s \(text 0\.7 s, voice 0\.3 s\) \|/);
});

test('a pipeline session that fails keeps what it has and says why', async () => {
  const pipeline = { notes: ['a note'], reply: async () => { throw new Error('gemini-3.1-flash-lite: HTTP 429 quota'); }, speak: async () => ({ audio: [], rate: 24000, usage: null, cost: 0 }) };
  const result = await runPipeline({ pipeline, kickoff: 'Hola', clips: [], clock: fakeClock(), wait: async () => {} });
  assert.deepEqual(result.notes, ['a note', 'gemini-3.1-flash-lite: HTTP 429 quota']);
  assert.equal(result.turns.length, 1);
});

test('the voice sample has the sounds of a Spain accent', () => {
  assert.match(SAMPLE, /Zaragoza/);
  assert.match(SAMPLE, /Valencia/);
});

test('the voice samples keep to Google\'s limits: 10 a minute, a wait when asked, a stop for the day', () => {
  assert.ok(GAP_MS >= 6000, 'no more than 10 requests a minute');
  const perMinute = 'gemini-3.8-flash-lite-tts: HTTP 429 Rate limit exceeded for model gemini-3.8-flash-lite-tts (limit: 10 requests per minute on Tier 1). Please retry in 33s or upgrade your tier at https://ai.dev/rate-limit.';
  assert.equal(retryAfterMs(perMinute), 33000);
  assert.equal(retryAfterMs('Please retry in 1.5s.'), 1500);
  assert.equal(retryAfterMs('retry in 250ms'), 250);
  assert.equal(retryAfterMs('HTTP 500 Internal error'), null);
  assert.equal(dailyLimit(perMinute), false);
  assert.equal(dailyLimit('Rate limit exceeded for model gemini-3.8-flash-lite-tts (limit: 100 requests per day on Tier 1).'), true);
  assert.equal(dailyLimit('Quota exceeded for metric: generate_requests_per_model_per_day'), true);
});

test('the day\'s requests reset at midnight Pacific time, in summer time and winter time', () => {
  // 10 October, 13:30 in Spain: 07:00 UTC the next day, 9:00 in Spain.
  assert.equal(nextReset(new Date('2026-10-10T11:30:00Z')).toISOString(), '2026-10-11T07:00:00.000Z');
  assert.equal(nextReset(new Date('2026-12-01T12:00:00Z')).toISOString(), '2026-12-02T08:00:00.000Z');
  // Summer time ends at 2:00 on 1 November and starts at 2:00 on 14 March.
  assert.equal(nextReset(new Date('2026-10-31T20:00:00Z')).toISOString(), '2026-11-01T07:00:00.000Z');
  assert.equal(nextReset(new Date('2026-11-01T10:00:00Z')).toISOString(), '2026-11-02T08:00:00.000Z');
  assert.equal(nextReset(new Date('2027-03-13T20:00:00Z')).toISOString(), '2027-03-14T08:00:00.000Z');
  assert.equal(nextReset(new Date('2027-03-14T20:00:00Z')).toISOString(), '2027-03-15T07:00:00.000Z');
});
