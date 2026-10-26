// Loading map data and everything derived from it: edges, prerequisite
// chains, degree highlights, search and the "what can I take" planner.
//
// A prerequisite tree is a course id, {"and": [...]} or {"or": [...]}.

// When one pair of courses is linked several ways, keep the strongest.
const EDGE_RANK = { req: 0, alt: 1, co: 2, ext: 3, rec: 4 };
// Recommended courses are not part of a prerequisite chain.
const CHAIN_KINDS = new Set(['req', 'alt', 'co', 'ext']);
const REQUIRED_KINDS = new Set(['req', 'co']);

export async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return res.json();
}

export function eachCode(tree, fn, inOr = false) {
  if (!tree) return;
  if (typeof tree === 'string') {
    fn(tree, inOr);
    return;
  }
  const [op, items] = Object.entries(tree)[0];
  for (const item of items) eachCode(item, fn, inOr || op === 'or');
}

export function satisfied(tree, taken) {
  if (!tree) return true;
  if (typeof tree === 'string') return taken.has(tree);
  const [op, items] = Object.entries(tree)[0];
  return op === 'and' ? items.every(t => satisfied(t, taken)) : items.some(t => satisfied(t, taken));
}

// The top-level pieces of a tree that are still unmet, for "Still needed".
export function unmet(tree, taken) {
  if (satisfied(tree, taken)) return [];
  return typeof tree === 'object' && tree.and ? tree.and.filter(t => !satisfied(t, taken)) : [tree];
}

export const codesIn = tree => {
  const out = [];
  eachCode(tree, id => out.push(id));
  return out;
};

// A course's requirement trees: its prerequisites and corequisites, or for
// another department's course, the ones read from its catalog text.
export function requirementTrees(c) {
  if (!c) return [];
  return (c.role === 'main' ? [c.prereq, c.coreq] : [c.autoPrereq]).filter(Boolean);
}

// MATH 228-1 is the earlier part of MATH 228-2's sequence.
export function earlierPart(map, id, of) {
  const a = map.get(id);
  const b = map.get(of);
  if (!a || !b || a.dept !== b.dept) return false;
  const [numA, partA] = a.num.split('-');
  const [numB, partB] = b.num.split('-');
  return numA === numB && Number(partA) < Number(partB);
}

// [a, b, ...] keys compared in order: does `a` come after `b`?
const isAfter = (a, b) => {
  const i = a.findIndex((v, j) => v !== b[j]);
  return i >= 0 && a[i] > b[i];
};

// "One of several" requirements, folded: of each group of options only the
// usual one is drawn, and the others fold into it. `rank` scores an option
// (a list of courses; higher is more usual); ties go to the earlier part of
// the course's own sequence (MATH 228-1 for MATH 228-2), then to the option
// more courses require (so groups pick alike and fewer cards are drawn),
// then to the option listed first. Options fold only if `canFold` passes all
// their courses.
// Where a course's requirements couldn't be read as a tree, parallel versions
// among the courses its catalog text names fold the same way (GEN_ENG 151
// into GEN_ENG 150).
//
// Returns `folded` (course -> the courses before it that aren't drawn) and
// `alts` (usual course -> course it's an option for -> the other options).
export function foldOptions(map, rank, canFold = () => true) {
  const folded = new Map();
  const alts = new Map();
  for (const c of map.courses) {
    const keep = new Set();
    const drop = new Set();
    // Which options fold into the usual one.
    const choose = options => {
      const uses = ids => Math.max(...ids.map(id => map.children.get(id)?.length || 0));
      const score = i => [rank(options[i]), options[i].length === 1 && earlierPart(map, options[i][0], c.id) ? 1 : 0,
        uses(options[i]), -i];
      let best = 0;
      options.forEach((ids, i) => { if (isAfter(score(i), score(best))) best = i; });
      const foldable = options.map((ids, i) => i !== best && ids.every(canFold));
      const others = options.filter((ids, i) => foldable[i]);
      if (others.length && options[best].length === 1) {
        if (!alts.has(options[best][0])) alts.set(options[best][0], new Map());
        const into = alts.get(options[best][0]);
        into.set(c.id, [...(into.get(c.id) || []), ...others]);
      }
      return foldable;
    };
    const visit = (tree, drawn) => {
      if (typeof tree === 'string') {
        (drawn ? keep : drop).add(tree);
        return;
      }
      const [op, items] = Object.entries(tree)[0];
      const foldable = op === 'or' && drawn ? choose(items.map(codesIn)) : [];
      items.forEach((t, i) => visit(t, drawn && !foldable[i]));
    };
    const trees = requirementTrees(c);
    trees.forEach(t => visit(t, true));
    if (!trees.length) {
      const named = map.parents.get(c.id).map(e => e.source);
      const seen = new Set();
      for (const id of named) {
        if (seen.has(id)) continue;
        const group = named.filter(x => x === id || map.parallels.get(id)?.has(x));
        group.forEach(x => seen.add(x));
        if (group.length < 2) continue;
        const foldable = choose(group.map(x => [x]));
        group.forEach((x, i) => (foldable[i] ? drop : keep).add(x));
      }
    }
    const gone = [...drop].filter(id => !keep.has(id));
    if (gone.length) folded.set(c.id, new Set(gone));
  }
  return { folded, alts };
}

