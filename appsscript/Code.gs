/**
 * Code.gs — entry points + shared helpers for the Electricity Dashboard.
 *
 * Web app:   doGet -> Index.html (graph-first, read-only, anonymous access).
 * Pipeline:  runDailyUpdate -> importUsageFromGmail -> refreshWeather -> computeProjection
 *            (runs on a daily time trigger; also from the ⚡ Electricity sheet menu).
 * Storage:   tabs Config, DailyUsage, Weather, Projection, Summary on the bound Sheet.
 */

// ─── Entry points ──────────────────────────────────────────────────────────

/**
 * Serve the dashboard HTML to anyone with the link.
 * @return {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Electricity Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Add the sheet menu when the spreadsheet opens. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚡ Electricity')
    .addItem('Refresh now', 'runDailyUpdate')
    .addItem('Run setup', 'setup')
    .addToUi();
}

/**
 * One-time setup: create tabs + headers, seed Config (only if empty), set the
 * spreadsheet timezone, and install the daily trigger. Safe to re-run.
 */
function setup() {
  getSpreadsheet_().setSpreadsheetTimeZone('America/Chicago');
  ensureInitialized_();
  installDailyTrigger_();
  logEvent_('setup_completed', {});
  try { getSpreadsheet_().toast('Setup complete. Use ⚡ Electricity → Refresh now.', 'Electricity Dashboard', 5); } catch (e) {}
}

/**
 * Create the tabs + headers and seed Config with defaults if it is empty.
 * Idempotent and safe to call on every run, so "Refresh now" works even if
 * setup() was never run explicitly.
 */
function ensureInitialized_() {
  var ss = getSpreadsheet_();
  var config = ss.getSheetByName('Config') || ss.insertSheet('Config');
  config.getRange('A:B').setNumberFormat('@');  // keep dates/zip as plain text
  if (config.getLastRow() < 2) {
    writeKeyValues_('Config', {
      zip: '77080',
      cycle_start: '2026-05-11',
      next_read: '2026-06-10',
      threshold_kwh: 1000,
      credit_usd: 125,
      cdd_base_f: 65
    });
  }
  ensureTab_('DailyUsage', ['service_date', 'total_kwh', 'source']);
  ensureTab_('Weather', ['date', 'temp_min_f', 'temp_max_f', 'mean_temp_f', 'source']);
  ensureTab_('Projection', ['date', 'mean_temp_f', 'cdd', 'actual_kwh', 'predicted_kwh', 'used_kwh', 'cumulative_kwh', 'day_type']);
  if (!ss.getSheetByName('Summary')) ss.insertSheet('Summary');
}

/**
 * Full pipeline: import usage from Gmail, refresh weather, recompute projection.
 * Trigger target and menu action. Fails loud so errors surface in the log.
 */
function runDailyUpdate() {
  try {
    ensureInitialized_();
    var importedDays = importUsageFromGmail();
    var weatherDays = refreshWeather();
    var summary = computeProjection();
    logEvent_('daily_update_completed', {
      imported_days: importedDays, weather_days: weatherDays,
      projected_total_kwh: summary.projected_total_kwh, verdict: summary.verdict
    });
    try {
      getSpreadsheet_().toast(summary.projected_total_kwh + ' kWh — ' + summary.verdict, 'Electricity Dashboard', 5);
    } catch (e) {}
    return summary;
  } catch (err) {
    logEvent_('daily_update_failed', {
      error_message: String(err && err.message ? err.message : err),
      fix_suggestion: 'Check Config (zip/dates), Gmail access, and Open-Meteo reachability.'
    });
    throw err;
  }
}

/**
 * Read Summary + Projection for the web app and shape the chart series.
 * Actual cumulative stops at the last metered day; projected cumulative starts
 * there (bridged) and runs to cycle end so the two lines connect.
 * @return {Object} dashboard payload for Index.html.
 */
function getDashboardData() {
  var summary = readKeyValues_('Summary');
  var config = readConfig_();
  var projection = readTable_('Projection');

  var labels = [], actual = [], projected = [];
  var lastActualIndex = -1;
  projection.rows.forEach(function (row, i) {
    labels.push(formatLabel_(normalizeDateCell_(row.date)));
    var cumulative = (row.cumulative_kwh === '' || row.cumulative_kwh == null) ? null : Number(row.cumulative_kwh);
    var dayType = String(row.day_type || '');
    if (dayType === 'actual') {
      actual.push(cumulative);
      projected.push(null);
      lastActualIndex = i;
    } else if (dayType === 'missing') {
      actual.push(null);
      projected.push(null);
    } else {
      actual.push(null);
      projected.push(cumulative);
    }
  });
  if (lastActualIndex >= 0 && lastActualIndex < projected.length) {
    projected[lastActualIndex] = actual[lastActualIndex];  // bridge the lines
  }

  var creditSafe = summary.credit_safe === true || String(summary.credit_safe).toLowerCase() === 'true';
  return {
    labels: labels,
    actualCumulative: actual,
    projectedCumulative: projected,
    threshold: Number(config.threshold_kwh || 1000),
    creditUsd: Number(config.credit_usd || 125),
    projectedTotal: Number(summary.projected_total_kwh || 0),
    margin: Number(summary.margin_vs_1000 || 0),
    verdict: String(summary.verdict || ''),
    creditSafe: creditSafe,
    lastUpdated: String(summary.last_updated || '')
  };
}

