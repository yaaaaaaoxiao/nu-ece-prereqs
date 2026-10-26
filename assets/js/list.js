// List view: every course grouped by department, with quick filters, your
// plan status per row and the quarters each course runs. Doubles as the
// accessible alternative to the graph. Shift-click rows to select several,
// as on the graph.
import { esc, statusIcon } from './panel.js';
import { termLabel } from './plan.js';

// Quick filters: the "your plan" highlights (see derive() in main.js).
const FILTERS = [
  ['plan:ready', 'Can take now'],
  ['plan:taken', 'Taken'],
  ['plan:planned', 'Planned'],
];

export function renderList(el, { map, state, query }) {
  const hl = state.highlight ? map.highlight(state.highlight) : null;
  const matches = query.trim() ? new Set(map.search(query, Infinity).map(c => c.id)) : null;
  // The same courses as the graph (this map's, what they require, and your programs').
  const pool = map.courses.filter(c => state.visible.has(c.id));
  const shown = pool.filter(c => (!hl || hl.ids.has(c.id)) && (!matches || matches.has(c.id)));

  const inPool = key => pool.filter(c => map.highlight(key)?.ids.has(c.id)).length;
  const chip = (attrs, label, n, pressed, off) => `<button type="button" class="filter-chip" ${attrs}
    aria-pressed="${pressed}"${off ? ' disabled' : ''}>${label} <span class="n">${n}</span></button>`;
  const filters = `<div class="list-filters" role="group" aria-label="Show">
    ${chip('data-action="clear-highlight"', 'All', pool.length, !state.highlight, false)}
    ${FILTERS.map(([key, label]) => {
      const n = inPool(key);
      return chip(`data-highlight="${key}"`, label, n, state.highlight === key, !n);
    }).join('')}
  </div>`;

  const notes = [hl && !FILTERS.some(([key]) => key === state.highlight) && `in “${esc(hl.label)}”`,
    matches && `matching “${esc(query.trim())}”`].filter(Boolean);
  let html = `${filters}<p class="list-summary">${shown.length === pool.length
    ? `${pool.length} courses` : `${shown.length} of ${pool.length} courses`}${notes.length ? ` ${notes.join(' ')}` : ''}</p>`;
  if (!shown.length) {
    el.innerHTML = `${html}<p class="list-empty">No courses match. Change the search or the filter.</p>`;
    return;
  }

  for (const dept of Object.keys(map.data.departments)) {
    const rows = shown.filter(c => c.dept === dept).sort((a, b) => a.num.localeCompare(b.num));
    if (!rows.length) continue;
    const info = map.data.departments[dept];
    html += `<section><h2>${esc(info.name)} <span class="muted">· ${esc(info.abbr || dept)}</span></h2>
      <ul class="course-list">${rows.map(c => rowHTML(map, c, state)).join('')}</ul></section>`;
  }
  el.innerHTML = html;
}

function rowHTML(map, c, state) {
  const label = map.label(c);
  const mine = state.plan.status(c.id);
  let tag = '';
  if (mine === 'taken') tag = `<span class="tag status-taken">${statusIcon('taken')}Taken</span>`;
  else if (mine === 'planned') {
    const term = state.plan.term(c.id);
    tag = `<span class="tag status-planned">${statusIcon('planned')}${term ? esc(termLabel(term)) : 'Planned'}</span>`;
  } else if (mine === 'skip') {
    tag = `<span class="tag status-skip">${statusIcon('skip')}Not interested</span>`;
  } else if (state.ready.has(c.id)) {
    tag = `<span class="tag status-ready">${statusIcon('ready')}Can take now</span>`;
  }
  let req;
  if (c.role !== 'main') req = 'Another department';
  else if (c.prereq) req = `Requires ${map.treeText(c.prereq)}`;
  else if (c.notes.length) req = c.notes.join(', ');
  else req = 'No prerequisites';
  const option = (value, text) => `<option value="${value}"${(mine || '') === value ? ' selected' : ''}>${text}</option>`;
  return `<li class="course-row${state.selected === c.id ? ' is-selected' : ''}${state.picked.has(c.id) ? ' is-picked' : ''}">
    <label class="row-status">
      <span class="sr-only">Your plan for ${esc(label)}</span>
      <select data-action="set-status" data-id="${esc(c.id)}" class="is-${mine || 'none'}">
        ${option('', 'Not taken')}${option('planned', 'Planned')}${option('taken', 'Taken')}${option('skip', 'Not interested')}
      </select>
    </label>
    <button type="button" class="row-main" data-select="${esc(c.id)}">
      <span class="row-code">${esc(label)}</span>
      <span class="row-title">${esc(c.title || 'Not in the current catalog')}</span>
      <span class="row-tags">${tag}${offeredHTML(map, c)}</span>
      <span class="row-req">${esc(req)}</span>
    </button>
  </li>`;
}

// F W S, as on the map: dark where the course runs this year.
function offeredHTML(map, c) {
  const scheduled = map.quarters.length && (c.role === 'main' || Object.keys(c.offered || {}).length);
  if (!scheduled) return '';
  const on = map.quarters.filter(q => c.offered?.[q]);
  const text = on.length ? `Offered ${on.join(', ')}` : `Not on the ${map.scheduleLabel()} schedule`;
  return `<span class="row-offered" title="${esc(text)}"><span aria-hidden="true">${map.quarters.map(q =>
    `<span${c.offered?.[q] ? ' class="on"' : ''}>${esc(q[0])}</span>`).join('')}</span><span class="sr-only">${esc(text)}</span></span>`;
}
