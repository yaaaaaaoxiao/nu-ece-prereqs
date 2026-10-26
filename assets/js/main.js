// App entry: loads a map, owns the state, keeps the URL in sync and wires the
// graph, list, plan, panel, search and toolbar together.
import { CourseMap, fetchJSON } from './model.js';
import { GraphView } from './graph.js';
import { renderPanel, aboutHTML, esc, statusIcon } from './panel.js';
import { renderList } from './list.js';
import { renderPlanView } from './planview.js';
import { Plan, currentTerm, termLabel, termOrder } from './plan.js';
import { pathFor } from './path.js';
import { Search } from './search.js';
import { prefs } from './store.js';

// GitHub "owner/repo" for "Report a problem" links. Detected automatically on
// GitHub Pages (owner.github.io/repo); set it here if you use a custom domain.
const REPO = '';

// On narrow screens the details panel is a bottom sheet; collapsed, it shows
// only this much of its top (the course title).
const SHEET_PEEK = 104;
const SHEET_PEEK_PICKING = 116; // the header plus the row of buttons
const narrow = window.matchMedia('(max-width: 760px)');
const touch = window.matchMedia('(pointer: coarse)');
const VIEWS = ['graph', 'list', 'plan'];
const TOAST_MS = 6000;

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
  viewButtons: document.querySelectorAll('.segmented [data-view]'),
  stage: $('#stage'),
  graph: $('#graph'),
  list: $('#list'),
  planView: $('#plan'),
  status: $('#stage-status'),
  panel: $('#panel'),
  announcer: $('#announcer'),
  help: $('#help'),
  helpData: $('#help-data'),
  themeBtn: $('#theme-btn'),
  toast: $('#toast'),
};

const state = {
  map: null,
  selected: null,
  highlight: '',
  view: 'graph',
  query: '',
  addTerm: null, // set while the search box adds a course to a quarter
  // Several courses selected at once (Shift-click, Shift-drag, long press or
  // "Mark courses") to mark them taken or planned together.
  picked: new Set(),
  picking: false, // "Mark courses" mode: plain clicks pick too, until Done
  showExternal: prefs.get('showExternal', true),
  showLinks: prefs.get('showLinks', true),
  pathPace: prefs.get('pathPace', 3), // at most this many courses a quarter on a path
  plan: new Plan(),
  // Derived from the plan and map by derive():
  taken: new Set(),
  planned: new Set(),
  ready: new Set(), // on the map, not taken or planned, prerequisites done
  myPrograms: new Set(),
  activePrograms: [],
  visible: new Set(),
  paths: new Map(), // paths to courses worked out so far (see path.js)
};
let maps = [];
const undoStack = []; // plan snapshots, newest last
let panelSubject = null; // what the panel showed last render (see render())

// The graph needs d3 from the CDN; without it the list still works.
const graph = window.d3
  ? new GraphView(els.graph, {
    onSelect: (id, opts) => select(id, opts),
    onPick: (ids, opts) => pickCourses(ids, opts),
    minimap: $('#minimap'),
  })
  : null;
graph?.setShowLinks(state.showLinks);
$('#show-links').checked = state.showLinks;

const search = new Search(els.search, els.results, {
  find: q => (state.map ? state.map.search(q, 8) : []),
  describe: optionHTML,
  onPick: id => (state.addTerm ? addToTerm(id, state.addTerm) : select(id, { source: 'search' })),
  onQuery: q => {
    state.query = q;
    if (state.view === 'list' && state.map && !state.addTerm) renderList(els.list, { map: state.map, state, query: q });
  },
  onBlur: () => {
    if (state.addTerm) {
      state.addTerm = null;
      syncControls();
    }
  },
});

// ---------------------------------------------------------------- loading

