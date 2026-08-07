# Landroll Leader API

The upload → map → validate → publish pipeline behind the admin back office,
plus the public listings API that powers the map-and-cards site.
Node 18+ / Express. Tested against Hinds County's real 15,537-row RP0095 export.

## Run locally
    npm install
    ADMIN_KEY=choose-a-key node server.js      # http://localhost:3000

## Deploy to Railway
1. Push this folder to a GitHub repo, create a Railway service from it.
2. Set env vars: `ADMIN_KEY` (required), `DATA_DIR=/data` and attach a
   Railway volume mounted at `/data` so listings survive deploys.
3. Railway injects `PORT` automatically. Done.
4. Optional: drop `landroll-leader.html` into `/public` as `index.html`
   and the same service serves the site and the API.

## The clerk flow (mirrors the admin screens)

### 1. Stage a land roll
    POST /api/uploads                       (admin)
    multipart form: file=<xlsx|csv>, county_id=hinds, sale_event_id=hinds-2026
Returns `upload_id`, the proposed column `mapping` with confidence levels,
`unmapped` headers, and a live `validation` preview. If the county has
published before, last year's confirmed mapping applies automatically.

### 2. Confirm or correct the mapping
    PUT /api/uploads/:id/mapping            (admin)
    { "LEGAL9": "legal_description", "MISC2": null }
Re-validates and returns the updated report. Omit this call entirely when
the proposed mapping is already right.

### 3. Download blocked rows (fix and re-upload just these)
    GET /api/uploads/:id/errors.csv         (admin)

### 4. Publish
    POST /api/uploads/:id/publish           (admin)
    { "confirm": "Hinds" }                  <- must type the county name
Swaps the sale event's listings atomically, stamps `published_at`, computes
each parcel's `redemption_deadline` from the county's statutory settings,
saves the mapping for next year, and writes the audit entry with the file's
SHA-256 — the county's proof of what was published, when.

## Public listings API
    GET /api/listings?county=hinds&status=active
        &q=ridgewood                        text search: parcel/owner/address/legal
        &min_total=5000&max_total=100000    face-value range
        &repeat_delinquent=true             prior tax-sale years present
        &out_of_state=true                  absentee owner
        &land_use=1110                      assessor use code
        &sort=total_desc|total_asc|value_desc
        &page=1&per_page=50
    GET /api/listings/:parcel               one parcel, full detail

## County operations
    POST /api/listings/:parcel/status       (admin) {"status":"paid_before_sale"}
    GET  /api/counties  /api/sale-events  /api/stats
    GET  /api/audit                         (admin) immutable trail, newest first

## Auth (pilot)
Admin routes require header `x-admin-key: $ADMIN_KEY`. Pass `x-actor` to
attribute audit entries. Before real county onboarding, replace with proper
sessions/SSO and per-county role scoping — the seams are in `requireAdmin`.

## Storage
`lib/store.js` persists JSON to `DATA_DIR` with atomic writes — right for a
pilot, and the module is the single seam to swap for Postgres later without
touching routes. Enrichments computed on ingest: repeat_delinquent,
owner_out_of_state, homestead_exempt, needs_geocode, taxes_due rollup from
county/municipal/school jurisdictions, and 8-way legal description merge.

## Pilot additions (clerk-demo build)

**Front end** — `public/index.html` is served at `/` by the same service. It is
fully API-driven: live facet filters (statuses and use codes with real counts),
server-side search and pagination, investor-signal filters (repeat delinquent,
absentee, combined), detail view with the three-jurisdiction tax breakdown,
deed book/page, prior sale years and 2025 buyer, Google/Apple Maps deep links,
and map pins with deterministic approximate positions (labeled as such) until
GIS geocoding lands. The admin back office is live too: the upload screen
POSTs real files through the pipeline, shows the mapping and validation, and
publishes with the type-the-county-name guard; the listings screen marks
parcels paid against the real API; the audit log renders the real trail.

**New endpoints**
    GET  /api/facets?county=hinds       filter options with counts, from live data
    POST /api/billing/checkout          {"plan":"investor"|"pro"} -> Stripe Checkout URL
                                        (demo-mode JSON until STRIPE_SECRET_KEY is set)
    POST /api/billing/webhook           Stripe events -> subscribers + audit
                                        (set STRIPE_WEBHOOK_SECRET to enforce signatures)
    GET  /api/subscribers               (admin)

**Stripe env vars**: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SITE_URL.
Point a Stripe webhook at /api/billing/webhook for checkout.session.completed
and customer.subscription.deleted.

**The 10-minute clerk demo script**
1. Open / — the public site with the county's real 15,537-parcel roll.
2. Filter: repeat delinquent + absentee + over $10k. Explain wider bidder
   reach = more competitive premiums = better collection rates.
3. Open a parcel: three-jurisdiction breakdown, deed book/page, redemption
   deadline computed from the statute.
4. Admin -> Upload: drop their own file live. Watch mapping + validation.
5. Publish with the typed county-name confirmation; show the audit entry
   with timestamp + file hash ("your proof of what was public, when").
