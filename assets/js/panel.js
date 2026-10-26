// Details panel: the selected course, or a highlighted list, or an
// introduction when nothing is selected.
import { dropWarnings, satisfied, unmet } from './model.js';
import { currentTerm, termLabel, termOrder, termShort } from './plan.js';
import { pathFor } from './path.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export const ICON = {
  close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>',
  external: '<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8"/></svg>',
  warn: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.8 15 14H1L8 1.8Z" fill="var(--warn)"/><path d="M8 6v3.6M8 11.4v.1" stroke="#1a1a19" stroke-width="1.6" stroke-linecap="round"/></svg>',
  path: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="4.5" r="2"/><circle cx="15" cy="15.5" r="2"/><path d="M5 6.5V8a2.5 2.5 0 0 0 2.5 2.5h5A2.5 2.5 0 0 1 15 13v.5"/></svg>',
};
const courses = n => `${n} course${n === 1 ? '' : 's'}`;
// "Prerequisites fit" (a green check) and "not yet" (an empty ring) in the panel.
const STATUS_ICON = {
  fits: '<svg class="status-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="m4.8 8.2 2.2 2.2 4.2-4.4"/></svg>',
  blocked: '<svg class="status-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/></svg>',
};
// The viewer's plan, drawn like the graph's status icons: taken (check),
// planned (clock), can take now (arrow), planned but needs a check (!).
export function statusIcon(kind) {
  const glyph = {
    taken: 'm5 8.2 2.1 2.1L11 6.3',
    planned: 'M8 4.6V8l2.4 1.6',
    ready: 'M4.7 8h6M8.5 5.5 11 8l-2.5 2.5',
    issue: 'M8 4.4v4.3M8 11.2v.1',
    skip: 'M5 8h6',
  }[kind];
  return `<svg class="si si-${kind}" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6"/><path d="${glyph}"/></svg>`;
}
const STATUS_LABEL = { taken: 'taken', planned: 'planned', ready: 'can take now', skip: 'not interested' };
// Notes that ask for more than courses ("senior standing"), not alternatives
// ("or equivalent") or remarks about where a prerequisite came from.
const extraNeeds = c => (c.notes || []).filter(n => !n.startsWith('or ') && !/[A-Z_]+ \d{3}/.test(n));
const LINK_NOTE = { alt: 'one option', co: 'corequisite', rec: 'recommended' };

// The panel follows the current focus: courses being marked, else a course,
// else a highlighted list, else the intro.
export function renderPanel(el, { map, state, repo }) {
  // The selected course, else one previewed by hovering over it on the map.
  const shown = state.selected || state.preview;
  const course = shown && map.get(shown);
  const hl = !course && state.highlight && map.highlight(state.highlight);
  let body;
  if (state.picking || state.picked.size) body = pickedHTML(map, state);
  else if (course) body = courseHTML(map, course, state, repo);
  else if (hl?.path) body = pathHTML(map, hl.path, state);
  else if (hl) body = highlightHTML(map, hl, state);
  else body = introHTML(map, state);
  // The grip only shows on phones, where the panel is a collapsible bottom sheet.
  el.innerHTML = `<button type="button" class="panel-grip" data-action="toggle-sheet"
    aria-label="Show or hide course details"></button>${body}`;
}

// ------------------------------------------------------- several courses

