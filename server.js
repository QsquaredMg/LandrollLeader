/**
 * Landroll Leader API
 * -------------------
 * The upload → map → validate → publish flow behind the admin back office,
 * plus the public listings API that powers the map-and-cards site.
 *
 *   POST /api/uploads                 (admin) stage a land roll file
 *   PUT  /api/uploads/:id/mapping     (admin) apply clerk-confirmed mapping, revalidate
 *   POST /api/uploads/:id/publish     (admin) publish accepted rows to a sale event
 *   GET  /api/uploads/:id/errors.csv  (admin) blocked rows for fix-and-reupload
 *   GET  /api/listings                (public) filterable listings
 *   GET  /api/listings/:parcel        (public) one parcel
 *   POST /api/listings/:parcel/status (admin) mark paid / reactivate
 *   GET  /api/sale-events | /api/counties | /api/audit | /api/stats
 *
 * Auth (pilot): admin routes require header  x-admin-key: $ADMIN_KEY
 */
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { processRoll } = require("./lib/ingest");
const { db, persist, audit, ready: storeReady, shutdown: storeShutdown, usingPostgres } = require("./lib/store");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Railway/most PaaS terminate TLS in front of the app
app.use((req, res, next) => {   // webhook needs the raw body for signature verification
  if (req.path === "/api/billing/webhook") return next();
  express.json({ limit: "2mb" })(req, res, next);
});
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});
app.use(express.static("public")); // drop landroll-leader.html in /public to serve the site

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xlsm|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error("Only .xlsx, .xlsm, or .csv files are accepted"), ok);
  },
});

/* =========================================================
   Auth — password-protected back office
   Browser: POST /api/auth/login -> httpOnly session cookie (8h)
   Automation: x-admin-key header ($ADMIN_KEY) still accepted
   ========================================================= */
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-key";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "landroll-pilot";
if (!process.env.ADMIN_PASSWORD) {
  console.warn("WARNING: ADMIN_PASSWORD not set — using the pilot default. Set it before any real deployment.");
}
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();      // token -> { actor, expires }
const loginAttempts = new Map(); // ip -> { fails, lockedUntil }

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const passwordOk = (p) => {
  try { return crypto.timingSafeEqual(sha(p), sha(ADMIN_PASSWORD)); } catch { return false; }
};
function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
function sessionOf(req) {
  const t = getCookie(req, "ll_session");
  const s = t && sessions.get(t);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(t); return null; }
  return s;
}
setInterval(() => { const now = Date.now();
  for (const [t, s] of sessions) if (now > s.expires) sessions.delete(t); }, 15 * 60 * 1000).unref();

