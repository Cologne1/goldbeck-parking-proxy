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

app.listen(PORT, () => {
  console.log(`Goldbeck test proxy on http://localhost:${PORT} (base: ${BASE_URL})`);
});
