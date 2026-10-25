// Graph view: the level layout, SVG rendering, pan/zoom, keyboard navigation
// and the visual states (selection chain, highlight, planner badges).
//
// Layout: one horizontal band per course level (100, 200, 300, ...), one
// column per department (this map's departments, then "Other departments").
// Inside a band, a course that needs another course of the same level sits
// in a lower "tier", so progressions such as CE 303 -> 355 -> 387 read
// top to bottom. Links are drawn on demand (hover, selection, highlight).
/* global d3 */

const NODE_W = 160;
const NODE_H = 42;
const GAP_X = 12;
const GAP_Y = 10;
const TIER_GAP = 14; // extra space before the next tier of a cell
const GROUP_GAP = 56; // between department columns
const PAD = 32;
const HEADER_H = 30; // department titles above the first band
const BAND_TOP = 44; // room for the band label
const BAND_BOTTOM = 20;
const MAX_COLS = 8;
const OTHER = '_other';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TITLE_FONT = `11px ${FONT}`;
// Below FAR the nodes switch to a large code-only label (semantic zoom);
// below READABLE even that is too small, so reveal() zooms in.
const FAR = 0.72;
const READABLE = 0.42;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const translate = p => `translate(${p.x},${p.y})`;

export class GraphView {
  constructor(svgEl, { onSelect }) {
    this.el = svgEl;
    this.svg = d3.select(svgEl);
    this.onSelect = onSelect;
    this.map = null;
    this.visible = new Set();
    this.state = null;
    this.layout = { nodes: new Map(), edges: [], bands: [], labels: [], width: 0, height: 0, cols: '' };
    this.focus = { sel: null, up: new Set(), down: new Set() };
    this.transform = d3.zoomIdentity;
    this.insets = { top: 0, bottom: 0 }; // px covered by floating controls / the phone sheet
    this.measure = document.createElement('canvas').getContext('2d');
    this.measure.font = TITLE_FONT;
    const titles = document.createElement('canvas').getContext('2d');
    titles.font = `650 22px ${FONT}`; // matches .graph.is-far .group-label
    this.titleWidth = text => titles.measureText(text).width + text.length * 1.1; // + letter-spacing

    this.viewport = this.svg.append('g').attr('class', 'viewport');
    this.bandLayer = this.viewport.append('g').attr('class', 'bands');
    this.edgeLayer = this.viewport.append('g').attr('class', 'edges');
    this.nodeLayer = this.viewport.append('g').attr('class', 'nodes');
    this.edgeSel = this.edgeLayer.selectAll('path.edge');
    this.nodeSel = this.nodeLayer.selectAll('g.node');

    // Drag pans, pinch or Ctrl+scroll zooms; plain scrolling pans (onWheel).
    this.zoom = d3.zoom()
      .scaleExtent([0.15, 2.5])
      .filter(e => (e.type === 'wheel' ? e.ctrlKey : !e.button))
      .on('zoom', e => {
        this.transform = e.transform;
        this.viewport.attr('transform', e.transform);
        this.svg.classed('is-far', e.transform.k < FAR);
      });
    this.svg.call(this.zoom).on('dblclick.zoom', null);
    svgEl.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    svgEl.addEventListener('keydown', e => this.onKey(e));
    // d3.zoom swallows the click that ends a drag, so this only fires on a real click.
    this.svg.on('click', e => {
      if (!e.target.closest('.node')) this.onSelect(null, { source: 'graph' });
    });
  }

  // ---------------------------------------------------------------- data

  setData(map, visibleIds, { animate = false } = {}) {
    const fresh = map !== this.map;
    this.map = map;
    this.visible = visibleIds;
    if (fresh) {
      this.nodeLayer.selectAll('*').remove();
      this.edgeLayer.selectAll('*').remove();
    }
    this.layout = computeLayout(map, visibleIds, this.viewportSize(), this.titleWidth);
    this.draw(animate && !fresh && !reducedMotion());
    if (this.state) this.update(this.state);
  }

