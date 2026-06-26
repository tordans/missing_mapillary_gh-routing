// Route profile geometry — pure, framework-agnostic.
//
// Builds a "perpendicular histogram" beside a route. The wiggly route is NOT
// used directly as the bar baseline — instead a smoothed, offset version of it
// is derived (the "vereinfachte Basislinie als gekrümmte X-Achse" from the
// brief). Bars are resampled to a uniform width and stand perpendicular to that
// smooth baseline, so the chart stays clean even where the route kinks.
//
// No MapLibre / DOM dependency, so this can be reused unchanged in a React port.

const M_PER_DEG_LAT = 111320;

// Local equirectangular projection to meters around the route. Distortion is
// negligible for a regional route and lets us do all vector math in a flat,
// metric frame, converting back to lng/lat only at the end.
function makeProjector(coordinates) {
  let latSum = 0;
  for (const c of coordinates) latSum += c[1];
  const lat0 = latSum / coordinates.length;
  const lng0 = coordinates[0][0];
  const mLng = 111320 * Math.cos((lat0 * Math.PI) / 180) || 1;
  return {
    toXY: ([lng, lat]) => [(lng - lng0) * mLng, (lat - lat0) * M_PER_DEG_LAT],
    toLngLat: ([x, y]) => [lng0 + x / mLng, lat0 + y / M_PER_DEG_LAT],
  };
}

const dist2 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// Cumulative arc-length along an xy polyline.
function cumulative(xy) {
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + dist2(xy[i - 1], xy[i]));
  return cum;
}

// Resample an xy polyline to points spaced `step` meters apart. out[k] sits at
// arc-length k * step, so the index is a direct arc-length parametrization.
function resample(xy, cum, step) {
  const total = cum[cum.length - 1];
  const out = [];
  let seg = 0;
  for (let s = 0; s <= total; s += step) {
    while (seg < xy.length - 2 && cum[seg + 1] < s) seg++;
    const segLen = cum[seg + 1] - cum[seg] || 1;
    const f = (s - cum[seg]) / segLen;
    out.push([
      xy[seg][0] + f * (xy[seg + 1][0] - xy[seg][0]),
      xy[seg][1] + f * (xy[seg + 1][1] - xy[seg][1]),
    ]);
  }
  return out;
}

// Moving-average smoothing with a symmetric window of radius w samples.
function smooth(points, w) {
  if (w < 1) return points.slice();
  const n = points.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      sx += points[j][0];
      sy += points[j][1];
      c++;
    }
    out[i] = [sx / c, sy / c];
  }
  return out;
}

// Moving-average smoothing for a scalar array (window radius w).
function smooth1d(arr, w) {
  if (w < 1) return arr.slice();
  const n = arr.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      s += arr[j];
      c++;
    }
    out[i] = s / c;
  }
  return out;
}

// Unit tangents via central difference.
function tangents(points) {
  const n = points.length;
  const T = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    T[i] = [dx / len, dy / len];
  }
  return T;
}

const lineFeature = (xyPts, proj) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: xyPts.map(proj.toLngLat) },
  properties: {},
});

function emptyResult() {
  return {
    bars: { type: 'FeatureCollection', features: [] },
    baseline: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
    domain: { min: 0, max: 1 },
    step: 1,
    routeCum: [],
  };
}

// Index of the route coordinate whose cumulative arc-length is closest to `s`
// (cum is sorted ascending). Binary search.
function nearestIndexByArcLength(cum, s) {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(cum[lo - 1] - s) <= Math.abs(cum[lo] - s)) return lo - 1;
  return lo;
}

/**
 * Build the smooth-baseline histogram for a route.
 *
 * @param {Array<[number, number]>} coordinates - route as [lng, lat] points
 * @param {Array<number|null>} segmentValues - one value per route segment
 *        (length coordinates.length - 1)
 * @param {Object} [opts]
 * @param {'left'|'right'} [opts.side='right'] - side the baseline + bars sit on
 * @param {number} [opts.maxBarLengthMeters=300] - bar length at t = 1
 * @param {number} [opts.barWidthMeters] - width of each resampled bar (default L/90)
 * @param {number} [opts.smoothingMeters] - baseline smoothing window (default 3 × bar width)
 * @param {number} [opts.baseOffsetMeters] - gap between route and baseline (default 8% of max bar)
 * @param {number} [opts.sampleStepMeters] - baseline resampling resolution (default bar width / 4)
 * @param {number} [opts.minValue] / [opts.maxValue] - value domain (default: resampled data range)
 * @param {(t: number, value: number) => string} [opts.colorForT] - color per normalized value
 * @returns {{bars: Object, baseline: Object, domain: {min:number, max:number}}}
 *          GeoJSON bars (Polygons), the baseline (LineString), and the value domain used.
 */