// What to do with the selected courses, then the list of them. On phones the
// header and buttons are what shows of the collapsed sheet.
function pickedHTML(map, state) {
  const ids = [...state.picked].filter(id => map.get(id))
    .sort((a, b) => map.label(map.get(a)).localeCompare(map.label(map.get(b)), undefined, { numeric: true }));
  const n = ids.length;
  const off = n ? '' : ' disabled';
  const now = termOrder(currentTerm());
  const terms = state.plan.terms();
  const option = t => `<option value="${t}">${termLabel(t)}</option>`;
  const items = ids.map(id => {
    const c = map.get(id);
    const label = map.label(c);
    return `<li class="pick-item"><span class="pick-code">${esc(label)}</span>
      <span class="pick-title">${esc(c.title || 'Not in the current catalog')}</span>
      <button type="button" class="icon-btn" data-action="unpick" data-id="${esc(id)}" aria-label="Unselect ${esc(label)}">${ICON.close}</button></li>`;
  }).join('');
  return `
    <div class="panel-head">
      <div>
        <p class="eyebrow">Mark courses</p>
        <h2>${n ? `${n} course${n === 1 ? '' : 's'} selected` : 'Select courses'}</h2>
      </div>
      <button type="button" class="pick-done" data-action="stop-picking">Done</button>
    </div>
    <div class="pick-actions" role="group" aria-label="Mark the selected courses">
      <button type="button" class="pick-btn" data-action="pick-status" data-status="taken" title="Mark taken (T)"${off}>${statusIcon('taken')}Taken</button>
      <button type="button" class="pick-btn" data-action="pick-status" data-status="planned" title="Mark planned (P)"${off}>${statusIcon('planned')}Planned</button>
      <label class="pick-term"><span class="sr-only">Put the selected courses in a quarter</span>
        <select data-action="pick-term"${off}>
          <option value="">Quarter…</option>
          <optgroup label="Plan for">${terms.filter(t => termOrder(t) >= now).map(option).join('')}</optgroup>
          <optgroup label="Taken in">${terms.filter(t => termOrder(t) < now).reverse().map(option).join('')}</optgroup>
        </select></label>
      <button type="button" class="pick-btn" data-action="pick-status" data-status="" title="Remove from your plan (N)"${off}>Not taken</button>
      <button type="button" class="pick-btn" data-action="pick-status" data-status="skip" title="Hide from your map (X)"${off}>${statusIcon('skip')}Not interested</button>
    </div>
    <section>
      ${n ? `<ul class="pick-list">${items}</ul>` : `<p class="muted">Click courses on the map or in the list.</p>`}
      <p class="muted pick-tips">Shift-drag on the map to select a group. Keys: <kbd>T</kbd> taken,
        <kbd>P</kbd> planned, <kbd>N</kbd> not taken, <kbd>Esc</kbd> done.</p>
    </section>`;
}

// ---------------------------------------------------------------- highlight

function highlightHTML(map, hl, state) {
  const planning = [...state.taken].some(id => map.get(id));
  const courses = [...hl.ids].map(id => map.get(id)).filter(Boolean)
    .sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'main' ? -1 : 1));
  const done = courses.filter(c => state.taken.has(c.id)).length;
  const items = courses.map(c => `<li>${chip(map, c.id, state, 'none')}</li>`).join('');
  const unlisted = hl.unlisted || [];
  return `
    <div class="panel-head">
      <div>
        <p class="eyebrow">${esc(hl.group)}</p>
        <h2>${esc(hl.label)}</h2>
      </div>
      <button type="button" class="icon-btn" data-action="clear-highlight" aria-label="Stop highlighting">${ICON.close}</button>
    </div>
    <section>
      <p class="muted">${courses.length} course${courses.length === 1 ? '' : 's'}${planning ? ` (${done} taken)` : ''}.
        Click one to see its prerequisites.</p>
      <ul class="chip-list">${items}</ul>
      ${unlisted.length ? `<p class="muted" style="margin-top:10px">Not in the undergraduate catalog: ${
        esc(unlisted.join(', '))}.</p>` : ''}
      ${hl.url ? `<div class="links" style="margin-top:12px"><a href="${esc(hl.url)}" target="_blank" rel="noopener">Program requirements ${ICON.external}</a></div>` : ''}
    </section>`;
}

// ---------------------------------------------------------- path to a course

const labelOf = (map, id) => (map.get(id) ? map.label(map.get(id)) : id);

