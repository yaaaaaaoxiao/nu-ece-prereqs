// App entry: loads a map, owns the state, keeps the URL in sync and wires the
// graph, list, panel, search and toolbar together.
import { CourseMap, fetchJSON } from './model.js';
import { GraphView } from './graph.js';
import { renderPanel, aboutHTML, esc } from './panel.js';
import { renderList } from './list.js';
import { Search } from './search.js';
import { prefs } from './store.js';

// GitHub "owner/repo" for "Report a problem" links. Detected automatically on
// GitHub Pages (owner.github.io/repo); set it here if you use a custom domain.
const REPO = '';

// On narrow screens the details panel is a bottom sheet; collapsed, it shows
// only this much of its top (the course title).
const SHEET_PEEK = 104;
const narrow = window.matchMedia('(max-width: 760px)');

const $ = sel => document.querySelector(sel);
const els = {
  mapName: $('#map-name'),
  mapPicker: $('#map-picker'),
  mapSelect: $('#map-select'),
  search: $('#search'),
  results: $('#search-results'),
  highlight: $('#highlight'),
  showExternal: $('#show-external'),
  planner: $('#planner'),
  viewButtons: document.querySelectorAll('[data-view]'),
  stage: $('#stage'),
  graph: $('#graph'),
  list: $('#list'),
  status: $('#stage-status'),
  panel: $('#panel'),
  announcer: $('#announcer'),
  help: $('#help'),
  helpData: $('#help-data'),
  themeBtn: $('#theme-btn'),
};

const state = {
  map: null,
  selected: null,
  highlight: '',
  view: 'graph',
  query: '',
  showExternal: prefs.get('showExternal', true),
  showLinks: prefs.get('showLinks', false),
  taken: new Set(prefs.get('taken', [])),
};
let maps = [];

// The graph needs d3 from the CDN; without it the list still works.
const graph = window.d3 ? new GraphView(els.graph, { onSelect: (id, opts) => select(id, opts) }) : null;
graph?.setShowLinks(state.showLinks);
$('#show-links').checked = state.showLinks;

const search = new Search(els.search, els.results, {
  find: q => (state.map ? state.map.search(q, 8) : []),
  describe: optionHTML,
  onPick: id => select(id, { source: 'search' }),
  onQuery: q => {
    state.query = q;
    if (state.view === 'list' && state.map) renderList(els.list, { map: state.map, state, query: q });
  },
});

// ---------------------------------------------------------------- loading

async function init() {
  syncThemeButton();
  if (!graph) {
    document.querySelector('[data-view="graph"]').disabled = true;
    announce('The graph library could not be loaded, so courses are shown as a list.');
  }
  setStatus('Loading course data…');
  try {
    maps = (await fetchJSON('data/maps.json')).maps;
    if (!maps.length) throw new Error('data/maps.json lists no maps.');
    els.mapSelect.innerHTML = maps.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    els.mapPicker.hidden = maps.length < 2;
    await openMap(readURL());
  } catch (err) {
    console.error(err);
    setStatus(`<div class="error"><p><b>Couldn't load the course data.</b></p><p>${esc(err.message)}</p>
      <button type="button" class="btn" data-action="reload">Try again</button></div>`);
  }
}

async function openMap(params) {
  const entry = maps.find(m => m.id === params.map) || maps[0];
  const fresh = !state.map || state.map.id !== entry.id;
  if (fresh) {
    setStatus('Loading course data…');
    state.map = new CourseMap(await fetchJSON(`data/${entry.file}`));
    els.mapSelect.value = entry.id;
    els.mapName.textContent = state.map.name;
    els.helpData.innerHTML = aboutHTML(state.map);
    fillHighlightSelect();
  }
  const map = state.map;
  state.selected = params.course && map.get(params.course) ? params.course : null;
  state.highlight = params.hl && map.highlight(params.hl) ? params.hl : '';
  state.view = params.view === 'list' || !graph ? 'list' : 'graph';
  setStatus('');
  if (fresh && graph) {
    graph.setData(map, visibleIds());
    syncInsets();
    graph.fitAll({ animate: false, minScale: 0.45 });
  }
  render({ history: 'replace' });
  if (state.selected) revealSelected({ animate: !fresh });
}

