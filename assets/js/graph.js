// Graph view: dagre layout, SVG rendering, pan/zoom, keyboard navigation and
// the visual states (selection chain, highlight, planner badges).
/* global d3, dagre */

const NODE_W = 160;
const NODE_H = 42;
const PAD = 32;
const GRID_GAP_X = 14;
const GRID_GAP_Y = 10;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TITLE_FONT = `11px ${FONT}`;
const LABEL_FONT = `650 11px ${FONT}`;
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
    this.state = null;
    this.layout = { nodes: new Map(), edges: [], width: 0, height: 0 };
    this.focus = { sel: null, up: new Set(), down: new Set() };
    this.transform = d3.zoomIdentity;
    this.insets = { top: 0, bottom: 0 }; // px covered by floating controls / the phone sheet
    this.measure = document.createElement('canvas').getContext('2d');
    this.measure.font = TITLE_FONT;

    this.viewport = this.svg.append('g').attr('class', 'viewport');
    this.edgeLayer = this.viewport.append('g').attr('class', 'edges');
    this.labelLayer = this.viewport.append('g').attr('class', 'labels');
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
    if (fresh) {
      this.nodeLayer.selectAll('*').remove();
      this.edgeLayer.selectAll('*').remove();
    }
    this.measure.font = LABEL_FONT;
    const labelWidth = text => this.measure.measureText(text.toUpperCase()).width + text.length * 0.7;
    this.layout = computeLayout(map, visibleIds, labelWidth);
    this.measure.font = TITLE_FONT;
    this.draw(animate && !fresh && !reducedMotion());
    if (this.state) this.update(this.state);
  }

  draw(animate) {
    const { nodes, edges, labels } = this.layout;
    const duration = animate ? 450 : 0;
    const line = d3.line().curve(d3.curveBasis).x(p => p.x).y(p => p.y);

    // Hide edges while nodes glide to their new places, then fade them back in.
    this.edgeLayer.classed('is-moving', animate);
    this.edgeSel = this.edgeLayer.selectAll('path.edge')
      .data(edges, e => `${e.source}|${e.target}`)
      .join('path')
      .attr('class', e => `edge k-${e.kind}`)
      .attr('d', e => line(e.points));
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

    this.labelLayer.selectAll('text')
      .data(labels)
      .join('text')
      .attr('class', 'loose-label')
      .attr('x', l => l.x)
      .attr('y', l => l.y)
      .text(l => l.text);
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
      .on('focus', (e, id) => this.onNodeFocus(id));
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
      .classed('is-dim', e => (sel
        ? !isUp(e) && !isDown(e)
        : !!hl && !(hl.ids.has(e.source) && hl.ids.has(e.target))));
    this.edgeSel.filter('.is-up, .is-down').raise();

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

  setHover(id) {
    const map = this.map;
    // Hover previews direct links only when nothing else is in focus.
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
    const pad = 24;
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

  firstNode() {
    let best = null;
    for (const [id, p] of this.layout.nodes) {
      const b = best && this.layout.nodes.get(best);
      if (!b || p.x < b.x - 1 || (Math.abs(p.x - b.x) <= 1 && p.y < b.y)) best = id;
    }
    return best;
  }

  focusNode(id) {
    this.setTabStop(id);
    this.nodeSel.filter(d => d === id).node()?.focus({ preventScroll: true });
  }

  onNodeFocus(id) {
    this.setTabStop(id);
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

// Linked courses get a left-to-right layered layout (prerequisites first).
// Courses with no links, and other departments' courses that are only on the
// map because a degree lists them, go in grids to the right, which keeps the
// graph focused and the whole map closer to the screen's shape.
function computeLayout(map, visible, labelWidth) {
  const inGraph = id => visible.has(id) && !map.degreeOnly.has(id);
  const edges = map.edges.filter(e => inGraph(e.source) && inGraph(e.target));
  const linked = new Set(edges.flatMap(e => [e.source, e.target]));

  const minlen = new Map();
  const run = () => {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'LR', nodesep: 10, ranksep: 64, edgesep: 6, marginx: PAD, marginy: PAD, acyclicer: 'greedy' });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const id of linked) graph.setNode(id, { width: NODE_W, height: NODE_H });
    for (const e of edges) {
      graph.setEdge(e.source, e.target, { weight: e.kind === 'req' ? 2 : 1, minlen: minlen.get(e) || 1 });
    }
    if (linked.size) dagre.layout(graph);
    return graph;
  };
  let g = run();
  for (let pass = 0; pass < 3 && rebalance(g, linked, edges, minlen); pass++) g = run();

  const nodes = new Map();
  for (const id of linked) {
    const n = g.node(id);
    nodes.set(id, { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 });
  }
  const routed = edges.map(e => ({ ...e, points: g.edge(e.source, e.target).points }));
  const graphW = linked.size ? g.graph().width : 0;
  const graphH = linked.size ? g.graph().height : 0;

  const byRole = (a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'main' ? -1 : 1);
  const blocks = [
    { text: 'No links on this map', ids: [...visible].filter(id => inGraph(id) && !linked.has(id)) },
    { text: 'Other departments in degree lists', ids: [...visible].filter(id => map.degreeOnly.has(id)) },
  ].filter(b => b.ids.length);

  // Fill each block column by column, no taller than the graph.
  const step = NODE_H + GRID_GAP_Y;
  const maxRows = Math.max(6, Math.floor((graphH - 2 * PAD - 22) / step));
  const labels = [];
  let x = linked.size ? graphW + 24 : PAD;
  let height = graphH;
  for (const block of blocks) {
    const rows = Math.min(maxRows, block.ids.length);
    const cols = Math.ceil(block.ids.length / rows);
    const top = PAD + 22;
    block.ids.map(id => map.get(id)).sort(byRole).forEach((c, i) => nodes.set(c.id, {
      x: x + Math.floor(i / rows) * (NODE_W + GRID_GAP_X),
      y: top + (i % rows) * step,
    }));
    labels.push({ x, y: PAD + 8, text: block.text });
    x += Math.max(cols * (NODE_W + GRID_GAP_X) - GRID_GAP_X, labelWidth(block.text)) + 40;
    height = Math.max(height, top + rows * step - GRID_GAP_Y + PAD);
  }

  return { nodes, edges: routed, labels, width: blocks.length ? x - 40 + PAD : graphW, height };
}