async function init() {
  syncThemeButton();
  if (!graph) {
    document.querySelector('[data-view="graph"]').disabled = true;
    announce('The graph library could not be loaded, so courses are shown as a list.');
  }
  setStageStatus('Loading course data…');
  try {
    maps = (await fetchJSON('data/maps.json')).maps;
    if (!maps.length) throw new Error('data/maps.json lists no maps.');
    els.mapSelect.innerHTML = maps.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    els.mapPicker.hidden = maps.length < 2;
    await openMap(readURL());
  } catch (err) {
    console.error(err);
    setStageStatus(`<div class="error"><p><b>Couldn't load the course data.</b></p><p>${esc(err.message)}</p>
      <button type="button" class="btn" data-action="reload">Try again</button></div>`);
  }
}

async function openMap(params) {
  const entry = maps.find(m => m.id === params.map) || maps[0];
  const fresh = !state.map || state.map.id !== entry.id;
  if (fresh) {
    setStageStatus('Loading course data…');
    state.map = new CourseMap(await fetchJSON(`data/${entry.file}`));
    els.mapSelect.value = entry.id;
    els.mapName.textContent = state.map.name;
    els.helpData.innerHTML = aboutHTML(state.map);
  }
  const before = state.visible;
  derive();
  const map = state.map;
  state.selected = params.course && map.get(params.course) ? params.course : null;
  state.highlight = params.hl && map.highlight(params.hl) ? params.hl : '';
  if (showingPath()) derive(); // the path's courses join the graph
  state.view = VIEWS.includes(params.view) ? params.view : 'graph';
  if (!graph && state.view === 'graph') state.view = 'list';
  setStageStatus('');
  if (fresh && graph) {
    graph.setData(map, state.visible);
    syncInsets();
    graph.fitAll({ animate: false, minScale: 0.45 });
  } else if (!fresh) {
    relayout(before);
  }
  render({ history: 'replace' });
  if (state.selected) revealSelected({ animate: !fresh });
}

// Everything that follows from the plan: status sets, the programs in play,
// which courses are on the graph, and the "your plan" highlights.
function derive() {
  const { map, plan } = state;
  state.taken = new Set(plan.ids('taken'));
  state.planned = new Set(plan.ids('planned'));
  const chosen = plan.chosenPrograms(map.id);
  state.myPrograms = new Set(chosen || []);
  // With no programs chosen, the map's own majors stand in.
  state.activePrograms = chosen ? chosen.map(id => map.program(id)).filter(Boolean) : map.programs.filter(p => p.default);

  state.paths = new Map();
  const visible = new Set(map.courses.filter(c => c.role === 'main').map(c => c.id));
  if (state.showExternal) {
    map.required.forEach(id => visible.add(id));
    state.activePrograms.forEach(p => p.courses.forEach(id => visible.add(id)));
    [...state.taken, ...state.planned].forEach(id => map.get(id) && visible.add(id));
    // So does a path being shown, so all of it is drawn.
    if (showingPath()) pathHighlight(state.highlight)?.ids.forEach(id => map.get(id) && visible.add(id));
  }
  state.visible = visible;
  // "Can take now" only means something once some courses are marked taken.
  const planning = [...state.taken].some(id => map.get(id));
  state.ready = new Set(planning
    ? [...visible].filter(id => !state.planned.has(id) && map.status(map.get(id), state.taken) === 'available')
    : []);
  for (const id of state.picked) if (!visible.has(id)) state.picked.delete(id);

  map.setExtraHighlights([
    { key: 'plan:taken', group: 'Your plan', label: "Courses you've taken", ids: state.taken },
    { key: 'plan:planned', group: 'Your plan', label: "Courses you've planned", ids: state.planned },
    { key: 'plan:ready', group: 'Your plan', label: 'Courses you can take now', ids: state.ready },
  ], pathHighlight);
  fillHighlightSelect();
  if (state.highlight && !highlightOptions().some(h => h.key === state.highlight)) state.highlight = '';
}

