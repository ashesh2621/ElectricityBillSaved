# Electricity Dashboard — Google Sheets + Apps Script

A grandma-simple web app: one link shows a big graph of this billing cycle's
cumulative electricity use, a red **1,000 kWh goal** line, and a projected line for
the rest of the month — so anyone can see at a glance whether we're on track to bank
the **$125 bill credit** (4Change "Maxx Saver Value 12").

The projection math is a faithful port of the repo's `project_usage.py`
(OLS: `kWh/day ≈ baseload + beta · CDD65`). Actual daily usage is imported
automatically from the Smart Meter Texas emails in your Gmail.

## Files
| File | Purpose |
|---|---|
| `appsscript.json` | Manifest: scopes (Gmail/Sheets/fetch) + web app config |
| `Code.gs` | Entry points (`doGet`, `setup`, `runDailyUpdate`, `getDashboardData`) + shared helpers |
| `Gmail.gs` | Import SMT CSV attachments → daily totals (`importUsageFromGmail`) |
| `Weather.gs` | Open-Meteo forecast + climatology (`refreshWeather`) |
| `Projection.gs` | OLS fit + predict + cumulative + verdict (`computeProjection`) |
| `Index.html` | Graph-first dashboard (Chart.js) |

## Sheet tabs (created by `setup()`)
- **Config** — `zip`, `cycle_start`, `next_read`, `threshold_kwh`, `credit_usd`, `cdd_base_f`
- **DailyUsage** — `service_date | total_kwh | source`
- **Weather** — `date | temp_min_f | temp_max_f | mean_temp_f | source`
- **Projection** — `date | mean_temp_f | cdd | actual_kwh | predicted_kwh | used_kwh | cumulative_kwh | day_type`
- **Summary** — key/value the web app reads (projected total, verdict, model fit, last_updated)

## Deploy (container-bound — recommended)
The script must be bound to the Sheet (so the ⚡ menu and `getActive()` work).

1. Create a new Google Sheet. **Extensions → Apps Script** opens the bound project.
2. Get the **Script ID**: in the editor, *Project Settings → IDs → Script ID*.
3. Locally: `npm i -g @google/clasp` then `clasp login` (interactive — in Claude Code run `! clasp login`).
4. Copy `.clasp.json.example` → `.clasp.json`, paste the Script ID, then:
   ```
   cd appsscript && clasp push
   ```
   (or just copy each file's contents into the editor manually).
5. In the editor, run **`setup`** once → authorize the scopes (Gmail read, Sheets, external fetch).
6. Set your real values in the **Config** tab (especially `zip`, `cycle_start`, `next_read`).
7. Force a first build: **⚡ Electricity → Refresh now** (or run `runDailyUpdate`).
8. **Deploy → New deployment → Web app**: *Execute as: Me*, *Who has access: Anyone* → copy the
   URL and bookmark it on grandma's device.

A daily time trigger (`runDailyUpdate`, ~7am CT) is installed by `setup()` to keep the
Sheet fresh; the web app only reads the precomputed Sheet, so it loads fast.

## One-time backfill
SMT *daily emails* cover roughly 5/19 onward. The 5/11–5/18 week came from a portal
export (not email), so the auto-import won't have it. Type those 8 daily totals into
**DailyUsage** by hand (`source` = `manual`) so the cycle total is complete — manual rows
are preserved across imports.

## Verify
- `importUsageFromGmail` fills DailyUsage with ~23–40 kWh/day rows matching `data/smt/*.CSV`.
- `computeProjection` `projected_total_kwh` / `baseload` / `beta` / `r_squared` match
  `python project_usage.py` for the same cycle.
- Open the web app URL in an incognito window: graph renders (solid actual, dashed
  projected, red 1,000 line) with the correct color-coded status.
