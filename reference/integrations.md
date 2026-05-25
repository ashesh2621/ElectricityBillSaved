# Integrations

**Why this doc exists:** Every external system this product depends on, with auth pattern, rate-limit / latency notes, and the failure modes to plan for. `/run-phase` consults this before writing any integration code so we never re-discover the same gotcha.

**When to update:** When an integration is added, an API version changes, or a new failure mode is observed in production.

---

## 1. Smart Meter Texas (SMT) — primary, M1 (Email subscription)

| | |
|---|---|
| **What** | Statewide Texas portal for smart-meter consumption data (CenterPoint, Oncor, AEP, TNMP). |
| **Used for** | Daily kWh totals, 15-minute interval reads (96/day), monthly billing-period boundaries. |
| **Delivery path chosen** | **SMT daily email subscription with CSV attachment.** Set up in the SMT portal under `Manage Subscriptions`: Report Type = `Energy Data 15 Min Interval`, Frequency = `Daily`, Format = `CSV`, **Delivery Type = `Email`**. |
| **Module** | `meter/` (interface), `meter/email_backend.py` (default impl), `meter/csv_parser.py` (shared parser). |
| **Library / runtime** | Standard library: `imaplib`, `email`, `csv`, `zipfile`. Optionally `imap-tools` if `imaplib` boilerplate gets ugly. |
| **Auth pattern** | IMAP login to a user-controlled mailbox (Gmail / Fastmail / etc.). For Gmail: an **app password** is required (not the account password). |
| **Required env vars** | `SMT_IMAP_HOST`, `SMT_IMAP_PORT`, `SMT_IMAP_USERNAME`, `SMT_IMAP_APP_PASSWORD`, `SMT_IMAP_MAILBOX`, `SMT_EMAIL_FROM_FILTER`, `SMT_ESI_ID`, `SMT_METER_NUMBER`. |
| **Rate limits** | None on the SMT side beyond "one email per day per subscription." On the IMAP side, polling once per cron run (daily) is well within any provider's limit. |
| **Latency** | **~24h.** Email arrives morning-after for the prior service day. Always treat "yesterday" as the freshest date. |
| **Payload** | CSV (sometimes ZIP-wrapped CSV) attached to the email. Columns: timestamp (local Houston time), ESIID, kWh consumed in that 15-min interval. 96 rows for a complete day. |
| **Idempotency key** | `(service_date, esi_id)` from CSV rows, NOT the email message id (re-deliveries happen). |
| **Failure modes** | (a) No email by 10am local → cron alerts; ingest exits 2 with `fix_suggestion="Check the SMT subscription is active and the mailbox filter."` (b) Email present but attachment unparseable → log raw payload to disk under `data/quarantine/`, exit 2. (c) Partial day (<96 intervals) → ingest the rows, mark `source='partial'`, re-ingest next day. (d) Subscription paused silently by SMT → 36h staleness check fires. |
| **Mailbox hygiene** | Use a dedicated label/folder. Mark messages read on success; don't delete (audit trail). One small disk-cache of seen `(date, esi_id)` tuples to dedupe redeliveries. |
| **Storage** | Intervals → `intervals(date, interval_start, kwh)`; daily totals → `daily_usage(date, total_kwh, source)`; billing periods → `billing_cycles(cycle_start, cycle_end, source)` (filled separately — see below). |
| **Billing-cycle source** | Email subscription does NOT include the monthly bill period boundaries. Read those from the SMT portal **once per cycle** (manual entry into `billing_cycles` is acceptable for M1), or extract from the user's retail provider's invoice email. The fallback library can also pull billing periods automatically — exposed via `meter/billing_cycle_provider.py` regardless of which interval backend we use. |

### Alternative SMT paths (not pursued / fallback only)

- **Unofficial `smart-meter-texas` portal-scraping library** — `meter/smt_lib_backend.py`. Used as a fallback only when the email path fails for N consecutive days. Same data, same latency, more fragile (portal changes break it). See `reference/stack-notes.md` for gotchas.
- **SMT push-API delivery** — **explicitly not pursued.** Requires: CA-issued SSL cert, registered domain, static public IP whitelisted by SMT support, customer-hosted HTTPS endpoint, JWT auth (post-Sept-2025). Designed for utilities and CSPs; same data and same latency as the email path. Infrastructure overkill for one house.
- **CSV manual export** — the SMT portal can be used to download CSVs by hand. Acceptable for one-time backfills (e.g., seeding 30 days of history at project start). Our `meter/csv_parser.py` handles these files identically.

---

## 2. Open-Meteo — primary, M2

