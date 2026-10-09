import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, plain } from '../src/leer/rss.js';
import { syllables, inflesz, levelFor } from '../src/leer/level.js';
import { topicsFor } from '../src/leer/topics.js';
import { articlesFrom, merge, refresh, KEY } from '../src/leer/build.js';
import worker from '../src/worker.js';

const RSS = `<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>elDiario.es - Cultura</title>
<item><title><![CDATA[El grupo de punk gana en los tribunales]]></title><link>https://www.eldiario.es/cultura/punk_1.html</link>
<pubDate>Sun, 27 Sep 2026 10:00:00 +0200</pubDate><description><![CDATA[<p>El grupo gana. La historia &amp; la música.</p>]]></description>
<media:keywords>Punk, Punk español, Música</media:keywords></item>
<item><title>Sin enlace</title></item>
<item><title>Pontevedra y sus barrios sin coches</title><link>https://example.com/a</link><category>Urbanismo</category></item>
</channel></rss>`;

const ATOM = `<feed><entry><title>Una entrada</title><link rel="alternate" href="https://example.com/e"/><updated>2026-09-27T08:00:00Z</updated><summary>Texto</summary></entry></feed>`;

test('parseFeed reads RSS items, CDATA, entities and keywords, and skips items without a link', () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'El grupo de punk gana en los tribunales');
  assert.equal(items[0].text, 'El grupo gana. La historia & la música.');
  assert.deepEqual(items[0].tags, ['Punk', 'Punk español', 'Música']);
  assert.equal(items[0].date, '2026-09-27T08:00:00.000Z');
  assert.deepEqual(items[1].tags, ['Urbanismo']);
});

test('parseFeed reads Atom entries', () => {
  const [e] = parseFeed(ATOM);
  assert.equal(e.link, 'https://example.com/e');
  assert.equal(e.date, '2026-09-27T08:00:00.000Z');
});

test('plain strips tags and decodes entities', () => {
  assert.equal(plain('<b>Hola</b>&nbsp;&#241;u &#xe1;'), 'Hola ñu á');
});

test('syllables handles diphthongs and hiatus', () => {
  assert.equal(syllables('casa'), 2);
  assert.equal(syllables('ciudad'), 2);
  assert.equal(syllables('poeta'), 3);
  assert.equal(syllables('día'), 2);
  assert.equal(syllables('internacional'), 5);
});

test('short, plain sentences score easier than long, complex ones', () => {
  const easy = 'Hoy hace sol. Voy a la playa con mi hermano. Comemos pan y queso. Luego vamos a casa.';
  const hard = 'La implementación de las recomendaciones internacionales sobre sostenibilidad medioambiental, anunciada por las autoridades comunitarias, requiere modificaciones legislativas extraordinariamente complejas y costosas.';
  assert.ok(inflesz(easy) > inflesz(hard));
  assert.equal(levelFor(easy), 'facil');
  assert.equal(levelFor(hard), 'dificil');
  assert.equal(levelFor('Muy corto'), 'medio');
});

test('topicsFor uses the feed, tags and headline words', () => {
  assert.deepEqual(topicsFor({ title: 'El grupo de punk gana', tags: ['Punk', 'Música'] }, ['cultura']), ['cultura', 'música']);
  assert.deepEqual(topicsFor({ title: 'Pontevedra y sus barrios sin coches', tags: [] }, []), ['urbanismo']);
  assert.deepEqual(topicsFor({ title: 'Un departamento nuevo', tags: [] }, []), [], 'arte inside a word does not count');
});

test('merge removes duplicates, old articles, and puts the newest first', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  const a = (link, date, topics = []) => ({ title: link, link, source: 's', date, level: 'medio', topics });
  const out = merge(
    [a('x', '2026-09-28T08:00:00Z', ['cine']), a('old', '2026-09-20T08:00:00Z')],
    [a('x', '2026-09-28T08:00:00Z', ['cultura']), a('y', '2026-09-28T09:00:00Z')],
    now);
  assert.deepEqual(out.map((o) => o.link), ['y', 'x']);
  assert.deepEqual(out[1].topics, ['cine', 'cultura']);
});

