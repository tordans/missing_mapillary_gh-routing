// 3D route profile — native MapLibre 3D bar chart (fill-extrusion) + optional
// 3D buildings, tilted camera view. Two variants:
//   - 'route'    : columns stand on the route itself
//   - 'baseline' : columns stand on a smoothed baseline beside the route
//
// This is the ONLY module here that touches MapLibre/DOM. Geometry, values and
// colors live in pure modules (profileColumns + the shared profileValues /
// profileColorScales), so a React port only re-implements this thin layer.

import { routeState } from '../routeState.js';
import { buildColumns, makeValueAtFraction } from './profileColumns.js';
import { buildProfileBars } from '../routeProfile/profileGeometry.js';
import { PROFILE_VALUES, getProfileSeries, toSegmentValues } from '../routeProfile/profileValues.js';
import { COLOR_SCHEMES, colorForT } from '../routeProfile/profileColorScales.js';

const SOURCE_COLS = 'route-3d-columns';
const LAYER_COLS = 'route-3d-columns-extrusion';
const LAYER_BUILDINGS = 'route-3d-buildings';

const IDS = {
  toggle: 'profile3d-toggle',
  controls: 'profile3d-controls',
  variant: 'profile3d-variant',
  value: 'profile3d-value',
  scheme: 'profile3d-scheme',
  height: 'profile3d-height',
  buildings: 'profile3d-buildings',
};

const options = {
  enabled: false,
  variant: 'route', // 'route' | 'baseline'
  valueKey: 'elevation',
  scheme: 'danger',
  maxHeightMeters: 250,
  buildings: true,
};

const ENABLED_PITCH = 55;
let mapRef = null;
let controlsWired = false;
let prevPitch = 0;

function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

export function setupRouteProfile3D(map) {
  mapRef = map;
  ensureLayers(map);
  if (!controlsWired) {
    setupControls();
    controlsWired = true;
  }
  update3D();
}

function ensureLayers(map) {
  if (!map.getSource(SOURCE_COLS)) {
    map.addSource(SOURCE_COLS, { type: 'geojson', data: emptyFC() });
  }
  // 3D buildings reuse the basemap's existing OpenMapTiles `building` source-layer
  // (render_height / render_min_height), extruded natively. Hidden until toggled.
  if (map.getSource('openmaptiles') && !map.getLayer(LAYER_BUILDINGS)) {
    map.addLayer({
      id: LAYER_BUILDINGS,
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 13,
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': 'hsl(35, 8%, 80%)',
        'fill-extrusion-height': [
          'max',
          ['coalesce', ['to-number', ['get', 'render_height']], 6],
          ['coalesce', ['to-number', ['get', 'render_min_height']], 0],
        ],
        'fill-extrusion-base': ['coalesce', ['to-number', ['get', 'render_min_height']], 0],
        'fill-extrusion-opacity': 0.75,
      },
    });
  }
  // The route profile columns sit on top, depth-tested against the buildings.
  if (!map.getLayer(LAYER_COLS)) {
    map.addLayer({
      id: LAYER_COLS,
      type: 'fill-extrusion',
      source: SOURCE_COLS,
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.92,
      },
    });
  }
}

function setupControls() {
  populateSelectors();

  const toggle = document.getElementById(IDS.toggle);
  const controls = document.getElementById(IDS.controls);
  if (toggle) {
    toggle.checked = options.enabled;
    if (controls) controls.style.display = options.enabled ? 'block' : 'none';
    toggle.addEventListener('change', (e) => {
      options.enabled = e.target.checked;
      if (controls) controls.style.display = options.enabled ? 'block' : 'none';
      applyCamera();
      update3D();
    });
  }

  bindSelect(IDS.variant, 'variant');
  bindSelect(IDS.value, 'valueKey');
  bindSelect(IDS.scheme, 'scheme');

  const height = document.getElementById(IDS.height);
  if (height) {
    height.value = String(options.maxHeightMeters);
    height.addEventListener('input', (e) => {
      options.maxHeightMeters = parseFloat(e.target.value) || 250;
      update3D();
    });
  }

  const buildings = document.getElementById(IDS.buildings);
  if (buildings) {
    buildings.checked = options.buildings;
    buildings.addEventListener('change', (e) => {
      options.buildings = e.target.checked;
      updateBuildingsVisibility();
    });
  }
}