6. Listings -> Mark one paid; flip to the public site and show it flagged.

## UI bugs found by screenshotting the real admin session

Three rendering defects only visible once the back office was driven in a real
browser (headless Chromium against the live server), all fixed:

1. Upload drop zone collapsed into two narrow slivers. .drop is a <label>,
   which is inline by default; with block children inside, the browser
   fragments the inline box. Fixed with display:block.
2. Audit timestamps clipped mid-second ("21:55:3"). The .when column was a
   fixed 128px inside a flex row and got squeezed. Widened to 150px + flex:none.
3. Raw snake_case status in the admin listings table ("struck_to_state")
   while every other status was humanized. Now renders "Struck to State",
   with a generic underscore-to-title fallback for any future status.

Verified not a bug: the admin UI sends status "paid_before_sale" while the
API tests used "prev_paid" — the server accepts both, confirmed live.

## Known bug fixed: multi-source column mapping

Found while exercising the admin flow with a real saved mapping. When several
source columns map to one canonical field (DESC1..DESC8 -> legal_description),
auto-detection tagged them "high-merge" and joined them correctly — but a
SAVED or clerk-confirmed mapping arrived as "confidence: confirmed" and fell
through to plain assignment, so the last column won. Trailing DESC columns are
usually blank, so legal_description was wiped and rows failed the required-field
check: the same Hinds file that ingested 15,537/15,537 clean on first upload
produced 15,324 BLOCKED rows on the second.

Impact if shipped: every county's second-year upload (and every clerk mapping
correction) would silently gut the roll — the exact feature meant to make year
two effortless. Fixed in lib/ingest.js by detecting multi-source targets after
overrides are applied and merging them regardless of confidence label; money
targets are excluded (two columns on one amount is a mapping error, so the
first non-null wins rather than summing and double-counting). Verified: both
the auto-detected and saved-mapping paths now accept 15,537/15,537.

## Production readiness (rollout build)

**Persistence — Postgres.** lib/store.js is dual-mode: set DATABASE_URL and
it uses Postgres (each collection an atomically-upserted jsonb row in
kv_store); leave it unset and it uses JSON files for local dev. server.js is
unchanged either way. Verified by killing the process with SIGKILL mid-run
and confirming an account created pre-crash still logged in after restart.

**Hardening.** Security headers (nosniff, DENY framing, referrer policy,
HSTS on https), x-powered-by removed, trust proxy set for Railway, and
fixed-window per-IP rate limiting: 240 req/min general, 8 signups/hr,
20 alerts/hr, 30 uploads/hr. Auth routes keep their own 5-strike lockouts.

**Boot safety.** In NODE_ENV=production the server prints explicit warnings
if ADMIN_PASSWORD or ADMIN_KEY are unset/default, DATABASE_URL is missing,
SITE_URL is unset, or Stripe keys are set without a webhook secret.

**Lifecycle.** GET /api/health (store mode, mailer, listing count, uptime)
for Railway health checks and uptime monitors. Graceful SIGTERM/SIGINT
shutdown drains connections and closes the pool — Railway sends SIGTERM on
every redeploy.

**Geocoding.** lib/geocode.js resolves real coordinates: tier 1 is a county
ArcGIS parcel layer (parcel-centroid accurate, set GIS_ARCGIS_LAYER_URL +
GIS_ARCGIS_PARCEL_FIELD), tier 2 is the free US Census geocoder from the
situs address. POST /api/geocode/run (admin, resumable, throttled, only
touches un-geocoded rows) + GET /api/geocode/status, with a "◎ Geocode
parcels" dashboard button. The front end projects real lat/lng into the map
frame and falls back to map-sheet clustering per-parcel until resolved.
Network calls could not be exercised from the build sandbox — verify with
the curl commands in DEPLOY.md "Geocoding setup".

**Legal.** public/legal/terms.html and privacy.html, linked from the site
footer and the signup consent line. Plain-language drafts — have counsel
review before they are load-bearing.

**Deploy tooling.** railway.json (health check + restart policy),
.env.example (every variable documented), .gitignore, DEPLOY.md (the full
runbook: GitHub, Railway, SendGrid, Cloudflare, Stripe, geocoding, ops), and
smoke-test.js — 25 checks against a live URL covering health, public API,
auth enforcement, signup/tier gating, reset-enumeration safety, admin auth,
and legal pages. Exits non-zero so it can gate CI.

    node smoke-test.js https://landrollleader.com YOUR_ADMIN_KEY

## Authentication

The back office is password protected.

