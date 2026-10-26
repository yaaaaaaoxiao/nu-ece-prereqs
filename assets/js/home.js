// Home page: one search box with a toggle above it. "Search" finds courses
// (each opens its own page: the course and its prerequisite chain);
// "Pre-req graph" picks a major, whose map shows all its courses.
import { esc, statusIcon } from './panel.js';
import { offeredHTML } from './list.js';

const LIMIT = 100; // course results shown at once
const EXAMPLES = ['EE 221', 'signal', 'machine learning', 'robot'];
const STATUS = { taken: 'Taken', planned: 'Planned', skip: 'Not interested' };

export const courseHref = id => `?${new URLSearchParams({ course: id })}`;
export const mapHref = ids => `?${new URLSearchParams({ programs: ids.join(',') })}`;

export function renderHome(el, { state, maps }) {
  const tab = state.homeTab;
  const query = state.homeQuery[tab];
  const input = el.querySelector('#home-search');
  if (input.value !== query) input.value = query;
  input.placeholder = tab === 'search' ? 'Search courses, e.g. EE 221' : 'Find a major, e.g. computer science';
  input.setAttribute('aria-label', tab === 'search' ? 'Search courses' : 'Find a major');
  el.classList.toggle('has-query', !!query.trim());
  el.querySelector('#home-lede').textContent = tab === 'search'
    ? 'Find a course and see everything it requires.'
    : 'Pick a major to see all its courses and how they connect.';
  el.querySelector('#home-results').innerHTML = tab === 'search'
    ? coursesHTML(state.all, state, query) : majorsHTML(state, maps, query);
}

// ----------------------------------------------------------------- courses

function coursesHTML(all, state, query) {
  if (!all) return '<p class="home-note">Loading courses…</p>';
  if (!query.trim()) return startHTML(all);
  const found = all.search(query, Infinity);
  if (!found.length) {
    return `<p class="home-note">No courses match “${esc(query.trim())}”. Search by number (EE 221) or by words in the title.</p>`;
  }
  const count = found.length > LIMIT ? `${LIMIT} of ${found.length} courses. Add words to narrow them down.`
    : `${found.length} course${found.length === 1 ? '' : 's'}`;
  return `<p class="home-count">${count}</p>
    <ul class="results">${found.slice(0, LIMIT).map(c => courseHTML(all, c, state)).join('')}</ul>`;
}

// Before anything is typed: a few searches to try, and the departments.
function startHTML(all) {
  const depts = Object.entries(all.data.departments).filter(([, d]) => d.main);
  const pill = (query, text) => `<button type="button" class="pill" data-query="${esc(query)}">${esc(text)}</button>`;
  return `<div class="home-start">
    <p><span class="muted">Try</span> ${EXAMPLES.map(q => pill(q, q)).join('')}</p>
    <p><span class="muted">Browse</span> ${depts.map(([code, d]) => pill(d.abbr || code, d.name)).join('')}</p>
  </div>`;
}

function courseHTML(map, c, state) {
  const status = state.plan.status(c.id);
  const mark = status ? `<span class="r-status" title="${STATUS[status]}">${statusIcon(status)}<span class="sr-only">${STATUS[status]}</span></span>` : '';
  return `<li><a class="result" href="${esc(courseHref(c.id))}" data-route>
    <span class="r-code">${esc(map.label(c))}</span>
    <span class="r-title">${esc(c.title || 'Not in the current catalog')}</span>
    <span class="r-side">${mark}${offeredHTML(map, c)}</span>
    <span class="r-meta">${esc(map.deptName(c))} · ${esc(needsText(map, c))}</span>
  </a></li>`;
}

// What a course requires, in a few words. Other departments' prerequisites
// are known only when the catalog sentence was plain enough to read.
function needsText(map, c) {
  const tree = c.role === 'main' ? c.prereq : c.autoPrereq;
  if (tree) return `Requires ${map.treeText(tree)}`;
  if (c.role !== 'main' && !('autoPrereq' in c)) return 'Prerequisites: see the catalog';
  return c.notes?.length ? c.notes.join(', ') : 'No prerequisites';
}

// ------------------------------------------------------------------ majors

// The student's own programs first (they may include minors), then every
// major. A minor is added from a major's map.
function majorsHTML(state, maps, query) {
  const words = query.trim().toLowerCase();
  const fits = p => !words || `${p.name} ${p.short || ''}`.toLowerCase().includes(words);
  const own = (state.plan.chosenPrograms() || []).map(id => state.programIndex.get(id)).filter(Boolean);
  const majors = [...state.programIndex.values()].filter(p => p.type === 'major' && fits(p));
  const mapName = p => maps.find(m => m.id === p.home)?.name || '';
  const link = (ids, title, meta) => `<li><a class="result result-program" href="${esc(mapHref(ids))}" data-route>
    <span class="r-title">${esc(title)}</span><span class="r-meta">${esc(meta)}</span></a></li>`;
  const yours = own.length && own.some(fits)
    ? `<h3 class="home-group">Yours</h3><ul class="results">${
      link(own.map(p => p.id), own.map(p => p.short || p.name).join(' + '), 'Your majors and minors')}</ul>` : '';
  const list = majors.length
    ? `<h3 class="home-group">Majors</h3><ul class="results">${majors.map(p => link([p.id], p.name, mapName(p))).join('')}</ul>`
    : `<p class="home-note">No major matches “${esc(query.trim())}”.</p>`;
  return `${yours}${list}<p class="home-note">To add a minor, open a major and press its programs button.</p>`;
}
