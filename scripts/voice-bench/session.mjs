// @ts-check
/**
 * One simulated "5 preguntas" session with a Gemini Live model. The learner's
 * lines are streamed in real time, with silence in between, like an open
 * microphone. Each line starts once the model has finished its reply.
 *
 * With `speechOnly`, nothing is sent between lines, and each line is wrapped
 * in activityStart and activityEnd, as an app does when it detects speech
 * itself. The setup must then turn off Google's activity detection.
 */
import { CHUNK_MS, INPUT_RATE, base64ToPcm, pcmToBase64, rateOf } from './lib.mjs';

export const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** How long the learner waits after the model finishes before speaking. */
export const REACTION_MS = 800;
/** How long to wait for a reply after the learner stops. */
export const REPLY_TIMEOUT_MS = 20_000;
/** The longest a session can run. */
export const SESSION_LIMIT_MS = 10 * 60_000;
/** How long to wait for the connection and the model's opening. */
export const START_TIMEOUT_MS = 30_000;

/**
 * @typedef {{ label: string, text: string, samples: Int16Array }} Clip
 *
 * @typedef {object} Turn  one learner line and what came back
 * @property {string} label
 * @property {string} said
 * @property {number} [startedAt]      ms from the start of the session
 * @property {number} [endedAt]
 * @property {number} [cutInAt]       the model started talking while this line was still playing
 * @property {number} [firstReplyAt]  the model's first audio after the line ended
 * @property {number} [doneAt]        the model finished its reply after the line ended
 * @property {boolean} [noReply]
 * @property {number} interruptions   times the learner's audio cut the model off
 * @property {string} heard           the model's transcript of the line
 * @property {string} reply           the transcript of the model's reply
 * @property {Int16Array[]} audio     the model's reply audio
 * @property {number} [replyMs]       pipeline only: how long the text model took
 * @property {number} [speechFirstMs] pipeline only: how long the voice took to send its first audio
 * @property {number} audioRate
 *
 * @typedef {object} Result
 * @property {Turn[]} turns   the model's opening first, then one per learner line
 * @property {any[]} reports  usageMetadata, in order
 * @property {string[]} notes
 * @property {{ code: number, reason: string } | null} close
 * @property {number} durationMs
 * @property {{ everyTurn: number, newOnly: number }} [cost]  set when the cost isn't worked out from reports, as in the pipeline
 *
 * @typedef {{ now(): number, setInterval(fn: () => void, ms: number): any, clearInterval(id: any): void }} Clock
 */

/** @type {Clock} */
const realClock = { now: () => Date.now(), setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) };

/**
 * @param {string} label
 * @param {string} said
 * @returns {Turn}
 */
export const newTurn = (label, said) => ({ label, said, interruptions: 0, heard: '', reply: '', audio: [], audioRate: 24000 });

/**
 * @param {{
 *   url: string,
 *   setup: object,
 *   kickoff: string,
 *   clips: Clip[],
 *   connect: (url: string) => any,
 *   clock?: Clock,
 *   speechOnly?: boolean,
 * }} p
 * @returns {Promise<Result>}
 */
