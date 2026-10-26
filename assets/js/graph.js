// Graph view: the level layout, SVG rendering, pan/zoom, keyboard navigation
// and the visual states (selection chain, highlight, plan statuses and the
// multi-selection).
//
// Layout: one horizontal band per course level (100, 200, 300, ...), one
// column per department (this map's departments, then "Other departments").
// Inside a band, a course that needs another course of the same level sits
// in a lower "tier", so progressions such as CE 303 -> 355 -> 387 read
// top to bottom.
//
// Each card shows the course code and its title on two lines, an icon for
// the viewer's plan (taken, planned, can take now), how many courses on the
// map it leads to, and the quarters it's offered this year (or the quarter
// it's planned for).
/* global d3 */
import { termLabel, termShort } from './plan.js';

const NODE_W = 170;
const NODE_H = 52;
const TITLE_Y = 31; // baseline of the title's first line
const TITLE_LEADING = 13; // and of the second, below it
const GAP_X = 18; // gutter between card columns; links run down it
const GAP_Y = 16; // gap between rows; links run along it
const PITCH = NODE_H + GAP_Y;
const GROUP_GAP = 56; // between department columns
const PAD = 32;
const HEADER_H = 30; // department titles above the first band
const BAND_TOP = 44; // room for the band label
const BAND_BOTTOM = 20;
const MAX_COLS = 8;
const OTHER = '_other';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TITLE_FONT = `11px ${FONT}`;
const TERM_FONT = `600 10px ${FONT}`; // matches .node .term
const OFFERED_FONT = `650 9.5px ${FONT}`; // matches .node .offered
const OFFERED_GAP = 2; // px between the quarter letters
const REACH_FONT = `650 10.5px ${FONT}`; // matches .reach text
const MORE_FONT = `700 10px ${FONT}`; // matches .more text
const FAR_FONT = `650 19px ${FONT}`; // matches .graph.is-far .node .code
const STUB = 40; // px: the most a "more courses" line fades out over
// Below FAR the nodes switch to a large code-only label (semantic zoom);
// below READABLE even that is too small, so reveal() zooms in.
const FAR = 0.72;
const READABLE = 0.42;
// "Leads to" counts from these up get a stronger badge.
const REACH_MID = 5;
const REACH_HIGH = 15;
const LONG_PRESS = 500; // ms; on touch screens a long press selects several courses

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const translate = p => `translate(${p.x},${p.y})`;
const isToggle = e => e.shiftKey || e.metaKey || e.ctrlKey;
const STATUS_TEXT = { taken: 'Taken', planned: 'Planned', ready: 'You can take it now', skip: 'Not interested' };
const listText = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

export class GraphView {
  constructor(svgEl, { onSelect, onPick, onPreview, onExpand, minimap }) {
    this.el = svgEl;
    this.svg = d3.select(svgEl);
    this.onSelect = onSelect;
    this.onPick = onPick;
    this.onPreview = onPreview; // a course under the mouse (or keyboard focus), or null
    this.onExpand = onExpand; // "+3" above a course on a course page: show the courses before it
    this.map = null;
    this.visible = new Set();
    this.focusId = null; // the course a course page is about (its graph is laid out around it)
    this.moreUp = new Map(); // course -> how many courses before it aren't drawn (course pages)
    this.folded = new Map(); // course -> options folded away from it (see foldOptions in model.js)
    this.foldKey = '';
    this.state = null;
    this.layout = { nodes: new Map(), edges: [], bands: [], labels: [], loose: new Set(), width: 0, height: 0, cols: '' };
    this.arrange = 'steps'; // rows by prerequisite steps, or 'level' (100, 200, 300)
    this.reach = new Map(); // course -> how many courses on the map it leads to
    this.focus = { sel: null, up: new Set(), down: new Set() };
    this.transform = d3.zoomIdentity;
    this.insets = { top: 0, bottom: 0 }; // px covered by floating controls / the phone sheet
    this.measure = document.createElement('canvas').getContext('2d');
    this.measure.font = TITLE_FONT;
    const ctx = document.createElement('canvas').getContext('2d');
    this.textWidth = (text, font) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };
    // Column titles at their zoomed-out size (matches .graph.is-far .group-label), plus letter-spacing.
    this.titleWidth = text => this.textWidth(text, `650 22px ${FONT}`) + text.length * 1.1;

    this.viewport = this.svg.append('g').attr('class', 'viewport');
    this.bandLayer = this.viewport.append('g').attr('class', 'bands');
    this.edgeLayer = this.viewport.append('g').attr('class', 'edges');
    this.stubLayer = this.viewport.append('g').attr('class', 'stubs');
    this.nodeLayer = this.viewport.append('g').attr('class', 'nodes');
    this.boxRect = this.viewport.append('rect').attr('class', 'select-box').style('display', 'none');
    this.edgeSel = this.edgeLayer.selectAll('path.edge');
    this.stubSel = this.stubLayer.selectAll('rect.stub');
    this.nodeSel = this.nodeLayer.selectAll('g.node');

    // Drag pans, pinch or Ctrl+scroll zooms; plain scrolling pans (onWheel).
    // Shift-drag draws a selection box instead (onBoxStart).
    this.zoom = d3.zoom()
      .scaleExtent([0.15, 2.5])
      .filter(e => (e.type === 'wheel' ? e.ctrlKey : !e.button && !e.shiftKey))
      .on('zoom', e => {
        this.transform = e.transform;
        this.viewport.attr('transform', e.transform);
        this.svg.classed('is-far', e.transform.k < FAR);
        this.drawMinimapView();
      });
    this.svg.call(this.zoom).on('dblclick.zoom', null);
    svgEl.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    svgEl.addEventListener('keydown', e => this.onKey(e));
    // d3.zoom swallows the click that ends a drag, so this only fires on a real click.
    this.svg.on('click', e => {
      if (this.swallowClick) {
        this.swallowClick = false;
        return;
      }
      if (!e.target.closest('.node')) this.onSelect(null, { source: 'graph', toggle: isToggle(e) });
    });
    svgEl.addEventListener('pointerdown', e => this.onBoxStart(e));
    svgEl.addEventListener('pointermove', e => {
      this.onBoxMove(e);
      if (this.press && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > 8) this.cancelPress();
    });
    svgEl.addEventListener('pointerup', e => {
      this.onBoxEnd(e);
      this.endPress();
    });
    svgEl.addEventListener('pointercancel', () => {
      this.cancelBox();
      this.cancelPress();
    });
    svgEl.addEventListener('contextmenu', e => {
      if (this.press || this.pressed) e.preventDefault();
    });