app.post("/api/auth/login", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
  const a = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  if (Date.now() < a.lockedUntil) {
    return res.status(429).json({ error: `Too many attempts — locked for ${Math.ceil((a.lockedUntil - Date.now()) / 60000)} more minute(s).` });
  }
  const { password, name } = req.body || {};
  if (!passwordOk(password)) {
    a.fails += 1;
    if (a.fails >= 5) { a.lockedUntil = Date.now() + 15 * 60 * 1000; a.fails = 0; }
    loginAttempts.set(ip, a);
    audit("system", "auth.login_failed", { ip });
    return res.status(401).json({ error: "Incorrect password." });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  const actor = (name || "clerk").slice(0, 60);
  sessions.set(token, { actor, expires: Date.now() + SESSION_TTL_MS });
  const secure = (req.headers["x-forwarded-proto"] || req.protocol) === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `ll_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
  audit(actor, "auth.login", { ip });
  res.json({ ok: true, actor });
});

app.post("/api/auth/logout", (req, res) => {
  const t = getCookie(req, "ll_session");
  const s = t && sessions.get(t);
  if (t) sessions.delete(t);
  if (s) audit(s.actor, "auth.logout", {});
  res.setHeader("Set-Cookie", "ll_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const s = sessionOf(req);
  res.json(s ? { authenticated: true, actor: s.actor } : { authenticated: false });
});

function requireAdmin(req, res, next) {
  const s = sessionOf(req);
  if (s) {
    if (!req.headers["x-actor"]) req.headers["x-actor"] = s.actor;  // audit attribution
    return next();
  }
  if (req.get("x-admin-key") === ADMIN_KEY) return next();          // automation path
  return res.status(401).json({ error: "Sign in required." });
}

/* =========================================================
   General rate limiting — fixed-window per IP, in-memory.
   Auth routes already have their own 5-strikes lockout; this is a coarser
   net over every route so no single client can hammer the API or the
   outbound-mail path. Fine for a single instance; if you scale to multiple
   Railway replicas behind Cloudflare, Cloudflare's own rate limiting (free
   tier) covers you at the edge regardless of instance count.
   ========================================================= */
const rateBuckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = (req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "?") + ":" + req.path;
    const now = Date.now();
    const b = rateBuckets.get(key);
    if (!b || now > b.resetAt) { rateBuckets.set(key, { count: 1, resetAt: now + windowMs }); return next(); }
    if (b.count >= max) return res.status(429).json({ error: "Too many requests — slow down and try again shortly." });
    b.count++; next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(k); }, 5 * 60 * 1000).unref();
app.use("/api/", rateLimit(240, 60 * 1000));               // 240 req/min/IP general ceiling
app.use("/api/users/signup", rateLimit(8, 60 * 60 * 1000)); // 8 signups/hr/IP
app.use("/api/alerts", rateLimit(20, 60 * 60 * 1000));      // 20 saved alerts/hr/IP
app.use("/api/uploads", rateLimit(30, 60 * 60 * 1000));     // 30 upload attempts/hr/IP

/* ---------- staged uploads live in memory until published ---------- */
const staged = new Map(); // uploadId -> { buffer, county_id, sale_event_id, result, created_at }

/* =========================================================
   1) STAGE: clerk drops the file (admin screen step 1-2)
   ========================================================= */
app.post("/api/uploads", requireAdmin, upload.single("file"), (req, res) => {
  const { county_id = "hinds", sale_event_id } = req.body;
  const county = db.counties.find((c) => c.id === county_id);
  if (!county) return res.status(400).json({ error: `Unknown county '${county_id}'` });
  if (!req.file) return res.status(400).json({ error: "Attach the land roll as form field 'file'" });

  const ev = db.sale_events.find((e) => e.id === sale_event_id && e.county_id === county_id);
  if (!ev) return res.status(400).json({ error: `Unknown sale_event_id for this county` });

  const result = processRoll(req.file.buffer, {
    county: county.id, state: county.state,
    mappingOverride: county.saved_mapping, // last year's confirmed mapping applies automatically
  });
  if (!result.ok) return res.status(422).json({ error: result.error, mapping: result.mapping, unmapped: result.unmapped });

  const id = crypto.randomUUID();
  staged.set(id, { buffer: req.file.buffer, county_id, sale_event_id, result, created_at: Date.now() });
  audit(req.get("x-actor") || "county-admin", "upload.staged",
    { upload_id: id, file: req.file.originalname, sha256: result.file_sha256, rows: result.report.rows_accepted + result.report.rows_blocked });

  res.status(201).json({
    upload_id: id,
    used_saved_mapping: Boolean(county.saved_mapping),
    mapping: result.mapping,          // header -> { maps_to, confidence } for the mapping screen
    unmapped: result.unmapped,
    validation: result.report,        // live preview numbers for the same screen
  });
});

/* =========================================================
   2) MAP: clerk confirms/edits mapping (admin screen step 2-3)
      body: { "LEGAL9": "legal_description", "MISC2": null }
   ========================================================= */
app.put("/api/uploads/:id/mapping", requireAdmin, (req, res) => {
  const s = staged.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Upload not found or expired" });
  const county = db.counties.find((c) => c.id === s.county_id);

  s.result = processRoll(s.buffer, {
    county: county.id, state: county.state,
    mappingOverride: { ...(county.saved_mapping || {}),
      ...Object.fromEntries(Object.entries(req.body || {}).map(([h, c]) => [h, c])) },
  });
  if (!s.result.ok) return res.status(422).json({ error: s.result.error });

  audit(req.get("x-actor") || "county-admin", "upload.mapping_confirmed", { upload_id: req.params.id });
  res.json({ upload_id: req.params.id, mapping: s.result.mapping, validation: s.result.report });
});

/* =========================================================
   3) ERRORS: blocked rows as CSV for fix-and-reupload
   ========================================================= */
app.get("/api/uploads/:id/errors.csv", requireAdmin, (req, res) => {
  const s = staged.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Upload not found or expired" });
  const blocked = s.result.blocked;
  if (!blocked.length) return res.status(204).end();
  const headers = [...Object.keys(blocked[0].raw), "ISSUES"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(",")];
  for (const b of blocked) lines.push([...Object.values(b.raw), b.issues.join("; ")].map(esc).join(","));
  res.type("text/csv").attachment("error_rows.csv").send(lines.join("\n"));
});

/* =========================================================
   4) PUBLISH: type-the-county-name confirm (admin screen step 4)
      body: { confirm: "Hinds" }
   ========================================================= */
app.post("/api/uploads/:id/publish", requireAdmin, (req, res) => {
  const s = staged.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Upload not found or expired" });
  const county = db.counties.find((c) => c.id === s.county_id);

  if (String(req.body?.confirm || "").trim().toLowerCase() !== county.name.toLowerCase()) {
    return res.status(400).json({ error: `Type the county name ("${county.name}") to confirm publishing` });
  }

  const ev = db.sale_events.find((e) => e.id === s.sale_event_id);
  const publishedAt = new Date().toISOString();

  // Replace any prior listings for this sale event (re-publish = full swap, audit keeps history)
  db.listings = db.listings.filter((l) => l.sale_event_id !== ev.id);
  for (const l of s.result.listings) {
    db.listings.push({ ...l, sale_event_id: ev.id, published_at: publishedAt,
      redemption_deadline: addMonths(ev.sale_date, county.redemption_months) });
  }
  ev.status = "published"; ev.published_at = publishedAt;

  county.saved_mapping = Object.fromEntries(          // one-click next year
    Object.entries(s.result.mapping).map(([h, m]) => [h, m.maps_to]));

  persist("listings"); persist("sale_events"); persist("counties");
  audit(req.get("x-actor") || "county-admin", "sale_event.published", {
    sale_event: ev.id, parcels: s.result.listings.length,
    file_sha256: s.result.file_sha256, published_at: publishedAt,
  });
  matchAlertsForPublish(ev.id, db.listings.filter((l) => l.sale_event_id === ev.id), req);
  staged.delete(req.params.id);

  res.json({ published: true, sale_event: ev.id, parcels: s.result.listings.length,
             published_at: publishedAt, public_url: `/ms/${county.id}` });
});

function addMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/* =========================================================
   PUBLIC LISTINGS API (powers the map + cards)
   ========================================================= */
app.get("/api/listings", (req, res) => {
  const { county, status, q, min_total, max_total, repeat_delinquent,
          out_of_state, land_use, page = 1, per_page = 50, sort = "total_desc" } = req.query;
  let list = db.listings;

  if (county) list = list.filter((l) => l.county === county);
  if (status) list = list.filter((l) => l.status === status);
  if (land_use) list = list.filter((l) => String(l.land_use_code) === String(land_use));
  if (repeat_delinquent === "true") list = list.filter((l) => l.repeat_delinquent);
  if (out_of_state === "true") list = list.filter((l) => l.owner_out_of_state);
  if (min_total) list = list.filter((l) => (l.total_opening_amount || 0) >= Number(min_total));
  if (max_total) list = list.filter((l) => (l.total_opening_amount || 0) <= Number(max_total));
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((l) =>
      [l.parcel_number, l.owner_name_of_record, l.situs_address, l.legal_description]
        .some((f) => f && String(f).toLowerCase().includes(needle)));
  }

  const sorters = {
    total_desc: (a, b) => (b.total_opening_amount || 0) - (a.total_opening_amount || 0),
    total_asc:  (a, b) => (a.total_opening_amount || 0) - (b.total_opening_amount || 0),
    value_desc: (a, b) => (b.true_value || 0) - (a.true_value || 0),
  };
  list = [...list].sort(sorters[sort] || sorters.total_desc);

  const p = Math.max(1, Number(page)), pp = Math.min(200, Number(per_page));
  res.json({ total: list.length, page: p, per_page: pp,
             results: list.slice((p - 1) * pp, p * pp) });
});

app.get("/api/listings/:parcel", (req, res) => {
  const l = db.listings.find((x) => x.parcel_number === req.params.parcel);
  if (!l) return res.status(404).json({ error: "Parcel not found" });
  res.json(l);
});

/* Mark paid / reactivate — flags publicly in seconds, always audited */
app.post("/api/listings/:parcel/status", requireAdmin, (req, res) => {
  const l = db.listings.find((x) => x.parcel_number === req.params.parcel);
  if (!l) return res.status(404).json({ error: "Parcel not found" });
  const next = req.body?.status;
  if (!["active", "paid_before_sale", "sold", "struck_to_state", "prev_paid"].includes(next)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const prev = l.status; l.status = next; l.status_changed_at = new Date().toISOString();
  persist("listings");
  audit(req.get("x-actor") || "county-admin", "listing.status_changed",
    { parcel: l.parcel_number, from: prev, to: next });
  res.json({ parcel: l.parcel_number, from: prev, to: next });
});

/* =========================================================
   Reference + platform endpoints
   ========================================================= */
app.get("/api/counties", (_req, res) => res.json(db.counties.map(({ saved_mapping, ...c }) => c)));
app.get("/api/sale-events", (_req, res) => res.json(db.sale_events));
app.get("/api/audit", requireAdmin, (_req, res) => res.json(db.audit.slice(0, 200)));
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, store: usingPostgres ? "postgres" : "json-file",
    mailer: process.env.EMAIL_PROVIDER || (process.env.SENDGRID_API_KEY ? "sendgrid" : process.env.RESEND_API_KEY ? "resend" : "console"),
    listings: db.listings.length, uptime_s: Math.round(process.uptime()) });
});
app.get("/api/stats", (_req, res) => {
  const L = db.listings;
  res.json({
    listings: L.length,
    active: L.filter((l) => l.status === "active").length,
    repeat_delinquent: L.filter((l) => l.repeat_delinquent).length,
    out_of_state_owners: L.filter((l) => l.owner_out_of_state).length,
    homestead: L.filter((l) => l.homestead_exempt).length,
    median_face_value: median(L.map((l) => l.total_opening_amount).filter(Boolean)),
  });
});
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }


/* =========================================================
   Facets — data-driven filter options for the public UI
   ========================================================= */
app.get("/api/facets", (req, res) => {
  const county = req.query.county;
  let L = db.listings;
  if (county) L = L.filter((l) => l.county === county);
  const count = (key) => {
    const m = new Map();
    for (const l of L) { const v = l[key] ?? "unknown"; m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
  };
  res.json({
    status: count("status"),
    land_use: count("land_use_code").slice(0, 10),
    judicial_district: count("judicial_district"),
    total_range: L.length ? {
      min: Math.min(...L.map((l) => l.total_opening_amount || 0)),
      max: Math.max(...L.map((l) => l.total_opening_amount || 0)),
    } : null,
  });
});

/* =========================================================
   Billing — Stripe Checkout (live with STRIPE_SECRET_KEY, demo mode without)
   ========================================================= */
const PLANS = {
  investor: { name: "Investor", amount: 4900, interval: "month" },
  pro:      { name: "Pro desk", amount: 19900, interval: "month" },
};
// Railway holds the live key as STRIPE_RESTRICTED_KEY; accept either name.
const stripeKey = () => process.env.STRIPE_SECRET_KEY || process.env.STRIPE_RESTRICTED_KEY || "";
// Paid tiers unlock only once billing is settled (or comped by an admin / demo mode with no Stripe).
const PAID_OK = new Set(["active", "demo", "comp"]);
db.subscribers = db.subscribers || [];

/* =========================================================
   Investor accounts — signup (with tier), login, sessions
   Passwords: scrypt + per-user salt. Cookie: ll_user (30d).
   Tiers: browse (free) | investor ($49/mo) | pro ($199/mo)
   ========================================================= */
db.users = db.users || [];
const userSessions = new Map(); // token -> { userId, expires }
const USER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TIERS = ["browse", "investor", "pro"];

const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString("hex");
function userOf(req) {
  const t = getCookie(req, "ll_user");
  const s = t && userSessions.get(t);
  if (!s) return null;
  if (Date.now() > s.expires) { userSessions.delete(t); return null; }
  return db.users.find((u) => u.id === s.userId) || null;
}
function setUserCookie(req, res, token) {
  const secure = (req.headers["x-forwarded-proto"] || req.protocol) === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `ll_user=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${USER_TTL_MS / 1000}${secure}`);
}
function requireTier(min) {
  return (req, res, next) => {
    const u = userOf(req);
    if (!u) return res.status(401).json({ error: "Sign in required.", upgrade: min });
    if (TIERS.indexOf(u.tier) < TIERS.indexOf(min)) {
      return res.status(403).json({ error: `This feature is on the ${min} plan.`, upgrade: min, current: u.tier });
    }
    if (min !== "browse" && !PAID_OK.has(u.billing_status)) {
      return res.status(402).json({ error: "Finish checkout to unlock this feature.", upgrade: u.tier, current: u.tier,
        billing_status: u.billing_status });
    }
    req.user = u; next();
  };
}

app.post("/api/users/signup", (req, res) => {
  const { email, password, name, tier } = req.body || {};
  const em = String(email || "").trim().toLowerCase();
  if (!/.+@.+\..+/.test(em)) return res.status(400).json({ error: "Valid email required." });
  if (String(password || "").length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (!TIERS.includes(tier)) return res.status(400).json({ error: "Pick a plan: browse, investor, or pro." });
  if (db.users.some((u) => u.email === em)) return res.status(409).json({ error: "An account with this email already exists — sign in instead." });
  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: crypto.randomUUID(), email: em, name: String(name || "").slice(0, 80) || em.split("@")[0],
    salt, password_hash: hashPw(password, salt), tier,
    billing_status: tier === "browse" ? "n/a" : (stripeKey() ? "pending_checkout" : "demo"),
    created_at: new Date().toISOString(),
  };
  db.users.push(user); persist("users");
  const token = crypto.randomBytes(32).toString("hex");
  userSessions.set(token, { userId: user.id, expires: Date.now() + USER_TTL_MS });
  setUserCookie(req, res, token);
  audit("system", "user.signup", { email: em, tier });
  queueMail({ type: "welcome", to: em, subject: "Welcome to Landroll Leader",
    html: mailer.welcomeEmail({ site: siteUrl(req), name: user.name, tier }) });
  res.status(201).json({ ok: true, email: em, name: user.name, tier, billing_status: user.billing_status });
});

app.post("/api/users/login", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
  const a = loginAttempts.get("u:" + ip) || { fails: 0, lockedUntil: 0 };
  if (Date.now() < a.lockedUntil) {
    return res.status(429).json({ error: `Too many attempts — locked for ${Math.ceil((a.lockedUntil - Date.now()) / 60000)} more minute(s).` });
  }
  const em = String(req.body?.email || "").trim().toLowerCase();
  const u = db.users.find((x) => x.email === em);
  const good = u && crypto.timingSafeEqual(
    Buffer.from(hashPw(req.body?.password || "", u ? u.salt : "x"), "hex"),
    Buffer.from(u ? u.password_hash : hashPw("", "x"), "hex"));
  if (!good) {
    a.fails += 1;
    if (a.fails >= 5) { a.lockedUntil = Date.now() + 15 * 60 * 1000; a.fails = 0; }
    loginAttempts.set("u:" + ip, a);
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  loginAttempts.delete("u:" + ip);
  const token = crypto.randomBytes(32).toString("hex");
  userSessions.set(token, { userId: u.id, expires: Date.now() + USER_TTL_MS });
  setUserCookie(req, res, token);
  audit("system", "user.login", { email: em });
  res.json({ ok: true, email: u.email, name: u.name, tier: u.tier });
});

db.password_resets = db.password_resets || [];
app.post("/api/users/forgot", (req, res) => {
  const em = String(req.body?.email || "").trim().toLowerCase();
  const u = db.users.find((x) => x.email === em);
  if (u) {
    const token = crypto.randomBytes(32).toString("hex");
    db.password_resets.push({ token, user_id: u.id, expires: Date.now() + 30 * 60 * 1000, used: false });
    persist("password_resets");
    const link = `${siteUrl(req)}/#reset=${token}`;
    queueMail({ type: "reset", to: em, subject: "Reset your Landroll Leader password",
      html: mailer.resetEmail({ site: siteUrl(req), link }) });
    audit("system", "user.reset_requested", { email: em });
  }
  // Same response either way — no account enumeration
  res.json({ ok: true, message: "If that email has an account, a reset link is on its way." });
});

