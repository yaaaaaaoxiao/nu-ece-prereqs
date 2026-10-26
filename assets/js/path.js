// Path to a course: the fewest courses still needed before it, and the
// soonest quarters to take them in.
//
// Starts from the viewer's plan (courses taken, or planned for the current
// quarter) and follows prerequisites back. At each "one of" it takes an option
// already in the plan, else the usual one (`prefer`: what the student's
// programs ask for, as the graph shows), else the earlier part of the course's
// own sequence (MATH 228-1 for MATH 228-2), else the option needing the
// fewest courses.
// Then it fills quarters from the next one on: a course goes in once
// its prerequisites are done in an earlier quarter (its corequisites by the
// same one), in a quarter it runs on this year's schedule, with at most
// `perQuarter` courses a quarter, counting courses already planned there.
// Courses with the longest chain still ahead of them go first. Planned
// courses keep their quarter unless it comes before their prerequisites.
import { earlierPart, eachCode, satisfied } from './model.js';
import { QUARTERS, currentTerm, parseTerm, termKey, termOrder } from './plan.js';

const LOOKAHEAD = 15; // quarters to fill: five years of fall, winter and spring

// The quarter after `term`, skipping summer.
export function nextTerm(term) {
  let { year, index } = parseTerm(term);
  do {
    index += 1;
    if (index === QUARTERS.length) {
      index = 0;
      year += 1;
    }
  } while (QUARTERS[index].id === 'SU');
  return termKey(year, QUARTERS[index].id);
}

const quarterName = term => QUARTERS[parseTerm(term).index].name;

// Quarter names ("Fall", ...) a course runs in this year, or null when the schedule doesn't say.
export function offeredNames(c) {
  const names = Object.keys(c?.offered || {}).map(q => q.split(' ')[0]);
  return names.length ? new Set(names) : null;
}

// Compares [a, b, ...] keys in order.
function isBefore(a, b) {
  const i = a.findIndex((v, j) => v !== b[j]);
  return i >= 0 && a[i] < b[i];
}

// What a course requires: prerequisites (done in an earlier quarter) and
// corequisites (done by the same quarter). Other departments' courses have
// them only when the catalog sentence was plain enough to read (autoPrereq).
function requirements(map, id) {
  const c = map.get(id);
  if (c?.role === 'main') return { pre: c.prereq, co: c.coreq, known: true };
  if (c && 'autoPrereq' in c) return { pre: c.autoPrereq, co: null, known: true };
  return { pre: null, co: null, known: false };
}

