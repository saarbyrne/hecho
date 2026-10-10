// @ts-check
/** Builds and stores the Leer article list. Runs on a schedule in the Worker. */
import { FEEDS } from './feeds.js';
import { parseFeed } from './rss.js';
import { levelFor } from './level.js';
import { topicsFor } from './topics.js';

export const KEY = 'leer:articles';
/** Articles older than this leave the list. */
export const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_ARTICLES = 200;
/** No source takes more than this many places, so one outlet can't fill the list. */
export const MAX_PER_SOURCE = 40;
const UA = 'Mozilla/5.0 (compatible; hechoLeer/1.0; +https://hecho.fyi/traduce/)';

/**
 * @typedef {object} Article
 * @property {string} title
 * @property {string} link
 * @property {string} source
 * @property {string} date
 * @property {'facil'|'medio'|'dificil'} level
 * @property {string[]} topics
 */

/**
 * @typedef {{ ok: boolean, count: number, at: string, error?: string }} FeedStatus
 * @typedef {{ updated: string, articles: Article[], feeds?: Record<string, FeedStatus> }} ArticleList
 * @typedef {{ get: (k: string) => Promise<string | null>, put: (k: string, v: string) => Promise<void> }} KV
 */

/**
 * Turns one feed's XML into articles.
 * @param {string} xml
 * @param {typeof FEEDS[number]} feed
 * @param {Date} now
 * @returns {Article[]}
 */
export function articlesFrom(xml, feed, now) {
  return parseFeed(xml).map((item) => ({
    title: item.title,
    link: item.link,
    source: feed.source,
    date: item.date || now.toISOString(),
    level: levelFor(`${item.title}. ${item.text}`),
    topics: topicsFor(item, feed.topics),
  }));
}

/**
 * Adds new articles to the list. The same link keeps its first entry, but gains any new topics.
 * Old articles drop off, and the newest come first.
 * @param {Article[]} list @param {Article[]} fresh @param {Date} now
 * @returns {Article[]}
 */
export function merge(list, fresh, now) {
  /** @type {Map<string, Article>} */
  const byLink = new Map(list.map((a) => [a.link, a]));
  for (const a of fresh) {
    const had = byLink.get(a.link);
    if (had) had.topics = [...new Set([...had.topics, ...a.topics])].slice(0, 3);
    else byLink.set(a.link, a);
  }
  const cutoff = now.getTime() - MAX_AGE_MS;
  /** @type {Map<string, number>} */
  const perSource = new Map();
  return [...byLink.values()]
    .filter((a) => Date.parse(a.date) >= cutoff)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .filter((a) => {
      const n = (perSource.get(a.source) ?? 0) + 1;
      perSource.set(a.source, n);
      return n <= MAX_PER_SOURCE;
    })
    .slice(0, MAX_ARTICLES);
}

/**
 * Fetches one feed. Never throws: a failed feed gives no articles and a status with the error.
 * @param {typeof FEEDS[number]} feed @param {Date} now @param {typeof fetch} fetchFn
 * @returns {Promise<{ articles: Article[], status: FeedStatus }>}
 */
async function readFeed(feed, now, fetchFn) {
  const at = now.toISOString();
  try {
    const res = await fetchFn(feed.url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml, */*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const articles = articlesFrom(await res.text(), feed, now);
    return { articles, status: { ok: true, count: articles.length, at } };
  } catch (err) {
    const error = String(/** @type {Error} */ (err)?.message ?? err);
    console.error(`leer: ${feed.id} failed`, error);
    return { articles: [], status: { ok: false, count: 0, at, error } };
  }
}

/**
 * Reads every feed at once. Used when the list is empty, for example just after a deploy.
 * @param {KV} kv
 * @param {{ now?: Date, fetchFn?: typeof fetch, feeds?: typeof FEEDS }} [opts]
 */
export async function refreshAll(kv, { now = new Date(), fetchFn = fetch, feeds = FEEDS } = {}) {
  const results = await Promise.all(feeds.map((feed) => readFeed(feed, now, fetchFn)));
  /** @type {ArticleList} */
  const stored = JSON.parse((await kv.get(KEY)) ?? 'null') ?? { updated: '', articles: [] };
  const articles = merge(stored.articles, results.flatMap((r) => r.articles), now);
  // Every feed in the list was just read, so a feed taken out of the list leaves the report.
  const status = Object.fromEntries(feeds.map((f, i) => [f.id, results[i].status]));
  await kv.put(KEY, JSON.stringify({ updated: now.toISOString(), articles, feeds: status }));
  return { total: articles.length };
}

/**
 * Refreshes one feed per run, in turn, so each run stays small.
 * @param {KV} kv
 * @param {{ now?: Date, fetchFn?: typeof fetch, feeds?: typeof FEEDS }} [opts]
 */
export async function refresh(kv, { now = new Date(), fetchFn = fetch, feeds = FEEDS } = {}) {
  const feed = feeds[Math.floor(now.getTime() / (15 * 60 * 1000)) % feeds.length];
  /** @type {ArticleList} */
  const stored = JSON.parse((await kv.get(KEY)) ?? 'null') ?? { updated: '', articles: [] };
  const { articles: fresh, status } = await readFeed(feed, now, fetchFn);
  const articles = merge(stored.articles, fresh, now);
  await kv.put(KEY, JSON.stringify({ updated: now.toISOString(), articles, feeds: { ...listed(stored.feeds, feeds), [feed.id]: status } }));
  return { feed: feed.id, added: fresh.length, total: articles.length };
}

/**
 * The saved statuses of the feeds still in the list. A feed taken out of the list leaves the report.
 * @param {Record<string, FeedStatus> | undefined} saved @param {typeof FEEDS} feeds
 * @returns {Record<string, FeedStatus>}
 */
function listed(saved, feeds) {
  const old = saved ?? {};
  return Object.fromEntries(feeds.filter((f) => old[f.id]).map((f) => [f.id, old[f.id]]));
}
