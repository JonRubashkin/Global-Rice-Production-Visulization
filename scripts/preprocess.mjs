#!/usr/bin/env node
/**
 * Preprocess FAOSTAT/OWID rice CSVs + population CSV into a compact JSON file
 * keyed by ISO 3166-1 alpha-3 country code and year, and augment the
 * world-atlas TopoJSON with alpha-3 codes so the app can join by code.
 *
 * Inputs  (data/):
 *   - rice-production.csv : Entity, Code, Year, Rice - Production (tonnes)
 *   - rice-yields.csv     : Entity, Code, Year, Rice - Yield (tonnes per hectare)
 *   - population.csv      : Entity, Code, Year, Population
 * Source map (scripts/):
 *   - world-countries.json : ISO numeric <-> alpha-3 reference (world-countries pkg)
 *   - ../public/world-110m.json : world-atlas TopoJSON (numeric ids)
 *
 * Outputs:
 *   - public/rice-data.json   : { meta, countries: { ISO3: { name, years: {...} } } }
 *   - public/world-110m.json  : same TopoJSON, each geometry gets properties.iso_a3
 *
 * Notes:
 *   - The OWID files already carry ISO alpha-3 codes in the Code column.
 *     Regional aggregates (Asia (FAO), ...) have an empty Code and are dropped.
 *     Historical entities use OWID_* pseudo-codes (USSR=OWID_USS, ...); we keep
 *     them in the data but they have no polygon on the modern map.
 *   - Area harvested is derived as production / yield (tonnes / (t/ha)) because
 *     the OWID export ships yield rather than area. Divide-by-zero is guarded.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const p = (...segs) => resolve(ROOT, ...segs);

/* ------------------------------------------------------------------ */
/* Minimal RFC-4180-ish CSV parser (handles quoted fields w/ commas).  */
/* ------------------------------------------------------------------ */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // ignore
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function loadTable(file) {
  const rows = parseCSV(readFileSync(p('data', file), 'utf8'));
  const header = rows.shift();
  // columns: Entity, Code, Year, <value>
  const out = [];
  for (const r of rows) {
    if (r.length < 4) continue;
    const [entity, code, yearStr, valStr] = r;
    if (entity === '' && code === '') continue;
    const year = Number(yearStr);
    const value = valStr === '' ? null : Number(valStr);
    if (!Number.isFinite(year)) continue;
    out.push({ entity, code: code.trim(), year, value });
  }
  return { header, rows: out };
}

/* ------------------------------------------------------------------ */
/* Build numeric ISO -> alpha-3 and name -> alpha-3 reference tables.  */
/* ------------------------------------------------------------------ */
const worldCountries = JSON.parse(readFileSync(p('scripts', 'world-countries.json'), 'utf8'));
const numericToAlpha3 = new Map();
const nameToAlpha3 = new Map();
const validAlpha3 = new Set();
for (const c of worldCountries) {
  if (c.ccn3) numericToAlpha3.set(String(Number(c.ccn3)), c.cca3); // strip leading zeros
  validAlpha3.add(c.cca3);
  const names = new Set([c.name.common, c.name.official, ...(c.altSpellings || [])]);
  for (const n of names) if (n) nameToAlpha3.set(n.toLowerCase(), c.cca3);
}

// Explicit name -> ISO overrides for map / data names that don't match cleanly.
const NAME_OVERRIDES = {
  'viet nam': 'VNM',
  'vietnam': 'VNM',
  'türkiye': 'TUR',
  'turkiye': 'TUR',
  'turkey': 'TUR',
  'czechia': 'CZE',
  'czech republic': 'CZE',
  'democratic republic of congo': 'COD',
  'dem. rep. congo': 'COD',
  'congo': 'COG',
  'côte d’ivoire': 'CIV',
  "cote d'ivoire": 'CIV',
  'ivory coast': 'CIV',
  'laos': 'LAO',
  'south korea': 'KOR',
  'north korea': 'PRK',
  'russia': 'RUS',
  'syria': 'SYR',
  'iran': 'IRN',
  'tanzania': 'TZA',
  'bolivia': 'BOL',
  'venezuela': 'VEN',
  'brunei': 'BRN',
  'moldova': 'MDA',
  'united states': 'USA',
  'east timor': 'TLS',
  'timor-leste': 'TLS',
  'eswatini': 'SWZ',
  'swaziland': 'SWZ',
  'gambia': 'GMB',
  'w. sahara': 'ESH',
  'western sahara': 'ESH',
  'macedonia': 'MKD',
  'north macedonia': 'MKD',
  'bosnia and herz.': 'BIH',
  'bosnia and herzegovina': 'BIH',
  's. sudan': 'SSD',
  'south sudan': 'SSD',
  'dominican rep.': 'DOM',
  'central african rep.': 'CAF',
  'eq. guinea': 'GNQ',
  'solomon is.': 'SLB',
  'fr. s. antarctic lands': 'ATF',
  'falkland is.': 'FLK',
};

function resolveAlpha3FromName(name) {
  if (!name) return null;
  const key = name.toLowerCase();
  return NAME_OVERRIDES[key] || nameToAlpha3.get(key) || null;
}

/* ------------------------------------------------------------------ */
/* Assemble per-country / per-year records.                            */
/* ------------------------------------------------------------------ */
const production = loadTable('rice-production.csv');
const yields = loadTable('rice-yields.csv');
const population = loadTable('population.csv');

