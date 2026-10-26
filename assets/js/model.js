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
    // alternatives, each a list of courses taken together.
    this.programs = data.programs || [];
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
    const abbr = this.data.departments[c.dept]?.abbr ?? c.dept;
    return `${abbr} ${c.num.replace(/-0$/, '')}`;
  }

  deptName(c) {
    return this.data.departments[c.dept]?.name || c.dept;
  }

  highlight(key) {
    return this.highlights.find(h => h.key === key) || this.extraHighlights?.find(h => h.key === key) || null;
  }

  // Highlights that depend on the viewer (their plan), set by the app.
  setExtraHighlights(list) {
    this.extraHighlights = list;
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
        const title = normText(c.title);
        const titleWords = title.split(' ');
        if (words.every(w => titleWords.some(t => t.startsWith(w)))) score = 2;
        else if (title.includes(q)) score = 3;
      }
      if (score < Infinity) scored.push([score, c]);
    }
    scored.sort(([sa, a], [sb, b]) =>
      sa - sb || (a.role === 'main' ? 0 : 1) - (b.role === 'main' ? 0 : 1) || a.id.localeCompare(b.id));
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