// Frame the selected course in the part of the graph that nothing covers
// (on phones: below the floating controls, above the bottom sheet).
function revealSelected({ force = true, animate = true } = {}) {
  if (!graph || state.view !== 'graph' || !state.selected) return;
  syncInsets();
  graph.reveal(state.selected, { force, animate });
}

function syncInsets() {
  const sheet = els.panel;
  let bottom = 0;
  if (narrow.matches && sheet.classList.contains('is-open')) {
    bottom = sheet.classList.contains('is-collapsed') ? SHEET_PEEK : sheet.offsetHeight;
  }
  graph?.setInsets({ top: narrow.matches ? 52 : 0, bottom });
}

function readURL() {
  const p = new URLSearchParams(location.search);
  return { map: p.get('map'), course: p.get('course'), hl: p.get('hl'), view: p.get('view') };
}

function writeURL(mode) {
  if (mode === 'none') return;
  const p = new URLSearchParams();
  if (state.map.id !== maps[0].id) p.set('map', state.map.id);
  if (state.selected) p.set('course', state.selected);
  if (state.highlight) p.set('hl', state.highlight);
  if (state.view === 'list') p.set('view', 'list');
  const qs = p.toString();
  const url = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  if (url === location.pathname + location.search + location.hash) return;
  history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
}

const visibleIds = () => new Set(state.map.courses
  .filter(c => c.role === 'main' || state.showExternal).map(c => c.id));

// -------------------------------------------------------------- rendering

function render({ history: mode = 'replace' } = {}) {
  const { map } = state;
  if (!map) return;
  keepFocus(() => {
    graph?.update(state);
    renderPanel(els.panel, { map, state, repo: repoSlug() });
    if (state.view === 'list') renderList(els.list, { map, state, query: state.query });
    renderPlanner();
  });
  // On phones the panel is a bottom sheet; open it only for a course so a
  // highlight stays visible on the graph.
  els.panel.classList.toggle('is-open', !!state.selected);
  syncControls();
  writeURL(mode);
}

// Re-rendering replaces buttons; put keyboard focus back on the equivalent one.
function keepFocus(fn) {
  const active = document.activeElement;
  const key = active?.dataset && ['action', 'select', 'highlight'].find(k => active.dataset[k]);
  const selector = key && `[data-${key}="${CSS.escape(active.dataset[key])}"]${
    active.dataset.id ? `[data-id="${CSS.escape(active.dataset.id)}"]` : ''}`;
  const container = active?.closest('#panel, #list, #planner');
  fn();
  if (selector && container && !container.contains(active)) container.querySelector(selector)?.focus();
}

function syncControls() {
  const list = state.view === 'list';
  els.highlight.value = state.highlight;
  els.highlight.classList.toggle('is-active', !!state.highlight);
  els.showExternal.checked = state.showExternal;
  els.stage.classList.toggle('is-list', list);
  els.list.hidden = !list;
  els.viewButtons.forEach(b => b.setAttribute('aria-checked', String(b.dataset.view === state.view)));
  search.setDropdown(!list);
  els.search.placeholder = list ? 'Filter the list by number or title' : 'Search courses, e.g. EE 221 or signals';
}

function fillHighlightSelect() {
  const groups = new Map();
  for (const h of state.map.highlights) {
    if (!groups.has(h.group)) groups.set(h.group, []);
    groups.get(h.group).push(h);
  }
  els.highlight.innerHTML = '<option value="">None</option>' + [...groups].map(([group, items]) =>
    `<optgroup label="${esc(group)}">${items.map(h =>
      `<option value="${esc(h.key)}">${esc(h.label)} (${h.ids.size})</option>`).join('')}</optgroup>`).join('');
}