// ─── Triggers ────────────────────────────────────────────────────────────────

/** Install the once-daily trigger for runDailyUpdate if not already present. */
function installDailyTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'runDailyUpdate';
  });
  if (!exists) {
    ScriptApp.newTrigger('runDailyUpdate').timeBased().everyDays(1).atHour(7).create();
  }
}

// ─── Sheet helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the spreadsheet: the bound container, else a SHEET_ID script property.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getSpreadsheet_() {
  var ss = SpreadsheetApp.getActive();
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  throw new Error('No spreadsheet found. Bind the script to a Sheet, or set the SHEET_ID script property.');
}

/**
 * Get a sheet by name, creating it if missing.
 * @param {string} name
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateSheet_(name) {
  var ss = getSpreadsheet_();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** Create a tab with headers only if it does not already exist. */
function ensureTab_(name, headers) {
  var ss = getSpreadsheet_();
  if (!ss.getSheetByName(name)) {
    ss.insertSheet(name).getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

/**
 * Read a header-row table into objects keyed by column header.
 * @param {string} name
 * @return {{headers: string[], rows: Array<Object>}}
 */
function readTable_(name) {
  var sheet = getOrCreateSheet_(name);
  var values = sheet.getDataRange().getValues();
  if (!values.length) return { headers: [], rows: [] };
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    var allBlank = true;
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = values[i][c];
      if (values[i][c] !== '' && values[i][c] !== null) allBlank = false;
    }
    if (!allBlank) rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

/**
 * Replace a tab's contents with a header row + matrix of rows.
 * @param {string} name
 * @param {string[]} headers
 * @param {Array<Array>} matrix
 */
function writeTable_(name, headers, matrix) {
  var sheet = getOrCreateSheet_(name);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (matrix.length) {
    sheet.getRange(2, 1, matrix.length, headers.length).setValues(matrix);
  }
}

/**
 * Write an object as a two-column key/value sheet.
 * @param {string} name
 * @param {Object} obj
 */
function writeKeyValues_(name, obj) {
  var sheet = getOrCreateSheet_(name);
  sheet.clearContents();
  var rows = [['key', 'value']];
  Object.keys(obj).forEach(function (key) { rows.push([key, obj[key]]); });
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
}

/**
 * Read a two-column key/value sheet into an object (skips the header row).
 * @param {string} name
 * @return {Object}
 */
function readKeyValues_(name) {
  var sheet = getOrCreateSheet_(name);
  var values = sheet.getDataRange().getValues();
  var out = {};
  for (var i = 0; i < values.length; i++) {
    var key = String(values[i][0] || '').trim();
    if (!key || key.toLowerCase() === 'key') continue;
    out[key] = values[i][1];
  }
  return out;
}

/** @return {Object} the Config tab as an object. */
function readConfig_() { return readKeyValues_('Config'); }

// ─── Date + number utilities ──────────────────────────────────────────────────

/** @return {{y: number, m: number, d: number}} */
function parseISO_(iso) {
  var p = String(iso).split('-');
  return { y: Number(p[0]), m: Number(p[1]), d: Number(p[2]) };
}

/** Add n days to an ISO date (UTC math, DST-safe). @return {string} */
function isoAddDays_(iso, n) {
  var p = parseISO_(iso);
  var d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  d.setUTCDate(d.getUTCDate() + n);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

/** @return {number} whole days from ISO a to ISO b (b - a). */
function isoDiffDays_(a, b) {
  var pa = parseISO_(a), pb = parseISO_(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

/** Cycle days [start, nextRead) as ISO strings. @return {string[]} */
function cycleDatesIso_(startIso, nextReadIso) {
  var n = isoDiffDays_(startIso, nextReadIso);
  var out = [];
  for (var i = 0; i < n; i++) out.push(isoAddDays_(startIso, i));
  return out;
}

/** @return {string} today's ISO date in the script timezone. */
function todayIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Normalize a cell value (Date, ISO string, or MM/DD/YYYY) to "YYYY-MM-DD".
 * @param {*} v
 * @return {string}
 */
function normalizeDateCell_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return parseUsageDateIso_(s) || s;
}

/** Format an ISO date as a short chart label, e.g. "May 11". @return {string} */
function formatLabel_(iso) {
  if (!iso) return '';
  var p = parseISO_(iso);
  return Utilities.formatDate(new Date(Date.UTC(p.y, p.m - 1, p.d)), 'UTC', 'MMM d');
}

/** Round to 1 decimal place. @return {number} */
function round1_(x) { return Math.round(Number(x) * 10) / 10; }

/** Round to 1 dp, or '' for null. @return {(number|string)} */
function blankOr1_(x) { return x === null || x === undefined ? '' : round1_(x); }

/** @return {string} zero-padded 2-digit. */
function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** @return {string} zero-padded 4-digit year. */
function pad4_(n) { return ('000' + n).slice(-4); }

/** Structured JSON log to Stackdriver/console. */
function logEvent_(event, fields) {
  var payload = { event: event };
  if (fields) Object.keys(fields).forEach(function (k) { payload[k] = fields[k]; });
  console.log(JSON.stringify(payload));
}
