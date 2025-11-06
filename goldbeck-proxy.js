// goldbeck-proxy.js (CommonJS) – iPCM + Static wie im ZIP
require('dotenv/config');
const express = require('express');
const { request } = require('undici');
const path = require('path');

const app = express();

// ---- ENV ----
const BASE_URL = process.env.GB_BASE_URL || 'https://control.goldbeck-parking.de/iPCM';
const GB_USER  = process.env.GB_USER || 'CC webservicegps';
const GB_PASS  = process.env.GB_PASS || 'webservice';
const PORT     = Number(process.env.PORT || 4000);

// Basic Auth Header (serverseitig)
const basic = 'Basic ' + Buffer.from(`${GB_USER}:${GB_PASS}`).toString('base64');

app.use(express.json());

// ---- Hilfsfunktionen ----
function qs(req) {
  const q = new URLSearchParams(req.query || {}).toString();
  return q ? `?${q}` : '';
}
async function getUpstream(pathAndQuery) {
  const url = `${BASE_URL}${pathAndQuery}`;
  const r = await request(url, {
    method: 'GET',
    headers: { Authorization: basic, Accept: 'application/json,*/*' },
    headersTimeout: 15000,
    bodyTimeout: 15000,
  });
  const ct = r.headers['content-type'] || '';
  if (r.statusCode >= 400) {
    const text = await r.body.text();
    const err = new Error(`Upstream ${r.statusCode} for ${url}: ${text}`);
    err.statusCode = r.statusCode;
    throw err;
  }
  return { r, ct, url };
}
async function getJson(pathAndQuery) {
  const { r, ct } = await getUpstream(pathAndQuery);
  return ct.includes('application/json') ? r.body.json() : r.body.text();
}
async function proxyGet(res, pathAndQuery) {
  try {
    const { r, ct } = await getUpstream(pathAndQuery);
    if (ct.includes('application/json')) {
      const json = await r.body.json();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.json(json);
    } else {
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      return r.body.pipe(res);
    }
  } catch (err) {
    console.error('API passthrough error:', err?.message || err);
    return res.status(err.statusCode || 502).json({ error: 'Bad gateway', detail: String(err?.message || err) });
  }
}

// ---- Static Test UI (GENAU wie im ZIP) ----
app.use('/', express.static(path.join(__dirname, 'public')));

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

// ---- (Platzhalter bis du Facilities/Features-REST bestätigst) ----
async function fetchFacilities() {
  // falls eure Stammdaten auch unter /iPCM/rest/... liegen, bitte Pfad durchgeben
  return getJson('/services/v4x0/facilities');
}
async function fetchFeatures() {
  return getJson('/services/v4x0/features');
}

