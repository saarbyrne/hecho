// @ts-check
/**
 * npm run voice-test
 * Plays a simulated learner to each option in script.mjs and writes a report.
 * Needs a Mac (the learner's voice comes from the `say` command) and Hecho's
 * Gemini key in .dev.vars. Options: --only today,tuned  --runs 2
 * It never prints the key.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hideKey, parseDevVars } from '../check-gemini.mjs';
import { INPUT_RATE, plainText, readWav, resample, sayText, writeWav } from './lib.mjs';
import { report, score } from './report.mjs';
import { FALLBACK_VOICE, PIPELINE_RULES, chooseVoice, geminiPipeline, runPipeline, spainVoices } from './pipeline.mjs';
import { KICKOFF, LINES, OPTIONS, prompt, questionNote, setupFor } from './script.mjs';
import { LIVE_URL, runSession } from './session.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'scripts', 'voice-bench', 'out');

/**
 * A Spanish voice from `say -v ?`, Spain first. BENCH_VOICE picks another.
 * @param {string} list the output of `say -v ?`
 */
export function pickVoice(list) {
  const voices = list
    .split('\n')
    .map((line) => /^(.+?)\s{2,}(es_[A-Z]{2})\s/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ name: m[1].trim(), locale: m[2] }));
  return (voices.find((v) => v.locale === 'es_ES') ?? voices[0])?.name ?? null;
}

/** @param {string} s */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The learner's lines as audio, made once per voice and kept in out/voices.
 * @param {string} voice
 */
function learnerClips(voice) {
  const dir = join(OUT, 'voices', slug(voice));
  mkdirSync(dir, { recursive: true });
  return LINES.map((line) => {
    const hash = createHash('sha1').update(line.say).digest('hex').slice(0, 8);
    const file = join(dir, `${slug(line.label)}-${hash}.wav`);
    if (!existsSync(file)) {
      execFileSync('say', ['-v', voice, '-r', '160', '--file-format=WAVE', '--data-format=LEI16@16000', '-o', file, sayText(line.say)]);
    }
    const { rate, samples } = readWav(readFileSync(file));
    return { label: line.label, text: plainText(line.say), samples: resample(samples, rate, INPUT_RATE) };
  });
}

