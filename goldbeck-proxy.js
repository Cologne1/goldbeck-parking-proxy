// goldbeck-proxy.js – iPAW Proxy (CommonJS) – Facilities (Parkhäuser) & Charging
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
const qsStr = (req) => req.url.split('?')[1] || '';

async function upstreamGet(pathFromRoot, query='') {
  const url = `${BASE_URL}${pathFromRoot}${query ? `?${query}` : ''}`;
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
  const keys = [
    'items','results','content','data','list',
    'facilities','features','filecontent',
    'occupancies','counters','attributes',
    'methods','devices','status','deviceStatus','contactData','contacts'
  ];
  for (const k of keys) if (Array.isArray(json[k])) return json[k];
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

function toKebab(s){ return String(s).replace(/([a-z0-9])([A-Z])/g,'$1-$2').replace(/[_\s]+/g,'-').toLowerCase(); }

// ── Static UI
app.use('/', express.static(path.join(__dirname, 'public')));

// ── Debug
app.use((req,_res,next)=>{ if (req.path.startsWith('/api/')) console.log('[API]', req.method, req.originalUrl); next(); });

/** Pfade */
const MAP = {
  facilities:          '/services/v4x0/facilities',
  facilitydefinitions: '/services/v4x0/facilitydefinitions',
  features:            '/services/v4x0/features',
  filecontent:         '/services/v4x0/filecontent',
  occupancies:         '/services/v4x0/occupancies',

  chargingStations:    '/services/charging/v1x0/charging-stations',
  chargingFiles:       '/services/charging/v1x0/files'
};

// ── Basis-Listen
app.get('/api/facilities',           (req,res)=> proxyList(res, MAP.facilities,          qsStr(req)));
app.get('/api/facility-definitions', (req,res)=> proxyList(res, MAP.facilitydefinitions, qsStr(req)));
app.get('/api/features',             (req,res)=> proxyList(res, MAP.features,            qsStr(req)));
app.get('/api/filecontent',          (req,res)=> proxyList(res, MAP.filecontent,         qsStr(req)));

// ── Charging: Liste + Detail
app.get('/api/charging-stations', (req,res)=> proxyList(res, MAP.chargingStations, qsStr(req)));
app.get('/api/charging-stations/:id', (req,res)=>{
  const id = encodeURIComponent(String(req.params.id||'').trim());
  return proxyList(res, `${MAP.chargingStations}/${id}`, qsStr(req));
});
app.get('/api/charging-files/:fileAttachmentId',
  (req,res)=> proxyList(res, `${MAP.chargingFiles}/${encodeURIComponent(req.params.fileAttachmentId)}`));

// ── Occupancies (für genau diese facilityId; probiert Query + Pfad-Variante)
app.get('/api/occupancies', async (req, res) => {
  const q = Object.fromEntries(new URLSearchParams(qsStr(req)));
  const facilityId = (q.facilityId || q.id || '').toString().trim();

  if (!facilityId) return proxyList(res, MAP.occupancies, qsStr(req));

  const candidates = [
    `${MAP.occupancies}?facilityId=${encodeURIComponent(facilityId)}`,
    `${MAP.occupancies}/facilities/${encodeURIComponent(facilityId)}`,
    `${MAP.facilities}/${encodeURIComponent(facilityId)}/occupancies`,
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
      return res.json(filterByFacilityId(json, facilityId));
    }
    return res.status(404).json({ error: 'Occupancies not found for facility', facilityId });
  } catch (e) {
    console.error('occupancies error:', e?.message || e);
    return res.status(502).json({ error: 'Bad gateway', detail: String(e?.message || e) });
  }
});

// ── Generische Einzel-Fetches für Facility-"Embeds" (ohne embed-Param)
const EMBED_HINTS = {
  attributes:        ['attributes'],
  contactData:       ['contactdata','contacts'],
  devices:           ['devices'],
  fileAttachments:   ['filecontent','files','attachments'],
  methods:           ['methods'],
  facilityStatus:    ['status','facilitystatus'],
  deviceStatus:      ['devicestatus','device-status'],
};

