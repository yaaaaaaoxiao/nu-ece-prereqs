// Plan view: the student's programs (majors/minors), a quarter-by-quarter
// plan, and a requirements checklist for the programs they picked.
import { esc, ICON, issueText } from './panel.js';
import { QUARTERS, currentTerm, termKey, termLabel, termOrder } from './plan.js';

const MANY = 8; // longer lists show only your courses until expanded

export function renderPlanView(el, { map, state }) {
  el.innerHTML = `<div class="plan">${programsHTML(map, state)}${gridHTML(map, state)}${requirementsHTML(map, state)}</div>`;
}

// ---------------------------------------------------------------- programs

// Every program the site has, not just this map's: adding a major brings its
// department onto the map.
function programsHTML(map, state) {
  const all = [...state.programIndex.values()];
  const chosen = state.programIds.map(id => state.programIndex.get(id)).filter(Boolean);
  const others = all.filter(p => !state.myPrograms.has(p.id));
  const options = type => others.filter(p => p.type === type)
    .map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  return `<section class="plan-section">
    <div class="plan-section-head">
      <h2>Your programs</h2>
      <p class="muted">Add your major, and any second major or minors, to track their requirements together.
        A major from another department brings its courses onto the map.</p>
    </div>
    <div class="program-chips">
      ${chosen.map(p => `<span class="program-chip"><span class="ptype">${esc(p.type)}</span>${esc(p.name)}
        ${chosen.length > 1 ? `<button type="button" class="icon-btn" data-action="remove-program" data-program="${esc(p.id)}"
          aria-label="Remove ${esc(p.name)}">${ICON.close}</button>` : ''}</span>`).join('')}
      ${others.length ? `<label class="add-program"><span class="sr-only">Add a major or minor</span>
        <select data-action="add-program">
          <option value="">+ Add a major or minor</option>
          ${options('major') ? `<optgroup label="Majors">${options('major')}</optgroup>` : ''}
          ${options('minor') ? `<optgroup label="Minors">${options('minor')}</optgroup>` : ''}
        </select></label>` : ''}
    </div>
  </section>`;
}

// -------------------------------------------------------------------- grid

function gridHTML(map, state) {
  const { plan } = state;
  const now = currentTerm();
  const mine = Object.keys(plan.courses).filter(id => map.get(id));
  const terms = new Set(plan.terms());
  const inTerm = new Map();
  const loose = [];
  for (const id of mine) {
    const t = plan.term(id);
    if (t && terms.has(t)) {
      if (!inTerm.has(t)) inTerm.set(t, []);
      inTerm.get(t).push(id);
    } else {
      loose.push(id);
    }
  }
  const issues = mine.filter(id => plan.issues(map, id).length).length;
  const startYears = [];
  const nowYear = Number(now.split('-')[0]);
  for (let y = nowYear - 5; y <= nowYear + 1; y++) startYears.push(y);

  const years = [];
  for (let y = plan.start, i = 1; y < plan.start + 5; y++, i++) {
    years.push(`<div class="plan-year">
      <h3>Year ${i} <span class="muted">${y}–${String(y + 1).slice(2)}</span></h3>
      <div class="quarters">${QUARTERS.map(q => quarterHTML(map, state, termKey(y, q.id), inTerm.get(termKey(y, q.id)) || [], now)).join('')}</div>
    </div>`);
  }
  return `<section class="plan-section">
    <div class="plan-section-head">
      <h2>Quarter by quarter</h2>
      <div class="plan-tools">
        <label class="field-inline">First year
          <select data-action="set-start">${startYears.map(y =>
            `<option value="${y}"${y === plan.start ? ' selected' : ''}>${y}–${String(y + 1).slice(2)}</option>`).join('')}</select>
        </label>
        <span class="plan-counts"><b>${plan.ids('taken').filter(id => map.get(id)).length}</b> taken ·
          <b>${plan.ids('planned').filter(id => map.get(id)).length}</b> planned${
          issues ? ` · <span class="warn-count">${ICON.warn} ${issues} to check</span>` : ''}</span>
        ${mine.length ? '<button type="button" class="link-btn" data-action="clear-plan">Clear plan</button>' : ''}
      </div>
    </div>
    <p class="muted plan-hint">Add courses with <b>+ Add</b>, drag them between quarters, or set the quarter in a course's details.
      Courses in past quarters count as taken.</p>
    <div class="plan-years">${years.join('')}</div>
    <div class="quarter unscheduled" data-term="" aria-label="Courses without a quarter">
      <div class="q-head"><span class="q-name">Not in a quarter yet</span></div>
      ${loose.length ? `<ul class="q-courses">${loose.sort().map(id => pchipHTML(map, state, id)).join('')}</ul>`
        : '<p class="muted">Courses you mark as planned or taken without a quarter show up here.</p>'}
    </div>
  </section>`;
}