// "path:<course>" highlights what's still needed for a course, with the
// quarters to take it in (path.js).
function pathHighlight(key) {
  const id = key.startsWith('path:') && key.slice(5);
  const c = id && state.map.get(id);
  if (!c) return null;
  const path = pathFor(state, id);
  return { key, group: 'Your plan', label: `Path to ${state.map.label(c)}`, ids: new Set(path.done ? [id] : path.courses), path };
}

const showingPath = () => state.highlight.startsWith('path:');

// After any change to the plan: recompute, re-lay out the graph if the set of
// courses on it changed, and redraw.
function planChanged() {
  const before = state.visible;
  derive();
  relayout(before);
  render();
}

function relayout(before) {
  const same = before.size === state.visible.size && [...before].every(id => state.visible.has(id));
  if (!same && graph) graph.setData(state.map, state.visible, { animate: state.view === 'graph' });
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
    const peek = isPicking() ? SHEET_PEEK_PICKING : SHEET_PEEK;
    bottom = sheet.classList.contains('is-collapsed') ? peek : sheet.offsetHeight;
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
  if (state.view !== 'graph') p.set('view', state.view);
  const qs = p.toString();
  const url = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  if (url === location.pathname + location.search + location.hash) return;
  history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
}

// -------------------------------------------------------------- rendering

function render({ history: mode = 'replace' } = {}) {
  const { map } = state;
  if (!map) return;
  keepFocus(() => {
    graph?.update(state);
    renderPanel(els.panel, { map, state, repo: repoSlug() });
    if (state.view === 'list') renderList(els.list, { map, state, query: state.query });
    if (state.view === 'plan') renderPlanView(els.planView, { map, state });
    renderPlanner();
  });
  // Something new in the panel (another course, a path, courses to mark) starts at its top.
  const subject = isPicking() ? 'picking' : state.selected || state.highlight;
  if (subject !== panelSubject) els.panel.scrollTop = 0;
  panelSubject = subject;
  // On phones the panel is a bottom sheet; open it only for a course, the
  // courses being marked or a path, so a highlight stays visible on the graph.
  els.panel.classList.toggle('is-open', !!state.selected || isPicking() || showingPath());
  els.panel.classList.toggle('is-picking', isPicking());
  syncControls();
  writeURL(mode);
}

// Re-rendering replaces controls; put keyboard focus back on the equivalent one.
const FOCUS_KEYS = ['action', 'select', 'highlight', 'id', 'status', 'term', 'program', 'view'];
function keepFocus(fn) {
  const active = document.activeElement;
  const container = active?.closest?.('#panel, #list, #planner, #plan');
  const selector = container && FOCUS_KEYS.filter(k => active.dataset[k] !== undefined)
    .map(k => `[data-${k}="${CSS.escape(active.dataset[k])}"]`).join('');
  fn();
  if (selector && !container.contains(active)) container.querySelector(selector)?.focus();
}

function syncControls() {
  const { view } = state;
  fillHighlightSelect(); // a path is on offer only while it's shown
  els.highlight.value = state.highlight;
  els.highlight.classList.toggle('is-active', !!state.highlight);
  els.showExternal.checked = state.showExternal;
  els.stage.classList.toggle('is-list', view === 'list');
  els.stage.classList.toggle('is-plan', view === 'plan');
  els.list.hidden = view !== 'list';
  els.planView.hidden = view !== 'plan';
  els.viewButtons.forEach(b => b.setAttribute('aria-checked', String(b.dataset.view === view)));
  // The list view filters as you type; elsewhere (or when adding) a dropdown suggests courses.
  search.setDropdown(view !== 'list' || !!state.addTerm);
  els.search.placeholder = state.addTerm
    ? `Add a course to ${termLabel(state.addTerm)}…`
    : view === 'list' ? 'Filter the list by number or title' : 'Search courses, e.g. EE 221 or signals';
  els.search.classList.toggle('is-adding', !!state.addTerm);
}

