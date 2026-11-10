// Shared, DOM-free forecast logic.
// Imported by both the browser UI (app.js) and the Cloudflare Worker (worker.js)
// so the scoring is identical everywhere. Uses only globals available in both
// runtimes: fetch, URL, setTimeout, Math, Date, Intl.

export const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
export const GEOCODING_BASE = 'https://geocoding-api.open-meteo.com/v1/search';
export const EC_CITY_PAGE = 'https://api.weather.gc.ca/collections/citypageweather-realtime/items';

// `independent: true` are the distinct physical/ML models we measure spread
// across. `best_match` is Open-Meteo's blend of several models, so it is
// reported separately and excluded from the min/max/median range.
export const OPEN_METEO_SOURCES = [
  { id: 'best_match', label: 'Open-Meteo best match', model: null, independent: false },
  { id: 'ecmwf_ifs025', label: 'ECMWF IFS 0.25°', model: 'ecmwf_ifs025', independent: true },
  { id: 'gfs_global', label: 'NOAA GFS Global', model: 'gfs_global', independent: true },
  { id: 'gem_global', label: 'Canadian GEM Global', model: 'gem_global', independent: true },
  { id: 'icon_global', label: 'DWD ICON Global', model: 'icon_global', independent: true },
  { id: 'ecmwf_aifs025', label: 'ECMWF AIFS 0.25°', model: 'ecmwf_aifs025', independent: true },
  { id: 'gfs_graphcast025', label: 'NOAA GraphCast 0.25°', model: 'gfs_graphcast025', independent: true },
  { id: 'ukmo_global', label: 'UKMO Global 10 km', model: 'ukmo_global_deterministic_10km', independent: true },
  { id: 'arpege_world', label: 'Météo-France ARPEGE World', model: 'meteofrance_arpege_world', independent: true },
];

const hourlyVariables = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'precipitation_probability',
  'precipitation',
  'rain',
  'showers',
  'weather_code',
  'cloud_cover',
  'wind_speed_10m',
  'wind_gusts_10m',
].join(',');

// Default location. Everything is overridable via params. With no dates given,
// the forecast covers today and tomorrow in the location's own timezone.
export const DEFAULTS = {
  latitude: 46.8139,
  longitude: -71.2080,
  label: 'Québec, Quebec, Canada',
  timezone: 'auto',
};
export const DEFAULT_FORECAST_DAYS = 2;

// Open-Meteo's forecast endpoint only serves a rolling window around today.
export const FORECAST_DAYS_BACK = 92;
export const FORECAST_DAYS_AHEAD = 15;

// Orchestrates the fetch + scoring. Returns a rich structure both the UI and
// the Worker shape for their own outputs. Never rejects on a single bad model;
// failures land in `health` instead.
export async function buildForecast(rawParams = {}) {
  const params = { ...DEFAULTS, ...rawParams };
  if (rawParams.label === undefined && (rawParams.latitude !== undefined || rawParams.longitude !== undefined)) {
    params.label = `${params.latitude}, ${params.longitude}`;
  }
  const [openMeteoResults, environmentCanadaResult] = await Promise.all([
    Promise.allSettled(OPEN_METEO_SOURCES.map((source) => fetchOpenMeteo(source, params))),
    fetchEnvironmentCanada(params).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    ),
  ]);

  const sources = [];
  const health = [];
  for (let index = 0; index < openMeteoResults.length; index += 1) {
    const result = openMeteoResults[index];
    const source = OPEN_METEO_SOURCES[index];
    if (result.status === 'fulfilled') {
      sources.push(result.value);
      health.push({ id: source.id, label: source.label, ok: true, message: `${result.value.hours.length} hourly rows` });
    } else {
      health.push({ id: source.id, label: source.label, ok: false, message: result.reason.message });
    }
  }

  // Regional source: only reported when the location has a nearby Canadian city page.
  if (environmentCanadaResult.status === 'fulfilled') {
    if (environmentCanadaResult.value) {
      health.push({ id: 'environment_canada', label: 'Environment Canada city page', ok: true, message: environmentCanadaResult.value.summary });
    }
  } else {
    health.push({ id: 'environment_canada', label: 'Environment Canada city page', ok: false, message: environmentCanadaResult.reason.message });
  }

  const consensus = buildConsensus(sources);
  const verdict = buildVerdict(consensus.daily, sources.length);
  return {
    // Resolved values: the timezone Open-Meteo picked for the coordinates, and
    // the actual date range when none was requested.
    params: {
      ...params,
      timezone: sources[0]?.timezone ?? params.timezone,
      startDate: params.startDate ?? consensus.daily[0]?.date ?? null,
      endDate: params.endDate ?? consensus.daily.at(-1)?.date ?? null,
    },
    failureReason: sources.length ? null : (health.find((item) => !item.ok)?.message ?? 'unknown error'),
    days: consensus.daily,
    hours: consensus.hours,
    verdict,
    health,
    sourceCount: sources.length,
    independentCount: sources.filter((source) => source.independent).length,
  };
}

