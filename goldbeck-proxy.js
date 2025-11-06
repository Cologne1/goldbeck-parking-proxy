// goldbeck-proxy.js (CommonJS)
require('dotenv/config');
const express = require('express');
const { request } = require('undici');
const path = require('path');

const app = express();

// ---- ENV ----
const BASE_URL = process.env.GB_BASE_URL || 'https://control.goldbeck-parking.de/ipaw';
const GB_USER  = process.env.GB_USER || 'CC webservicegps';
const GB_PASS  = process.env.GB_PASS || 'webservice';
const PORT     = Number(process.env.PORT || 4000);

// Basic Auth Header (serverseitig)
const basic = 'Basic ' + Buffer.from(`${GB_USER}:${GB_PASS}`).toString('base64');

// --- kleine Hilfen ---
function isJsonContentType(ct = '') {
  return /\bjson\b/i.test(ct); // robust: matcht auch application/hal+json etc.
}
function qs(req) {
  return req.url.split('?')[1] || '';
}

// Helper: GET mit Basic-Auth + Query passthrough
async function proxyGet(res, upstreamPath, query = '') {
  const url = `${BASE_URL}${upstreamPath}${query ? `?${query}` : ''}`;
  try {
    const r = await request(url, {
      method: 'GET',
      headers: { Authorization: basic, Accept: 'application/json,*/*' },
      headersTimeout: 15000,
      bodyTimeout: 15000,
    });

    const ct = r.headers['content-type'] || '';
    res.status(r.statusCode || 200);

    if (isJsonContentType(ct)) {
      const json = await r.body.json();
      return res.json(json);
    } else {
      // non-JSON (z. B. Binärdaten) durchstreamen
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      return r.body.pipe(res);
    }
  } catch (err) {
    console.error('Proxy error:', upstreamPath, err?.message || err);
    return res.status(502).json({ error: 'Bad gateway', detail: String(err?.message || err) });
  }
}

// Nur für flexible Varianten: Upstream-Fetch OHNE sofort zu antworten (damit wir Fallbacks probieren können)
async function getUpstreamRaw(pathAndQuery) {
  const url = `${BASE_URL}${pathAndQuery}`;
  const r = await request(url, {
    method: 'GET',
    headers: { Authorization: basic, Accept: 'application/json,*/*' },
    headersTimeout: 15000,
    bodyTimeout: 15000,
  });
  const ct = r.headers['content-type'] || '';
  return { r, ct, url };
}

// Static Test UI
app.use('/', express.static(path.join(__dirname, 'public')));

// ---- API Proxy Routen ----

// E-Charging
app.get('/api/charging-stations', (req, res) =>
  proxyGet(res, '/services/charging/v1x0/charging-stations', qs(req))
);
app.get('/api/charging-files/:fileAttachmentId', (req, res) =>
  proxyGet(res, `/services/charging/v1x0/files/${encodeURIComponent(req.params.fileAttachmentId)}`)
);

// Garagen / Räume / Features / Filecontent / Parkhäuser (Listen)
app.get('/api/facilities', (req, res) =>
  proxyGet(res, '/services/v4x0/facilities', qs(req))
);
app.get('/api/facility-definitions', (req, res) =>
  proxyGet(res, '/services/v4x0/facilitydefinitions', qs(req))
);
app.get('/api/features', (req, res) =>
  proxyGet(res, '/services/v4x0/features', qs(req))
);
app.get('/api/filecontent', (req, res) =>
  proxyGet(res, '/services/v4x0/filecontent', qs(req))
);
app.get('/api/occupancies', (req, res) =>
  proxyGet(res, '/services/v4x0/occupancies', qs(req))
);

