/**
 * Landroll Leader — geocoding.
 *
 * Two-tier lookup, cheapest/most-accurate first:
 *
 *   1) County ArcGIS parcel layer (MARIS-hosted, or any county GIS office's
 *      public ArcGIS FeatureServer/MapServer). This returns the actual
 *      parcel centroid — the correct point, not an approximation — when a
 *      county's layer URL and parcel-number field are configured. This is
 *      the standard way Mississippi county GIS data is published; MARIS
 *      itself is a portal in front of per-county ArcGIS services, so the
 *      exact layer URL differs county to county and has to be sourced from
 *      that county's GIS office or MARIS listing — see README "Geocoding
 *      setup" for how to find it. Configured via GIS_ARCGIS_LAYER_URL /
 *      GIS_ARCGIS_PARCEL_FIELD (per deployment; multi-county support can
 *      key these off the county record once more than one is live).
 *
 *   2) US Census Bureau Geocoder (geocoding.geo.census.gov) — free, no API
 *      key, no rate-limit registration required, stable federal service.
 *      Falls back to the situs street address when no ArcGIS layer is
 *      configured or the parcel isn't found in it. Street-level accuracy,
 *      not parcel-centroid, but real coordinates rather than a cluster
 *      approximation.
 *
 * If both fail (or the listing has no usable address), the caller keeps
 * using the existing map_sheet-based visual clustering as a placeholder —
 * nothing breaks, coverage just improves incrementally as this runs.
 *
 * NOTE: this file makes outbound HTTP calls and was written against the
 * documented shapes of both APIs, but could not be exercised against the
 * live internet from the sandbox that built it (no general network egress
 * there). Verify with the smoke commands in README "Geocoding setup"
 * once deployed somewhere with real network access (e.g. Railway).
 */

const ARCGIS_LAYER = process.env.GIS_ARCGIS_LAYER_URL || null;       // e.g. https://.../FeatureServer/0
const ARCGIS_FIELD = process.env.GIS_ARCGIS_PARCEL_FIELD || "PARCELID";
const REQUEST_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ---------- tier 1: county ArcGIS parcel layer ---------- */
async function geocodeViaArcGIS(parcelNumber) {
  if (!ARCGIS_LAYER || !parcelNumber) return null;
  const url = `${ARCGIS_LAYER}/query?where=${encodeURIComponent(`${ARCGIS_FIELD}='${String(parcelNumber).replace(/'/g, "''")}'`)}` +
    `&outFields=*&returnGeometry=true&outSR=4326&f=json`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) return null;
    const data = await r.json();
    const feat = data?.features?.[0];
    if (!feat) return null;
    // Polygon parcel geometries: use the ring centroid (simple average — good
    // enough for a map pin, not for surveying). Point geometries pass through.
    if (feat.geometry?.x != null && feat.geometry?.y != null) {
      return { lat: feat.geometry.y, lng: feat.geometry.x, source: "arcgis_point" };
    }
    const ring = feat.geometry?.rings?.[0];
    if (ring?.length) {
      const [sx, sy] = ring.reduce(([ax, ay], [x, y]) => [ax + x, ay + y], [0, 0]);
      return { lat: sy / ring.length, lng: sx / ring.length, source: "arcgis_centroid" };
    }
    return null;
  } catch {
    return null; // timeout, network error, bad response — just fall through
  }
}

/* ---------- tier 2: US Census Bureau Geocoder (free, no key) ---------- */
async function geocodeViaCensus(address, state) {
  if (!address) return null;
  // ingest.js produces one combined situs_address string, not separate
  // city/zip fields, so we pass it as the single-line "address" parameter
  // (the Census "onelineaddress" mode) rather than the structured one.
  const params = new URLSearchParams({
    address: `${address}, ${state || "MS"}`,
    benchmark: "Public_AR_Current", format: "json",
  });
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params.toString()}`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) return null;
    const data = await r.json();
    const match = data?.result?.addressMatches?.[0];
    if (!match?.coordinates) return null;
    return { lat: match.coordinates.y, lng: match.coordinates.x, source: "census" };
  } catch {
    return null;
  }
}

/**
 * Geocode one listing. Returns { lat, lng, source } or null if nothing
 * could be resolved (caller should leave the listing on cluster fallback
 * and can retry later — county layers and the Census service both have
 * occasional transient failures).
 */
async function geocodeListing(listing) {
  const byParcel = await geocodeViaArcGIS(listing.parcel_number);
  if (byParcel) return byParcel;
  const addr = listing.situs_address;
  if (!addr) return null;
  return geocodeViaCensus(addr, listing.state || "MS");
}

module.exports = { geocodeListing, geocodeViaArcGIS, geocodeViaCensus, configured: { arcgis: !!ARCGIS_LAYER } };