// One map's data from several maps' files (a student's majors and minors).
// Courses in `mainDepts` are the map's own; a course another file has as its
// own, hand-checked, keeps that tree (as autoPrereq) when it isn't one here.
export function combineData(datas, mainDepts, { id, name }) {
  const main = new Set(mainDepts);
  const rank = c => (c.role === 'main' ? 2 : 'autoPrereq' in c ? 1 : 0);
  const records = new Map();
  for (const d of datas) {
    for (const c of d.courses) {
      const prev = records.get(c.id);
      const keep = !prev || rank(c) > rank(prev) ? { ...c } : prev;
      keep.links = [...new Set([...(prev?.links || []), ...(c.links || [])])];
      records.set(c.id, keep);
    }
  }
  const courses = [...records.values()].map(c => {
    if (main.has(c.dept) || c.role !== 'main') return c;
    const links = [...codesIn(c.prereq), ...codesIn(c.coreq), ...c.links].filter(x => x !== c.id && records.has(x));
    return { ...c, role: 'external', autoPrereq: c.prereq ?? null, prereq: null, coreq: null,
      recommended: [], notes: [], links: [...new Set(links)] };
  });
  courses.forEach(c => { if (!c.links.length) delete c.links; });
  const departments = {};
  for (const d of datas) {
    for (const [code, info] of Object.entries(d.departments)) departments[code] = { ...info, main: main.has(code) };
  }
  const unique = (list, key) => [...new Map(list.map(x => [key(x), x])).values()];
  return {
    id,
    name,
    generated: datas.map(d => d.generated).sort().at(-1),
    catalogYear: datas[0].catalogYear,
    quarters: [...new Set(datas.flatMap(d => d.quarters || []))],
    departments: Object.fromEntries(Object.entries(departments).sort(([a, x], [b, y]) => (y.main - x.main) || a.localeCompare(b))),
    programs: unique(datas.flatMap(d => d.programs || []), p => p.id),
    sources: [...new Set(datas.flatMap(d => d.sources || []))],
    courses: courses.sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'main' ? -1 : 1)),
  };
}

// Why hiding courses ("not interested") can hurt: a requirement of the
// student's programs can no longer be met, or a course they need (required
// with no other choice, or planned) requires one of them. Short reasons.
export function dropWarnings(map, programs, plan, ids) {
  const drop = new Set([...plan.ids('skip'), ...ids]);
  const label = id => (map.get(id) ? map.label(map.get(id)) : id.replace(/-0$/, ''));
  const names = list => list.map(label).join(', ');
  const reasons = [];
  const needed = new Map(); // course -> why the student needs it
  for (const p of programs) {
    const name = p.short || p.name;
    for (const list of p.lists) {
      const hit = ids.filter(id => list.items.some(alts => alts.some(alt => alt.includes(id))));
      const viable = list.items.filter(alts => alts.some(alt => alt.every(c => !drop.has(c)))).length;
      if (hit.length && list.need && viable < list.need) reasons.push(`${name} “${list.label}” needs ${names(hit)}.`);
      if (list.need && list.need === list.items.length) {
        for (const alts of list.items) {
          if (alts.length === 1) alts[0].forEach(c => needed.has(c) || needed.set(c, `required for ${name}`));
        }
      }
    }
  }
  plan.ids('planned').forEach(c => needed.has(c) || needed.set(c, 'in your plan'));
  for (const id of ids) {
    const by = [...needed].filter(([c]) => !drop.has(c) && c !== id && map.requiredAncestors(c).has(id));
    if (by.length) {
      reasons.push(`${label(by[0][0])} (${by[0][1]}) needs ${label(id)}${by.length > 1 ? `, and so ${by.length === 2 ? 'does 1 other course' : `do ${by.length - 1} other courses`}` : ''}.`);
    }
  }
  return reasons;
}

