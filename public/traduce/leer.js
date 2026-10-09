// Leer: real Spanish news, filtered by level and topic. The list comes from /api/leer.

const LEVELS = [
  { id: '', label: 'Todos' },
  { id: 'facil', label: 'Fácil' },
  { id: 'medio', label: 'Medio' },
  { id: 'dificil', label: 'Difícil' },
];
const LEVEL_LABEL = { facil: 'Fácil', medio: 'Medio', dificil: 'Difícil' };
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const SAVED = 'leer:filters';

const $ = (id) => document.getElementById(id);
let articles = [];
let state = load();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVED) || 'null');
    if (s && typeof s.level === 'string' && Array.isArray(s.topics)) return s;
  } catch { /* no storage */ }
  return { level: '', topics: [] };
}

function save() {
  try { localStorage.setItem(SAVED, JSON.stringify(state)); } catch { /* no storage */ }
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  e.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

function age(iso, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 60) return `hace ${Math.max(1, mins)} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'ayer' : `hace ${days} días`;
}

function chip(label, pressed, onclick) {
  return el('button', { type: 'button', class: 'chip', 'aria-pressed': String(pressed), onclick }, label);
}

function visible() {
  return articles.filter((a) =>
    (!state.level || a.level === state.level) &&
    (!state.topics.length || a.topics.some((t) => state.topics.includes(t))));
}

function render() {
  $('levels').replaceChildren(...LEVELS.map((l) =>
    chip(l.label, state.level === l.id, () => { state.level = l.id; save(); render(); })));

  // Only topics that have articles today, most common first.
  const counts = new Map();
  for (const a of articles) for (const t of a.topics) counts.set(t, (counts.get(t) || 0) + 1);
  const topics = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b, 'es'));
  state.topics = state.topics.filter((t) => counts.has(t));
  $('topics').replaceChildren(...topics.map((t) =>
    chip(t, state.topics.includes(t), () => {
      state.topics = state.topics.includes(t) ? state.topics.filter((x) => x !== t) : [...state.topics, t];
      save();
      render();
    })));

  const list = visible();
  $('articles').replaceChildren(...list.map((a) =>
    el('li', {},
      el('a', { class: 'article', href: a.link, target: '_blank', rel: 'noopener' },
        el('span', { class: 'article-meta' },
          el('span', { class: 'article-topic' }, a.topics[0] || ''),
          el('span', { class: 'article-level' }, LEVEL_LABEL[a.level] || '')),
        el('span', { class: 'article-text' },
          el('span', { class: 'article-title', lang: 'es' }, a.title),
          el('span', { class: 'article-source' }, `${a.source} · ${age(a.date)}`)),
        el('span', { class: 'article-open', 'aria-hidden': 'true' }, '↗')))));
  const empty = $('empty');
  empty.hidden = list.length > 0;
  empty.textContent = articles.length ? 'Nada con estos filtros.' : 'Todavía no hay artículos.';
}

function header() {
  const d = new Date();
  $('leer-date').textContent = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${articles.length} artículos`;
}

async function start() {
  try {
    const res = await fetch('/api/leer');
    const data = await res.json();
    articles = Array.isArray(data.articles) ? data.articles : [];
  } catch {
    articles = [];
  }
  header();
  render();
}

// Two tabs: Leer and Set up. The tab is in the address, so each has its own link.
// A link to anything inside Set up (for example #set-up-steps) opens that tab.
function showTab() {
  const hash = decodeURIComponent(location.hash.slice(1));
  const setup = $('set-up');
  const target = hash ? document.getElementById(hash) : null;
  const tab = target && setup.contains(target) ? 'set-up' : 'leer';
  $('leer').hidden = tab !== 'leer';
  setup.hidden = tab !== 'set-up';
  for (const a of document.querySelectorAll('.tab')) a.toggleAttribute('aria-current', a.dataset.tab === tab);
  for (const a of document.querySelectorAll('.tab[aria-current]')) a.setAttribute('aria-current', 'page');
}

for (const a of document.querySelectorAll('.tab')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    history.replaceState(null, '', `#${a.dataset.tab}`);
    showTab();
  });
}
window.addEventListener('hashchange', showTab);
showTab();
start();
