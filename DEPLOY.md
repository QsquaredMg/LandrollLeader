# Landroll Leader — Deployment Runbook

Everything needed to take this from the pilot build to a live site at
landrollleader.com. Steps 1–4 get you online; 5–7 are the commercial and
polish layers you can do in the days after.

Budget roughly 90 minutes for steps 1–4 the first time.

---

## Step 1 — Push to GitHub

```bash
cd landroll-api
git init
git add -A
git commit -m "Landroll Leader — pilot platform"
git branch -M main
git remote add origin https://github.com/QsquaredMG/landroll-leader.git
git push -u origin main
```

A `.gitignore` is included — it excludes `node_modules/`, `data/`, `.env`,
and logs. **Never commit `.env`.** Secrets live in Railway's Variables tab.

---

## Step 2 — Deploy on Railway

1. railway.app → **New Project** → **Deploy from GitHub repo** → pick the repo.
   Nixpacks auto-detects Node and runs `npm start`. `railway.json` already
   sets the health check to `/api/health` with auto-restart on failure.
2. **Add Postgres**: in the project, **New** → **Database** → **Add PostgreSQL**.
3. Open your web service → **Variables** → add:

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Turns on the config-safety warnings |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Use Railway's reference syntax — it wires automatically |
| `ADMIN_PASSWORD` | *(long random string)* | County staff back-office password |
| `ADMIN_KEY` | *(different long random string)* | Automation/API key |
| `SITE_URL` | `https://landrollleader.com` | Used in emailed links |

Generate secrets with: `openssl rand -base64 32`

4. **Settings → Networking → Generate Domain** for a temporary
   `*.up.railway.app` URL. Deploy and confirm the log reads
   `store=postgres`.

### Verify the deploy

```bash
node smoke-test.js https://your-app.up.railway.app YOUR_ADMIN_KEY
```

Expect Postgres ✓. Email and geocoding will still warn until steps 3 and 6.

---

## Step 3 — Email (SendGrid)

Password resets and alert emails don't send until this is done.

1. Create a SendGrid account → **Settings → Sender Authentication →
   Authenticate Your Domain** for `landrollleader.com`. Add the CNAME
   records SendGrid gives you at your DNS host. **Do this properly** —
   unauthenticated senders land in spam, and a password-reset email in
   spam looks like a broken product.
2. **Settings → API Keys** → Create API Key → *Restricted Access* with only
   **Mail Send** enabled. Copy it (shown once).
3. Railway Variables:
   - `SENDGRID_API_KEY` = `SG....`
   - `EMAIL_FROM` = `Landroll Leader <alerts@landrollleader.com>`
4. Redeploy, then test: sign up a throwaway account and confirm the welcome
   email arrives; run "Forgot password?" and confirm that link works.

*(Resend works identically — set `RESEND_API_KEY` instead.)*

---

## Step 4 — Domain & DNS (Cloudflare)

Cloudflare's free tier is the single biggest scale lever here: it caches
listing responses at the edge, so a sale-morning traffic spike mostly never
reaches your server.

1. Add `landrollleader.com` to Cloudflare; update nameservers at your
   registrar to the two Cloudflare provides. (Propagation: minutes to hours.)
2. Railway → **Settings → Networking → Custom Domain** → add
   `landrollleader.com`. Railway shows a CNAME target.
3. In Cloudflare DNS, add that CNAME with the **proxy (orange cloud) ON**.
4. **SSL/TLS → Overview → Full (strict)**.
5. **Caching → Cache Rules**, add:
   - Path starts with `/api/listings` or `/api/facets` or `/api/stats` →
     **Cache eligible**, Edge TTL **60 seconds**.
   - Path starts with `/api/users` or `/api/auth` or `/api/uploads` →
     **Bypass cache** (never cache authenticated or admin routes).
6. Update `SITE_URL` in Railway to `https://landrollleader.com` and redeploy.
7. Re-run the smoke test against the real domain.

---

## Step 5 — Stripe live billing

Until this is done, paid signups create real accounts but no charges
(`billing_status: "demo"`) — which is fine for a pilot and a county demo.

