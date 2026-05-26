/**
 * Projection.gs — weather-driven cycle kWh projection + the 1000 kWh credit cliff.
 *
 * Faithful port of project_usage.py:40-150. Model:
 *   kWh/day ≈ baseload + beta · CDD,  where CDD = max(0, (tmin+tmax)/2 − cdd_base_f)
 * Fit by ordinary-least-squares on days that have BOTH metered usage and weather.
 * For each cycle day: use the metered value if present, else predict from weather.
 * Sum to a projected total, compare to threshold_kwh (1000), classify the verdict.
 */

/**
 * Ordinary-least-squares fit of kWh = baseload + beta * CDD.
 *
 * @param {number[]} cdds Cooling-degree-days per day (regressor).
 * @param {number[]} kwhs Metered kWh per day (response), aligned with cdds.
 * @return {{baseload: number, beta: number, r2: number}} beta is kWh per CDD.
 */
function fitUsageModel_(cdds, kwhs) {
  var n = cdds.length;
  var sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (var i = 0; i < n; i++) {
    sumX += cdds[i];
    sumY += kwhs[i];
    sumXX += cdds[i] * cdds[i];
    sumXY += cdds[i] * kwhs[i];
  }
  var denom = n * sumXX - sumX * sumX;
  if (n < 2 || denom === 0) {
    return { baseload: n ? sumY / n : 0, beta: 0, r2: 0 };
  }
  var beta = (n * sumXY - sumX * sumY) / denom;
  var baseload = (sumY - beta * sumX) / n;
  var meanY = sumY / n;
  var ssTot = 0, ssRes = 0;
  for (var j = 0; j < n; j++) {
    ssTot += Math.pow(kwhs[j] - meanY, 2);
    var predicted = baseload + beta * cdds[j];
    ssRes += Math.pow(kwhs[j] - predicted, 2);
  }
  var r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { baseload: baseload, beta: beta, r2: r2 };
}

/**
 * Read DailyUsage tab into a map of service_date (ISO) -> total_kwh.
 * @return {Object<string, number>}
 */
function readUsageMap_() {
  var table = readTable_('DailyUsage');
  var map = {};
  table.rows.forEach(function (row) {
    var iso = normalizeDateCell_(row.service_date);
    if (!iso) return;
    var kwh = Number(row.total_kwh);
    if (!isNaN(kwh)) map[iso] = kwh;
  });
  return map;
}

/**
 * Read Weather tab into a map of date (ISO) -> {min, max, source}.
 * @return {Object<string, {min: number, max: number, source: string}>}
 */
function readWeatherMap_() {
  var table = readTable_('Weather');
  var map = {};
  table.rows.forEach(function (row) {
    var iso = normalizeDateCell_(row.date);
    if (!iso) return;
    var min = Number(row.temp_min_f);
    var max = Number(row.temp_max_f);
    if (isNaN(min) || isNaN(max)) return;
    map[iso] = { min: min, max: max, source: String(row.source || 'forecast') };
  });
  return map;
}

/**
 * Average of the most recent up-to-n metered days. Safety fallback when the
 * temperature model is unreliable (too few points or a non-physical slope).
 * @param {Object<string, number>} usageMap
 * @param {string[]} meteredDatesIso
 * @param {number} n
 * @return {number}
 */
function trailingAverage_(usageMap, meteredDatesIso, n) {
  if (!meteredDatesIso.length) return 0;
  var sorted = meteredDatesIso.slice().sort();
  var recent = sorted.slice(-n);
  var sum = 0;
  recent.forEach(function (iso) { sum += usageMap[iso]; });
  return sum / recent.length;
}

/**
 * Compute the cycle projection and write the Projection + Summary tabs.
 * Reads Config, DailyUsage, and Weather. Idempotent — safe to re-run.
 * @return {Object} the summary object that was written.
 */
