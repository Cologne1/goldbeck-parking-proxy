// goldbeck-proxy.js (CommonJS)
require('dotenv/config');
const express = require('express');
const { request } = require('undici');
const path = require('path');

const app = express();

// ---- ENV ----
const BASE_URL = process.env.GB_BASE_URL || 'https://control.goldbeck-parking.de/ipaw';
const GB_USER   = process.env.GB_USER || 'CC webservicegps';
const GB_PASS   = process.env.GB_PASS || 'webservice';
const PORT      = Number(process.env.PORT || 4000);

// Basic Auth Header (serverseitig)
const basic = 'Basic ' + Buffer.from(`${GB_USER}:${GB_PASS}`).toString('base64');

// Helper: GET mit Basic-Auth + Query passthrough
async function proxyGet(res, upstreamPath, query = '') {
  const url = `${BASE_URL}${upstreamPath}${query ? `?${query}` : ''}`;
  try {
    const r = await request(url, {
      method: 'GET',
      headers: {
        Authorization: basic,
        Accept: 'application/json,*/*',
      },
      headersTimeout: 15000,
      bodyTimeout: 15000,
    });

    const ct = r.headers['content-type'] || '';
    res.status(r.statusCode || 200);

    if (/application\/json/i.test(ct)) {
      const json = await r.body.json();
      return res.json(json);
    } else {
      // non-JSON (z. B. Binärdaten) durchstreamen
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      return r.body.pipe(res);
    }
  } catch (err) {
    console.error('Proxy error:', upstreamPath, err && err.message ? err.message : err);
    return res.status(502).json({ error: 'Bad gateway', detail: String(err && err.message ? err.message : err) });
  }
}

// Static Test UI
app.use('/', express.static(path.join(__dirname, 'public')));

// ---- API Proxy Routen ----
// E-Charging
app.get('/api/charging-stations', (req, res) =>
  proxyGet(res, '/services/charging/v1x0/charging-stations', req.url.split('?')[1] || '')
);
app.get('/api/charging-files/:fileAttachmentId', (req, res) =>
  proxyGet(res, `/services/charging/v1x0/files/${encodeURIComponent(req.params.fileAttachmentId)}`)
);

// Facilities / Features / Filecontent
app.get('/api/facilities', (req, res) =>
  proxyGet(res, '/services/v4x0/facilities', req.url.split('?')[1] || '')
);
app.get('/api/facility-definitions', (req, res) =>
  proxyGet(res, '/services/v4x0/facilitydefinitions', req.url.split('?')[1] || '')
);
app.get('/api/features', (req, res) =>
  proxyGet(res, '/services/v4x0/features', req.url.split('?')[1] || '')
);
app.get('/api/filecontent', (req, res) =>
  proxyGet(res, '/services/v4x0/filecontent', req.url.split('?')[1] || '')
);

// Occupancies
app.get('/api/occupancies', (req, res) =>
  proxyGet(res, '/services/v4x0/occupancies', req.url.split('?')[1] || '')
);

// Health
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    baseUrl: BASE_URL,
    hasAuth: Boolean(GB_USER && GB_PASS),
  });
});

app.listen(PORT, () => {
  console.log(`Goldbeck test proxy on http://localhost:${PORT} (base: ${BASE_URL})`);
});
