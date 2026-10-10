import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const topics = JSON.parse(readFileSync(new URL('../public/app/gramatica/topics.json', import.meta.url), 'utf8'));

const FIELDS = ['id', 'title_es', 'title_en', 'level', 'summary', 'pcic', 'verbos', 'order', 'status'];
const LEVELS = ['facil', 'medio', 'dificil'];
// Every topic starts as planned. The content issues move a topic to review, then ready.
const STATUSES = ['planned', 'review', 'ready'];

// Section numbers of the grammar inventory in the Instituto Cervantes Plan curricular.
// For each top section, the list gives how many third-level sections each second-level one has.
function sections(top, subs = []) {
  return [top, ...subs.flatMap((count, i) => {
    const sub = `${top}.${i + 1}`;
    return [sub, ...Array.from({ length: count }, (_, j) => `${sub}.${j + 1}`)];
  })];
}
const PCIC = new Set([
  ...sections('1', [2, 0, 0]),
  ...sections('2', [3, 0, 0, 0, 0, 0]),
  ...sections('3', [0, 0, 0]),
  ...sections('4'),
  ...sections('5'),
  ...sections('6', [0, 0, 0]),
  ...sections('7', [6, 0, 0, 0]),
  ...sections('8', [0, 0, 0, 0, 0, 0, 0, 0, 0]),
  ...sections('9', [10, 4, 0, 3]),
  ...sections('10', [0, 0, 0, 0, 0]),
  ...sections('11', [0, 0]),
  ...sections('12', [0, 6]),
  ...sections('13', [0, 0, 0]),
  ...sections('14', [0, 0, 0, 0]),
  ...sections('15', [2, 0, 9]),
]);

const text = (value) => typeof value === 'string' && value.length > 0 && value.trim() === value;

test('topics.json is a list of topics', () => {
  assert.ok(Array.isArray(topics));
  assert.ok(topics.length > 0);
});

test('every topic has every field with a valid value', () => {
  for (const t of topics) {
    const name = t.id ?? JSON.stringify(t);
    assert.deepEqual(Object.keys(t).sort(), [...FIELDS].sort(), `${name}: fields`);
    assert.match(t.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${name}: id is not kebab-case`);
    assert.ok(text(t.title_es), `${name}: title_es`);
    assert.ok(text(t.title_en), `${name}: title_en`);
    assert.ok(LEVELS.includes(t.level), `${name}: level ${t.level}`);
    assert.ok(text(t.summary), `${name}: summary`);
    assert.match(t.summary, /^\p{Lu}.*\.$/u, `${name}: summary starts with a capital and ends with a full stop`);
    assert.doesNotMatch(t.summary, /[.!?]\s/, `${name}: summary is one sentence`);
    assert.ok(PCIC.has(t.pcic), `${name}: pcic ${t.pcic} is not a section of the grammar inventory`);
    assert.ok(Array.isArray(t.verbos), `${name}: verbos is a list`);
    for (const [i, level] of t.verbos.entries()) {
      assert.ok(Number.isInteger(level) && level >= 1 && level <= 21, `${name}: verbos level ${level}`);
      if (i > 0) assert.ok(level > t.verbos[i - 1], `${name}: verbos levels are in order, without repeats`);
    }
    assert.ok(Number.isInteger(t.order) && t.order >= 1, `${name}: order ${t.order}`);
    assert.ok(STATUSES.includes(t.status), `${name}: status ${t.status}`);
  }
});

test('ids are unique', () => {
  const seen = new Set();
  for (const { id } of topics) {
    assert.ok(!seen.has(id), `duplicate id ${id}`);
    seen.add(id);
  }
});

test('order runs from 1 with no gaps or repeats within each level', () => {
  for (const level of LEVELS) {
    const orders = topics.filter((t) => t.level === level).map((t) => t.order).sort((a, b) => a - b);
    assert.ok(orders.length > 0, `${level} has no topics`);
    assert.deepEqual(orders, orders.map((_, i) => i + 1), `${level}: order`);
  }
});

test('por and para, and the object pronouns, have topics', () => {
  const ids = new Set(topics.map((t) => t.id));
  assert.ok(ids.has('por-y-para'), 'por y para');
  assert.ok(ids.has('lo-la-le'), 'lo, la y le');
});
