/**
 * Weather.gs — Open-Meteo client (port of weather/client.py), all free, no API key.
 *
 *   ZIP -> lat/lon : https://api.zippopotam.us/us/<zip>
 *   Near-term daily forecast : https://api.open-meteo.com/v1/forecast  (<=16 days)
 *   Climatology normals      : https://archive-api.open-meteo.com/v1/archive (5-yr avg)
 *
 * refreshWeather() stitches forecast (recent observed + future) across the cycle and
 * fills any day beyond the 16-day forecast horizon with calendar-day climatology.
 */

var ZIPPOPOTAM_URL = 'https://api.zippopotam.us/us/';
var OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
var OPEN_METEO_ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
var DAILY_TEMP_FIELDS = 'temperature_2m_max,temperature_2m_min';
var MAX_FORECAST_DAYS = 16;
var MAX_PAST_DAYS = 92;

/**
 * GET a URL with query params and parse JSON. Throws on non-2xx.
 * @param {string} url
 * @param {Object<string, (string|number)>} params
 * @return {Object}
 */
function httpJson_(url, params) {
  var query = '';
  if (params) {
    query = '?' + Object.keys(params).map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    }).join('&');
  }
  var response = UrlFetchApp.fetch(url + query, { muteHttpExceptions: true });
  var code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    logEvent_('http_request_failed', { url: url, status: code, fix_suggestion: 'Check ZIP/coords and Open-Meteo availability.' });
    throw new Error('HTTP ' + code + ' for ' + url);
  }
  return JSON.parse(response.getContentText());
}

/**
 * Resolve a US ZIP to coordinates via zippopotam.us.
 * @param {string} zipCode 5-digit US ZIP.
 * @return {{lat: number, lon: number, place: string, state: string, zip: string}}
 */
function geocodeZip_(zipCode) {
  var zip = String(zipCode).trim();
  var payload = httpJson_(ZIPPOPOTAM_URL + encodeURIComponent(zip), null);
  var places = payload.places || [];
  if (!places.length) throw new Error('ZIP code returned no places: ' + zip);
  var place = places[0];
  return {
    lat: parseFloat(place.latitude),
    lon: parseFloat(place.longitude),
    place: place['place name'] || '',
    state: place.state || '',
    zip: String(payload['post code'] || zip)
  };
}

/**
 * Unpack an Open-Meteo daily block into [{date, min, max}], skipping null rows.
 * @param {Object} data
 * @return {Array<{date: string, min: number, max: number}>}
 */
function unpackDaily_(data) {
  var daily = data.daily || {};
  var times = daily.time || [];
  var maxes = daily.temperature_2m_max || [];
  var mins = daily.temperature_2m_min || [];
  var rows = [];
  for (var i = 0; i < times.length; i++) {
    if (maxes[i] == null || mins[i] == null) continue;
    rows.push({ date: String(times[i]), min: Number(mins[i]), max: Number(maxes[i]) });
  }
  return rows;
}

/**
 * Near-term daily forecast (min/max °F). With pastDays>0 the response is prefixed
 * with recent observed/reanalysis days, used to regress against actual weather.
 * @param {number} lat
 * @param {number} lon
 * @param {number} days Forecast days (clamped to 16).
 * @param {number} pastDays Recent days to prepend (clamped to 92).
 * @return {Array<{date: string, min: number, max: number}>}
 */
function fetchForecast_(lat, lon, days, pastDays) {
  days = Math.max(1, Math.min(days, MAX_FORECAST_DAYS));
  pastDays = Math.max(0, Math.min(pastDays, MAX_PAST_DAYS));
  var data = httpJson_(OPEN_METEO_FORECAST_URL, {
    latitude: lat,
    longitude: lon,
    daily: DAILY_TEMP_FIELDS,
    forecast_days: days,
    past_days: pastDays,
    temperature_unit: 'fahrenheit',
    timezone: 'auto'
  });
  return unpackDaily_(data);
}

/**
 * Shift an ISO date to the same month/day in a given year (Feb 29 -> Feb 28).
 * @param {string} iso
 * @param {number} year
 * @return {string} ISO date.
 */