async function fetchOpenMeteo(source, params) {
  const url = new URL(OPEN_METEO_BASE);
  url.searchParams.set('latitude', params.latitude);
  url.searchParams.set('longitude', params.longitude);
  url.searchParams.set('hourly', hourlyVariables);
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', params.timezone);
  if (params.startDate && params.endDate) {
    url.searchParams.set('start_date', params.startDate);
    url.searchParams.set('end_date', params.endDate);
  } else {
    url.searchParams.set('forecast_days', String(DEFAULT_FORECAST_DAYS));
  }
  if (source.model) url.searchParams.set('models', source.model);

  const data = await fetchJsonWithRetry(url.toString());
  if (!data.hourly?.time?.length) throw new Error('No hourly data returned');

  return {
    id: source.id,
    label: source.label,
    independent: source.independent,
    timezone: data.timezone,
    hours: data.hourly.time.map((time, index) => ({
      time,
      temperature: valueAt(data.hourly.temperature_2m, index),
      humidity: valueAt(data.hourly.relative_humidity_2m, index),
      apparentTemperature: valueAt(data.hourly.apparent_temperature, index),
      precipitationProbability: valueAt(data.hourly.precipitation_probability, index),
      precipitation: valueAt(data.hourly.precipitation, index),
      rain: valueAt(data.hourly.rain, index),
      showers: valueAt(data.hourly.showers, index),
      weatherCode: valueAt(data.hourly.weather_code, index),
      cloudCover: valueAt(data.hourly.cloud_cover, index),
      windSpeed: valueAt(data.hourly.wind_speed_10m, index),
      windGusts: valueAt(data.hourly.wind_gusts_10m, index),
    })),
  };
}

async function fetchEnvironmentCanada(params) {
  const bboxDelta = 0.4;
  const bbox = [
    params.longitude - bboxDelta,
    params.latitude - bboxDelta,
    params.longitude + bboxDelta,
    params.latitude + bboxDelta,
  ].join(',');
  const url = new URL(EC_CITY_PAGE);
  url.searchParams.set('f', 'json');
  url.searchParams.set('lang', 'en');
  url.searchParams.set('bbox', bbox);
  url.searchParams.set('limit', '10');

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const data = await response.json();
  const distanceTo = (item) => {
    const [lon, lat] = item.geometry?.coordinates ?? [];
    return typeof lon === 'number' && typeof lat === 'number'
      ? Math.hypot(lon - params.longitude, lat - params.latitude)
      : Infinity;
  };
  const feature = [...(data.features ?? [])].sort((a, b) => distanceTo(a) - distanceTo(b))[0];

  if (!feature) return null;
  const properties = feature.properties ?? {};
  const name = properties.name?.en ?? properties.name ?? properties.locationName ?? properties.city ?? 'nearby city';
  return { summary: `Fetched public city forecast item for ${typeof name === 'object' ? JSON.stringify(name) : name}` };
}

async function fetchJsonWithRetry(url, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response.json();
    // 429 (rate limit) and 5xx are transient — back off and retry.
    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt === attempts - 1) {
      // Open-Meteo explains rejections (e.g. dates out of range) in `reason`.
      const body = await response.json().catch(() => null);
      throw new Error(body?.reason ?? `${response.status} ${response.statusText}`);
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : (2 ** attempt) * 800 + Math.random() * 400;
    await delay(backoff);
  }
  throw new Error('Exhausted retries');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function valueAt(values, index) {
  const value = values?.[index];
  return typeof value === 'number' ? value : null;
}

