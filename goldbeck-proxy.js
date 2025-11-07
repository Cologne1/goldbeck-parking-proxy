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
const basic    = 'Basic ' + Buffer.from(`${GB_USER}:${GB_PASS}`).toString('base64');

function isJson(ct = '') { return /\bjson\b/i.test(ct); }
function reqQuery(req)   { return req.url.split('?')[1] || ''; }

async function proxyGet(res, upstreamPath, query = '') {
  const url = `${BASE_URL}${upstreamPath}${query ? `?${query}` : ''}`;
  try {
    const r = await request(url, {
      method: 'GET',
      headers: { Authorization: basic, Accept: 'application/json,*/*' },
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
    console.error('Proxy error for', upstreamPath, e?.message || e);
    return res.status(502).json({ error: 'Bad gateway', detail: String(e?.message || e) });
  }
}

// Static UI
app.use('/', express.static(path.join(__dirname, 'public')));

// --- API passt genau zu deiner Vorgabe ---
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
app.get('/api/occupancies', (req, res) =>
  proxyGet(res, '/services/v4x0/occupancies', reqQuery(req))
);
// nur Occupancies für eine Facility (Detail)
app.get('/api/occupancies/facilities/:id', (req, res) =>
  proxyGet(res, `/services/v4x0/occupancies/facilities/${encodeURIComponent(req.params.id)}`)
);

// E-Charging
app.get('/api/charging-stations', (req, res) =>
  proxyGet(res, '/services/charging/v1x0/charging-stations', reqQuery(req))
);
app.get('/api/charging-stations/:id', (req, res) =>
  proxyGet(res, `/services/charging/v1x0/charging-stations/${encodeURIComponent(req.params.id)}`, reqQuery(req))
);
app.get('/api/charging-files/:fileAttachmentId', (req, res) =>
  proxyGet(res, `/services/charging/v1x0/files/${encodeURIComponent(req.params.fileAttachmentId)}`)
);

app.listen(PORT, () => {
  console.log(`✅ Goldbeck Proxy läuft: http://localhost:${PORT}  | Base: ${BASE_URL}`);
});