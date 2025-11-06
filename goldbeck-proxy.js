// goldbeck-proxy.js – Einzel-Fetches statt embed (CommonJS)
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
const qsObj    = (req) => Object.fromEntries(new URLSearchParams(req.url.split('?')[1] || ''));
const toQS     = (obj) => new URLSearchParams(obj || {}).toString();

async function upstreamGet(fullPath, query='') {
  const url = `${BASE_URL}${fullPath}${query ? `?${query}` : ''}`;
  const r = await request(url, {
    method: 'GET',
    headers: { Authorization: BASIC, Accept: 'application/json,*/*' },
    headersTimeout: 20000,
    bodyTimeout: 20000,
  });
  const ct = r.headers['content-type'] || '';
  return { r, ct, url };
}

function pickArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const keys = ['items','results','content','data','list',
    'facilities','features','filecontent',
    'occupancies','counters','attributes',
    'methods','devices','status','deviceStatus','contactData'];
  for (const k of keys) {
    if (Array.isArray(json[k])) return json[k];
  }
  const first = Object.values(json).find(Array.isArray);
  return Array.isArray(first) ? first : [];
}

function filterByFacilityId(json, facilityId) {
  const idStr = String(facilityId);
  const arr = pickArray(json);
  const match = (x) =>
    String(x?.facilityId ?? x?.facility?.id ?? x?.id) === idStr;
  return arr.filter(match);
}

async function proxyList(res, pathFromRoot, query='') {
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
  } catch (e) {
    console.error('Proxy error:', e?.message || e);
    return res.status(502).json({ error: 'Bad gateway', detail: String(e?.message || e) });
  }
}

// ── Static UI
app.use('/', express.static(path.join(__dirname, 'public')));

// ── Debug
app.use((req,_res,next)=>{ if (req.path.startsWith('/api/')) console.log('[API]', req.method, req.originalUrl); next(); });

/**
 * MAP der „Embed“-Arten → Upstream-Collections
 * Passe nur diese Tabelle an, falls bei dir die Sammlungsnamen anders heißen.
 */
const EMBED_MAP = {
  attributes:        '/services/v4x0/attributes',
  contactData:       '/services/v4x0/contactdata',
  devices:           '/services/v4x0/devices',
  fileAttachments:   '/services/v4x0/filecontent',   // Datei-Infos
  methods:           '/services/v4x0/methods',
  facilityOccupancies:'/services/v4x0/occupancies',  // Belegung
  facilityStatus:    '/services/v4x0/status',
  deviceStatus:      '/services/v4x0/devicestatus',

  // Bestehende, nicht direkt „embed“ aber nützlich:
  facilities:         '/services/v4x0/facilities',
  features:           '/services/v4x0/features',
  facilitydefinitions:'/services/v4x0/facilitydefinitions',
};

// ── Basis-Listen
app.get('/api/facilities',           (req,res)=> proxyList(res, EMBED_MAP.facilities,          req.url.split('?')[1] || ''));
app.get('/api/facility-definitions', (req,res)=> proxyList(res, EMBED_MAP.facilitydefinitions, req.url.split('?')[1] || ''));
app.get('/api/features',             (req,res)=> proxyList(res, EMBED_MAP.features,            req.url.split('?')[1] || ''));
app.get('/api/filecontent',          (req,res)=> proxyList(res, EMBED_MAP.fileAttachments,     req.url.split('?')[1] || ''));

