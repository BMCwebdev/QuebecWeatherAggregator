// Cloudflare Worker entry. Static assets (index.html, app.js, consensus.js,
// styles.css, llms.txt) are served from ./public via the ASSETS binding.
// Any path without a matching asset falls through to here, which is how the
// dynamic /forecast* JSON endpoints get served on the same origin.
//
// Why this exists: sandboxed agents often can't reach api.open-meteo.com
// (host allowlists) or run the page's JS. The Worker fetches Open-Meteo
// server-side and returns plain JSON from *your* domain, which agents can read.

import { buildForecast, dateRangeProblem, geocode } from './public/consensus.js';

const ROUND = {
  temp: 1, // °F / %
  precip: 2, // inches
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') return preflight();

    const isForecast = pathname === '/forecast.json'
      || pathname === '/forecast/index.json'
      || /^\/forecast\/\d{4}-\d{2}-\d{2}(\.summary)?\.json$/.test(pathname);
    // Not a forecast route — serve a static asset.
    if (!isForecast) return env.ASSETS.fetch(request);

    try {
      const params = await paramsFromUrl(url);
      // Fresh build every request — always the latest upstream data.
      const forecast = await loadForecast(params);
      if (!forecast.sourceCount) {
        const outOfRange = /out of allowed range/i.test(forecast.failureReason);
        return json({
          error: outOfRange ? 'dates_out_of_range' : 'forecast_failed',
          message: `No forecast source returned data (${forecast.failureReason})`,
        }, outOfRange ? 400 : 502);
      }
      // Per-day links keep the caller's location/date query so they stay aimed
      // at the same forecast.
      const linkQuery = linkQueryFrom(url);
      if (pathname === '/forecast.json') return json(fullPayload(forecast, url.origin, linkQuery));
      if (pathname === '/forecast/index.json') return json(indexPayload(forecast, url.origin, linkQuery));
      const summaryMatch = pathname.match(/^\/forecast\/(\d{4}-\d{2}-\d{2})\.summary\.json$/);
      if (summaryMatch) return dayResponse(dayPayload(forecast, summaryMatch[1], false));
      const dayMatch = pathname.match(/^\/forecast\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (dayMatch) return dayResponse(dayPayload(forecast, dayMatch[1], true));
    } catch (error) {
      if (error instanceof RequestError) return json({ error: error.code, message: error.message }, error.status);
      return json({ error: 'forecast_failed', message: String(error?.message ?? error) }, 502);
    }

    return env.ASSETS.fetch(request);
  },
};

// No caching — build fresh on every request so the data is always the latest
// Open-Meteo has. Each build stamps generatedAt and a content hash; within one
// request every endpoint derives from this same build, and across requests the
// deterministic scoring + near-simultaneous upstream data keep index and
// summaries consistent (snapshotHash confirms it; a mismatch means an upstream
// update landed mid-pull — just refetch).
async function loadForecast(params) {
  const forecast = await buildForecast(params);
  forecast.generatedAt = new Date().toISOString();
  forecast.snapshotHash = await computeSnapshotHash(forecast);
  return forecast;
}

// Content-derived hash of the decision-relevant outputs (rounded, so trivial
// float jitter between model runs doesn't flip it). Two snapshots with the same
// hash describe the same forecast even if generatedAt differs — so an agent can
// tell "did anything actually change since my last fetch?" by comparing hashes,
// and can confirm two files (index vs summary) are the same run. 64-bit hex.
async function computeSnapshotHash(forecast) {
  const projection = {
    days: forecast.days.map((d) => [d.date, d.avgScore, d.stormPeak, d.agreement, d.goodHours, d.excellentHours]),
    hours: forecast.hours.filter((h) => h.isDaytime).map((h) => [
      h.time,
      h.score,
      h.stormVotes,
      Math.round(h.rainSignal ?? -1),
      Math.round(h.apparentTemperature ?? -999),
    ]),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(projection));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

class RequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Location: `city` ("Burlington, VT") or `lat`+`lon`; default is Québec.
// Dates: `start`+`end` (YYYY-MM-DD); default is today and tomorrow, local to
// the location.
async function paramsFromUrl(url) {
  const params = {};
  const query = url.searchParams;
  const city = query.get('city')?.trim();
  const lat = query.get('lat');
  const lon = query.get('lon');

  if (city) {
    const [match] = await geocode(city);
    if (!match) throw new RequestError('city_not_found', `No place found for "${city}". Try "City, State" or "City, Country".`, 404);
    Object.assign(params, { latitude: match.latitude, longitude: match.longitude, label: match.label });
  } else if (lat !== null || lon !== null) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    const valid = lat !== null && lon !== null && lat !== '' && lon !== ''
      && Number.isFinite(latitude) && Number.isFinite(longitude)
      && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
    if (!valid) throw new RequestError('invalid_coordinates', 'Pass both lat (-90..90) and lon (-180..180), or use city= instead.');
    Object.assign(params, { latitude, longitude });
  }

  const start = query.get('start');
  const end = query.get('end');
  if (start !== null || end !== null) {
    // One day of slack: the Worker's clock is UTC, the location's may differ.
    const problem = dateRangeProblem(start, end, 1);
    if (problem) throw new RequestError('invalid_dates', `Invalid start/end: ${problem}.`);
    Object.assign(params, { startDate: start, endDate: end });
  }
  return params;
}