  // Column counts are picked to suit the stage's shape; redo them when it changes a lot.
  refit() {
    if (!this.map) return false;
    const next = computeLayout(this.map, this.visible, this.viewportSize(), this.titleWidth);
    if (next.cols === this.layout.cols) return false;
    this.setData(this.map, this.visible, { animate: true });
    return true;
  }

  // The stage can be hidden (list view) when the layout is computed.
  viewportSize() {
    const w = this.el.clientWidth || window.innerWidth;
    const h = this.el.clientHeight || window.innerHeight - 120;
    return { w, h };
  }

  setShowLinks(on) {
    this.svg.classed('show-links', on);
  }

  draw(animate) {
    const { nodes, edges, bands, labels, width } = this.layout;
    const duration = animate ? 450 : 0;

    this.bandLayer.selectAll('rect')
      .data(bands)
      .join('rect')
      .attr('class', (b, i) => `band${i % 2 ? ' is-alt' : ''}`)
      .attr('x', 0)
      .attr('y', b => b.top)
      .attr('width', width)
      .attr('height', b => b.bottom - b.top);
    this.bandLayer.selectAll('text')
      .data(labels)
      .join('text')
      .attr('class', l => l.cls)
      .attr('x', l => l.x)
      .attr('y', l => l.y)
      .text(l => l.text);

    // Hide edges while nodes glide to their new places, then fade them back in.
    this.edgeLayer.classed('is-moving', animate);
    this.edgeSel = this.edgeLayer.selectAll('path.edge')
      .data(edges, e => `${e.source}|${e.target}`)
      .join('path')
      .attr('class', e => `edge k-${e.kind}`)
      .attr('d', e => edgePath(nodes.get(e.source), nodes.get(e.target)));
    if (animate) setTimeout(() => this.edgeLayer.classed('is-moving', false), duration);

    this.nodeSel = this.nodeLayer.selectAll('g.node')
      .data([...nodes.keys()], id => id)
      .join(
        enter => {
          const g = this.createNodes(enter).attr('transform', id => translate(nodes.get(id)));
          if (animate) {
            g.style('opacity', 0).transition().duration(duration).style('opacity', 1)
              .on('end', function () { d3.select(this).style('opacity', null); });
          }
          return g;
        },
        update => update.call(u => (animate ? u.transition().duration(duration) : u)
          .attr('transform', id => translate(nodes.get(id)))),
        exit => exit.remove(),
      );
  }

  createNodes(enter) {
    const map = this.map;
    const g = enter.append('g')
      .attr('class', id => {
        const c = map.get(id);
        return `node${c.role === 'main' ? '' : ' is-ext'}${c.missing ? ' is-missing' : ''}`;
      })
      .attr('data-id', id => id)
      .attr('role', 'button')
      .attr('tabindex', -1)
      .on('click', (e, id) => this.onSelect(id, { source: 'graph' }))
      .on('pointerenter', (e, id) => { if (e.pointerType === 'mouse') this.setHover(id); })
      .on('pointerleave', () => this.setHover(null))
      .on('focus', (e, id) => this.onNodeFocus(id))
      .on('blur', () => this.setHover(null));
    g.append('rect').attr('class', 'card').attr('width', NODE_W).attr('height', NODE_H).attr('rx', 7);
    g.append('text').attr('class', 'code').attr('x', 10).attr('y', 17).text(id => map.label(map.get(id)));
    g.append('text').attr('class', 'title').attr('x', 10).attr('y', 32)
      .text(id => this.fitText(map.get(id).title || 'Not in the current catalog', NODE_W - 20));
    const badge = g.append('g').attr('class', 'badge').attr('aria-hidden', 'true')
      .attr('transform', `translate(${NODE_W - 13},13)`);
    badge.append('circle').attr('r', 6);
    badge.append('path').attr('class', 'check').attr('d', 'M-3 0.2 -0.9 2.3 3 -1.8');
    g.append('title').text(id => {
      const c = map.get(id);
      return c.title ? `${c.id}: ${c.title}` : c.id;
    });
    return g;
  }

