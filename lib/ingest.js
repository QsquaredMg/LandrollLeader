/**
 * Landroll Leader — land roll ingestion engine (Node port of ingest.py)
 * Parses a county's .xlsx/.csv export, maps columns, validates rows,
 * and returns clean listings + a validation report.
 */
const XLSX = require("xlsx");
const crypto = require("crypto");

/* ------------------------------------------------------------------ */
/* Canonical schema + synonym dictionary                               */
/* ------------------------------------------------------------------ */
const SYNONYMS = {
  parcel_number:        ["parcel","parcelno","parcelid","ppin","parcelnumber","taxparcel","pin"],
  parcel_display:       ["parcelformatted","parcelfmt","displayparcel"],
  owner_name_of_record: ["name","owner","owner1","ownername","taxpayer","assessedto"],
  owner_mail_1:         ["addr1","address1","mailaddr1","owneraddr"],
  owner_mail_2:         ["addr2","address2","mailaddr2"],
  owner_mail_3:         ["addr3","address3","mailaddr3"],
  situs_address:        ["location","situs","situsaddress","physicaladdress","propertyaddress","propaddr"],
  legal_description:    ["desc","legal","legaldesc","legaldescription"],
  county_tax:           ["cotax","countytax"],
  municipal_tax:        ["muntax","citytax","municipaltax"],
  school_tax:           ["ssdtax","schooltax","ssd"],
  taxes_due:            ["taxesdue","taxdue","basetax"],
  fees:                 ["fees","fee","cost","costs"],
  penalties_interest:   ["interest","penalty","penalties","penaltiesinterest","damages"],
  total_opening_amount: ["total","totdue","totaldue","openingbid","facevalue","amountdue"],
  true_value:           ["truevalue","marketvalue","fairvalue"],
  assessed_land_value:  ["assland","assessedland","landvalue"],
  assessed_improvement_value: ["assimp","assessedimp","improvementvalue","impvalue"],
  prior_sale_year_1:    ["priorsale1","prevsale1"],
  prior_sale_year_2:    ["priorsale2","prevsale2"],
  prior_buyer_1:        ["prior1soldto","prevbuyer1"],
  prior_buyer_2:        ["prior2soldto","prevbuyer2"],
  deed_book:            ["book","deedbook"],
  deed_page:            ["page","deedpage"],
  judicial_district:    ["juddist","district","judicialdistrict"],
  gis_map_number:       ["map","mapno","gismap","mapnumber","geocode"],
  homestead_exempt:     ["he","homestead","homesteadexempt"],
  land_use_code:        ["landuse","landusecode","useclass","class"],
  tax_year_delinquent:  ["taxyear","year","delinquentyear"],
  sold_to:              ["soldto","buyer","purchaser"],
  excess_bid:           ["excessbid","overbid","premium"],
  sale_date:            ["saledate"],
  prev_paid:            ["prevpaid","previouslypaid"],
  type_tax:             ["typetax","taxtype"],
};
const REQUIRED = ["parcel_number","owner_name_of_record","legal_description","total_opening_amount"];
const MERGE_RE = { legal_description: /^(desc|legal)\d+$/ };
const MONEY = new Set(["county_tax","municipal_tax","school_tax","taxes_due","fees","penalties_interest",
  "total_opening_amount","true_value","assessed_land_value","assessed_improvement_value","excess_bid"]);

const norm = (h) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* ------------------------------------------------------------------ */
/* File reading + header detection                                     */
/* ------------------------------------------------------------------ */
function readRows(buffer) {
  // SheetJS reads xlsx, xls, and csv from the same entry point
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
}

function detectHeader(rows) {
  const all = new Set(Object.values(SYNONYMS).flat());
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const hits = (rows[i] || []).filter((c) => c != null && all.has(norm(c))).length;
    if (hits >= 3) return i;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Column mapping with confidence                                      */
/* ------------------------------------------------------------------ */
function buildMapping(headers) {
  const mapping = {}; // colIndex -> { canon, confidence }
  const unmapped = [];
  headers.forEach((h, idx) => {
    if (h == null || String(h).trim() === "") return;
    const n = norm(h);
    for (const [canon, syns] of Object.entries(SYNONYMS)) {
      if (syns.includes(n)) { mapping[idx] = { canon, confidence: "high" }; return; }
    }
    for (const [canon, re] of Object.entries(MERGE_RE)) {
      if (re.test(n)) { mapping[idx] = { canon, confidence: "high-merge" }; return; }
    }
    for (const [canon, syns] of Object.entries(SYNONYMS)) {
      if (syns.some((s) => s.length > 3 && (n.includes(s) || s.includes(n)))) {
        mapping[idx] = { canon, confidence: "review" }; return;
      }
    }
    unmapped.push(String(h));
  });
  return { mapping, unmapped };
}

/* ------------------------------------------------------------------ */
/* Field cleaners                                                      */
/* ------------------------------------------------------------------ */
function cleanMoney(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Math.round(v * 100) / 100;
  const s = String(v).replace(/[$,\s]/g, "");
  if (s === "" || s === "-") return null;
  const f = Number(s);
  return Number.isFinite(f) ? Math.round(f * 100) / 100 : "ERR";
}

function cleanSitus(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{3,6})\s+(.+)$/);
  if (m) {
    const num = parseInt(m[1], 10);
    const street = m[2].trim().split(/\s+/)
      .map((w) => /^[NSEW]{1,2}$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase())
      .join(" ");
    return num === 0 ? street : `${num} ${street}`;
  }
  return String(v).trim().replace(/\w\S*/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
}

