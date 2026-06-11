/* global d3, topojson */
(function () {
  'use strict';

  // ---------------------------------------------------------------- state
  const state = {
    data: null, // { meta, countries }
    metric: 'production', // 'production' | 'area' | 'yield'
    year: 2024,
    pinned: null, // ISO3 of pinned country (click-to-pin tooltip)
    hovered: null, // datum of country currently under the cursor (hover tooltip)
    playing: false,
    playTimer: null,
    colorScales: {}, // metric -> d3 scale
  };

  const COLORS = d3.interpolateYlGn;

  // ---------------------------------------------------------------- format
  const fmtInt = d3.format(',.0f');
  const fmtYield = d3.format(',.2f');
  function fmtValue(metric, v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return metric === 'yield' ? fmtYield(v) : fmtInt(v);
  }

  // ---------------------------------------------------------------- elements
  const el = {
    slider: document.getElementById('yearSlider'),
    yearValue: document.getElementById('yearValue'),
    yearMin: document.getElementById('yearMin'),
    yearMax: document.getElementById('yearMax'),
    playBtn: document.getElementById('playBtn'),
    metricBtns: Array.from(document.querySelectorAll('.metric-btn')),
    legendTitle: document.getElementById('legendTitle'),
    legendSvg: d3.select('#legend'),
    tooltip: document.getElementById('tooltip'),
    loading: document.getElementById('loading'),
    search: document.getElementById('countrySearch'),
    datalist: document.getElementById('countryList'),
    rankList: document.getElementById('rankList'),
    rankingSub: document.getElementById('rankingSub'),
    zoomIn: document.getElementById('zoomIn'),
    zoomOut: document.getElementById('zoomOut'),
    zoomReset: document.getElementById('zoomReset'),
  };

  const svg = d3.select('#map');
  let width = 0;
  let height = 0;
  const projection = d3.geoNaturalEarth1();
  const path = d3.geoPath(projection);
  let gMap; // zoomable group
  let countrySel; // selection of country paths
  let zoom;

  // ---------------------------------------------------------------- helpers
  function metricValue(iso, year, metric) {
    const c = state.data.countries[iso];
    if (!c) return undefined;
    const y = c.years[year];
    if (!y) return undefined;
    const v = y[metric];
    return v == null || !Number.isFinite(v) ? undefined : v;
  }

  function buildColorScales() {
    const m = state.data.meta.metrics;
    state.colorScales.production = d3
      .scaleSequential(COLORS)
      .domain([Math.log10(Math.max(1, m.production.extent[0])), Math.log10(m.production.extent[1])]);
    state.colorScales.area = d3
      .scaleSequential(COLORS)
      .domain([Math.log10(Math.max(1, m.area.extent[0])), Math.log10(m.area.extent[1])]);
    state.colorScales.yield = d3
      .scaleSequential(COLORS)
      .domain([m.yield.extent[0], m.yield.extent[1]]);
  }

  function colorFor(value, metric) {
    if (value === undefined) return '#3a423b'; // no-data gray (matches --no-data)
    const scale = state.colorScales[metric];
    const cfg = state.data.meta.metrics[metric];
    const input = cfg.scale === 'log' ? Math.log10(Math.max(1, value)) : value;
    return scale(input);
  }

  // ---------------------------------------------------------------- map setup
  function sizeMap() {
    const rect = svg.node().getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    projection.fitExtent(
      [
        [10, 10],
        [width - 10, height - 10],
      ],
      { type: 'Sphere' }
    );
    svg.select('.sphere').attr('d', path({ type: 'Sphere' }));
    if (countrySel) countrySel.attr('d', path);
  }

  function renderMap(topo) {
    const countries = topojson.feature(topo, topo.objects.countries).features;

    zoom = d3
      .zoom()
      .scaleExtent([1, 12])
      .on('zoom', (event) => gMap.attr('transform', event.transform));
    svg.call(zoom).on('dblclick.zoom', null);

    gMap = svg.append('g');

    // sphere/ocean background
    svg.insert('path', ':first-child').attr('class', 'sphere');

    countrySel = gMap
      .selectAll('path.country')
      .data(countries, (d) => d.properties.iso_a3 || d.id)
      .join('path')
      .attr('class', 'country')
      .attr('d', path)
      .on('mousemove', (event, d) => showTooltip(event, d))
      .on('mouseenter', (event, d) => showTooltip(event, d))
      .on('mouseleave', () => hideTooltip())
      .on('click', (event, d) => togglePin(d));

    sizeMap();
    updateFills();
  }

  // ---------------------------------------------------------------- fills
  function updateFills() {
    if (!countrySel) return;
    const metric = state.metric;
    const year = state.year;
    countrySel
      .transition()
      .duration(300)
      .attr('fill', (d) => colorFor(metricValue(d.properties.iso_a3, year, metric), metric));
  }

  // ---------------------------------------------------------------- legend
  function renderLegend() {
    const metric = state.metric;
    const cfg = state.data.meta.metrics[metric];
    el.legendTitle.textContent = cfg.label;

    const w = 220;
    const barH = 12;
    const margin = { left: 8, right: 8, top: 4, bottom: 20 };
    const innerW = w - margin.left - margin.right;
    el.legendSvg.attr('width', w).attr('height', barH + margin.top + margin.bottom);
    el.legendSvg.selectAll('*').remove();

    const defs = el.legendSvg.append('defs');
    const gradId = 'legend-grad';
    const grad = defs.append('linearGradient').attr('id', gradId);
    const stops = 12;
    for (let i = 0; i <= stops; i++) {
      const t = i / stops;
      grad
        .append('stop')
        .attr('offset', `${t * 100}%`)
        .attr('stop-color', COLORS(t));
    }

    const g = el.legendSvg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    g.append('rect').attr('width', innerW).attr('height', barH).attr('fill', `url(#${gradId})`)
      .attr('rx', 2);

    // axis ticks mapped through the active scale
    const [lo, hi] = cfg.extent;
    let ticks;
    let tickScale;
    if (cfg.scale === 'log') {
      tickScale = d3.scaleLog().domain([Math.max(1, lo), hi]).range([0, innerW]);
      ticks = tickScale.ticks(4).filter((t) => Number.isInteger(Math.log10(t)));
      if (ticks.length < 2) ticks = [Math.max(1, lo), hi];
    } else {
      tickScale = d3.scaleLinear().domain([lo, hi]).range([0, innerW]);
      ticks = tickScale.ticks(4);
    }
    const sci = d3.format('.2s');
    const axisG = g.append('g').attr('transform', `translate(0,${barH})`);
    ticks.forEach((t) => {
      const x = tickScale(t);
      axisG.append('line').attr('x1', x).attr('x2', x).attr('y1', 0).attr('y2', 4)
        .attr('stroke', '#9bb09e');
      axisG
        .append('text')
        .attr('x', x)
        .attr('y', 15)
        .attr('text-anchor', 'middle')
        .attr('fill', '#9bb09e')
        .attr('font-size', '10px')
        .text(metric === 'yield' ? fmtYield(t) : sci(t));
    });

    // no-data swatch
    const ndY = barH + margin.top + 4;
    const nd = el.legendSvg.append('g').attr('transform', `translate(${margin.left},${ndY})`);
    nd.append('rect').attr('width', 10).attr('height', 10).attr('y', 4).attr('fill', '#3a423b')
      .attr('stroke', '#2c3a2f');
    nd.append('text').attr('x', 16).attr('y', 13).attr('fill', '#9bb09e').attr('font-size', '10px')
      .text('No data');
  }

  // ---------------------------------------------------------------- tooltip
  // Population series ends a year before the rice data. If the selected year
  // has no population, fall back to the most recent earlier year that does and
  // report which year it came from, so the row is never silently blank.
  function populationFor(rec, year) {
    if (!rec) return null;
    const direct = rec.years[year];
    if (direct && direct.population != null) return { value: direct.population, year };
    let best = null;
    for (const yStr of Object.keys(rec.years)) {
      const yr = Number(yStr);
      if (yr > year) continue;
      const v = rec.years[yStr].population;
      if (v == null) continue;
      if (!best || yr > best.year) best = { value: v, year: yr };
    }
    return best;
  }

  function populationRow(rec) {
    const pop = populationFor(rec, state.year);
    if (!pop) {
      return `<div class="tt-row"><span class="tt-label">Population</span><span class="tt-val">—</span></div>`;
    }
    const label = pop.year === state.year ? 'Population' : `Population (${pop.year})`;
    return `<div class="tt-row"><span class="tt-label">${label}</span><span class="tt-val">${fmtInt(pop.value)}</span></div>`;
  }

  function tooltipHTML(d) {
    const iso = d.properties.iso_a3;
    const name = (state.data.countries[iso] && state.data.countries[iso].name) || d.properties.name;
    const rec = iso ? state.data.countries[iso] : null;
    const y = rec && rec.years[state.year];
    const pinned = state.pinned === iso;
    const pinNote = pinned ? '<span class="tt-pin">pinned · click to unpin</span>' : '';

    if (!y || (y.production == null && y.area == null && y.yield == null)) {
      return (
        `<div class="tt-name">${escapeHTML(name)}${pinNote}</div>` +
        `<div class="tt-nodata">No data for ${state.year}</div>` +
        populationRow(rec)
      );
    }

    const rows = [
      ['Area harvested', y.area != null ? `${fmtInt(y.area)} ha` : '—'],
      ['Production', y.production != null ? `${fmtInt(y.production)} t` : '—'],
      ['Yield', y.yield != null ? `${fmtYield(y.yield)} t/ha` : '—'],
    ];
    return (
      `<div class="tt-name">${escapeHTML(name)}${pinNote}</div>` +
      populationRow(rec) +
      rows
        .map(
          ([l, v]) =>
            `<div class="tt-row"><span class="tt-label">${l}</span><span class="tt-val">${v}</span></div>`
        )
        .join('')
    );
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function positionTooltip(x, y) {
    const tt = el.tooltip;
    const pad = 14;
    const rect = tt.getBoundingClientRect();
    let left = x + pad;
    let top = y + pad;
    if (left + rect.width > window.innerWidth - 4) left = x - rect.width - pad;
    if (top + rect.height > window.innerHeight - 4) top = y - rect.height - pad;
    if (left < 4) left = 4;
    if (top < 4) top = 4;
    tt.style.left = `${left}px`;
    tt.style.top = `${top}px`;
  }

  function showTooltip(event, d) {
    state.hovered = d;
    if (state.pinned) return; // pinned tooltip takes precedence
    const tt = el.tooltip;
    tt.innerHTML = tooltipHTML(d);
    tt.hidden = false;
    positionTooltip(event.clientX, event.clientY);
  }

  function hideTooltip() {
    state.hovered = null;
    if (state.pinned) return;
    el.tooltip.hidden = true;
  }

  // Re-render whichever tooltip is currently visible (pinned, else hovered) so
  // its values track year/metric changes — e.g. while the play animation runs
  // and no mouse events are firing. Position is left untouched.
  function refreshActiveTooltip() {
    const iso = state.pinned;
    const d = iso
      ? countrySel.data().find((f) => f.properties.iso_a3 === iso)
      : state.hovered;
    if (d && !el.tooltip.hidden) el.tooltip.innerHTML = tooltipHTML(d);
  }

  function togglePin(d) {
    const iso = d.properties.iso_a3;
    if (state.pinned === iso) {
      state.pinned = null;
      el.tooltip.hidden = true;
    } else {
      state.pinned = iso;
      el.tooltip.hidden = false;
      el.tooltip.innerHTML = tooltipHTML(d);
      // position near the country centroid
      const c = path.centroid(d);
      const t = d3.zoomTransform(svg.node());
      const [px, py] = t.apply(c);
      const svgRect = svg.node().getBoundingClientRect();
      positionTooltip(svgRect.left + px, svgRect.top + py);
    }
    countrySel.classed('pinned', (f) => f.properties.iso_a3 === state.pinned);
    syncRankingHighlight();
  }

  // Reflect the pinned country in the ranking list without a full re-render.
  function syncRankingHighlight() {
    if (!el.rankList) return;
    el.rankList.querySelectorAll('.rank-item').forEach((li) => {
      li.classList.toggle('is-active', li.dataset.iso === state.pinned);
    });
  }

  // ---------------------------------------------------------------- controls
  function setMetric(metric) {
    if (state.metric === metric) return;
    state.metric = metric;
    el.metricBtns.forEach((b) => {
      const active = b.dataset.metric === metric;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    renderLegend();
    updateFills();
    refreshActiveTooltip();
    renderRanking();
  }

  function setYear(year, { updateSlider = true } = {}) {
    year = Math.max(state.data.meta.minYear, Math.min(state.data.meta.maxYear, year));
    state.year = year;
    el.yearValue.textContent = year;
    if (updateSlider) el.slider.value = year;
    updateFills();
    refreshActiveTooltip();
    renderRanking();
  }

  // debounce slider so dragging doesn't thrash transitions
  let sliderRAF = null;
  function onSliderInput() {
    const v = Number(el.slider.value);
    el.yearValue.textContent = v; // immediate label feedback
    if (sliderRAF) cancelAnimationFrame(sliderRAF);
    sliderRAF = requestAnimationFrame(() => {
      sliderRAF = null;
      setYear(v, { updateSlider: false });
    });
  }

  function togglePlay() {
    state.playing = !state.playing;
    el.playBtn.classList.toggle('is-playing', state.playing);
    el.playBtn.textContent = state.playing ? '❚❚' : '▶';
    el.playBtn.setAttribute('aria-label', state.playing ? 'Pause animation' : 'Play animation');
    if (state.playing) {
      if (state.year >= state.data.meta.maxYear) setYear(state.data.meta.minYear);
      state.playTimer = setInterval(() => {
        if (state.year >= state.data.meta.maxYear) {
          togglePlay();
          return;
        }
        setYear(state.year + 1);
      }, 600);
    } else {
      clearInterval(state.playTimer);
      state.playTimer = null;
    }
  }

  // ---------------------------------------------------------------- zoom btns
  function zoomBy(factor) {
    svg.transition().duration(250).call(zoom.scaleBy, factor);
  }
  function resetZoom() {
    svg.transition().duration(350).call(zoom.transform, d3.zoomIdentity);
  }

  // ---------------------------------------------------------------- search
  function populateSearch() {
    const opts = Object.entries(state.data.countries)
      .filter(([iso]) => !iso.startsWith('OWID_'))
      .map(([, c]) => c.name)
      .sort((a, b) => a.localeCompare(b));
    el.datalist.innerHTML = opts.map((n) => `<option value="${escapeHTML(n)}"></option>`).join('');
  }

  // Pin and zoom the map to a country by ISO3 (shared by search + ranking list).
  function focusCountry(iso) {
    const d = countrySel.data().find((f) => f.properties.iso_a3 === iso);
    if (!d) return false; // no polygon (small island / aggregate)
    state.pinned = null; // reset so togglePin pins fresh
    togglePin(d);
    const [[x0, y0], [x1, y1]] = path.bounds(d);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const scale = Math.max(1, Math.min(8, 0.6 / Math.max(dx / width, dy / height)));
    const translate = [width / 2 - scale * cx, height / 2 - scale * cy];
    svg
      .transition()
      .duration(600)
      .call(zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
    return true;
  }

  function onSearch() {
    const term = el.search.value.trim().toLowerCase();
    if (!term) return;
    const entry = Object.entries(state.data.countries).find(
      ([, c]) => c.name.toLowerCase() === term
    );
    if (entry) focusCountry(entry[0]);
  }

  // ---------------------------------------------------------------- ranking
  // Top-20 countries for the active metric and year, re-rendered on any change.
  function renderRanking() {
    const metric = state.metric;
    const year = state.year;
    const cfg = state.data.meta.metrics[metric];
    el.rankingSub.textContent = `${cfg.label} · ${year}`;

    const ranked = [];
    for (const iso of Object.keys(state.data.countries)) {
      if (iso.startsWith('OWID_')) continue; // skip aggregates (World, regions…)
      const v = metricValue(iso, year, metric);
      if (v === undefined) continue;
      ranked.push({
        iso,
        name: state.data.countries[iso].name,
        cca2: state.data.countries[iso].cca2,
        value: v,
      });
    }
    ranked.sort((a, b) => b.value - a.value);
    const top = ranked.slice(0, 20);

    if (top.length === 0) {
      el.rankList.innerHTML = `<li class="rank-empty">No data for ${year}</li>`;
      return;
    }

    const max = top[0].value;
    const unitSuffix = metric === 'production' ? ' t' : metric === 'area' ? ' ha' : '';
    el.rankList.innerHTML = top
      .map((r, i) => {
        const pct = max > 0 ? (r.value / max) * 100 : 0;
        const val = (metric === 'yield' ? fmtYield(r.value) : fmtInt(r.value)) + unitSuffix;
        const active = state.pinned === r.iso ? ' is-active' : '';
        // Local flag SVG (./flags/<iso2>.svg); hidden gracefully if absent.
        const flag = r.cca2
          ? `<img class="rank-flag" src="./flags/${r.cca2}.svg" alt="" loading="lazy" ` +
            `onerror="this.style.visibility='hidden'" />`
          : `<span class="rank-flag rank-flag--none"></span>`;
        return (
          `<li class="rank-item${active}" data-iso="${r.iso}" title="Click to highlight on map">` +
          `<span class="rank-bar" style="width:${pct}%"></span>` +
          `<span class="rank-num">${i + 1}</span>` +
          flag +
          `<span class="rank-name">${escapeHTML(r.name)}</span>` +
          `<span class="rank-val">${val}</span>` +
          `</li>`
        );
      })
      .join('');
  }

  function onRankClick(event) {
    const li = event.target.closest('.rank-item');
    if (!li) return;
    focusCountry(li.dataset.iso);
  }

  // ---------------------------------------------------------------- init
  function wireEvents() {
    el.slider.addEventListener('input', onSliderInput);
    el.playBtn.addEventListener('click', togglePlay);
    el.metricBtns.forEach((b) => b.addEventListener('click', () => setMetric(b.dataset.metric)));
    el.zoomIn.addEventListener('click', () => zoomBy(1.5));
    el.zoomOut.addEventListener('click', () => zoomBy(1 / 1.5));
    el.zoomReset.addEventListener('click', resetZoom);
    el.search.addEventListener('change', onSearch);
    el.rankList.addEventListener('click', onRankClick);
    window.addEventListener('resize', debounce(sizeMap, 150));
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  Promise.all([
    d3.json('./rice-data.json'),
    d3.json('./world-110m.json'),
  ])
    .then(([data, topo]) => {
      state.data = data;
      state.year = data.meta.maxYear;

      // slider range from meta
      el.slider.min = data.meta.minYear;
      el.slider.max = data.meta.maxYear;
      el.slider.value = data.meta.maxYear;
      el.yearMin.textContent = data.meta.minYear;
      el.yearMax.textContent = data.meta.maxYear;
      el.yearValue.textContent = data.meta.maxYear;

      buildColorScales();
      renderMap(topo);
      renderLegend();
      renderRanking();
      populateSearch();
      wireEvents();

      el.loading.classList.add('hidden');
    })
    .catch((err) => {
      el.loading.textContent = `Failed to load data: ${err.message}`;
      // surface for debugging but keep UI message
      console.error(err); // eslint-disable-line no-console
    });
})();