function buildConsensus(sources) {
  const byHour = new Map();

  for (const source of sources) {
    for (const hour of source.hours) {
      const bucket = byHour.get(hour.time) ?? [];
      bucket.push({ ...hour, source: source.label, sourceId: source.id, independent: source.independent });
      byHour.set(hour.time, bucket);
    }
  }

  const hours = [...byHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, rows]) => scoreHour(time, rows));

  const dailyMap = new Map();
  for (const hour of hours) {
    const entry = dailyMap.get(hour.date) ?? { date: hour.date, hours: [] };
    entry.hours.push(hour);
    dailyMap.set(hour.date, entry);
  }

  return { hours, daily: [...dailyMap.values()].map(scoreDay) };
}

function scoreHour(time, rows) {
  const values = (key) => rows.map((row) => row[key]).filter(isNum);
  const avg = (key) => average(values(key));
  const max = (key) => maxValue(values(key));
  const min = (key) => minValue(values(key));
  const rainValues = values('precipitationProbability');
  const apparentValues = values('apparentTemperature');
  const stormVotes = rows.filter((row) => isStormCode(row.weatherCode)).length;
  const showerVotes = rows.filter((row) => isShowerCode(row.weatherCode)).length;
  const rainProb = average(rainValues);
  const precipitation = max('precipitation') ?? 0;
  const showers = max('showers') ?? 0;
  const apparent = avg('apparentTemperature');
  const humidity = avg('humidity');
  const windSpeed = avg('windSpeed');
  const windGusts = max('windGusts');
  const rainSpread = spread(rainValues);
  const rainStdDev = standardDeviation(rainValues);
  const apparentSpread = spread(apparentValues);
  const disagreement = Math.round(Math.min(100, (rainStdDev * 1.7) + (rainSpread * 0.45) + (apparentSpread * 1.8)));

  let score = 100;
  if (rainProb !== null) score -= rainProb * 0.48;
  score -= Math.min(35, precipitation * 900);
  score -= Math.min(25, showers * 900);
  // Saturating storm penalty: a thunderstorm signal is a real risk for that hour,
  // but extra agreeing models shouldn't stack linearly to a -60 wipeout —
  // especially when rain probability is modest. Caps near -38.
  score -= stormVotes > 0 ? Math.min(38, 16 + (stormVotes - 1) * 7) : 0;
  score -= showerVotes * 4;
  if (apparent !== null && apparent > 88) score -= (apparent - 88) * 3.2;
  if (apparent !== null && apparent > 82) score -= (apparent - 82) * 0.6;
  if (humidity !== null && humidity > 82) score -= (humidity - 82) * 0.18;
  if (windGusts !== null && windGusts > 24) score -= Math.min(14, (windGusts - 24) * 0.65);
  if (disagreement > 45) score -= 4;
  score = Math.round(Math.max(0, Math.min(100, score)));

  // Spread is measured across INDEPENDENT models only; the best_match blend is
  // reported separately so it cannot narrow the honest range.
  const independentRows = rows.filter((row) => row.independent);
  const indRain = independentRows.map((row) => row.precipitationProbability).filter(isNum);
  const indFeels = independentRows.map((row) => row.apparentTemperature).filter(isNum);
  const indGust = independentRows.map((row) => row.windGusts).filter(isNum);
  const blend = rows.find((row) => !row.independent) ?? null;

  const localHour = Number(time.slice(11, 13));
  return {
    time,
    date: time.slice(0, 10),
    hour: time.slice(11, 16),
    score,
    rating: ratingFor(score),
    label: labelFor(score),
    temperature: avg('temperature'),
    apparentTemperature: apparent,
    humidity,
    windSpeed,
    windGusts,
    rainSignal: rainProb ?? Math.min(100, Math.round((precipitation + showers) * 1000)),
    rainMin: min('precipitationProbability'),
    rainMax: max('precipitationProbability'),
    rainSpread,
    disagreement,
    agreement: confidenceFor(disagreement, rows.length),
    stormVotes,
    showerVotes,
    sourceCount: rows.length,
    independentCount: independentRows.length,
    sourceNames: [...new Set(rows.map((row) => row.source))],
    // Spread across independent models (excludes the best_match blend).
    // `n` is how many independent models actually reported that metric — some
    // models return nulls for some fields, so n can be < independentCount.
    spread: {
      rainProb: { min: minValue(indRain), max: maxValue(indRain), median: median(indRain), n: indRain.length },
      feels: { min: minValue(indFeels), max: maxValue(indFeels), median: median(indFeels), n: indFeels.length },
      gust: { min: minValue(indGust), max: maxValue(indGust), median: median(indGust), n: indGust.length },
    },
    blend: blend ? {
      apparentTemperature: blend.apparentTemperature,
      precipitationProbability: blend.precipitationProbability,
      windGusts: blend.windGusts,
      weatherCode: blend.weatherCode,
    } : null,
    models: rows.map((row) => ({
      id: row.sourceId,
      label: row.source,
      independent: row.independent,
      temperature: row.temperature,
      apparentTemperature: row.apparentTemperature,
      humidity: row.humidity,
      precipitationProbability: row.precipitationProbability,
      precipitation: row.precipitation,
      showers: row.showers,
      windGusts: row.windGusts,
      weatherCode: row.weatherCode,
    })),
    isDaytime: localHour >= 8 && localHour <= 21,
  };
}