function renderPlanner() {
  const { map, taken } = state;
  const mine = [...taken].filter(id => map.get(id));
  if (!mine.length) {
    els.planner.innerHTML = '<span class="muted">Mark courses you\'ve taken to see what you can take next.</span>';
    return;
  }
  const open = map.courses.filter(c => map.status(c, taken) === 'available').length;
  els.planner.innerHTML = `<span><b>${mine.length}</b> taken · <span class="dot" aria-hidden="true"></span>
    <b>${open}</b> can take now</span>
    <button type="button" class="link-btn" data-action="clear-taken">Clear</button>`;
}

function optionHTML(c) {
  const map = state.map;
  const taken = state.taken.has(c.id) ? ' · taken' : '';
  return `<span class="r-code">${esc(map.label(c))}</span>
    <span class="r-title">${esc(c.title || 'Not in the current catalog')}</span>
    <span class="r-meta">${esc(map.deptName(c))}${taken}</span>`;
}

function setStatus(html) {
  els.status.innerHTML = html;
}

function announce(message) {
  els.announcer.textContent = '';
  requestAnimationFrame(() => { els.announcer.textContent = message; });
}

function repoSlug() {
  if (REPO) return REPO;
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return '';
  const first = location.pathname.split('/').filter(Boolean)[0];
  return `${host.replace(/\.github\.io$/, '')}/${first && !first.includes('.') ? first : host}`;
}

// ----------------------------------------------------------------- actions

function select(id, { source = 'panel' } = {}) {
  const map = state.map;
  if (!map || (id && !map.get(id))) return;
  // Clicking (or pressing Enter on) the selected course again deselects it.
  if (id && id === state.selected && (source === 'graph' || source === 'keyboard')) id = null;
  if (id !== state.selected) {
    state.selected = id;
    // On phones, tapping the graph opens the sheet as a peek so the chain stays
    // in view; choosing from search or the list opens it fully.
    els.panel.classList.toggle('is-collapsed', source === 'graph' || source === 'keyboard');
    render({ history: 'push' });
  }
  if (!id) return;
  revealSelected({ force: source !== 'graph' && source !== 'keyboard' });
  const c = map.get(id);
  announce(`${map.label(c)}, ${c.title}. Details are in the side panel.`);
  if (source === 'search') els.panel.focus({ preventScroll: true });
}

function toggleTaken(id) {
  const c = state.map.get(id);
  if (state.taken.has(id)) state.taken.delete(id);
  else state.taken.add(id);
  prefs.set('taken', [...state.taken]);
  render();
  announce(`${state.map.label(c)} ${state.taken.has(id) ? 'marked as taken' : 'no longer marked as taken'}.`);
}

function clearTaken() {
  const mine = [...state.taken].filter(id => state.map.get(id));
  if (!mine.length || !window.confirm(`Clear the ${mine.length} course${mine.length === 1 ? '' : 's'} you marked as taken?`)) return;
  mine.forEach(id => state.taken.delete(id));
  prefs.set('taken', [...state.taken]);
  render();
}

function setHighlight(key) {
  state.highlight = key;
  render({ history: 'push' });
  const hl = state.map.highlight(key);
  if (!hl) return;
  announce(`Highlighting ${hl.ids.size} courses: ${hl.label}.`);
  if (state.view === 'graph' && !state.selected) {
    syncInsets();
    graph.showIds(hl.ids);
  }
}

function setView(view) {
  if (view === state.view || (view === 'graph' && !graph)) return;
  state.view = view;
  render({ history: 'replace' });
  if (view === 'graph') graph.refit();
  revealSelected({ animate: false });
}

function toggleSheet() {
  els.panel.classList.toggle('is-collapsed');
  revealSelected();
}

function setShowExternal(on) {
  state.showExternal = on;
  prefs.set('showExternal', on);
  graph?.setData(state.map, visibleIds(), { animate: true });
  render();
}