export function runSession({ url, setup, kickoff, clips, connect, clock = realClock, speechOnly = false }) {
  return new Promise((resolve) => {
    const t0 = clock.now();
    const at = () => clock.now() - t0;
    const intro = newTurn('intro', '');
    /** @type {Turn[]} */
    const turns = [intro];
    /** The turn whose reply the model is giving. */
    let target = intro;
    /** @type {{ clip: Clip, turn: Turn, pos: number } | null} */
    let playing = null;
    let next = 0;
    let ready = false;
    let finished = false;
    /** @type {any[]} */
    const reports = [];
    /** @type {string[]} */
    const notes = [];
    /** @type {{ code: number, reason: string } | null} */
    let close = null;
    const silence = new Int16Array((INPUT_RATE * CHUNK_MS) / 1000);

    const ws = connect(url);
    ws.binaryType = 'arraybuffer';
    const send = (/** @type {unknown} */ obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };
    ws.onopen = () => send({ setup });
    ws.onmessage = (/** @type {{ data: string | ArrayBuffer }} */ e) => handle(e.data);
    ws.onerror = () => {};
    ws.onclose = (/** @type {{ code: number, reason: string }} */ e) => {
      close = { code: e.code, reason: e.reason };
      finish();
    };
    const timer = clock.setInterval(tick, CHUNK_MS);

    function finish() {
      if (finished) return;
      finished = true;
      clock.clearInterval(timer);
      if (ws.readyState === 1) {
        // Google only takes audioStreamEnd when it detects activity itself.
        if (!speechOnly) send({ realtimeInput: { audioStreamEnd: true } });
        ws.close(1000);
      }
      resolve({ turns, reports, notes, close, durationMs: at() });
    }

    /** @param {Turn} t */
    const answered = (t) => (t === intro ? t.doneAt !== undefined : t.doneAt !== undefined || t.noReply === true);
    /** @param {Turn} t */
    const readySince = (t) => (t.noReply ? (t.endedAt ?? 0) + REPLY_TIMEOUT_MS : t.doneAt ?? Infinity);

    function tick() {
      if (finished) return;
      if (at() > SESSION_LIMIT_MS) {
        notes.push('stopped at the session time limit');
        finish();
        return;
      }
      if ((!ready || intro.doneAt === undefined) && at() > START_TIMEOUT_MS) {
        notes.push(ready ? 'the model never finished its opening' : 'the session never started');
        finish();
        return;
      }
      if (!ready) return;

      /** @type {Int16Array | null} */
      let chunk = speechOnly ? null : silence;
      let lineEnded = false;
      if (playing) {
        chunk = playing.clip.samples.subarray(playing.pos, playing.pos + silence.length);
        if (chunk.length < silence.length) {
          const padded = new Int16Array(silence.length);
          padded.set(chunk);
          chunk = padded;
        }
        playing.pos += silence.length;
        if (playing.pos >= playing.clip.samples.length) {
          playing.turn.endedAt = at();
          playing = null;
          lineEnded = true;
        }
      }
      if (chunk) send({ realtimeInput: { audio: { data: pcmToBase64(chunk), mimeType: `audio/pcm;rate=${INPUT_RATE}` } } });
      if (lineEnded && speechOnly) send({ realtimeInput: { activityEnd: {} } });
      if (playing) return;

      if (target !== intro && target.endedAt !== undefined && !answered(target) && at() - target.endedAt > REPLY_TIMEOUT_MS) {
        target.noReply = true;
      }
      if (!answered(target) || at() - readySince(target) < REACTION_MS) return;
      if (next >= clips.length) {
        finish();
        return;
      }
      const clip = clips[next++];
      const turn = newTurn(clip.label, clip.text);
      turn.startedAt = at();
      turns.push(turn);
      target = turn;
      playing = { clip, turn, pos: 0 };
      if (speechOnly) send({ realtimeInput: { activityStart: {} } });
    }

    /** @param {string | ArrayBuffer} data */
    function handle(data) {
      let msg;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
      } catch {
        return;
      }
      if (msg.setupComplete && !ready) {
        ready = true;
        send({ realtimeInput: { text: kickoff } });
      }
      if (msg.usageMetadata) reports.push(msg.usageMetadata);
      if (msg.goAway) notes.push(`Google asked to end the session (${msg.goAway.timeLeft ?? ''})`);
      if (msg.error) notes.push(String(msg.error.message ?? msg.error));
      const sc = msg.serverContent;
      if (!sc) return;
      for (const part of sc.modelTurn?.parts ?? []) {
        const d = part.inlineData;
        if (!d?.data || !String(d.mimeType ?? '').startsWith('audio/')) continue;
        target.audio.push(base64ToPcm(d.data));
        target.audioRate = rateOf(d.mimeType);
        if (playing && playing.turn === target) {
          if (target.cutInAt === undefined) target.cutInAt = at();
        } else if (target === intro || target.endedAt !== undefined) {
          if (target.firstReplyAt === undefined) target.firstReplyAt = at();
        }
      }
      if (sc.inputTranscription?.text) (playing ? playing.turn : target).heard += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) target.reply += sc.outputTranscription.text;
      if (sc.interrupted) target.interruptions += 1;
      if (sc.turnComplete && target.firstReplyAt !== undefined && target.doneAt === undefined && !playing) {
        target.doneAt = at();
      }
    }
  });
}