// ── Occupancies (mit robustem Fallback + striktem Filter)
app.get('/api/occupancies', async (req, res) => {
  const q = qsObj(req);
  const facilityId = (q.facilityId || q.id || '').toString().trim();

  // ohne facilityId → komplette Liste
  if (!facilityId) return proxyList(res, EMBED_MAP.facilityOccupancies, toQS(q));

  const candidates = [
    `${EMBED_MAP.facilityOccupancies}?facilityId=${encodeURIComponent(facilityId)}`,
    `${EMBED_MAP.facilityOccupancies}/facilities/${encodeURIComponent(facilityId)}`,
  ];

  try {
    for (const p of candidates) {
      const { r, ct, url } = await upstreamGet(p, '');
      if ((r.statusCode||0) < 200 || (r.statusCode||0) >= 400) continue;

      res.setHeader('x-upstream-url', url);
      if (!isJsonCT(ct)) {
        res.status(r.statusCode || 200);
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        return r.body.pipe(res);
      }

      const json = await r.body.json();
      // immer streng filtern
      return res.json(filterByFacilityId(json, facilityId));
    }
    return res.status(404).json({ error: 'Occupancies not found for facility', facilityId });
  } catch (e) {
    console.error('occupancies error:', e?.message || e);
    return res.status(502).json({ error: 'Bad gateway', detail: String(e?.message || e) });
  }
});

// ── Generischer Embed-Fetch: /api/embed/:kind?facilityId=123
app.get('/api/embed/:kind', async (req, res) => {
  const kind = req.params.kind;
  const basePath = EMBED_MAP[kind];
  if (!basePath) return res.status(400).json({ error: 'unknown kind', kind });

  const q = qsObj(req);
  const facilityId = (q.facilityId || q.id || '').toString().trim();

  // ohne facilityId → ungefilterte Liste (kann groß sein)
  if (!facilityId) return proxyList(res, basePath, req.url.split('?')[1] || '');

  const candidates = [
    `${basePath}?facilityId=${encodeURIComponent(facilityId)}`,
    `${basePath}/facilities/${encodeURIComponent(facilityId)}`,
  ];

  try {
    for (const p of candidates) {
      const { r, ct, url } = await upstreamGet(p, '');
      if ((r.statusCode||0) < 200 || (r.statusCode||0) >= 400) continue;

      res.setHeader('x-upstream-url', url);
      if (!isJsonCT(ct)) {
        res.status(r.statusCode || 200);
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        return r.body.pipe(res);
      }

      const json = await r.body.json();
      // strikt nur diese facilityId
      return res.json(filterByFacilityId(json, facilityId));
    }
    return res.status(404).json({ error: `${kind} not found for facility`, facilityId });
  } catch (e) {
    console.error('embed error:', kind, e?.message || e);
    return res.status(502).json({ error: 'Bad gateway', detail: String(e?.message || e) });
  }
});

// ── „Details“ einer Facility (Basis-Datensatz) per Filter (ohne embed)
app.get('/api/facilities/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();

  const variants = [
    `${EMBED_MAP.facilities}?id=${encodeURIComponent(id)}`,
    `${EMBED_MAP.facilities}?facilityId=${encodeURIComponent(id)}`,
    `${EMBED_MAP.facilities}?$filter=${encodeURIComponent(`id eq ${id}`)}`,
    `${EMBED_MAP.facilities}?filter=${encodeURIComponent(`id eq ${id}`)}`,
  ];

  try {
    for (const p of variants) {
      const { r, ct, url } = await upstreamGet(p, '');
      if ((r.statusCode||0) < 200 || (r.statusCode||0) >= 400) continue;

      res.setHeader('x-upstream-url', url);
      if (!isJsonCT(ct)) {
        res.status(r.statusCode || 200);
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        return r.body.pipe(res);
      }

      const data = await r.body.json();
      const arr = pickArray(data);
      const hit =
        arr.find(x => String(x?.id)===id || String(x?.facilityId)===id) ||
        (arr.length === 1 ? arr[0] : null) ||
        (data && typeof data === 'object' && !Array.isArray(data) ? data : null);
      if (hit) return res.json(hit);
    }
    return res.status(404).json({ error: 'Facility not found', id });
  } catch (e) {
    console.error('facility/:id error:', e?.message || e);
    return res.status(502).json({ error: 'Bad gateway', detail: String(e?.message || e) });
  }
});

// ── Health
app.get('/api/health', (req,res)=>{
  res.json({ ok:true, baseUrl: BASE_URL, hasAuth: Boolean(GB_USER && GB_PASS) });
});

app.listen(PORT, ()=> {
  console.log(`Goldbeck Proxy läuft: http://localhost:${PORT}  (base: ${BASE_URL})`);
});