1. Stripe Dashboard → activate the account (business details, bank account).
2. **Developers → API keys** → copy the **live** secret key (`sk_live_...`).
3. **Developers → Webhooks → Add endpoint**:
   - URL: `https://landrollleader.com/api/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.deleted`
   - Copy the **Signing secret** (`whsec_...`).
4. Railway Variables: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Redeploy.
5. Test with a real card on the Investor plan, then refund yourself in
   Stripe. Confirm the account's `billing_status` flips to `active`.

**Do not skip the webhook secret.** Without it the signature check is
skipped and anyone could POST a fake "payment succeeded" event.

---

## Step 6 — Geocoding setup

Until configured, map pins cluster by assessor map sheet (approximate but
spatially sensible). Two tiers, best first:

**Tier 1 — County ArcGIS parcel layer (parcel-centroid accurate).**
Find the county's public ArcGIS FeatureServer/MapServer parcel layer — ask
the county GIS office directly, or look for the county's ArcGIS REST
services directory (MARIS is a portal in front of per-county services, so
URLs differ county to county). You want a layer URL ending in a layer index,
e.g. `.../FeatureServer/0`. Then set:

- `GIS_ARCGIS_LAYER_URL` = that URL
- `GIS_ARCGIS_PARCEL_FIELD` = the attribute holding the parcel number
  (often `PARCELID`, `PARCEL_NO`, `PIN`, or similar)

Confirm the field name first:
```bash
curl "https://<layer-url>/query?where=1=1&outFields=*&resultRecordCount=1&f=json"
```
Then verify one real parcel resolves:
```bash
curl "https://<layer-url>/query?where=PARCELID='00010006000'&outFields=*&returnGeometry=true&outSR=4326&f=json"
```

**Tier 2 — US Census Geocoder (automatic fallback, no key, no setup).**
Street-level accuracy from the situs address. Runs whenever tier 1 is
unconfigured or misses.

**Run it:** back office → **◎ Geocode parcels** (200 per click, resumable,
only touches un-geocoded rows), or:
```bash
curl -X POST https://landrollleader.com/api/geocode/run \
  -H "x-admin-key: YOUR_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"limit":500}'
```
Track progress at `/api/geocode/status`. Pins switch to real coordinates
automatically as rows resolve.

> The geocoding module was written against both APIs' documented response
> shapes but could not be exercised against the live internet from the
> sandbox that built it. Verify with the curl commands above on first run.

---

## Step 7 — Operations

**Backups.** Railway Postgres has automatic backups; confirm they're on
(Postgres service → Backups). Monthly, take a manual dump you control:
```bash
pg_dump "$DATABASE_URL" > landroll-$(date +%Y%m%d).sql
```
The audit log is your evidence trail if a sale is ever challenged — treat
backups as a legal record, not just IT hygiene.

**Monitoring.** Point a free uptime monitor (UptimeRobot, Better Stack) at
`https://landrollleader.com/api/health` every 5 minutes. It returns store
mode, mailer, and listing count — a listing count that unexpectedly drops
to 0 is your loudest possible alarm.

**Before each county's sale season:**
1. Publish the new roll via the back office.
2. Run the geocoder.
3. Print the statutory notice export (`/api/export/notice.html?qr=1`).
4. Check the alert outbox actually sent (dashboard → ✉ Alert outbox).
5. Re-run `smoke-test.js`.

**Scale triggers** — you don't need to act until one of these hits:
- *Slow listing queries (>1s)* → move `/api/listings` filtering from
  in-memory `.filter()` to indexed SQL in `lib/store.js`. This is the known
  next milestone; nothing else needs to change.
- *Sustained CPU >70%* → add a Railway replica. **First** move sessions
  from in-memory `Map`s into Postgres, or logins will bounce between
  instances.
- *Multi-state, millions of rows* → dedicated `listings` table with indexes
  on `(county, status, total_opening_amount)`, and paginate in SQL.

---

## Rollback

Railway keeps every deployment: **Deployments → [previous] → Redeploy**.
Postgres data is unaffected by app rollbacks. If a bad land-roll publish is
the problem, don't roll back code — re-upload the corrected file and
publish again; the audit log records both events, which is the honest
record a county wants.