    // Minimap: the whole map in miniature, with the visible area outlined.
    // Click or drag on it to move there.
    if (minimap) {
      this.mm = d3.select(minimap).append('svg').attr('class', 'minimap-svg');
      this.mmBands = this.mm.append('g');
      this.mmNodes = this.mm.append('g');
      this.mmView = this.mm.append('rect').attr('class', 'mm-view');
      this.mmNodeSel = this.mmNodes.selectAll('rect');
      const go = e => {
        const [x, y] = d3.pointer(e, this.mm.node());
        this.svg.call(this.zoom.translateTo, x, y);
      };
      minimap.addEventListener('pointerdown', e => {
        minimap.setPointerCapture(e.pointerId);
        go(e);
      });
      minimap.addEventListener('pointermove', e => {
        if (minimap.hasPointerCapture(e.pointerId)) go(e);
      });
    }
  }

  // ---------------------------------------------------------------- data

  // `focus`: the course of a course page, whose graph is laid out around it.
  // `folded`: course -> options folded away from it (their links aren't
  // drawn); `foldKey` names that, so the app can tell when it changes.
  setData(map, visibleIds, { animate = false, focus = null, folded = new Map(), foldKey = '' } = {}) {
    const fresh = map !== this.map;
    this.map = map;
    this.visible = visibleIds;
    this.focusId = focus;
    this.folded = folded;
    this.foldKey = foldKey;
    if (fresh) {
      this.nodeLayer.selectAll('*').remove();
      this.edgeLayer.selectAll('*').remove();
      this.stubLayer.selectAll('*').remove();
    }
    // The courses each one leads to are what turns orange when it's selected.
    // A course page draws only part of one chain, so it counts them everywhere.
    this.reach = new Map([...visibleIds].map(id =>
      [id, [...map.descendants(id)].filter(d => focus || visibleIds.has(d)).length]));
    this.offeredWidth = map.quarters.reduce((w, q, i) => w + this.textWidth(q[0], OFFERED_FONT) + (i ? OFFERED_GAP : 0), 0);
    this.layout = computeLayout(map, visibleIds, this.viewportSize(), this.titleWidth, { arrange: this.arrange, focus, folded });
    this.moreUp = new Map(this.layout.stubs.filter(s => s.dir === 'up').map(s => [s.id, s.n]));
    this.draw(animate && !fresh && !reducedMotion());
    if (this.state) this.update(this.state);
  }

  // Column counts are picked to suit the stage's shape; redo them when it changes a lot.
  refit() {
    if (!this.map) return false;
    const next = computeLayout(this.map, this.visible, this.viewportSize(), this.titleWidth,
      { arrange: this.arrange, focus: this.focusId, folded: this.folded });
    if (next.cols === this.layout.cols) return false;
    this.redraw();
    return true;
  }

  // The same courses laid out again (another shape or arrangement); the cards glide.
  redraw() {
    this.setData(this.map, this.visible, { animate: true, focus: this.focusId, folded: this.folded, foldKey: this.foldKey });
  }

  // The stage can be hidden (list view) when the layout is computed.
  viewportSize() {
    const w = this.el.clientWidth || window.innerWidth;
    const h = this.el.clientHeight || window.innerHeight - 120;
    return { w, h };
  }

  // Rows by prerequisite steps or by course level; the cards glide to their new places.
  setArrange(mode) {
    if (mode === this.arrange) return;
    this.arrange = mode;
    if (this.map) this.redraw();
  }

  setShowLinks(on) {
    this.svg.classed('show-links', on);
  }

  draw(animate) {
    const { nodes, edges, bands, labels, stubs, width } = this.layout;
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
    this.stubLayer.classed('is-moving', animate);
    this.edgeSel = this.edgeLayer.selectAll('path.edge')
      .data(edges, e => `${e.source}|${e.target}`)
      .join('path')
      .attr('class', e => `edge k-${e.kind}`)
      .attr('d', e => e.d);
    // A course page draws part of a chain: lines fade out where it goes on (see stubsOf).
    this.stubSel = this.stubLayer.selectAll('rect.stub')
      .data(stubs, s => `${s.id}|${s.dir}`)
      .join('rect')
      .attr('class', s => `stub is-${s.dir}`)
      .attr('x', s => s.x - 1.1)
      .attr('y', s => s.y)
      .attr('width', 2.2)
      .attr('height', s => s.len);
    if (animate) {
      setTimeout(() => {
        this.edgeLayer.classed('is-moving', false);
        this.stubLayer.classed('is-moving', false);
      }, duration);
    }

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
    // Courses with no links here are drawn quieter so the chains stand out.
    this.nodeSel.classed('is-loose', id => this.layout.loose.has(id));
    this.nodeSel.each((id, i, els) => {
      this.drawReach(d3.select(els[i]), this.reach.get(id) || 0);
      this.drawMore(d3.select(els[i]), id);
    });
    this.drawMinimap();
  }

  // On a course page, "+3" on top of a course says how many courses before it
  // aren't drawn; clicking it draws them.
  drawMore(g, id) {
    const n = this.moreUp.get(id) || 0;
    const more = g.select('.more').classed('is-on', n > 0);
    if (!n) return;
    const text = `+${n}`;
    const w = this.textWidth(text, MORE_FONT) + 12;
    more.select('rect').attr('x', -w / 2).attr('width', w);
    more.select('text').text(text);
    more.select('title').text(`${n} more course${n === 1 ? '' : 's'} before ${this.map.label(this.map.get(id))}. Click to show ${n === 1 ? 'it' : 'them'}.`);
  }

  // The "leads to" badge: a branching icon and the count, darker the more it is.
  drawReach(g, n) {
    const reach = g.select('.reach').attr('class', `reach t${n >= REACH_HIGH ? 3 : n >= REACH_MID ? 2 : n ? 1 : 0}`);
    if (!n) return;
    const w = this.textWidth(String(n), REACH_FONT);
    const x = -(w + 10.6); // icon center: right padding, number, gap, half the icon
    reach.select('rect').attr('x', -(w + 18)).attr('width', w + 18);
    reach.select('.fork').attr('d', `M${x} -3.8v2.4M${x} -1.4l-2.6 3.9M${x} -1.4v3.9M${x} -1.4l2.6 3.9`);
    reach.select('text').text(n);
  }

  drawMinimap() {
    if (!this.mm) return;
    const { nodes, bands, width, height } = this.layout;
    this.mm.attr('viewBox', `0 0 ${width} ${height}`);
    this.mmBands.selectAll('rect').data(bands).join('rect')
      .attr('class', (b, i) => `mm-band${i % 2 ? ' is-alt' : ''}`)
      .attr('x', 0).attr('y', b => b.top).attr('width', width).attr('height', b => b.bottom - b.top);
    this.mmNodeSel = this.mmNodes.selectAll('rect').data([...nodes.keys()], id => id).join('rect')
      .attr('class', 'mm-node')
      .attr('x', id => nodes.get(id).x).attr('y', id => nodes.get(id).y)
      .attr('width', NODE_W).attr('height', NODE_H).attr('rx', 8);
    this.drawMinimapView();
  }

  drawMinimapView() {
    if (!this.mm) return;
    const t = this.transform;
    const view = { x: -t.x / t.k, y: -t.y / t.k, w: this.el.clientWidth / t.k, h: this.el.clientHeight / t.k };
    this.mmView.attr('x', view.x).attr('y', view.y).attr('width', view.w).attr('height', view.h);
    // Only needed when part of the map is off screen.
    const { width, height } = this.layout;
    const all = view.x <= 8 && view.y <= 8 && view.x + view.w >= width - 8 && view.y + view.h >= height - 8;
    this.mm.node().parentNode.classList.toggle('is-hidden', all || !width);
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
      .on('click', (e, id) => {
        if (this.swallowClick) {
          this.swallowClick = false;
          return;
        }
        this.onSelect(id, { source: 'graph', toggle: isToggle(e) });
      })
      .on('pointerdown', (e, id) => this.startPress(e, id))
      .on('pointerenter', (e, id) => {
        if (e.pointerType !== 'mouse') return;
        this.setHover(id);
        this.onPreview?.(id);
      })
      .on('pointerleave', () => {
        this.setHover(null);
        this.onPreview?.(null);
      })
      .on('focus', (e, id) => {
        this.onNodeFocus(id);
        this.onPreview?.(id);
      })
      .on('blur', () => {
        this.setHover(null);
        this.onPreview?.(null);
      });
    // A course standing in for several options (MATH 228-1 or MATH 230-1 ...): cards stacked behind it.
    for (const off of [7, 3.5]) {
      g.append('rect').attr('class', 'ghost').attr('x', off).attr('y', off).attr('width', NODE_W).attr('height', NODE_H).attr('rx', 7);
    }
    g.append('rect').attr('class', 'card').attr('width', NODE_W).attr('height', NODE_H).attr('rx', 7);
    // The viewer's plan: taken, planned, can take now, or planned but needs a check.
    const mark = g.append('g').attr('class', 'mark').attr('aria-hidden', 'true')
      .attr('transform', 'translate(16,13)')
      .append('g').attr('class', 'mark-icon');
    mark.append('circle').attr('r', 5.5);
    mark.append('path').attr('class', 'i-check').attr('d', 'M-2.6 0.1-0.8 1.9 2.6-1.6');
    mark.append('path').attr('class', 'i-clock').attr('d', 'M0-3.1V0l2 1.3');
    mark.append('path').attr('class', 'i-go').attr('d', 'M-2.6 0H2.2M0.1-2.3 2.4 0 0.1 2.3');
    mark.append('path').attr('class', 'i-warn').attr('d', 'M0-3V0.4M0 2.5v0.1');
    mark.append('path').attr('class', 'i-skip').attr('d', 'M-2.6 0H2.6');
    g.append('text').attr('class', 'code').attr('x', 10).attr('y', 17).text(id => map.label(map.get(id)));
    g.append('text').attr('class', 'title').attr('y', TITLE_Y);
    // The other options it stands for, under a one-line title: "or MATH 230-1 +5".
    g.append('text').attr('class', 'alts').attr('x', 10).attr('y', TITLE_Y + TITLE_LEADING);
    // At the end of the title's second line: the quarter in the plan, or else
    // the quarters it's offered this year (F W S).
    const slotY = TITLE_Y + TITLE_LEADING;
    g.append('text').attr('class', 'term').attr('x', NODE_W - 9).attr('y', slotY);
    g.append('text').attr('class', 'offered').attr('x', NODE_W - 9).attr('y', slotY).attr('aria-hidden', 'true')
      .selectAll('tspan').data(map.quarters).join('tspan')
      .attr('dx', (q, i) => (i ? OFFERED_GAP : null))
      .text(q => q[0]);
    // How many courses on the map this one leads to (see drawReach).
    const reach = g.append('g').attr('class', 'reach').attr('aria-hidden', 'true')
      .attr('transform', `translate(${NODE_W - 6},13.5)`)
      .append('g').attr('class', 'reach-badge');
    reach.append('rect').attr('y', -7.5).attr('height', 15).attr('rx', 7.5);
    reach.append('path').attr('class', 'fork');
    reach.append('text').attr('x', -5).attr('y', 3.7);
    // A check on the top-left corner while the course is in the multi-selection.
    const pick = g.append('g').attr('class', 'pick').attr('aria-hidden', 'true');
    pick.append('circle').attr('r', 7.5);
    pick.append('path').attr('d', 'M-3.2 0.1-1 2.3 3.2-1.9');
    g.append('title');
    // On a course page: "+3" on the top edge, for courses before it that aren't drawn (see drawMore).
    const more = g.append('g').attr('class', 'more').attr('aria-hidden', 'true')
      .attr('transform', `translate(${NODE_W / 2},0)`)
      .on('click', (e, id) => {
        e.stopPropagation();
        if (this.swallowClick) {
          this.swallowClick = false;
          return;
        }
        this.onExpand?.(id);
      })
      .append('g').attr('class', 'more-badge');
    more.append('rect').attr('y', -7).attr('height', 14).attr('rx', 7);
    more.append('text').attr('y', 3.5);
    more.append('title');
    return g;
  }

  // A title in lines of the given widths, word by word; the last line ends in
  // "…" if the rest doesn't fit (the full title is in the tooltip and panel).
  wrapTitle(text, widths) {
    const words = text.split(' ');
    const lines = [];
    let i = 0;
    while (i < words.length) {
      const max = widths[lines.length];
      if (lines.length === widths.length - 1) {
        lines.push(this.fitText(words.slice(i).join(' '), max));
        break;
      }
      let line = words[i++];
      while (i < words.length && this.measure.measureText(`${line} ${words[i]}`).width <= max) line += ` ${words[i++]}`;
      lines.push(this.fitText(line, max));
    }
    return lines;
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
    const { taken, planned, ready, picked, plan, skipped } = state;
    const hl = state.highlight ? map.highlight(state.highlight) : null;
    const sel = state.selected && this.layout.nodes.has(state.selected) ? state.selected : null;
    // A path to a course (path.js) shows its quarters while nothing is selected.
    const path = !sel && hl?.path && !hl.path.done ? hl.path : null;

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
    const inHighlight = e => !sel && !!hl && hl.ids.has(e.source) && hl.ids.has(e.target) && !(path && e.kind === 'rec');
    const status = id => (taken.has(id) ? 'taken' : planned.has(id) ? 'planned' : skipped.has(id) ? 'skip' : ready.has(id) ? 'ready' : '');
    const issues = new Map([...planned].filter(id => this.layout.nodes.has(id)).map(id => [id, plan.issues(map, id)]));
    const hasIssue = id => !!issues.get(id)?.length;

    this.nodeSel
      .classed('is-selected', id => id === sel)
      .classed('is-up', id => up.has(id))
      .classed('is-down', id => down.has(id) && !up.has(id))
      .classed('is-match', id => !!hl && hl.ids.has(id))
      .classed('is-dim', id => (sel ? !inFocus(id) : !!hl && !hl.ids.has(id)))
      .classed('is-taken', id => taken.has(id))
      .classed('is-planned', id => planned.has(id))
      .classed('is-ready', id => ready.has(id))
      .classed('is-skip', id => skipped.has(id))
      .classed('has-issue', hasIssue)
      .classed('has-status', id => !!status(id))
      .classed('is-picked', id => picked.has(id))
      .classed('is-goal', id => !!path && id === path.target)
      .classed('has-alts', id => !!state.alts?.get(id))
      .attr('aria-pressed', id => String(id === sel || picked.has(id)))
      .attr('aria-label', id => this.describe(id, status(id), hasIssue(id), path));
    this.nodeSel.each((id, i, els) => this.drawCard(els[i], id, status(id), path));
    this.svg.classed('is-picking', state.picking || picked.size > 0).classed('has-path', !!path);

    this.edgeSel
      .classed('is-up', isUp)
      .classed('is-down', e => !isUp(e) && isDown(e))
      .classed('is-hl', inHighlight)
      .classed('is-dim', e => (sel ? !isUp(e) && !isDown(e) : !!hl && !inHighlight(e)))
      // Done: a link out of a course you've taken.
      .classed('is-met', e => taken.has(e.source) && !taken.has(e.target));
    this.edgeSel.filter('.is-up, .is-down, .is-hl').raise();
    this.stubSel.classed('is-dim', s => (sel ? !inFocus(s.id) : !!hl && !hl.ids.has(s.id)));

    this.mmNodeSel?.attr('class', id => ['mm-node',
      status(id) && `is-${status(id)}`, picked.has(id) && 'is-picked',
      id === sel && 'is-selected', up.has(id) && 'is-up', down.has(id) && !up.has(id) && 'is-down',
      (sel ? !inFocus(id) : !!hl && !hl.ids.has(id)) && 'is-dim', !sel && hl?.ids.has(id) && 'is-match',
    ].filter(Boolean).join(' '));

    const stop = sel || (this.layout.nodes.has(this.tabStop) ? this.tabStop : this.firstNode());
    this.setTabStop(stop);
  }

  // The parts of a card that depend on the plan: the code moves right to make
  // room for the status icon, planned and taken courses show their quarter
  // (so does a course on the path being shown), others the quarters they're
  // offered; the title's second line gives way, and the zoomed-out code
  // shrinks to fit if it must.
  drawCard(el, id, status, path) {
    const c = this.map.get(id);
    const own = (status === 'taken' || status === 'planned') && this.state.plan.term(id);
    const next = !own && path?.when.get(id);
    const term = own || next;
    const termText = term ? termShort(term) : '';
    const offered = !termText && this.hasSchedule(c);
    const reach = this.reach.get(id) || 0;
    const more = this.moreUp.get(id) || 0;
    const alts = this.state.alts?.get(id);
    const altNames = alts ? alts.map(o => o.map(x => this.map.label(this.map.get(x))).join(' + ')) : [];
    const key = `${status}|${termText}|${next ? 'path' : ''}|${reach}|${more}|${altNames.join()}`;
    if (el.dataset.card === key) return;
    el.dataset.card = key;
    const g = d3.select(el);
    const title = c.title || 'Not in the current catalog';
    const slot = termText ? this.textWidth(termText, TERM_FONT) + 6 : offered ? this.offeredWidth + 6 : 0;
    g.select('.code').attr('x', status ? 25 : 10).style('--far', `${this.farSize(c, status)}px`);
    // Standing in for other options, the title gets one line and the options the second.
    const lines = alts ? [NODE_W - 20] : [NODE_W - 20, NODE_W - 20 - slot];
    g.select('.title').selectAll('tspan').data(this.wrapTitle(title, lines)).join('tspan')
      .attr('x', 10).attr('dy', (line, i) => (i ? TITLE_LEADING : null)).text(line => line);
    g.select('.alts').text(alts ? this.altsText(altNames, NODE_W - 20 - slot) : '');
    g.select('.term').text(termText).classed('is-next', !!next);
    g.select('.offered').style('display', offered ? null : 'none')
      .selectAll('tspan').classed('on', q => !!c.offered?.[q]);
    const tip = [c.title ? `${c.id}: ${c.title}` : c.id];
    if (reach) tip.push(`Leads to ${reach} course${reach === 1 ? '' : 's'}${this.focusId ? '' : ' on this map'}`);
    if (more) tip.push(`${more} more course${more === 1 ? '' : 's'} before it, not shown`);
    if (alts) tip.push(`Or instead: ${altNames.join(', ')}`);
    if (status) tip.push(own ? `${STATUS_TEXT[status]}, ${termLabel(own)}` : STATUS_TEXT[status]);
    if (next) tip.push(`On the path: ${termLabel(next)}`);
    if (this.hasSchedule(c)) tip.push(this.scheduleText(c));
    g.select(':scope > title').text(tip.join('\n'));
  }

  // "or MATH 230-1, MATH 281-1 +4": the options a course stands for, as many as fit.
  altsText(names, max) {
    for (let n = names.length; n > 0; n--) {
      const text = `or ${names.slice(0, n).join(', ')}${n < names.length ? ` +${names.length - n}` : ''}`;
      if (this.measure.measureText(text).width <= max) return text;
    }
    return this.fitText(`or ${names.length} other options`, max);
  }

  // This year's schedule covers this map's courses (listed or not) and the
  // other departments' courses it lists.
  hasSchedule(c) {
    return this.map.quarters.length > 0 && (c.role === 'main' || Object.keys(c.offered || {}).length > 0);
  }

  scheduleText(c) {
    const on = this.map.quarters.filter(q => c.offered?.[q]);
    return on.length ? `Offered ${listText(on)}` : `Not on the ${this.map.scheduleLabel()} schedule`;
  }

  // Zoomed out, a card shows just the code (and status icon), drawn at 19px;
  // the longest codes shrink a little to fit.
  farSize(c, status) {
    const room = NODE_W - (status ? 33 : 10) - 10;
    const width = this.textWidth(this.map.label(c), FAR_FONT);
    return Math.max(11, Math.min(19, Math.floor((19 * room) / width)));
  }

  describe(id, status, hasIssue, path) {
    const map = this.map;
    const c = map.get(id);
    const before = map.parents.get(id).filter(e => e.kind !== 'rec').length;
    const reach = this.reach.get(id) || 0;
    const parts = [`${map.label(c)}, ${c.title || 'not in the current catalog'}`];
    parts.push(before ? `${before} prerequisite${before === 1 ? '' : 's'}` : 'no prerequisites');
    const more = this.moreUp.get(id);
    if (more) parts.push(`${more} earlier course${more === 1 ? '' : 's'} not shown`);
    const alts = this.state.alts?.get(id);
    if (alts) parts.push(`or ${alts.length} other option${alts.length === 1 ? '' : 's'}`);
    if (reach) parts.push(`leads to ${reach} course${reach === 1 ? '' : 's'}`);
    const term = this.state.plan.term(id);
    if (status === 'planned' && term) parts.push(`planned for ${termLabel(term)}`);
    else if (status) parts.push(STATUS_TEXT[status].toLowerCase());
    if (hasIssue) parts.push('needs a check');
    if (path?.when.has(id)) parts.push(`${id === path.target ? 'goal of the path' : 'on the path'}, ${termLabel(path.when.get(id))}`);
    if (this.hasSchedule(c)) parts.push(this.scheduleText(c));
    if (this.state.picked.has(id)) parts.push('selected');
    return parts.join('. ');
  }

  // Previews a course's direct links (on mouse hover or keyboard focus)
  // when nothing else is in focus. Not while picking courses: tapping one
  // focuses it, and the rest of the map shouldn't fade.
  setHover(id) {
    const map = this.map;
    const s = this.state;
    const active = !!id && !s?.selected && !s?.highlight && !s?.picking && !s?.picked.size;
    const was = this.hovering;
    this.hovering = active;
    this.svg.classed('has-hover', active);
    if (!active) {
      this.nodeSel.classed('is-hovered', false).classed('is-near', false);
      this.edgeSel.classed('is-hover', false);
      // Hover only applies when nothing else dims links, so undimming is safe.
      if (was) this.edgeSel.classed('is-dim', false);
      return;
    }
    const near = new Set([
      ...map.parents.get(id).map(e => e.source),
      ...map.children.get(id).map(e => e.target),
    ]);
    const touches = e => e.source === id || e.target === id;
    this.nodeSel.classed('is-hovered', d => d === id).classed('is-near', d => near.has(d));
    this.edgeSel.classed('is-hover', touches).classed('is-dim', e => !touches(e));
    this.edgeSel.filter('.is-hover').raise();
  }

  // ------------------------------------------------------ multi-selection
  // Shift-drag draws a box and every course it touches joins the selection.
  // On touch screens, a long press on a course starts one.

  onBoxStart(e) {
    if (!e.shiftKey || e.button !== 0 || !this.map) return;
    const [x, y] = d3.pointer(e, this.el);
    this.box = { pointer: e.pointerId, sx: x, sy: y, ex: x, ey: y, shown: false };
  }

  onBoxMove(e) {
    const b = this.box;
    if (!b || e.pointerId !== b.pointer) return;
    [b.ex, b.ey] = d3.pointer(e, this.el);
    if (!b.shown && Math.hypot(b.ex - b.sx, b.ey - b.sy) < 5) return;
    // Capture only once it's a drag, so a Shift-click still reaches the course.
    if (!b.shown) this.el.setPointerCapture(e.pointerId);
    b.shown = true;
    const r = this.boxBounds(b);
    this.boxRect.style('display', null).attr('x', r.x).attr('y', r.y).attr('width', r.w).attr('height', r.h);
  }

  onBoxEnd(e) {
    const b = this.box;
    if (!b || e.pointerId !== b.pointer) return;
    this.cancelBox();
    if (!b.shown) return; // a Shift-click: the click handlers take it
    const r = this.boxBounds(b);
    const ids = [...this.layout.nodes]
      .filter(([, p]) => p.x < r.x + r.w && p.x + NODE_W > r.x && p.y < r.y + r.h && p.y + NODE_H > r.y)
      .map(([id]) => id);
    this.swallowNextClick();
    if (ids.length) this.onPick(ids);
  }

  cancelBox() {
    this.box = null;
    this.boxRect.style('display', 'none');
  }

  // The box in layout coordinates.
  boxBounds({ sx, sy, ex, ey }) {
    const [x0, y0] = this.transform.invert([Math.min(sx, ex), Math.min(sy, ey)]);
    const [x1, y1] = this.transform.invert([Math.max(sx, ex), Math.max(sy, ey)]);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  startPress(e, id) {
    if (e.pointerType === 'mouse') return;
    this.cancelPress();
    this.press = { x: e.clientX, y: e.clientY };
    this.press.timer = setTimeout(() => {
      this.press = null;
      this.pressed = true;
      this.onPick([id], { toggle: true });
    }, LONG_PRESS);
  }

  cancelPress() {
    if (this.press) clearTimeout(this.press.timer);
    this.press = null;
  }

  // Lifting the finger after a long press must not also select the course.
  endPress() {
    this.cancelPress();
    if (!this.pressed) return;
    this.pressed = false;
    this.swallowNextClick();
  }

  swallowNextClick() {
    this.swallowClick = true;
    clearTimeout(this.swallowTimer);
    this.swallowTimer = setTimeout(() => { this.swallowClick = false; }, 400);
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

  // The stage changed width by `dx` px: move the view half as far, so what
  // was in the middle stays there.
  panBy(dx) {
    this.zoom.translateBy(this.svg, dx / 2 / this.transform.k, 0);
  }

  // A course page: everything if it fits at a readable size, else the course
  // and as much of its chain as does.
  frame(id, { animate = false } = {}) {
    const { width, height } = this.layout;
    const { w, h } = this.size();
    if (Math.min((w - 32) / width, (h - 32) / height) >= READABLE) this.fitAll({ animate });
    else this.reveal(id, { force: true, animate });
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

  // Frame a set of courses. If they don't fit at a readable zoom, show the
  // part around `keep` (the goal of a path), else the top.
  showIds(ids, { keep = null } = {}) {
    const box = this.bbox(ids);
    if (!box) return;
    const { w, h } = this.size();
    const fit = Math.min((w - 96) / box.w, (h - 96) / box.h, 1);
    if (fit >= 0.4) {
      this.moveTo(box, fit);
      return;
    }
    const tall = Math.min(box.h, (h - 96) / 0.4);
    const goal = keep && this.bbox([keep]);
    const y = goal ? Math.min(Math.max(goal.y + goal.h - tall, box.y), box.y + box.h - tall) : box.y;
    this.moveTo({ ...box, y, h: tall }, 0.4);
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
      this.onSelect(id, { source: 'keyboard', toggle: isToggle(e) });
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
//
// Rows: bands of prerequisite steps (a course sits in the band after its
// latest prerequisite on the map, so MATH 228-2 comes before every course that
// needs it), or of course levels (100, 200, 300). A band is split into tiers
// when a course needs another course of the same band (a corequisite, or a
// same-level prerequisite); tiers start on the same row in every department,
// so prerequisites are always above what they unlock. Columns: departments,
// each a few card columns wide. Within a tier, courses take the free slot
// closest to their prerequisites (and the courses they unlock), so chains
// line up vertically. Courses with no links on the map close each cell (by
// step, they get bands of their own: introductory ones at the top, advanced
// ones at the bottom).

const levelOf = c => Math.floor(parseInt(c.num, 10) / 100) * 100;
// The bands, by step, for courses with no links: 100- and 200-level ones
// (first-year seminars, intro courses) above step 1, the rest after the last step.
const UNLINKED_INTRO = -1;
const UNLINKED = Infinity;

// How many prerequisites deep each course is on the map: the longest chain of
// prerequisites leading to it. A corequisite may share its band.
function stepsOf(courses, edges, linked) {
  const into = new Map(courses.map(c => [c.id, []]));
  for (const e of edges) if (e.kind !== 'rec') into.get(e.target).push(e);
  const depth = new Map();
  const visiting = new Set();
  const of = id => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0; // a loop in the data
    visiting.add(id);
    const d = Math.max(0, ...into.get(id).map(e => of(e.source) + (e.kind === 'co' ? 0 : 1)));
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  return c => (linked.has(c.id) ? of(c.id) : levelOf(c) < 300 ? UNLINKED_INTRO : UNLINKED);
}

// A course page's rows, by step: how many steps before or after its course
// each course comes (the longest chain of links between them, so a course
// that a prerequisite also needs sits above that prerequisite). The course
// is row 0; a corequisite shares a row.
function aroundOf(focus, courses, edges) {
  const into = new Map(courses.map(c => [c.id, []]));
  const out = new Map(courses.map(c => [c.id, []]));
  for (const e of edges) {
    into.get(e.target).push(e);
    out.get(e.source).push(e);
  }
  const longest = (links, end) => {
    const memo = new Map([[focus, 0]]);
    const visiting = new Set();
    const of = id => {
      if (memo.has(id)) return memo.get(id);
      if (visiting.has(id)) return -Infinity; // a loop in the data
      visiting.add(id);
      const d = Math.max(-Infinity, ...links.get(id).map(e => of(e[end]) + (e.kind === 'co' ? 0 : 1)));
      visiting.delete(id);
      memo.set(id, d);
      return d;
    };
    return of;
  };
  const toFocus = longest(out, 'target');
  const fromFocus = longest(into, 'source');
  return c => {
    if (toFocus(c.id) > -Infinity) return -toFocus(c.id);
    return fromFocus(c.id) > -Infinity ? fromFocus(c.id) : -1;
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const bandName = (arrange, band, focus) => {
  if (arrange === 'level') return `${band}-level`;
  if (focus) return band < 0 ? `${plural(-band, 'step')} before` : band > 0 ? `${plural(band, 'step')} after` : 'This course';
  if (band === UNLINKED_INTRO) return 'Not linked \u00b7 introductory (100\u2013200 level)';
  if (band === UNLINKED) return 'Not linked \u00b7 advanced (300 level and up)';
  return band ? `Step ${band + 1}` : 'Step 1 \u00b7 start here';
};
const byId = (a, b) => a.id.localeCompare(b.id);
const ROW_COST = 40; // px of sideways distance a course trades for one row higher
const SWEEPS = 4; // placement passes; later ones also look at where children went

// textWidth measures a column title at its zoomed-out size. `focus` is the
// course of a course page: by step, rows count the steps before and after it.
// Links from options `folded` away aren't drawn.
function computeLayout(map, visible, viewport, textWidth, { arrange = 'steps', focus = null, folded = new Map() } = {}) {
  const courses = [...visible].map(id => map.get(id));
  const depts = map.data.departments;
  const edges = map.edges.filter(e => visible.has(e.source) && visible.has(e.target) && !folded.get(e.target)?.has(e.source));
  const linked = new Set(edges.flatMap(e => [e.source, e.target]));
  const groupOf = c => (c.role === 'main' ? c.dept : OTHER);
  const mains = Object.keys(depts).filter(d => depts[d].main && courses.some(c => c.role === 'main' && c.dept === d));
  const groups = orderGroups(mains, courses.some(c => c.role !== 'main'), edges, id => groupOf(map.get(id)));
  const bandOf = arrange === 'level' ? levelOf : focus ? aroundOf(focus, courses, edges) : stepsOf(courses, edges, linked);
  const levels = [...new Set(courses.map(bandOf))].sort((a, b) => a - b);

  // Tier = how many prerequisites in the same band must come first.
  const sameLevel = new Map(courses.map(c => [c.id, []]));
  for (const e of edges) {
    if (e.kind !== 'rec' && bandOf(map.get(e.source)) === bandOf(map.get(e.target))) {
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

  // cells: "level|group" -> { tiers: [[course]], loose: [course] }
  const cells = new Map();
  for (const c of [...courses].sort(byId)) {
    const key = `${bandOf(c)}|${groupOf(c)}`;
    if (!cells.has(key)) cells.set(key, { tiers: [], loose: [] });
    const cell = cells.get(key);
    if (!linked.has(c.id)) {
      cell.loose.push(c);
      continue;
    }
    const t = tierOf(c.id);
    while (cell.tiers.length <= t) cell.tiers.push([]);
    cell.tiers[t].push(c);
  }

  const cols = pickColumns(cells, groups, levels, viewport);
  const groupX = [];
  let x = PAD;
  groups.forEach((g, i) => {
    groupX.push(x);
    x += cols[i] * (NODE_W + GAP_X) - GAP_X + GROUP_GAP;
  });
  const width = x - GROUP_GAP + PAD;
  const slotX = (gi, c) => groupX[gi] + c * (NODE_W + GAP_X);
  const center = p => p.x + NODE_W / 2;
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

  const parents = new Map(courses.map(c => [c.id, []]));
  const children = new Map(courses.map(c => [c.id, []]));
  for (const e of edges) {
    parents.get(e.target).push(e.source);
    children.get(e.source).push(e.target);
  }

  let nodes = new Map();
  let bands = [];
  let height = 0;
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const before = nodes;
    nodes = new Map();
    bands = [];
    let y = PAD + HEADER_H;
    for (const level of levels) {
      const top = y;
      const rowY = r => top + BAND_TOP + r * PITCH;
      const used = groups.map(() => 0);
      const here = groups.map(g => cells.get(`${level}|${g}`) || { tiers: [], loose: [] });

      // Each course takes the free slot nearest the middle of its prerequisites
      // (and, after the first pass, of the courses it unlocks).
      const place = (block, gi) => {
        const C = cols[gi];
        const rows = Math.ceil(block.length / C);
        const free = [];
        for (let r = 0; r < rows; r++) for (let c = 0; c < C; c++) free.push({ r, c });
        const wants = block.map((course, i) => {
          const up = parents.get(course.id).filter(id => nodes.has(id)).map(id => center(nodes.get(id)));
          const down = children.get(course.id).filter(id => before.has(id)).map(id => center(before.get(id)));
          let target = slotX(gi, i % C) + NODE_W / 2; // catalog order
          if (up.length && down.length) target = (2 * mean(up) + mean(down)) / 3;
          else if (up.length) target = mean(up);
          else if (down.length) target = mean(down);
          return { course, target, pull: up.length + down.length };
        });
        wants.sort((a, b) => b.pull - a.pull || a.target - b.target || byId(a.course, b.course));
        for (const w of wants) {
          let best = 0;
          let bestCost = Infinity;
          free.forEach((slot, k) => {
            const cost = Math.abs(slotX(gi, slot.c) + NODE_W / 2 - w.target) + slot.r * ROW_COST;
            if (cost < bestCost) {
              bestCost = cost;
              best = k;
            }
          });
          const slot = free.splice(best, 1)[0];
          nodes.set(w.course.id, { x: slotX(gi, slot.c), y: rowY(used[gi] + slot.r) });
        }
        used[gi] += rows;
      };
      // Tier by tier across all departments, so prerequisites are placed first.
      // Every department starts a tier on the same row, so each prerequisite
      // sits above the courses it unlocks and every link runs downward.
      const tierCount = Math.max(0, ...here.map(cell => cell.tiers.length));
      for (let t = 0; t < tierCount; t++) {
        const start = Math.max(...used);
        here.forEach((cell, gi) => {
          used[gi] = start;
          if (cell.tiers[t]?.length) place(cell.tiers[t], gi);
        });
      }
      here.forEach((cell, gi) => {
        cell.loose.forEach((c, i) => nodes.set(c.id, {
          x: slotX(gi, i % cols[gi]),
          y: rowY(used[gi] + Math.floor(i / cols[gi])),
        }));
        used[gi] += Math.ceil(cell.loose.length / cols[gi]);
      });
      const bottom = rowY(Math.max(1, ...used)) - GAP_Y + BAND_BOTTOM;
      bands.push({ level, top, bottom });
      y = bottom;
    }
    height = y + PAD;
  }

  // Column titles, plus a short form for zoomed-out views of narrow columns.
  const labels = groups.flatMap((g, i) => {
    const full = g === OTHER ? 'Other departments' : depts[g].name;
    const short = g === OTHER ? 'Other' : depts[g].abbr || g;
    const fits = textWidth(full.toUpperCase()) <= cols[i] * (NODE_W + GAP_X) + GROUP_GAP / 2;
    return fits
      ? [{ cls: 'group-label', x: groupX[i], y: PAD + 12, text: full }]
      : [{ cls: 'group-label full', x: groupX[i], y: PAD + 12, text: full },
        { cls: 'group-label short', x: groupX[i], y: PAD + 12, text: short }];
  });
  for (const b of bands) labels.push({ cls: 'band-label', x: PAD, y: b.top + 27, text: bandName(arrange, b.level, focus) });

  const loose = new Set(courses.filter(c => !linked.has(c.id)).map(c => c.id));
  const routed = edges.map(e => ({ ...e, d: '' }));
  routeEdges(routed, nodes);
  const stubs = focus ? stubsOf(map, visible, focus, nodes, folded) : [];
  return { nodes, edges: routed, bands, labels, loose, stubs, width, height, cols: cols.join(',') };
}

// A course page draws only part of its course's chain. A course before it
// whose own prerequisites aren't all drawn gets a line fading out above it
// (and "+3", how many courses that leaves out; options folded away don't
// count); a course it unlocks that leads to more gets one fading out below
// it. A line stops short of any card in its way.
function stubsOf(map, visible, focus, nodes, folded) {
  const before = new Set([...map.ancestors(focus), ...map.parents.get(focus).map(e => e.source)]);
  const needs = id => map.parents.get(id).filter(e => e.kind !== 'rec' && !folded.get(id)?.has(e.source)).map(e => e.source);
  const earlier = id => {
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      for (const p of needs(stack.pop())) {
        if (seen.has(p)) continue;
        seen.add(p);
        stack.push(p);
      }
    }
    return seen;
  };
  const room = (p, up) => {
    const cx = p.x + NODE_W / 2;
    let gap = STUB;
    for (const q of nodes.values()) {
      if (q === p || cx < q.x || cx > q.x + NODE_W) continue;
      const between = up ? p.y - (q.y + NODE_H) : q.y - (p.y + NODE_H);
      if (between >= 0) gap = Math.min(gap, between - 4);
    }
    return gap;
  };
  const stubs = [];
  for (const id of visible) {
    if (id === focus) continue;
    const up = before.has(id);
    const goesOn = up
      ? needs(id).some(p => !visible.has(p))
      : map.children.get(id).some(e => e.kind !== 'rec' && !visible.has(e.target));
    if (!goesOn) continue;
    const p = nodes.get(id);
    const len = Math.max(0, room(p, up));
    const x = p.x + NODE_W / 2;
    if (up) stubs.push({ id, dir: 'up', n: [...earlier(id)].filter(a => a !== id && !visible.has(a)).length, x, y: p.y - len, len });
    else stubs.push({ id, dir: 'down', x, y: p.y + NODE_H, len });
  }
  return stubs;
}

// Put "Other departments" where its links to this map's departments are
// shortest (usually between them); the map's own departments keep their order.
function orderGroups(mains, hasOther, edges, groupOfId) {
  if (!hasOther) return mains;
  let best = null;
  for (let i = mains.length; i >= 0; i--) {
    const order = [...mains.slice(0, i), OTHER, ...mains.slice(i)];
    const at = new Map(order.map((g, j) => [g, j]));
    const cost = edges.reduce((sum, e) => sum + Math.abs(at.get(groupOfId(e.source)) - at.get(groupOfId(e.target))), 0);
    if (!best || cost < best.cost) best = { cost, order };
  }
  return best.order;
}

// Choose how many card columns each department gets so the whole map best
// fits the stage (tries every combination; there are only a few groups).
function pickColumns(cells, groups, levels, viewport) {
  const blocks = (level, g) => {
    const cell = cells.get(`${level}|${g}`);
    return cell ? [...cell.tiers.map(t => t.length), cell.loose.length] : [];
  };
  const options = groups.map(g => {
    const widest = Math.max(1, ...levels.flatMap(l => blocks(l, g)));
    return Array.from({ length: Math.min(MAX_COLS, widest) }, (_, i) => i + 1);
  });
  // Tiers line up across departments (see computeLayout), so a band is as tall
  // as its tallest block in each tier plus its tallest block of unlinked courses.
  const measure = cols => {
    const width = 2 * PAD + cols.reduce((s, c) => s + c * (NODE_W + GAP_X) - GAP_X, 0) + GROUP_GAP * (cols.length - 1);
    let height = 2 * PAD + HEADER_H;
    for (const level of levels) {
      const per = groups.map((g, i) => blocks(level, g).map(n => Math.ceil(n / cols[i])));
      const tierCount = Math.max(0, ...per.map(b => b.length - 1));
      let rows = 0;
      for (let t = 0; t < tierCount; t++) rows += Math.max(0, ...per.map(b => (t < b.length - 1 ? b[t] : 0)));
      rows += Math.max(0, ...per.map(b => (b.length ? b[b.length - 1] : 0)));
      height += BAND_TOP + Math.max(1, rows) * PITCH - GAP_Y + BAND_BOTTOM;
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

// ----------------------------------------------------------------- routing
//
// Every link runs downward (tiers line up across a band). A course directly
// below its prerequisite gets a short drop; one further down the same column
// is reached along the gutter to the column's left, so the link never runs
// behind the cards in between; anything else gets an S-curve from the bottom
// of the prerequisite to the top of the course. Links sharing a gutter get
// lanes a few pixels apart so they read as parallel lines.

function routeEdges(edges, nodes) {
  const sameColumn = (s, t) => Math.abs(s.x - t.x) < 1;
  const below = (s, t) => sameColumn(s, t) && Math.abs(t.y - s.y - PITCH) < 1;
  const gutters = new Map(); // card column x -> sources running down its gutter
  for (const e of edges) {
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    if (!sameColumn(s, t) || below(s, t)) continue;
    if (!gutters.has(t.x)) gutters.set(t.x, []);
    if (!gutters.get(t.x).includes(e.source)) gutters.get(t.x).push(e.source);
  }
  gutters.forEach(list => list.sort((a, b) => nodes.get(a).y - nodes.get(b).y));
  const lane = (list, id) => {
    const room = GAP_X / 2 - 2;
    const step = list.length > 1 ? Math.min(3, (2 * room) / (list.length - 1)) : 0;
    return (list.indexOf(id) - (list.length - 1) / 2) * step;
  };

  for (const e of edges) {
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    const x1 = s.x + NODE_W / 2;
    const y1 = s.y + NODE_H;
    if (below(s, t)) {
      e.d = `M${x1},${y1}V${t.y}`;
    } else if (sameColumn(s, t)) {
      const gx = t.x - GAP_X / 2 + lane(gutters.get(t.x), e.source);
      const yc = y1 + GAP_Y / 2;
      const ty = t.y + NODE_H / 2;
      e.d = roundedPath([[x1, y1], [x1, yc], [gx, yc], [gx, ty], [t.x, ty]], 6);
    } else {
      const x2 = t.x + NODE_W / 2;
      const d = Math.max(24, (t.y - y1) / 2);
      e.d = `M${x1},${y1}C${x1},${y1 + d} ${x2},${t.y - d} ${x2},${t.y}`;
    }
  }
}

// An orthogonal polyline with its corners rounded off.
function roundedPath(points, radius) {
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const r = Math.min(radius, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
    const inX = cx - Math.sign(cx - px) * r;
    const inY = cy - Math.sign(cy - py) * r;
    const outX = cx + Math.sign(nx - cx) * r;
    const outY = cy + Math.sign(ny - cy) * r;
    d += `L${inX},${inY}Q${cx},${cy} ${outX},${outY}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${last[0]},${last[1]}`;
}
