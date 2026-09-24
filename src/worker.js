// @ts-check
// Serves the static site from ./public and handles the Hecho+ sign-up form.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Support goes straight to Stripe. The link lives in wrangler.jsonc, so going live is one change.
    if (url.pathname === '/apoyar' || url.pathname === '/apoyar/') {
      return Response.redirect(env.STRIPE_URL, 302);
    }
    if (url.pathname === '/api/interes') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      return signup(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};

/**
 * Saves an email to KV and sends Saar a short alert.
 * Answers JSON to the page script, and redirects when the form is sent without JavaScript.
 * @param {Request} request @param {Env} env @param {ExecutionContext} ctx
 */
export async function signup(request, env, ctx) {
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  const reply = (/** @type {number} */ status, /** @type {Record<string, unknown>} */ body) =>
    wantsJson
      ? Response.json(body, { status })
      : status < 400
        ? Response.redirect(new URL('/plus/?ok=1', request.url).toString(), 303)
        : new Response(String(body.error), { status });

  /** @type {FormData} */
  let form;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: 'Please enter a valid email.' });
  }

  // Bots fill in the hidden field. Pretend it worked.
  if (String(form.get('web') || '')) return reply(200, { ok: true });

  const email = String(form.get('email') || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return reply(400, { error: 'Please enter a valid email.' });

  const key = `email:${email}`;
  const existing = await env.SIGNUPS.get(key);
  if (!existing) {
    const record = {
      email,
      at: new Date().toISOString(),
      country: /** @type {any} */ (request).cf?.country || '',
      lang: (request.headers.get('accept-language') || '').split(',')[0],
    };
    await env.SIGNUPS.put(key, JSON.stringify(record));
    ctx.waitUntil(notify(env, email));
  }
  return reply(200, { ok: true });
}

/** @param {Env} env @param {string} email */
async function notify(env, email) {
  if (!env.NOTIFY || !env.NOTIFY_TO) return;
  try {
    await env.NOTIFY.send({
      from: env.NOTIFY_FROM || 'hola@hecho.fyi',
      to: env.NOTIFY_TO,
      subject: `Hecho+: ${email}`,
      text: `${email} signed up for Hecho+ at ${new Date().toISOString()}.`,
    });
  } catch (err) {
    console.error('notify failed', err);
  }
}

/**
 * @typedef {{
 *   ASSETS: { fetch: (r: Request) => Promise<Response> },
 *   SIGNUPS: { get: (k: string) => Promise<string | null>, put: (k: string, v: string) => Promise<void> },
 *   NOTIFY?: { send: (m: { from: string, to: string, subject: string, text: string }) => Promise<unknown> },
 *   NOTIFY_TO?: string,
 *   NOTIFY_FROM?: string,
 *   STRIPE_URL: string,
 * }} Env
 * @typedef {{ waitUntil: (p: Promise<unknown>) => void }} ExecutionContext
 */