// In a course's panel: how far it is from the viewer's plan, and the button
// that shows the whole path on the map.
function pathSummaryHTML(map, c, state) {
  if (state.plan.status(c.id) === 'taken') return '';
  const path = pathFor(state, c.id);
  if (path.done) return ''; // planned for the quarter under way
  const first = path.courses.length - 1;
  const term = path.when.get(c.id);
  let when;
  if (!term) when = 'They do not all fit in the next five years.';
  else if (path.fixed.has(c.id)) when = `You've planned it for <b>${termLabel(term)}</b>.`;
  else {
    when = `Soonest: <b>${termLabel(term)}</b>${path.guess.has(c.id) && map.quarters.length
      ? ' <span class="muted">(a guess: it isn\'t on this year\'s schedule)</span>' : ''}.`;
  }
  return `<section class="path-summary"><h3>Path to this course</h3>
    <p>${first ? `You need ${courses(first)} first.` : 'You need nothing else first.'} ${when}</p>
    ${first ? `<button type="button" class="btn path-btn" data-action="show-path" data-id="${esc(c.id)}">${ICON.path}Show the path</button>` : ''}
  </section>`;
}

// The path panel: what's still needed before a course, quarter by quarter,
// and a button that puts it all in the plan.
function pathHTML(map, path, state) {
  const c = map.get(path.target);
  const label = esc(map.label(c));
  const head = `<div class="panel-head">
      <div>
        <p class="eyebrow">Path to</p>
        <h2><span class="code">${esc(c.id)}</span>${esc(c.title || 'Not in the current catalog')}</h2>
      </div>
      <button type="button" class="icon-btn" data-action="clear-highlight" aria-label="Stop showing the path">${ICON.close}</button>
    </div>`;
  if (path.done) {
    return `${head}<p class="status fits path-lead">${STATUS_ICON.fits}<span>${
      state.taken.has(c.id) ? 'You took this course.' : 'You take this course this quarter.'} There is nothing to plan.</span></p>`;
  }
  const first = path.courses.length - 1;
  const end = path.when.get(path.target);
  let lead = first ? `You need ${courses(first)} first.` : 'You need nothing else first.';
  if (!end) lead += ` At ${state.pathPace} a quarter, they do not all fit in the next five years.`;
  else if (path.fixed.has(path.target)) lead += ` You planned ${label} for <b>${termLabel(end)}</b>.`;
  else lead += ` The soonest you can take ${label} is <b>${termLabel(end)}</b>.`;
  const steps = path.steps.map(({ term, ids }) => `<li class="path-step">
      <p class="path-term">${esc(termLabel(term))}</p>
      <ul class="chip-list">${ids.map(id => `<li>${chip(map, id, state, 'up', stepNote(path, id))}</li>`).join('')}</ul>
    </li>`).join('');
  const toAdd = [...path.when].filter(([id, term]) => map.get(id)
    && !(state.plan.status(id) === 'planned' && state.plan.term(id) === term)).length;
  const pace = [2, 3, 4, 5].map(n => `<option value="${n}"${n === state.pathPace ? ' selected' : ''}>${n}</option>`).join('');
  return `${head}
    <p class="path-lead">${lead}</p>
    <div class="path-actions">
      <button type="button" class="btn primary" data-action="plan-path" data-id="${esc(path.target)}"${toAdd ? '' : ' aria-disabled="true"'}>${
        toAdd ? `Add ${courses(toAdd)} to my plan` : 'All in your plan'}</button>
      <label class="pace">Up to <select data-action="set-pace">${pace}</select> a quarter</label>
    </div>
    <section>
      ${steps ? `<ol class="path-steps">${steps}</ol>` : ''}
      ${path.unplaced.length ? `<p class="muted">Does not fit in the next five years: ${esc(path.unplaced.map(id => labelOf(map, id)).join(', '))}.</p>` : ''}
    </section>
    <section><h3>How the path is made</h3>${pathNotesHTML(map, path, state)}</section>`;
}

// One short note per course on the path; the notes below say more.
function stepNote(path, id) {
  if (id === path.target) return 'goal';
  if (path.moved.has(id)) return `moved from ${termShort(path.moved.get(id))}`;
  if (path.unknownReqs.has(id)) return 'check prerequisites';
  if (path.options.has(id)) return 'one of several';
  if (path.guess.has(id)) return 'not on the schedule';
  return '';
}

