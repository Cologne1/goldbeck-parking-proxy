// goldbeck-proxy.js
require('dotenv/config');
const express = require('express');
const { request } = require('undici');

const app = express();
app.use(express.json());

// ──────────────────────────────────────────────────────────────────────────────
// ENV
// ──────────────────────────────────────────────────────────────────────────────
const BASE_URL   = process.env.GB_BASE_URL || 'https://control.goldbeck-parking.de/ipaw';
const GB_USER    = process.env.GB_USER || process.env.GB_USERNAME || '';
const GB_PASS    = process.env.GB_PASS || process.env.GB_PASSWORD || '';
const PORT       = process.env.PORT || 3030;

// ──────────────────────────────────────────────────────────────────────────────
/** Helper: HTTP GET mit BasicAuth und JSON-Parsing */
async function gbGet(path, { searchParams } = {}) {
  const url = new URL(path, BASE_URL);
  if (searchParams) Object.entries(searchParams).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const res = await request(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: 'Basic ' + Buffer.from(`${GB_USER}:${GB_PASS}`).toString('base64'),
    },
  });

  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new Error(`GB GET ${url} → ${res.statusCode}: ${text}`);
  }
  const ct = res.headers['content-type'] || '';
  if (ct.includes('application/json')) return res.body.json();
  return res.body.text();
}

// ──────────────────────────────────────────────────────────────────────────────
// Datenzugriff
// (Hinweis: Facilities/Features Endpunkte bleiben placeholder bis du mir deren
// Swagger zeigst. Die Occupancy/Status-Routen sind hier präzise umgesetzt.)
// ──────────────────────────────────────────────────────────────────────────────

async function fetchFacilities() {
  // 👇 Passe diesen Pfad an deine Facilities-API an, falls abweichend.
  return gbGet('/services/v4x0/facilities');
}

async function fetchFeatures() {
  // 👇 Passe diesen Pfad an deine Features-API an, falls abweichend.
  return gbGet('/services/v4x0/features');
}

function restPath(p) {
  // BASE_URL kann mit oder ohne /iPCM kommen
  // wir liefern nur den "inneren" Pfad zurück
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/^\/+/, '/'); // normalize
}

// dann:
async function fetchFacilityOccupancyById(facilityId, locale) {
  const q = locale ? `?locale=${encodeURIComponent(locale)}` : '';
  return gbGet(restPath(`rest/v1/operation/occupancies/facility/${encodeURIComponent(facilityId)}${q}`));
}

async function fetchFacilityStatusById(facilityId, locale) {
  const q = locale ? `?locale=${encodeURIComponent(locale)}` : '';
  return gbGet(restPath(`rest/v1/operation/status/facility/${encodeURIComponent(facilityId)}${q}`));
}

// ──────────────────────────────────────────────────────────────────────────────
// Mapping-Helfer
// ──────────────────────────────────────────────────────────────────────────────

/** Feature-Mapping von API → deine Keys */
function mapFeaturesForFacility(allFeatures, facilityId) {
  const f = (allFeatures || []).filter(x => String(x.facilityId) === String(facilityId));
  const has = (key) => f.some(x => (x.type || x.key) === key);

  const features = [];
  if (has('public_restrooms') || has('toilet')) features.push('public_restrooms');
  if (has('surveillance') || has('video_surveillance')) features.push('surveillance');
  if (has('roofed') || has('indoor')) features.push('roofed');
  if (has('elevator')) features.push('elevator');
  if (has('guidance_system') || has('dynamic_guidance')) features.push('guidance_system');
  if (has('disabled_parking_spaces') || has('accessible')) features.push('disabled_parking_spaces');
  if (has('stork_parking_spaces') || has('family')) features.push('stork_parking_spaces');
  if (has('long_term_parking') || has('contract')) features.push('long_term_parking');
  if (has('bicycle') || has('bike')) features.push('bicycle');

  const paymentOptions = [];
  if (has('payment_cash')) paymentOptions.push('payment_cash');
  if (has('payment_ec') || has('payment_girocard')) paymentOptions.push('payment_ec');
  if (has('payment_mastercard')) paymentOptions.push('payment_mastercard');
  if (has('payment_visa')) paymentOptions.push('payment_visa');
  if (has('payment_wien_mobile') || has('payment_mobile')) paymentOptions.push('payment_wien_mobile');
  if (has('payment_post_card') || has('payment_postcard')) paymentOptions.push('payment_post_card');
  if (has('payment_multipurposecard') || has('payment_mpc')) paymentOptions.push('payment_multipurposecard');

  return { features, paymentOptions };
}