function shiftYearIso_(iso, year) {
  var p = parseISO_(iso);
  var d = new Date(Date.UTC(year, p.m - 1, p.d));
  if (d.getUTCMonth() !== p.m - 1) d = new Date(Date.UTC(year, p.m - 1, 28));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

/**
 * Per-calendar-day climatology normals from the Open-Meteo archive, averaged over
 * the last `lookbackYears` years for the calendar window the cycle covers.
 * @param {number} lat
 * @param {number} lon
 * @param {string} cycleStartIso
 * @param {number} numDays
 * @param {number} lookbackYears
 * @return {Object<string, {min: number, max: number}>} keyed by "MM-DD".
 */
function fetchClimatology_(lat, lon, cycleStartIso, numDays, lookbackYears) {
  var lastFullYear = Number(todayIso_().substring(0, 4)) - 1;
  var acc = {};
  for (var year = lastFullYear; year > lastFullYear - lookbackYears; year--) {
    var histStart = shiftYearIso_(cycleStartIso, year);
    var histEnd = isoAddDays_(histStart, numDays - 1);
    var data = httpJson_(OPEN_METEO_ARCHIVE_URL, {
      latitude: lat,
      longitude: lon,
      daily: DAILY_TEMP_FIELDS,
      start_date: histStart,
      end_date: histEnd,
      temperature_unit: 'fahrenheit',
      timezone: 'auto'
    });
    unpackDaily_(data).forEach(function (row) {
      var key = row.date.substring(5);
      if (!acc[key]) acc[key] = { minSum: 0, maxSum: 0, count: 0 };
      acc[key].minSum += row.min;
      acc[key].maxSum += row.max;
      acc[key].count += 1;
    });
  }
  var normals = {};
  Object.keys(acc).forEach(function (key) {
    var a = acc[key];
    normals[key] = { min: a.minSum / a.count, max: a.maxSum / a.count };
  });
  return normals;
}

/**
 * Fetch weather for the whole cycle and write the Weather tab.
 * Recent + near days = forecast; days beyond the 16-day horizon = climatology.
 * @return {number} number of cycle days written.
 */
function refreshWeather() {
  var cfg = readConfig_();
  var startIso = normalizeDateCell_(cfg.cycle_start);
  var nextReadIso = normalizeDateCell_(cfg.next_read);
  var dates = cycleDatesIso_(startIso, nextReadIso);
  var zip = String(cfg.zip || '').trim();
  if (!zip) {
    throw new Error('Config.zip is empty — set your 5-digit ZIP in the Config tab, then Refresh.');
  }
  var loc = geocodeZip_(zip);

  var today = todayIso_();
  var pastDays = Math.max(0, isoDiffDays_(startIso, today)) + 1;
  var cycleEndIso = dates[dates.length - 1];
  var forecastDays = Math.max(1, isoDiffDays_(today, cycleEndIso) + 1);

  var weatherMap = {};
  fetchForecast_(loc.lat, loc.lon, forecastDays, pastDays).forEach(function (row) {
    weatherMap[row.date] = { min: row.min, max: row.max, source: 'forecast' };
  });

  var missing = dates.filter(function (iso) { return !weatherMap[iso]; });
  if (missing.length) {
    var normals = fetchClimatology_(loc.lat, loc.lon, startIso, dates.length, 5);
    missing.forEach(function (iso) {
      var normal = normals[iso.substring(5)];
      if (normal) weatherMap[iso] = { min: normal.min, max: normal.max, source: 'climatology' };
    });
  }

  var coveredDates = dates.filter(function (iso) { return weatherMap[iso]; });
  var climatologyCount = coveredDates.filter(function (iso) { return weatherMap[iso].source === 'climatology'; }).length;
  var rows = coveredDates.map(function (iso) {
    var w = weatherMap[iso];
    return [iso, round1_(w.min), round1_(w.max), round1_((w.min + w.max) / 2), w.source];
  });
  writeTable_('Weather', ['date', 'temp_min_f', 'temp_max_f', 'mean_temp_f', 'source'], rows);

  logEvent_('refresh_weather_completed', {
    location: loc.place + ', ' + loc.state + ' ' + loc.zip,
    days_written: rows.length,
    climatology_filled: climatologyCount
  });
  return rows.length;
}
