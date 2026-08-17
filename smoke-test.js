#!/usr/bin/env node
/**
 * Landroll Leader — post-deploy smoke test.
 *
 *   node smoke-test.js https://your-app.up.railway.app [admin-key]
 *
 * Verifies every critical path against a LIVE deployment: health, public
 * listings, filters, auth enforcement, signup/login/logout, tier gating,
 * password reset, admin routes, and security headers. Creates a throwaway
 * test account (smoke-test+<timestamp>@landrollleader.test) and reports a
 * pass/fail summary. Exits non-zero if anything fails, so it can gate a
 * deploy in CI.
 *
 * Safe to run against production: it only creates one free "browse" account
 * and never publishes, deletes, or modifies county data.
 */
const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const ADMIN_KEY = process.argv[3] || process.env.ADMIN_KEY || "dev-key";

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = "") {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function req(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  let body = null;
  const ct = r.headers.get("content-type") || "";
  try { body = ct.includes("json") ? await r.json() : await r.text(); } catch {}
  return { status: r.status, body, headers: r.headers };
}

(async () => {
  console.log(`\nLandroll Leader smoke test → ${BASE}\n${"─".repeat(60)}`);

  /* ---- 1. Health & infrastructure ---- */
  const h = await req("/api/health");
  check("health endpoint responds", h.status === 200 && h.body?.ok === true, `status ${h.status}`);
  if (h.body?.store) console.log(`  ℹ store=${h.body.store}  mailer=${h.body.mailer}  listings=${h.body.listings}`);
  check("running on Postgres (not JSON files)", h.body?.store === "postgres",
    h.body?.store === "json-file" ? "DATABASE_URL not set — data may not survive redeploys" : "");
  check("real email provider configured", h.body?.mailer !== "console",
    h.body?.mailer === "console" ? "emails only log, never send" : "");
  check("listings are published", (h.body?.listings || 0) > 0, "no listings — publish a land roll");

  /* ---- 2. Security headers ---- */
  check("X-Content-Type-Options set", h.headers.get("x-content-type-options") === "nosniff");
  check("X-Frame-Options set", h.headers.get("x-frame-options") === "DENY");
  check("no X-Powered-By leak", !h.headers.get("x-powered-by"));
  if (BASE.startsWith("https")) {
    check("HSTS header on https", !!h.headers.get("strict-transport-security"));
  }

  /* ---- 3. Public API ---- */
  const list = await req("/api/listings?county=hinds&per_page=5");
  check("public listings return", list.status === 200 && Array.isArray(list.body?.results), `status ${list.status}`);
  const filtered = await req("/api/listings?county=hinds&repeat_delinquent=true&min_total=5000&per_page=5");
  check("filters compose", filtered.status === 200 && (filtered.body?.total ?? -1) >= 0);
  const facets = await req("/api/facets?county=hinds");
  check("facets return", facets.status === 200 && !!facets.body?.status);
  const buyers = await req("/api/buyers?county=hinds");
  check("buyer intelligence returns", buyers.status === 200 && Array.isArray(buyers.body?.buyers));

  /* ---- 4. Auth enforcement (the paywall + back office actually hold) ---- */
  const noAuth = await req("/api/audit");
  check("admin routes reject anonymous", noAuth.status === 401, `got ${noAuth.status}`);
  const csvAnon = await req("/api/export/listings.csv?county=hinds");
  check("CSV export rejects anonymous", csvAnon.status === 401, `got ${csvAnon.status}`);
  const badLogin = await req("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "definitely-not-the-password-" + Date.now() }),
  });
  check("back office rejects wrong password", badLogin.status === 401, `got ${badLogin.status}`);

  /* ---- 5. Investor signup → tier gating → logout ---- */
  const email = `smoke-test+${Date.now()}@landrollleader.test`;
  const signup = await req("/api/users/signup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "smoketest-pw-123", name: "Smoke Test", tier: "browse" }),
  });
  check("signup creates account with tier", signup.status === 201 && signup.body?.tier === "browse",
    `status ${signup.status}`);
  const cookie = (signup.headers.get("set-cookie") || "").split(";")[0];

  const dupe = await req("/api/users/signup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "another-pw-456", tier: "pro" }),
  });
  check("duplicate email rejected", dupe.status === 409, `got ${dupe.status}`);

  const badTier = await req("/api/users/signup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `x${Date.now()}@test.test`, password: "pw12345678", tier: "platinum" }),
  });
  check("invalid tier rejected", badTier.status === 400, `got ${badTier.status}`);

  const me = await req("/api/users/me", { headers: { cookie } });
  check("session cookie authenticates", me.body?.authenticated === true);

  const csvBrowse = await req("/api/export/listings.csv?county=hinds", { headers: { cookie } });
  check("browse tier blocked from CSV (403)", csvBrowse.status === 403, `got ${csvBrowse.status}`);

  const wrongPw = await req("/api/users/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "wrong-password" }),
  });
  check("wrong user password rejected", wrongPw.status === 401, `got ${wrongPw.status}`);

  const forgot = await req("/api/users/forgot", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const forgotGhost = await req("/api/users/forgot", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nobody-here@landrollleader.test" }),
  });
  check("password reset: no account enumeration",
    forgot.status === 200 && forgotGhost.status === 200 &&
    JSON.stringify(forgot.body) === JSON.stringify(forgotGhost.body));

  const logout = await req("/api/users/logout", { method: "POST", headers: { cookie } });
  const afterLogout = await req("/api/users/me", { headers: { cookie } });
  check("logout invalidates session", logout.status === 200 && afterLogout.body?.authenticated === false);

  /* ---- 6. Admin key path (automation) ---- */
  const adminAudit = await req("/api/audit", { headers: { "x-admin-key": ADMIN_KEY } });
  check("admin key authenticates automation", adminAudit.status === 200 && Array.isArray(adminAudit.body),
    `status ${adminAudit.status} (check the admin-key argument)`);
  const geoStatus = await req("/api/geocode/status", { headers: { "x-admin-key": ADMIN_KEY } });
  if (geoStatus.status === 200) {
    console.log(`  ℹ geocoded: ${geoStatus.body.geocoded}/${geoStatus.body.total} (${geoStatus.body.pct}%)` +
      `  arcgis=${geoStatus.body.arcgis_configured}`);
  }

  /* ---- 7. Legal pages (required before taking payments) ---- */
  const terms = await req("/legal/terms.html");
  const privacy = await req("/legal/privacy.html");
  check("Terms of Service page served", terms.status === 200);
  check("Privacy Policy page served", privacy.status === 200);

  /* ---- summary ---- */
  console.log(results.join("\n"));
  console.log("─".repeat(60));
  console.log(`${pass} passed, ${fail} failed\n`);
  if (fail) {
    console.log("Fix the ✗ items before announcing the site. Warnings about");
    console.log("Postgres/email/geocoding are expected on a fresh pilot deploy.\n");
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nSmoke test crashed:", e.message, "\n"); process.exit(1); });
