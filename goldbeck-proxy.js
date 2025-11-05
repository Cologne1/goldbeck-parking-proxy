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

// Nur für die :id-Route: Upstream-Fetch OHNE sofort zu antworten (damit wir fallbacks probieren können)
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

// Facilities / Features / Filecontent (Listen)
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

// 👉 NEU: Facility nach ID (mit Fallbacks)
app.get('/api/facilities/:id', async (req, res) => {
  const id = String(req.params.id).trim();
  const query = qs(req);
  const suffix = query ? `?${query}` : '';

  // Kandidaten: erst /{id}, dann Query-Varianten
  const candidates = [
      `/services/v4x0/facilities/${encodeURIComponent(id)}${suffix}`,
      `/services/v4x0/facilities?id=${encodeURIComponent(id)}${suffix}`,
      `/services/v4x0/facilities?facilityId=${encodeURIComponent(id)}${suffix}`,
      `/services/v4x0/facilities?$filter=${encodeURIComponent(`id eq ${id}`)}${suffix ? `&${query}` : ''}`,
      `/services/v4x0/facilities?filter=${encodeURIComponent(`id eq ${id}`)}${suffix ? `&${query}` : ''}`,
  ];

  try {
    for (const pathAndQuery of candidates) {
      const { r, ct } = await getUpstreamRaw(pathAndQuery);

      // 2xx oder 304 → versuchen zu deuten
      if ((r.statusCode || 0) >= 200 && (r.statusCode || 0) < 400) {
        if (isJsonContentType(ct)) {
          const data = await r.body.json();

          // Objekt direkt?
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            // Falls Wrapper: versuche gängige Keys
            const keys = ['item','result','facility','data','content'];
            for (const k of keys) {
              if (data[k] && typeof data[k] === 'object' && !Array.isArray(data[k])) {
                return res.json(data[k]);
              }
            }
            // Hat selbst eine ID? Dann zurück
            if (data.id || data.facilityId) return res.json(data);
            // Vielleicht steckt irgendwo ein Array mit genau einem Treffer
            const arr =
              Array.isArray(data) ? data :
                Object.values(data).find(v => Array.isArray(v)) || [];
            if (Array.isArray(arr) && arr.length) {
              const match = arr.find(x =>
                String(x?.id) === id || String(x?.facilityId) === id
              ) || (arr.length === 1 ? arr[0] : null);
              if (match) return res.json(match);
            }
            // Daten da, aber kein passender Treffer → probiere nächsten Kandidaten
            continue;
          }

          // Array-Antwort
          if (Array.isArray(data)) {
            const match = data.find(x =>
              String(x?.id) === id || String(x?.facilityId) === id
            ) || (data.length === 1 ? data[0] : null);
            if (match) return res.json(match);
            continue;
          }

          // Irgendwas JSON-artiges, aber ohne Treffer → nächster Kandidat
          continue;
        } else {
          // Non-JSON (unerwartet) → direkt durchreichen und beenden
          res.status(r.statusCode || 200);
          res.setHeader('Content-Type', ct || 'application/octet-stream');
          return r.body.pipe(res);
        }
      }

      // 404/405/etc.: probiere nächsten Kandidaten
      // (Optional: Log nur bei Bedarf)
      // console.log('Upstream miss', r.statusCode, pathAndQuery);
    }

    // Wenn alle Varianten nichts liefern:
    return res.status(404).json({ error: 'Not found', id });
  } catch (err) {
    console.error('Facility-by-id error:', err?.message || err);
    return res.status(502).json({ error: 'Bad gateway', detail: String(err?.message || err) });
  }
});

// Occupancies
app.get('/api/occupancies', (req, res) =>
  proxyGet(res, '/services/v4x0/occupancies', qs(req))
);

// Health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, baseUrl: BASE_URL, hasAuth: Boolean(GB_USER && GB_PASS) });
});

// Fallback: /api/* → 1:1 an BASE_URL weiterreichen
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