  fitText(text, max) {
    if (this.measure.measureText(text).width <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.measure.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= max) lo = mid;
      else hi = mid - 1;
    }
    return `${text.slice(0, lo).trimEnd()}…`;
  }

  // -------------------------------------------------------------- states

  update(state) {
    this.state = state;
    const map = this.map;
    if (!map) return;
    const { taken } = state;
    const showStatus = [...taken].some(id => map.get(id));
    const hl = state.highlight ? map.highlight(state.highlight) : null;
    const sel = state.selected && this.layout.nodes.has(state.selected) ? state.selected : null;

    const up = new Set();
    const down = new Set();
    if (sel) {
      map.ancestors(sel).forEach(id => up.add(id));
      map.descendants(sel).forEach(id => down.add(id));
      // Recommended courses aren't part of the chain, but show the direct ones.
      for (const e of map.parents.get(sel)) if (e.kind === 'rec') up.add(e.source);
      for (const e of map.children.get(sel)) if (e.kind === 'rec') down.add(e.target);
    }
    this.focus = { sel, up, down };
    const inFocus = id => id === sel || up.has(id) || down.has(id);
    const isUp = e => !!sel && up.has(e.source) && (e.target === sel || up.has(e.target));
    const isDown = e => !!sel && (e.source === sel || down.has(e.source)) && down.has(e.target);
    const inHighlight = e => !sel && !!hl && hl.ids.has(e.source) && hl.ids.has(e.target);

    this.nodeSel
      .classed('is-selected', id => id === sel)
      .classed('is-up', id => up.has(id))
      .classed('is-down', id => down.has(id) && !up.has(id))
      .classed('is-match', id => !!hl && hl.ids.has(id))
      .classed('is-dim', id => (sel ? !inFocus(id) : !!hl && !hl.ids.has(id)))
      .classed('is-taken', id => showStatus && taken.has(id))
      .classed('is-available', id => showStatus && map.status(map.get(id), taken) === 'available')
      .attr('aria-pressed', id => String(id === sel))
      .attr('aria-label', id => this.describe(id, taken, showStatus));

    this.edgeSel
      .classed('is-up', isUp)
      .classed('is-down', e => !isUp(e) && isDown(e))
      .classed('is-hl', inHighlight)
      .classed('is-dim', e => (sel ? !isUp(e) && !isDown(e) : !!hl && !inHighlight(e)));
    this.edgeSel.filter('.is-up, .is-down, .is-hl').raise();

    const stop = sel || (this.layout.nodes.has(this.tabStop) ? this.tabStop : this.firstNode());
    this.setTabStop(stop);
  }

  describe(id, taken, showStatus) {
    const map = this.map;
    const c = map.get(id);
    const before = map.parents.get(id).filter(e => e.kind !== 'rec').length;
    const after = map.children.get(id).length;
    const parts = [`${map.label(c)}, ${c.title || 'not in the current catalog'}`];
    parts.push(before ? `${before} prerequisite${before === 1 ? '' : 's'}` : 'no prerequisites');
    if (after) parts.push(`unlocks ${after}`);
    const status = showStatus ? map.status(c, taken) : null;
    if (status === 'taken') parts.push('taken');
    if (status === 'available') parts.push('you can take it now');
    return parts.join('. ');
  }

  // Previews a course's direct links (on mouse hover or keyboard focus)
  // when nothing else is in focus.
  setHover(id) {
    const map = this.map;
    const active = !!id && !this.state?.selected && !this.state?.highlight;
    this.svg.classed('has-hover', active);
    if (!active) {
      this.nodeSel.classed('is-hovered', false).classed('is-near', false);
      this.edgeSel.classed('is-hover', false);
      return;
    }
    const near = new Set([
      ...map.parents.get(id).map(e => e.source),
      ...map.children.get(id).map(e => e.target),
    ]);
    this.nodeSel.classed('is-hovered', d => d === id).classed('is-near', d => near.has(d));
    this.edgeSel.classed('is-hover', e => e.source === id || e.target === id);
    this.edgeSel.filter('.is-hover').raise();
  }

  // ------------------------------------------------------------- camera

  // The unobstructed part of the stage: width, height and top offset.
  size() {
    const { top, bottom } = this.insets;
    return { w: this.el.clientWidth, h: Math.max(120, this.el.clientHeight - top - bottom), top };
  }

  setInsets({ top = 0, bottom = 0 }) {
    this.insets = { top, bottom };
  }

  bbox(ids) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      const p = this.layout.nodes.get(id);
      if (!p) continue;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + NODE_W);
      y1 = Math.max(y1, p.y + NODE_H);
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  inView(box, margin) {
    const t = this.transform;
    const { w, h, top } = this.size();
    return t.applyX(box.x) >= margin && t.applyY(box.y) >= top + margin
      && t.applyX(box.x + box.w) <= w - margin && t.applyY(box.y + box.h) <= top + h - margin;
  }

  moveTo(box, k, { animate = true } = {}) {
    const { w, h, top } = this.size();
    const t = d3.zoomIdentity
      .translate(w / 2 - k * (box.x + box.w / 2), top + h / 2 - k * (box.y + box.h / 2))
      .scale(k);
    const target = animate && !reducedMotion() ? this.svg.transition().duration(500) : this.svg;
    target.call(this.zoom.transform, t);
  }

  // Show everything; if that would be unreadably small, start at the top-left.
  fitAll({ animate = true, minScale = 0.15 } = {}) {
    const { width, height } = this.layout;
    if (!width) return;
    const { w, h, top } = this.size();
    const pad = 16;
    const fit = Math.min((w - 2 * pad) / width, (h - 2 * pad) / height, 1);
    const k = Math.max(fit, minScale);
    const tx = width * k <= w - 2 * pad ? (w - width * k) / 2 : pad;
    const ty = top + (height * k <= h - 2 * pad ? (h - height * k) / 2 : pad);
    const t = d3.zoomIdentity.translate(tx, ty).scale(k);
    const target = animate && !reducedMotion() ? this.svg.transition().duration(450) : this.svg;
    target.call(this.zoom.transform, t);
  }

  // Bring a course into view: its whole chain if that fits at a readable
  // zoom, else its direct neighbors, else its direct prerequisites, else
  // just the course.
  reveal(id, { force = false, animate = true } = {}) {
    const { sel, up, down } = this.focus;
    const node = this.bbox([id]);
    if (!node) return;
    const k0 = this.transform.k;
    const near = this.neighbors(id);
    const before = near.filter(n => up.has(n));
    const views = id === sel ? [[id, ...up, ...down], [id, ...near], [id, ...before]] : [];
    if (!force && k0 >= READABLE && views.length && this.inView(this.bbox(views[0]), 16)) return;
    const { w, h } = this.size();
    const pad = Math.min(56, Math.round(Math.min(w, h) * 0.08));
    for (const ids of views) {
      const box = this.bbox(ids);
      const fit = Math.min((w - 2 * pad) / box.w, (h - 2 * pad) / box.h);
      if (fit >= READABLE) {
        this.moveTo(box, Math.min(Math.max(k0, 0.85), fit, 1.4), { animate });
        return;
      }
    }
    this.moveTo(node, Math.max(k0, 0.85), { animate });
  }

  neighbors(id) {
    return [...this.map.parents.get(id).map(e => e.source), ...this.map.children.get(id).map(e => e.target)]
      .filter(n => this.layout.nodes.has(n));
  }

  showIds(ids) {
    const box = this.bbox(ids);
    if (!box) return;
    const { w, h } = this.size();
    const fit = Math.min((w - 96) / box.w, (h - 96) / box.h, 1);
    if (fit >= 0.4) this.moveTo(box, fit);
    else this.moveTo({ ...box, h: Math.min(box.h, (h - 96) / 0.4) }, 0.4);
  }

  zoomBy(factor) {
    this.svg.transition().duration(reducedMotion() ? 0 : 200).call(this.zoom.scaleBy, factor);
  }

  onWheel(e) {
    if (e.ctrlKey) return; // pinch / Ctrl+scroll: d3.zoom handles it
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.el.clientHeight : 1;
    const { k } = this.transform;
    this.zoom.translateBy(this.svg, (-e.deltaX * unit) / k, (-e.deltaY * unit) / k);
  }

  // ----------------------------------------------------------- keyboard
  // One node is in the tab order at a time (roving tabindex); arrow keys
  // move to the nearest node in that direction.

  setTabStop(id) {
    this.tabStop = id;
    this.nodeSel.attr('tabindex', d => (d === id ? 0 : -1));
  }

  // The first course in reading order: top row, leftmost.
  firstNode() {
    let best = null;
    for (const [id, p] of this.layout.nodes) {
      const b = best && this.layout.nodes.get(best);
      if (!b || p.y < b.y - 1 || (Math.abs(p.y - b.y) <= 1 && p.x < b.x)) best = id;
    }
    return best;
  }

  focusNode(id) {
    this.setTabStop(id);
    this.nodeSel.filter(d => d === id).node()?.focus({ preventScroll: true });
  }

  onNodeFocus(id) {
    this.setTabStop(id);
    this.setHover(id);
    const box = this.bbox([id]);
    if (box && !this.inView(box, 24)) this.moveTo(box, Math.max(this.transform.k, READABLE));
  }

  onKey(e) {
    const node = e.target.closest?.('.node');
    if (!node) return;
    const id = node.dataset.id;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.onSelect(id, { source: 'keyboard' });
      return;
    }
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
    if (!dir) return;
    e.preventDefault();
    const next = this.nearest(id, dir);
    if (next) this.focusNode(next);
  }

  nearest(id, [dx, dy]) {
    const center = p => ({ x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 });
    const from = center(this.layout.nodes.get(id));
    let best = null;
    let bestCost = Infinity;
    for (const [other, p] of this.layout.nodes) {
      if (other === id) continue;
      const to = center(p);
      const ax = to.x - from.x;
      const ay = to.y - from.y;
      const along = ax * dx + ay * dy;
      if (along <= 1) continue;
      const cost = along + 3 * (Math.abs(ax * dy) + Math.abs(ay * dx));
      if (cost < bestCost) {
        bestCost = cost;
        best = other;
      }
    }
    return best;
  }
}

