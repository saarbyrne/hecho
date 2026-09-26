import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC = new URL('../public/', import.meta.url).pathname;
// Paths the Worker answers itself, not files in public/.
const WORKER_PATHS = new Set(['/apoyar/', '/api/interes']);

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return htmlFiles(full);
    return name.endsWith('.html') ? [full] : [];
  });
}

const pages = htmlFiles(PUBLIC);

test('every page exists', () => {
  for (const p of ['index.html', 'charla/index.html', 'traduce/index.html', 'verbos/index.html', 'plus/index.html', 'privacidad/index.html', '404.html']) {
    assert.ok(existsSync(join(PUBLIC, p)), p);
  }
});

test('internal links point to a file or a Worker path', () => {
  for (const file of pages) {
    const html = readFileSync(file, 'utf8');
    for (const [, url] of html.matchAll(/(?:href|src|action)="(\/[^"#?]*)/g)) {
      if (WORKER_PATHS.has(url)) continue;
      const target = url.endsWith('/') ? join(PUBLIC, url, 'index.html') : join(PUBLIC, url);
      assert.ok(existsSync(target), `${file.replace(PUBLIC, '')} links to missing ${url}`);
    }
  }
});

test('in-page anchors have a matching id', () => {
  for (const file of pages) {
    const html = readFileSync(file, 'utf8');
    for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) {
      assert.ok(html.includes(`id="${id}"`), `${file.replace(PUBLIC, '')} is missing #${id}`);
    }
  }
});
