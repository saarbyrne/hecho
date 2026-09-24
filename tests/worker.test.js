import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

function env() {
  const store = new Map();
  const sent = [];
  return {
    store, sent,
    ASSETS: { fetch: async () => new Response('asset') },
    SIGNUPS: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } },
    NOTIFY: { send: async (m) => { sent.push(m); } },
    NOTIFY_TO: 'me@example.com',
    STRIPE_URL: 'https://buy.stripe.com/x',
  };
}
const ctx = () => { const jobs = []; return { jobs, waitUntil: (p) => jobs.push(p) }; };
const post = (fields, json = true) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request('https://hecho.fyi/api/interes', { method: 'POST', body, headers: json ? { accept: 'application/json' } : {} });
};

test('saves a new email and sends one alert', async () => {
  const e = env(); const c = ctx();
  const res = await worker.fetch(post({ email: ' Ana@Example.com ' }), e, c);
  assert.equal(res.status, 200);
  await Promise.all(c.jobs);
  assert.ok(e.store.has('email:ana@example.com'));
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].to, 'me@example.com');
});

test('a repeat email is not saved or alerted twice', async () => {
  const e = env();
  await worker.fetch(post({ email: 'a@b.co' }), e, ctx());
  const c = ctx();
  await worker.fetch(post({ email: 'a@b.co' }), e, c);
  await Promise.all(c.jobs);
  assert.equal(e.store.size, 1);
  assert.equal(e.sent.length, 1);
});

test('rejects a bad email', async () => {
  const e = env();
  const res = await worker.fetch(post({ email: 'nope' }), e, ctx());
  assert.equal(res.status, 400);
  assert.equal(e.store.size, 0);
});

test('ignores bots that fill the hidden field', async () => {
  const e = env();
  const res = await worker.fetch(post({ email: 'a@b.co', web: 'spam' }), e, ctx());
  assert.equal(res.status, 200);
  assert.equal(e.store.size, 0);
});

test('redirects when sent without JavaScript', async () => {
  const res = await worker.fetch(post({ email: 'x@y.es' }, false), env(), ctx());
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://hecho.fyi/plus/?ok=1');
});

test('works without the email binding', async () => {
  const e = env(); delete e.NOTIFY;
  const c = ctx();
  const res = await worker.fetch(post({ email: 'x@y.es' }), e, c);
  await Promise.all(c.jobs);
  assert.equal(res.status, 200);
});

test('other paths go to the static site', async () => {
  const res = await worker.fetch(new Request('https://hecho.fyi/'), env(), ctx());
  assert.equal(await res.text(), 'asset');
});

test('support goes straight to Stripe', async () => {
  for (const path of ['/apoyar', '/apoyar/']) {
    const res = await worker.fetch(new Request('https://hecho.fyi' + path), env(), ctx());
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://buy.stripe.com/x');
  }
});