app.post("/api/users/reset", (req, res) => {
  const { token, password } = req.body || {};
  if (String(password || "").length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const t = db.password_resets.find((x) => x.token === token);
  if (!t || t.used || Date.now() > t.expires) {
    return res.status(400).json({ error: "This reset link is invalid or has expired — request a new one." });
  }
  const u = db.users.find((x) => x.id === t.user_id);
  if (!u) return res.status(400).json({ error: "Account not found." });
  u.salt = crypto.randomBytes(16).toString("hex");
  u.password_hash = hashPw(password, u.salt);
  t.used = true;
  for (const [tok, s] of userSessions) if (s.userId === u.id) userSessions.delete(tok); // sign out everywhere
  persist("users"); persist("password_resets");
  audit("system", "user.password_reset", { email: u.email });
  res.json({ ok: true, message: "Password updated — sign in with your new password." });
});

app.post("/api/users/logout", (req, res) => {
  const t = getCookie(req, "ll_user");
  if (t) userSessions.delete(t);
  res.setHeader("Set-Cookie", "ll_user=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/users/me", (req, res) => {
  const u = userOf(req);
  res.json(u ? { authenticated: true, email: u.email, name: u.name, tier: u.tier, billing_status: u.billing_status }
             : { authenticated: false });
});

app.post("/api/billing/checkout", async (req, res) => {
  const plan = PLANS[req.body?.plan];
  if (!plan) return res.status(400).json({ error: "Unknown plan" });
  const key = stripeKey();
  const buyer = userOf(req);
  if (!key) {
    return res.json({ demo: true, plan: req.body.plan,
      message: `Demo mode: set STRIPE_SECRET_KEY to create a real Checkout session for ${plan.name} ($${(plan.amount/100).toFixed(0)}/${plan.interval}).` });
  }
  try {
    const site = process.env.SITE_URL || `${req.protocol}://${req.get("host")}`;
    const body = new URLSearchParams({
      mode: "subscription",
      success_url: `${site}/?checkout=success`,
      cancel_url: `${site}/?checkout=cancelled`,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(plan.amount),
      "line_items[0][price_data][recurring][interval]": plan.interval,
      "line_items[0][price_data][product_data][name]": `Landroll Leader — ${plan.name}`,
      "metadata[plan]": req.body.plan,
      "subscription_data[metadata][plan]": req.body.plan,
      allow_promotion_codes: "true",
    });
    if (buyer) {
      body.set("client_reference_id", buyer.id);
      body.set("customer_email", buyer.email);
      body.set("subscription_data[metadata][user_id]", buyer.id);
    }
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const session = await r.json();
    if (session.error) return res.status(502).json({ error: session.error.message });
    res.json({ url: session.url });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* Stripe webhook: records subscription lifecycle into the store + audit trail */
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    const payload = req.body.toString("utf8");
    if (secret) {
      const sig = req.get("stripe-signature") || "";
      const t = /t=(\d+)/.exec(sig)?.[1];
      const v1 = /v1=([a-f0-9]+)/.exec(sig)?.[1];
      const expected = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
      if (!t || !v1 || !crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))) {
        return res.status(400).json({ error: "Bad signature" });
      }
    }
    event = JSON.parse(payload);
  } catch { return res.status(400).json({ error: "Bad payload" }); }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const payerEmail = String(s?.customer_details?.email || s?.customer_email || "").toLowerCase();
    const u = db.users.find((x) => x.id === s.client_reference_id) || db.users.find((x) => x.email === payerEmail);
    const plan = s.metadata?.plan;
    if (u) {
      u.billing_status = "active";
      if (TIERS.includes(plan)) u.tier = plan;
      u.stripe_customer = s.customer; u.stripe_subscription = s.subscription;
      persist("users");
    }
    db.subscribers.push({ email: s.customer_details?.email, user_id: u?.id || null, plan: plan || null,
      stripe_customer: s.customer, subscription: s.subscription, since: new Date().toISOString(), status: "active" });
    persist("subscribers");
    audit("stripe", "subscription.created", { email: s.customer_details?.email });
  }
  if (event.type === "customer.subscription.deleted") {
    const sub = db.subscribers.find((x) => x.subscription === event.data.object.id);
    if (sub) { sub.status = "cancelled"; persist("subscribers"); }
    const cu = db.users.find((x) => x.stripe_subscription === event.data.object.id
      || (sub && (x.id === sub.user_id || x.email === String(sub.email || "").toLowerCase())));
    if (cu) { cu.billing_status = "cancelled"; persist("users"); }
    audit("stripe", "subscription.cancelled", { subscription: event.data.object.id });
  }
  res.json({ received: true });
});