app.get('/api/embed/:kind', async (req, res) => {
  const kind = String(req.params.kind || '').trim();
  const q = Object.fromEntries(new URLSearchParams(qsStr(req)));
  const facilityId = (q.facilityId || q.id || '').toString().trim();
  if (!facilityId) return res.status(400).json({ error:'facilityId required' });

  const base = kind;
  const kebab = toKebab(kind);
  const plural = base.endsWith('s') ? base : `${base}s`;
  const kebabPlural = kebab.endsWith('s') ? kebab : `${kebab}s`;
  const hints = EMBED_HINTS[kind] || [];

  const tried = new Set();
  const paths = [];
  const add = (p)=>{ if (!tried.has(p)) { paths.push(p); tried.add(p); } };

  // bevorzugte Hints
  for (const h of hints) {
    add(`${MAP.facilities}/${encodeURIComponent(facilityId)}/${h}`);
    add(`/services/v4x0/${h}?facilityId=${encodeURIComponent(facilityId)}`);
  }
  // generische Varianten (unterhalb Facility)
  add(`${MAP.facilities}/${encodeURIComponent(facilityId)}/${base}`);
  add(`${MAP.facilities}/${encodeURIComponent(facilityId)}/${plural}`);
  add(`${MAP.facilities}/${encodeURIComponent(facilityId)}/${kebab}`);
  add(`${MAP.facilities}/${encodeURIComponent(facilityId)}/${kebabPlural}`);
  // generische Varianten (Top-Level Collections mit Query)
  add(`/services/v4x0/${base}?facilityId=${encodeURIComponent(facilityId)}`);
  add(`/services/v4x0/${plural}?facilityId=${encodeURIComponent(facilityId)}`);
  add(`/services/v4x0/${kebab}?facilityId=${encodeURIComponent(facilityId)}`);
  add(`/services/v4x0/${kebabPlural}?facilityId=${encodeURIComponent(facilityId)}`);

  try {
    for (const p of paths) {
      const { r, ct, url } = await upstreamGet(p, '');
      if ((r.statusCode||0) < 200 || (r.statusCode||0) >= 400) continue;

      res.setHeader('x-upstream-url', url);
      if (!isJsonCT(ct)) {
        res.status(r.statusCode || 200);
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        return r.body.pipe(res);
      }
      const json = await r.body.json();

      // Facility-Subresource → vermutlich korrekt; Collections → strikt filtern
      const isSub = /\/services\/v4x0\/facilities\/\d+\/?/i.test(url);
      const out = isSub ? pickArray(json) : filterByFacilityId(json, facilityId);
      return res.json(out);
    }
    // nichts gefunden → leeres Array, UI bleibt stabil
    return res.json([]);
  } catch (e) {
    console.error('embed route error', kind, e?.message || e);
    return res.status(502).json({ error:'Bad gateway', detail:String(e?.message || e) });
  }
});

// ── Facility-„Details“ (Basisdatensatz per Filter; KEIN embed)
app.get('/api/facilities/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  const variants = [
    `${MAP.facilities}?id=${encodeURIComponent(id)}`,
    `${MAP.facilities}?facilityId=${encodeURIComponent(id)}`,
    `${MAP.facilities}?$filter=${encodeURIComponent(`id eq ${id}`)}`,
    `${MAP.facilities}?filter=${encodeURIComponent(`id eq ${id}`)}`
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
    return res.status(502).json({ error:'Bad gateway', detail:String(e?.message || e) });
  }
});

// ── Health
app.get('/api/health', (req,res)=>{
  res.json({ ok:true, baseUrl: BASE_URL, hasAuth: Boolean(GB_USER && GB_PASS) });
});

app.listen(PORT, ()=> {
  console.log(`Goldbeck Proxy läuft: http://localhost:${PORT}  (base: ${BASE_URL})`);
});
