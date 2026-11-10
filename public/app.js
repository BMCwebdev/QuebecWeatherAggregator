const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_BASE = 'https://geocoding-api.open-meteo.com/v1/search';
const EC_CITY_PAGE = 'https://api.weather.gc.ca/collections/citypageweather-realtime/items';

const OPEN_METEO_SOURCES = [
  { id: 'best_match', label: 'Open-Meteo best match', model: null },
  { id: 'ecmwf_ifs025', label: 'ECMWF IFS 0.25°', model: 'ecmwf_ifs025' },
  { id: 'gfs_global', label: 'NOAA GFS Global', model: 'gfs_global' },
  { id: 'gem_global', label: 'Canadian GEM Global', model: 'gem_global' },
  { id: 'icon_global', label: 'DWD ICON Global', model: 'icon_global' },
  { id: 'ecmwf_aifs025', label: 'ECMWF AIFS 0.25°', model: 'ecmwf_aifs025' },
  { id: 'gfs_graphcast025', label: 'NOAA GraphCast 0.25°', model: 'gfs_graphcast025' },
  { id: 'ukmo_global', label: 'UKMO Global 10 km', model: 'ukmo_global_deterministic_10km' },
  { id: 'arpege_world', label: 'Météo-France ARPEGE World', model: 'meteofrance_arpege_world' },
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

const $ = (selector) => document.querySelector(selector);
let latestHours = [];

// Open-Meteo's forecast endpoint only serves a rolling window around today.
const FORECAST_DAYS_BACK = 92;
const FORECAST_DAYS_AHEAD = 15;

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

let locationLabel = 'Québec, Quebec, Canada';
let locationNeedsLookup = false;
let suggestionItems = [];
let activeSuggestion = -1;
let suggestionTimer = null;
let suggestionRequest = 0;

initDates();
initLocationControls();

$('#refreshButton').addEventListener('click', refresh);
refresh();

function refresh() {
  $('#status').classList.remove('error');
  fetchAndRender().catch((error) => {
    $('#status').textContent = `Could not build forecast: ${error.message}`;
    $('#status').classList.add('error');
    $('#refreshButton').disabled = false;
  });
}

$('#exportButton')?.addEventListener('click', () => exportCsv(latestHours));

async function fetchAndRender() {
  const button = $('#refreshButton');
  button.disabled = true;
  $('#status').textContent = 'Fetching public forecast sources…';

  const params = await getControls();
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
      health.push({ label: source.label, ok: true, message: `${result.value.hours.length} hourly rows` });
    } else {
      health.push({ label: source.label, ok: false, message: result.reason.message });
    }
  }

  // Regional source: only reported when the location has a nearby Canadian city page.
  const hasRegionalSource = environmentCanadaResult.status === 'rejected' || environmentCanadaResult.value !== null;
  if (environmentCanadaResult.status === 'fulfilled') {
    if (environmentCanadaResult.value) {
      health.push({ label: 'Environment Canada city page', ok: true, message: environmentCanadaResult.value.summary });
    }
  } else {
    health.push({ label: 'Environment Canada city page', ok: false, message: environmentCanadaResult.reason.message });
  }

  const consensus = buildConsensus(sources);
  latestHours = consensus.hours.filter((hour) => hour.isDaytime);

  renderSummary(consensus.daily);
  renderInsights(consensus.daily);
  renderHourly(consensus.hours);
  renderHealth(health);

  const usableSources = sources.length;
  if (!usableSources) {
    const reason = health.find((item) => !item.ok)?.message ?? 'unknown error';
    throw new Error(`no forecast source returned data (${reason})`);
  }
  $('#status').textContent = `Updated ${new Date().toLocaleString()} for ${params.label}. Aggregated ${usableSources} model source${usableSources === 1 ? '' : 's'} from Open-Meteo${hasRegionalSource ? ', plus Environment Canada source health' : ''}. Extra models may fail gracefully if a provider does not cover the selected dates or variables.`;
  button.disabled = false;
}

function toDateInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysFromToday(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return toDateInputValue(date);
}

function initDates() {
  const start = $('#startDate');
  const end = $('#endDate');
  start.value = daysFromToday(0);
  end.value = daysFromToday(1);
  for (const input of [start, end]) {
    input.min = daysFromToday(-FORECAST_DAYS_BACK);
    input.max = daysFromToday(FORECAST_DAYS_AHEAD);
  }
  start.addEventListener('change', () => {
    if (start.value && end.value < start.value) end.value = start.value;
  });
}

function initLocationControls() {
  const input = $('#locationInput');

  input.addEventListener('input', () => {
    locationNeedsLookup = true;
    clearTimeout(suggestionTimer);
    const query = input.value.trim();
    if (query.length < 2) return hideSuggestions();
    suggestionTimer = setTimeout(async () => {
      const request = ++suggestionRequest;
      try {
        const results = await geocode(query);
        if (request === suggestionRequest && locationNeedsLookup) showSuggestions(results);
      } catch {
        hideSuggestions();
      }
    }, 250);
  });

  input.addEventListener('keydown', (event) => {
    const open = !$('#locationSuggestions').hidden;
    if (event.key === 'ArrowDown' && open) {
      event.preventDefault();
      setActiveSuggestion((activeSuggestion + 1) % suggestionItems.length);
    } else if (event.key === 'ArrowUp' && open) {
      event.preventDefault();
      setActiveSuggestion((activeSuggestion - 1 + suggestionItems.length) % suggestionItems.length);
    } else if (event.key === 'Escape') {
      hideSuggestions();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (open && activeSuggestion >= 0) selectLocation(suggestionItems[activeSuggestion]);
      else hideSuggestions();
      refresh();
    }
  });

  input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));

  for (const id of ['#latitude', '#longitude']) {
    $(id).addEventListener('input', () => {
      locationNeedsLookup = false;
      locationLabel = `${$('#latitude').value}, ${$('#longitude').value}`;
      setResolved(`Using custom coordinates (${locationLabel})`);
      updateTitle();
    });
  }
}

