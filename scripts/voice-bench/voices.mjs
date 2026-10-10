// @ts-check
/**
 * npm run voice-samples
 * Says the same sentences in every Spain Spanish voice in Google's voice
 * library, so the voice for charla can be chosen by ear. Writes one WAV file
 * per voice to scripts/voice-bench/out/voices-es/. A voice that already has a
 * file is skipped, so running it again fills in the ones that failed.
 * `npm run voice-samples -- --again` makes them all again.
 *
 * On Tier 1 Google allows 10 voice requests a minute and 100 a day, so it
 * makes one request every 7 seconds and waits when Google asks it to. It
 * stops when the day's requests are used up.
 * Costs about $0.002 a voice. Needs Hecho's Gemini key in .dev.vars. It never
 * prints the key.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { hideKey, parseDevVars } from '../check-gemini.mjs';
import { writeWav } from './lib.mjs';
import { geminiPipeline, spainVoices } from './pipeline.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'scripts', 'voice-bench', 'out', 'voices-es');

/** Words that show a Spain accent: the "z" and soft "c" in Zaragoza, Valencia and cerveza. */
export const SAMPLE = 'Hola. Hoy vamos a hablar de los viajes. ¿Has estado en Zaragoza o en Valencia? Cuéntame tu viaje favorito, y dime si probaste la comida del lugar.';

/** Time between two requests: 10 a minute on Tier 1, with a second to spare. */
export const GAP_MS = 7000;

/** Tries for one voice when Google says to wait. */
const TRIES = 3;

/**
 * How long Google asks to wait, from "Please retry in 33s" or "retry in 1.5s".
 * @param {string} message
 * @returns {number | null} milliseconds, or null when the message gives no time
 */
export function retryAfterMs(message) {
  const m = /retry in (\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.ceil(m[2].toLowerCase() === 'ms' ? n : n * 1000);
}

/**
 * Whether Google refused because the day's requests are used up, which
 * waiting a minute doesn't fix.
 * @param {string} message
 */
export const dailyLimit = (message) => /per[ _]day|daily/i.test(message);

/**
 * When Google resets the day's requests: the next midnight in Pacific time.
 * @param {Date} now
 */
export function nextReset(now = new Date()) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  /** Pacific time's date, and how many minutes it is from UTC. @param {Date} d */
  const pacific = (d) => {
    /** @type {Record<string, number>} */
    const p = Object.fromEntries(format.formatToParts(d).map((x) => [x.type, Number(x.value)]));
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return { year: p.year, month: p.month, day: p.day, offset: wall - Math.floor(d.getTime() / 60000) * 60000 };
  };
  const today = pacific(now);
  const midnight = Date.UTC(today.year, today.month - 1, today.day + 1);
  // Summer time can start or end before midnight, so check the offset there.
  return new Date(midnight - pacific(new Date(midnight - today.offset)).offset);
}

/** @param {string} s */
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function main() {
  const devVars = join(ROOT, '.dev.vars');
  if (!existsSync(devVars)) throw new Error('There is no .dev.vars file. Copy .dev.vars.example to .dev.vars and paste Hecho\'s Gemini key after GEMINI_API_KEY=.');
  const key = parseDevVars(readFileSync(devVars, 'utf8')).GEMINI_API_KEY ?? '';
  if (!key || /^<.*>$/.test(key)) throw new Error('.dev.vars has no GEMINI_API_KEY. Paste Hecho\'s Gemini key after GEMINI_API_KEY=.');
  const again = process.argv.includes('--again');
  const voices = await spainVoices({ fetch, key });
  if (!voices.length) throw new Error('Google listed no Spain Spanish voices.');
  mkdirSync(OUT, { recursive: true });

  const fileOf = (/** @type {{ name: string }} */ v) => join(OUT, `${slug(v.name)}.wav`);
  const todo = voices.filter((v) => again || !existsSync(fileOf(v)));
  console.log(`${voices.length} Spain Spanish voices. Each one says: "${SAMPLE}"`);
  if (todo.length) {
    const minutes = Math.ceil((todo.length * GAP_MS) / 60000);
    console.log(`${todo.length} to make, one every ${GAP_MS / 1000} seconds because of Google's limit of 10 a minute. That takes about ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.\n`);
  } else {
    console.log('Every voice has a file already. Add --again to make them again.\n');
  }

  /** @type {string[]} */
  const lines = [];
  let last = 0;
  let outOfRequests = false;
  for (const v of voices) {
    const file = fileOf(v);
    const label = `${v.name} (${v.id}${v.gender ? `, ${v.gender}` : ''})`;
    if (!todo.includes(v)) {
      lines.push(`- ${label}: ${relative(ROOT, file)}`);
      console.log(`- ${label}: made earlier`);
      continue;
    }
    if (outOfRequests) {
      lines.push(`- ${label}: not made yet`);
      continue;
    }
    let line = '';
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      await sleep(Math.max(0, last + GAP_MS - Date.now()));
      last = Date.now();
      const p = geminiPipeline({ fetch, key, model: 'gemini-3.1-flash-lite', ttsModel: 'gemini-3.8-flash-lite-tts', voice: v.id, system: '' });
      try {
        const speech = await p.speak(SAMPLE, () => {});
        if (p.notes.some((n) => /didn't take the voice/.test(n))) {
          line = `- ${label}: Google didn't take this voice`;
          break;
        }
        const pcm = new Int16Array(speech.audio.reduce((n, a) => n + a.length, 0));
        let pos = 0;
        for (const a of speech.audio) { pcm.set(a, pos); pos += a.length; }
        writeFileSync(file, writeWav(pcm, speech.rate));
        line = `- ${label}: ${relative(ROOT, file)}`;
        break;
      } catch (err) {
        const message = hideKey(err instanceof Error ? err.message : String(err), key);
        if (dailyLimit(message)) {
          outOfRequests = true;
          line = `- ${label}: not made yet, because Google's requests for today are used up`;
          break;
        }
        const wait = retryAfterMs(message);
        if (wait !== null && attempt < TRIES) {
          console.log(`  Google asked to wait ${Math.ceil(wait / 1000)} seconds before ${v.name}.`);
          last = Date.now() + wait + 1000 - GAP_MS;
          continue;
        }
        line = `- ${label}: failed, ${message}`;
        break;
      }
    }
    console.log(line);
    lines.push(line);
  }

  writeFileSync(join(OUT, 'voices.md'), `# Spain Spanish voices\n\nEach one says: "${SAMPLE}"\n\n${lines.join('\n')}\n`);
  const missing = lines.filter((l) => !l.includes(relative(ROOT, OUT))).length;
  if (outOfRequests) {
    const when = nextReset().toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
    console.log(`\n${missing} voices are still missing. Google resets the day's requests at midnight Pacific time, which is ${when} on this Mac. Run npm run voice-samples again after that, and it makes only the missing ones.`);
  } else if (missing) {
    console.log(`\n${missing} voices are still missing. Run npm run voice-samples again to try them.`);
  }
  console.log(`\nOpen the folder with: open ${relative(ROOT, OUT)}`);
}

// Runs only when called as a script, so tests can import from it.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
