/**
 * Gmail.gs — import Smart Meter Texas (SMT) interval CSVs from Gmail.
 *
 * SMT emails interval-usage CSVs to the account inbox. We read those attachments,
 * sum the Consumption intervals per service day, keep the latest revision per day,
 * and upsert daily totals into the DailyUsage tab. Mirrors meter/csv_parser.py.
 *
 * CSV columns:
 *   ESIID, USAGE_DATE, REVISION_DATE, USAGE_START_TIME, USAGE_END_TIME,
 *   USAGE_KWH, ESTIMATED_ACTUAL, CONSUMPTION_SURPLUSGENERATION
 */

var SMT_SEARCH_QUERY = 'from:smartmetertexas.com has:attachment newer_than:40d';

/**
 * Read SMT CSV attachments from Gmail and upsert daily totals into DailyUsage.
 * Email-sourced days override existing rows; manually entered rows for dates the
 * emails do not cover are preserved.
 * @return {number} count of distinct service days imported.
 */
function importUsageFromGmail() {
  var threads = GmailApp.search(SMT_SEARCH_QUERY);
  var contributions = {};
  var filesParsed = 0;

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      message.getAttachments().forEach(function (attachment) {
        if (!/\.csv$/i.test(attachment.getName() || '')) return;
        filesParsed += 1;
        var content = attachment.getDataAsString('UTF-8').replace(/^﻿/, '');
        accumulateSmtCsv_(content, contributions);
      });
    });
  });

  // Resolve the latest revision per service day.
  var imported = {};
  Object.keys(contributions).forEach(function (dateIso) {
    var byRevision = contributions[dateIso];
    var bestRevision = '';
    var bestSum = 0;
    Object.keys(byRevision).forEach(function (revision) {
      if (revision >= bestRevision) {
        bestRevision = revision;
        bestSum = byRevision[revision];
      }
    });
    imported[dateIso] = Math.round(bestSum * 1000) / 1000;
  });

  // Upsert into DailyUsage, preserving manual rows the emails do not cover.
  var existing = readTable_('DailyUsage');
  var byDate = {};
  existing.rows.forEach(function (row) {
    var iso = normalizeDateCell_(row.service_date);
    if (iso) byDate[iso] = { kwh: Number(row.total_kwh), source: String(row.source || 'manual') };
  });

  var added = 0, updated = 0;
  Object.keys(imported).forEach(function (iso) {
    if (byDate[iso]) updated += 1; else added += 1;
    byDate[iso] = { kwh: imported[iso], source: 'email' };
  });

  var rows = Object.keys(byDate).sort().map(function (iso) {
    return [iso, byDate[iso].kwh, byDate[iso].source];
  });
  writeTable_('DailyUsage', ['service_date', 'total_kwh', 'source'], rows);

  logEvent_('import_usage_completed', {
    files_parsed: filesParsed, dates_imported: Object.keys(imported).length, added: added, updated: updated
  });
  return Object.keys(imported).length;
}

/**
 * Parse one SMT CSV and add its Consumption kWh into `contributions`, grouped by
 * service day and revision: contributions[dateIso][revisionSortKey] += kwh.
 * @param {string} content Raw CSV text (BOM already stripped).
 * @param {Object<string, Object<string, number>>} contributions Accumulator (mutated).
 */
function accumulateSmtCsv_(content, contributions) {
  var table = Utilities.parseCsv(content);
  if (!table.length) return;
  var header = table[0].map(function (h) { return String(h).trim().toUpperCase(); });
  var idxDate = header.indexOf('USAGE_DATE');
  var idxRevision = header.indexOf('REVISION_DATE');
  var idxKwh = header.indexOf('USAGE_KWH');
  var idxType = header.indexOf('CONSUMPTION_SURPLUSGENERATION');
  if (idxDate < 0 || idxKwh < 0 || idxType < 0) {
    logEvent_('smt_csv_header_unrecognized', { header: header.join('|'), fix_suggestion: 'Confirm the attachment is an SMT IntervalMeterUsage CSV.' });
    return;
  }

  for (var r = 1; r < table.length; r++) {
    var row = table[r];
    if (!row || row.length <= idxType) continue;
    var type = String(row[idxType] || '').trim().toLowerCase();
    if (type.indexOf('consumption') !== 0) continue;  // skip surplus generation / blanks
    var dateIso = parseUsageDateIso_(row[idxDate]);
    if (!dateIso) continue;
    var kwh = parseFloat(row[idxKwh]);
    if (isNaN(kwh)) continue;
    var revisionKey = idxRevision >= 0 ? parseRevisionSortable_(row[idxRevision]) : '';
    if (!contributions[dateIso]) contributions[dateIso] = {};
    contributions[dateIso][revisionKey] = (contributions[dateIso][revisionKey] || 0) + kwh;
  }
}

/**
 * Parse an SMT USAGE_DATE (MM/DD/YYYY or M/D/YY) into an ISO date string.
 * @param {string} raw
 * @return {string} "YYYY-MM-DD" or '' if unparseable.
 */
function parseUsageDateIso_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  var parts = s.split('/');
  if (parts.length !== 3) return '';
  var month = parseInt(parts[0], 10);
  var day = parseInt(parts[1], 10);
  var year = parseInt(parts[2], 10);
  if (isNaN(month) || isNaN(day) || isNaN(year)) return '';
  if (parts[2].length <= 2) year += 2000;
  return pad4_(year) + '-' + pad2_(month) + '-' + pad2_(day);
}

/**
 * Convert an SMT REVISION_DATE ("MM/DD/YYYY HH:MM:SS") into a lexically sortable
 * key "YYYYMMDDHHMMSS" so later revisions compare greater.
 * @param {string} raw
 * @return {string}
 */
function parseRevisionSortable_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  var segments = s.split(/\s+/);
  var dateIso = parseUsageDateIso_(segments[0]);
  if (!dateIso) return '';
  var time = (segments[1] || '00:00:00').split(':');
  var hh = pad2_(parseInt(time[0] || '0', 10));
  var mm = pad2_(parseInt(time[1] || '0', 10));
  var ss = pad2_(parseInt(time[2] || '0', 10));
  return dateIso.replace(/-/g, '') + hh + mm + ss;
}
