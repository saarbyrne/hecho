// @ts-check
/** A small RSS and Atom reader. Workers have no DOMParser, so this uses patterns. */

/**
 * @typedef {object} FeedItem
 * @property {string} title
 * @property {string} link
 * @property {string} date      ISO date, or '' when the feed has none
 * @property {string} text      plain text of the summary, cut short
 * @property {string[]} tags    the feed's own categories and keywords
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** @param {string} s */
export function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[/** @type {keyof typeof ENTITIES} */ (n.toLowerCase())] ?? m);
}

/** @param {string} html */
export function plain(html) {
  return decode(decode(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** @param {string} xml @param {string} tag */
function first(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
}

/** @param {string} xml @param {string} tag */
function all(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => decode(m[1]).trim());
}

/** @param {string} s */
function isoDate(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

/**
 * @param {string} xml
 * @param {number} [max]
 * @returns {FeedItem[]}
 */
export function parseFeed(xml, max = 30) {
  const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].slice(0, max).map((m) => m[0]);
  return blocks.map((b) => {
    const atomLink = b.match(/<link[^>]*href="([^"]+)"/i);
    const link = first(b, 'link') || (atomLink ? decode(atomLink[1]) : '');
    const tags = [
      ...all(b, 'category'),
      ...all(b, 'dc:subject'),
      ...all(b, 'media:keywords').flatMap((k) => k.split(',')),
    ].map((t) => plain(t)).filter(Boolean);
    const summary = first(b, 'description') || first(b, 'summary') || first(b, 'content');
    return {
      title: plain(first(b, 'title')),
      link: link.trim(),
      date: isoDate(first(b, 'pubDate') || first(b, 'dc:date') || first(b, 'published') || first(b, 'updated')),
      text: plain(summary).slice(0, 600),
      tags,
    };
  }).filter((i) => i.title && /^https?:\/\//.test(i.link));
}