function scoreDay(day) {
  const walkingHours = day.hours.filter((hour) => hour.isDaytime);
  const excellentHours = walkingHours.filter((hour) => hour.score >= 75);
  const goodHours = walkingHours.filter((hour) => hour.score >= 60);
  const excellentStretch = longestStretch(walkingHours, 75);
  const goodStretch = longestStretch(walkingHours, 60);
  const avgHourlyScore = average(walkingHours.map((hour) => hour.score)) ?? 0;
  // Weight toward the better half of the day: a day you can plan around (good
  // morning + good evening, stormy midday) should not score like a washout.
  const sortedScores = walkingHours.map((hour) => hour.score).sort((a, b) => b - a);
  const bestHalfAvg = average(sortedScores.slice(0, Math.ceil(sortedScores.length / 2))) ?? 0;
  const windowBonus = Math.min(35, (goodStretch ** 2) * 1.25 + (excellentStretch ** 2) * 0.85);
  // Two separate usable windows are fine; only lightly penalize scatter.
  const scatteredHoursPenalty = Math.max(0, goodHours.length - goodStretch) * 0.35;
  const avgDisagreement = average(walkingHours.map((hour) => hour.disagreement)) ?? 0;
  const confidencePenalty = avgDisagreement > 55 ? 8 : avgDisagreement > 35 ? 4 : 0;
  const dayScore = Math.round(Math.max(0, Math.min(100, (avgHourlyScore * 0.45) + (bestHalfAvg * 0.30) + windowBonus - scatteredHoursPenalty - confidencePenalty)));
  const maxFeels = Math.round(maxValue(walkingHours.map((hour) => hour.apparentTemperature).filter(Boolean)) ?? 0);
  const maxGust = Math.round(maxValue(walkingHours.map((hour) => hour.windGusts).filter(Boolean)) ?? 0);
  const avgHumidity = Math.round(average(walkingHours.map((hour) => hour.humidity).filter(Boolean)) ?? 0);
  const stormPeak = maxValue(walkingHours.map((hour) => hour.stormVotes)) ?? 0;
  const stormStart = firstHourAtOrAbove(walkingHours, (hour) => hour.stormVotes >= Math.ceil(hour.sourceCount / 2));
  const periods = buildDayPeriods(walkingHours);
  const bestExcellentWindow = bestWindow(walkingHours, 75);
  const bestGoodWindow = bestWindow(walkingHours, 60);

  return {
    date: day.date,
    avgScore: dayScore,
    rating: ratingFor(dayScore),
    label: labelFor(dayScore),
    excellentHours: excellentHours.length,
    goodHours: goodHours.length,
    excellentStretch,
    goodStretch,
    maxFeels,
    maxGust,
    avgHumidity,
    agreement: confidenceFor(avgDisagreement, walkingHours[0]?.sourceCount ?? 0),
    stormPeak,
    stormStart,
    periods,
    bestExcellentWindow,
    bestGoodWindow,
    planLine: planLineFor(periods, dayScore, goodStretch, stormStart),
  };
}

function planLineFor(periods, dayScore, goodStretch, stormStart) {
  const bestPeriod = [...periods].sort((a, b) => b.score - a.score)[0];
  const bestName = bestPeriod?.label.toLowerCase() ?? 'day';
  const parts = [`Strongest block: ${bestName} (${bestPeriod?.score ?? 0}/100)`];
  parts.push(goodStretch >= 1
    ? `longest comfortable stretch ${goodStretch}h`
    : 'no continuous comfortable stretch');
  if (stormStart) parts.push(`thunderstorm signal from ~${stormStart}`);
  return parts.join(' · ');
}