function pathNotesHTML(map, path, state) {
  const names = ids => esc(ids.map(id => labelOf(map, id)).join(', '));
  const notes = [map.quarters.length
    ? `Quarters come from the ${esc(map.scheduleLabel())} schedule. The path assumes each course runs in the same quarters every year.`
    : 'This map has no schedule, so the path can use any quarter.'];
  notes.push(`It puts at most ${state.pathPace} courses in a quarter, including courses already in your plan. It does not use summers.`);
  const options = [...path.options].map(([id, others]) => {
    const alts = others.filter(o => map.get(o) && !map.get(o).missing);
    return alts.length ? `${labelOf(map, id)} (or ${alts.slice(0, 2).map(o => labelOf(map, o)).join(', ')}${
      alts.length > 2 ? ` and ${alts.length - 2} more` : ''})` : '';
  }).filter(Boolean);
  if (options.length) {
    notes.push(`If one of several courses is acceptable, the path uses the usual one: ${esc(options.join('; '))}.
      To use a different one, plan it.`);
  }
  for (const [id, old] of path.moved) {
    const now = path.when.get(id);
    notes.push(`You planned ${esc(labelOf(map, id))} for ${termLabel(old)}, before its prerequisites.${now ? ` The path moves it to ${termLabel(now)}.` : ''}`);
  }
  // Quarters taken from the plan aren't guesses.
  const guess = [...path.guess].filter(id => !path.fixed.has(id));
  if (guess.length && map.quarters.length) {
    notes.push(`Not on this year's schedule: ${names(guess)}. The path can use any quarter for ${guess.length === 1 ? 'it' : 'them'}.`);
  }
  const unknown = [...path.noSchedule].filter(id => !path.fixed.has(id));
  if (unknown.length) notes.push(`The site does not have other departments' schedules. The path can use any quarter for ${names(unknown)}.`);
  if (path.unknownReqs.size) {
    notes.push(`Check the prerequisites of ${names([...path.unknownReqs])} in the catalog. The site cannot read them, so the path can be incomplete.`);
  }
  const hidden = path.courses.filter(id => map.get(id) && !state.visible.has(id));
  if (hidden.length) notes.push(`Not on the map because Other departments is off: ${names(hidden)}.`);
  const extra = extraNeeds(map.get(path.target));
  if (extra.length) notes.push(`${esc(labelOf(map, path.target))} also needs: ${esc(extra.join('; '))}.`);
  return `<ul class="path-notes">${notes.map(n => `<li>${n}</li>`).join('')}</ul>`;
}

// ------------------------------------------------------------------ course

function courseHTML(map, c, state, repo) {
  const units = c.units ? ` · ${c.units} unit${c.units === 1 ? '' : 's'}` : '';
  return `
    <div class="panel-head">
      <div>
        <p class="eyebrow">${esc(map.deptName(c))}${units}</p>
        <h2><span class="code">${esc(c.id)}</span>${esc(c.title || 'Not in the current catalog')}</h2>
      </div>
      <button type="button" class="icon-btn" data-action="close" aria-label="Close details">${ICON.close}</button>
    </div>
    ${skippedHTML(map, c, state)}
    ${descHTML(map, c, state)}
    ${planControlHTML(map, c, state)}
    ${statusHTML(map, c, state)}
    ${pathSummaryHTML(map, c, state)}
    ${requirementsHTML(map, c, state)}
    ${unlocksHTML(map, c, state)}
    ${programsHTML(map, c, state)}
    ${scheduleHTML(map, c)}
    ${sourceHTML(map, c, repo)}`;
}

