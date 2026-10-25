// List view: every course grouped by department, filterable, with a
// "taken" checkbox per row. Doubles as the accessible alternative to the graph.
import { esc } from './panel.js';

export function renderList(el, { map, state, query }) {
  const hl = state.highlight ? map.highlight(state.highlight) : null;
  const matches = query.trim() ? new Set(map.search(query, Infinity).map(c => c.id)) : null;
  const shown = map.courses.filter(c => (state.showExternal || c.role === 'main')
    && (!hl || hl.ids.has(c.id)) && (!matches || matches.has(c.id)));

  const filters = [hl && `in “${esc(hl.label)}”`, matches && `matching “${esc(query.trim())}”`].filter(Boolean);
  let html = `<p class="list-summary">Showing ${shown.length} of ${map.courses.length} courses${
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
  const status = map.status(c, state.taken);
  const planning = [...state.taken].some(id => map.get(id));
  const tags = [];
  if (status === 'taken') tags.push('<span class="tag status-taken">✓ Taken</span>');
  else if (planning && status === 'available') tags.push('<span class="tag status-available">Can take</span>');
  for (const q of map.quarters) {
    if (c.offered?.[q]) tags.push(`<span class="tag" title="Offered ${esc(q)}">${esc(q[0])}<span class="sr-only">, offered ${esc(q)}</span></span>`);
  }
  let req;
  if (c.role !== 'main') req = 'Other department';
  else if (c.prereq) req = `Requires ${map.treeText(c.prereq)}`;
  else if (c.notes.length) req = c.notes.join(', ');
  else req = 'No prerequisites';
  return `<li class="course-row${state.selected === c.id ? ' is-selected' : ''}">
    <label class="row-check" title="I've taken this">
      <input type="checkbox" data-action="toggle-taken" data-id="${esc(c.id)}"${state.taken.has(c.id) ? ' checked' : ''}>
      <span class="sr-only">Mark ${esc(label)} as taken</span>
    </label>
    <button type="button" class="row-main" data-select="${esc(c.id)}">
      <span class="row-code">${esc(label)}</span>
      <span class="row-title">${esc(c.title || 'Not in the current catalog')}</span>
      <span class="row-tags">${tags.join('')}</span>
      <span class="row-req">${esc(req)}</span>
    </button>
  </li>`;
}