function buildDayPeriods(hours) {
  return [
    { label: 'Morning', start: 8, end: 12 },
    { label: 'Afternoon', start: 12, end: 17 },
    { label: 'Evening', start: 17, end: 22 },
  ].map((period) => {
    const periodHours = hours.filter((hour) => {
      const localHour = Number(hour.hour.slice(0, 2));
      return localHour >= period.start && localHour < period.end;
    });
    const score = Math.round(average(periodHours.map((hour) => hour.score)) ?? 0);
    return { ...period, score, rating: ratingFor(score) };
  });
}

function bestWindow(hours, minimumScore) {
  let current = [];
  let best = [];
  for (const hour of hours) {
    if (hour.score >= minimumScore) {
      current.push(hour);
      if (current.length > best.length) best = [...current];
    } else {
      current = [];
    }
  }
  if (!best.length) return null;
  const avgScore = Math.round(average(best.map((hour) => hour.score)) ?? 0);
  return {
    start: best[0].hour,
    end: addOneHourLabel(best.at(-1).hour),
    hours: best.length,
    avgScore,
    label: labelFor(avgScore),
  };
}

function addOneHourLabel(hourLabel) {
  const [hour] = hourLabel.split(':').map(Number);
  return `${String(Math.min(23, hour + 1)).padStart(2, '0')}:00`;
}

function longestStretch(hours, minimumScore) {
  let current = 0;
  let best = 0;
  for (const hour of hours) {
    if (hour.score >= minimumScore) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

function firstHourAtOrAbove(hours, predicate) {
  const match = hours.find(predicate);
  return match ? match.hour : null;
}

function isStormCode(code) {
  return [95, 96, 99].includes(code);
}

function isShowerCode(code) {
  return [80, 81, 82].includes(code);
}

export function weatherCodeLabel(code) {
  if (typeof code !== 'number') return '—';
  if (isStormCode(code)) return 'storm';
  if (isShowerCode(code)) return 'showers';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 61 && code <= 67) return 'rain';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code >= 45 && code <= 48) return 'fog';
  if (code === 3) return 'overcast';
  if (code === 2) return 'part cloud';
  if (code === 1) return 'mostly clear';
  if (code === 0) return 'clear';
  return `code ${code}`;
}

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