// The highlights on offer: lists from the programs in play, your plan (and
// the path being shown), and the schedule.
function highlightOptions() {
  const active = new Set(state.activePrograms.map(p => p.id));
  const plan = state.map.extraHighlights.filter(h => h.ids.size && [...h.ids].some(id => state.map.get(id)));
  const path = showingPath() && state.map.highlight(state.highlight);
  return [
    ...state.map.highlights.filter(h => h.program && active.has(h.program)),
    ...plan,
    ...(path ? [path] : []),
    ...state.map.highlights.filter(h => !h.program),
  ];
}

function fillHighlightSelect() {
  const groups = new Map();
  for (const h of highlightOptions()) {
    if (!groups.has(h.group)) groups.set(h.group, []);
    groups.get(h.group).push(h);
  }
  const count = h => [...h.ids].filter(id => state.map.get(id)).length;
  const html = '<option value="">None</option>' + [...groups].map(([group, items]) =>
    `<optgroup label="${esc(group)}">${items.map(h =>
      `<option value="${esc(h.key)}">${esc(h.label)} (${count(h)})</option>`).join('')}</optgroup>`).join('');
  if (html !== els.highlight.dataset.html) {
    els.highlight.innerHTML = html;
    els.highlight.dataset.html = html;
    els.highlight.value = state.highlight;
  }
}

function renderPlanner() {
  const { map, taken, planned, ready } = state;
  const picking = isPicking();
  const nTaken = [...taken].filter(id => map.get(id)).length;
  const nPlanned = [...planned].filter(id => map.get(id)).length;
  const start = `<button type="button" class="tool-btn" data-action="${picking ? 'stop-picking' : 'start-picking'}" aria-pressed="${picking}"
    title="Select several courses, then mark them taken or planned">${statusIcon('taken')}<span class="wide-only">Mark courses</span><span class="narrow-only">Mark</span></button>`;
  if (!nTaken && !nPlanned) {
    els.planner.innerHTML = `${start}<span class="muted planner-hint">or Shift-click courses to mark what you've taken</span>`;
    return;
  }
  // Each count highlights its courses on the map.
  const stat = (key, kind, n, label) => `<button type="button" class="stat-btn" data-highlight="${key}"
    aria-pressed="${state.highlight === key}"${n ? '' : ' disabled'} title="Highlight them">${statusIcon(kind)}<b>${n}</b> <span class="stat-label">${label}</span></button>`;
  els.planner.innerHTML = `<span class="plan-stats">${stat('plan:taken', 'taken', nTaken, 'taken')}${
    stat('plan:planned', 'planned', nPlanned, 'planned')}${stat('plan:ready', 'ready', ready.size, 'can take now')}</span>${start}`;
}

function optionHTML(c) {
  const map = state.map;
  const status = state.plan.status(c.id);
  const term = state.plan.term(c.id);
  const mine = status ? ` · ${status}${term ? ` ${termLabel(term)}` : ''}` : '';
  return `<span class="r-code">${esc(map.label(c))}</span>
    <span class="r-title">${esc(c.title || 'Not in the current catalog')}</span>
    <span class="r-meta">${esc(map.deptName(c))}${esc(mine)}</span>`;
}