/** Öffnungszeiten → HTML-Table (Fallback 24/7 bis Opening-Quelle steht) */
function openingTimesToHtml() {
  return `<table width="100%" cellpadding="0" cellspacing="0"><tr><td><label>Täglich (auch Feiertage)</label></td><td>0 - 24 Uhr</td></tr></table>`;
}

/** Tarife → HTML-Table (bis eigene Tarifquelle vorhanden) */
function ratesToHtml(rates) {
  const hour = (rates && rates.hourly) || '1,50 €';
  const dayMax = (rates && rates.dayMax) || '10,00 €';
  const monthly = (rates && rates.monthlyLongTerm) || '65,00 €';

  return `<table style="width: 100%;">
<tbody>
<tr>
<td><span style="color: #ff6600;"><strong>Standardtarif</strong></span></td>
<td align="right" nowrap="nowrap">&nbsp;</td>
</tr>
<tr>
<td>pro Stunde</td>
<td align="right" nowrap="nowrap">${hour}</td>
</tr>
<tr>
<td>Tageshöchstsatz</td>
<td align="right" nowrap="nowrap">${dayMax}</td>
</tr>
<tr>
<td>&nbsp;</td>
<td align="right" nowrap="nowrap">&nbsp;</td>
</tr>
<tr>
<td><span style="color: #ff6600;"><strong>Dauerstellplatz</strong></span></td>
<td align="right" nowrap="nowrap">&nbsp;</td>
</tr>
<tr>
<td nowrap="nowrap">Dauerparkplatz pro Monat</td>
<td align="right" nowrap="nowrap">${monthly}</td>
</tr>
</tbody>
</table>`;
}

/** Adresse → streetLines */
function addressToStreetLines(fac) {
  const line1 = [fac.address?.street, fac.address?.houseNo].filter(Boolean).join(' ').trim() || fac.street || '';
  const line2 = [fac.address?.zip || fac.zip, fac.address?.city || fac.city].filter(Boolean).join(' ') || '';
  return [line1, line2].filter(Boolean);
}

/** Bild-URL wählen */
function pickImageUrl(fac) {
  if (fac.images?.length) return fac.images[0].url;
  if (fac.snapshotUrl) return fac.snapshotUrl;
  return null;
}

/** Restriktionen (Einfahrtshöhe) */
function mapRestrictions(fac) {
  if (typeof fac.clearanceMeters === 'number') {
    return `Einfahrtshöhe: ${fac.clearanceMeters.toFixed(2).replace('.', ',')}m`;
  }
  if (typeof fac.heightLimitCm === 'number') {
    return `Einfahrtshöhe: ${(fac.heightLimitCm / 100).toFixed(2).replace('.', ',')}m`;
  }
  return null;
}

/** Kapazität */
function mapCapacity(fac) {
  return fac.capacityTotal ?? fac.totalCapacity ?? null;
}

/** Long-Term URL */
function mapLongTermUrl(fac) {
  return fac.contractUrl || null;
}

/** Beschreibung / AGB-Link */
function mapDescriptionHtml() {
  const url = 'https://www.goldbeck.de/fileadmin/Redaktion/Unternehmen/Dienstleistungen/GPS/forms/180813_Einstellbedingungen_ohne_ParkingCard_DSGVO.pdf';
  return `<p><a href="${url}" target="_blank">&nbsp;</a></p>`;
}