/** countries[ISO3] = { name, years: { [year]: {production, area, yield, population} } } */
const countries = {};
const unmatchedEntities = new Set(); // entities we tried to keep but couldn't resolve

function ensure(code, name) {
  if (!countries[code]) countries[code] = { name, years: {} };
  return countries[code];
}
function ensureYear(rec, year) {
  if (!rec.years[year]) rec.years[year] = {};
  return rec.years[year];
}

// Production -> establishes the country/year universe.
for (const { entity, code, year, value } of production.rows) {
  if (!code) { unmatchedEntities.add(entity); continue; } // FAO aggregates, no code
  const rec = ensure(code, entity);
  ensureYear(rec, year).production = value;
}

// Yield, and derive area = production / yield (guard divide-by-zero).
for (const { code, year, value } of yields.rows) {
  if (!code || !countries[code]) continue;
  const y = ensureYear(countries[code], year);
  y.yield = value;
  if (value && value > 0 && y.production != null) {
    y.area = y.production / value;
  } else {
    y.area = null;
  }
}

// Population (only attach years we already track for that country).
for (const { code, year, value } of population.rows) {
  if (!code || !countries[code]) continue;
  const rec = countries[code];
  if (rec.years[year]) rec.years[year].population = value;
}

/* ------------------------------------------------------------------ */
/* Compute meta: year range + per-metric global non-zero extents.      */
/* ------------------------------------------------------------------ */
let minYear = Infinity, maxYear = -Infinity;
const ext = {
  production: [Infinity, -Infinity],
  area: [Infinity, -Infinity],
  yield: [Infinity, -Infinity],
};
function bump(metric, v) {
  if (v == null || !Number.isFinite(v) || v <= 0) return;
  if (v < ext[metric][0]) ext[metric][0] = v;
  if (v > ext[metric][1]) ext[metric][1] = v;
}
for (const code of Object.keys(countries)) {
  for (const yStr of Object.keys(countries[code].years)) {
    const y = Number(yStr);
    if (y < minYear) minYear = y;
    if (y > maxYear) maxYear = y;
    const d = countries[code].years[yStr];
    bump('production', d.production);
    bump('area', d.area);
    bump('yield', d.yield);
  }
}

/* ------------------------------------------------------------------ */
/* Augment the world-atlas TopoJSON with alpha-3 codes.                */
/* ------------------------------------------------------------------ */
const topo = JSON.parse(readFileSync(p('public', 'world-110m.json'), 'utf8'));
const geoms = topo.objects.countries.geometries;
const unmatchedMapFeatures = [];
for (const g of geoms) {
  const byNumeric = numericToAlpha3.get(String(Number(g.id)));
  const byName = resolveAlpha3FromName(g.properties && g.properties.name);
  const iso = byNumeric || byName || null;
  g.properties = g.properties || {};
  g.properties.iso_a3 = iso;
  if (!iso) unmatchedMapFeatures.push(`${g.id} / ${g.properties.name}`);
}

/* ------------------------------------------------------------------ */
/* Report + write outputs.                                             */
/* ------------------------------------------------------------------ */
const dataCodesWithPolygon = new Set(
  geoms.map((g) => g.properties.iso_a3).filter(Boolean)
);
const dataOnlyCodes = Object.keys(countries).filter((c) => !dataCodesWithPolygon.has(c));

const meta = {
  minYear,
  maxYear,
  generatedAt: new Date().toISOString(),
  metrics: {
    production: { label: 'Production (tonnes)', unit: 'tonnes', scale: 'log', extent: ext.production },
    area: { label: 'Harvested land (ha)', unit: 'ha', scale: 'log', extent: ext.area },
    yield: { label: 'Yield (t/ha)', unit: 't/ha', scale: 'linear', extent: ext.yield },
  },
};

writeFileSync(p('public', 'rice-data.json'), JSON.stringify({ meta, countries }));
writeFileSync(p('public', 'world-110m.json'), JSON.stringify(topo));

/* ---- Logging (do not silently drop anything) -------------------- */
console.log('Preprocessing complete.');
console.log(`  Years: ${minYear}–${maxYear}`);
console.log(`  Countries with data: ${Object.keys(countries).length}`);
console.log(`  Production extent: ${ext.production.join(' .. ')}`);
console.log(`  Area extent:       ${ext.area.join(' .. ')}`);
console.log(`  Yield extent:      ${ext.yield.join(' .. ')}`);
console.log(`  Map features matched to ISO3: ${dataCodesWithPolygon.size}/${geoms.length}`);

const realUnmatched = unmatchedEntities; // these are FAO aggregates (expected)
console.log(`\n  Skipped non-country aggregates (no ISO code): ${realUnmatched.size}`);
[...realUnmatched].sort().forEach((e) => console.log(`    - ${e}`));

if (unmatchedMapFeatures.length) {
  console.log(`\n  WARNING: map polygons with no ISO3 match (${unmatchedMapFeatures.length}):`);
  unmatchedMapFeatures.forEach((e) => console.log(`    - ${e}`));
} else {
  console.log('\n  All map polygons resolved to an ISO3 code.');
}

if (dataOnlyCodes.length) {
  console.log(`\n  Data countries with no polygon on the 110m map (${dataOnlyCodes.length}):`);
  dataOnlyCodes.sort().forEach((c) => console.log(`    - ${c} (${countries[c].name})`));
}