app.get("/api/subscribers", requireAdmin, (_req, res) => res.json(db.subscribers || []));


/* =========================================================
   Shared filter helper (listings route + alert matching)
   ========================================================= */
function filterListings(list, p) {
  let out = list;
  if (p.county) out = out.filter((l) => l.county === p.county);
  if (p.status) out = out.filter((l) => l.status === p.status);
  if (p.land_use) out = out.filter((l) => String(l.land_use_code) === String(p.land_use));
  if (p.repeat_delinquent === "true") out = out.filter((l) => l.repeat_delinquent);
  if (p.out_of_state === "true") out = out.filter((l) => l.owner_out_of_state);
  if (p.min_total) out = out.filter((l) => (l.total_opening_amount || 0) >= Number(p.min_total));
  if (p.max_total) out = out.filter((l) => (l.total_opening_amount || 0) <= Number(p.max_total));
  if (p.q) {
    const n = String(p.q).toLowerCase();
    out = out.filter((l) => [l.parcel_number, l.owner_name_of_record, l.situs_address, l.legal_description]
      .some((f) => f && String(f).toLowerCase().includes(n)));
  }
  return out;
}

/* =========================================================
   Statutory-format printable notice (+ optional QR codes)
   GET /api/export/notice.html?sale_event=hinds-2025&status=active&qr=1
   ========================================================= */
