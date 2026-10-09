// @ts-check
/**
 * Topics for Leer, found from the feed, the article's own tags and its headline.
 * Words are matched without accents and in lower case.
 */

/** @type {Record<string, string[]>} topic → words that point to it */
export const TOPIC_WORDS = {
  'internacional': ['internacional', 'guerra', 'gaza', 'ucrania', 'onu', 'eeuu', 'estados unidos', 'europa', 'america latina', 'latinoamerica', 'mexico', 'argentina', 'colombia', 'venezuela'],
  'sociedad': ['sociedad', 'educacion', 'igualdad', 'feminismo', 'migracion', 'inmigracion', 'religion'],
  'cultura': ['cultura', 'arte', 'museo', 'exposicion', 'teatro', 'danza', 'fotografia'],
  'cine': ['cine', 'pelicula', 'series', 'serie', 'festival de san sebastian', 'oscar', 'goya', 'netflix'],
  'música': ['musica', 'concierto', 'disco', 'cancion', 'punk', 'rock', 'flamenco', 'rap', 'festival de musica'],
  'libros': ['libro', 'libros', 'novela', 'literatura', 'escritor', 'escritora', 'poesia', 'editorial'],
  'ciencia': ['ciencia', 'investigacion', 'cientificos', 'fisica', 'quimica', 'biologia', 'espacio', 'astronomia', 'nasa'],
  'salud': ['salud', 'medicina', 'cancer', 'hospital', 'sanidad', 'enfermedad', 'vacuna'],
  'tecnología': ['tecnologia', 'inteligencia artificial', 'openai', 'internet', 'movil', 'moviles', 'apple', 'google', 'software'],
  'medio ambiente': ['medio ambiente', 'clima', 'cambio climatico', 'sequia', 'incendio', 'naturaleza', 'ecologia', 'animales'],
  'urbanismo': ['urbanismo', 'ciudad', 'ciudades', 'barrio', 'barrios', 'transporte publico', 'movilidad'],
  'vivienda': ['vivienda', 'alquiler', 'alquileres', 'hipoteca', 'desahucio'],
  'economía': ['economia', 'empleo', 'paro', 'salario', 'impuestos', 'inflacion', 'empresas'],
  'historia': ['historia', 'historico', 'historica', 'arqueologia', 'guerra civil', 'franquismo', 'romanos'],
  'viajes': ['viaje', 'viajes', 'turismo', 'turistas', 'destino', 'playa', 'pueblo', 'pueblos'],
  'gastronomía': ['gastronomia', 'cocina', 'receta', 'restaurante', 'comida', 'vino', 'chef'],
  'deporte': ['deporte', 'deportes', 'tenis', 'baloncesto', 'ciclismo', 'atletismo', 'olimpicos', 'formula 1'],
  'fútbol': ['futbol', 'liga', 'champions', 'real madrid', 'barcelona', 'atletico', 'seleccion espanola', 'mundial'],
};

/** @param {string} s */
export const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * @param {{ title: string, tags: string[] }} item
 * @param {string[]} feedTopics
 * @returns {string[]} up to three topics
 */
export function topicsFor(item, feedTopics) {
  const words = (/** @type {string} */ t) => fold(t).replace(/[^a-z0-9ñ]+/g, ' ').trim();
  const text = ` ${[item.title, ...item.tags].map(words).join(' | ')} `;
  const found = new Set(feedTopics);
  for (const [topic, list] of Object.entries(TOPIC_WORDS)) {
    if (list.some((w) => text.includes(` ${w} `))) found.add(topic);
  }
  return [...found].slice(0, 3);
}
