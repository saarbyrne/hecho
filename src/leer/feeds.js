// @ts-check
/**
 * Real news feeds for Leer. All free to read.
 * `topics` are given to every article in the feed. Keywords and categories add more (see topics.js).
 * Checked on 9 Oct 2026: every feed worked from the Worker except Infobae, which answered HTTP 403.
 * elDiarioAR (Argentina) replaced it that day. Its feed comes from the same system as elDiario.es.
 * @type {{ id: string, source: string, url: string, topics: string[] }[]}
 */
export const FEEDS = [
  { id: 'eldiario', source: 'elDiario.es', url: 'https://www.eldiario.es/rss/', topics: [] },
  { id: 'eldiario-cultura', source: 'elDiario.es', url: 'https://www.eldiario.es/rss/cultura/', topics: ['cultura'] },
  { id: 'eldiario-internacional', source: 'elDiario.es', url: 'https://www.eldiario.es/rss/internacional/', topics: ['internacional'] },
  { id: 'eldiario-sociedad', source: 'elDiario.es', url: 'https://www.eldiario.es/rss/sociedad/', topics: ['sociedad'] },
  { id: 'eldiario-tecnologia', source: 'elDiario.es', url: 'https://www.eldiario.es/rss/tecnologia/', topics: ['tecnología'] },
  { id: 'xataka', source: 'Xataka', url: 'https://www.xataka.com/feedburner.xml', topics: ['tecnología'] },
  { id: 'bbc-mundo', source: 'BBC Mundo', url: 'https://feeds.bbci.co.uk/mundo/rss.xml', topics: [] },
  { id: 'eldiarioar', source: 'elDiarioAR', url: 'https://www.eldiarioar.com/rss/', topics: [] },
  { id: 'elsalto', source: 'El Salto', url: 'https://www.elsaltodiario.com/general/feed', topics: [] },
];