// The catalog's description, under the title. Course codes in it link to the
// course when it's on this map; a long one shows its first lines until opened.
const LONG_DESC = 260; // characters, about four lines of the panel
function descHTML(map, c, state) {
  if (!c.desc) return '';
  const long = c.desc.length > LONG_DESC;
  const open = state.openDescs.has(c.id);
  return `<div class="desc${long && !open ? ' is-clamped' : ''}"><p>${linkCodes(map, c.desc, c.id)}</p>${long
    ? `<button type="button" class="link-btn desc-more" data-action="toggle-desc" data-id="${esc(c.id)}"
        aria-expanded="${open}">${open ? 'Show less' : 'Show more'}</button>` : ''}</div>`;
}

// "Taught with COMP_ENG 346-0": a code becomes a link when the course is on the
// map (other than the course itself).
function linkCodes(map, text, self) {
  return esc(text).replace(/\b([A-Z][A-Z_]+) (\d{3}-\d)\b/g, (code, dept, num) => {
    const c = `${dept} ${num}` !== self && map.get(`${dept} ${num}`);
    return c ? `<button type="button" class="code-link" data-select="${dept} ${num}">${esc(map.label(c))}</button>` : code;
  });
}

// A course marked "not interested": it's off the map; say why it may matter.
function skippedHTML(map, c, state) {
  if (state.plan.status(c.id) !== 'skip') return '';
  const reasons = dropWarnings(map, state.activePrograms, state.plan, [c.id]);
  return `<div class="skipped">
    <p>${statusIcon('skip')}<span><b>Not interested.</b> This course is hidden from your map.</span></p>
    ${reasons.length ? `<ul class="issues">${reasons.map(r => `<li>${ICON.warn}<span>${esc(r)}</span></li>`).join('')}</ul>` : ''}
    <button type="button" class="btn" data-action="set-status" data-id="${esc(c.id)}" data-status="">Show it again</button>
  </div>`;
}

// Not taken / Planned / Taken, plus the quarter.
function planControlHTML(map, c, state) {
  const { plan } = state;
  const status = plan.status(c.id);
  const id = esc(c.id);
  const option = (value, label) => `<button type="button" role="radio" data-action="set-status" data-id="${id}"
    data-status="${value}" aria-checked="${status === (value || null)}">${label}</button>`;
  let when = '';
  if (status) {
    const terms = plan.terms();
    const term = plan.term(c.id);
    if (term && !terms.includes(term)) terms.push(term);
    const now = termOrder(currentTerm());
    // Taken courses can only be in past quarters, plans in the current one or later.
    const options = terms.filter(t => (status === 'taken' ? termOrder(t) <= now : termOrder(t) >= now) || t === term);
    when = `<label class="term-pick"><span>${status === 'taken' ? 'Taken in' : 'Planned for'}</span>
      <select data-action="set-term" data-id="${id}">
        <option value="">No quarter</option>
        ${options.map(t => `<option value="${t}"${t === term ? ' selected' : ''}>${termLabel(t)}</option>`).join('')}
      </select></label>`;
  }
  // Handy for marking a whole chain taken at once.
  const chain = [...map.requiredAncestors(c.id)].filter(x => state.visible.has(x)).length;
  const pick = chain ? `<button type="button" class="link-btn pick-chain" data-action="pick-chain" data-id="${id}">Select it with its ${
    chain} prerequisite${chain === 1 ? '' : 's'}</button>` : '';
  return `<div class="plan-control">
      <div class="segmented seg-status" role="radiogroup" aria-label="Your plan for this course">
        ${option('', 'Not taken')}${option('planned', 'Planned')}${option('taken', 'Taken')}
      </div>
      ${when}
      <div class="plan-links">${pick}${status === 'skip' ? '' : `<button type="button" class="link-btn skip-btn"
        data-action="set-status" data-id="${id}" data-status="skip" title="Hide it from your map (X)">Not interested</button>`}</div>
    </div>`;
}