export const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const normText = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class CourseMap {
  constructor(data) {
    this.data = data;
    this.id = data.id;
    this.name = data.name;
    this.courses = data.courses;
    this.quarters = data.quarters || [];
    this.byId = new Map(this.courses.map(c => [c.id, c]));

    this.edges = buildEdges(this.courses, this.byId);
    this.parents = new Map(this.courses.map(c => [c.id, []]));
    this.children = new Map(this.courses.map(c => [c.id, []]));
    for (const e of this.edges) {
      this.parents.get(e.target).push(e);
      this.children.get(e.source).push(e);
    }

    // Parallel versions: one department's courses offered as options for
    // each other ("MATH 228-1 or MATH 230-1"), neither needing the other.
    this.parallels = new Map();
    const pair = (a, b) => {
      if (!this.parallels.has(a)) this.parallels.set(a, new Set());
      this.parallels.get(a).add(b);
    };
    const options = tree => {
      if (!tree || typeof tree === 'string') return;
      const [op, items] = Object.entries(tree)[0];
      items.forEach(options);
      if (op !== 'or') return;
      const ids = items.filter(t => typeof t === 'string' && this.byId.has(t));
      for (const a of ids) {
        for (const b of ids) {
          const same = a !== b && this.byId.get(a).dept === this.byId.get(b).dept;
          if (same && !this.ancestors(a).has(b) && !this.ancestors(b).has(a)) pair(a, b);
        }
      }
    };
    this.courses.forEach(c => requirementTrees(c).forEach(options));

    // Courses from other departments that a course here requires; they're
    // always worth showing. Others appear only through a chosen program.
    this.required = new Set();
    for (const c of this.courses) {
      if (c.role !== 'main') continue;
      eachCode(c.prereq, id => this.required.add(id));
      eachCode(c.coreq, id => this.required.add(id));
      (c.recommended || []).forEach(id => this.required.add(id));
    }

    // Majors/minors. Each requirement list has items; an item is a list of
    // alternatives, each a list of courses taken together. Each map keeps its
    // own copies: maps built from the same file mark different courses.
    this.programs = (data.programs || []).map(p => ({ ...p, lists: p.lists.map(list => ({ ...list })) }));
    this.highlights = [];
    this.membership = new Map();
    for (const program of this.programs) {
      program.courses = new Set();
      for (const list of program.lists) {
        list.key = `${program.id}:${slug(list.label)}`;
        list.ids = new Set(list.items.flat(2).filter(id => this.byId.has(id)));
        list.ids.forEach(id => program.courses.add(id));
        const unlisted = [...new Set(list.items.flat(2))].filter(id => !this.byId.has(id));
        this.highlights.push({ key: list.key, group: program.name, program: program.id, label: list.label, ids: list.ids, unlisted, url: program.url });
        for (const id of list.ids) {
          if (!this.membership.has(id)) this.membership.set(id, []);
          this.membership.get(id).push({ program, list, key: list.key });
        }
      }
    }
    for (const q of this.quarters) {
      this.highlights.push({
        key: `q:${slug(q)}`,
        group: 'Schedule',
        label: `Offered ${q}`,
        ids: new Set(this.courses.filter(c => c.offered?.[q]).map(c => c.id)),
      });
    }
  }

  program(id) {
    return this.programs.find(p => p.id === id) || null;
  }

  // How far a requirement list is: per item 'taken' | 'planned' | null.
  progress(list, taken, planned) {
    const all = new Set([...taken, ...planned]);
    const covered = (alts, set) => alts.some(alt => alt.every(id => set.has(id)));
    const items = list.items.map(alts => (covered(alts, taken) ? 'taken' : covered(alts, all) ? 'planned' : null));
    return {
      items,
      taken: items.filter(s => s === 'taken').length,
      planned: items.filter(s => s === 'planned').length,
      need: list.need,
    };
  }

  get(id) {
    return this.byId.get(id);
  }

  label(c) {
    const abbr = this.data.departments[c.dept]?.abbr ?? c.dept.replace(/_/g, ' ');
    return `${abbr} ${c.num.replace(/-0$/, '')}`;
  }

  deptName(c) {
    return this.data.departments[c.dept]?.name || c.dept;
  }

  highlight(key) {
    return this.highlights.find(h => h.key === key) || this.extraHighlights?.find(h => h.key === key)
      || this.resolveHighlight?.(key) || null;
  }

  // Highlights that depend on the viewer (their plan), set by the app.
  // `resolve` makes the rest from their key on demand (a path to a course).
  setExtraHighlights(list, resolve = null) {
    this.extraHighlights = list;
    this.resolveHighlight = resolve;
  }

  scheduleLabel() {
    const q = this.quarters;
    return q.length ? `${q[0]} – ${q[q.length - 1]}` : '';
  }

  ancestors(id) {
    return walk(id, this.parents, 'source');
  }

  descendants(id) {
    return walk(id, this.children, 'target');
  }

  // What a course needs whichever options a student picks: required courses
  // and corequisites, followed back, but not "one of several" alternatives.
  requiredAncestors(id) {
    return walk(id, this.parents, 'source', REQUIRED_KINDS);
  }

  // 'taken' | 'available' | 'blocked', or null when unknown. Other departments'
  // prerequisites aren't checked by hand; the scraper keeps them (autoPrereq)
  // only when the catalog sentence is plain enough to read reliably.
  status(c, taken) {
    if (taken.has(c.id)) return 'taken';
    if (c.role === 'main') return satisfied(c.prereq, taken) ? 'available' : 'blocked';
    if (!('autoPrereq' in c)) return null;
    return satisfied(c.autoPrereq, taken) ? 'available' : 'blocked';
  }

  treeText(tree, top = true) {
    if (!tree) return '';
    if (typeof tree === 'string') return this.byId.has(tree) ? this.label(this.get(tree)) : tree;
    const [op, items] = Object.entries(tree)[0];
    const text = items.map(t => this.treeText(t, false)).join(op === 'and' ? ' and ' : ' or ');
    return top ? text : `(${text})`;
  }

  search(query, limit = 8) {
    const q = normText(query);
    if (!q) return [];
    const compact = q.replace(/ /g, '');
    const words = q.split(' ');
    const scored = [];
    for (const c of this.courses) {
      let score = Infinity;
      for (const key of this.codeKeys(c)) {
        if (key === compact) score = Math.min(score, 0);
        else if (key.startsWith(compact)) score = Math.min(score, 1);
      }
      if (score > 1) {
        // Closer matches first: the title starts with what was typed, then
        // every word is a whole word in it, then every word starts one, then
        // it's somewhere inside.
        const title = normText(c.title);
        const titleWords = title.split(' ');
        if (title.startsWith(q)) score = 2;
        else if (words.every(w => titleWords.includes(w))) score = 3;
        else if (words.every(w => titleWords.some(t => t.startsWith(w)))) score = 4;
        else if (title.includes(q)) score = 5;
      }
      if (score < Infinity) scored.push([score, c]);
    }
    // Then by course number (MATH 220 before CHEM 342), then by department.
    const number = c => c.num.split('-').map(Number);
    scored.sort(([sa, a], [sb, b]) => sa - sb || number(a)[0] - number(b)[0] || number(a)[1] - number(b)[1]
      || a.dept.localeCompare(b.dept));
    return scored.slice(0, limit).map(([, c]) => c);
  }

  // "ce303", "compeng303", "303" (and "3471" for 347-1) all find COMP_ENG 303-0.
  codeKeys(c) {
    const num = c.num.replace(/-0$/, '').replace('-', '');
    const abbr = normText(this.data.departments[c.dept]?.abbr || c.dept).replace(/ /g, '');
    return [abbr + num, normText(c.dept).replace(/ /g, '') + num, num];
  }
}

function buildEdges(courses, byId) {
  const best = new Map();
  const add = (source, target, kind) => {
    if (!byId.has(source) || source === target) return;
    const key = `${source}|${target}`;
    const prev = best.get(key);
    if (!prev || EDGE_RANK[kind] < EDGE_RANK[prev.kind]) best.set(key, { source, target, kind });
  };
  for (const c of courses) {
    eachCode(c.prereq, (id, inOr) => add(id, c.id, inOr ? 'alt' : 'req'));
    eachCode(c.coreq, id => add(id, c.id, 'co'));
    for (const id of c.recommended || []) add(id, c.id, 'rec');
    for (const id of c.links || []) add(id, c.id, 'ext');
  }
  return [...best.values()];
}

function walk(start, adjacency, key, kinds = CHAIN_KINDS) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    for (const e of adjacency.get(stack.pop()) || []) {
      const next = e[key];
      if (kinds.has(e.kind) && next !== start && !seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}