function zoom(kind) {
  if (!graph || state.view !== 'graph') return;
  syncInsets();
  if (kind === 'in') graph.zoomBy(1.3);
  else if (kind === 'out') graph.zoomBy(1 / 1.3);
  else graph.fitAll();
}

// ------------------------------------------------------------------- theme

function effectiveTheme() {
  return document.documentElement.dataset.theme
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function syncThemeButton() {
  const dark = effectiveTheme() === 'dark';
  els.themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  els.themeBtn.querySelector('.i-moon').style.display = dark ? 'none' : '';
  els.themeBtn.querySelector('.i-sun').style.display = dark ? '' : 'none';
}

// ------------------------------------------------------------------ events

document.addEventListener('click', e => {
  // Tapping a collapsed sheet (anywhere but its buttons) expands it.
  if (narrow.matches && els.panel.classList.contains('is-collapsed') && e.target.closest('#panel')
      && !e.target.closest('[data-action="close"], [data-action="toggle-sheet"]')) {
    toggleSheet();
    return;
  }
  const t = e.target.closest('[data-select], [data-action], [data-highlight], [data-zoom], [data-view]');
  if (!t || t.disabled) return;
  if (t.dataset.select) select(t.dataset.select, { source: t.closest('#list') ? 'list' : 'panel' });
  else if (t.dataset.highlight) setHighlight(state.highlight === t.dataset.highlight ? '' : t.dataset.highlight);
  else if (t.dataset.zoom) zoom(t.dataset.zoom);
  else if (t.dataset.view) setView(t.dataset.view);
  else if (t.dataset.action === 'close') select(null);
  else if (t.dataset.action === 'toggle-taken' && t.type !== 'checkbox') toggleTaken(t.dataset.id);
  else if (t.dataset.action === 'clear-taken') clearTaken();
  else if (t.dataset.action === 'clear-highlight') setHighlight('');
  else if (t.dataset.action === 'toggle-sheet') toggleSheet();
  else if (t.dataset.action === 'reload') window.location.reload();
});

els.list.addEventListener('change', e => {
  if (e.target.matches('input[data-action="toggle-taken"]')) toggleTaken(e.target.dataset.id);
});
els.highlight.addEventListener('change', () => setHighlight(els.highlight.value));
$('#show-links').addEventListener('change', e => {
  state.showLinks = e.target.checked;
  prefs.set('showLinks', state.showLinks);
  graph?.setShowLinks(state.showLinks);
});
// The layout picks column counts to suit the stage's shape.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.view === 'graph' && graph?.refit()) revealSelected({ force: false });
  }, 250);
});
els.showExternal.addEventListener('change', () => setShowExternal(els.showExternal.checked));
els.mapSelect.addEventListener('change', () => {
  openMap({ map: els.mapSelect.value }).then(() => writeURL('push'));
});
$('#help-btn').addEventListener('click', () => els.help.showModal());
els.help.addEventListener('click', e => { if (e.target === els.help) els.help.close(); });
els.themeBtn.addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  prefs.set('theme', next);
  syncThemeButton();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeButton);
window.addEventListener('popstate', () => openMap(readURL()));
// Focusing an off-screen node must never scroll the stage itself.
els.stage.addEventListener('scroll', () => { els.stage.scrollTop = 0; els.stage.scrollLeft = 0; });

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || els.help.open) return;
  const typing = e.target.matches('input, select, textarea') || e.target.isContentEditable;
  if (e.key === '/' && !typing) {
    e.preventDefault();
    els.search.focus();
  } else if (e.key === 'Escape' && (state.selected || state.highlight)) {
    // Step back one level: the selected course first, then the highlight.
    if (state.selected) select(null);
    else setHighlight('');
  } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === '+' || e.key === '=') zoom('in');
    else if (e.key === '-' || e.key === '_') zoom('out');
    else if (e.key === '0') zoom('fit');
  }
});

init();