// ------------------------------------------------------------------ layout

const levelOf = c => Math.floor(parseInt(c.num, 10) / 100) * 100;

// textWidth measures a column title at its zoomed-out size.
function computeLayout(map, visible, viewport, textWidth) {
  const courses = [...visible].map(id => map.get(id));
  const depts = map.data.departments;
  const groupOf = c => (c.role === 'main' ? c.dept : OTHER);
  const groups = [...Object.keys(depts).filter(d => depts[d].main), OTHER]
    .filter(g => courses.some(c => groupOf(c) === g));
  const levels = [...new Set(courses.map(levelOf))].sort((a, b) => a - b);
  const edges = map.edges.filter(e => visible.has(e.source) && visible.has(e.target));

  // Tier = how many same-level prerequisites must come first.
  const sameLevel = new Map(courses.map(c => [c.id, []]));
  for (const e of edges) {
    if (e.kind !== 'rec' && levelOf(map.get(e.source)) === levelOf(map.get(e.target))) {
      sameLevel.get(e.target).push(e.source);
    }
  }
  const tiers = new Map();
  const tierOf = (id, path = new Set()) => {
    if (tiers.has(id)) return tiers.get(id);
    if (path.has(id)) return 0; // guard against a cycle in the data
    path.add(id);
    const t = 1 + Math.max(-1, ...sameLevel.get(id).map(p => tierOf(p, path)));
    path.delete(id);
    tiers.set(id, t);
    return t;
  };

  // cells: "level|group" -> list of tiers, each a list of courses
  const cells = new Map();
  for (const c of courses) {
    const key = `${levelOf(c)}|${groupOf(c)}`;
    if (!cells.has(key)) cells.set(key, []);
    const list = cells.get(key);
    const t = tierOf(c.id);
    while (list.length <= t) list.push([]);
    list[t].push(c);
  }
  for (const list of cells.values()) {
    for (let t = list.length - 1; t >= 0; t--) if (!list[t].length) list.splice(t, 1);
  }

  const cols = pickColumns(cells, groups, levels, viewport);

  // Place cells band by band. Tier 0 is in catalog order; later tiers sit
  // under their prerequisites as far as the columns allow.
  const nodes = new Map();
  const groupX = new Map();
  let x = PAD;
  groups.forEach((g, i) => {
    groupX.set(g, x);
    x += cols[i] * (NODE_W + GAP_X) - GAP_X + GROUP_GAP;
  });
  const width = x - GROUP_GAP + PAD;
  // Column titles, plus a short form for zoomed-out views of narrow columns.
  const labels = groups.flatMap((g, i) => {
    const full = g === OTHER ? 'Other departments' : depts[g].name;
    const short = g === OTHER ? 'Other' : depts[g].abbr || g;
    const fits = textWidth(full.toUpperCase()) <= cols[i] * (NODE_W + GAP_X) + GROUP_GAP / 2;
    return fits
      ? [{ cls: 'group-label', x: groupX.get(g), y: PAD + 12, text: full }]
      : [{ cls: 'group-label full', x: groupX.get(g), y: PAD + 12, text: full },
        { cls: 'group-label short', x: groupX.get(g), y: PAD + 12, text: short }];
  });
  const bands = [];
  let y = PAD + HEADER_H;
  const parentCenters = c => edges.filter(e => e.target === c.id && nodes.has(e.source))
    .map(e => nodes.get(e.source).x + NODE_W / 2);
  for (const level of levels) {
    let bottom = y + BAND_TOP;
    groups.forEach((g, gi) => {
      let rowY = y + BAND_TOP;
      for (const [t, list] of (cells.get(`${level}|${g}`) || []).entries()) {
        const ordered = t === 0 ? sortByCode(list) : sortUnderParents(list, parentCenters);
        ordered.forEach((c, i) => nodes.set(c.id, {
          x: groupX.get(g) + (i % cols[gi]) * (NODE_W + GAP_X),
          y: rowY + Math.floor(i / cols[gi]) * (NODE_H + GAP_Y),
        }));
        const lastRowBottom = rowY + Math.ceil(list.length / cols[gi]) * (NODE_H + GAP_Y) - GAP_Y;
        bottom = Math.max(bottom, lastRowBottom);
        rowY = lastRowBottom + GAP_Y + TIER_GAP;
      }
    });
    bands.push({ level, top: y, bottom: bottom + BAND_BOTTOM });
    labels.push({ cls: 'band-label', x: PAD, y: y + 27, text: `${level}-level` });
    y = bottom + BAND_BOTTOM;
  }

  return { nodes, edges, bands, labels, width, height: y + PAD, cols: cols.join(',') };
}