const QRCode = require("qrcode");
const mailer = require("./lib/mailer");
const geo = require("./lib/geocode");
app.get("/api/export/notice.html", async (req, res) => {
  const ev = db.sale_events.find((e) => e.id === (req.query.sale_event || "")) 
          || db.sale_events.find((e) => e.status === "published");
  if (!ev) return res.status(404).send("No published sale event");
  const county = db.counties.find((c) => c.id === ev.county_id);
  const status = req.query.status || "active";
  const withQR = req.query.qr === "1";
  const site = process.env.SITE_URL || `${req.protocol}://${req.get("host")}`;

  let rows = db.listings.filter((l) => l.sale_event_id === ev.id);
  if (status !== "all") rows = rows.filter((l) => l.status === status);
  rows.sort((a, b) => String(a.parcel_number).localeCompare(String(b.parcel_number)));

  const qrs = new Map();
  if (withQR) {
    for (const l of rows) {
      qrs.set(l.parcel_number,
        await QRCode.toDataURL(`${site}/#parcel=${encodeURIComponent(l.parcel_number)}`, { margin: 0, width: 66 }));
    }
  }
  const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const money = (n) => n == null ? "" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 });

  res.type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Notice of Tax Sale — ${esc(county.name)} County, ${esc(county.state)}</title>
