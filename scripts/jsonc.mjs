// @ts-check
/** Reads JSONC, the format of wrangler.jsonc: JSON with // and /* comments, and trailing commas. */

// A string, a line comment or a block comment. Strings match first, so "https://…" and "*/15" stay whole.
const PARTS = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
// A string, or a comma just before a closing bracket.
const TRAILING = /"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g;

/**
 * Replaces each comment with spaces, so every other character keeps its place.
 * @param {string} text
 */
export function blankComments(text) {
  return text.replace(PARTS, (m) => (m.startsWith('"') ? m : m.replace(/[^\n]/g, ' ')));
}

/**
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
  return JSON.parse(blankComments(text).replace(TRAILING, (m) => (m.startsWith('"') ? m : '')));
}
