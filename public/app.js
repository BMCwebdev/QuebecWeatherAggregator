import {
  buildForecast,
  dateRangeProblem,
  daysFromToday,
  geocode,
  normalizeText,
  weatherCodeLabel,
  formatDate,
  joinReadable,
  DEFAULTS,
  FORECAST_DAYS_BACK,
  FORECAST_DAYS_AHEAD,
} from './consensus.js';

const $ = (selector) => document.querySelector(selector);
let latestHours = [];
let latestPayload = null;

let locationLabel = DEFAULTS.label;
let locationNeedsLookup = false;
let suggestionItems = [];
let activeSuggestion = -1;
let suggestionTimer = null;
let suggestionRequest = 0;

initDates();
initLocationControls();

$('#refreshButton').addEventListener('click', refresh);
$('#exportButton')?.addEventListener('click', () => exportCsv(latestHours));
$('#exportJsonButton')?.addEventListener('click', () => exportJson());
refresh();

function refresh() {
  $('#status').classList.remove('error');
  fetchAndRender().catch((error) => {
    $('#status').textContent = `Could not build forecast: ${error.message}`;
    $('#status').classList.add('error');
    $('#refreshButton').disabled = false;
  });
}

async function fetchAndRender() {
  const button = $('#refreshButton');
  button.disabled = true;
  $('#status').textContent = 'Fetching public forecast sources…';

  const params = await getControls();
  const forecast = await buildForecast(params);
  if (!forecast.sourceCount) {
    throw new Error(`no forecast source returned data (${forecast.failureReason})`);
  }
  latestHours = forecast.hours.filter((hour) => hour.isDaytime);

  renderVerdict(forecast.verdict);
  renderSummary(forecast.days);
  renderInsights(forecast.days);
  renderHourly(forecast.hours);
  renderHealth(forecast.health);
  exposeForAgents(forecast);
  updateAgentLinks(forecast.params);

  const usableSources = forecast.sourceCount;
  const hasRegionalSource = forecast.health.some((item) => item.id === 'environment_canada');
  $('#status').textContent = `Updated ${new Date().toLocaleString()} for ${forecast.params.label}. Aggregated ${usableSources} model source${usableSources === 1 ? '' : 's'} from Open-Meteo (${forecast.independentCount} independent)${hasRegionalSource ? ', plus Environment Canada source health' : ''}. Times are local to the location (${forecast.params.timezone}).`;
  button.disabled = false;
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
  const problem = dateRangeProblem(startDate, endDate);
  if (problem) throw new Error(problem);

  return { latitude, longitude, startDate, endDate, label: locationLabel };
}

function renderVerdict(verdict) {
  const panel = $('#verdict');
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="verdictHead">
      <div>
        <p class="eyebrow">Decision summary · data signal</p>
        <h2>Outlook: ${verdict.signal} <span class="verdictScore">${verdict.avgTripScore}/100 avg</span></h2>
      </div>
      <p class="verdictNote">Aggregated from ${verdict.sourceCount} model source${verdict.sourceCount === 1 ? '' : 's'}. This is a neutral read of the data, not a recommendation.</p>
    </div>
    <ul class="verdictFacts">
      ${verdict.facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join('')}
    </ul>
  `;
}

function exposeForAgents(forecast) {
  latestPayload = buildAgentPayload(forecast);
  window.__WEATHER_FORECAST__ = latestPayload;
  const tag = document.getElementById('forecastData');
  if (tag) tag.textContent = JSON.stringify(latestPayload);
}

// Mirror of the Worker's full payload, so the browser export and the
// server-side /forecast.json stay structurally identical.
function buildAgentPayload(forecast) {
  return {
    generatedAt: new Date().toISOString(),
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
    note: 'Outdoor comfort score (0-100) and model agreement are heuristics. See /llms.txt for methodology. Values are decision inputs, not recommendations.',
    verdict: forecast.verdict,
    days: forecast.days,
    hours: forecast.hours.filter((hour) => hour.isDaytime),
    sourceHealth: forecast.health,
  };
}

// Point the "For AI agents" links at the forecast currently on screen.
function updateAgentLinks(params) {
  const query = new URLSearchParams({
    lat: params.latitude,
    lon: params.longitude,
    start: params.startDate,
    end: params.endDate,
  }).toString();
  for (const link of document.querySelectorAll('[data-forecast-link]')) {
    link.href = `${link.dataset.forecastLink}?${query}`;
  }
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
        <strong>${day.excellentHours}</strong> favorable hours (score ≥75)<br />
        <strong>${day.goodHours}</strong> comfortable hours (score ≥60)<br />
        Longest favorable stretch: <strong>${day.excellentStretch}h</strong><br />
        Longest comfortable stretch: <strong>${day.goodStretch}h</strong><br />
        Model agreement: <strong>${day.agreement}</strong><br />
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
    humidDays.length ? `Higher humidity on ${joinReadable(humidDays)}.` : 'Humidity is not a dominant constraint in the daytime rows.',
    stormyDays.length ? `Thunderstorm consensus is highest on ${joinReadable(stormyDays)}.` : 'No strong thunderstorm consensus in the daytime rows.',
    dryDays.length ? `${joinReadable(dryDays)} carry the cleanest outdoor signal.` : 'No day reads as fully settled across the models.',
  ].map((text) => `<li>${escapeHtml(text)}</li>`).join('');
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
      <td>${hour.agreement}<br /><span class="subtle">spread ${formatNumber(hour.rainSpread)} pts</span></td>
      <td><details class="sourceDetails"><summary>${hour.sourceCount} models</summary>
        <table class="modelBreakdown">
          <thead><tr><th>Model</th><th>Feels</th><th>Rain</th><th>Gust</th><th>Sky</th></tr></thead>
          <tbody>
            ${hour.models.map((model) => `
              <tr class="${model.independent ? '' : 'blendRow'}">
                <td>${escapeHtml(model.label)}${model.independent ? '' : ' <span class="subtle">(blend)</span>'}</td>
                <td>${formatNumber(model.apparentTemperature)}°</td>
                <td>${formatNumber(model.precipitationProbability)}%</td>
                <td>${formatNumber(model.windGusts)}</td>
                <td>${weatherCodeLabel(model.weatherCode)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </details></td>
    </tr>
  `).join('');
}

function renderHealth(items) {
  $('#sourceHealth').innerHTML = items.map((item) => `
    <li>
      <strong>${item.ok ? 'OK' : 'Failed'} — ${escapeHtml(item.label)}:</strong>
      ${escapeHtml(item.message)}
    </li>
  `).join('');
}

function exportCsv(hours) {
  if (!hours.length) return;
  const headers = ['date', 'hour', 'score', 'label', 'temp_f', 'feels_f', 'humidity_pct', 'wind_gust_mph', 'rain_signal_pct', 'rain_min_pct', 'rain_max_pct', 'storm_votes', 'source_count', 'model_agreement'];
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
    hour.agreement,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
  downloadBlob(csv, 'text/csv;charset=utf-8', `${fileSlug()}-weather-consensus.csv`);
}

function exportJson() {
  if (!latestPayload) return;
  downloadBlob(JSON.stringify(latestPayload, null, 2), 'application/json;charset=utf-8', `${fileSlug()}-weather-consensus.json`);
}

function fileSlug() {
  return normalizeText(locationLabel.split(',')[0]).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'location';
}

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
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