function bindSelect(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = options[key];
  el.addEventListener('change', (e) => {
    options[key] = e.target.value;
    update3D();
  });
}

function populateSelectors() {
  const valueSel = document.getElementById(IDS.value);
  if (valueSel && valueSel.options.length === 0) {
    Object.entries(PROFILE_VALUES).forEach(([key, def]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = def.unit ? `${def.label} (${def.unit})` : def.label;
      valueSel.appendChild(opt);
    });
  }
  const schemeSel = document.getElementById(IDS.scheme);
  if (schemeSel && schemeSel.options.length === 0) {
    Object.entries(COLOR_SCHEMES).forEach(([key, def]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = def.label;
      schemeSel.appendChild(opt);
    });
  }
}

// Tilt the camera into a 3D view when enabling, restore when disabling.
function applyCamera() {
  if (!mapRef) return;
  if (options.enabled) {
    prevPitch = mapRef.getPitch();
    if (mapRef.getPitch() < 30) mapRef.easeTo({ pitch: ENABLED_PITCH, duration: 600 });
  } else {
    mapRef.easeTo({ pitch: prevPitch || 0, duration: 600 });
  }
}

function updateBuildingsVisibility() {
  if (!mapRef || !mapRef.getLayer(LAYER_BUILDINGS)) return;
  const vis = options.enabled && options.buildings ? 'visible' : 'none';
  mapRef.setLayoutProperty(LAYER_BUILDINGS, 'visibility', vis);
}

// Meters per pixel at the current zoom (for a baseline offset that reads ~constant).
function pixelsToMeters(px, coordinates) {
  if (!mapRef || !coordinates.length) return px;
  let latSum = 0;
  for (const c of coordinates) latSum += c[1];
  const lat = latSum / coordinates.length;
  const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, mapRef.getZoom());
  return px * mPerPx;
}

export function update3D() {
  if (!mapRef) return;
  const src = mapRef.getSource(SOURCE_COLS);
  if (!src) return;

  updateBuildingsVisibility();

  const data = routeState.currentRouteData;
  if (!options.enabled || !data || !Array.isArray(data.coordinates) || data.coordinates.length < 3) {
    src.setData(emptyFC());
    return;
  }

  const series = getProfileSeries(data, options.valueKey);
  if (!series.available || series.values.length === 0) {
    src.setData(emptyFC());
    return;
  }

  const valueAtFraction = makeValueAtFraction(data.coordinates, series.values);
  const valid = series.values.filter((v) => Number.isFinite(v));
  const minValue = valid.length ? Math.min(...valid) : 0;
  const maxValue = valid.length ? Math.max(...valid) : 1;

  const totalDistance = data.distance || 1;
  const barWidthMeters = Math.max(15, totalDistance / 200);

  // Which line do the columns stand on?
  let line = data.coordinates;
  if (options.variant === 'baseline') {
    const mode = options.valueKey === 'elevation' ? 'avg' : 'start';
    const segValues = toSegmentValues(series.values, mode);
    const baseline = buildProfileBars(data.coordinates, segValues, {
      side: 'east',
      maxBarLengthMeters: 1,
      barWidthMeters,
      smoothingMeters: barWidthMeters * 8,
      baseOffsetMeters: pixelsToMeters(70, data.coordinates),
      sampleStepMeters: Math.max(3, barWidthMeters / 4),
    }).baseline;
    if (baseline && baseline.geometry.coordinates.length > 1) line = baseline.geometry.coordinates;
  }

  const fc = buildColumns(line, valueAtFraction, {
    minValue,
    maxValue,
    barWidthMeters,
    footprintDepthMeters: barWidthMeters * 0.7,
    maxHeightMeters: options.maxHeightMeters,
    colorForT: (t) => colorForT(options.scheme, t),
  });
  src.setData(fc);
}

/** Clear columns + reset the camera/buildings (called when the route is cleared). */
export function clearRouteProfile3D() {
  if (!mapRef) return;
  const src = mapRef.getSource(SOURCE_COLS);
  if (src) src.setData(emptyFC());
  updateBuildingsVisibility();
}
