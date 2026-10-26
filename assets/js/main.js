// App entry: owns the state, routes between the pages (home, a course, a
// degree map), keeps the URL in sync and wires the graph, list, plan, panel,
// search and toolbar together.
import { CourseMap, combineData, dropWarnings, eachCode, fetchJSON, foldOptions } from './model.js';
import { GraphView } from './graph.js';
import { renderPanel, aboutHTML, esc, ICON, statusIcon } from './panel.js';
import { renderHome, courseHref, mapHref } from './home.js';
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
  programsBtn: $('#programs-btn'),
  programsDialog: $('#programs'),
  programsList: $('#programs-list'),
  search: $('#search'),
  results: $('#search-results'),
  toolbar: $('.toolbar'),
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
  legendNote: $('#legend-note'),
  toast: $('#toast'),
  confirm: $('#confirm'),
  home: $('#home'),
  homeSearch: $('#home-search'),
  homeResults: $('#home-results'),
  workspace: $('#workspace'),
  splitter: $('#splitter'),
};

const state = {
  // 'home' (search courses, or pick a major's pre-req graph), 'course' (one
  // course and its prerequisite chain) or 'map' (a degree's graph, list and plan).
  page: 'home',
  homeTab: 'search', // the toggle above the home search box: 'search' or 'graph'
  homeQuery: { search: '', graph: '' }, // what's typed on each side of the toggle
  focus: null, // the course a course page is about
  depth: prefs.get('courseDepth', 2), // how many layers of prerequisites a course page shows: 1, 2 or 'all'
  opened: new Set(), // courses on the course page whose earlier courses are all shown ("+3" clicked)
  all: null, // every course on the site, for search and course pages
  deptMaps: new Map(), // department -> the map it belongs to: { name, programs }
  map: null,
  programIds: [], // the majors and minors on the map (the student's, or a link's)
  programIndex: new Map(), // every program the maps offer (see indexPrograms)
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
  arrange: prefs.get('arrange', 'steps'), // graph rows: prerequisite steps, or course 'level'
  pathPace: prefs.get('pathPace', 3), // at most this many courses a quarter on a path
  plan: new Plan(),
  // Derived from the plan and map by derive():
  taken: new Set(),
  planned: new Set(),
  skipped: new Set(), // "not interested": hidden from the map unless showSkipped
  ready: new Set(), // on the map, not taken or planned, prerequisites done
  myPrograms: new Set(),
  activePrograms: [],
  visible: new Set(),
  paths: new Map(), // paths to courses worked out so far (see path.js)
  expanded: new Set(), // panel parts opened in full: "desc:<course>", "unlocks:<course>"
  preview: null, // a course shown in the panel while the mouse is over it
  showSkipped: false, // show the courses marked "not interested" (faded) on the map and list
  // "One of several" options: the graph draws the usual one (see foldFor), unless every option is shown.
  showOptions: prefs.get('showOptions', false),
  prefer: () => 0, // how usual an option is (usualRank)
  folded: new Map(), // course -> options folded away from it
  alts: new Map(), // course on the graph -> the options folded into it
  foldKey: '', // what's folded on the graph, to tell when it needs drawing again
};
let maps = []; // data/maps.json: each map's file, departments and programs
const loaded = new Map(); // map id -> its data (a promise), fetched once
const built = new Map(); // a degree map's key -> its CourseMap, so going back to it is instant
const undoStack = []; // plan snapshots, newest last
let panelSubject = null; // what the panel showed last render (see render())

// The graph needs d3 from the CDN; without it the list still works.
const graph = window.d3
  ? new GraphView(els.graph, {
    onSelect: (id, opts) => select(id, opts),
    onPick: (ids, opts) => pickCourses(ids, opts),
    onPreview: id => preview(id),
    onExpand: id => showEarlier(id),
    minimap: $('#minimap'),
  })
  : null;
graph?.setShowLinks(state.showLinks);
graph?.setArrange(state.arrange);
$('#show-links').checked = state.showLinks;
$('#show-options').checked = state.showOptions;