function kv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
}
const feed = { id: 'f', source: 'Fuente', url: 'https://example.com/rss', topics: ['cultura'] };

test('refresh stores the articles of one feed', async () => {
  const store = kv();
  const now = new Date('2026-09-27T12:00:00Z');
  const r = await refresh(store, { now, feeds: [feed], fetchFn: async () => new Response(RSS) });
  assert.deepEqual(r, { feed: 'f', added: 2, total: 2 });
  const saved = JSON.parse(store.m.get(KEY));
  assert.equal(saved.articles[0].source, 'Fuente');
  assert.ok(saved.articles.every((x) => x.topics.includes('cultura')));
});

test('refresh keeps the old list when a feed fails', async () => {
  const store = kv();
  const now = new Date('2026-09-27T12:00:00Z');
  store.m.set(KEY, JSON.stringify({ updated: '', articles: articlesFrom(RSS, feed, now) }));
  const r = await refresh(store, { now, feeds: [feed], fetchFn: async () => new Response('no', { status: 500 }) });
  assert.equal(r.total, 2);
});

test('the Worker serves /api/leer and refreshes on a schedule', async () => {
  const store = kv();
  const env = { SIGNUPS: store, ASSETS: { fetch: async () => new Response('asset') } };
  const jobs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const empty = await worker.fetch(new Request('https://hecho.fyi/api/leer'), env, { waitUntil() {} });
    assert.deepEqual((await empty.json()).articles, []);
    assert.equal(empty.headers.get('cache-control'), 'no-store');
  } finally {
    globalThis.fetch = realFetch;
  }
  globalThis.fetch = async () => new Response(RSS);
  try {
    await worker.scheduled({}, env, { waitUntil: (p) => jobs.push(p) });
    await Promise.all(jobs);
  } finally {
    globalThis.fetch = realFetch;
  }
  const res = await worker.fetch(new Request('https://hecho.fyi/api/leer'), env, { waitUntil() {} });
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.ok((await res.json()).articles.length > 0);
});

test('the old Leer address goes to the section on the traduce page', async () => {
  const env = { SIGNUPS: kv(), ASSETS: { fetch: async () => new Response('asset') } };
  const res = await worker.fetch(new Request('https://hecho.fyi/traduce/leer/'), env, { waitUntil() {} });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://hecho.fyi/traduce/#leer');
});

test('an empty list is filled from every feed on the first request', async () => {
  const store = kv();
  const env = { SIGNUPS: store, ASSETS: { fetch: async () => new Response('asset') } };
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (u) => { asked.push(u); return new Response(RSS); };
  try {
    const res = await worker.fetch(new Request('https://hecho.fyi/api/leer'), env, { waitUntil() {} });
    assert.ok((await res.json()).articles.length > 0);
    assert.ok(asked.length > 1, 'reads more than one feed');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('refreshAll records which feeds worked, and caps each source', async () => {
  const { refreshAll, MAX_PER_SOURCE } = await import('../src/leer/build.js');
  const store = kv();
  const now = new Date('2026-09-27T12:00:00Z');
  const feeds = [{ ...feed, id: 'ok' }, { ...feed, id: 'bad', url: 'https://bad' }];
  await refreshAll(store, { now, feeds, fetchFn: async (u) => (u === 'https://bad' ? new Response('x', { status: 403 }) : new Response(RSS)) });
  const saved = JSON.parse(store.m.get(KEY));
  assert.equal(saved.feeds.ok.ok, true);
  assert.deepEqual([saved.feeds.bad.ok, saved.feeds.bad.error], [false, 'HTTP 403']);
  const many = Array.from({ length: 60 }, (_, i) => ({ title: 't', link: `l${i}`, source: 'A', date: '2026-09-27T10:00:00Z', level: 'medio', topics: [] }));
  assert.equal(merge([], many, now).length, MAX_PER_SOURCE);
});