function parseCityStateZip(lines) {
  for (const line of [...lines].reverse()) {
    if (!line) continue;
    const m = String(line).trim().match(/^(.*?)[\s,]+([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
    if (m) {
      const city = m[1].replace(/\w\S*/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
      return { city, state: m[2], zip: m[3] };
    }
  }
  return { city: null, state: null, zip: null };
}

/* ------------------------------------------------------------------ */
/* Full processing pass                                                */
/* ------------------------------------------------------------------ */
function processRoll(buffer, { county = "hinds", state = "MS", mappingOverride = null } = {}) {
  const rows = readRows(buffer);
  const hIdx = detectHeader(rows);
  const headers = rows[hIdx] || [];
  let { mapping, unmapped } = buildMapping(headers);

  // Clerk-confirmed overrides from the mapping screen: { "HEADER": "canon" | null }
  if (mappingOverride) {
    headers.forEach((h, idx) => {
      const key = String(h ?? "");
      if (key in mappingOverride) {
        const canon = mappingOverride[key];
        if (canon) mapping[idx] = { canon, confidence: "confirmed" };
        else delete mapping[idx];
      }
    });
  }

  /* Multi-source targets must MERGE, not overwrite.
     Auto-detection tags DESC1..DESC8 as "high-merge", but a saved mapping or
     a clerk-confirmed mapping arrives as "confirmed" — without this pass the
     last column silently wins, and since trailing DESC columns are usually
     blank it wipes legal_description entirely. That would blank out every
     county's second-year upload, which is exactly when a saved mapping is
     used. Money targets are excluded: two columns pointing at one amount is
     a mapping mistake, and summing them would double-count, so those take
     the first non-null value instead (see the row loop). */
  const canonCounts = {};
  for (const m of Object.values(mapping)) canonCounts[m.canon] = (canonCounts[m.canon] || 0) + 1;
  for (const [idx, m] of Object.entries(mapping)) {
    if (canonCounts[m.canon] > 1 && !MONEY.has(m.canon) && m.confidence !== "high-merge") {
      mapping[idx] = { canon: m.canon, confidence: "high-merge" };
    }
  }

  const canonSet = new Set(Object.values(mapping).map((m) => m.canon));
  const missingRequired = REQUIRED.filter((r) => !canonSet.has(r));
  if (missingRequired.length) {
    return { ok: false, error: `Required columns not found: ${missingRequired.join(", ")}`,
             headers, mapping, unmapped };
  }

  const listings = [], warnings = [], blocked = [];
  const seen = new Map();

  for (let rn = hIdx + 1; rn < rows.length; rn++) {
    const row = rows[rn] || [];
    if (!row.some((c) => c != null && c !== "")) continue;

    const rec = {}, merges = {}, rowIssues = [];
    for (const [idxStr, { canon, confidence }] of Object.entries(mapping)) {
      const idx = Number(idxStr);
      let val = idx < row.length ? row[idx] : null;
      if (confidence === "high-merge") {
        (merges[canon] ||= []).push([idx, val]);
        continue;
      }
      if (MONEY.has(canon)) {
        val = cleanMoney(val);
        if (val === "ERR") { rowIssues.push(`unreadable amount in ${canon}`); val = null; }
      }
      // Multi-source non-merge target: first non-null wins, so a trailing
      // blank column can't erase a value an earlier column supplied.
      if (canonCounts[canon] > 1 && rec[canon] != null && rec[canon] !== "") continue;
      rec[canon] = val;
    }
    for (const [canon, parts] of Object.entries(merges)) {
      const joined = parts.sort((a, b) => a[0] - b[0])
        .map(([, v]) => (v == null ? "" : String(v).trim())).filter(Boolean)
        .join(" ").replace(/\s+/g, " ");
      rec[canon] = joined || null;
    }

    const pid = String(rec.parcel_number ?? "").trim();
    const dupKey = `${pid}|${rec.type_tax ?? ""}|${rec.tax_year_delinquent ?? ""}`;
    if (!pid) rowIssues.push("missing parcel_number");
    else if (seen.has(dupKey)) rowIssues.push(`duplicate of row ${seen.get(dupKey)}`);
    else seen.set(dupKey, rn + 1);

    for (const req of REQUIRED) {
      if (rec[req] == null || rec[req] === "") rowIssues.push(`missing ${req}`);
    }

    // Derive taxes_due from jurisdiction parts when absent
    const parts = [rec.county_tax, rec.municipal_tax, rec.school_tax];
    if (rec.taxes_due == null && parts.some((p) => p != null)) {
      rec.taxes_due = Math.round(parts.reduce((a, b) => a + (b || 0), 0) * 100) / 100;
    }
    // Face-value cross-check -> itemize prior-year balances instead of just warning
    const comp = (rec.taxes_due || 0) + (rec.fees || 0) + (rec.penalties_interest || 0);
    rec.prior_years_included_amount = null;
    if (rec.total_opening_amount != null && comp) {
      const diff = Math.round((rec.total_opening_amount - comp) * 100) / 100;
      if (diff > 0.05) {
        rec.prior_years_included_amount = diff;   // rolled-in prior-year taxes
      } else if (diff < -0.05) {
        rowIssues.push(`total ${rec.total_opening_amount} is less than components ${comp.toFixed(2)} — check the export`);
      }
    }

    // Enrichments
    rec.situs_address = cleanSitus(rec.situs_address);
    const csz = parseCityStateZip([rec.owner_mail_1, rec.owner_mail_2, rec.owner_mail_3]);
    rec.owner_mail_city = csz.city; rec.owner_mail_state = csz.state; rec.owner_mail_zip = csz.zip;
    rec.owner_out_of_state = Boolean(csz.state && csz.state !== state);
    rec.repeat_delinquent_years = [rec.prior_sale_year_1, rec.prior_sale_year_2]
      .filter((y) => y != null && y !== "").map(Number).sort();
    rec.repeat_delinquent = rec.repeat_delinquent_years.length > 0;
    rec.homestead_exempt = String(rec.homestead_exempt ?? "").toUpperCase() === "Y";
    rec.county = county; rec.state = state;
    rec.needs_geocode = !rec.gis_map_number && !rec.situs_address;
    // Map-sheet clustering key: leading digits of the county GIS map number group
    // parcels that sit on the same assessor map sheet (true GIS geocoding replaces this)
    rec.map_sheet = rec.gis_map_number ? String(rec.gis_map_number).slice(0, 4) : null;
    rec.status = rec.sold_to
      ? (/^STATE OF MISS/i.test(String(rec.sold_to)) ? "struck_to_state" : "sold")
      : (rec.prev_paid ? "prev_paid" : "active");
    rec.source_row = rn + 1;

    const hard = rowIssues.filter((i) => /duplicate|missing|unreadable/.test(i));
    if (hard.length) {
      blocked.push({ row: rn + 1, issues: rowIssues,
        raw: Object.fromEntries(headers.map((h, i) => [String(h ?? `col${i}`), row[i] ?? ""])) });
    } else {
      if (rowIssues.length) warnings.push({ row: rn + 1, parcel: pid, warnings: rowIssues });
      listings.push(rec);
    }
  }

  const mappingByHeader = Object.fromEntries(
    Object.entries(mapping).map(([i, m]) => [String(headers[i]), { maps_to: m.canon, confidence: m.confidence }])
  );

  return {
    ok: true,
    file_sha256: crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16),
    headers, mapping: mappingByHeader, unmapped,
    listings, warnings, blocked,
    report: {
      rows_accepted: listings.length,
      rows_blocked: blocked.length,
      rows_with_warnings: warnings.length,
      needs_geocode: listings.filter((l) => l.needs_geocode).length,
      repeat_delinquent: listings.filter((l) => l.repeat_delinquent).length,
      multi_year_itemized: listings.filter((l) => l.prior_years_included_amount).length,
      homestead_parcels: listings.filter((l) => l.homestead_exempt).length,
      out_of_state_owners: listings.filter((l) => l.owner_out_of_state).length,
      unmapped_columns: unmapped,
      warnings_sample: warnings.slice(0, 25),
      blocked_sample: blocked.slice(0, 25).map((b) => ({ row: b.row, issues: b.issues })),
    },
  };
}

module.exports = { processRoll, SYNONYMS, REQUIRED };
