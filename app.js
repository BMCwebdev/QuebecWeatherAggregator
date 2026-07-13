const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
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

$('#refreshButton').addEventListener('click', () => {
  fetchAndRender().catch((error) => {
    $('#status').textContent = `Could not build forecast: ${error.message}`;
    $('#refreshButton').disabled = false;
  });
});

$('#exportButton')?.addEventListener('click', () => exportCsv(latestHours));

async function fetchAndRender() {
  const button = $('#refreshButton');
  button.disabled = true;
  $('#status').textContent = 'Fetching public forecast sources…';

  const params = getControls();
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

  if (environmentCanadaResult.status === 'fulfilled') {
    health.push({ label: 'Environment Canada city page', ok: true, message: environmentCanadaResult.value.summary });
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
  $('#status').textContent = `Updated ${new Date().toLocaleString()}. Aggregated ${usableSources} model source${usableSources === 1 ? '' : 's'} from Open-Meteo, plus Environment Canada source health. Extra models may fail gracefully if a provider does not cover the selected dates or variables.`;
  button.disabled = false;
}

function getControls() {
  return {
    latitude: Number($('#latitude').value),
    longitude: Number($('#longitude').value),
    startDate: $('#startDate').value,
    endDate: $('#endDate').value,
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
  url.searchParams.set('timezone', 'America/Toronto');
  url.searchParams.set('start_date', params.startDate);
  url.searchParams.set('end_date', params.endDate);
  if (source.model) url.searchParams.set('models', source.model);

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
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
  const feature = data.features?.find((item) => {
    const properties = item.properties ?? {};
    return JSON.stringify(properties).toLowerCase().includes('québec') ||
      JSON.stringify(properties).toLowerCase().includes('quebec');
  }) ?? data.features?.[0];

  if (!feature) throw new Error('No nearby city page item returned');
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
  link.download = 'quebec-weather-consensus.csv';
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