// A column crowded with courses that nothing else requires makes the map very
// tall. Push every other such "leaf" one column right (by lengthening its
// incoming edges) until neighboring columns are roughly even. Returns whether
// anything changed, so the caller re-runs the layout.
function rebalance(g, linked, edges, minlen) {
  const columns = new Map();
  for (const id of linked) {
    const x = Math.round(g.node(id).x);
    if (!columns.has(x)) columns.set(x, []);
    columns.get(x).push(id);
  }
  const ranks = [...columns.keys()].sort((a, b) => a - b).map(x => columns.get(x));
  const rankOf = new Map(ranks.flatMap((ids, r) => ids.map(id => [id, r])));
  const limit = Math.max(12, Math.ceil((linked.size / ranks.length) * 1.3));
  const hasChildren = new Set(edges.map(e => e.source));
  let changed = false;
  ranks.forEach((ids, r) => {
    const room = Math.floor((ids.length - (ranks[r + 1]?.length ?? 0)) / 2);
    if (ids.length <= limit || room < 1) return;
    const leaves = ids.filter(id => !hasChildren.has(id)).sort((a, b) => g.node(a).y - g.node(b).y);
    for (const id of leaves.filter((_, i) => i % 2 === 1).slice(0, room)) {
      for (const e of edges) {
        if (e.target === id) minlen.set(e, r - rankOf.get(e.source) + 1);
      }
      changed = true;
    }
  });
  return changed;
}