function statusHTML(map, c, state) {
  const { plan, taken } = state;
  const status = plan.status(c.id);
  if (status === 'planned') return issuesHTML(map, plan.issues(map, c.id), plan.term(c.id));
  if (status || ![...taken].some(id => map.get(id))) return '';
  const can = map.status(c, taken);
  if (c.role !== 'main') {
    // Other departments: known only when their catalog sentence was plain enough to read.
    if (can === 'available') {
      return `<p class="status available">${statusIcon('ready')}<span>You can probably take this now.
        <span class="muted">(Read automatically from the catalog.)</span></span></p>`;
    }
    return can === 'blocked' ? `<p class="status blocked">${STATUS_ICON.blocked}<span>Probably not yet.
      <span class="muted">(Read automatically from the catalog.)</span></span></p>` : '';
  }
  if (can === 'available') {
    const extra = extraNeeds(c);
    return `<p class="status available">${statusIcon('ready')}<span>You can take this now.${
      extra.length ? ` <span class="muted">Also: ${esc(extra.join(', '))}.</span>` : ''}</span></p>`;
  }
  const parts = c.prereq.and || [c.prereq];
  const missing = unmet(c.prereq, taken).length;
  return `<p class="status blocked">${STATUS_ICON.blocked}<span>Not yet. You need ${
    parts.length === 1 ? 'the prerequisite below' : `${missing} of the ${parts.length} requirements below`}.</span></p>`;
}

export function issueText(map, issue, term) {
  const list = trees => trees.map(t => map.treeText(t)).join('; ');
  if (issue.type === 'prereq') return `Needs ${list(issue.missing)} before ${termLabel(term)}.`;
  if (issue.type === 'coreq') return `Needs ${list(issue.missing)} by ${termLabel(term)} (corequisite).`;
  return `Runs only in ${issue.quarters.join(' and ')} this year.`;
}

function issuesHTML(map, issues, term) {
  if (!issues.length) {
    return term ? `<p class="status fits">${STATUS_ICON.fits}<span>The prerequisites fit your plan.</span></p>` : '';
  }
  return `<ul class="issues">${issues.map(i => `<li>${ICON.warn}<span>${esc(issueText(map, i, term))}</span></li>`).join('')}</ul>`;
}