- Browser: the Admin button opens a sign-in screen. POST /api/auth/login
  { password, name } sets an httpOnly session cookie (8-hour expiry). The
  name entered is attached to every audited action ("E. Dunn, Deputy Clerk
  -> sale_event.published"). Sign-ins, failures, and sign-outs are audited.
- Brute force: 5 failed attempts from an IP locks it out for 15 minutes.
- Automation: server-to-server calls may still use the x-admin-key header
  ($ADMIN_KEY) — cron jobs and scripts keep working without a session.
- Env: set ADMIN_PASSWORD in production (the server warns at boot if it is
  running on the pilot default). Set ADMIN_KEY for the automation path.
  Sessions are in-memory: a redeploy signs everyone out, which is fine.
- Upgrade path when counties onboard for real: per-user accounts with
  bcrypt-hashed passwords in the store, roles (clerk vs. deputy vs. read-
  only), and county scoping in requireAdmin.

## Investor accounts (signup / login with tier selection)

- POST /api/users/signup { email, password, name, tier } — tier is required:
  browse (free) | investor ($49/mo) | pro ($199/mo). Validates email format,
  8+ char password, unknown tiers, and duplicate emails. Creates the account,
  signs the user in (httpOnly ll_user cookie, 30 days), and for paid tiers
  hands off to Stripe Checkout (demo mode without keys: billing_status
  "demo"; with keys: "pending_checkout" until the webhook marks "active").
- POST /api/users/login — scrypt-hashed passwords, timing-safe compare,
  5-failures-per-IP lockout (separate bucket from the admin lockout).
- GET /api/users/me, POST /api/users/logout.
- Tier enforcement: requireTier("investor") gates paid features server-side.
  CSV export returns 401 anonymous / 403 browse / 200 investor+. The admin
  session and x-admin-key bypass the gate for county staff and automation.
- Front end: Sign in button opens the account modal (Sign in / Create
  account tabs). Signup shows three selectable plan cards; the Pricing modal
  buttons deep-link into signup with that tier preselected. The nav shows
  "Name · Tier" with Sign out once authenticated, restored on reload from
  the session cookie. Gated features catch 401/403 and open signup on the
  right tier.
- Demo accounts seeded in data/: jordan@deltafund.com / strongpass99
  (investor) and casual@example.com / password123 (browse).

## Email: provider, outbox worker, password reset

- lib/mailer.js is provider-agnostic: EMAIL_PROVIDER = sendgrid | resend |
  console (auto-detected from SENDGRID_API_KEY / RESEND_API_KEY; console is
  the default and simply logs — the pilot "works" without any keys, and one
  env var flips it live). EMAIL_FROM sets the sender.
- Outbox worker: every outgoing message (welcome, alert, password reset) is
  queued in db.outbox with a status, sent immediately via setImmediate, and
  retried by a 60-second interval sweep. POST /api/alerts/outbox/process
  (admin) runs the sweep on demand and returns sent/queued/failed counts —
  wired to the Alert outbox button in the dashboard. GET .../outbox lists
  entries without bodies.
- Branded HTML templates (pine/amber shell): saved-search alert digests with
  parcel deep links, welcome-by-tier, and reset emails.
- Password reset: POST /api/users/forgot always answers identically (no
  account enumeration); real accounts get a single-use, 30-minute token
  linking to /#reset=<token>. POST /api/users/reset validates the token,
  re-salts and re-hashes, marks the token used, and invalidates every
  session for that user. Front end: "Forgot password?" in the sign-in tab,
  and the #reset= link opens a set-new-password view automatically.

## Feature build 2 (full suggestion set)

**Statutory notice export** — GET /api/export/notice.html?sale_event=&qr=1
  Print-ready, three-column newspaper-format list (Georgia serif, break-safe
  entries) with per-parcel QR codes that deep-link to /#parcel=<id> on the
  public site. Intro paragraph is a placeholder for the county's approved
  notice language. Tested: 1,749 active parcels with QR in ~2.5 MB.

**CSV export** — GET /api/export/listings.csv?<same filters as /api/listings>
  All canonical + enrichment columns; export events are audited.

**Buyer intelligence** — GET /api/buyers?county=
  Aggregates published results by purchaser: parcels, market share, total
  face, average overbid. Parcels struck to the State are correctly excluded
  (status struck_to_state, 3,482 in Hinds 2025) — investors bought 10,274
  across 129 distinct buyers. Front end: "Market intel" in the nav.

**Owner redemption estimator** — GET /api/listings/:parcel/redemption
  Months elapsed since sale x statutory monthly rate on face value, with the
  deadline and a clear send-them-to-the-Clerk note. Shown on every detail view.

**Yield calculator** — client-side on the detail view: overbid + redemption
  month inputs -> cash in, interest earned, net, simple and annualized return.

**Saved-search alerts** — POST /api/alerts {email, filters}; on every publish
  the server matches new listings against saved alerts and queues messages to
  an outbox (GET /api/alerts/outbox, admin). Plug an email provider into the
  outbox worker to send; the matching layer is done.

**Pipeline** — totals that exceed components are itemized as
  prior_years_included_amount (9 parcels); totals below components flag
  "check the export" (255 — likely partial payments, for clerk review).
  Parcels sold to "STATE OF MISSISSIPPI" are classified struck_to_state.
  Each parcel carries map_sheet (leading GIS-map digits); the front end
  clusters pins by sheet (561 sheets in Hinds) until true GIS geocoding.
