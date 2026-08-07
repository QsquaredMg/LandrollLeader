/**
 * Landroll Leader — persistence layer.
 *
 * Two modes, same public API (db, persist, audit) so server.js never
 * changes regardless of backend:
 *
 *   - DATABASE_URL set  -> Postgres. Each collection is a row in
 *     kv_store(name text primary key, value jsonb, updated_at timestamptz),
 *     written with an atomic upsert. This is the durability + multi-instance
 *     fix: concurrent Railway replicas share one source of truth, backups
 *     are real (pg_dump / Railway's automatic backups), and a redeploy
 *     can't lose data the way a container-local file can.
 *
 *   - DATABASE_URL unset -> JSON-on-disk (original pilot behavior), for
 *     local development with zero setup.
 *
 * NOTE ON SCALE: this still loads each collection fully into memory (as
 * the pilot always has) and server.js filters `db.listings` in JS. That's
 * fine through the multi-county pilot phase (low hundreds of thousands of
 * rows). The next scaling milestone — once several states are live and
 * `listings` is multi-million rows — is moving the hot filter queries
 * (GET /api/listings) to real indexed SQL instead of in-memory `.filter()`.
 * This module is where that change would land; server.js would not need
 * to change its call sites (db.listings would become a query result set
 * instead of a full in-memory array). Not required for the current launch.
 */
const fs = require("fs");
const path = require("path");

const COLLECTIONS = [
  "counties", "sale_events", "listings", "audit",
  "users", "subscribers", "alerts", "outbox", "password_resets",
];

const DEFAULTS = {
  counties: [
    { id: "hinds", state: "MS", name: "Hinds", sale_month_rule: "august_last_monday",
      redemption_months: 24, interest_rate_monthly: 1.5, saved_mapping: null },
  ],
  sale_events: [
    { id: "hinds-2025", county_id: "hinds", sale_date: "2025-08-25", status: "closed", published_at: null },
    { id: "hinds-2026", county_id: "hinds", sale_date: "2026-08-31", status: "draft", published_at: null },
  ],
  listings: [], audit: [], users: [], subscribers: [], alerts: [], outbox: [], password_resets: [],
};

const USE_PG = !!process.env.DATABASE_URL;

let db, persist, audit, ready, shutdown;

if (USE_PG) {
  /* ============================== Postgres ============================== */
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 10),
  });
  pool.on("error", (err) => console.error("[pg] idle client error:", err.message));

  const initSql = `
    CREATE TABLE IF NOT EXISTS kv_store (
      name text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  db = {}; // populated by init()

  async function init() {
    await pool.query(initSql);
    for (const name of COLLECTIONS) {
      const { rows } = await pool.query("SELECT value FROM kv_store WHERE name = $1", [name]);
      if (rows.length) {
        db[name] = rows[0].value;
      } else {
        db[name] = DEFAULTS[name] ?? [];
        await pool.query(
          "INSERT INTO kv_store (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
          [name, JSON.stringify(db[name])]
        );
      }
    }
    console.log(`[store] Postgres connected — ${COLLECTIONS.length} collections loaded (${db.listings.length} listings)`);
  }

  persist = (which) => {
    // Fire-and-forget upsert; in-memory db[which] is already updated by the
    // caller (matches the JSON-store's synchronous feel) — failures are
    // logged, not thrown, so a transient DB blip never crashes a request
    // that already succeeded from the caller's point of view.
    pool.query(
      "INSERT INTO kv_store (name, value, updated_at) VALUES ($1, $2, now()) " +
      "ON CONFLICT (name) DO UPDATE SET value = $2, updated_at = now()",
      [which, JSON.stringify(db[which])]
    ).catch((e) => console.error(`[pg] persist("${which}") failed:`, e.message));
  };

  audit = (actor, action, detail) => {
    db.audit.unshift({ at: new Date().toISOString(), actor, action, detail });
    db.audit = db.audit.slice(0, 5000);
    persist("audit");
  };

  ready = init(); // server.js awaits this before listening
  shutdown = () => pool.end();

} else {
  /* ============================== JSON files ============================== */
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = (name) => path.join(DATA_DIR, `${name}.json`);
  const load = (name, fallback) => {
    try { return JSON.parse(fs.readFileSync(file(name), "utf8")); }
    catch { return fallback; }
  };
  const save = (name, value) => {
    const tmp = file(name) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file(name));
  };

  db = {};
  for (const name of COLLECTIONS) db[name] = load(name, DEFAULTS[name] ?? []);

  persist = (which) => save(which, db[which]);

  audit = (actor, action, detail) => {
    db.audit.unshift({ at: new Date().toISOString(), actor, action, detail });
    db.audit = db.audit.slice(0, 5000);
    persist("audit");
  };

  console.log(`[store] JSON file mode (${DATA_DIR}) — set DATABASE_URL to use Postgres`);
  ready = Promise.resolve();
  shutdown = () => Promise.resolve();
}

module.exports = { db, persist, audit, ready, shutdown, usingPostgres: USE_PG };