function quarterHTML(map, state, term, ids, now) {
  const past = termOrder(term) < termOrder(now);
  const units = ids.reduce((sum, id) => sum + (map.get(id).units || 0), 0);
  return `<div class="quarter${term === now ? ' is-now' : ''}${past ? ' is-past' : ''}" data-term="${term}"
      aria-label="${termLabel(term)}">
    <div class="q-head"><span class="q-name">${termLabel(term)}</span>${term === now ? '<span class="now">Now</span>' : ''}
      ${units ? `<span class="q-units">${units} unit${units === 1 ? '' : 's'}</span>` : ''}</div>
    ${ids.length ? `<ul class="q-courses">${ids.sort().map(id => pchipHTML(map, state, id)).join('')}</ul>` : ''}
    <button type="button" class="q-add" data-action="add-to-term" data-term="${term}"
      aria-label="Add a course to ${termLabel(term)}">+ Add</button>
  </div>`;
}

function pchipHTML(map, state, id) {
  const c = map.get(id);
  const { plan } = state;
  const status = plan.status(id);
  const term = plan.term(id);
  const issues = plan.issues(map, id);
  const tip = issues.map(i => issueText(map, i, term)).join(' ');
  const where = term ? '' : `<span class="pchip-note">${status === 'taken' ? 'taken' : 'planned'}</span>`;
  return `<li><button type="button" class="pchip is-${status}${issues.length ? ' has-issue' : ''}${
    state.selected === id ? ' is-selected' : ''}" data-select="${esc(id)}" data-id="${esc(id)}" draggable="true"
      title="${esc(`${c.title}${tip ? ` — ${tip}` : ''}`)}">
    <span class="pchip-code">${esc(map.label(c))}</span><span class="pchip-title">${esc(c.title)}</span>${where}
    ${issues.length ? `${ICON.warn}<span class="sr-only">${esc(tip)}</span>` : ''}
    ${status === 'taken' ? '<span class="pchip-check" aria-label="taken">✓</span>' : ''}
  </button></li>`;
}

// ------------------------------------------------------------ requirements

function requirementsHTML(map, state) {
  const chosen = [...state.myPrograms].map(id => map.program(id)).filter(Boolean);
  if (!chosen.length) {
    return `<section class="plan-section"><div class="plan-section-head"><h2>Requirements</h2></div>
      <p class="muted">Add a program above to see its requirements checked against your plan.</p></section>`;
  }
  // Courses that appear in more than one of your programs.
  const count = new Map();
  for (const p of chosen) p.courses.forEach(id => count.set(id, (count.get(id) || 0) + 1));
  const shared = [...count].filter(([id, n]) => n > 1 && (state.taken.has(id) || state.planned.has(id))).map(([id]) => id);
  return `<section class="plan-section">
    <div class="plan-section-head">
      <h2>Requirements</h2>
      <p class="muted">A checklist built from the catalog, not an official degree audit. Confirm with your
        Academic Advisement Report in CAESAR and your adviser.</p>
    </div>
    ${shared.length > 0 && chosen.length > 1 ? `<p class="overlap">${ICON.warn}<span>${shared.map(id => esc(map.label(map.get(id)))).join(', ')}
      ${shared.length === 1 ? 'is' : 'are'} in more than one of your programs. Schools limit how many courses can count
      twice, so check how these count with your adviser.</span></p>` : ''}
    <div class="req-cards">${chosen.map(p => programCardHTML(map, state, p, count)).join('')}</div>
  </section>`;
}