export function buildProfileBars(coordinates, segmentValues, opts = {}) {
  if (!coordinates || coordinates.length < 3 || !segmentValues || segmentValues.length < 2) {
    return emptyResult();
  }

  const side = opts.side === 'left' ? 'left' : 'right';
  const maxLen = opts.maxBarLengthMeters > 0 ? opts.maxBarLengthMeters : 300;

  const proj = makeProjector(coordinates);
  const xy = coordinates.map(proj.toXY);
  const cumOrig = cumulative(xy);
  const L = cumOrig[cumOrig.length - 1];
  if (L < 1) return emptyResult();

  const barWidth = opts.barWidthMeters > 0 ? opts.barWidthMeters : Math.max(5, L / 90);
  const step = opts.sampleStepMeters > 0 ? opts.sampleStepMeters : Math.max(2, barWidth / 4);
  const smoothMeters = opts.smoothingMeters != null ? opts.smoothingMeters : barWidth * 3;
  const offset = opts.baseOffsetMeters != null ? opts.baseOffsetMeters : maxLen * 0.08;

  // 1. Smooth, offset baseline (the abstracted "curved X-axis").
  const R = resample(xy, cumOrig, step); // R[k] at arc-length k*step
  if (R.length < 3) return emptyResult();
  const K = R.length;
  const w = Math.max(0, Math.round(smoothMeters / step));
  const S = smooth(R, w);
  const T = tangents(S);
  const N = T.map(([dx, dy]) => (side === 'left' ? [-dy, dx] : [dy, -dx]));

  // The baseline = smoothed centerline pushed outward by `offset` PLUS the route's
  // own outward deviation from that centerline. Without the deviation term a very
  // smooth baseline would be crossed by the wiggly route at its peaks; with it the
  // baseline stays a clean ~`offset` clear of the route everywhere. The deviation
  // is dilated over the smoothing window (so peaks are cleared) then re-smoothed.
  const dev = new Array(K);
  for (let k = 0; k < K; k++) {
    dev[k] = Math.max(0, (R[k][0] - S[k][0]) * N[k][0] + (R[k][1] - S[k][1]) * N[k][1]);
  }
  const devClear = new Array(K);
  for (let k = 0; k < K; k++) {
    let m = 0;
    const lo = Math.max(0, k - w);
    const hi = Math.min(K - 1, k + w);
    for (let j = lo; j <= hi; j++) if (dev[j] > m) m = dev[j];
    devClear[k] = m;
  }
  const devSmooth = smooth1d(devClear, Math.max(1, Math.round(w / 2)));
  const B = S.map((p, k) => {
    const d = offset + devSmooth[k];
    return [p[0] + N[k][0] * d, p[1] + N[k][1] * d];
  });

  // 2. Value at each resample point (piecewise-constant from the route segments).
  const gv = new Array(K).fill(null);
  let seg = 0;
  for (let k = 0; k < K; k++) {
    const s = k * step;
    while (seg < segmentValues.length - 1 && cumOrig[seg + 1] <= s) seg++;
    const v = segmentValues[seg];
    gv[k] = v === null || v === undefined || !Number.isFinite(v) ? null : v;
  }

  // Interpolated baseline point at a fractional sample index; nearest tan/normal.
  const at = (arr, idx) => {
    const i0 = Math.max(0, Math.min(arr.length - 1, Math.floor(idx)));
    const i1 = Math.min(arr.length - 1, i0 + 1);
    const f = idx - i0;
    return [arr[i0][0] + f * (arr[i1][0] - arr[i0][0]), arr[i0][1] + f * (arr[i1][1] - arr[i0][1])];
  };
  const nearest = (arr, idx) => arr[Math.max(0, Math.min(arr.length - 1, Math.round(idx)))];

  // 3. Resample one value per uniform bar (mean over the bar's arc-length window).
  const numBars = Math.max(1, Math.floor(L / barWidth));
  const raw = new Array(numBars).fill(null);
  for (let j = 0; j < numBars; j++) {
    const i0 = Math.round((j * barWidth) / step);
    const i1 = Math.round(((j + 1) * barWidth) / step);
    let sum = 0;
    let c = 0;
    for (let k = i0; k <= i1 && k < K; k++) {
      if (gv[k] != null) {
        sum += gv[k];
        c++;
      }
    }
    raw[j] = c > 0 ? sum / c : null;
  }

  const validRaw = raw.filter((v) => v != null);
  if (!validRaw.length) {
    return { ...emptyResult(), baseline: lineFeature(B, proj), step, routeCum: cumOrig };
  }
  const minV = opts.minValue != null ? opts.minValue : Math.min(...validRaw);
  const maxV = opts.maxValue != null ? opts.maxValue : Math.max(...validRaw);
  const range = maxV - minV || 1;
  const colorFn = typeof opts.colorForT === 'function' ? opts.colorForT : null;
  const gap = 0.94; // small gaps between bars for a crisp histogram

  // 4. Build uniform bar rectangles standing on the smooth baseline.
  const features = [];
  for (let j = 0; j < numBars; j++) {
    const v = raw[j];
    if (v == null) continue;
    const t = Math.max(0, Math.min(1, (v - minV) / range));
    const len = t * maxLen;
    if (len <= 0) continue;

    const centerIdx = ((j + 0.5) * barWidth) / step;
    const P = at(B, centerIdx);
    const tan = nearest(T, centerIdx);
    const nor = nearest(N, centerIdx);
    const hw = (barWidth * gap) / 2;

    const b1 = [P[0] - tan[0] * hw, P[1] - tan[1] * hw];
    const b2 = [P[0] + tan[0] * hw, P[1] + tan[1] * hw];
    const t2 = [b2[0] + nor[0] * len, b2[1] + nor[1] * len];
    const t1 = [b1[0] + nor[0] * len, b1[1] + nor[1] * len];
    const ring = [b1, b2, t2, t1, b1].map(proj.toLngLat);

    // Route-coordinate index at this bar's center — lets the shared cursor map a
    // hovered bar back to a position on the route line and height profile.
    const routeIndex = nearestIndexByArcLength(cumOrig, (j + 0.5) * barWidth);

    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { index: j, routeIndex, value: v, t, color: colorFn ? colorFn(t, v) : '#7c3aed' },
    });
  }

  return {
    bars: { type: 'FeatureCollection', features },
    baseline: lineFeature(B, proj),
    domain: { min: minV, max: maxV },
    step, // baseline sample spacing in meters (B[k] is at route arc-length k*step)
    routeCum: cumOrig, // route arc-length per original coordinate
  };
}
