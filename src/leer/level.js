// @ts-check
/**
 * Fácil, Medio or Difícil from the INFLESZ readability score (Barrio-Cantalejo, 2008).
 * It scores sentence and word length only, so it is a guide, not a language level.
 * INFLESZ = 206.835 − 62.3 × (syllables / words) − (words / sentences)
 */

const VOWEL = /[aeiouáéíóúü]/;
// Strong vowels, and weak vowels with an accent, start a new syllable after a strong vowel.
const STRONG = /[aeoáéóíú]/;

/** Rough Spanish syllable count for one word. @param {string} word */
export function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-záéíóúüñ]/g, '');
  let count = 0;
  let prev = '';
  for (const ch of w) {
    if (VOWEL.test(ch)) {
      if (!VOWEL.test(prev) || (STRONG.test(prev) && STRONG.test(ch))) count++;
    }
    prev = ch;
  }
  return Math.max(1, count);
}

/** @param {string} text */
export function inflesz(text) {
  const sentences = Math.max(1, text.split(/[.!?¡¿:;]+/).filter((s) => /[a-záéíóúñ]/i.test(s)).length);
  const words = text.match(/[a-záéíóúüñ]+/gi) ?? [];
  if (words.length < 8) return null;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 206.835 - 62.3 * (syl / words.length) - words.length / sentences;
}

/**
 * INFLESZ bands: above 65 is "bastante fácil", 55 to 65 "normal", below 55 "algo difícil".
 * @param {string} text
 * @returns {'facil'|'medio'|'dificil'}
 */
export function levelFor(text) {
  const score = inflesz(text);
  if (score === null) return 'medio';
  if (score >= 65) return 'facil';
  if (score >= 55) return 'medio';
  return 'dificil';
}
