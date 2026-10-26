// The student's plan: courses taken or planned (optionally in a quarter), the
// year they started, and the majors/minors they're pursuing on each map.
// Saved per viewer in localStorage through prefs.
import { prefs } from './store.js';
import { satisfied, unmet } from './model.js';

export const QUARTERS = [
  { id: 'FA', name: 'Fall' },
  { id: 'WI', name: 'Winter' },
  { id: 'SP', name: 'Spring' },
  { id: 'SU', name: 'Summer' },
];
const YEARS = 5; // academic years shown in the plan grid

// A term key is "<year the academic year starts>-<quarter>", e.g. "2026-WI" is Winter 2027.
export const termKey = (year, q) => `${year}-${q}`;

export function parseTerm(key) {
  const [year, q] = key.split('-');
  return { year: Number(year), q, index: QUARTERS.findIndex(x => x.id === q) };
}

export function termLabel(key) {
  const { year, q, index } = parseTerm(key);
  return `${QUARTERS[index].name} ${q === 'FA' ? year : year + 1}`;
}

// Short form for course cards: "Fall 26", "Win 27".
export function termShort(key) {
  const { year, q, index } = parseTerm(key);
  return `${['Fall', 'Win', 'Spr', 'Sum'][index]} ${String(q === 'FA' ? year : year + 1).slice(2)}`;
}

export function termOrder(key) {
  const { year, index } = parseTerm(key);
  return year * 4 + index;
}

export function currentTerm(date = new Date()) {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  if (month >= 9) return termKey(year, 'FA');
  if (month <= 3) return termKey(year - 1, 'WI');
  if (month <= 6) return termKey(year - 1, 'SP');
  return termKey(year - 1, 'SU');
}

export class Plan {
  constructor() {
    const saved = prefs.get('plan', null);
    this.courses = saved?.courses || {};
    if (!saved) {
      // Earlier versions only kept a list of taken courses.
      for (const id of prefs.get('taken', [])) this.courses[id] = { s: 'taken', t: null };
    }
    this.start = saved?.start ?? parseTerm(currentTerm()).year;
    this.programs = saved?.programs || {};
  }

  save() {
    prefs.set('plan', { v: 2, courses: this.courses, start: this.start, programs: this.programs });
  }

  status(id) {
    return this.courses[id]?.s || null;
  }

  term(id) {
    return this.courses[id]?.t || null;
  }

  // status: 'taken' | 'planned' | null (remove); term: a term key or null.
  set(id, status, term = this.term(id)) {
    if (status) this.courses[id] = { s: status, t: term || null };
    else delete this.courses[id];
    this.save();
  }

  // The same status (and quarter) for several courses at once.
  setMany(ids, status, term = null) {
    for (const id of ids) {
      if (status) this.courses[id] = { s: status, t: term };
      else delete this.courses[id];
    }
    this.save();
  }

  // For undo: the courses part of the plan as it is now, and putting it back.
  snapshot() {
    return JSON.stringify(this.courses);
  }

  restore(snapshot) {
    this.courses = JSON.parse(snapshot);
    this.save();
  }

  ids(status) {
    return Object.keys(this.courses).filter(id => this.courses[id].s === status);
  }

  setStart(year) {
    this.start = year;
    this.save();
  }

  // Programs chosen on a map, or null if the student hasn't chosen any.
  chosenPrograms(mapId) {
    const ids = this.programs[mapId];
    return ids && ids.length ? ids : null;
  }

  setPrograms(mapId, ids) {
    this.programs[mapId] = ids;
    this.save();
  }

  clear(ids) {
    for (const id of ids) delete this.courses[id];
    this.save();
  }

  // Every quarter in the plan grid, in order.
  terms() {
    const out = [];
    for (let y = this.start; y < this.start + YEARS; y++) {
      for (const q of QUARTERS) out.push(termKey(y, q.id));
    }
    return out;
  }

  // Courses finished (or planned) before a quarter starts.
  doneBefore(term) {
    const limit = termOrder(term);
    const done = new Set();
    for (const [id, c] of Object.entries(this.courses)) {
      if (c.s === 'taken' && (!c.t || termOrder(c.t) < limit)) done.add(id);
      else if (c.s === 'planned' && c.t && termOrder(c.t) < limit) done.add(id);
    }
    return done;
  }

  // Problems with where a planned course sits: prerequisites not done in an
  // earlier quarter, a corequisite missing, or a quarter it isn't offered in.
  issues(map, id) {
    const c = map.get(id);
    const entry = this.courses[id];
    if (!c || entry?.s !== 'planned' || !entry.t) return [];
    const out = [];
    if (c.role === 'main') {
      const before = this.doneBefore(entry.t);
      if (!satisfied(c.prereq, before)) out.push({ type: 'prereq', missing: unmet(c.prereq, before) });
      const together = new Set([...before, ...Object.keys(this.courses).filter(k => this.courses[k].t === entry.t)]);
      if (c.coreq && !satisfied(c.coreq, together)) out.push({ type: 'coreq', missing: unmet(c.coreq, together) });
    }
    const offered = Object.keys(c.offered || {}).map(q => q.split(' ')[0]);
    const name = QUARTERS[parseTerm(entry.t).index].name;
    if (offered.length && !offered.includes(name)) out.push({ type: 'offered', quarters: offered });
    return out;
  }
}