function setStageStatus(html) {
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

function select(id, { source = 'panel', toggle = false } = {}) {
  const map = state.map;
  if (!map || (id && !map.get(id))) return;
  // Shift, Cmd or Ctrl-click picks several courses; while picking, any click does.
  if (toggle || isPicking()) {
    if (id) togglePick(id);
    else if (!toggle && !state.picking) stopPicking(); // a plain click on empty space
    return;
  }
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

// ------------------------------------------------------ several at once

const isPicking = () => state.picking || state.picked.size > 0;
const countText = n => `${n} course${n === 1 ? '' : 's'}`;

// The panel lists what's selected, with what to do with it. On phones it
// starts as a peek (its header holds the buttons) so the map stays in view.
function beginPicking() {
  if (!isPicking()) els.panel.classList.add('is-collapsed');
}

function togglePick(id) {
  const { picked, map } = state;
  beginPicking();
  // The course open in the panel comes along when picking starts.
  if (!picked.size && state.selected && state.selected !== id) picked.add(state.selected);
  if (picked.has(id)) picked.delete(id);
  else picked.add(id);
  state.selected = null;
  render();
  announce(`${map.label(map.get(id))} ${picked.has(id) ? 'selected' : 'unselected'}. ${countText(picked.size)} selected.`);
}

// From a Shift-drag box, a long press, or "Select it and what it requires".
function pickCourses(ids, { toggle = false } = {}) {
  if (toggle && ids.length === 1) {
    togglePick(ids[0]);
    return;
  }
  beginPicking();
  if (!state.picked.size && state.selected) state.picked.add(state.selected);
  ids.forEach(id => state.picked.add(id));
  state.selected = null;
  render();
  announce(`${countText(state.picked.size)} selected.`);
}

function startPicking() {
  beginPicking();
  state.picking = true;
  state.selected = null;
  render();
  announce(`${touch.matches ? 'Tap' : 'Click'} courses to select them, then mark them taken or planned.`);
}

function stopPicking() {
  if (!isPicking()) return;
  state.picked.clear();
  state.picking = false;
  render();
}

// An action uses up the selection; "Mark courses" mode stays on.
function takePicked() {
  const ids = [...state.picked];
  state.picked.clear();
  return ids;
}

// ------------------------------------------------------------ plan changes
// Every change to the plan's courses goes through changePlan, which says what
// happened and offers Undo (Cmd/Ctrl+Z works too).

function changePlan(message, fn) {
  const before = state.plan.snapshot();
  fn(state.plan);
  if (state.plan.snapshot() === before) {
    render();
    return;
  }
  undoStack.push(before);
  if (undoStack.length > 50) undoStack.shift();
  planChanged();
  showToast(message, { canUndo: true });
  announce(message);
}

function undo() {
  const snapshot = undoStack.pop();
  if (snapshot === undefined) return;
  state.plan.restore(snapshot);
  planChanged();
  showToast('Undone.');
  announce('Undone.');
}

let toastTimer;
function showToast(message, { canUndo = false } = {}) {
  els.toast.querySelector('.toast-text').textContent = message;
  els.toast.querySelector('[data-action="undo"]').hidden = !canUndo;
  els.toast.hidden = false;
  hideToastLater(TOAST_MS);
}

function hideToastLater(ms) {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

const isPast = term => termOrder(term) < termOrder(currentTerm());
const STATUS_DONE = { taken: 'marked taken', planned: 'marked planned', '': 'removed from your plan' };

// Taken / planned / not taken for one or more courses. A course keeps its
// quarter only if it still fits (taken courses sit in past quarters, plans in
// the current one or later).
function setStatus(ids, status) {
  const { map } = state;
  const what = ids.length === 1 ? map.label(map.get(ids[0])) : countText(ids.length);
  changePlan(`${what} ${STATUS_DONE[status || '']}.`, plan => {
    for (const id of ids) {
      const term = plan.term(id);
      const keep = term && (status === 'taken' ? termOrder(term) <= termOrder(currentTerm()) : !isPast(term));
      plan.set(id, status || null, keep ? term : null);
    }
  });
}

function setCourseTerm(id, term) {
  const c = state.map.get(id);
  changePlan(`${state.map.label(c)}: ${term ? termLabel(term) : 'no quarter'}.`,
    plan => plan.set(id, plan.status(id), term || null));
}

// A drop or "+ Add" into a quarter: past quarters mean taken, others planned.
function moveToTerm(ids, term, verb = term && isPast(term) ? 'marked taken in' : 'planned for') {
  const { map } = state;
  const what = ids.length === 1 ? map.label(map.get(ids[0])) : countText(ids.length);
  changePlan(`${what} ${verb} ${term ? termLabel(term) : 'no quarter'}.`, plan => {
    for (const id of ids) {
      const status = term ? (isPast(term) ? 'taken' : 'planned') : plan.status(id) || 'planned';
      plan.set(id, status, term || null);
    }
  });
}

// T, P and N: the selected courses, else the focused or open one.
function quickMark(status) {
  if (state.picked.size) {
    setStatus(takePicked(), status);
    return;
  }
  const el = document.activeElement;
  const id = el?.closest?.('.node')?.dataset.id || el?.closest?.('[data-select]')?.dataset.select || state.selected;
  if (id && state.map.get(id)) setStatus([id], status);
}

function startAdding(term) {
  state.addTerm = term;
  syncControls();
  els.search.value = '';
  els.search.focus();
  announce(`Type a course to add to ${termLabel(term)}.`);
}

function addToTerm(id, term) {
  state.addTerm = null;
  moveToTerm([id], term, 'added to');
}

function setPrograms(ids) {
  state.plan.setPrograms(state.map.id, ids);
  planChanged();
}

function clearPlan() {
  const mine = Object.keys(state.plan.courses).filter(id => state.map.get(id));
  if (!mine.length || !window.confirm(`Remove all ${mine.length} courses from your plan?`)) return;
  changePlan(`Removed ${countText(mine.length)} from your plan.`, plan => plan.clear(mine));
}

function setHighlight(key) {
  const before = state.visible;
  const paths = showingPath() || key.startsWith('path:');
  state.highlight = key;
  if (paths) {
    derive(); // a path brings its courses onto the graph
    relayout(before);
  }
  render({ history: 'push' });
  const hl = state.map.highlight(key);
  if (!hl) return;
  announce(hl.path ? `${hl.label}: ${countText(hl.ids.size - 1)} to take first. Details are in the side panel.`
    : `Highlighting ${hl.ids.size} courses: ${hl.label}.`);
  if (state.view === 'graph' && !state.selected) {
    syncInsets();
    graph.showIds(hl.ids, { keep: hl.path?.target });
  }
}

// ------------------------------------------------------- path to a course

// The courses still needed for a course, quarter by quarter, on the map and
// in the panel (on phones, the sheet peeks so the path stays in view).
function showPath(id) {
  state.selected = null;
  els.panel.classList.add('is-collapsed');
  setHighlight(`path:${id}`);
  els.panel.focus({ preventScroll: true });
}

// Every course on the path goes in the plan, in the quarter the path gives it.
function planPath(id) {
  const { map, plan } = state;
  const path = pathFor(state, id);
  const add = [...path.when].filter(([c, term]) => map.get(c) && plan.status(c) !== 'taken'
    && !(plan.status(c) === 'planned' && plan.term(c) === term));
  if (!add.length) return;
  changePlan(`Planned ${countText(add.length)} for the path to ${map.label(map.get(id))}.`, p => {
    for (const [c, term] of add) p.set(c, 'planned', term);
  });
}

function setPace(n) {
  state.pathPace = n;
  prefs.set('pathPace', n);
  state.paths.clear();
  render();
}

function setView(view) {
  if (view === state.view || (view === 'graph' && !graph)) return;
  state.view = view;
  if (view === 'plan') {
    state.picked.clear();
    state.picking = false;
  }
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
  planChanged();
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
      && !e.target.closest('[data-action], select')) {
    toggleSheet();
    return;
  }
  const t = e.target.closest('[data-select], [data-action], [data-highlight], [data-zoom], [data-view]');
  if (!t || t.disabled || t.tagName === 'SELECT') return;
  const { action, id } = t.dataset;
  const toggle = state.view !== 'plan' && (e.shiftKey || e.metaKey || e.ctrlKey);
  if (t.dataset.select) select(t.dataset.select, { source: t.closest('#list') ? 'list' : 'panel', toggle });
  else if (t.dataset.highlight) setHighlight(state.highlight === t.dataset.highlight ? '' : t.dataset.highlight);
  else if (t.dataset.zoom) zoom(t.dataset.zoom);
  else if (t.dataset.view) setView(t.dataset.view);
  else if (action === 'close') select(null);
  else if (action === 'set-status') setStatus([id], t.dataset.status);
  else if (action === 'pick-status') setStatus(takePicked(), t.dataset.status);
  else if (action === 'start-picking') startPicking();
  else if (action === 'stop-picking') stopPicking();
  else if (action === 'unpick') togglePick(id);
  else if (action === 'pick-chain') pickCourses([id, ...[...state.map.requiredAncestors(id)].filter(c => state.visible.has(c))]);
  else if (action === 'show-path') showPath(id);
  else if (action === 'plan-path') planPath(id);
  else if (action === 'undo') undo();
  else if (action === 'add-to-term') startAdding(t.dataset.term);
  else if (action === 'remove-program') setPrograms([...state.myPrograms].filter(p => p !== t.dataset.program));
  else if (action === 'clear-plan') clearPlan();
  else if (action === 'clear-highlight') setHighlight('');
  else if (action === 'toggle-sheet') toggleSheet();
  else if (action === 'reload') window.location.reload();
});

// Selects in the panel, list and plan view.
document.addEventListener('change', e => {
  const t = e.target;
  const { action, id } = t.dataset;
  if (action === 'set-status') setStatus([id], t.value);
  else if (action === 'set-term') setCourseTerm(id, t.value);
  else if (action === 'pick-term' && t.value) moveToTerm(takePicked(), t.value);
  else if (action === 'add-program' && t.value) setPrograms([...state.myPrograms, t.value]);
  else if (action === 'set-pace') setPace(Number(t.value));
  else if (action === 'set-start') {
    state.plan.setStart(Number(t.value));
    render();
  }
});

// Drag courses between quarters in the plan view.
els.planView.addEventListener('dragstart', e => {
  const chip = e.target.closest?.('.pchip');
  if (!chip) return;
  e.dataTransfer.setData('text/plain', chip.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
  chip.classList.add('is-dragging');
});
els.planView.addEventListener('dragend', e => e.target.closest?.('.pchip')?.classList.remove('is-dragging'));
els.planView.addEventListener('dragover', e => {
  const quarter = e.target.closest('.quarter');
  if (!quarter) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  els.planView.querySelectorAll('.drag-over').forEach(q => q !== quarter && q.classList.remove('drag-over'));
  quarter.classList.add('drag-over');
});
els.planView.addEventListener('dragleave', e => {
  const quarter = e.target.closest('.quarter');
  if (quarter && !quarter.contains(e.relatedTarget)) quarter.classList.remove('drag-over');
});
els.planView.addEventListener('drop', e => {
  const quarter = e.target.closest('.quarter');
  if (!quarter) return;
  e.preventDefault();
  quarter.classList.remove('drag-over');
  const id = e.dataTransfer.getData('text/plain');
  if (state.map.get(id) && state.plan.term(id) !== (quarter.dataset.term || null)) moveToTerm([id], quarter.dataset.term, 'moved to');
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
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && !typing) {
    if (undoStack.length) {
      e.preventDefault();
      undo();
    }
  } else if (e.key === '/' && !typing) {
    e.preventDefault();
    els.search.focus();
  } else if (e.key === 'Escape' && (isPicking() || state.selected || state.highlight)) {
    // Step back one level: the multi-selection, the selected course, then the highlight.
    if (isPicking()) stopPicking();
    else if (state.selected) select(null);
    else setHighlight('');
  } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const mark = { t: 'taken', p: 'planned', n: '' }[e.key.toLowerCase()];
    if (mark !== undefined && state.view !== 'plan') quickMark(mark);
    else if (e.key === '+' || e.key === '=') zoom('in');
    else if (e.key === '-' || e.key === '_') zoom('out');
    else if (e.key === '0') zoom('fit');
  }
});

// The toast stays while the pointer is on it.
els.toast.addEventListener('pointerenter', () => clearTimeout(toastTimer));
els.toast.addEventListener('pointerleave', () => hideToastLater(2500));

init();