/** @param {string[]} argv */
function args(argv) {
  const get = (/** @type {string} */ name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const only = get('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const runs = Math.max(1, Math.min(5, Number(get('--runs') ?? 2) || 2));
  const options = only ? OPTIONS.filter((o) => only.includes(o.id)) : OPTIONS;
  if (!options.length) throw new Error(`No option called ${only?.join(', ')}. The options are: ${OPTIONS.map((o) => o.id).join(', ')}.`);
  return { options, runs };
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('This test needs a Mac, because the learner\'s voice comes from the Mac\'s "say" command.');
  const { options, runs } = args(process.argv.slice(2));
  const devVars = join(ROOT, '.dev.vars');
  if (!existsSync(devVars)) throw new Error('There is no .dev.vars file. Copy .dev.vars.example to .dev.vars and paste Hecho\'s Gemini key after GEMINI_API_KEY=.');
  const key = parseDevVars(readFileSync(devVars, 'utf8')).GEMINI_API_KEY ?? '';
  if (!key || /^<.*>$/.test(key)) throw new Error('.dev.vars has no GEMINI_API_KEY. Paste Hecho\'s Gemini key after GEMINI_API_KEY=.');

  const voice = process.env.BENCH_VOICE || pickVoice(execFileSync('say', ['-v', '?'], { encoding: 'utf8' }));
  if (!voice) throw new Error('This Mac has no Spanish voice. Add one in System Settings → Accessibility → Spoken Content → System voice → Manage Voices, then run this again.');
  console.log(`Learner voice: ${voice}`);
  const clips = learnerClips(voice);

  let ttsVoice = '';
  if (options.some((o) => o.kind === 'pipeline')) {
    const voices = await spainVoices({ fetch, key });
    if (voices.length) console.log(`Spain Spanish voices in Google's library: ${voices.map((v) => `${v.name} (${v.id}${v.gender ? `, ${v.gender}` : ''})`).join('; ')}`);
    const found = process.env.BENCH_TTS_VOICE ? null : chooseVoice(voices);
    ttsVoice = process.env.BENCH_TTS_VOICE || found?.id || FALLBACK_VOICE;
    console.log(`Pipeline voice: ${found ? `${found.name} (${found.id})` : ttsVoice}${found || process.env.BENCH_TTS_VOICE ? '' : ', because Google listed no Spain Spanish voice'}. BENCH_TTS_VOICE=<id> picks another.`);
  }

  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const folder = join(OUT, stamp);
  mkdirSync(folder, { recursive: true });
  const minutes = Math.ceil(runs * 4);
  console.log(`Testing ${options.map((o) => o.id).join(', ')}, ${runs} run${runs > 1 ? 's' : ''} each. This takes about ${minutes} minutes.`);

  /** @type {import('./report.mjs').Run[]} */
  const all = [];
  for (let run = 1; run <= runs; run++) {
    const results = await Promise.all(options.map(async (option) => {
      const dir = join(folder, `${option.id}-${run}`);
      mkdirSync(dir, { recursive: true });
      try {
        const result = option.kind === 'pipeline'
          ? await runPipeline({
            pipeline: geminiPipeline({ fetch, key, model: option.model, ttsModel: option.tts ?? '', voice: ttsVoice, system: prompt(option.prompt) + PIPELINE_RULES }),
            kickoff: KICKOFF,
            clips,
            turnNote: questionNote,
          })
          : await runSession({
            url: `${LIVE_URL}?key=${encodeURIComponent(key)}`,
            setup: setupFor(option),
            kickoff: KICKOFF,
            clips,
            connect: (url) => new WebSocket(url),
            speechOnly: option.speechOnly === true,
          });
        result.turns.forEach((t, i) => {
          if (!t.audio.length) return;
          const pcm = new Int16Array(t.audio.reduce((n, a) => n + a.length, 0));
          let pos = 0;
          for (const a of t.audio) { pcm.set(a, pos); pos += a.length; }
          writeFileSync(join(dir, `${String(i).padStart(2, '0')}-${slug(t.label)}.wav`), writeWav(pcm, t.audioRate));
        });
        const saved = { option, run, turns: result.turns.map(({ audio, ...rest }) => rest), reports: result.reports, notes: result.notes.map((n) => hideKey(n, key)), close: result.close, durationMs: result.durationMs, cost: result.cost };
        writeFileSync(join(dir, 'session.json'), JSON.stringify(saved, null, 2));
        result.notes = saved.notes;
        if (result.close && result.close.code !== 1000) result.notes.push(hideKey(`closed by Google: ${result.close.code} ${result.close.reason}`, key));
        const scores = score(result, option);
        console.log(`  ${option.id} run ${run}: ${scores.cutIns} cut-ins, questions ${scores.order.ok ? 'right' : 'wrong'}, ${result.turns.length - 1} lines${result.notes.length ? `, ${result.notes.join('; ')}` : ''}`);
        return { option, run, folder: relative(ROOT, dir), result, scores };
      } catch (err) {
        const error = hideKey(err instanceof Error ? err.message : String(err), key);
        console.log(`  ${option.id} run ${run}: failed, ${error}`);
        return { option, run, folder: relative(ROOT, dir), result: { turns: [], reports: [], notes: [], close: null, durationMs: 0 }, scores: score({ turns: [], reports: [], notes: [], close: null, durationMs: 0 }, option), error };
      }
    }));
    all.push(...results);
  }

  const file = join(folder, 'report.md');
  writeFileSync(file, report({ date, voice, runs: all, ttsVoice }));
  console.log(`\nReport: ${relative(ROOT, file)}`);
}

// Runs only when called as a script, so tests can import pickVoice.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
