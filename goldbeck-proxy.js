// goldbeck-proxy.js – iPAW /services v4x0 (ohne /rest)
require('dotenv/config');
const express = require('express');
const { request } = require('undici');
const path = require('path');

const app = express();

// ── ENV
const BASE_URL = process.env.GB_BASE_URL || 'https://control.goldbeck-parking.de/ipaw';
const GB_USER  = process.env.GB_USER || 'CC webservicegps';
const GB_PASS  = process.env.GB_PASS || 'webservice';
const PORT     = Number(process.env.PORT || 4000);
const BASIC    = 'Basic ' + Buffer.from(`${GB_USER}:${GB_PASS}`).toString('base64');

// ── Helpers
const isJsonCT = (ct='') => /\bjson\b/i.test(ct);
const toQueryString = (obj) => new URLSearchParams(obj || {}).toString();
const qs = (req) => toQueryString(req.query || '');

async function upstreamGet(pathFromRoot, query='') {
  // pathFromRoot muss mit / beginnen, z. B. /services/v4x0/facilities
  const url = `${BASE_URL}${pathFromRoot}${query ? `?${query}` : ''}`;
  const r = await request(url, {
    method: 'GET',
    headers: { Authorization: BASIC, Accept: 'application/json,*/*' },
    headersTimeout: 15000,
    bodyTimeout: 15000,
  });
  const ct = r.headers['content-type'] || '';
  return { r, ct, url };
}

async function proxyGet(res, pathFromRoot, query='') {
  try {
    const { r, ct, url } = await upstreamGet(pathFromRoot, query);
    res.setHeader('x-upstream-url', url);
    res.status(r.statusCode || 200);
    if (isJsonCT(ct)) {
      const json = await r.body.json();
      return res.json(json);
    }
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    return r.body.pipe(res);
  } catch (err) {
    console.error('Proxy error:', err?.message || err);
    return res.status(502).json({ error: 'Bad gateway', detail: String(err?.message || err) });
  }
}

// Static UI (optional)
app.use('/', express.static(path.join(__dirname, 'public')));

// Debug-Log (optional)
app.use((req,_res,next)=>{ if (req.path.startsWith('/api/')) console.log('[API]', req.method, req.originalUrl); next(); });

// ── Listen (exakt wie spezifiziert)
app.get('/api/facilities',           (req,res)=> proxyGet(res, '/services/v4x0/facilities',          qs(req)));
app.get('/api/facility-definitions', (req,res)=> proxyGet(res, '/services/v4x0/facilitydefinitions', qs(req)));
app.get('/api/features',             (req,res)=> proxyGet(res, '/services/v4x0/features',            qs(req)));
app.get('/api/filecontent',          (req,res)=> proxyGet(res, '/services/v4x0/filecontent',         qs(req)));
app.get('/api/occupancies',          (req,res)=> proxyGet(res, '/services/v4x0/occupancies',         qs(req)));

// ── E-Charging
app.get('/api/charging-stations',    (req,res)=> proxyGet(res, '/services/charging/v1x0/charging-stations', qs(req)));
app.get('/api/charging-files/:fileAttachmentId',
  (req,res)=> proxyGet(res, `/services/charging/v1x0/files/${encodeURIComponent(req.params.fileAttachmentId)}`));

// ── Facility-Details per ID (kein /{id} upstream → Filter-Fallbacks; embed passt durch)
app.get('/api/facilities/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  const rawQuery = qs(req); // z. B. embed=attributes,facilityStatus
  const addTail = (hasQ) => (rawQuery ? (hasQ ? `&${rawQuery}` : `?${rawQuery}`) : '');

  // typische Varianten (einige Systeme akzeptieren id, andere facilityId; OData-like $filter als Fallback)
  const candidates = [
    `/services/v4x0/facilities?id=${encodeURIComponent(id)}${addTail(true)}`,
    `/services/v4x0/facilities?facilityId=${encodeURIComponent(id)}${addTail(true)}`,
    `/services/v4x0/facilities?$filter=${encodeURIComponent(`id eq ${id}`)}${addTail(true)}`,
    `/services/v4x0/facilities?filter=${encodeURIComponent(`id eq ${id}`)}${addTail(true)}`,
  ];

  try {
    for (const path of candidates) {
      const { r, ct, url } = await upstreamGet(path, '');
      if ((r.statusCode||0) < 200 || (r.statusCode||0) >= 400) continue;

      res.setHeader('x-upstream-url', url);

      if (!isJsonCT(ct)) {
        res.status(r.statusCode || 200);
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        return r.body.pipe(res);
      }

      const data = await r.body.json();

      // Direktobjekt?
      if (data && typeof data === 'object' && !Array.isArray(data) && (data.id || data.facilityId)) {
        return res.json(data);
      }

      // Wrapper/Array → bestes Match ziehen
      const arr = Array.isArray(data) ? data : (Object.values(data || {}).find(v => Array.isArray(v)) || []);
      const hit = Array.isArray(arr)
        ? (arr.find(x => String(x?.id) === id || String(x?.facilityId) === id) || (arr.length === 1 ? arr[0] : null))
        : null;

      if (hit) return res.json(hit);
      // sonst nächste Variante testen
    }

    return res.status(404).json({ error: 'Not found', id });
  } catch (err) {
    console.error('facilities/:id error:', err?.message || err);
    return res.status(502).json({ error:'Bad gateway', detail:String(err?.message || err) });
  }
});

// ── Health
app.get('/api/health', (req,res)=>{
  res.json({ ok:true, baseUrl: BASE_URL, hasAuth: Boolean(GB_USER && GB_PASS) });
});

// ── Optional: 1:1 Passthrough für alles unter /api/services/* → /ipaw/services/*
app.get('/api/services/*', async (req,res)=>{
  // behält /services/... bei, ersetzt nur das /api Präfix
  const upstreamPath = req.originalUrl.replace(/^\/api/, ''); // → /services/...
  try {
    const { r, ct, url } = await upstreamGet(upstreamPath, '');
    res.setHeader('x-upstream-url', url);
    res.status(r.statusCode || 200);
    if (isJsonCT(ct)) {
      const j = await r.body.json(); return res.json(j);
    }
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    return r.body.pipe(res);
  } catch (e) {
    console.error('passthrough error:', e?.message || e);
    return res.status(502).json({ error:'Bad gateway', detail:String(e?.message || e) });
  }
});

app.listen(PORT, ()=> {
  console.log(`Goldbeck Proxy läuft: http://localhost:${PORT}  (base: ${BASE_URL})`);
});