| | |
|---|---|
| **What** | Free weather API with both historical daily aggregates and forecast. |
| **Used for** | Historical daily `T_avg` paired with each stored kWh day (for model fitting); forecast `T_avg` per day for projection. |
| **Module** | `weather/`. |
| **Endpoints** | History: `https://archive-api.open-meteo.com/v1/archive` · Forecast: `https://api.open-meteo.com/v1/forecast`. |
| **Auth pattern** | None — no API key. |
| **Required env vars** | `WEATHER_LAT`, `WEATHER_LON`. Default to Houston: `29.7604, -95.3698`. |
| **Required query params** | `latitude`, `longitude`, `daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min`, `temperature_unit=fahrenheit`, `timezone=America/Chicago`. |
| **Rate limits** | None for personal use. Cache responses for the day — don't re-query inside one cron run. |
| **Latency** | History updates with a 1–2 day lag (matches SMT's lag — convenient). |
| **Forecast horizon** | ~16 days. When `days_remaining > forecast_days`, fall back to **30-day trailing-average `T_avg`** for the uncovered tail. Surface the fallback in the recommendation output. |
| **Failure modes** | Network failure (transient) — log and retry on next cron run; degraded reports are acceptable for one day. |
| **Ruled out** | OpenWeather / Tomorrow.io (require keys; no advantage); NWS (no history endpoint at the granularity we want). |

---

## 3. Aprilaire Thermostat — primary, M3 + M4

**Model confirmed: S86WMUPR** (FW 1.8.6, two units — `0025CAA32A6D` = 2nd floor, `0025CAA32C67` = 1st floor; plus a `NONCON` air cleaner). The product needs a path that is **scalable (cloud-reachable)** AND **keeps the customer's phone app working** — which rules out the local-LAN path as the product mechanism (it needs same-LAN access and Automation mode, which disables the app). **The cloud path below is primary; local TCP is a prototype/offline fallback only.**

### 3a. Cloud path — PRIMARY (scalable, app stays working)

| | |
|---|---|
| **What** | The same "Healthy Air" cloud (`aprilaire.io`) the phone app uses. The S86 reports into it; the app keeps working in parallel. Verified live end-to-end (read + write). |
| **Used for** | Reading live indoor temp/humidity + setpoints/mode (M3); writing cool setpoint (M4). |
| **Module** | `thermostat/cloud_client.py` (`AprilaireCloudClient`); CLI `cloud_thermostat.py read|set`; discovery via `cloud_probe.py`. Reuses `thermostat/models.py` (`ThermostatReading`, °C⇄°F). |
| **Library** | `pycognito` (auth), `aiohttp` (REST + WebSocket). |
| **Auth pattern** | **AWS Cognito** (public app pool, `us-west-2`, pool `us-west-2_skfkpmVv6`, client `3aiakr6qdoqtajv7qgtapecerg`). Username/password → `id_token` (Bearer). Endpoint/Cognito config originally mapped by `billda/ha-aprilaire-cloud`. |
| **Endpoints** | REST `https://device.aprilaire.io` — `GET /hierarchy` (lists locations→rooms→devices), `GET /{id}/settings` (setpoints/mode), `PATCH /{id}/settings` (write). Account: `GET https://account.aprilaire.io/user`. Live telemetry: WebSocket `wss://socket.aprilaire.io/` — subscribe `{"action":"subscribe","message":{"token":<id_token>,"locationId":<loc>}}`. |
| **Schema (confirmed)** | **Live temp/humidity only on the WebSocket** `ThermostatStatus` frame: `tempSensors[].reading` (°C), `humSensors[].reading` (%), `coolingStatus`/`heatingStatus`/`isFanOn`. **Setpoints/mode** via REST `/settings` → `thermostatPZ1.{cool,heat}` (°C), `.mode` (`cool`/`heat`/`auto`/`off`), `.fan`, `.hold`, `.scale`. **Write:** `PATCH /{id}/settings` body `{"thermostatPZ1":{"cool":<°C>}}`. All temps Celsius on the wire. |
| **Required env vars** | `APRILAIRE_CLOUD_EMAIL`, `APRILAIRE_CLOUD_PASSWORD`, `APRILAIRE_LOCATION_ID`, `APRILAIRE_2F_DEVICE_ID`, `APRILAIRE_1F_DEVICE_ID`. |
| **Eventual consistency** | A `GET /settings` immediately after a `PATCH` may return the OLD value for a few seconds. `set_cool_setpoint` polls `/settings` until the change reflects before confirming. |
| **Deadband** | Heat/cool min-gap (~3°F guard) **only enforced in `auto` mode**; in `cool`/`heat` mode the setpoints are independent (that's why cool 73°F was allowed with heat 72°F). |
| **Rate limits** | REST returns 429 + `Retry-After` when throttled; back off. Don't poll `/settings` tighter than needed — prefer the WebSocket for live state. |
| **Failure modes** | (a) Cognito auth fails → `AprilaireCloudError`; (b) HTTP ≥400 → raise with body; (c) no `ThermostatStatus` within ~12s on WS → raise; (d) cloud/AWS outage → no control (cloud-dependent by nature). |
| **Productization TODO** | Per-customer OAuth/consent; store **refresh tokens** (encrypted), never passwords; add token refresh (current client only does first-login auth); **unofficial API** — expect breakage on app updates; ToS gray area. |

### 3b. Local LAN path — FALLBACK (prototype / offline only)

| | |
|---|---|
| **What** | Direct LAN socket to the device. Reliable + offline-capable, but **requires Automation mode (disables the app) and same-LAN access** — not viable as the product mechanism. Kept for personal/offline use and tests. |
| **Module / lib** | `thermostat/client.py`, `read_temperature.py`, `set_temperature.py`; `pyaprilaire`. |
| **Connection** | TCP **port 8000** (S86WMUPR / 8800-series). Port **7001** is only the `pyaprilaire` mock. Protocol speaks Celsius. |
| **Setup** | Device → Settings → hold Up+Down 3s → Installer Settings → Connection Type → **Automation System** (reversible; breaks the app while set). |
| **Env vars** | `APRILAIRE_2F_HOST`, `APRILAIRE_1F_HOST`, `APRILAIRE_PORT=8000`. |
| **Hard constraint** | **One automation connection at a time** — parallel connects can hang the device (physical power-cycle to recover). `client.py` serializes via a cross-process file lock. |
| **Mock for dev** | `python -m pyaprilaire.mock_server` (port 7001). |

**Ruled out entirely:** Google Assistant / SDM (Nest-only; no third-party device read); **Alexa Smart Home Skill API** (manufacturer→Alexa only — no consumer API to read/control already-linked devices; only the unofficial, brittle AlexaPy, which can't reliably read state); legacy `app.aprilairestat.com` (old 8800/8900-series portal, not the S86); raw AWS IoT MQTT reverse-engineering (the `aprilaire.io` REST/WS layer above already covers it).

---

## 4. Outbound email — SMTP (`notify/`), M1

| | |
|---|---|
| **What** | Sends the daily report/verdict email to the user. |
| **Used for** | Delivering the daily consumption report (M1) and the projection + RAISE/LOWER/HOLD verdict (M2). |
| **Module** | `notify/` (interface), `notify/smtp_backend.py` (default impl), `report/` renders the body. |
| **Library / runtime** | Standard library: `smtplib`, `email.message.EmailMessage`. No extra dep. |
| **Default transport** | Gmail SMTP — `smtp.gmail.com:587`, STARTTLS, **app password** (Gmail blocks plain-password SMTP). |
| **Auth pattern** | SMTP AUTH with username + app password. Separate session from the inbound IMAP poller even if it's the same Gmail account. |
| **Required env vars** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_APP_PASSWORD`, `EMAIL_FROM`, `EMAIL_TO`, `EMAIL_CADENCE`. |
| **Message format** | Multipart: `text/plain` (= CLI output) + `text/html`. Subject carries the verdict (e.g. `Raise AC to 77°F — projected 1,034 vs 950 kWh`). |
| **Cadence** | `EMAIL_CADENCE=daily` (always) or `on_action` (only when verdict is RAISE/LOWER). Default `daily`. |
| **Idempotency** | Record `(report_date, sent_at)`; at most one email per service day unless `--force`. |
| **Failure modes** | SMTP auth/connection failure → still write report to file + stdout, log `email_send_failed` with `fix_suggestion`, exit 2 (cron surfaces it). Never silently swallow. |
| **Ruled out (for M1)** | Transactional providers (Resend / SES / Postmark) — need SPF/DKIM on a sending domain; unnecessary for one self-recipient. Revisit if deliverability becomes an issue. |

---

## Cross-cutting integration rules

- **One HTTP client config** (`httpx.AsyncClient` with `timeout=30s`, `http2=True`) lives in `shared/http.py` and is reused. No bare `httpx.get`.
- **Every integration goes behind a Pydantic-typed interface** in its module. Tests mock at that boundary (the HTTP client, the IMAP client, or the `pyaprilaire` client), never deeper.
- **Every integration has a recorded fixture** in `tests/<module>/fixtures/` captured from a real call/email early in development. When the upstream changes, the diff is the first thing to inspect.
- **Every integration error logs `fix_suggestion`.** "SMT email missing → check the subscription is active." "Aprilaire connect refused → another client may be connected; verify and retry." "Open-Meteo timeout → retry on next cron run."
- **No integration runs in M1 unit tests.** Live integration tests live in `tests/integration/` with the `live` marker and are skipped unless explicitly invoked.