export function findPath(map, plan, target, { perQuarter = 3, now = currentTerm(), prefer = () => 0 } = {}) {
  const start = nextTerm(now);
  const done = plan.doneBefore(start);
  const planned = new Set(plan.ids('planned'));
  const skipped = new Set(plan.ids('skip'));
  const path = {
    target,
    start,
    done: done.has(target),
    courses: [], // the target and everything still needed for it, in order
    when: new Map(), // course -> quarter
    steps: [], // [{ term, ids }], one per quarter
    fixed: new Set(), // keep the quarter they're planned for
    moved: new Map(), // planned before their prerequisites: course -> the quarter planned
    options: new Map(), // taken as one of several: course -> the other choices
    unplaced: [], // didn't fit in the quarters looked at
    guess: new Set(), // on this map but not on this year's schedule, so any quarter is assumed
    noSchedule: new Set(), // other departments: their schedule isn't known
    unknownReqs: new Set(), // other departments: prerequisites couldn't be read
  };
  if (path.done) return path;

  // Which courses. Courses already planned, or already picked for another
  // part of the path (one intro course, not two), cost nothing. Ones whose
  // prerequisites couldn't be read probably have some (later parts of a
  // sequence, at least the earlier parts); retired or unknown ones are a last resort.
  const cost = ids => {
    let n = 0;
    for (const id of ids) {
      if (planned.has(id) || chosen.has(id)) continue;
      const c = map.get(id);
      n += !c || c.missing ? 5 : skipped.has(id) ? 10 : 1;
      if (!requirements(map, id).known) n += Math.max(1, Number(c?.num.split('-')[1]) || 0);
    }
    return n;
  };
  const memo = new Map();
  const visiting = new Set();
  const choices = new Map();
  const chosen = new Set();
  const withNeeds = id => {
    if (done.has(id)) return new Set();
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return new Set([id]); // a loop in the data
    visiting.add(id);
    const { pre, co } = requirements(map, id);
    const out = new Set([id, ...needs(pre, id), ...needs(co, id)]);
    visiting.delete(id);
    memo.set(id, out);
    return out;
  };
  // `owner` is the course whose requirements these are.
  const needs = (tree, owner) => {
    if (!tree) return new Set();
    if (typeof tree === 'string') return withNeeds(tree);
    const [op, items] = Object.entries(tree)[0];
    if (op === 'and') return new Set(items.flatMap(t => [...needs(t, owner)]));
    if (satisfied(tree, done)) return new Set();
    // An option in the plan, then one without courses marked "not interested",
    // then the usual one, then the earlier part of the same sequence, then the
    // fewest courses.
    // Ties go to the option listed first, usually the standard one.
    // Every option is priced against what was picked before this choice, not
    // against what weighing the other options picked along the way.
    const before = new Set(chosen);
    const options = items.map(t => ({ t, set: needs(t, owner) }));
    chosen.clear();
    before.forEach(id => chosen.add(id));
    let best = null;
    for (const option of options) {
      const { t, set } = option;
      const top = typeof t === 'string' ? [t] : Object.values(t)[0].filter(x => typeof x === 'string');
      option.rank = [top.some(x => planned.has(x)) ? 0 : 1, [...set].some(x => skipped.has(x)) ? 1 : 0, -prefer(top),
        typeof t === 'string' && earlierPart(map, t, owner) ? 0 : 1, cost(set)];
      if (!best || isBefore(option.rank, best.rank)) best = option;
    }
    if (typeof best.t === 'string' && !choices.has(best.t)) choices.set(best.t, items.filter(t => typeof t === 'string' && t !== best.t));
    best.set.forEach(id => chosen.add(id));
    return best.set;
  };
  const ids = new Set(withNeeds(target));
  // Drop what another choice made unnecessary: CS 150 picked for one course
  // when GEN_ENG 150, picked for another, also covers it. Planned courses stay.
  const covered = () => {
    const have = new Set([...done, ...ids]);
    return [...ids].every(id => {
      const r = requirements(map, id);
      return satisfied(r.pre, have) && satisfied(r.co, have);
    });
  };
  for (let dropped = true; dropped;) {
    dropped = false;
    for (const id of [...ids]) {
      if (id === target || planned.has(id)) continue;
      ids.delete(id);
      if (covered()) dropped = true;
      else ids.add(id);
    }
  }
  // A course whose prerequisites couldn't be read still comes after the
  // courses on the path that its catalog text mentions.
  const reqs = new Map([...ids].map(id => {
    const r = requirements(map, id);
    const mentions = r.known ? [] : (map.get(id)?.links || []).filter(x => ids.has(x) && x !== id);
    return [id, { ...r, pre: mentions.length ? { and: [...(r.pre ? [r.pre] : []), ...mentions] } : r.pre }];
  }));

  // How many quarters must still follow each course before the target:
  // prerequisites add one, corequisites none.
  const later = new Map([...ids].map(id => [id, []]));
  for (const id of ids) {
    eachCode(reqs.get(id).pre, p => p !== id && later.get(p)?.push([id, 1]));
    eachCode(reqs.get(id).co, p => p !== id && later.get(p)?.push([id, 0]));
  }
  const ahead = new Map();
  const seen = new Set();
  const chain = id => {
    if (ahead.has(id)) return ahead.get(id);
    if (seen.has(id)) return 0; // a loop in the data
    seen.add(id);
    const n = Math.max(0, ...later.get(id).map(([next, gap]) => chain(next) + gap));
    ahead.set(id, n);
    return n;
  };
  const runs = (id, term) => {
    const offered = offeredNames(map.get(id));
    return !offered || offered.has(quarterName(term));
  };
  const rarity = id => offeredNames(map.get(id))?.size ?? QUARTERS.length;

  // Which quarters, with `fixed` courses kept where they're planned.
  const schedule = fixed => {
    const when = new Map();
    // Courses already planned for a quarter count toward its limit, unless
    // the path is about to place them somewhere else.
    const load = new Map();
    for (const [id, entry] of Object.entries(plan.courses)) {
      if (entry.s === 'planned' && entry.t && (fixed.has(id) || !ids.has(id))) load.set(entry.t, (load.get(entry.t) || 0) + 1);
    }
    const terms = [];
    for (let t = start; terms.length < LOOKAHEAD; t = nextTerm(t)) terms.push(t);
    for (const t of fixed.values()) if (!terms.includes(t)) terms.push(t);
    terms.sort((a, b) => termOrder(a) - termOrder(b));
    const before = new Set(done);
    for (const term of terms) {
      if (when.size === ids.size) break;
      const here = new Set();
      for (const [id, t] of fixed) {
        if (t !== term) continue;
        when.set(id, term);
        here.add(id);
      }
      let room = quarterName(term) === 'Summer' ? 0 : perQuarter - (load.get(term) || 0);
      while (room > 0) {
        const together = new Set([...before, ...here]);
        const fits = [...ids].filter(id => !when.has(id) && !fixed.has(id) && runs(id, term)
          && satisfied(reqs.get(id).pre, before) && satisfied(reqs.get(id).co, together));
        if (!fits.length) break;
        fits.sort((a, b) => chain(b) - chain(a) || rarity(a) - rarity(b) || a.localeCompare(b));
        when.set(fits[0], term);
        here.add(fits[0]);
        room -= 1;
      }
      here.forEach(id => before.add(id));
    }
    return when;
  };
  // A quarter that comes before the course's prerequisites (or corequisites) are done.
  const tooEarly = (when, id) => {
    const t = termOrder(when.get(id));
    const before = new Set(done);
    const by = new Set(done);
    for (const [other, term] of when) {
      if (termOrder(term) < t) before.add(other);
      if (termOrder(term) <= t) by.add(other);
    }
    return !satisfied(reqs.get(id).pre, before) || !satisfied(reqs.get(id).co, by);
  };

  const fixed = new Map([...ids].filter(id => planned.has(id) && plan.term(id)).map(id => [id, plan.term(id)]));
  let when = schedule(fixed);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, term] of fixed) {
      if (!when.has(id) || !tooEarly(when, id)) continue;
      fixed.delete(id);
      path.moved.set(id, term);
      changed = true;
    }
    if (changed) when = schedule(fixed);
  }
  for (const [id, term] of path.moved) if (when.get(id) === term) path.moved.delete(id);

  path.when = when;
  path.fixed = new Set(fixed.keys());
  for (const [id, others] of choices) if (ids.has(id)) path.options.set(id, others);
  const label = id => (map.get(id) ? map.label(map.get(id)) : id);
  const order = id => (when.has(id) ? termOrder(when.get(id)) : Infinity);
  path.courses = [...ids].sort((a, b) => order(a) - order(b) || (a === target) - (b === target)
    || label(a).localeCompare(label(b), undefined, { numeric: true }));
  for (const id of path.courses) {
    const c = map.get(id);
    if (!when.has(id)) path.unplaced.push(id);
    if (!reqs.get(id).known) path.unknownReqs.add(id);
    if (!offeredNames(c)) (c?.role === 'main' ? path.guess : path.noSchedule).add(id);
    const term = when.get(id);
    if (!term) continue;
    const last = path.steps[path.steps.length - 1];
    if (last?.term === term) last.ids.push(id);
    else path.steps.push({ term, ids: [id] });
  }
  return path;
}

// Paths are worked out on demand and kept until the plan changes
// (derive() in main.js starts a fresh state.paths).
export function pathFor(state, id) {
  const key = `${id}|${state.pathPace}`;
  if (!state.paths.has(key)) state.paths.set(key, findPath(state.map, state.plan, id, { perQuarter: state.pathPace, prefer: state.prefer }));
  return state.paths.get(key);
}
