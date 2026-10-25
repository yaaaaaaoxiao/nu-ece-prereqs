// Details panel: the selected course, or an introduction when nothing is selected.
import { satisfied, unmet } from './model.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const ICON = {
  close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>',
  external: '<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8"/></svg>',
};
const STATUS_ICON = {
  taken: '<svg class="status-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="m4.8 8.2 2.2 2.2 4.2-4.4"/></svg>',
  available: '<svg class="status-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/></svg>',
  blocked: '<svg class="status-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/></svg>',
};
const LINK_NOTE = { alt: 'one option', co: 'corequisite', rec: 'recommended' };

// The panel follows the current focus: a course, else a highlighted list, else the intro.
export function renderPanel(el, { map, state, repo }) {
  const course = state.selected && map.get(state.selected);
  const hl = !course && state.highlight && map.highlight(state.highlight);
  let body;
  if (course) body = courseHTML(map, course, state, repo);
  else if (hl) body = highlightHTML(map, hl, state);
  else body = introHTML(map);
  // The grip only shows on phones, where the panel is a collapsible bottom sheet.
  el.innerHTML = `<button type="button" class="panel-grip" data-action="toggle-sheet"
    aria-label="Show or hide course details"></button>${body}`;
}

// ---------------------------------------------------------------- highlight

function highlightHTML(map, hl, state) {
  const { taken } = state;
  const planning = [...taken].some(id => map.get(id));
  const courses = [...hl.ids].map(id => map.get(id))
    .sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'main' ? -1 : 1));
  const done = courses.filter(c => taken.has(c.id)).length;
  const items = courses.map(c => {
    const note = planning && map.status(c, taken) === 'available' ? 'can take now' : '';
    return `<li>${chip(map, c.id, taken, 'none', note)}</li>`;
  }).join('');
  return `
    <div class="panel-head">
      <div>
        <p class="eyebrow">${esc(hl.group)}</p>
        <h2>${esc(hl.label)}</h2>
      </div>
      <button type="button" class="icon-btn" data-action="clear-highlight" aria-label="Stop highlighting">${ICON.close}</button>
    </div>
    <section>
      <p class="muted">${courses.length} course${courses.length === 1 ? '' : 's'}${planning ? `, ${done} taken` : ''}.
        Select one to see what it requires.</p>
      <ul class="chip-list">${items}</ul>
      ${hl.unlisted.length ? `<p class="muted" style="margin-top:10px">The degree page also lists ${
        esc(hl.unlisted.join(', '))}, which ${hl.unlisted.length === 1 ? "isn't" : "aren't"} in the undergraduate catalog.</p>` : ''}
      ${hl.url ? `<div class="links" style="margin-top:12px"><a href="${esc(hl.url)}" target="_blank" rel="noopener">Degree requirements ${ICON.external}</a></div>` : ''}
    </section>`;
}

// ------------------------------------------------------------------ course

function courseHTML(map, c, state, repo) {
  const isTaken = state.taken.has(c.id);
  const units = c.units ? ` · ${c.units} unit${c.units === 1 ? '' : 's'}` : '';
  return `
    <div class="panel-head">
      <div>
        <p class="eyebrow">${esc(map.deptName(c))}${units}</p>
        <h2><span class="code">${esc(c.id)}</span>${esc(c.title || 'Not in the current catalog')}</h2>
      </div>
      <button type="button" class="icon-btn" data-action="close" aria-label="Close details">${ICON.close}</button>
    </div>
    <div class="panel-actions">
      <button type="button" class="btn" data-action="toggle-taken" data-id="${esc(c.id)}" aria-pressed="${isTaken}">
        ${ICON.check}${isTaken ? 'Taken' : 'Mark as taken'}
      </button>
    </div>
    ${statusHTML(map, c, state.taken)}
    ${requirementsHTML(map, c, state.taken)}
    ${unlocksHTML(map, c, state.taken)}
    ${degreesHTML(map, c, state.highlight)}
    ${scheduleHTML(map, c)}
    ${sourceHTML(map, c, repo)}`;
}

function statusHTML(map, c, taken) {
  const planning = [...taken].some(id => map.get(id));
  const status = map.status(c, taken);
  if (status === 'taken') return `<p class="status taken">${STATUS_ICON.taken}<span>You've marked this as taken.</span></p>`;
  if (!planning || !status) return '';
  if (status === 'available') {
    const extra = c.notes.filter(n => !n.startsWith('or '));
    return `<p class="status available">${STATUS_ICON.available}<span>You can take this now${
      extra.length ? ` <span class="muted">(also: ${esc(extra.join(', '))})</span>` : ''}</span></p>`;
  }
  const parts = c.prereq.and || [c.prereq];
  const missing = unmet(c.prereq, taken).length;
  return `<p class="status blocked">${STATUS_ICON.blocked}<span>Not yet: ${
    parts.length === 1 ? 'the prerequisite below is' : `${missing} of ${parts.length} requirements below are`} still needed.</span></p>`;
}