<style>
  body{font-family:Georgia,serif;font-size:8.4pt;line-height:1.25;margin:24px;color:#111}
  h1{font-size:13pt;text-align:center;letter-spacing:.08em;margin:0 0 2px}
  h2{font-size:9.5pt;text-align:center;font-weight:normal;margin:0 0 10px}
  .intro{font-size:8.4pt;text-align:justify;margin:0 auto 12px;max-width:760px}
  .cols{column-count:3;column-gap:18px;column-rule:1px solid #999}
  .p{break-inside:avoid;border-bottom:1px dotted #bbb;padding:3px 0;display:flex;gap:6px}
  .p img{width:34px;height:34px;flex:none}
  .n{font-weight:bold}
  .meta{font-size:7.6pt;color:#333}
  @media print{.noprint{display:none}}
  .noprint{background:#17453B;color:#fff;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-family:Helvetica,sans-serif;font-size:10pt}
</style></head><body>
<div class="noprint">Print-ready statutory-format list · ${rows.length.toLocaleString()} parcels · generated ${new Date().toISOString().slice(0,16).replace("T"," ")} — use your browser's Print dialog. Edit the introductory text to match the county's approved notice language before publication.</div>
<h1>NOTICE OF ${esc(county.name).toUpperCase()} COUNTY TAX SALE</h1>
<h2>${esc(county.name)} County, ${esc(county.state)} — Sale of ${new Date(ev.sale_date + "T00:00:00").toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"})}</h2>
<p class="intro">[COUNTY-APPROVED NOTICE LANGUAGE HERE] Notice is hereby given that, pursuant to Miss. Code Ann. § 27-41-55 et seq., the lands described below, on which taxes remain due and unpaid, will be offered for sale. Each parcel is listed with the name of the person to whom assessed, an abbreviated description, and the total amount of taxes, fees, and costs due. Scan a parcel's code to view its full listing, map, and redemption information at ${esc(site)}. This supplemental publication does not replace the official statutory notice; the official records of the county remain authoritative.</p>
<div class="cols">
${rows.map((l) => `<div class="p">${withQR ? `<img src="${qrs.get(l.parcel_number)}" alt="">` : ""}
<div><span class="n">${esc(l.parcel_display || l.parcel_number)}</span> — ${esc(l.owner_name_of_record)}<br>
<span class="meta">${esc((l.legal_description || "").slice(0, 88))} · ${money(l.total_opening_amount)}</span></div></div>`).join("\n")}
</div></body></html>`);
});

/* =========================================================
   CSV export (Investor-plan feature; open in pilot)
   GET /api/export/listings.csv?county=hinds&status=active...
   ========================================================= */
app.get("/api/export/listings.csv", (req, res, next) => {
  if (req.get("x-admin-key") === ADMIN_KEY || sessionOf(req)) return next();
  return requireTier("investor")(req, res, next);
}, (req, res) => {
  const rows = filterListings(db.listings, req.query);
  const cols = ["parcel_number","parcel_display","owner_name_of_record","owner_mail_city","owner_mail_state",
    "situs_address","legal_description","county_tax","municipal_tax","school_tax","taxes_due","fees",
    "penalties_interest","prior_years_included_amount","total_opening_amount","true_value",
    "assessed_land_value","assessed_improvement_value","repeat_delinquent","repeat_delinquent_years",
    "owner_out_of_state","homestead_exempt","judicial_district","land_use_code","deed_book","deed_page",
    "gis_map_number","status","sold_to","excess_bid","redemption_deadline"];
  const escC = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.join(",")];
  for (const l of rows) lines.push(cols.map((c) => escC(Array.isArray(l[c]) ? l[c].join("; ") : l[c])).join(","));
  audit("public", "export.csv", { rows: rows.length, filters: req.query });
  res.type("text/csv").attachment("landroll_listings.csv").send(lines.join("\n"));
});

/* =========================================================
   Buyer intelligence — who is buying this county
   ========================================================= */
app.get("/api/buyers", (req, res) => {
  const county = req.query.county || "hinds";
  const sold = db.listings.filter((l) => l.county === county && l.sold_to && l.status === "sold");
  const agg = new Map();
  for (const l of sold) {
    const a = agg.get(l.sold_to) || { buyer: l.sold_to, parcels: 0, total_face: 0, total_excess: 0 };
    a.parcels++; a.total_face += l.total_opening_amount || 0; a.total_excess += l.excess_bid || 0;
    agg.set(l.sold_to, a);
  }
  const buyers = [...agg.values()].sort((x, y) => y.parcels - x.parcels).slice(0, 25)
    .map((b) => ({ ...b, total_face: Math.round(b.total_face * 100) / 100,
      total_excess: Math.round(b.total_excess * 100) / 100,
      avg_excess: b.parcels ? Math.round((b.total_excess / b.parcels) * 100) / 100 : 0,
      share_pct: Math.round((b.parcels / sold.length) * 1000) / 10 }));
  res.json({ county, sold_parcels: sold.length, distinct_buyers: agg.size, buyers });
});

/* =========================================================
   Owner redemption estimator
   ========================================================= */
app.get("/api/listings/:parcel/redemption", (req, res) => {
  const l = db.listings.find((x) => x.parcel_number === req.params.parcel);
  if (!l) return res.status(404).json({ error: "Parcel not found" });
  const ev = db.sale_events.find((e) => e.id === l.sale_event_id);
  const county = db.counties.find((c) => c.id === l.county);
  const saleDate = new Date(ev.sale_date + "T00:00:00Z");
  const now = new Date();
  const months = Math.max(1, Math.ceil((now - saleDate) / (30.44 * 86400000)));
  const rate = (county.interest_rate_monthly || 1.5) / 100;
  const estimate = Math.round(l.total_opening_amount * (1 + rate * months) * 100) / 100;
  res.json({
    parcel: l.parcel_number, sale_date: ev.sale_date, months_elapsed: months,
    face_value: l.total_opening_amount, monthly_rate_pct: county.interest_rate_monthly,
    estimated_redemption: estimate, redemption_deadline: l.redemption_deadline,
    note: "Estimate only — interest at the statutory monthly rate on the face value. Additional statutory damages, fees, and subsequent-year taxes may apply. Contact the Chancery Clerk for the official payoff figure.",
  });
});

/* =========================================================
   Saved-search alerts: store now, match on publish, queue email
   (outbox pattern — plug SendGrid/SES into the worker later)
   ========================================================= */
db.alerts = db.alerts || []; db.outbox = db.outbox || [];
app.post("/api/alerts", (req, res) => {
  const { email, filters = {} } = req.body || {};
  if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: "Valid email required" });
  const alert = { id: crypto.randomUUID(), email, filters, created_at: new Date().toISOString(), active: true };
  db.alerts.push(alert); persist("alerts");
  audit("public", "alert.created", { email, filters });
  res.status(201).json({ id: alert.id, message: "Alert saved — you'll be emailed when matching parcels are published." });
});
app.get("/api/alerts/outbox", requireAdmin, (_req, res) => res.json(db.outbox.slice(0, 100).map(({ html, ...rest }) => rest)));

function siteUrl(req) {
  return process.env.SITE_URL || (req ? `${req.protocol}://${req.get("host")}` : "http://localhost:3000");
}
function queueMail(entry) {
  db.outbox.unshift({ id: crypto.randomUUID(), status: "queued", queued_at: new Date().toISOString(), ...entry });
  persist("outbox");
  setImmediate(processOutbox); // try to send right away
}
function matchAlertsForPublish(evId, published, req) {
  const site = siteUrl(req);
  for (const a of (db.alerts || []).filter((x) => x.active)) {
    const matches = filterListings(published, a.filters);
    if (matches.length) {
      queueMail({ type: "alert", to: a.email,
        subject: `Landroll Leader: ${matches.length} matching parcel(s) just published`,
        html: mailer.alertEmail({ site, matches, filters: a.filters, saleEvent: evId }),
        meta: { sale_event: evId, matches: matches.length } });
    }
  }
}

let outboxBusy = false;
async function processOutbox() {
  if (outboxBusy) return; outboxBusy = true;
  try {
    for (const m of db.outbox.filter((x) => x.status === "queued")) {
      const r = await mailer.deliver({ to: m.to, subject: m.subject, html: m.html });
      m.status = r.ok ? "sent" : "failed";
      m.provider = r.provider;
      if (r.ok) m.sent_at = new Date().toISOString(); else m.error = r.error;
    }
    persist("outbox");
  } finally { outboxBusy = false; }
}
setInterval(processOutbox, 60 * 1000).unref();

app.post("/api/alerts/outbox/process", requireAdmin, async (_req, res) => {
  await processOutbox();
  const c = { sent: 0, failed: 0, queued: 0 };
  for (const m of db.outbox) c[m.status] = (c[m.status] || 0) + 1;
  res.json({ provider: mailer.PROVIDER, counts: c });
});

/* =========================================================
   Geocoding — batch resolve real coordinates for listings
   POST /api/geocode/run  (admin)  { limit }
   Walks listings that have no lat/lng yet, resolves each via the county
   ArcGIS parcel layer (if configured) or the free US Census geocoder,
   and writes lat/lng/geocode_source onto the listing. Throttled, resumable,
   and safe to run repeatedly — it only touches un-geocoded rows, so a
   partial run just continues where it left off next time.
   ========================================================= */
let geocodeRunning = false;
app.post("/api/geocode/run", requireAdmin, async (req, res) => {
  if (geocodeRunning) return res.status(409).json({ error: "A geocode run is already in progress." });
  const limit = Math.min(Number(req.body?.limit) || 200, 2000);
  const pending = db.listings.filter((l) => l.lat == null && (l.parcel_number || l.situs_address)).slice(0, limit);
  if (!pending.length) {
    const done = db.listings.filter((l) => l.lat != null).length;
    return res.json({ attempted: 0, resolved: 0, already_geocoded: done, total: db.listings.length,
      message: "Nothing left to geocode." });
  }
  geocodeRunning = true;
  let resolved = 0, failed = 0;
  try {
    for (const l of pending) {
      const hit = await geo.geocodeListing(l);
      if (hit) { l.lat = hit.lat; l.lng = hit.lng; l.geocode_source = hit.source; resolved++; }
      else { l.geocode_attempted_at = new Date().toISOString(); failed++; }
      await new Promise((r) => setTimeout(r, 120)); // be polite to public GIS endpoints
    }
    persist("listings");
    audit(req.headers["x-actor"] || "admin", "geocode.run",
      { attempted: pending.length, resolved, failed, arcgis_configured: geo.configured.arcgis });
  } finally { geocodeRunning = false; }
  const total_geocoded = db.listings.filter((l) => l.lat != null).length;
  res.json({ attempted: pending.length, resolved, failed, total_geocoded, total: db.listings.length,
    arcgis_configured: geo.configured.arcgis,
    remaining: db.listings.filter((l) => l.lat == null).length });
});

app.get("/api/geocode/status", requireAdmin, (_req, res) => {
  const total = db.listings.length;
  const done = db.listings.filter((l) => l.lat != null).length;
  res.json({ total, geocoded: done, remaining: total - done,
    pct: total ? Math.round((done / total) * 1000) / 10 : 0,
    arcgis_configured: geo.configured.arcgis });
});

/* ---------- errors ---------- */
app.use((err, _req, res, _next) => {
  console.error("[unhandled route error]", err);
  res.status(400).json({ error: err.message || "Request failed." });
});

/* ---------- boot ---------- */
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

function checkProductionConfig() {
  const problems = [];
  if (IS_PROD && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "landroll-pilot")) {
    problems.push("ADMIN_PASSWORD is unset or the pilot default — back office is guessable.");
  }
  if (IS_PROD && (!process.env.ADMIN_KEY || process.env.ADMIN_KEY === "dev-key")) {
    problems.push("ADMIN_KEY is unset or the pilot default — automation key is guessable.");
  }
  if (IS_PROD && !usingPostgres) {
    problems.push("DATABASE_URL is not set — running on the JSON file store in production risks data loss on redeploy.");
  }
  if (IS_PROD && !process.env.SITE_URL) {
    problems.push("SITE_URL is not set — emailed links (password reset, alerts) may point at the wrong host.");
  }
  if (IS_PROD && stripeKey() && !process.env.STRIPE_WEBHOOK_SECRET) {
    problems.push("STRIPE_SECRET_KEY is set without STRIPE_WEBHOOK_SECRET — webhook signature is unverified.");
  }
  if (problems.length) {
    console.error("\n⚠️  PRODUCTION CONFIG WARNINGS:");
    problems.forEach((p) => console.error("   - " + p));
    console.error("   Continuing to boot, but fix these before real traffic.\n");
  }
}

let server;
storeReady
  .then(() => {
    checkProductionConfig();
    server = app.listen(PORT, () => {
      console.log(`Landroll Leader API on :${PORT} (${IS_PROD ? "production" : "development"}, store=${usingPostgres ? "postgres" : "json-file"})`);
    });
  })
  .catch((err) => {
    console.error("FATAL: store failed to initialize:", err);
    process.exit(1);
  });

/* Graceful shutdown: stop accepting new connections, let in-flight ones
   finish, close the DB pool — matters on Railway which sends SIGTERM on
   every redeploy and restart. */
function gracefulShutdown(signal) {
  console.log(`${signal} received, shutting down gracefully…`);
  if (!server) return process.exit(0);
  server.close(async () => {
    await storeShutdown();
    console.log("Shutdown complete.");
    process.exit(0);
  });
  setTimeout(() => { console.error("Forced shutdown after timeout."); process.exit(1); }, 10_000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