function requirementsHTML(map, c, state) {
  if (c.role !== 'main') {
    const linked = map.parents.get(c.id).map(e => e.source);
    return `<section><h3>Prerequisites</h3>
      <p class="muted">The site reads another department's prerequisites automatically. Check the catalog text below.</p>
      ${linked.length ? `<p>Links on this map:</p>${chipList(map, linked, state, 'up')}` : ''}
    </section>`;
  }
  const notes = c.notes.length
    ? `<ul class="notes">${c.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  let html = `<section><h3>Prerequisites</h3>${
    c.prereq ? treeHTML(map, c.prereq, state, 'up') : '<p class="muted">No prerequisites.</p>'}${notes}</section>`;
  if (c.coreq) html += `<section><h3>Take at the same time</h3>${treeHTML(map, c.coreq, state, 'up')}</section>`;
  if (c.recommended.length) html += `<section><h3>Recommended first</h3>${chipList(map, c.recommended, state, 'up')}</section>`;
  return html;
}

function unlocksHTML(map, c, state) {
  const links = [...map.children.get(c.id)].sort((a, b) => a.target.localeCompare(b.target));
  if (!links.length) {
    return '<section><h3>Unlocks</h3><p class="muted">No course on this map needs it.</p></section>';
  }
  const total = [...map.descendants(c.id)].filter(id => state.visible.has(id)).length;
  const items = links.map(e => `<li>${chip(map, e.target, state, 'down', LINK_NOTE[e.kind])}</li>`).join('');
  return `<section><h3>Unlocks</h3><ul class="chip-list">${items}</ul>${
    total > links.length ? `<p class="muted" style="margin-top:8px">Leads to ${total} courses in all.</p>` : ''}</section>`;
}

// Requirement lists this course appears in, yours first.
function programsHTML(map, c, state) {
  const entries = [...(map.membership.get(c.id) || [])]
    .sort((a, b) => Number(state.myPrograms.has(b.program.id)) - Number(state.myPrograms.has(a.program.id)));
  if (!entries.length) return '';
  const items = entries.map(m => `<li><button type="button" data-highlight="${esc(m.key)}" aria-pressed="${m.key === state.highlight}"
      title="Highlight every course in this list"><span class="d-name">${esc(m.program.name)}${
      state.myPrograms.has(m.program.id) ? ' <span class="mine">yours</span>' : ''}</span>
      <span class="d-group">${esc(m.list.label)}</span></button></li>`).join('');
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
  if (c.missing) review = 'Not in the current catalog. The number can be old, or the course can be retired.';
  else if (c.role !== 'main') review = 'Read automatically. Not checked by hand.';
  else if (!c.text) review = '';
  else if (c.reviewed) review = '✓ Checked by hand against this text.';
  else review = 'Read automatically. Not checked by hand yet.';
  const text = c.text
    ? `<blockquote class="catalog-text">${esc(c.text)}</blockquote>`
    : '<p class="muted">The catalog lists no prerequisites.</p>';
  const report = repo
    ? `<a href="${esc(issueURL(repo, map, c))}" target="_blank" rel="noopener">Report a problem ${ICON.external}</a>` : '';
  return `<section><h3>Prerequisites as written</h3>${text}
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

function treeHTML(map, tree, state, kind) {
  if (typeof tree === 'string') return `<ul class="chip-list"><li>${chip(map, tree, state, kind)}</li></ul>`;
  return groupHTML(map, tree, state, kind);
}

function groupHTML(map, tree, state, kind) {
  if (typeof tree === 'string') return chip(map, tree, state, kind);
  const [op, items] = Object.entries(tree)[0];
  const done = satisfied(tree, state.taken) ? ' <span class="req-done">✓ done</span>' : '';
  return `<div class="req req-${op}"><span class="req-label">${op === 'and' ? 'All of' : 'One of'}${done}</span>
    <ul>${items.map(t => `<li>${groupHTML(map, t, state, kind)}</li>`).join('')}</ul></div>`;
}

function chipList(map, ids, state, kind) {
  return `<ul class="chip-list">${ids.map(id => `<li>${chip(map, id, state, kind)}</li>`).join('')}</ul>`;
}

// A course button showing the viewer's status for it (taken, planned, can take now).
export function chip(map, id, { taken, planned, ready, skipped }, kind, note) {
  const c = map.get(id);
  if (!c) return `<span class="chip is-unlisted"><span class="chip-code">${esc(id)}</span><span class="chip-title">Not in the undergraduate catalog</span></span>`;
  const status = taken.has(id) ? 'taken' : planned.has(id) ? 'planned' : skipped?.has(id) ? 'skip' : ready?.has(id) ? 'ready' : '';
  return `<button type="button" class="chip k-${kind}${status ? ` is-${status}` : ''}" data-select="${esc(id)}">
    <span class="chip-code">${esc(map.label(c))}</span>
    <span class="chip-title">${esc(c.title || 'Not in the current catalog')}</span>
    ${note ? `<span class="chip-note">${esc(note)}</span>` : ''}
    ${status ? `<span class="chip-status" title="${STATUS_LABEL[status]}">${statusIcon(status)}<span class="sr-only"> ${STATUS_LABEL[status]}</span></span>` : ''}
  </button>`;
}

// ------------------------------------------------------------------ intro

function introHTML(map, state) {
  const main = map.courses.filter(c => c.role === 'main');
  const links = map.edges.filter(e => map.get(e.target).role === 'main' && e.kind !== 'rec').length;
  // This map's courses that open up the most later courses on the graph.
  const gateways = main
    .map(c => [c, [...map.descendants(c.id)].filter(id => state.visible.has(id)).length])
    .filter(([, n]) => n > 0)
    .sort(([a, n], [b, m]) => m - n || a.id.localeCompare(b.id))
    .slice(0, 5);
  return `<div class="intro">
    <p class="eyebrow">${esc(map.data.catalogYear ? `${map.data.catalogYear} catalog` : 'Course map')}</p>
    <h2>${esc(map.name)}</h2>
    <div class="stats">
      <div class="stat"><b>${main.length}</b><span>courses</span></div>
      <div class="stat"><b>${links}</b><span>prerequisite links</span></div>
      <div class="stat"><b>${map.programs.length}</b><span>majors &amp; minors</span></div>
    </div>
    <section>
      <ul class="tips">
        <li><svg viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke-width="2.4" stroke-linecap="round"><path class="tip-up" d="M2 7h12"/><path class="tip-down" d="M8 15h12"/></svg>
          <span><b>Point at a course</b> to see its details here. <b>Click it</b> to keep them, and to see its
          prerequisites (violet) and the courses it unlocks (orange).</span></li>
        <li>${statusIcon('ready').replace('class="si', 'class="tip-icon si')}
          <span><b>Mark your courses.</b> Shift-click them, or press <b>Mark courses</b>. Courses you can take next turn green.</span></li>
        <li><svg viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round"><circle class="tip-up" cx="5" cy="4.5" r="2.2"/><path class="tip-up" d="M5 6.7v2.3a2.5 2.5 0 0 0 2.5 2.5h7A2.5 2.5 0 0 1 17 14v1"/><circle cx="17" cy="17.5" r="2.4" fill="var(--ink-2)"/></svg>
          <span><b>Plan a route.</b> Open a course and press <b>Show the path</b>.</span></li>
        <li><svg class="tip-icon" viewBox="0 0 22 22" aria-hidden="true"><rect class="tip-reach" x="0.5" y="4.5" width="21" height="13" rx="6.5"/><path class="tip-fork" d="M6.5 8v2.2M6.5 10.2l-2.3 3.4M6.5 10.2v3.4M6.5 10.2l2.3 3.4"/><text class="tip-num" x="16.3" y="14.6">9</text></svg>
          <span><b>On each course:</b> the number of courses it leads to, and the quarters it runs this year
          (<b class="tip-quarters">F<span class="off">W</span>S</b>).</span></li>
        <li><svg viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke="var(--ink-2)" stroke-width="1.8"><rect x="3" y="4" width="16" height="5" rx="1.5"/><rect x="3" y="13" width="16" height="5" rx="1.5" fill="var(--sunken)"/></svg>
          <span><b>Add your majors and minors</b> with the button at the top.</span></li>
        <li><svg viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke="var(--ink-2)" stroke-width="1.8" stroke-linecap="round"><circle cx="9.5" cy="9.5" r="5.5"/><path d="m14 14 5 5"/></svg>
          <span><b>Search</b> by number or title. Press <kbd>/</kbd> to start.</span></li>
      </ul>
    </section>
    ${gateways.length ? `<section><h3>Gateway courses</h3>
      <p class="muted">These lead to the most courses.</p>
      <ul class="chip-list">${gateways.map(([c, n]) => `<li>${chip(map, c.id, state, 'down', `leads to ${n}`)}</li>`).join('')}</ul>
    </section>` : ''}
    <section><h3>About the data</h3>${aboutHTML(map, { sources: false })}</section>
    <p class="disclaimer">Unofficial. Not affiliated with Northwestern University. Prerequisites change:
    before you register, check the official catalog and talk to your adviser.</p>
  </div>`;
}

export function aboutHTML(map, { sources = true } = {}) {
  const d = map.data;
  const main = map.courses.filter(c => c.role === 'main' && c.text);
  const checked = main.filter(c => c.reviewed).length;
  const list = (d.sources || []).map(u =>
    `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\/(www\.)?/, ''))}</a></li>`).join('');
  return `<p class="meta">Prerequisites: the ${esc(d.catalogYear || 'current')} undergraduate catalog.${
    map.quarters.length ? ` Schedule: the department's ${esc(map.scheduleLabel())} course list.` : ''}
    Checked by hand: ${checked} of ${main.length} prerequisite statements. Updated ${esc(d.generated)}.</p>
    ${sources && list ? `<ul class="sources">${list}</ul>` : ''}`;
}