function linkQueryFrom(url) {
  const kept = new URLSearchParams();
  const keys = url.searchParams.get('city')?.trim() ? ['city', 'start', 'end'] : ['lat', 'lon', 'start', 'end'];
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== '') kept.set(key, value);
  }
  const text = kept.toString();
  return text ? `?${text}` : '';
}

function meta(forecast) {
  return {
    generatedAt: forecast.generatedAt,
    snapshotHash: forecast.snapshotHash,
    location: {
      name: forecast.params.label,
      latitude: forecast.params.latitude,
      longitude: forecast.params.longitude,
      timezone: forecast.params.timezone,
    },
    range: { startDate: forecast.params.startDate, endDate: forecast.params.endDate },
    units: { temperature: 'fahrenheit', wind: 'mph', precipitation: 'inch' },
    sourceCount: forecast.sourceCount,
    independentCount: forecast.independentCount,
    note: 'Outdoor comfort score (0-100) and model agreement are heuristics. Spread (min/max/median) is across independent models only; best_match is the blend and is reported separately. See /llms.txt. Values are decision inputs, not recommendations.',
  };
}

// All days in one file: consensus + spread + blend per hour, NO per-model
// arrays (those live in the per-day full files). ~41KB.
function fullPayload(forecast, origin, linkQuery) {
  return {
    ...meta(forecast),
    verdict: forecast.verdict,
    days: forecast.days,
    hours: forecast.hours.filter((hour) => hour.isDaytime).map((hour) => shapeHour(hour, false)),
    perDayFiles: dayFileMap(forecast, origin, linkQuery),
    sourceHealth: forecast.health,
  };
}

// Tiny index: verdict + day rollups + ABSOLUTE links to the per-day files.
function indexPayload(forecast, origin, linkQuery) {
  return {
    ...meta(forecast),
    verdict: forecast.verdict,
    days: forecast.days,
    perDayFiles: dayFileMap(forecast, origin, linkQuery),
    sourceHealth: forecast.health,
  };
}

// One day. withModels=false -> small summary (per-hour consensus + spread).
// withModels=true -> full per-model breakdown.
function dayPayload(forecast, date, withModels) {
  const day = forecast.days.find((entry) => entry.date === date);
  if (!day) return { error: 'date_not_found', date, available: forecast.days.map((entry) => entry.date) };
  return {
    ...meta(forecast),
    tier: withModels ? 'full' : 'summary',
    day,
    hours: forecast.hours.filter((hour) => hour.isDaytime && hour.date === date).map((hour) => shapeHour(hour, withModels)),
  };
}

function dayResponse(payload) {
  return json(payload, payload.error ? 404 : 200);
}

// Absolute URLs so agent fetch tools (which often reject relative paths and
// only allow URLs already seen in-conversation) can reach every day from one
// index fetch.
function dayFileMap(forecast, origin, linkQuery) {
  return Object.fromEntries(forecast.days.map((day) => [day.date, {
    summary: `${origin}/forecast/${day.date}.summary.json${linkQuery}`,
    full: `${origin}/forecast/${day.date}.json${linkQuery}`,
  }]));
}

function shapeHour(hour, includeModels) {
  const shaped = {
    time: hour.time,
    date: hour.date,
    hour: hour.hour,
    score: hour.score,
    rating: hour.rating,
    label: hour.label,
    temp: r(hour.temperature),
    feels: r(hour.apparentTemperature),
    humidity: r(hour.humidity),
    windGusts: r(hour.windGusts),
    rainSignal: r(hour.rainSignal),
    rainMin: r(hour.rainMin),
    rainMax: r(hour.rainMax),
    rainSpread: r(hour.rainSpread),
    agreement: hour.agreement,
    stormVotes: hour.stormVotes,
    showerVotes: hour.showerVotes,
    sourceCount: hour.sourceCount,
    independentCount: hour.independentCount,
    spread: roundSpread(hour.spread),
    blend: hour.blend ? {
      feels: r(hour.blend.apparentTemperature),
      rainProb: r(hour.blend.precipitationProbability),
      windGusts: r(hour.blend.windGusts),
      code: hour.blend.weatherCode,
    } : null,
  };
  if (includeModels) {
    shaped.models = hour.models.map((model) => ({
      id: model.id,
      label: model.label,
      independent: model.independent,
      feels: r(model.apparentTemperature),
      rainProb: r(model.precipitationProbability),
      precip: r(model.precipitation, ROUND.precip),
      showers: r(model.showers, ROUND.precip),
      gust: r(model.windGusts),
      humidity: r(model.humidity),
      code: model.weatherCode,
    }));
  }
  return shaped;
}

function roundSpread(spread) {
  if (!spread) return null;
  // n = how many independent models reported this metric this hour.
  const band = (b) => ({ min: r(b.min), max: r(b.max), median: r(b.median), n: b.n });
  return { rainProb: band(spread.rainProb), feels: band(spread.feels), gust: band(spread.gust) };
}

function r(value, digits = ROUND.temp) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function json(data, status = 200) {
  // Pretty-printed: newlines keep agent fetch tools from truncating one giant line.
  // no-store: every pull returns freshly-built data — signals edge/agent caches
  // not to serve a stale copy.
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store, must-revalidate',
    },
  });
}

function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}
