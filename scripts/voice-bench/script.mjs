// @ts-check
/**
 * What the simulated learner says, and the options the voice test compares.
 *
 * The answers are Saar's own answers from his "5 preguntas" session on
 * "Los viajes" on 10 October 2026, with his mistakes kept. The fifth answer is
 * new, because that session ended before the fifth question. Pauses are in
 * seconds, as {1.2}. Google's default turn-taking takes a pause of about 0.8 s
 * as the end of a turn, so every pause here would let the model cut in.
 */

/** @type {import('./lib.mjs').Line[]} */
export const ANSWERS = [
  { label: 'answer 1', say: 'Sí, me gusta mucho viajar. {1.2} Intentamos viajar en un nuevo lugar cada año, para tres semanas, cuatro semanas. Hoy en día es un poco más difícil porque tenemos un hijo, pero {1.6} antes viajábamos a muchos lugares, como Ecuador, Cuba y Sri Lanka.' },
  { label: 'answer 2', say: 'Me gusta ambos, porque me gusta mucho la naturaleza. Por ejemplo, en Ecuador {1.3} hay montañas y hay playas bonitas. Subimos el Cotopaxi, que es muy grande, y después {1.8} fuimos a Galápagos para la playas.' },
  { label: 'answer 3', say: 'Prefiero un apartamento, porque prefiero quedarme en un lugar con espacio y con una cocina. {1.2} En un hotel no tienes cosas para preparar comida, y por eso {1.5} es mejor para nosotros un apartamento o un piso.' },
  { label: 'answer 4', say: 'Prefiero ambos. Una mezcla es mejor para mí. Me gusta mucho el turismo, pero {1.7} también descansar en la playa es muy importante para mí, porque me gusta mucho nadar.' },
  { label: 'answer 5', say: 'El mejor viaje fue a Sri Lanka. {1.2} Viajamos en tren por las montañas y vimos muchas plantaciones de té. Fue muy bonito, pero {1.6} hacía mucho calor.' },
];

/** @type {import('./lib.mjs').Line} */
export const NEXT = { label: 'siguiente', say: 'Siguiente pregunta.' };

/** The order the learner speaks in: an answer, then «siguiente pregunta», and so on. */
export const LINES = ANSWERS.flatMap((a, i) => (i < ANSWERS.length - 1 ? [a, NEXT] : [a]));

export const THEME = 'Los viajes';
export const KICKOFF = 'Hola. Empecemos con las 5 preguntas.';

/** charla's level guide for Fácil (A2), from charla's src/core/prompts.js. */
const LEVEL_A2 = 'Mi nivel es A2 (básico). Usa frases cortas y vocabulario común. Usa el presente, el pasado y el futuro con «ir a». Habla despacio.';

const RULES = `Reglas:
- Habla solo en español, con acento de España.
- Adapta las preguntas, el vocabulario y la velocidad a mi nivel.
- Si no entiendo algo, repítelo con palabras más sencillas.
- No me corrijas durante la conversación, salvo que yo lo pida. Queremos que la conversación fluya.
- Sé breve en cada turno. Deja que yo hable más que tú.`;

const LEARNER_RULES = `
- Hago pausas para pensar. Si mi frase parece sin terminar, por ejemplo si acaba en «pero», «y» o «porque», di solo «¿Sí?» o «Sigue» y espera.
- Si no entiendes lo que digo, pídeme que lo repita. No me pidas que hable en español, salvo que diga una frase entera en otro idioma.`;

const ACTIVITY_TODAY = `- Prepara 5 preguntas sobre el tema.
- Di el tema y haz solo la primera pregunta.
- No hagas la siguiente pregunta hasta que yo diga «siguiente pregunta».
- Entre preguntas, comenta mi respuesta o hazme una pregunta corta para seguir la conversación.
- Después de la quinta pregunta, despídete de forma breve.`;

const ACTIVITY_TUNED = `- Prepara 5 preguntas sobre el tema antes de empezar, y hazlas en ese orden.
- Di el tema y haz solo la primera pregunta.
- Di el número de cada pregunta: primera, segunda, tercera, cuarta y quinta. Usa cada número una sola vez.
- No hagas la siguiente pregunta hasta que yo diga «siguiente pregunta».
- Entre preguntas, comenta mi respuesta o hazme una pregunta corta para seguir la conversación. Esas preguntas cortas no tienen número y no cuentan como una de las 5.
- Después de la quinta pregunta, despídete de forma breve.`;

/**
 * charla's instructions for a "5 preguntas" session at Fácil. "today" is
 * charla before 10 October, "tuned" is step 1 of the voice test.
 * @param {'today' | 'tuned'} variant
 */
export function prompt(variant) {
  const tuned = variant === 'tuned';
  return `Eres mi compañero de conversación en español. Hablamos cada día para practicar. Estoy aprendiendo español.
${LEVEL_A2}
${RULES}${tuned ? LEARNER_RULES : ''}

Actividad de hoy: 5 preguntas.
Tema: ${THEME}. Es la ronda 1 de 3 con este tema.
${tuned ? ACTIVITY_TUNED : ACTIVITY_TODAY}`;
}

const ORDINALS = ['primera', 'segunda', 'tercera', 'cuarta', 'quinta'];

/** @param {string} text */
const asksNext = (text) => /siguiente\s+pregunta/.test(text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));

/**
 * Where the 5 questions are, added to the instructions on each pipeline turn,
 * as in charla's src/core/prompts.js (questionNote). The app counts the
 * learner's «siguiente pregunta», so the model doesn't have to remember. In the
 * first pipeline test on 10 October, Flash-Lite asked the fourth question
 * without waiting for «siguiente pregunta».
 * @param {{ role: 'user' | 'model', text: string }[]} history  the conversation before this turn
 */