// 👉 Facility-Details per ID (mit Query-Passthrough für z. B. embed=…)
// Da upstream /{id} nicht garantiert ist, nutzen wir Query-Varianten.
app.get('/api/facilities/:id', async (req, res) => {
  const id = String(req.params.id).trim();
  const query = qs(req);

  // embed & weitere Query-Parameter beibehalten
  // Für die Varianten, die selbst schon ?… enthalten, hängen wir &query an.
  const addTail = (hasQ) => (query ? (hasQ ? `&${query}` : `?${query}`) : '');

  const candidates = [
    `/services/v4x0/facilities?id=${encodeURIComponent(id)}${addTail(true)}`,
    `/services/v4x0/facilities?facilityId=${encodeURIComponent(id)}${addTail(true)}`,
    `/services/v4x0/facilities?$filter=${encodeURIComponent(`id eq ${id}`)}${addTail(true)}`,
    `/services/v4x0/facilities?filter=${encodeURIComponent(`id eq ${id}`)}${addTail(true)}`,
  ];

  try {
    for (const pathAndQuery of candidates) {
      const { r, ct } = await getUpstreamRaw(pathAndQuery);

      // 2xx oder 304 → versuchen zu deuten
      if ((r.statusCode || 0) >= 200 && (r.statusCode || 0) < 400) {
        if (isJsonContentType(ct)) {
          const data = await r.body.json();

          // Einzelobjekt direkt?
          if (data && typeof data === 'object' && !Array.isArray(data) && (data.id || data.facilityId)) {
            return res.json(data);
          }

          // Wrapper / Arrays → bestes Match ziehen
          const arr = Array.isArray(data) ? data : (Object.values(data || {}).find(v => Array.isArray(v)) || []);
          const hit = Array.isArray(arr)
            ? (arr.find(x => String(x?.id) === id || String(x?.facilityId) === id) || (arr.length === 1 ? arr[0] : null))
            : null;

          if (hit) return res.json(hit);
          // Sonst nächste Variante
          continue;
        } else {
          // Non-JSON (unerwartet) → direkt durchreichen
          res.status(r.statusCode || 200);
          res.setHeader('Content-Type', ct || 'application/octet-stream');
          return r.body.pipe(res);
        }
      }
      // 4xx/5xx → nächste Variante
    }

    // Wenn alle Varianten nichts liefern:
    return res.status(404).json({ error: 'Not found', id });
  } catch (err) {
    console.error('Facility-by-id error:', err?.message || err);
    return res.status(502).json({ error: 'Bad gateway', detail: String(err?.message || err) });
  }
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, baseUrl: BASE_URL, hasAuth: Boolean(GB_USER && GB_PASS) });
});

// Fallback: /api/* → 1:1 an BASE_URL weiterreichen (praktisch für Tests)
app.get('/api/*', async (req, res) => {
  try {
    const upstreamPath = req.originalUrl.replace(/^\/api/, '');
    const url = `${BASE_URL}${upstreamPath}`;
    const r = await request(url, {
      method: 'GET',
      headers: { Authorization: basic, Accept: 'application/json,*/*' },
      headersTimeout: 15000,
      bodyTimeout: 15000,
    });
    const ct = r.headers['content-type'] || '';
    res.status(r.statusCode || 200);
    if (isJsonContentType(ct)) {
      const json = await r.body.json();
      return res.json(json);
    } else {
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      return r.body.pipe(res);
    }
  } catch (err) {
    console.error('API passthrough error:', err?.message || err);
    return res.status(502).json({ error: 'Bad gateway', detail: String(err?.message || err) });
  }
});

async function gbGetJSON(fullPath) {
  const url = `${BASE_URL}${fullPath}`;
  const r = await request(url, {
    method: 'GET',
    headers: { Authorization: basic, Accept: 'application/json,*/*' },
    headersTimeout: 15000,
    bodyTimeout: 15000,
  });
  if ((r.statusCode || 500) >= 400) {
    const t = await r.body.text();
    throw new Error(`${r.statusCode} ${url}: ${t}`);
  }
  return r.body.json();
}