/** NEU: combinedStatus aus Occupancy-Countern aggregieren */
function combinedStatusFromOccupancy(occ) {
  if (!occ || !Array.isArray(occ.counters) || occ.counters.length === 0) return 'unknown';

  // 1) Wenn irgendein Counter diskret "FULL"/"TIGHT"/"FREE" liefert, bevorzugt das (strengste gewinnt)
  const statusRank = { full: 3, tight: 2, free: 1, unknown: 0 };
  let best = 'unknown';
  for (const c of occ.counters) {
    const s = String(c.status || '').toLowerCase();
    if (s === 'full' && statusRank[s] > statusRank[best]) best = 'full';
    else if (s === 'tight' && statusRank[s] > statusRank[best]) best = 'tight';
    else if (s === 'free' && statusRank[s] > statusRank[best]) best = 'free';
  }
  if (best !== 'unknown') return best;

  // 2) Sonst auf Basis (maxPlaces, freePlaces) aggregieren
  let sumMax = 0;
  let sumFree = 0;
  for (const c of occ.counters) {
    if (typeof c.maxPlaces === 'number') sumMax += c.maxPlaces;
    if (typeof c.freePlaces === 'number') sumFree += c.freePlaces;
  }
  if (sumMax <= 0) return 'unknown';

  const occupied = sumMax - sumFree;
  const ratio = occupied / sumMax; // 0..1
  if (ratio <= 0.60) return 'free';
  if (ratio <= 0.90) return 'tight';
  return 'full';
}

/**
 * Haupt-Mapping: API-Facility + Features + Occupancy → Zielobjekt
 * (Status wird aktuell nur geladen, nicht in das Zielformat geschrieben.)
 */
function toTargetObject({ fac, features, occupancy /*, status*/ }) {
  const { features: featList, paymentOptions } = mapFeaturesForFacility(features, fac.id);
  const combinedStatus = combinedStatusFromOccupancy(occupancy);

  return {
    id: Number(fac.id),
    name: fac.name || '',
    city: fac.city || fac.address?.city || '',
    lat: Number(fac.lat || fac.latitude),
    lng: Number(fac.lng || fac.longitude),
    imageUrl: pickImageUrl(fac),
    rates: ratesToHtml(fac.rates),
    country: fac.country || 'DE',
    description: mapDescriptionHtml(fac),
    openingTimes: openingTimesToHtml(fac.openingTimes),
    restrictions: mapRestrictions(fac),
    features: featList,
    paymentOptions,
    streetLines: addressToStreetLines(fac),
    urlPrebooking: fac.prebookingUrl || null,
    urlLongTermParking: mapLongTermUrl(fac),
    capacityTotal: mapCapacity(fac),
    combinedStatus, // "free" | "tight" | "full" | "unknown"
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Route: Facility by ID → liefert dein gewünschtes Objekt
// ──────────────────────────────────────────────────────────────────────────────

app.get('/api/facilities/:id', async (req, res) => {
  const id = String(req.params.id);
  const locale = req.query.locale; // optional weiterreichen

  try {
    // Stammdaten + Features + Occupancy (per Facility) + (optional) Status (per Facility)
    const [facilities, features, occupancy, status] = await Promise.all([
      fetchFacilities(),
      fetchFeatures(),
      fetchFacilityOccupancyById(id, locale),
      fetchFacilityStatusById(id, locale).catch(() => null), // nicht kritisch
    ]);

    const fac = (facilities || []).find(f =>
      String(f.id) === id || String(f.facilityId) === id
    );
    if (!fac) return res.status(404).json({ error: 'Facility not found', id });

    const payload = toTargetObject({ fac, features, occupancy, status });
    return res.json(payload);
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: 'Failed to build facility object',
      message: err.message,
    });
  }
});

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Start
app.listen(PORT, () => {
  console.log(`Goldbeck proxy up on :${PORT}`);
});
