// goldbeck-proxy.js
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

// Basic-Auth Header
const BASIC = 'Basic ' + Buffer.from(`${GB_USER}:${GB_PASS}`).toString('base64');

// Hilfen
function isJson(ct = '') { return /\bjson\b/i.test(ct); }
function reqQuery(req)   { return req.url.split('?')[1] || ''; }

// ORIGIN für iPCM-Routen *ohne* /ipaw
const ORIGIN = (() => {
  try { return new URL(BASE_URL).origin; }
  catch { return 'https://control.goldbeck-parking.de'; }
})();

// Upstream-URL bauen:
// - iPAW-Services ("/services/..."): an BASE_URL
// - iPCM-REST (beginnt mit "/iPCM/"): an ORIGIN
function buildUpstreamUrl(upstreamPath, query = '') {
  let url;
  if (upstreamPath.startsWith('/iPCM/')) {
    url = ORIGIN + upstreamPath;
  } else {
    url = BASE_URL.replace(/\/+$/, '') + upstreamPath;
  }
  if (query) url += (url.includes('?') ? '&' : '?') + query;
  return url;
}

// GET-Proxy
async function proxyGet(res, upstreamPath, query = '') {
  const url = buildUpstreamUrl(upstreamPath, query);
  try {
    const r = await request(url, {
      method: 'GET',
      headers: { Authorization: BASIC, Accept: 'application/json,*/*' },
      headersTimeout: 20000,
      bodyTimeout: 20000,
    });
    const ct = r.headers['content-type'] || '';
    res.status(r.statusCode || 200);
    if (isJson(ct)) {
      const json = await r.body.json();
      return res.json(json);
    }
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    return r.body.pipe(res);
  } catch (e) {
    console.error('Proxy error:', url, e?.message || e);
    return res.status(502).json({ error: 'Bad gateway', detail: String(e?.message || e) });
  }
}

// Static UI
app.use('/', express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────────────────
// iPAW Services (unter BASE_URL /ipaw)
// ──────────────────────────────────────────────────────────
app.get('/api/facilities', (req, res) =>
  proxyGet(res, '/services/v4x0/facilities', reqQuery(req))
);
app.get('/api/facilities/:id', (req, res) =>
  proxyGet(res, `/services/v4x0/facilities/${encodeURIComponent(req.params.id)}`, reqQuery(req))
);
app.get('/api/facility-definitions', (req, res) =>
  proxyGet(res, '/services/v4x0/facilitydefinitions', reqQuery(req))
);
app.get('/api/features', (req, res) =>
  proxyGet(res, '/services/v4x0/features', reqQuery(req))
);
app.get('/api/filecontent', (req, res) =>
  proxyGet(res, '/services/v4x0/filecontent', reqQuery(req))
);

// ➕ Occupancies – komplette Liste (Client filtert nach facilityId)
app.get('/api/occupancies', (req, res) =>
  proxyGet(res, '/services/v4x0/occupancies', reqQuery(req))
);

// ──────────────────────────────────────────────────────────
// iPCM REST (ohne /ipaw) – facility-spezifische Endpunkte
// ──────────────────────────────────────────────────────────

// Belegung für *eine* Facility (was du für die Detailansicht willst)
app.get('/api/occupancies/facility/:id', (req, res) =>
  proxyGet(res, `/iPCM/rest/v1/operation/occupancies/facility/${encodeURIComponent(req.params.id)}`, reqQuery(req))
);

// Geräte/Ausstattung (Devices) für *eine* Facility
app.get('/api/devices/facility/:id', (req, res) =>
  proxyGet(res, `/iPCM/rest/v1/configuration/devices/facility/${encodeURIComponent(req.params.id)}`, reqQuery(req))
);

// ──────────────────────────────────────────────────────────
// Charging bleibt unverändert
// ──────────────────────────────────────────────────────────
app.get('/api/charging-stations', (req, res) =>
  proxyGet(res, '/services/charging/v1x0/charging-stations', reqQuery(req))
);
app.get('/api/charging-stations/:id', (req, res) =>
  proxyGet(res, `/services/charging/v1x0/charging-stations/${encodeURIComponent(req.params.id)}`, reqQuery(req))
);
app.get('/api/charging-files/:fileAttachmentId', (req, res) =>
  proxyGet(res, `/services/charging/v1x0/files/${encodeURIComponent(req.params.fileAttachmentId)}`)
);

// Health (optional)
app.get('/api/health', (req, res) => {
  res.json({ ok:true, baseUrl: BASE_URL, origin: ORIGIN, user: !!GB_USER });
});

// Start
app.listen(PORT, () => {
  console.log(`✅ Proxy läuft auf http://localhost:${PORT}`);
  console.log(`   BASE_URL (iPAW): ${BASE_URL}`);
  console.log(`   ORIGIN   (iPCM): ${ORIGIN}`);
});