async function geocode(text) {
  const [name, ...qualifiers] = text.split(',').map((part) => part.trim()).filter(Boolean);
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

function normalizeText(value) {
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

function showSuggestions(items) {
  const list = $('#locationSuggestions');
  suggestionItems = items;
  activeSuggestion = -1;
  if (!items.length) {
    list.innerHTML = '<li aria-disabled="true">No matching places</li>';
  } else {
    list.innerHTML = items.map((item, index) => `
      <li role="option" id="suggestion-${index}" data-index="${index}" aria-selected="false">${escapeHtml(item.label)}</li>
    `).join('');
    for (const option of list.querySelectorAll('[data-index]')) {
      // mousedown fires before the input's blur hides the list
      option.addEventListener('mousedown', (event) => {
        event.preventDefault();
        selectLocation(suggestionItems[Number(option.dataset.index)]);
        refresh();
      });
    }
  }
  list.hidden = false;
  $('#locationInput').setAttribute('aria-expanded', 'true');
}

function setActiveSuggestion(index) {
  if (!suggestionItems.length) return;
  activeSuggestion = index;
  for (const option of $('#locationSuggestions').querySelectorAll('[data-index]')) {
    option.setAttribute('aria-selected', String(Number(option.dataset.index) === index));
  }
  $('#locationInput').setAttribute('aria-activedescendant', `suggestion-${index}`);
}

function hideSuggestions() {
  clearTimeout(suggestionTimer);
  suggestionRequest += 1;
  suggestionItems = [];
  activeSuggestion = -1;
  $('#locationSuggestions').hidden = true;
  $('#locationInput').setAttribute('aria-expanded', 'false');
  $('#locationInput').removeAttribute('aria-activedescendant');
}

function selectLocation(place) {
  $('#locationInput').value = place.label;
  $('#latitude').value = place.latitude.toFixed(4);
  $('#longitude').value = place.longitude.toFixed(4);
  locationLabel = place.label;
  locationNeedsLookup = false;
  setResolved(`${place.label} (${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)})`);
  hideSuggestions();
  updateTitle();
}

function updateTitle() {
  document.title = `${locationLabel.split(',')[0]} · Weather Aggregator`;
}

function setResolved(text, isError = false) {
  const resolved = $('#locationResolved');
  resolved.textContent = text;
  resolved.classList.toggle('error', isError);
}

async function getControls() {
  if (locationNeedsLookup) {
    const query = $('#locationInput').value.trim();
    const [match] = query ? await geocode(query) : [];
    if (!match) {
      setResolved(`No place found for “${query}”. Try “City, State”.`, true);
      throw new Error(`could not find a place called “${query}”`);
    }
    selectLocation(match);
  }

  const latitude = Number($('#latitude').value);
  const longitude = Number($('#longitude').value);
  const startDate = $('#startDate').value;
  const endDate = $('#endDate').value;

  if ($('#latitude').value === '' || $('#longitude').value === '' || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new Error('latitude must be between -90 and 90 and longitude between -180 and 180');
  }
  if (!startDate || !endDate) throw new Error('pick a start and end date');
  if (endDate < startDate) throw new Error('the end date is before the start date');
  const earliest = daysFromToday(-FORECAST_DAYS_BACK);
  const latest = daysFromToday(FORECAST_DAYS_AHEAD);
  if (startDate < earliest || endDate > latest) {
    throw new Error(`forecast data is only available from ${earliest} to ${latest}; pick dates inside that range`);
  }

  return { latitude, longitude, startDate, endDate, label: locationLabel };
}

async function fetchOpenMeteo(source, params) {
  const url = new URL(OPEN_METEO_BASE);
  url.searchParams.set('latitude', params.latitude);
  url.searchParams.set('longitude', params.longitude);
  url.searchParams.set('hourly', hourlyVariables);
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('start_date', params.startDate);
  url.searchParams.set('end_date', params.endDate);
  if (source.model) url.searchParams.set('models', source.model);

  // Open-Meteo rate-limits bursts of parallel requests; back off and retry.
  let response = await fetch(url.toString());
  for (let attempt = 1; response.status === 429 && attempt <= 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    response = await fetch(url.toString());
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.reason ?? `${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (!data.hourly?.time?.length) throw new Error('No hourly data returned');

  return {
    id: source.id,
    label: source.label,
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

function valueAt(values, index) {
  const value = values?.[index];
  return typeof value === 'number' ? value : null;
}

function buildConsensus(sources) {
  const byHour = new Map();

  for (const source of sources) {
    for (const hour of source.hours) {
      const bucket = byHour.get(hour.time) ?? [];
      bucket.push({ ...hour, source: source.label });
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
  const values = (key) => rows.map((row) => row[key]).filter((value) => typeof value === 'number');
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
  score -= stormVotes * 15;
  score -= showerVotes * 4;
  if (apparent !== null && apparent > 88) score -= (apparent - 88) * 3.2;
  if (apparent !== null && apparent > 82) score -= (apparent - 82) * 0.6;
  if (humidity !== null && humidity > 82) score -= (humidity - 82) * 0.18;
  if (windGusts !== null && windGusts > 24) score -= Math.min(14, (windGusts - 24) * 0.65);
  if (disagreement > 45) score -= 4;
  score = Math.round(Math.max(0, Math.min(100, score)));

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
    confidence: confidenceFor(disagreement, rows.length),
    stormVotes,
    showerVotes,
    sourceCount: rows.length,
    sourceNames: [...new Set(rows.map((row) => row.source))],
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
  const windowBonus = Math.min(35, (goodStretch ** 2) * 1.25 + (excellentStretch ** 2) * 0.85);
  const scatteredHoursPenalty = Math.max(0, goodHours.length - goodStretch) * 0.6;
  const avgDisagreement = average(walkingHours.map((hour) => hour.disagreement)) ?? 0;
  const confidencePenalty = avgDisagreement > 55 ? 8 : avgDisagreement > 35 ? 4 : 0;
  const dayScore = Math.round(Math.max(0, Math.min(100, (avgHourlyScore * 0.68) + windowBonus - scatteredHoursPenalty - confidencePenalty)));
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
    confidence: confidenceFor(avgDisagreement, walkingHours[0]?.sourceCount ?? 0),
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

  if (dayScore >= 75 && goodStretch >= 6) return 'Best plan: treat this as your main open-air sightseeing day.';
  if (goodStretch >= 4) return `Best plan: prioritize the ${bestName}; ${stormStart ? `watch radar after ${stormStart}.` : 'keep a light backup plan.'}`;
  if (bestPeriod?.score >= 60) return `Best plan: use the ${bestName} as your main outdoor window and avoid overcommitting.`;
  return `Best plan: keep this flexible; the ${bestName} is the least-bad outdoor window.`;
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

function average(values) {
  const filtered = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function maxValue(values) {
  const filtered = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!filtered.length) return null;
  return Math.max(...filtered);
}

function minValue(values) {
  const filtered = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!filtered.length) return null;
  return Math.min(...filtered);
}

function spread(values) {
  const min = minValue(values);
  const max = maxValue(values);
  return min === null || max === null ? 0 : max - min;
}

function standardDeviation(values) {
  const filtered = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (filtered.length < 2) return 0;
  const mean = average(filtered);
  const variance = average(filtered.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function ratingFor(score) {
  if (score >= 75) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 42) return 'marginal';
  return 'poor';
}

function labelFor(score) {
  if (score >= 75) return 'Excellent sightseeing';
  if (score >= 60) return 'Comfortable walking';
  if (score >= 42) return 'Watch radar';
  return 'Indoor recommended';
}

function confidenceFor(disagreement, sourceCount) {
  if (sourceCount < 3) return 'low source count';
  if (disagreement <= 25) return 'high';
  if (disagreement <= 45) return 'medium';
  return 'low';
}

function renderSummary(days) {
  $('#summaryGrid').innerHTML = days.map((day) => `
    <article class="dayCard ${day.rating}">
      <h3>${formatDate(day.date)}</h3>
      <div class="score">${day.avgScore}/100</div>
      <div class="dayLabel">${day.label}</div>
      <div class="periodBars" aria-label="Day shape">
        ${day.periods.map((period) => `
          <div class="periodRow">
            <span>${period.label}</span>
            <meter min="0" max="100" low="42" high="75" optimum="90" value="${period.score}"></meter>
            <strong>${period.score}</strong>
          </div>
        `).join('')}
      </div>
      <p class="planLine"><strong>${day.planLine}</strong></p>
      <div class="meta">
        <strong>${day.excellentHours}</strong> excellent sightseeing hours<br />
        <strong>${day.goodHours}</strong> comfortable walking hours<br />
        Best excellent stretch: <strong>${day.excellentStretch}h</strong><br />
        Best comfortable stretch: <strong>${day.goodStretch}h</strong><br />
        Model confidence: <strong>${day.confidence}</strong><br />
        Storm consensus peak: <strong>${day.stormPeak || 0}</strong> models${day.stormStart ? `, starts around <strong>${day.stormStart}</strong>` : ''}<br />
        Max feels-like: <strong>${day.maxFeels || '—'}°F</strong><br />
        Max gust: <strong>${day.maxGust || '—'} mph</strong><br />
        Avg humidity: <strong>${day.avgHumidity || '—'}%</strong>
      </div>
    </article>
  `).join('');
}

function renderInsights(days) {
  const windows = days
    .flatMap((day) => [
      day.bestExcellentWindow ? { date: day.date, ...day.bestExcellentWindow } : null,
      !day.bestExcellentWindow && day.bestGoodWindow ? { date: day.date, ...day.bestGoodWindow } : null,
    ])
    .filter(Boolean)
    .sort((a, b) => b.hours - a.hours || b.avgScore - a.avgScore)
    .slice(0, 6);

  const stormyDays = days
    .filter((day) => day.stormPeak >= 3)
    .map((day) => `${formatDate(day.date)} around ${day.stormStart ?? 'the afternoon/evening'}`);
  const humidDays = days.filter((day) => day.avgHumidity >= 80).map((day) => formatDate(day.date));
  const dryDays = days.filter((day) => day.stormPeak === 0 && day.avgScore >= 70).map((day) => formatDate(day.date));

  $('#bestWindows').innerHTML = windows.length ? windows.map((window) => `
    <li>
      <strong>${formatDate(window.date)}</strong>
      <span>${window.start}–${window.end}</span>
      <em>${window.label} · ${window.hours}h</em>
    </li>
  `).join('') : '<li>No long clean windows found yet.</li>';

  $('#modelAgreement').innerHTML = [
    humidDays.length ? `High humidity signal on ${joinReadable(humidDays)}.` : 'Humidity does not look like the dominant constraint.',
    stormyDays.length ? `Thunderstorm consensus is highest on ${joinReadable(stormyDays)}.` : 'No strong thunderstorm consensus in the daytime rows.',
    dryDays.length ? `${joinReadable(dryDays)} looks like the cleanest outdoor candidate.` : 'No day is clean enough to treat as fully settled yet.',
  ].map((text) => `<li>${text}</li>`).join('');
}

function renderHourly(hours) {
  const rows = hours.filter((hour) => hour.isDaytime);
  $('#hourlyTable tbody').innerHTML = rows.map((hour) => `
    <tr class="${hour.rating}">
      <td>${formatDate(hour.date)}</td>
      <td>${hour.hour}</td>
      <td><strong>${hour.score}</strong>/100<br /><span class="subtle">${hour.label}</span></td>
      <td>${formatNumber(hour.temperature)}°F</td>
      <td>${formatNumber(hour.apparentTemperature)}°F</td>
      <td>${formatNumber(hour.humidity)}%</td>
      <td>${formatNumber(hour.windGusts)} mph</td>
      <td>${formatNumber(hour.rainSignal)}%<br /><span class="subtle">range ${formatNumber(hour.rainMin)}–${formatNumber(hour.rainMax)}%</span></td>
      <td>${hour.stormVotes}/${hour.sourceCount}</td>
      <td>${hour.confidence}<br /><span class="subtle">spread ${formatNumber(hour.rainSpread)} pts</span></td>
      <td><details class="sourceDetails"><summary>${hour.sourceCount} models</summary><div>${hour.sourceNames.join('<br />')}</div></details></td>
    </tr>
  `).join('');
}

function renderHealth(items) {
  $('#sourceHealth').innerHTML = items.map((item) => `
    <li>
      <strong>${item.ok ? 'OK' : 'Failed'} — ${item.label}:</strong>
      ${escapeHtml(item.message)}
    </li>
  `).join('');
}

function exportCsv(hours) {
  if (!hours.length) return;
  const headers = ['date', 'hour', 'score', 'label', 'temp_f', 'feels_f', 'humidity_pct', 'wind_gust_mph', 'rain_signal_pct', 'rain_min_pct', 'rain_max_pct', 'storm_votes', 'source_count', 'confidence'];
  const rows = hours.map((hour) => [
    hour.date,
    hour.hour,
    hour.score,
    hour.label,
    formatNumber(hour.temperature),
    formatNumber(hour.apparentTemperature),
    formatNumber(hour.humidity),
    formatNumber(hour.windGusts),
    formatNumber(hour.rainSignal),
    formatNumber(hour.rainMin),
    formatNumber(hour.rainMax),
    hour.stormVotes,
    hour.sourceCount,
    hour.confidence,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const slug = normalizeText(locationLabel.split(',')[0]).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'location';
  link.download = `${slug}-weather-consensus.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function joinReadable(items) {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T12:00:00`));
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : '—';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
