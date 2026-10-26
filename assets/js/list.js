// List view: every course grouped by department, filterable, with a plan
// status per row. Doubles as the accessible alternative to the graph.
// Shift-click rows to select several, as on the graph.
import { esc, statusIcon } from './panel.js';
import { termLabel } from './plan.js';

export function renderList(el, { map, state, query }) {
  const hl = state.highlight ? map.highlight(state.highlight) : null;
  const matches = query.trim() ? new Set(map.search(query, Infinity).map(c => c.id)) : null;
  // The same courses as the graph (this map's, what they require, and your programs').
  const pool = map.courses.filter(c => state.visible.has(c.id));
  const shown = pool.filter(c => (!hl || hl.ids.has(c.id)) && (!matches || matches.has(c.id)));

  const filters = [hl && `in “${esc(hl.label)}”`, matches && `matching “${esc(query.trim())}”`].filter(Boolean);
  let html = `<p class="list-summary">Showing ${shown.length} of ${pool.length} courses${
    filters.length ? ` ${filters.join(' ')}` : ''}.</p>`;
  if (!shown.length) {
    el.innerHTML = `${html}<p class="list-empty">Nothing matches. Try another search or highlight.</p>`;
    return;
  }

  for (const dept of Object.keys(map.data.departments)) {
    const rows = shown.filter(c => c.dept === dept).sort((a, b) => a.num.localeCompare(b.num));
    if (!rows.length) continue;
    html += `<section><h2>${esc(map.data.departments[dept].name)} <span class="muted">(${esc(dept)})</span></h2>
      <ul class="course-list">${rows.map(c => rowHTML(map, c, state)).join('')}</ul></section>`;
  }
  el.innerHTML = html;
}

function rowHTML(map, c, state) {
  const label = map.label(c);
  const mine = state.plan.status(c.id);
  const tags = [];
  if (mine === 'taken') tags.push(`<span class="tag status-taken">${statusIcon('taken')}Taken</span>`);
  else if (mine === 'planned') {
    const term = state.plan.term(c.id);
    tags.push(`<span class="tag status-planned">${statusIcon('planned')}${term ? esc(termLabel(term)) : 'Planned'}</span>`);
  } else if (state.ready.has(c.id)) {
    tags.push(`<span class="tag status-ready">${statusIcon('ready')}Can take now</span>`);
  }
  for (const q of map.quarters) {
    if (c.offered?.[q]) tags.push(`<span class="tag" title="Offered ${esc(q)}">${esc(q[0])}<span class="sr-only">, offered ${esc(q)}</span></span>`);
  }
  let req;
  if (c.role !== 'main') req = 'Other department';
  else if (c.prereq) req = `Requires ${map.treeText(c.prereq)}`;
  else if (c.notes.length) req = c.notes.join(', ');
  else req = 'No prerequisites';
  const option = (value, text) => `<option value="${value}"${(mine || '') === value ? ' selected' : ''}>${text}</option>`;
  return `<li class="course-row${state.selected === c.id ? ' is-selected' : ''}${state.picked.has(c.id) ? ' is-picked' : ''}">
    <label class="row-status">
      <span class="sr-only">Your plan for ${esc(label)}</span>
      <select data-action="set-status" data-id="${esc(c.id)}" class="${mine ? `is-${mine}` : ''}">
        ${option('', '—')}${option('planned', 'Planned')}${option('taken', 'Taken')}
      </select>
    </label>
    <button type="button" class="row-main" data-select="${esc(c.id)}">
      <span class="row-code">${esc(label)}</span>
      <span class="row-title">${esc(c.title || 'Not in the current catalog')}</span>
      <span class="row-tags">${tags.join('')}</span>
      <span class="row-req">${esc(req)}</span>
    </button>
  </li>`;
}