const sortByCode = list => [...list].sort((a, b) => a.id.localeCompare(b.id));

// Order by the mean x of each course's already-placed prerequisites.
function sortUnderParents(list, parentXs) {
  const mean = c => {
    const xs = parentXs(c);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity;
  };
  return [...list].map(c => [mean(c), c])
    .sort(([ma, a], [mb, b]) => ma - mb || a.id.localeCompare(b.id))
    .map(([, c]) => c);
}

// Choose how many card columns each department gets so the whole map best
// fits the stage (tries every combination; there are only a few groups).
function pickColumns(cells, groups, levels, viewport) {
  const tierSizes = (level, g) => (cells.get(`${level}|${g}`) || []).map(list => list.length);
  const options = groups.map(g => {
    const widest = Math.max(1, ...levels.flatMap(l => tierSizes(l, g)));
    return Array.from({ length: Math.min(MAX_COLS, widest) }, (_, i) => i + 1);
  });
  const measure = cols => {
    const width = 2 * PAD + cols.reduce((s, c) => s + c * (NODE_W + GAP_X) - GAP_X, 0) + GROUP_GAP * (cols.length - 1);
    let height = 2 * PAD + HEADER_H;
    for (const level of levels) {
      const cellHeights = groups.map((g, i) => {
        const sizes = tierSizes(level, g);
        const rows = sizes.reduce((s, n) => s + Math.ceil(n / cols[i]), 0);
        return rows * (NODE_H + GAP_Y) - GAP_Y + Math.max(0, sizes.length - 1) * TIER_GAP;
      });
      height += BAND_TOP + Math.max(0, ...cellHeights) + BAND_BOTTOM;
    }
    return { width, height };
  };
  // On a narrow (phone) screen, scrolling down is natural, so the map may be
  // up to three screens tall as long as every column fits across.
  const tallness = viewport.w < 600 ? 3 : 1;
  let best = null;
  const visit = (i, cols) => {
    if (i === groups.length) {
      const { width, height } = measure(cols);
      // Biggest zoom that fits; prefer fewer columns when it's a near tie.
      const score = Math.min(viewport.w / width, (tallness * viewport.h) / height)
        - 1e-4 * cols.reduce((a, b) => a + b, 0);
      if (!best || score > best.score) best = { score, cols: [...cols] };
      return;
    }
    for (const c of options[i]) visit(i + 1, [...cols, c]);
  };
  visit(0, []);
  return best.cols;
}