// ---- Mapping Helfer ----
function mapFeaturesForFacility(allFeatures, facilityId) {
  const f = (allFeatures || []).filter(x => String(x.facilityId) === String(facilityId));
  const has = (key) => f.some(x => (x.type || x.key || x.code) === key || (x.name || '').toLowerCase() === key);
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
function combinedStatusFromOccupancy(occ) {
  if (!occ || !Array.isArray(occ.counters) || !occ.counters.length) return 'unknown';
  const rank = { full: 3, tight: 2, free: 1, unknown: 0 };
  let best = 'unknown';
  for (const c of occ.counters) {
    const s = String(c.status || '').toLowerCase();
    if (rank[s] > rank[best]) best = s;
  }
  if (best !== 'unknown') return best;
  let max = 0, free = 0;
  for (const c of occ.counters) {
    if (typeof c.maxPlaces === 'number') max += c.maxPlaces;
    if (typeof c.freePlaces === 'number') free += c.freePlaces;
  }
  if (max <= 0) return 'unknown';
  const ratio = (max - free) / max;
  if (ratio <= 0.60) return 'free';
  if (ratio <= 0.90) return 'tight';
  return 'full';
}
function addressToStreetLines(fac) {
  const line1 = [fac.address?.street, fac.address?.houseNo].filter(Boolean).join(' ').trim() || fac.street || '';
  const line2 = [fac.address?.zip || fac.zip, fac.address?.city || fac.city].filter(Boolean).join(' ') || '';
  return [line1, line2].filter(Boolean);
}
function pickImageUrl(fac) {
  if (fac.images?.length) return fac.images[0].url;
  if (fac.snapshotUrl) return fac.snapshotUrl;
  return null;
}
function mapRestrictions(fac) {
  if (typeof fac.clearanceMeters === 'number') return `Einfahrtshöhe: ${fac.clearanceMeters.toFixed(2).replace('.', ',')}m`;
  if (typeof fac.heightLimitCm === 'number') return `Einfahrtshöhe: ${(fac.heightLimitCm / 100).toFixed(2).replace('.', ',')}m`;
  return null;
}
function mapCapacity(fac) { return fac.capacityTotal ?? fac.totalCapacity ?? null; }
function mapLongTermUrl(fac) { return fac.contractUrl || null; }
function openingTimesToHtml() {
  return `<table width="100%" cellpadding="0" cellspacing="0"><tr><td><label>Täglich (auch Feiertage)</label></td><td>0 - 24 Uhr</td></tr></table>`;
}
function ratesToHtml(rates) {
  const hour = (rates && rates.hourly) || '1,50 €';
  const dayMax = (rates && rates.dayMax) || '10,00 €';
  const monthly = (rates && rates.monthlyLongTerm) || '65,00 €';
  return `<table style="width: 100%;">
<tbody>
<tr><td><span style="color: #ff6600;"><strong>Standardtarif</strong></span></td><td align="right" nowrap="nowrap">&nbsp;</td></tr>
<tr><td>pro Stunde</td><td align="right" nowrap="nowrap">${hour}</td></tr>
<tr><td>Tageshöchstsatz</td><td align="right" nowrap="nowrap">${dayMax}</td></tr>
<tr><td>&nbsp;</td><td align="right" nowrap="nowrap">&nbsp;</td></tr>
<tr><td><span style="color: #ff6600;"><strong>Dauerstellplatz</strong></span></td><td align="right" nowrap="nowrap">&nbsp;</td></tr>
<tr><td nowrap="nowrap">Dauerparkplatz pro Monat</td><td align="right" nowrap="nowrap">${monthly}</td></tr>
</tbody></table>`;
}
function descriptionHtml() {
  const url = 'https://www.goldbeck.de/fileadmin/Redaktion/Unternehmen/Dienstleistungen/GPS/forms/180813_Einstellbedingungen_ohne_ParkingCard_DSGVO.pdf';
  return `<p><a href="${url}" target="_blank">&nbsp;</a></p>`;
}
function toTargetObject({ fac, features, occupancy }) {
  const { features: featList, paymentOptions } = mapFeaturesForFacility(features, fac.id || fac.facilityId);
  const combinedStatus = combinedStatusFromOccupancy(occupancy);
  return {
    id: Number(fac.id ?? fac.facilityId),
    name: fac.name || '',
    city: fac.city || fac.address?.city || '',
    lat: Number(fac.lat ?? fac.latitude),
    lng: Number(fac.lng ?? fac.longitude),
    imageUrl: pickImageUrl(fac),
    rates: ratesToHtml(fac.rates),
    country: fac.country || 'DE',
    description: descriptionHtml(),
    openingTimes: openingTimesToHtml(fac.openingTimes),
    restrictions: mapRestrictions(fac),
    features: featList,
    paymentOptions,
    streetLines: addressToStreetLines(fac),
    urlPrebooking: fac.prebookingUrl || null,
    urlLongTermParking: mapLongTermUrl(fac),
    capacityTotal: mapCapacity(fac),
    combinedStatus,
  };
}

// ---- API: fertiges Facility-Objekt ----
app.get('/api/facility-object/:id', async (req, res) => {
  const id = String(req.params.id).trim();
  const locale = req.query.locale;
  try {
    const [facilities, features, occupancy] = await Promise.all([
      fetchFacilities(),
      fetchFeatures(),
      fetchFacilityOccupancyById(id, locale),
      // fetchFacilityStatusById(id, locale) // aktuell nicht im Zielformat genutzt
    ]);
    const fac = (facilities || []).find(f => String(f.id) === id || String(f.facilityId) === id)
      || (facilities?.content || []).find(f => String(f.id) === id || String(f.facilityId) === id);
    if (!fac) return res.status(404).json({ error: 'Facility not found', id });
    return res.json(toTargetObject({ fac, features, occupancy }));
  } catch (err) {
    console.error('facility-object error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to build facility object', detail: String(err?.message || err) });
  }
});

// ---- (optional) Passthrough-Beispiele wie im ZIP ----
app.get('/api/facilities', (req, res) => proxyGet(res, '/services/v4x0/facilities' + qs(req)));
app.get('/api/features',   (req, res) => proxyGet(res, '/services/v4x0/features'   + qs(req)));

// ---- Start ----
app.listen(PORT, () => {
  console.log(`Goldbeck test proxy on http://localhost:${PORT} (base: ${BASE_URL})`);
});


