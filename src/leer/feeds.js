// @ts-check
/**
 * Real news feeds for Leer. All free to read.
 * `topics` are given to every article in the feed. Keywords and categories add more (see topics.js).
 * elDiario.es, Xataka, Infobae and El Salto were checked on 28 Sep 2026. BBC Mundo is its long-standing public feed.
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
  { id: 'infobae', source: 'Infobae', url: 'https://www.infobae.com/arc/outboundfeeds/rss/', topics: [] },
  { id: 'elsalto', source: 'El Salto', url: 'https://www.elsaltodiario.com/general/feed', topics: [] },
];