// Facilities (wir nutzen deine vorhandenen Query-Varianten; hier: by id)
async function fetchFacilityById(id, extraQuery = '') {
  const tail = extraQuery ? `&${extraQuery}` : '';
  const tries = [
    `/services/v4x0/facilities?id=${encodeURIComponent(id)}${tail}`,
    `/services/v4x0/facilities?facilityId=${encodeURIComponent(id)}${tail}`,
    `/services/v4x0/facilities?$filter=${encodeURIComponent(`id eq ${id}`)}${tail}`,
    `/services/v4x0/facilities?filter=${encodeURIComponent(`id eq ${id}`)}${tail}`,
  ];
  for (const path of tries) {
    try {
      const data = await gbGetJSON(path);
      if (data && typeof data === 'object' && !Array.isArray(data) && (data.id || data.facilityId)) return data;
      if (Array.isArray(data) && data.length) {
        const match = data.find(f => String(f.id) === String(id) || String(f.facilityId) === String(id)) || data[0];
        if (match) return match;
      }
      const arr = data?.content && Array.isArray(data.content) ? data.content : null;
      if (arr?.length) {
        const match = arr.find(f => String(f.id) === String(id) || String(f.facilityId) === String(id)) || arr[0];
        if (match) return match;
      }
    } catch { /* nächsten Versuch */ }
  }
  return null;
}

async function fetchAllFeatures() {
  return gbGetJSON('/services/v4x0/features');
}

async function fetchOccupancyByFacilityId(id, locale) {
  const q = locale ? `?locale=${encodeURIComponent(locale)}` : '';
  return gbGetJSON(`/rest/v1/operation/occupancies/facility/${encodeURIComponent(id)}${q}`);
}

async function fetchStatusByFacilityId(id, locale) {
  const q = locale ? `?locale=${encodeURIComponent(locale)}` : '';
  try {
    return await gbGetJSON(`/rest/v1/operation/status/facility/${encodeURIComponent(id)}${q}`);
  } catch {
    return null; // nicht kritisch
  }
}

// Mapper
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

function mapCapacity(fac) {
  return fac.capacityTotal ?? fac.totalCapacity ?? null;
}

function mapLongTermUrl(fac) {
  return fac.contractUrl || null;
}

function openingTimesToHtml(_opening) {
  // bis echte Quelle verfügbar → 24/7
  return `<table width="100%" cellpadding="0" cellspacing="0"><tr><td><label>Täglich (auch Feiertage)</label></td><td>0 - 24 Uhr</td></tr></table>`;
}

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

function descriptionHtml() {
  const url = 'https://www.goldbeck.de/fileadmin/Redaktion/Unternehmen/Dienstleistungen/GPS/forms/180813_Einstellbedingungen_ohne_ParkingCard_DSGVO.pdf';
  return `<p><a href="${url}" target="_blank">&nbsp;</a></p>`;
}

function toTargetObject({ fac, features, occupancy /*, status*/ }) {
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
    combinedStatus, // "free" | "tight" | "full" | "unknown"
  };
}

// Route: fertiges Facility-Objekt
app.get('/api/facility-object/:id', async (req, res) => {
  const id = String(req.params.id).trim();
  const extra = req.url.split('?')[1] || ''; // Query passthrough an Facilities
  const locale = new URLSearchParams(extra).get('locale') || undefined;

  try {
    const [fac, allFeatures, occ/*, stat*/] = await Promise.all([
      fetchFacilityById(id, extra),
      fetchAllFeatures(),
      fetchOccupancyByFacilityId(id, locale),
      // fetchStatusByFacilityId(id, locale) // nur wenn du es später brauchst
    ]);

    if (!fac) return res.status(404).json({ error: 'Facility not found', id });

    const payload = toTargetObject({ fac, features: allFeatures, occupancy: occ });
    return res.json(payload);
  } catch (err) {
    console.error('facility-object error', err?.message || err);
    return res.status(500).json({ error: 'Failed to build facility object', detail: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Goldbeck test proxy on http://localhost:${PORT} (base: ${BASE_URL})`);
});