function computeProjection() {
  var cfg = readConfig_();
  var startIso = normalizeDateCell_(cfg.cycle_start);
  var nextReadIso = normalizeDateCell_(cfg.next_read);
  var cddBase = Number(cfg.cdd_base_f || 65);
  var threshold = Number(cfg.threshold_kwh || 1000);

  var dates = cycleDatesIso_(startIso, nextReadIso);
  var usageMap = readUsageMap_();
  var weatherMap = readWeatherMap_();

  function meanTemp(iso) {
    var w = weatherMap[iso];
    return w ? (w.min + w.max) / 2 : null;
  }
  function cdd(iso) {
    var t = meanTemp(iso);
    return t === null ? null : Math.max(0, t - cddBase);
  }

  // Fit on days with BOTH metered usage and weather (matches project_usage.py).
  var fitCdds = [], fitKwhs = [];
  dates.forEach(function (iso) {
    if (usageMap[iso] != null && cdd(iso) !== null) {
      fitCdds.push(cdd(iso));
      fitKwhs.push(usageMap[iso]);
    }
  });
  var model = fitUsageModel_(fitCdds, fitKwhs);

  var meteredDates = dates.filter(function (iso) { return usageMap[iso] != null; });
  var fallbackAvg = trailingAverage_(usageMap, meteredDates, 7);
  var useFallback = fitCdds.length < 3 || model.beta <= 0;

  function predict(iso) {
    if (useFallback) return fallbackAvg;
    var c = cdd(iso);
    return c === null ? null : Math.max(0, model.baseload + model.beta * c);
  }

  // Walk the cycle: metered where known, else modeled.
  var rows = [];
  var actualSum = 0, modeledSum = 0, cumulative = 0;
  var lastActualIso = null;

  dates.forEach(function (iso) {
    var t = meanTemp(iso);
    var c = cdd(iso);
    var actual = usageMap[iso];

    if (actual != null) {
      actualSum += actual;
      cumulative += actual;
      lastActualIso = iso;
      rows.push([iso, blankOr1_(t), blankOr1_(c), round1_(actual), '', round1_(actual), round1_(cumulative), 'actual']);
      return;
    }

    var predicted = predict(iso);
    if (predicted === null) {
      // No weather for this day and not in fallback mode — exclude from the total.
      rows.push([iso, blankOr1_(t), blankOr1_(c), '', '', '', round1_(cumulative), 'missing']);
      return;
    }
    modeledSum += predicted;
    cumulative += predicted;
    var dayType = weatherMap[iso] ? weatherMap[iso].source : 'forecast';
    rows.push([iso, blankOr1_(t), blankOr1_(c), '', round1_(predicted), round1_(predicted), round1_(cumulative), dayType]);
  });

  var total = Math.round(actualSum + modeledSum);
  var margin = Math.round(total - threshold);
  var creditSafe = total >= threshold;
  var verdict;
  if (total >= threshold + 60) verdict = 'LIKELY CLEAR';
  else if (total >= threshold) verdict = 'CLOSE';
  else if (total >= threshold - 75) verdict = 'AT RISK';
  else verdict = 'MISS';

  writeTable_('Projection',
    ['date', 'mean_temp_f', 'cdd', 'actual_kwh', 'predicted_kwh', 'used_kwh', 'cumulative_kwh', 'day_type'],
    rows);

  var summary = {
    projected_total_kwh: total,
    margin_vs_1000: margin,
    verdict: verdict,
    credit_safe: creditSafe,
    last_actual_date: lastActualIso || '',
    baseload: round1_(model.baseload),
    beta: Math.round(model.beta * 100) / 100,
    r_squared: Math.round(model.r2 * 100) / 100,
    fit_days: fitCdds.length,
    model_note: useFallback ? 'trailing-7-day average (model unreliable)' : 'OLS baseload + beta*CDD',
    metered_kwh: round1_(actualSum),
    modeled_kwh: round1_(modeledSum),
    last_updated: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm 'CT'")
  };
  writeKeyValues_('Summary', summary);

  logEvent_('compute_projection_completed', {
    projected_total_kwh: total, margin: margin, verdict: verdict,
    fit_days: fitCdds.length, beta: summary.beta, r2: summary.r_squared, fallback: useFallback
  });
  return summary;
}
