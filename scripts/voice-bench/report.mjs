// @ts-check
/** Scores for one simulated session, and the report that compares the options. */
import { PRICES, average, questionNumbers, questionOrder, sessionCost, wordAccuracy } from './lib.mjs';

/**
 * @param {import('./session.mjs').Result} result
 * @param {import('./script.mjs').Option} option
 */
export function score(result, option) {
  const lines = result.turns.filter((t) => t.label !== 'intro');
  const answers = lines.filter((t) => t.label.startsWith('answer'));
  const waits = lines
    .filter((t) => t.cutInAt === undefined && t.firstReplyAt !== undefined && t.endedAt !== undefined)
    .map((t) => ((t.firstReplyAt ?? 0) - (t.endedAt ?? 0)) / 1000);
  const minutes = result.durationMs / 60_000;
  const price = PRICES[option.model];
  const cost = result.cost ?? (price ? sessionCost(result.reports, price) : null);
  return {
    lines: lines.length,
    cutIns: lines.filter((t) => t.cutInAt !== undefined).length,
    noReply: lines.filter((t) => t.noReply).length,
    waitAvg: average(waits),
    waitMax: waits.length ? Math.max(...waits) : NaN,
    /** Pipeline only: the text model's and the voice's share of the wait. */
    replyAvg: average(lines.filter((t) => t.replyMs !== undefined).map((t) => (t.replyMs ?? 0) / 1000)),
    speechAvg: average(lines.filter((t) => t.speechFirstMs !== undefined).map((t) => (t.speechFirstMs ?? 0) / 1000)),
    heardRight: average(answers.map((t) => wordAccuracy(t.said, t.heard))),
    order: questionOrder(questionNumbers(result.turns.map((t) => t.reply))),
    minutes,
    /** Usage reports, one per turn the model takes. Google bills each one. */
    billedTurns: result.reports.length,
    cost,
    complete: lines.length > 0 && result.notes.length === 0 && (result.close === null || result.close.code === 1000),
  };
}

const money = (/** @type {number} */ n) => (Number.isFinite(n) ? `$${n.toFixed(3)}` : '?');
const secs = (/** @type {number} */ n) => (Number.isFinite(n) ? `${n.toFixed(1)} s` : '?');
const pct = (/** @type {number} */ n) => (Number.isFinite(n) ? `${Math.round(n * 100)}%` : '?');
const mins = (/** @type {number} */ n) => (Number.isFinite(n) && n > 0 ? n.toFixed(1) : '?');

/** @param {ReturnType<typeof questionOrder>} o */
function orderText(o) {
  if (o.ok) return 'right';
  const parts = [];
  if (o.missing.length) parts.push(`missing ${o.missing.join(', ')}`);
  if (o.repeats) parts.push(`${o.repeats} repeated`);
  if (!o.inOrder) parts.push('out of order');
  return parts.join(', ');
}

/**
 * @typedef {{ option: import('./script.mjs').Option, run: number, folder: string, result: import('./session.mjs').Result, scores: ReturnType<typeof score>, error?: string }} Run
 */

/**
 * The report, in Markdown.
 * @param {{ date: string, voice: string, runs: Run[], ttsVoice?: string }} p
 */
export function report({ date, voice, runs, ttsVoice = '' }) {
  const rows = runs.map(({ option, run, scores: s, error }) => (error
    ? `| ${option.name} | ${run} | failed: ${error} | | | | | | | |`
    : `| ${option.name} | ${run} | ${s.cutIns} of ${s.lines} | ${secs(s.waitAvg)}${Number.isFinite(s.replyAvg) ? ` (text ${secs(s.replyAvg)}, voice ${secs(s.speechAvg)})` : ''} | ${pct(s.heardRight)} | ${orderText(s.order)} | ${mins(s.minutes)} | ${s.billedTurns} | ${money(s.cost?.everyTurn ?? NaN)} | ${money(s.cost?.newOnly ?? NaN)} |`));
  const replies = runs.flatMap(({ option, run, folder, result, error }) => {
    if (error) return [];
    return [
      `### ${option.name}, run ${run}`,
      '',
      `Audio: \`${folder}\``,
      '',
      ...result.turns.map((t) => `- **${t.label}**${t.said ? ` (said: ${t.said})` : ''}${t.cutInAt !== undefined ? ' [cut in]' : ''}${t.noReply ? ' [no reply]' : ''}\n  - heard: ${t.heard.trim() || '-'}\n  - reply: ${t.reply.trim() || '-'}`),
      ...(result.notes.length ? ['', `Notes: ${result.notes.join('; ')}`] : []),
      '',
    ];
  });
  return [
    '# Voice test results',
    '',
    `Run on ${date}. The learner is the Mac voice "${voice}", reading Saar's answers with pauses of 1.2 to 1.8 seconds.${ttsVoice ? ` The pipeline speaks with the voice "${ttsVoice}".` : ''}`,
    '',
    '- **Cut in:** lines where the model started talking before the learner finished.',
    '- **Wait:** average time from the end of a line to the reply, leaving out cut-ins. In the speech only options the test marks the end of a line the moment it ends. A real app has to wait for a pause first, so its reply comes about 1.5 s later than shown.',
    '- **Heard right:** how much of the answers Google\'s transcript got right.',
    '- **Questions:** whether it said "primera" to "quinta pregunta" once each, in order. Check this closely for the short context option, which drops the oldest part of the conversation.',
    '- **Turns:** turns the model took. On the Live API, Google bills each one for the whole session so far.',
    '- **Pipeline:** Gemini Flash-Lite gets each answer as audio and writes the reply, and Gemini\'s text-to-speech says it. charla would decide when the learner has finished, so it can\'t cut in, and its Wait has the same caveat as speech only. Each call bills only what it gets.',
    '- **Cost:** the session\'s cost from its token counts at list prices, billed the way Google\'s Live API guide describes (updated 15 September 2026). "If billed once" counts each token once, for comparison. AI Studio\'s bill is the final check.',
    '',
    '| Option | Run | Cut in | Wait | Heard right | Questions | Minutes | Turns | Cost | If billed once |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Replies',
    '',
    ...replies,
  ].join('\n');
}