function programCardHTML(map, state, program, count) {
  return `<article class="req-card">
    <header><div><span class="ptype">${esc(program.type)}</span><h3>${esc(program.name)}</h3></div>
      <a href="${esc(program.url)}" target="_blank" rel="noopener">Catalog ${ICON.external}</a></header>
    ${program.lists.map(list => listHTML(map, state, list, count)).join('')}
    ${program.notes.length ? `<details class="req-notes"><summary>Rules to check yourself (${program.notes.length})</summary>
      <ul>${program.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
  </article>`;
}

function listHTML(map, state, list, count) {
  const p = map.progress(list, state.taken, state.planned);
  const total = list.items.length;
  const need = list.need;
  const complete = need && p.taken >= need;
  const covered = need && p.taken + p.planned >= need;
  let summary;
  if (need) summary = `${p.taken} of ${need} taken${p.planned ? `, ${p.planned} planned` : ''}`;
  else summary = `${p.taken} taken${p.planned ? `, ${p.planned} planned` : ''} · ${total} option${total === 1 ? '' : 's'}`;
  const bar = need ? `<div class="bar" aria-hidden="true"><span class="bar-taken" style="width:${Math.min(100, (p.taken / need) * 100)}%"></span><span class="bar-planned" style="width:${
    Math.min(100 - Math.min(100, (p.taken / need) * 100), (p.planned / need) * 100)}%"></span></div>` : '';
  const rows = list.items.map((alts, i) => ({ alts, status: p.items[i] }));
  const mine = rows.filter(r => r.status);
  const itemHTML = r => `<li class="req-item${r.status ? ` is-${r.status}` : ''}">${
    r.status === 'taken' ? '<span class="ri-mark" aria-label="taken">✓</span>' : r.status === 'planned' ? '<span class="ri-mark" aria-label="planned">◷</span>' : '<span class="ri-mark" aria-hidden="true">○</span>'}
    <span class="ri-alts">${r.alts.map(alt => alt.map(id => miniChip(map, state, id, count)).join('<span class="amp">&amp;</span>')).join('<span class="or">or</span>')}</span></li>`;
  const long = total > MANY;
  return `<div class="req-list${complete ? ' is-complete' : covered ? ' is-covered' : ''}">
    <div class="rl-head"><span class="rl-label">${esc(list.label)}${list.kind === 'prereq' ? ' <span class="rl-kind">before the program</span>'
      : list.kind === 'core' ? ' <span class="rl-kind">school core</span>' : ''}</span>
      <span class="rl-summary">${complete ? '✓ ' : ''}${summary}</span></div>
    ${bar}
    ${long
      ? `${mine.length ? `<ul class="req-items">${mine.map(itemHTML).join('')}</ul>` : ''}
         <details><summary>All ${total} options</summary><ul class="req-items">${rows.map(itemHTML).join('')}</ul></details>`
      : `<ul class="req-items">${rows.map(itemHTML).join('')}</ul>`}
  </div>`;
}

function miniChip(map, state, id, count) {
  const c = map.get(id);
  const twice = (count.get(id) || 0) > 1 ? `<sup title="In more than one of your programs">×${count.get(id)}</sup>` : '';
  if (!c) return `<span class="mini-chip is-unlisted" title="Not in the undergraduate catalog">${esc(id.replace(/-0$/, ''))}</span>`;
  const status = state.taken.has(id) ? ' is-taken' : state.planned.has(id) ? ' is-planned' : '';
  return `<button type="button" class="mini-chip${status}" data-select="${esc(id)}" title="${esc(c.title)}">${esc(map.label(c))}${twice}</button>`;
}