function requirementsHTML(map, c, taken) {
  if (c.role !== 'main') {
    const linked = map.parents.get(c.id).map(e => e.source);
    return `<section><h3>Prerequisites</h3>
      <p class="muted">Courses from other departments are here for context. Their prerequisites are read
      automatically and not checked, so rely on the catalog text below.</p>
      ${linked.length ? `<p>Linked on this map:</p>${chipList(map, linked, taken, 'up')}` : ''}
    </section>`;
  }
  const notes = c.notes.length
    ? `<ul class="notes">${c.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  let html = `<section><h3>Prerequisites</h3>${
    c.prereq ? treeHTML(map, c.prereq, taken, 'up') : '<p class="muted">No course prerequisites listed.</p>'}${notes}</section>`;
  if (c.coreq) html += `<section><h3>Take at the same time</h3>${treeHTML(map, c.coreq, taken, 'up')}</section>`;
  if (c.recommended.length) html += `<section><h3>Recommended first</h3>${chipList(map, c.recommended, taken, 'up')}</section>`;
  return html;
}

function unlocksHTML(map, c, taken) {
  const links = [...map.children.get(c.id)].sort((a, b) => a.target.localeCompare(b.target));
  if (!links.length) {
    return '<section><h3>Unlocks</h3><p class="muted">No course on this map lists it as a prerequisite.</p></section>';
  }
  const total = map.descendants(c.id).size;
  const items = links.map(e => `<li>${chip(map, e.target, taken, 'down', LINK_NOTE[e.kind])}</li>`).join('');
  return `<section><h3>Unlocks</h3><ul class="chip-list">${items}</ul>${
    total > links.length ? `<p class="muted" style="margin-top:8px">Leads to ${total} courses in all, counting later steps.</p>` : ''}</section>`;
}

function degreesHTML(map, c, activeKey) {
  const groups = map.membership.get(c.id) || [];
  if (!groups.length) return '';
  const items = groups.map(m => `<li><button type="button" data-highlight="${esc(m.key)}" aria-pressed="${m.key === activeKey}"
      title="Highlight every course in this list"><span class="d-name">${esc(m.degree.name)}</span>
      <span class="d-group">${esc(m.group.label)}</span></button></li>`).join('');
  return `<section><h3>Counts toward</h3><ul class="degree-list">${items}</ul></section>`;
}

function scheduleHTML(map, c) {
  if (!map.quarters.length) return '';
  const offered = c.offered || {};
  const any = Object.keys(offered).length > 0;
  if (!any && c.role !== 'main') return '';
  if (!any) return `<section><h3>Schedule</h3><p class="muted">Not on the ${esc(map.scheduleLabel())} schedule.</p></section>`;
  const rows = map.quarters.map(q => `<tr><th scope="row">${esc(q)}</th>${
    offered[q] ? `<td>${esc(offered[q])}</td>` : '<td class="none">Not offered</td>'}</tr>`).join('');
  return `<section><h3>Schedule</h3><table class="schedule"><tbody>${rows}</tbody></table></section>`;
}

function sourceHTML(map, c, repo) {
  let review;
  if (c.missing) review = "This course isn't in the current catalog. It may have been renumbered or retired.";
  else if (c.role !== 'main') review = 'Read automatically, not checked by hand.';
  else if (!c.text) review = '';
  else if (c.reviewed) review = '✓ The prerequisites above were checked by hand against this text.';
  else review = 'Read automatically and not yet checked by hand.';
  const text = c.text
    ? `<blockquote class="catalog-text">${esc(c.text)}</blockquote>`
    : '<p class="muted">The catalog lists no prerequisites.</p>';
  const report = repo
    ? `<a href="${esc(issueURL(repo, map, c))}" target="_blank" rel="noopener">Report a problem ${ICON.external}</a>` : '';
  return `<section><h3>Catalog text</h3>${text}
    ${review ? `<p class="review-note${c.reviewed && c.role === 'main' ? ' ok' : ''}">${esc(review)}</p>` : ''}
    <div class="links"><a href="${esc(c.url)}" target="_blank" rel="noopener">Open in the catalog ${ICON.external}</a>${report}</div>
  </section>`;
}

function issueURL(repo, map, c) {
  const title = `Prerequisite data: ${c.id}`;
  const body = [`Course: ${c.id} ${c.title}`, `Map: ${map.name}`, `Catalog text: ${c.text || '(none)'}`, '', "What's wrong:", ''].join('\n');
  return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// --------------------------------------------------------------- pieces

function treeHTML(map, tree, taken, kind) {
  if (typeof tree === 'string') return `<ul class="chip-list"><li>${chip(map, tree, taken, kind)}</li></ul>`;
  return groupHTML(map, tree, taken, kind);
}

function groupHTML(map, tree, taken, kind) {
  if (typeof tree === 'string') return chip(map, tree, taken, kind);
  const [op, items] = Object.entries(tree)[0];
  const done = satisfied(tree, taken) ? ' <span class="req-done">✓ done</span>' : '';
  return `<div class="req req-${op}"><span class="req-label">${op === 'and' ? 'All of' : 'One of'}${done}</span>
    <ul>${items.map(t => `<li>${groupHTML(map, t, taken, kind)}</li>`).join('')}</ul></div>`;
}

function chipList(map, ids, taken, kind) {
  return `<ul class="chip-list">${ids.map(id => `<li>${chip(map, id, taken, kind)}</li>`).join('')}</ul>`;
}

function chip(map, id, taken, kind, note) {
  const c = map.get(id);
  if (!c) return `<span class="chip"><span class="chip-code">${esc(id)}</span></span>`;
  const done = taken.has(id);
  return `<button type="button" class="chip k-${kind}${done ? ' is-taken' : ''}" data-select="${esc(id)}">
    <span class="chip-code">${esc(map.label(c))}</span>
    <span class="chip-title">${esc(c.title || 'Not in the current catalog')}</span>
    ${note ? `<span class="chip-note">${esc(note)}</span>` : ''}
    ${done ? '<span class="chip-check" title="Taken">✓<span class="sr-only"> taken</span></span>' : ''}
  </button>`;
}

// ------------------------------------------------------------------ intro

function introHTML(map) {
  const main = map.courses.filter(c => c.role === 'main');
  const links = map.edges.filter(e => map.get(e.target).role === 'main' && e.kind !== 'rec').length;
  const lists = map.highlights.filter(h => h.group !== 'Schedule').length;
  return `<div class="intro">
    <p class="eyebrow">${esc(map.data.catalogYear ? `${map.data.catalogYear} catalog` : 'Course map')}</p>
    <h2>${esc(map.name)}</h2>
    <div class="stats">
      <div class="stat"><b>${main.length}</b><span>courses</span></div>
      <div class="stat"><b>${links}</b><span>prerequisite links</span></div>
      <div class="stat"><b>${lists}</b><span>degree lists</span></div>
    </div>
    <section>
      <ul class="tips">
        <li><svg viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke-width="2.4" stroke-linecap="round"><path class="tip-up" d="M2 7h12"/><path class="tip-down" d="M8 15h12"/></svg>
          <span><b>Click a course</b> to light up what it requires (violet) and what it unlocks (orange).</span></li>
        <li><svg viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="8" fill="var(--good)"/><path d="m7.5 11.3 2.4 2.4 4.6-4.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span><b>Mark courses you've taken</b> and the ones you can take next get a green ring.</span></li>
        <li><svg viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke="var(--ink-2)" stroke-width="1.8"><rect x="3" y="4" width="16" height="5" rx="1.5"/><rect x="3" y="13" width="16" height="5" rx="1.5" fill="var(--sunken)"/></svg>
          <span><b>Highlight</b> a degree requirement, a technical track or a quarter's offerings.</span></li>
        <li><svg viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke="var(--ink-2)" stroke-width="1.8" stroke-linecap="round"><circle cx="9.5" cy="9.5" r="5.5"/><path d="m14 14 5 5"/></svg>
          <span><b>Search</b> by number or title. Press <kbd>/</kbd> to jump to the search box.</span></li>
      </ul>
    </section>
    <section><h3>About the data</h3>${aboutHTML(map, { sources: false })}</section>
    <p class="disclaimer">Unofficial and not affiliated with Northwestern University. Prerequisites change, so confirm
    with the official catalog and your adviser before you register.</p>
  </div>`;
}

export function aboutHTML(map, { sources = true } = {}) {
  const d = map.data;
  const main = map.courses.filter(c => c.role === 'main' && c.text);
  const checked = main.filter(c => c.reviewed).length;
  const list = (d.sources || []).map(u =>
    `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\/(www\.)?/, ''))}</a></li>`).join('');
  return `<p class="meta">Prerequisites come from the ${esc(d.catalogYear || 'current')} undergraduate catalog${
    map.quarters.length ? `, and the schedule from the department's ${esc(map.scheduleLabel())} course listing` : ''}.
    Updated ${esc(d.generated)}. ${checked} of ${main.length} prerequisite statements were checked by hand.</p>
    ${sources && list ? `<ul class="sources">${list}</ul>` : ''}`;
}