function average(values) {
  const filtered = values.filter(isNum);
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function maxValue(values) {
  const filtered = values.filter(isNum);
  if (!filtered.length) return null;
  return Math.max(...filtered);
}

function minValue(values) {
  const filtered = values.filter(isNum);
  if (!filtered.length) return null;
  return Math.min(...filtered);
}

function median(values) {
  const filtered = values.filter(isNum).sort((a, b) => a - b);
  if (!filtered.length) return null;
  const mid = Math.floor(filtered.length / 2);
  return filtered.length % 2 ? filtered[mid] : (filtered[mid - 1] + filtered[mid]) / 2;
}

function spread(values) {
  const min = minValue(values);
  const max = maxValue(values);
  return min === null || max === null ? 0 : max - min;
}

function standardDeviation(values) {
  const filtered = values.filter(isNum);
  if (filtered.length < 2) return 0;
  const mean = average(filtered);
  const variance = average(filtered.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

export function ratingFor(score) {
  if (score >= 75) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 42) return 'marginal';
  return 'poor';
}

export function labelFor(score) {
  if (score >= 75) return 'Favorable for outdoor time';
  if (score >= 60) return 'Generally comfortable';
  if (score >= 42) return 'Mixed / variable';
  return 'Unfavorable for outdoor time';
}

// "Model agreement" — how much the independent models diverge for this hour.
// Says nothing about whether the forecast is correct, only how converged the
// models are. Lower divergence = higher agreement.
export function confidenceFor(disagreement, sourceCount) {
  if (sourceCount < 3) return 'insufficient sources';
  if (disagreement <= 25) return 'high';
  if (disagreement <= 45) return 'medium';
  return 'low';
}

export function buildVerdict(days, sourceCount) {
  const favorableDays = days.filter((day) => day.avgScore >= 75).length;
  const comfortableDays = days.filter((day) => day.avgScore >= 60).length;
  const poorDays = days.filter((day) => day.avgScore < 42).length;
  const stormDays = days.filter((day) => day.stormPeak >= 3);
  const comfortableHours = days.reduce((sum, day) => sum + day.goodHours, 0);
  const favorableHours = days.reduce((sum, day) => sum + day.excellentHours, 0);
  const lowAgreementDays = days.filter((day) => day.agreement === 'low').length;
  const avgTripScore = Math.round(average(days.map((day) => day.avgScore)) ?? 0);

  // Neutral signal band — describes the data, does not prescribe a decision.
  let signal = 'mixed';
  if (avgTripScore >= 70 && stormDays.length === 0) signal = 'mostly favorable';
  else if (avgTripScore >= 60 && stormDays.length <= 1) signal = 'leaning favorable';
  else if (avgTripScore < 42 || stormDays.length >= 3) signal = 'mostly unfavorable';

  const facts = [
    `${comfortableHours} comfortable daytime hours (score ≥60) across the ${days.length} days.`,
    `${favorableDays} of ${days.length} days score favorable overall, ${comfortableDays} comfortable, ${poorDays} unfavorable.`,
    stormDays.length
      ? `Thunderstorm consensus (3+ models) on ${joinReadable(stormDays.map((day) => formatDate(day.date)))}.`
      : 'No day shows thunderstorm consensus across 3+ models.',
    lowAgreementDays
      ? `${lowAgreementDays} day(s) have low model agreement — those scores are uncertain.`
      : 'Model agreement is medium-to-high on every day.',
  ];

  return {
    signal,
    avgTripScore,
    favorableDays,
    comfortableDays,
    poorDays,
    favorableHours,
    comfortableHours,
    stormDays: stormDays.map((day) => day.date),
    lowAgreementDays,
    sourceCount,
    facts,
  };
}

export function joinReadable(items) {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

export function formatDate(date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T12:00:00`));
}

// ---- Dates ----------------------------------------------------------------

function toIsoDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ISO date `offset` days from today, in the runtime's local time.
export function daysFromToday(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return toIsoDate(date);
}

// Returns a human-readable problem with the date range, or null if it is fine.
// `slackDays` loosens the window for callers whose clock may be a day off from
// the location's (the Worker runs in UTC).
export function dateRangeProblem(startDate, endDate, slackDays = 0) {
  const isIso = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '');
  if (!isIso(startDate) || !isIso(endDate)) return 'pick a start and end date (YYYY-MM-DD)';
  if (endDate < startDate) return 'the end date is before the start date';
  const earliest = daysFromToday(-FORECAST_DAYS_BACK - slackDays);
  const latest = daysFromToday(FORECAST_DAYS_AHEAD + slackDays);
  if (startDate < earliest || endDate > latest) {
    return `forecast data is only available from ${daysFromToday(-FORECAST_DAYS_BACK)} to ${daysFromToday(FORECAST_DAYS_AHEAD)}; pick dates inside that range`;
  }
  return null;
}

// ---- Place search -----------------------------------------------------------

// Lets "Burlington, VT" match the geocoder's full region names.
const REGION_ABBREVIATIONS = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
  ct: 'connecticut', de: 'delaware', dc: 'district of columbia', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky',
  la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
  ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire',
  nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota',
  oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island',
  sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  ab: 'alberta', bc: 'british columbia', mb: 'manitoba', nb: 'new brunswick',
  nl: 'newfoundland and labrador', ns: 'nova scotia', nt: 'northwest territories', nu: 'nunavut',
  on: 'ontario', pe: 'prince edward island', qc: 'quebec', sk: 'saskatchewan', yt: 'yukon',
};

// "City" or "City, State/Province/Country" -> up to 8 matches, best first.
export async function geocode(text) {
  const [name, ...qualifiers] = String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!name) return [];
  const url = new URL(GEOCODING_BASE);
  url.searchParams.set('name', name);
  url.searchParams.set('count', '25');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Location search failed (${response.status})`);
  const data = await response.json();

  return (data.results ?? [])
    .filter((place) => qualifiers.every((qualifier) => matchesQualifier(place, qualifier)))
    .slice(0, 8)
    .map((place) => ({
      label: [place.name, place.admin1 === place.name ? null : place.admin1, place.country].filter(Boolean).join(', '),
      latitude: place.latitude,
      longitude: place.longitude,
    }));
}

export function normalizeText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function matchesQualifier(place, qualifier) {
  const wanted = normalizeText(qualifier).replaceAll('.', '');
  const expanded = REGION_ABBREVIATIONS[wanted];
  const region = normalizeText(place.admin1);
  const country = normalizeText(place.country);
  const countryCode = normalizeText(place.country_code);
  if (expanded && region === expanded) return true;
  if (wanted === countryCode || (wanted === 'usa' && countryCode === 'us') || (wanted === 'uk' && countryCode === 'gb')) return true;
  return wanted.length >= 3 && (region.startsWith(wanted) || country.startsWith(wanted));
}