// Links run from the bottom of a prerequisite to the top of the course it
// unlocks. Within one column, a link that would cross other cards runs down
// the gap to the column's left instead; in the same row, side to side.
function edgePath(s, t) {
  const sx = s.x + NODE_W / 2;
  const tx = t.x + NODE_W / 2;
  if (Math.abs(s.x - t.x) < 1 && Math.abs(t.y - s.y) > NODE_H + GAP_Y + 1) {
    const x = s.x;
    const y1 = s.y + NODE_H / 2;
    const y2 = t.y + NODE_H / 2;
    const out = x - GAP_X - 2;
    return `M${x},${y1}C${out},${y1} ${out},${y2} ${x},${y2}`;
  }
  if (t.y >= s.y + NODE_H) {
    const y1 = s.y + NODE_H;
    const y2 = t.y;
    const d = Math.max(18, (y2 - y1) / 2);
    return `M${sx},${y1}C${sx},${y1 + d} ${tx},${y2 - d} ${tx},${y2}`;
  }
  if (t.y + NODE_H <= s.y) {
    const y1 = s.y;
    const y2 = t.y + NODE_H;
    const d = Math.max(18, (y1 - y2) / 2);
    return `M${sx},${y1}C${sx},${y1 - d} ${tx},${y2 + d} ${tx},${y2}`;
  }
  const right = t.x > s.x;
  const x1 = right ? s.x + NODE_W : s.x;
  const x2 = right ? t.x : t.x + NODE_W;
  const y = s.y + NODE_H / 2;
  const d = Math.max(18, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
  return `M${x1},${y}C${x1 + d},${y} ${x2 - d},${t.y + NODE_H / 2} ${x2},${t.y + NODE_H / 2}`;
}