export function questionNote(history) {
  if (!history.length) return '\n\nAhora: di el tema y haz la primera pregunta.';
  const n = 1 + history.filter((m) => m.role === 'user' && asksNext(m.text)).length;
  const comment = 'comenta lo que digo o hazme una pregunta corta sobre ello';
  if (n > 5) return `\n\nAhora: ya hemos hecho las 5 preguntas. No hagas más preguntas con número. ${comment[0].toUpperCase()}${comment.slice(1)}, o despídete si me despido.`;
  if (n === 5) return `\n\nAhora: vamos por la quinta y última pregunta. Si en este turno digo «siguiente pregunta», dime que ya hemos hecho las 5 y despídete de forma breve. Si no, ${comment}.`;
  return `\n\nAhora: vamos por la ${ORDINALS[n - 1]} pregunta. Si en este turno digo «siguiente pregunta», haz la ${ORDINALS[n]} pregunta. Si no, no hagas una pregunta nueva con número: ${comment}.`;
}

/** Turn-taking for learners, as in charla's src/core/gemini.js (LEARNER_TURNS). */
export const LEARNER_TURNS = {
  automaticActivityDetection: { endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', silenceDurationMs: 1500 },
};

/**
 * A hint that the learner speaks Spain Spanish, for Google's transcript of
 * what they say, as in charla's src/core/gemini.js (LEARNER_TRANSCRIPTION).
 * Without it Google guesses the language, and on 10 October it wrote a German
 * word for one of Saar's answers.
 */
export const LEARNER_TRANSCRIPTION = { languageCodes: ['es-ES'] };

/**
 * The app decides when the learner starts and stops: Google's activity
 * detection is off, and sound is sent only while the learner speaks. Google
 * says gemini-3.1-flash-live-preview then bills only the sound it gets.
 * gemini-3.8-live bills "the entire time the Live API is listening", so this
 * shows whether that includes the time when no sound is sent.
 */
export const APP_TURNS = { automaticActivityDetection: { disabled: true } };

/**
 * Google bills every turn for the whole session so far. This drops the oldest
 * part once the session holds 4,000 tokens (about 2.5 minutes) and keeps the
 * newest 2,000 (about 80 seconds). The prompt is always kept.
 */
export const SHORT_CONTEXT = { triggerTokens: 4000, slidingWindow: { targetTokens: 2000 } };

/**
 * @typedef {object} Option
 * @property {string} id              short name used in file names
 * @property {string} name            what the report calls it
 * @property {string} model
 * @property {'today' | 'tuned'} prompt
 * @property {object} [turns]         realtimeInputConfig; none means Google's default
 * @property {boolean} [speechOnly]   send sound only while the learner speaks, with activityStart and activityEnd
 * @property {object} [compression]   contextWindowCompression
 * @property {object} [transcription] inputAudioTranscription; none means Google guesses the language
 * @property {'live' | 'pipeline'} [kind]  live (the default) or a pipeline of a text model and text-to-speech
 * @property {string} [tts]           the text-to-speech model of a pipeline
 */

/** @type {Option[]} */
export const OPTIONS = [
  { id: 'today', name: 'Gemini 3.8 Live as today', model: 'gemini-3.8-live', prompt: 'today' },
  { id: 'tuned', name: 'Gemini 3.8 Live, tuned', model: 'gemini-3.8-live', prompt: 'tuned', turns: LEARNER_TURNS, transcription: LEARNER_TRANSCRIPTION },
  { id: 'short-context', name: 'Gemini 3.8 Live, tuned, short context', model: 'gemini-3.8-live', prompt: 'tuned', turns: LEARNER_TURNS, transcription: LEARNER_TRANSCRIPTION, compression: SHORT_CONTEXT },
  { id: 'speech-only', name: 'Gemini 3.8 Live, tuned, speech only', model: 'gemini-3.8-live', prompt: 'tuned', turns: APP_TURNS, speechOnly: true, transcription: LEARNER_TRANSCRIPTION },
  { id: 'flash-live', name: 'Gemini 3.1 Flash Live, tuned', model: 'gemini-3.1-flash-live-preview', prompt: 'tuned', turns: LEARNER_TURNS, transcription: LEARNER_TRANSCRIPTION },
  { id: 'flash-speech-only', name: 'Gemini 3.1 Flash Live, tuned, speech only', model: 'gemini-3.1-flash-live-preview', prompt: 'tuned', turns: APP_TURNS, speechOnly: true, transcription: LEARNER_TRANSCRIPTION },
  { id: 'native-audio', name: 'Gemini 2.5 Flash Native Audio, tuned', model: 'gemini-2.5-flash-native-audio-latest', prompt: 'tuned', turns: LEARNER_TURNS, transcription: LEARNER_TRANSCRIPTION },
  { id: 'pipeline', name: 'Pipeline: Gemini 3.1 Flash-Lite and 3.8 Flash-Lite TTS', kind: 'pipeline', model: 'gemini-3.1-flash-lite', tts: 'gemini-3.8-flash-lite-tts', prompt: 'tuned' },
];

/**
 * The Live API setup for an option.
 * @param {Option} option
 */
export function setupFor(option) {
  return {
    model: `models/${option.model}`,
    generationConfig: { responseModalities: ['AUDIO'] },
    systemInstruction: { parts: [{ text: prompt(option.prompt) }] },
    ...(option.turns ? { realtimeInputConfig: option.turns } : {}),
    ...(option.compression ? { contextWindowCompression: option.compression } : {}),
    inputAudioTranscription: option.transcription ?? {},
    outputAudioTranscription: {},
  };
}