const search = new Search(els.search, els.results, {
  find: q => (state.map ? state.map.search(q, 8) : []),
  describe: optionHTML,
  onPick: id => {
    if (state.addTerm) addToTerm(id, state.addTerm);
    else if (state.page === 'course') go(courseHref(id));
    else select(id, { source: 'search' });
  },
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
  syncArrange();
  if (!graph) {
    document.querySelector('[data-view="graph"]').disabled = true;
    announce('The graph library could not be loaded, so courses are shown as a list.');
  }
  showPage(pageOf(readURL()));
  setStageStatus('Loading course data…');
  try {
    maps = (await fetchJSON('data/maps.json')).maps;
    if (!maps.length) throw new Error('data/maps.json lists no maps.');
    state.programIndex = indexPrograms(maps);
    state.deptMaps = new Map(maps.flatMap(m => m.departments.map(d =>
      [d, { name: m.name, programs: m.programs.filter(p => p.default).map(p => p.id) }])));
    await route(readURL());
  } catch (err) {
    loadFailed(err);
  }
}

// The message goes in the stage, so the home page makes way for it.
function loadFailed(err) {
  console.error(err);
  showPage('map');
  setStageStatus(`<div class="error"><p><b>Couldn't load the course data.</b></p><p>${esc(err.message)}</p>
    <button type="button" class="btn" data-action="reload">Try again</button></div>`);
}

// Every program the maps offer, and the map it belongs to: a major's own map
// (where it's a default), else the first map that lists it.
function indexPrograms(list) {
  const index = new Map();
  for (const m of list) {
    for (const p of m.programs || []) {
      if (!index.has(p.id)) index.set(p.id, { ...p, maps: [], home: null });
      const entry = index.get(p.id);
      entry.maps.push(m.id);
      if (p.default && !entry.home) entry.home = m.id;
    }
  }
  index.forEach(p => { p.home ||= p.maps[0]; });
  return index;
}

const defaultPrograms = () => maps[0].programs.filter(p => p.default).map(p => p.id);
const ownPrograms = () => (state.plan.chosenPrograms() || []).filter(id => state.programIndex.has(id));

// The programs a link asks for (?programs=ee-bs,mse-bs, or an older ?map=cs),
// else the student's own, else the first map's majors.
function programsFrom(params) {
  const asked = (params.programs || '').split(',').filter(id => state.programIndex.has(id));
  if (asked.length) return asked;
  const old = maps.find(m => m.id === params.map);
  if (old) return old.programs.filter(p => p.default).map(p => p.id);
  const own = ownPrograms();
  return own.length ? own : defaultPrograms();
}

// The map for a set of programs: every course in its majors' departments
// (from those majors' maps), plus a map that has each minor's lists. Returns
// whether the map changed.
async function loadPrograms(ids) {
  const programs = ids.map(id => state.programIndex.get(id));
  const homes = [...new Set(programs.filter(p => p.type === 'major').map(p => p.home))];
  const files = new Set(homes);
  for (const p of programs) if (p.type !== 'major' && !p.maps.some(m => files.has(m))) files.add(p.maps[0]);
  const entries = maps.filter(m => files.has(m.id));
  const key = `${entries.map(m => m.id).join('+')}|${homes.join('+')}`;
  if (state.map?.key === key) return false;
  if (!built.has(key)) {
    if (entries.some(m => !loaded.has(m.id))) setStageStatus('Loading course data…');
    const datas = await Promise.all(entries.map(loadData));
    const own = maps.filter(m => homes.includes(m.id));
    const single = datas.length === 1 && own.length === 1;
    const map = new CourseMap(single ? datas[0] : combineData(datas, own.flatMap(m => m.departments),
      { id: key, name: own.length ? own.map(m => m.name).join(' + ') : 'Your minors' }));
    map.key = key;
    built.set(key, map);
  }
  useMap(built.get(key));
  return true;
}

function useMap(map) {
  state.map = map;
  els.mapName.textContent = map.name;
  els.helpData.innerHTML = aboutHTML(map);
}

// One map's data file, fetched once (and again only if it failed).
function loadData(m) {
  if (!loaded.has(m.id)) {
    loaded.set(m.id, fetchJSON(`data/${m.file}`).catch(err => {
      loaded.delete(m.id);
      throw err;
    }));
  }
  return loaded.get(m.id);
}

// Every course on the site in one map, for search and course pages. Each
// map's departments are its own; the rest are other departments' courses.
async function loadAll() {
  if (!state.all) {
    const datas = await Promise.all(maps.map(loadData));
    state.all ||= Object.assign(new CourseMap(combineData(datas, maps.flatMap(m => m.departments),
      { id: 'all', name: 'All courses' })), { key: 'all' });
  }
  return state.all;
}

// ------------------------------------------------------------------ pages
// Links are real links (they can be copied or opened in a new tab); going
// to one pushes it and opens its page.

// A link names programs (or, in older links, a map, view or highlight) for a
// degree map, else a course for its page, else it's the home page.
function pageOf(p) {
  if (p.programs || p.map || p.view || (p.hl && !p.hl.startsWith('path:'))) return 'map';
  return p.course ? 'course' : 'home';
}

function route(params) {
  const page = pageOf(params);
  if (page === 'home') return showHome(params.home === 'graph' ? 'graph' : 'search', params.q || '');
  if (page === 'course') return showCourse(params.course, params.hl || '');
  return showMap(params);
}

function go(href) {
  history.pushState(null, '', href);
  route(readURL()).catch(loadFailed);
}

function homeHref(tab, q = '') {
  const p = new URLSearchParams();
  if (tab === 'graph') p.set('home', 'graph');
  if (q) p.set('q', q);
  return p.toString() ? `?${p}` : './';
}

// Which page's parts are on screen, and how much room the details get.
function showPage(page) {
  document.body.dataset.page = page;
  els.home.hidden = page !== 'home';
  els.workspace.hidden = page === 'home';
  if (page !== 'map') els.toolbar.hidden = true; // the toolbar holds a degree map's options
  if (page !== 'home') setPanelWidth(savedPanelWidth());
}

// Moving to another page drops what was in progress on this one.
function leavePage() {
  clearTimeout(previewTimer);
  state.preview = null;
  state.picked.clear();
  state.picking = false;
  state.addTerm = null;
  state.highlight = '';
}

async function showHome(tab, query) {
  leavePage();
  state.page = 'home';
  state.homeTab = tab;
  state.homeQuery[tab] = query;
  render({ history: 'replace' });
  // Ready to type, except on touch screens, where the keyboard would cover the page.
  if (!touch.matches) els.homeSearch.focus({ preventScroll: true });
  await loadAll();
  if (state.page === 'home') render({ history: 'none' });
}

// A course's page: the course, everything it requires and what it unlocks.
async function showCourse(id, hl) {
  const map = await loadAll();
  if (!map.get(id)) {
    history.replaceState(null, '', './');
    return showHome('search', '');
  }
  leavePage();
  if (id !== state.focus) state.opened.clear();
  state.page = 'course';
  showPage('course'); // the stage takes this page's size before the graph is laid out
  useMap(map);
  state.focus = id;
  state.selected = id;
  state.view = 'graph';
  // Only the student's own programs: a visitor's course page marks none as theirs.
  state.programIds = ownPrograms();
  state.highlight = hl === `path:${id}` ? hl : '';
  derive();
  setStageStatus('');
  els.panel.classList.add('is-collapsed'); // phones: the chain first, the details peek
  layoutGraph({ animate: true }); // from another course page, the cards glide
  render({ history: 'replace' });
  syncInsets(); // on phones, once the sheet is open
  graph?.frame(id);
  const c = map.get(id);
  announce(`${map.label(c)}, ${c.title}: what it requires and what it unlocks.`);
}

async function showMap(params) {
  leavePage();
  state.programIds = programsFrom(params);
  const fresh = await loadPrograms(state.programIds);
  const before = state.visible;
  state.page = 'map';
  showPage('map');
  state.focus = null;
  derive();
  const map = state.map;
  state.selected = params.course && map.get(params.course) ? params.course : null;
  state.highlight = params.hl && map.highlight(params.hl) ? params.hl : '';
  if (showingPath()) derive(); // the path's courses join the graph
  state.view = VIEWS.includes(params.view) ? params.view : 'graph';
  if (!graph && state.view === 'graph') state.view = 'list';
  setStageStatus('');
  if (fresh && graph) {
    layoutGraph();
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
  state.skipped = new Set(plan.ids('skip'));
  state.myPrograms = new Set(state.programIds);
  state.activePrograms = state.programIds.map(id => map.program(id)).filter(Boolean);

  state.paths = new Map();
  state.prefer = usualRank(map); // before any path is worked out: paths take the usual options too
  const pathHl = showingPath() ? pathHighlight(state.highlight) : null;
  const fold = foldFor(map, pathHl);
  state.folded = fold.folded;
  let visible;
  if (state.page === 'course') {
    // A course page draws its chain, hidden courses and all.
    visible = chainOf(map, state.focus);
  } else {
    visible = new Set(map.courses.filter(c => c.role === 'main').map(c => c.id));
    if (state.showExternal) {
      requiredHere(map).forEach(id => visible.add(id));
      programCourses().forEach(id => map.get(id) && visible.add(id));
      [...state.taken, ...state.planned].forEach(id => map.get(id) && visible.add(id));
    }
    // Courses marked "not interested" leave the map, unless the student asks to see them.
    if (!state.showSkipped) state.skipped.forEach(id => visible.delete(id));
  }
  // A path being shown brings all of its courses, so all of it is drawn.
  if (pathHl && (state.showExternal || state.page === 'course')) pathHl.ids.forEach(id => map.get(id) && visible.add(id));
  state.visible = visible;
  state.alts = altsOn(map, fold.alts, visible);
  state.foldKey = [...visible].filter(id => state.folded.has(id)).sort()
    .map(id => `${id}:${[...state.folded.get(id)].join()}`).join('|');
  // "Can take now" only means something once some courses are marked taken.
  const planning = [...state.taken].some(id => map.get(id));
  state.ready = new Set(planning
    ? [...visible].filter(id => !state.planned.has(id) && !state.skipped.has(id) && map.status(map.get(id), state.taken) === 'available')
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

// ------------------------------------------------------ one of several
// Where a course accepts one of several options (MATH 228-1 or MATH 230-1 or
// ...), the graph draws the usual one and names the others on its card.

// How usual an option (a list of courses) is; higher is more: one in the
// student's plan, then one more of their programs ask for, then one more of
// the site's majors ask for (engineers take MATH 228-1, not MATH 230-1, and
// GEN_ENG 150 rather than COMP_SCI 150).
function usualRank(map) {
  const mine = new Set([...state.taken, ...state.planned]);
  const own = firstChoices(state.activePrograms);
  const majors = firstChoices(map.programs.filter(p => p.type === 'major'));
  const most = (ids, counts) => Math.max(0, ...ids.map(id => counts.get(id) || 0));
  return ids => (ids.some(id => mine.has(id)) ? 100 : 0) + 10 * Math.min(9, most(ids, own)) + Math.min(9, most(ids, majors));
}

// How many programs list each course as a requirement's first choice.
function firstChoices(programs) {
  const counts = new Map();
  for (const p of programs) {
    const ids = new Set(p.lists.flatMap(list => list.items.flatMap(alts => alts[0])));
    ids.forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
  }
  return counts;
}

// The options folded away, unless the student asked to see every option. A
// degree map folds only other departments' courses (all of its own are
// drawn); a course page folds any, but never its own course or the path
// being shown.
function foldFor(map, pathHl) {
  if (state.showOptions) return { folded: new Map(), alts: new Map() };
  const keep = new Set([...(pathHl?.ids || []), ...(state.page === 'course' ? [state.focus] : [])]);
  const rank = ids => (ids.some(id => keep.has(id)) ? 1000 : 0) + state.prefer(ids);
  return foldOptions(map, rank, state.page === 'course' ? undefined : id => map.get(id)?.role !== 'main');
}

// Other departments' courses that this map's courses require (and recommend),
// less the options folded away.
function requiredHere(map) {
  if (state.showOptions) return map.required;
  const ids = new Set();
  for (const c of map.courses) {
    if (c.role !== 'main') continue;
    const add = id => { if (!state.folded.get(c.id)?.has(id)) ids.add(id); };
    eachCode(c.prereq, add);
    eachCode(c.coreq, add);
    (c.recommended || []).forEach(add);
  }
  return ids;
}

// The courses of the programs in play: of a requirement's choices, the usual
// one (all of them while every option is shown).
function programCourses() {
  const pick = alts => alts.reduce((best, a) => (state.prefer(a) > state.prefer(best) ? a : best));
  return state.activePrograms.flatMap(p => p.lists.flatMap(list =>
    list.items.flatMap(alts => (state.showOptions ? alts.flat() : pick(alts)))));
}

// What folded into each course on the graph: the other options that the
// courses it leads to there accept instead. Courses not in the catalog any
// more (old numbers) are left out, and so is a course page's own course
// (the page is about it, not its stand-ins).
function altsOn(map, alts, visible) {
  const out = new Map();
  for (const [id, byCourse] of alts) {
    if (!visible.has(id) || id === graphFocus()) continue;
    const options = new Map();
    for (const [target, list] of byCourse) {
      if (!visible.has(target)) continue;
      for (const o of list) if (o.every(x => map.get(x) && !map.get(x).missing)) options.set(o.join('+'), o);
    }
    // Its own department's versions first: GEN_ENG 151 before COMP_SCI 150.
    const other = o => Number(map.get(o[0]).dept !== map.get(id).dept);
    if (options.size) out.set(id, [...options.values()].sort((a, b) => other(a) - other(b)));
  }
  return out;
}

function setShowOptions(on) {
  state.showOptions = on;
  prefs.set('showOptions', on);
  planChanged();
  announce(on ? 'Showing every option.' : 'Showing the usual option, with the others named on it.');
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

// A course page's graph: the course, the courses it unlocks directly, and
// what it requires (the usual option of each "one of") as many layers back
// as the viewer chose, or all the way back from a course whose "+3" was
// clicked. A recommended course is drawn, but not what it requires.
function chainOf(map, id) {
  const ids = new Set([id, ...map.children.get(id).map(e => e.target)]);
  const left = new Map([[id, state.depth === 'all' ? Infinity : state.depth]]); // layers still to go back
  const queue = [id];
  while (queue.length) {
    const x = queue.shift();
    const steps = state.opened.has(x) ? Infinity : left.get(x);
    if (steps <= 0) continue;
    for (const e of map.parents.get(x)) {
      if ((e.kind === 'rec' && x !== id) || state.folded.get(x)?.has(e.source)) continue;
      ids.add(e.source);
      const rest = e.kind === 'rec' ? 0 : steps - 1;
      if (!(left.get(e.source) >= rest)) {
        left.set(e.source, rest);
        queue.push(e.source);
      }
    }
  }
  return ids;
}

const graphFocus = () => (state.page === 'course' ? state.focus : null);

// "+3" on a course on a course page: draw every course before it.
function showEarlier(id) {
  const before = state.visible;
  state.opened.add(id);
  derive();
  relayout(before);
  render();
  const added = [...state.visible].filter(x => !before.has(x));
  if (!added.length) return;
  syncInsets();
  graph.showIds([id, ...added], { keep: id });
  announce(`Showing ${countText(added.length)} before ${state.map.label(state.map.get(id))}.`);
}

// How far back a course page's prerequisites go: 1 or 2 layers, or all.
function setDepth(depth) {
  if (depth === state.depth) return;
  const before = state.visible;
  state.depth = depth;
  prefs.set('courseDepth', depth);
  state.opened.clear();
  derive();
  relayout(before);
  render();
  syncInsets();
  graph?.frame(state.focus, { animate: true });
  announce(depth === 'all' ? 'Showing everything it requires.'
    : depth === 1 ? 'Showing only its direct prerequisites.' : 'Showing its prerequisites and theirs.');
}

// After any change to the plan: recompute, re-lay out the graph if the set of
// courses on it changed, and redraw.
function planChanged() {
  if (state.page === 'home') {
    render();
    return;
  }
  const before = state.visible;
  derive();
  relayout(before);
  render();
}

function relayout(before) {
  const same = before.size === state.visible.size && [...before].every(id => state.visible.has(id))
    && graph?.foldKey === state.foldKey;
  if (!same) layoutGraph({ animate: state.view === 'graph' });
}

// Hands the graph what to draw: the courses, the links folded away, and on a
// course page, the course it's about.
function layoutGraph(opts = {}) {
  graph?.setData(state.map, state.visible, { ...opts, focus: graphFocus(), folded: state.folded, foldKey: state.foldKey });
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
  // Floating controls cover the top of the stage on phones, and a course page's depth control everywhere.
  const top = state.page === 'course' ? (narrow.matches ? 98 : 56) : narrow.matches ? 52 : 0;
  graph?.setInsets({ top, bottom });
}

function readURL() {
  const p = new URLSearchParams(location.search);
  return { programs: p.get('programs'), map: p.get('map'), course: p.get('course'), hl: p.get('hl'), view: p.get('view'),
    home: p.get('home'), q: p.get('q') };
}

function writeURL(mode) {
  if (mode === 'none') return;
  let href;
  if (state.page === 'home') {
    href = homeHref(state.homeTab, state.homeQuery[state.homeTab].trim());
  } else if (state.page === 'course') {
    const p = new URLSearchParams({ course: state.focus });
    if (showingPath()) p.set('hl', state.highlight);
    href = `?${p}`;
  } else {
    // A degree map's link always names its programs: that's what makes it a map.
    const p = new URLSearchParams({ programs: state.programIds.join(',') });
    if (state.selected) p.set('course', state.selected);
    if (state.highlight) p.set('hl', state.highlight);
    if (state.view !== 'graph') p.set('view', state.view);
    href = `?${p}`;
  }
  const next = new URL(href, location.href);
  const url = `${next.pathname}${next.search}${location.hash}`;
  if (url === location.pathname + location.search + location.hash) return;
  history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
}

// -------------------------------------------------------------- rendering

function render({ history: mode = 'replace' } = {}) {
  showPage(state.page);
  document.title = pageTitle();
  if (state.page === 'home') {
    renderHome(els.home, { state, maps });
    syncControls();
    writeURL(mode);
    return;
  }
  const { map } = state;
  if (!map) return;
  // A course page keeps its course open, unless a path or courses being marked take the panel.
  if (state.page === 'course' && !state.selected && !isPicking() && !showingPath()) state.selected = state.focus;
  keepFocus(() => {
    graph?.update(state);
    renderPanel(els.panel, { map, state, repo: repoSlug() });
    if (state.view === 'list') renderList(els.list, { map, state, query: state.query });
    if (state.view === 'plan') renderPlanView(els.planView, { map, state });
    renderPlanner();
  });
  // Something new in the panel (another course, a path, courses to mark) starts at its top.
  const subject = isPicking() ? 'picking' : state.selected || state.preview || state.highlight;
  if (subject !== panelSubject) els.panel.scrollTop = 0;
  panelSubject = subject;
  // On phones the panel is a bottom sheet; open it only for a course, the
  // courses being marked or a path, so a highlight stays visible on the graph.
  els.panel.classList.toggle('is-open', !!state.selected || isPicking() || showingPath());
  els.panel.classList.toggle('is-picking', isPicking());
  syncControls();
  writeURL(mode);
}

const TITLE = 'Course Prerequisite Map';
function pageTitle() {
  const c = state.page === 'course' && state.map?.get(state.focus);
  if (c) return `${state.map.label(c)} ${c.title} · ${TITLE}`;
  return state.page === 'map' && state.map ? `${state.map.name} · ${TITLE}` : TITLE;
}

// Re-rendering replaces controls; put keyboard focus back on the equivalent one.
const FOCUS_KEYS = ['action', 'select', 'highlight', 'id', 'key', 'status', 'term', 'program', 'view'];
function keepFocus(fn) {
  const active = document.activeElement;
  const container = active?.closest?.('#panel, #list, #planner, #plan');
  const selector = container && FOCUS_KEYS.filter(k => active.dataset[k] !== undefined)
    .map(k => `[data-${k}="${CSS.escape(active.dataset[k])}"]`).join('');
  fn();
  if (selector && !container.contains(active)) container.querySelector(selector)?.focus();
}

function syncControls() {
  const { view, page } = state;
  // The Search / Pre-req graph toggle: a course page is a search result, a degree map a pre-req graph.
  const mode = page === 'map' ? 'graph' : page === 'course' ? 'search' : state.homeTab;
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  els.toolbar.hidden = page !== 'map' || view === 'plan';
  if (page === 'home') return;
  document.querySelectorAll('[data-depth]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.depth === String(state.depth))));
  syncArrange();
  syncProgramsButton();
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
  // Phones hide the "Highlight" label, so the empty choice names itself.
  const html = `<option value="">${narrow.matches ? 'Highlight: none' : 'None'}</option>` + [...groups].map(([group, items]) =>
    `<optgroup label="${esc(group)}">${items.map(h =>
      `<option value="${esc(h.key)}">${esc(h.label)} (${count(h)})</option>`).join('')}</optgroup>`).join('');
  if (html !== els.highlight.dataset.html) {
    els.highlight.innerHTML = html;
    els.highlight.dataset.html = html;
    els.highlight.value = state.highlight;
  }
}

function renderPlanner() {
  const { map, taken, planned, ready, skipped } = state;
  const picking = isPicking();
  const nTaken = [...taken].filter(id => map.get(id)).length;
  const nPlanned = [...planned].filter(id => map.get(id)).length;
  const start = `<button type="button" class="tool-btn" data-action="${picking ? 'stop-picking' : 'start-picking'}" aria-pressed="${picking}"
    title="Select several courses, then mark them taken or planned">${statusIcon('taken')}<span class="wide-only">Mark courses</span><span class="narrow-only">Mark</span></button>`;
  // Courses marked "not interested": a count that shows them again (faded).
  const nSkipped = [...skipped].filter(id => map.get(id)).length;
  const hidden = nSkipped ? `<button type="button" class="stat-btn" data-action="toggle-skipped" aria-pressed="${state.showSkipped}"
    title="${state.showSkipped ? 'Hide them again' : 'Show them on the map'}">${statusIcon('skip')}<b>${nSkipped}</b> <span class="stat-label">hidden</span></button>` : '';
  if (!nTaken && !nPlanned) {
    els.planner.innerHTML = `${nSkipped ? `<span class="plan-stats">${hidden}</span>` : ''}${start}`;
    return;
  }
  // Each count highlights its courses on the map.
  const stat = (key, kind, n, label) => `<button type="button" class="stat-btn" data-highlight="${key}"
    aria-pressed="${state.highlight === key}"${n ? '' : ' disabled'} title="Highlight them">${statusIcon(kind)}<b>${n}</b> <span class="stat-label">${label}</span></button>`;
  els.planner.innerHTML = `<span class="plan-stats">${stat('plan:taken', 'taken', nTaken, 'taken')}${
    stat('plan:planned', 'planned', nPlanned, 'planned')}${stat('plan:ready', 'ready', ready.size, 'can take now')}${hidden}</span>${start}`;
}

function optionHTML(c) {
  const map = state.map;
  const status = state.plan.status(c.id);
  const term = state.plan.term(c.id);
  const mine = status ? ` · ${STATUS_NAME[status]}${term ? ` ${termLabel(term)}` : ''}` : '';
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

// Hovering over a course (or focusing it with the keyboard) shows its details
// in the panel until the pointer moves off, unless a course is selected or
// courses are being marked. A short delay keeps the panel still while the
// pointer crosses the map; moving into the panel keeps the preview there.
let previewTimer;
function preview(id) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (id && (state.selected || isPicking() || narrow.matches)) return;
    if (!id && els.panel.matches(':hover')) return;
    if ((id || null) === state.preview) return;
    state.preview = id || null;
    renderPanel(els.panel, { map: state.map, state, repo: repoSlug() });
    els.panel.scrollTop = 0;
    panelSubject = state.preview || state.highlight;
  }, id ? 200 : 300);
}

function select(id, { source = 'panel', toggle = false } = {}) {
  clearTimeout(previewTimer);
  state.preview = null;
  const map = state.map;
  if (!map || (id && !map.get(id))) return;
  // Shift, Cmd or Ctrl-click picks several courses; while picking, any click does.
  if (toggle || isPicking()) {
    if (id) togglePick(id);
    else if (!toggle && !state.picking) stopPicking(); // a plain click on empty space
    return;
  }
  // On a course page another course opens its own page; the course itself
  // stays open (or comes back from a path).
  if (state.page === 'course') {
    if (id && id !== state.focus) go(courseHref(id));
    else if (id && showingPath()) setHighlight('');
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
  state.preview = null;
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
const STATUS_DONE = { taken: 'marked taken', planned: 'marked planned', skip: 'marked not interested', '': 'removed from your plan' };
const STATUS_NAME = { taken: 'taken', planned: 'planned', skip: 'not interested' };

// Taken / planned / not taken for one or more courses. A course keeps its
// quarter only if it still fits (taken courses sit in past quarters, plans in
// the current one or later).
function setStatus(ids, status) {
  const { map } = state;
  const what = ids.length === 1 ? map.label(map.get(ids[0])) : countText(ids.length);
  // Undoing "not interested" puts the courses back on the map.
  const back = !status && ids.every(id => state.plan.status(id) === 'skip');
  changePlan(`${what} ${back ? `${ids.length === 1 ? 'is' : 'are'} back on your map` : STATUS_DONE[status || '']}.`, plan => {
    for (const id of ids) {
      const term = plan.term(id);
      const keep = term && status !== 'skip' && (status === 'taken' ? termOrder(term) <= termOrder(currentTerm()) : !isPast(term));
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

// T, P, N and X: the selected courses, else the focused or open one.
function quickMark(status) {
  if (state.picked.size) {
    markPicked(status);
    return;
  }
  const el = document.activeElement;
  const id = el?.closest?.('.node')?.dataset.id || el?.closest?.('[data-select]')?.dataset.select || state.selected;
  if (id && state.map.get(id)) mark([id], status);
}

// Every way of setting a status comes here: "not interested" checks first.
function mark(ids, status) {
  if (status === 'skip') hideCourses(ids);
  else setStatus(ids, status);
}

// The selected courses; they stay selected if the student cancels hiding them.
function markPicked(status) {
  if (status === 'skip') hideCourses([...state.picked]);
  else setStatus(takePicked(), status);
}

// "Not interested": the courses leave the map. If one is required (by the
// student's programs, or by a course they need or planned), ask first.
async function hideCourses(ids) {
  const { map } = state;
  const reasons = dropWarnings(map, state.activePrograms, state.plan, ids);
  if (reasons.length) {
    const ok = await confirmDialog({
      title: ids.length === 1 ? `You need ${map.label(map.get(ids[0]))}` : 'You need some of these courses',
      reasons,
      action: 'Hide anyway',
    });
    if (!ok) {
      render(); // puts a list row's menu back
      return;
    }
  }
  ids.forEach(id => state.picked.delete(id));
  setStatus(ids, 'skip');
}

// A yes/no question in a dialog; resolves true for the action.
function confirmDialog({ title, reasons, action }) {
  const d = els.confirm;
  d.querySelector('#confirm-title').textContent = title;
  d.querySelector('.confirm-reasons').innerHTML = reasons.map(r => `<li>${ICON.warn}<span>${esc(r)}</span></li>`).join('');
  d.querySelector('[value="ok"]').textContent = action;
  d.showModal();
  d.querySelector('[value="cancel"]').focus();
  // Answer from the buttons (and Escape) directly: the dialog's "close" event
  // can arrive late or not at all.
  return new Promise(resolve => {
    const done = ok => {
      d.removeEventListener('click', onClick);
      d.removeEventListener('cancel', onCancel);
      if (d.open) d.close();
      resolve(ok);
    };
    const onClick = e => {
      const button = e.target.closest('button[value]');
      if (!button) return;
      e.preventDefault();
      done(button.value === 'ok');
    };
    const onCancel = e => {
      e.preventDefault();
      done(false);
    };
    d.addEventListener('click', onClick);
    d.addEventListener('cancel', onCancel);
  });
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

// The student's majors and minors; the map follows them (another major
// brings its department's courses in).
async function setPrograms(ids) {
  if (!ids.length) return;
  state.plan.setPrograms(ids);
  state.programIds = ids;
  const before = state.visible;
  if (!(await loadPrograms(ids))) {
    planChanged();
    renderProgramsDialog();
    return;
  }
  derive();
  if (state.selected && !state.map.get(state.selected)) state.selected = null;
  setStageStatus('');
  if (graph) {
    layoutGraph();
    syncInsets();
    graph.fitAll({ animate: false, minScale: 0.45 });
  }
  relayout(before);
  render({ history: 'push' });
  renderProgramsDialog();
  announce(`Showing ${state.map.name}.`);
}

// The topbar button names the programs on the map; its dialog changes them.
function syncProgramsButton() {
  const names = state.programIds.map(id => state.programIndex.get(id)?.short || id);
  els.programsBtn.querySelector('.programs-label').textContent = names.length > 2 ? `${names[0]} + ${names.length - 1} more` : names.join(' + ');
  els.programsBtn.title = state.programIds.map(id => state.programIndex.get(id)?.name || id).join(', ');
}

function renderProgramsDialog() {
  const chosen = new Set(state.programIds);
  const group = (type, title) => {
    const list = [...state.programIndex.values()].filter(p => p.type === type);
    return list.length ? `<fieldset class="prog-group"><legend>${title}</legend>${list.map(p => {
      const on = chosen.has(p.id);
      // The last program on the map stays: there'd be nothing to show without one.
      const last = on && chosen.size === 1;
      return `<label class="prog-option"><input type="checkbox" data-action="toggle-program" value="${esc(p.id)}"${
        on ? ' checked' : ''}${last ? ' disabled' : ''}><span>${esc(p.name)}</span></label>`;
    }).join('')}</fieldset>` : '';
  };
  els.programsList.innerHTML = group('major', 'Majors') + group('minor', 'Minors');
}

function openPrograms() {
  renderProgramsDialog();
  els.programsDialog.showModal();
}

function clearPlan() {
  const mine = Object.keys(state.plan.courses).filter(id => state.map.get(id) && state.plan.status(id) !== 'skip');
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

// Graph rows by prerequisite steps or by course level.
function setArrange(mode) {
  if (mode === state.arrange) return;
  state.arrange = mode;
  prefs.set('arrange', mode);
  graph?.setArrange(mode);
  syncArrange();
  if (state.page === 'course') {
    syncInsets();
    graph?.frame(state.focus, { animate: true });
  } else if (state.selected) revealSelected();
  else graph?.fitAll({ minScale: 0.45 });
  announce(mode === 'level' ? 'Rows are course levels.' : 'Rows are prerequisite steps.');
}

function syncArrange() {
  document.querySelectorAll('[data-arrange]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.arrange === state.arrange)));
  els.legendNote.textContent = state.arrange === 'level'
    ? 'Columns are departments. Each row is a course level (100, 200, 300).'
    : state.page === 'course' ? 'Columns are departments. Rows count the steps before and after this course.'
      : 'Columns are departments. Each row is a prerequisite step.';
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

// On phones the sheet's grip also drags: the sheet follows it and keeps the
// height it's left at, as a share of the screen. Dragged nearly shut, it
// closes to a peek.
const SHEET_MAX = 0.88;
let sheetDrag = null; // where a drag of the grip started: { y, h, moved }
let sheetDragged = false; // the click that ends a drag doesn't also toggle the sheet
const sheetPeek = () => (isPicking() ? SHEET_PEEK_PICKING : SHEET_PEEK);

function useSheetHeight(share) {
  els.panel.style.setProperty('--sheet-h', share ? `${(share * 100).toFixed(1)}vh` : '');
}
useSheetHeight(prefs.get('sheet', null));

els.panel.addEventListener('pointerdown', e => {
  if (!narrow.matches || e.button || !e.target.closest('.panel-grip')) return;
  const collapsed = els.panel.classList.contains('is-collapsed');
  sheetDrag = { y: e.clientY, h: collapsed ? sheetPeek() : els.panel.offsetHeight, moved: false };
  e.target.setPointerCapture(e.pointerId);
});
els.panel.addEventListener('pointermove', e => {
  if (!sheetDrag || (!sheetDrag.moved && Math.abs(e.clientY - sheetDrag.y) < 6)) return;
  sheetDrag.moved = true;
  const h = Math.max(sheetPeek(), Math.min(window.innerHeight * SHEET_MAX, sheetDrag.h + sheetDrag.y - e.clientY));
  els.panel.classList.add('is-dragging');
  els.panel.classList.remove('is-collapsed');
  els.panel.style.setProperty('--sheet-h', `${Math.round(h)}px`);
});
els.panel.addEventListener('lostpointercapture', () => {
  const drag = sheetDrag;
  sheetDrag = null;
  if (!drag?.moved) return;
  els.panel.classList.remove('is-dragging');
  sheetDragged = true;
  setTimeout(() => { sheetDragged = false; }, 400);
  if (els.panel.offsetHeight < sheetPeek() + 60) {
    els.panel.classList.add('is-collapsed');
    useSheetHeight(prefs.get('sheet', null));
  } else {
    const share = els.panel.offsetHeight / window.innerHeight;
    prefs.set('sheet', share);
    useSheetHeight(share);
  }
  revealSelected({ force: false });
});

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

// ---------------------------------------------------------------- home

// The toggle above the search box. On the home page it switches what the box
// finds; elsewhere it goes back home to that side.
function chooseMode(mode) {
  if (state.page !== 'home') {
    go(homeHref(mode, state.homeQuery[mode].trim()));
    return;
  }
  if (mode === state.homeTab) return;
  state.homeTab = mode;
  render();
  els.homeSearch.focus();
}

// A suggestion under the home search box: search for it.
function searchFor(query) {
  state.homeQuery.search = query;
  render();
  els.homeSearch.focus();
}

els.homeSearch.addEventListener('input', () => {
  state.homeQuery[state.homeTab] = els.homeSearch.value;
  render();
});

// Enter opens the first result; the arrow keys move between the results.
els.home.addEventListener('keydown', e => {
  const links = [...els.homeResults.querySelectorAll('a[data-route]')];
  if (e.target === els.homeSearch) {
    if (e.key === 'Enter' && links.length) {
      e.preventDefault();
      links[0].click();
    } else if (e.key === 'ArrowDown' && links.length) {
      e.preventDefault();
      links[0].focus();
    }
    return;
  }
  const i = links.indexOf(e.target);
  if (i < 0 || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  e.preventDefault();
  if (e.key === 'ArrowUp' && i === 0) els.homeSearch.focus();
  else links[Math.max(0, Math.min(links.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
});

// ---------------------------------------------------------------- splitter
// The edge between the graph and the details panel can be dragged (or moved
// with the arrow keys) to give either more room. A course page and a degree
// map each remember their split, as a share of the window; a course page
// starts with more room for its course.

const PANEL_MIN = 300;
const STAGE_MIN = 320;
let panelPx = 0; // the panel's width now
let grab = null; // where a drag of the splitter started: { x, w }
let splitTimer;
const splitPref = page => (page === 'course' ? 'split.course' : 'split.map');
const workspaceWidth = () => els.workspace.clientWidth || window.innerWidth;

function savedPanelWidth(page = document.body.dataset.page) {
  const total = workspaceWidth();
  const share = prefs.get(splitPref(page), null);
  if (share) return share * total;
  return page === 'course' ? Math.min(720, Math.max(400, total * 0.42)) : 380;
}

// `pan` keeps what's in the middle of the graph in the middle while the user resizes.
function setPanelWidth(px, { pan = false } = {}) {
  const total = workspaceWidth();
  const w = Math.round(Math.max(PANEL_MIN, Math.min(total - STAGE_MIN, px)));
  if (pan && panelPx && w !== panelPx) graph?.panBy(panelPx - w);
  panelPx = w;
  document.body.style.setProperty('--panel-w', `${w}px`);
  els.splitter.setAttribute('aria-valuemin', String(Math.round((PANEL_MIN / total) * 100)));
  els.splitter.setAttribute('aria-valuemax', String(Math.round(((total - STAGE_MIN) / total) * 100)));
  els.splitter.setAttribute('aria-valuenow', String(Math.round((w / total) * 100)));
}

function saveSplit() {
  prefs.set(splitPref(state.page), panelPx / workspaceWidth());
}

function resetSplit() {
  prefs.set(splitPref(state.page), undefined);
  setPanelWidth(savedPanelWidth(), { pan: true });
  afterResize();
}

// The stage changed size: the graph may suit other column counts now.
function afterResize() {
  if (state.page === 'home' || state.view !== 'graph' || !graph?.refit()) return;
  syncInsets();
  if (state.page === 'course') graph.frame(state.focus, { animate: true });
  else revealSelected({ force: false });
}

els.splitter.addEventListener('pointerdown', e => {
  if (e.button) return;
  e.preventDefault();
  els.splitter.setPointerCapture(e.pointerId);
  grab = { x: e.clientX, w: panelPx };
  document.body.classList.add('is-resizing');
});
els.splitter.addEventListener('pointermove', e => {
  if (grab) setPanelWidth(grab.w + grab.x - e.clientX, { pan: true });
});
els.splitter.addEventListener('lostpointercapture', () => {
  if (!grab) return;
  grab = null;
  document.body.classList.remove('is-resizing');
  saveSplit();
  afterResize();
});
els.splitter.addEventListener('dblclick', resetSplit);
// Left and right move the edge (Shift: further); Home and End take it as far as it goes.
els.splitter.addEventListener('keydown', e => {
  const step = e.shiftKey ? 120 : 40;
  const to = { ArrowLeft: panelPx + step, ArrowRight: panelPx - step, Home: PANEL_MIN, End: Infinity }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  setPanelWidth(to, { pan: true });
  saveSplit();
  clearTimeout(splitTimer);
  splitTimer = setTimeout(afterResize, 300);
});

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
  // Links between pages open here (with a modifier key, the browser handles them).
  const link = e.target.closest('a[data-route]');
  if (link) {
    if (!e.button && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      go(link.getAttribute('href'));
    }
    return;
  }
  // Tapping a collapsed sheet (anywhere but its buttons) expands it.
  if (narrow.matches && els.panel.classList.contains('is-collapsed') && e.target.closest('#panel')
      && !e.target.closest('[data-action], select')) {
    toggleSheet();
    return;
  }
  const t = e.target.closest('[data-select], [data-action], [data-highlight], [data-zoom], [data-view], [data-arrange], [data-depth], [data-mode], [data-query]');
  if (!t || t.disabled || t.tagName === 'SELECT') return;
  const { action, id } = t.dataset;
  const toggle = state.view !== 'plan' && (e.shiftKey || e.metaKey || e.ctrlKey);
  if (t.dataset.select) select(t.dataset.select, { source: t.closest('#list') ? 'list' : 'panel', toggle });
  // On a course page, a program's list opens that program's map, with the list highlighted.
  else if (t.dataset.highlight && t.dataset.program && state.page === 'course') {
    go(`${mapHref([t.dataset.program])}&${new URLSearchParams({ course: state.focus, hl: t.dataset.highlight })}`);
  }
  else if (t.dataset.highlight) setHighlight(state.highlight === t.dataset.highlight ? '' : t.dataset.highlight);
  else if (t.dataset.mode) chooseMode(t.dataset.mode);
  else if (t.dataset.query !== undefined) searchFor(t.dataset.query);
  else if (action === 'open-map') go(`${mapHref(t.dataset.programs.split(','))}&${new URLSearchParams({ course: state.focus })}`);
  else if (t.dataset.zoom) zoom(t.dataset.zoom);
  else if (t.dataset.view) setView(t.dataset.view);
  else if (t.dataset.arrange) setArrange(t.dataset.arrange);
  else if (t.dataset.depth) setDepth(t.dataset.depth === 'all' ? 'all' : Number(t.dataset.depth));
  else if (action === 'close') select(null);
  else if (action === 'set-status') mark([id], t.dataset.status);
  else if (action === 'pick-status') markPicked(t.dataset.status);
  else if (action === 'toggle-skipped') {
    state.showSkipped = !state.showSkipped;
    planChanged();
  }
  else if (action === 'start-picking') startPicking();
  else if (action === 'stop-picking') stopPicking();
  else if (action === 'unpick') togglePick(id);
  else if (action === 'pick-chain') pickCourses([id, ...[...state.map.requiredAncestors(id)].filter(c => state.visible.has(c))]);
  else if (action === 'show-path') showPath(id);
  else if (action === 'toggle-more') {
    if (!state.expanded.delete(t.dataset.key)) state.expanded.add(t.dataset.key);
    render();
  }
  else if (action === 'open-programs') openPrograms();
  else if (action === 'plan-path') planPath(id);
  else if (action === 'undo') undo();
  else if (action === 'add-to-term') startAdding(t.dataset.term);
  else if (action === 'remove-program') setPrograms(state.programIds.filter(p => p !== t.dataset.program));
  else if (action === 'clear-plan') clearPlan();
  else if (action === 'clear-highlight') setHighlight('');
  else if (action === 'toggle-sheet' && !sheetDragged) toggleSheet();
  else if (action === 'reload') window.location.reload();
});

// Selects in the panel, list and plan view.
document.addEventListener('change', e => {
  const t = e.target;
  const { action, id } = t.dataset;
  if (action === 'set-status') mark([id], t.value);
  else if (action === 'set-term') setCourseTerm(id, t.value);
  else if (action === 'pick-term' && t.value) moveToTerm(takePicked(), t.value);
  else if (action === 'add-program' && t.value) setPrograms([...state.programIds, t.value]);
  else if (action === 'toggle-program') {
    setPrograms(t.checked ? [...state.programIds, t.value] : state.programIds.filter(id => id !== t.value));
  }
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
$('#show-options').addEventListener('change', e => setShowOptions(e.target.checked));
// The panel keeps its share of the window; the layout picks column counts to suit the stage's shape.
let resizeTimer;
window.addEventListener('resize', () => {
  if (state.page !== 'home') setPanelWidth(savedPanelWidth());
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(afterResize, 250);
});
els.showExternal.addEventListener('change', () => setShowExternal(els.showExternal.checked));
narrow.addEventListener('change', () => state.map && syncControls());
els.programsBtn.addEventListener('click', openPrograms);
els.programsDialog.addEventListener('click', e => { if (e.target === els.programsDialog) els.programsDialog.close(); });
$('#help-btn').addEventListener('click', () => els.help.showModal());
els.help.addEventListener('click', e => { if (e.target === els.help) els.help.close(); });
els.themeBtn.addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  prefs.set('theme', next);
  syncThemeButton();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeButton);
window.addEventListener('popstate', () => route(readURL()).catch(loadFailed));
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
    (state.page === 'home' ? els.homeSearch : els.search).focus();
  } else if (state.page === 'home') {
    // The home page has no courses to mark or zoom.
  } else if (e.key === 'Escape' && (isPicking() || state.selected || state.highlight)) {
    // Step back one level: the multi-selection, the selected course, then the
    // highlight. A course page's course stays.
    if (isPicking()) stopPicking();
    else if (state.page === 'course') {
      if (state.highlight) setHighlight('');
    }
    else if (state.selected) select(null);
    else setHighlight('');
  } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const status = { t: 'taken', p: 'planned', n: '', x: 'skip' }[e.key.toLowerCase()];
    if (status !== undefined && state.view !== 'plan') quickMark(status);
    else if (e.key === '+' || e.key === '=') zoom('in');
    else if (e.key === '-' || e.key === '_') zoom('out');
    else if (e.key === '0') zoom('fit');
  }
});

// Leaving the panel ends a preview it was showing.
els.panel.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && state.preview) preview(null); });

// The toast stays while the pointer is on it.
els.toast.addEventListener('pointerenter', () => clearTimeout(toastTimer));
els.toast.addEventListener('pointerleave', () => hideToastLater(2500));

init();
