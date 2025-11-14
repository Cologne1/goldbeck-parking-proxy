// public/app.js

// ---------- Mini-Helpers ----------
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const ALLOWED_FAC_DEFS = new Set(['14']);
function safeJson(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function toLowerJsonStr(x) { try { return JSON.stringify(x).toLowerCase(); } catch { return ''; } }
function splitLines(v) { return String(v || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }

const euro = (v) => {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (s.includes('€')) return s;
  return s.replace('.', ',') + ' €';
};

function pickArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.results)) return json.results;
  if (json && Array.isArray(json.content)) return json.content;
  if (json && typeof json === 'object') {
    const firstArr = Object.values(json).find((v) => Array.isArray(v));
    if (Array.isArray(firstArr)) return firstArr;
  }
  return [];
}

function collectAttributes(obj) {
  return Array.isArray(obj && obj.attributes) ? obj.attributes : [];
}

function attrVal(attrs, keys) {
  const lower = keys.map((k) => String(k).toLowerCase());
  for (let i = 0; i < (attrs || []).length; i++) {
    const a = attrs[i];
    if (!a) continue;
    const k = String(a.key || '').toLowerCase();
    if (lower.includes(k)) return a.value != null ? a.value : '';
  }
  return '';
}

// POSTAL_ADDRESS: "Straße\nPLZ\nOrt\nLändercode"
function parsePostalAddressBlock(block) {
  const lines = String(block).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  const street = lines[0] || '';
  let zip = '', city = '', country = '';
  for (let i = 1; i < lines.length; i++) {
    const L = lines[i];
    if (/^\d{4,6}$/.test(L)) { zip = L; continue; }
    if (/^[A-Z]{2,3}$/.test(L)) { country = L; continue; }
    if (!city) city = L;
  }
  const line2 = [zip, city].filter(Boolean).join(' ');
  const c = country === 'DEU' ? 'DE' : country;
  return [street, line2, c].filter(Boolean).join('<br/>');
}
function formatPostalAddress(postal) {
  if (!postal || typeof postal !== 'object') return '';
  const street = [postal.street1, postal.street2].filter(Boolean).join(' ').trim();
  const line1 = street || postal.name || '';
  const line2 = [postal.zip, postal.city].filter(Boolean).join(' ').trim();
  const country = postal.country || '';
  return [line1, line2, country].filter(Boolean).join('<br/>');
}
function extractAddressFromAttributes(obj) {
  const attrs = collectAttributes(obj);
  const postal = attrs.find((a) => String(a && a.key).toUpperCase() === 'POSTAL_ADDRESS');
  if (obj.postalAddress) {
    const html = formatPostalAddress(obj.postalAddress);
    if (html) return html;
  }
  if (postal && postal.value) return parsePostalAddressBlock(postal.value);

  const street = attrVal(attrs, ['STREET', 'straße', 'strasse']);
  const house  = attrVal(attrs, ['HOUSE_NO', 'houseno', 'housenumber']);
  const zip    = attrVal(attrs, ['ZIP', 'PLZ', 'postalCode']);
  const city   = attrVal(attrs, ['CITY', 'Ort', 'city']);
  const l1 = [street, house].filter(Boolean).join(' ').trim();
  const l2 = [zip, city].filter(Boolean).join(' ').trim();
  return [l1, l2].filter(Boolean).join(', ');
}

function boolFromString(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'true' || s === 'yes' || s === 'ja' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === 'nein' || s === '0') return false;
  return null;
}

// ---------- Tarife/Details-Heuristiken ----------
function extractRates(detail) {
  const attrs = collectAttributes(detail);
  const hourly  = attrVal(attrs, ['HOURLY_RATE', 'hourly', 'pro_stunde', 'STUNDENPREIS']);
  const daymax  = attrVal(attrs, ['DAY_MAX', 'day_max', 'tageshöchstsatz', 'TAGESMAX']);
  const monthly = attrVal(attrs, ['MONTHLY', 'DAUERSTELLPLATZ', 'MONTHLY_LONG_TERM']);
  const bits = [];
  if (hourly) bits.push('Stunde: ' + euro(hourly));
  if (daymax) bits.push('Tag: ' + euro(daymax));
  if (monthly) bits.push('Monat: ' + euro(monthly));
  return bits.join(' · ');
}

function extractClearance(detail) {
  const attrs = collectAttributes(detail);
  const m  = attrVal(attrs, ['CLEARANCE_METERS', 'EINFAHRTSHOEHE_M', 'EINFAHRTSHÖHE_M']);
  const cm = attrVal(attrs, ['HEIGHT_LIMIT_CM', 'EINFAHRTSHOEHE_CM', 'EINFAHRTSHÖHE_CM']);
  if (m) return String(m).replace('.', ',') + ' m';
  if (cm) {
    const n = Number(cm);
    if (!isNaN(n)) return (n / 100).toFixed(2).replace('.', ',') + ' m';
  }
  return '';
}

function extractCapacity(detail) {
  const attrs = collectAttributes(detail);
  console.log(detail, attrs)
  const a = detail && (detail.capacityTotal != null ? detail.capacityTotal : detail.totalCapacity);
  if (a != null && a !== '') return a;
  const attrCap = attrVal(attrs, ['CAPACITY_TOTAL', 'TOTAL_CAPACITY']);
  return attrCap || '';
}

// Optionales Label-Mapping für Devices
const DEVICE_LABELS = {
  BARRIER: 'Schranke',
  CASH_DESK: 'Kasse',
  TICKET_MACHINE: 'Ticketautomat',
  CAMERA: 'Kamera'
};

// Devices in Features einmischen
function extractFeatures(detail, devices) {
  const attrs = collectAttributes(detail);

  const featNames = (detail && Array.isArray(detail.features) ? detail.features : [])
    .map((f) => f && f.name)
    .filter(Boolean);

  const deviceNames = (Array.isArray(devices) ? devices : [])
    .map((d) => {
      const t = String(d && d.type || '').toUpperCase();
      return d?.category?.names[0].value;
    })
    .filter(Boolean);

  const extras = [];
  if (attrVal(attrs, ['ELEVATOR', 'AUFZUG'])) extras.push('Aufzug');
  if (attrVal(attrs, ['ROOFED', 'UEBERDACHT', 'ÜBERDACHT'])) extras.push('Überdacht');
  if (attrVal(attrs, ['RESTROOMS', 'WC'])) extras.push('WCs');
  if (attrVal(attrs, ['GUIDANCE_SYSTEM', 'LEITSYSTEM'])) extras.push('Leitsystem');

  const all = [].concat(featNames, deviceNames, extras).filter(Boolean);
  const set = {};
  for (let i = 0; i < all.length; i++) set[all[i]] = true;
  return Object.keys(set);
}

function extractPayments(detail) {
  const attrs = collectAttributes(detail);
  const namesSet = {};

  if (detail && Array.isArray(detail.features)) {
    for (let i = 0; i < detail.features.length; i++) {
      const f = detail.features[i];
      if (!f) continue;
      if (String(f.type || '').toUpperCase() === 'PAYMENT' && f.name) {
        namesSet[f.name] = true;
      }
    }
  }

  const payKeys = [
    'PAYPAL', 'PAY_PAL', 'VISA', 'MASTER_CARD', 'MASTERCARD',
    'AMERICAN_EXPRESS', 'GIRO_CARD', 'CASH', 'DEBIT_CARD',
    'EC_CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'PARKINGCARD'
  ];
  for (let i = 0; i < payKeys.length; i++) {
    const k = payKeys[i];
    const v = attrVal(attrs, [k]);
    if (v) {
      namesSet[k.replace(/_/g, ' ')] = true;
    }
  }

  return Object.keys(namesSet);
}
function firstChargingStationId(devicesRaw) {
    const list = pickArray(devicesRaw);
    for (const d of list) {
        if (!d) continue;
       const catKey = String(d?.category?.key || '').toUpperCase();
      const did = d?.id;
      if (catKey === 'CHARGINGSTATION' && did != null) return String(did);
     }
    return null;
  }
// ---------- Belegung (REST /iPCM) ----------
function normalizeOccForFacility(res, facId) {
  if (!res) return null;
  const fid = String(facId);

  if (Array.isArray(res)) {
    const match = res.find(x => String(x?.facilityId) === fid);
    if (match) return match;
    if (res.length === 1 && res[0]?.counters) return res[0];
    return null;
  }

  if (String(res.facilityId || '') === fid) return res;

  const arr = Array.isArray(res.items) ? res.items
    : Array.isArray(res.results) ? res.results
      : Array.isArray(res.content) ? res.content
        : [];
  return arr.find(x => String(x?.facilityId) === fid) || null;
}

function renderOccupancyTableFromRest(occJson) {
  const tbody = $('#occTable');
  const counters = (occJson && Array.isArray(occJson.counters)) ? occJson.counters : [];

  if (!counters.length) {
    tbody.innerHTML = '<tr><td colspan="6">Keine Zählstellen vorhanden.</td></tr>';
    return;
  }

  const rows = counters.map(c => {
    const keyOrName =
      c.name ||
      (c.nativeId && (c.nativeId.value || c.nativeId.id)) ||
      (c.counterType && Array.isArray(c.counterType.translations) && c.counterType.translations[0]?.value) ||
      c.key || '';

    const typ =
      (c.counterType && c.counterType.type) ||
      (c.type && c.type.type) ||
      '';

    const rsv = c.counterType?.reservationStatus ? ' · ' + c.counterType.reservationStatus : '';
    const statusCell = String(c.status || '') + rsv;

    return (
      '<tr>' +
      '<td>' + keyOrName + '</td>' +
      '<td>' + typ + '</td>' +
      '<td>' + (c.maxPlaces != null ? c.maxPlaces : '') + '</td>' +
      '<td>' + (c.occupiedPlaces != null ? c.occupiedPlaces : '') + '</td>' +
      '<td>' + (c.freePlaces != null ? c.freePlaces : '') + '</td>' +
      '<td>' + statusCell + '</td>' +
      '</tr>'
    );
  });

  tbody.innerHTML = rows.join('');
}

function combinedStatusFromRest(occJson) {
  const counters = (occJson && Array.isArray(occJson.counters)) ? occJson.counters : [];
  if (!counters.length) return 'unknown';

  const rank = { full: 3, tight: 2, free: 1, unknown: 0 };
  let best = 'unknown';

  for (let i = 0; i < counters.length; i++) {
    const s = String(counters[i].status || '').toLowerCase();
    if (rank[s] > rank[best]) best = s;
  }
  if (best !== 'unknown') return best;

  let max = 0, free = 0;
  for (let i = 0; i < counters.length; i++) {
    const c = counters[i];
    if (typeof c.maxPlaces === 'number') max += c.maxPlaces;
    if (typeof c.freePlaces === 'number') free += c.freePlaces;
  }
  if (max <= 0) return 'unknown';
  const ratio = (max - free) / max;
  if (ratio <= 0.60) return 'free';
  if (ratio <= 0.90) return 'tight';
  return 'full';
}

function summarizeCounters(counters = []) {
  let max = 0, occ = 0, free = 0, resOnlyMax = 0, noResMax = 0;
  for (const c of counters) {
    const m = Number(c.maxPlaces || 0);
    const o = Number(c.occupiedPlaces || 0);
    const f = Number(c.freePlaces || 0);
    max  += m;
    occ  += o;
    free += f;
    const r = c.counterType && c.counterType.reservationStatus;
    if (r === 'ONLY_RESERVATIONS') resOnlyMax += m;
    if (r === 'NO_RESERVATIONS')   noResMax  += m;
  }
  return { max, occ, free, resOnlyMax, noResMax };
}

// ===== Real Attribute Filters – Caches & Utils =====
const FAC_DETAIL_CACHE = new Map();
const FAC_DEV_CACHE    = new Map();
const CS_DETAIL_CACHE  = new Map();

const upKey = (k) => String(k || '').toUpperCase();
const toAttrsMap = (obj) => {
  const m = new Map();
  const attrs = collectAttributes(obj);
  for (const a of (attrs || [])) {
    if (!a) continue;
    const key = upKey(a.key);
    const val = a.value == null ? '' : String(a.value);
    m.set(key, val);
  }
  return m;
};
const attrHas = (attrsMap, key, needle) => {
  const v = attrsMap.get(upKey(key)) || '';
  return v && (needle ? v.toLowerCase().includes(String(needle).toLowerCase()) : true);
};
const anyAttrHas = (attrsMap, keys=[], predicate=(v)=>!!v) => {
  for (const k of keys) {
    const v = attrsMap.get(upKey(k));
    if (v != null && predicate(String(v))) return true;
  }
  return false;
};

async function getFacilityRich(id) {
  id = String(id);
  if (FAC_DETAIL_CACHE.has(id)) return FAC_DETAIL_CACHE.get(id);

  const [detail, devices] = await Promise.all([
    loadFacility(id).catch(()=>null),
    loadDevicesForFacility(id).then(pickArray).catch(()=>[])
  ]);

  const attrsMap = detail ? toAttrsMap(detail) : new Map();
  const deviceTypes = new Set(
    (devices || []).map(d => upKey(d?.type || d?.key || d?.name || ''))
  );

  const rich = { detail, attrsMap, devices, deviceTypes };
  FAC_DETAIL_CACHE.set(id, rich);
  return rich;
}

async function getChargingRich(id) {
  id = String(id);
  if (CS_DETAIL_CACHE.has(id)) return CS_DETAIL_CACHE.get(id);
  const detail = await loadChargingStation(id);
  const attrsMap = toAttrsMap(detail);
  const rich = { detail, attrsMap };
  CS_DETAIL_CACHE.set(id, rich);
  return rich;
}

// ---------- API ----------
async function apiJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  return ct.indexOf('json') !== -1 ? r.json() : r.text();
}

// iPAW Services:
const loadFacilityDefinitions = () => apiJSON('/api/facility-definitions');
const loadFacilities         = () => apiJSON('/api/facilities');
const loadFacility           = (id) => apiJSON('/api/facilities/' + encodeURIComponent(id));
// iPCM REST:
const loadOccupanciesForFacility = (id) => apiJSON('/api/occupancies/facility/' + encodeURIComponent(id));
const loadDevicesForFacility     = (id) => apiJSON('/api/devices/facility/' + encodeURIComponent(id));
// Charging:
const loadChargingStations   = () => apiJSON('/api/charging-stations/?firstResult=0&maxResults=3000&order=ASC&sort=DISTANCE');
const loadChargingStation    = (id) => apiJSON('/api/charging-stations/' + encodeURIComponent(id));

// ---------- State ----------
let FAC_ALL = [];
let FAC_FILTERED = [];
let CURRENT_FAC = null;
let CS_ALL = [];

// ---------- Rendering: Liste ----------
function renderFacilitiesTable(rows) {
  const tbody = $('#facilitiesTbody');
  const out = [];

  for (let i = 0; i < rows.length; i++) {
    const f = rows[i] || {};
    const id = f.id != null ? String(f.id) : '';
    const name = f.name || '';
    const def = f.definitionId != null ? String(f.definitionId) : '';
    out.push(
      '<tr>' +
      '<td><a class="id-link" href="#" data-fid="' + id + '">' + id + '</a></td>' +
      '<td>' + name + '</td>' +
      '</tr>'
    );
  }
  tbody.innerHTML = out.join('');

  $$('#facilitiesTbody .id-link').forEach((a) => {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      const id = this.getAttribute('data-fid');
      if (id) showFacilityDetails(id);
      if (document.getElementById('overlay')) {
        openOverlay('Details – Parkhaus');
      }
    });
  });

  $('#countBadge').textContent = rows.length + ' Treffer';
}

function filterFacilities() {
  const needle = ($('#filterText').value || '').toLowerCase();
  const feat   = readFeatureFlags();

  FAC_FILTERED = FAC_ALL.filter((f) => {
    // harte Schranke: nur Typ 14
    if (!ALLOWED_FAC_DEFS.has(String(f?.definitionId))) return false;

    // Parkhaus muss mindestens eine Ladestation / Steckdose haben
    if (feat.hasCharging && !f.hasCharging) return false;

    if (!needle) return true;
    const s = toLowerJsonStr({
      id:   f.id,
      name: f.name,
      city: f.city,
      def:  f.definitionId
    });
    return s.indexOf(needle) !== -1;
  });

  renderFacilitiesTable(FAC_FILTERED);
}


function chips(container, items) {
  const arr = (items || []).filter(Boolean);
  if (!arr.length) {
    container.innerHTML = '–';
    return;
  }
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    out.push('<span class="tag">' + String(arr[i]) + '</span>');
  }
  container.innerHTML = out.join('');
}

async function showFacilityDetails(id) {
  // --- lokale Helfer nur für diese Funktion ---
  function findTotalCounter(occJson) {
    const counters = (occJson && Array.isArray(occJson.counters)) ? occJson.counters : [];
    if (!counters.length) return null;

    // robuste Erkennung der "total"-Zeile
    return counters.find(c => {
      const key   = (c.key || c.name || '').toString().toLowerCase();
      const nId   = (c.nativeId && (c.nativeId.value || c.nativeId.id) || '').toString().toLowerCase();
      const ctype = (c.counterType && (c.counterType.type || '') || '').toString().toLowerCase();
      const label = (Array.isArray(c.counterType?.translations) ? (c.counterType.translations[0]?.value || '') : '').toString().toLowerCase();
      return key === 'total' || nId === 'total' || ctype === 'total' || label === 'total';
    }) || null;
  }

  function formatOccFromTotalRow(totalRow) {
    if (!totalRow) return '–';
    const max  = (typeof totalRow.maxPlaces === 'number') ? totalRow.maxPlaces : null;
    const occ  = (typeof totalRow.occupiedPlaces === 'number') ? totalRow.occupiedPlaces : null;
    const free = (typeof totalRow.freePlaces === 'number')
      ? totalRow.freePlaces
      : (max != null && occ != null ? (max - occ) : null);

    let status = (totalRow.status || '').toString().toLowerCase();
    if (!status && max && (occ != null)) {
      const ratio = occ / max;
      status = (ratio <= 0.60) ? 'free' : (ratio <= 0.90 ? 'tight' : 'full');
    }
    const statusDe = status === 'free' ? 'frei'
      : status === 'tight' ? 'angespannt'
        : status === 'full' ? 'voll'
          : 'unbekannt';

    const parts = [];
    parts.push(statusDe);
    if (occ != null && max != null) parts.push(`${occ}/${max} belegt`);
    if (max != null) $('#facCapacity').textContent = max;
    if (free != null) parts.push(`${free} frei`);
    return parts.join(' · ');
  }

  try {
    // 1) Stammdaten iPAW
    const detail = await loadFacility(id);

    // 2) Devices & (nur) Belegung für diese Facility
    const [devicesRaw, occRaw] = await Promise.all([
      loadDevicesForFacility(id).catch(() => null),
      loadOccupanciesForFacility(id).catch(() => null),
    ]);

    // --- UI: Stammdaten ---
    let facAddrHtml = extractAddressFromAttributes(detail) || '';

// 2) Fallback/Ergänzung: Adresse aus verknüpfter Ladestation ziehen
    try {
      const csId = firstChargingStationId(devicesRaw);
      if (csId) {
        const csDetail = await getChargingRich(csId).then(r => r.detail).catch(() => null);
        const csAddr = csDetail
          ? (extractAddressFromAttributes(csDetail) || csDetail.postalAddress || '')
          : '';

        // Standard: nur wenn Facility-Adresse leer ist, nimm die CS-Adresse
        if (!facAddrHtml && csAddr) {
          facAddrHtml = csAddr;
        }

        // Falls du IMMER die CS-Adresse bevorzugen willst, nimm stattdessen:
        // if (csAddr) facAddrHtml = csAddr;

        // Oder beides anzeigen (mit Label):
        // if (csAddr && csAddr !== facAddrHtml) {
        //   facAddrHtml = [facAddrHtml || '–', '<span class="muted">(Adresse aus Ladestation)</span><br/>', csAddr]
        //     .filter(Boolean).join('<br/>');
        // }
      }
    } catch { /* still okay */ }
    $('#facName').textContent      = (detail && detail.name) || '–';
    $('#facAddress').innerHTML = facAddrHtml || '–';
    $('#facClearance').textContent = extractClearance(detail) || '–';
    $('#facCapacity').textContent  = extractCapacity(detail) || '–';
    $('#facRates').textContent     = extractRates(detail) || '–';

    const devices = pickArray(devicesRaw);
    chips($('#facFeatures'), extractFeatures(detail, devices));
    chips($('#facPayments'), extractPayments(detail));

    // --- Belegung: nur "total"-Zeile in facStatus ---
    let occJson = null;
    if (occRaw) {
      occJson = normalizeOccForFacility(occRaw, id)
        || (Array.isArray(occRaw) ? occRaw.find(x => String(x?.facilityId) === String(id)) : null);
    }
    const totalRow = findTotalCounter(occJson);
    $('#facStatus').textContent = formatOccFromTotalRow(totalRow);

    // --- Rohdaten (Facility) ---
    $('#facRaw').textContent = safeJson(detail);

  } catch (e) {
    $('#facName').textContent = 'Fehler';
    $('#facRaw').textContent  = safeJson({ error: String(e && e.message ? e.message : e) });
    $('#facStatus').textContent = '–';
  }
}
// ---------- E-Ladestationen ----------

// Basic attribute getter (used below)
function getAttr(attrs, key) {
  const K = String(key).toUpperCase();
  const arr = attrs || [];
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a && String(a.key).toUpperCase() === K) return a.value != null ? a.value : '';
  }
  return '';
}

// === Charging helpers (plug type, power, payment) ===
function stationPlugType(station) {
  const outlets = Array.isArray(station?.outlets) ? station.outlets : [];
  for (const o of outlets) {
    const oa = Array.isArray(o?.attributes) ? o.attributes : [];
    const t = (getAttr(oa, 'OUTLET_TYPE') || '').toUpperCase();
    if (t.includes('CCS')) return 'CCS';
  }
  // Default: map unknown/Sonstige to Type 2
  return 'Type 2';
}

function stationMaxPowerKw(station) {
  // Bestimme die stärkste Outlet-Leistung einer Station in kW.
  // Quelle 1: MAX_ELECTRIC_POWER (W) -> kW
  // Quelle 2: OUTLET_TYPE-Suffix …KW (z. B. ARCS_CHARGING_OUTLET_CCS_CABLE_DC_150KW)
  let maxKW = 0;
  const outlets = Array.isArray(station?.outlets) ? station.outlets : [];
  for (const o of outlets) {
    const kw = getOutletPowerKW(o); // nutzt MAX_ELECTRIC_POWER ODER …KW-Suffix
    if (kw != null && kw > maxKW) maxKW = kw;
  }
  return maxKW || null;
}

function stationHasPayment(station, needle /* 'Direct' | 'Contract' */) {
  const attrs = collectAttributes(station);
  const raw = getAttr(attrs, 'PAYMENT_OPTIONS'); // e.g. "Direct\nContract"
  if (!raw) return false;
  const parts = raw.split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean);
  return parts.includes(String(needle).toLowerCase());
}

function renderChargingList(list) {
  const tbody = $('#chargeTbody');
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const x = list[i] || {};
    const id = x.id != null ? String(x.id) : '';
    const nm = x.name || x.label || 'Ladestation';
    out.push(
      '<tr>' +
      '<td><a class="id-link" href="#" data-csid="' + id + '">' + id + '</a></td>' +
      '<td>' + nm + '</td>' +
      '</tr>'
    );
  }
  tbody.innerHTML = out.join('');

  $('#countBadge2').textContent = list.length + ' Treffer';
  $$('#chargeTbody .id-link').forEach((a) => {
    a.addEventListener('click', async function (e) {
      e.preventDefault();
      const id = this.getAttribute('data-csid');
      try {
        const d = await loadChargingStation(id);
        renderChargingDetail(d);
        if (document.getElementById('overlay')) {
          openOverlay('Details – Ladestation');
        }
      } catch (err) {
        $('#csRaw').textContent = safeJson({ error: String(err && err.message ? err.message : err) });
      }
    });
  });
}

function extractChargingImageIds(detail) {
   const ids = new Set();
   if (!detail || typeof detail !== 'object') return [];

      // 1) Häufiges Schema: detail.images = [{ id }] oder { fileAttachmentId }
        if (Array.isArray(detail.images)) {
       for (const im of detail.images) {
            const a = im && (im.id ?? im.fileAttachmentId);
            if (a != null) ids.add(String(a));
        }
     }
   // 2) Alternativ: detail.fileAttachments = [{ id }]
     if (Array.isArray(detail.fileAttachments)) {
       for (const fa of detail.fileAttachments) {
           const a = fa && (fa.id ?? fa.fileAttachmentId);
           if (a != null) ids.add(String(a));
         }
     }
   // 3) Manchmal hängen Bilder an EVSE/Outlets
     if (Array.isArray(detail.outlets)) {
       for (const o of detail.outlets) {
           if (Array.isArray(o?.images)) {
               for (const im of o.images) {
                   const a = im && (im.id ?? im.fileAttachmentId);
                   if (a != null) ids.add(String(a));
                }
             }
         }
      }
    return Array.from(ids);
}
async function loadChargingAndWire() {
  const all = await loadChargingStations();
  CS_ALL = pickArray(all).sort((a, b) => Number(a.id) - Number(b.id));;

  // initial mit aktuellen Häkchen rendern
  applyChargingFilters();

  const bind = (sel, ev = 'change') => {
    const el = document.querySelector(sel);
    if (el) el.addEventListener(ev, applyChargingFilters);
  };
  bind('#chargeFilter', 'input');

  // Payment
  bind('#csPayDirect');
  bind('#csPayContract');

  // Steckertyp
  bind('#ef-conn-type2');
  bind('#ef-conn-ccs');

  // Leistung
  bind('#ef-pwr-50');
  bind('#ef-pwr-100');
  bind('#ef-pwr-150');
}
// Apply all charging filters (text, payment, connector, power)
function applyChargingFilters() {
  const qtext = ($('#filterText')?.value || '').toLowerCase(); // Volltext global
  const qright = ($('#chargeFilter')?.value || '').toLowerCase(); // rechter Filter (falls genutzt)

  const wantDirect   = $('#csPayDirect')?.checked || false;
  const wantContract = $('#csPayContract')?.checked || false;

  const fType2 = $('#ef-conn-type2')?.checked || false;
  const fCCS   = $('#ef-conn-ccs')?.checked || false;

  const p50  = $('#ef-pwr-50')?.checked || false;
  const p100 = $('#ef-pwr-100')?.checked || false;
  const p150 = $('#ef-pwr-150')?.checked || false;

  let minKw = 0;
  if (p150) minKw = 150; else if (p100) minKw = 100; else if (p50) minKw = 50;

  const feat = readFeatureFlags();

  const rows = CS_ALL.filter(st => {
    // Volltext (global links) + rechter Textfilter (zusätzlich)
    if (qtext)  { if (toLowerJsonStr(st).indexOf(qtext)  === -1) return false; }
    if (qright) { if (toLowerJsonStr(st).indexOf(qright) === -1) return false; }

    // Payment
    if (wantDirect   && !stationHasPayment(st, 'Direct'))   return false;
    if (wantContract && !stationHasPayment(st, 'Contract')) return false;

    // Steckertyp
    const plug = stationPlugType(st);
    if (fType2 && plug !== 'Type 2') return false;
    if (fCCS   && plug !== 'CCS')    return false;

    // Leistung
    const kw = stationMaxPowerKw(st) || 0;
    if (minKw && kw < minKw) return false;

    // 🔎 Feature-Checkboxen (wirken auf Charging-Attributes)
    if (feat.surveillance && !stationHasFeature(st, 'surveillance')) return false;
    if (feat.roofed       && !stationHasFeature(st, 'roofed'))       return false;
    if (feat.elevator     && !stationHasFeature(st, 'elevator'))     return false;
    if (feat.accessible   && !stationHasFeature(st, 'accessible'))   return false;
    if (feat.bike         && !stationHasFeature(st, 'bike'))         return false;
    if (feat.family       && !stationHasFeature(st, 'family'))       return false;
    if (feat.women        && !stationHasFeature(st, 'women'))        return false;
    if (feat.available    && !stationHasFeature(st, 'available'))        return false;

    return true;
  });

  renderChargingList(rows);
}
function wireFeatureCheckboxesBothPanels() {
  const ids = [
    // Parkhäuser-Panel
    '#pf-charging','#pf-roofed','#pf-elevator',
    '#pf-accessible','#pf-bike','#pf-family','#pf-women',
    // E-Laden-Panel
    '#ef-available',
    // Payment/Steckertyp/Power direkt im E-Laden-Panel
    '#csPayDirect','#csPayContract',
    '#ef-conn-type2','#ef-conn-ccs',
    '#ef-pwr-50','#ef-pwr-100','#ef-pwr-150'
  ];
  ids.forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.addEventListener('change', () => {
        // Re-apply both sides so everything stays in sync
        filterFacilities();
        applyChargingFilters();
      });
    }
  });
}

// --- Feature-Mapping für Charging-Attributes ---
function stationHasFeature(station, featureKey) {
  const attrs = collectAttributes(station);
  let is_Available = false;
  is_Available = station.nativeStatus == "AVAILABLE";
  const outlets = Array.isArray(station?.outlets) ? station.outlets : [];
  for (const o of outlets) {
    if (o?.nativeStatus == "AVAILABLE") {
      is_Available = true;
    };
  }
  const hasAny = (keys, pred = (v)=>!!String(v).trim()) =>
    anyAttrHas(toAttrsMap({ attributes: attrs }), keys, pred);

  switch (featureKey) {
     case 'surveillance': // Überwacht / Kamera / CCTV
      return hasAny(['SURVEILLANCE','CCTV','CAMERA','VIDEO_SURVEILLANCE','UEBERWACHT','ÜBERWACHT']);
    case 'roofed':       // Überdacht
      return hasAny(['ROOFED','UEBERDACHT','ÜBERDACHT'], v => String(v).toLowerCase() !== 'false');
    case 'elevator':     // Aufzug
      return hasAny(['ELEVATOR','AUFZUG'], v => String(v).toLowerCase() !== 'false');
    case 'accessible':   // Barrierefrei
      return hasAny(['ACCESSIBLE','BARRIER_FREE','BARRIEREFREI','ACCESSIBILITY'], v => /barrier|frei|yes|true/i.test(String(v)));
    case 'bike':         // Fahrradstellplatz
      return hasAny(['BIKE_PARKING','BICYCLE_PARKING','FAHRRADSTELLPLATZ']);
    case 'family':       // Familienparkplatz
      return hasAny(['FAMILY_PARKING','FAMILIENPARKPLATZ']);
    case 'available':       // Familienparkplatz
      return is_Available;
    case 'women':        // Frauenparkplatz
      return hasAny(['WOMEN_PARKING','FRAUENPARKPLATZ']);
    default:
      return false;
  }
}

function outletAttr(outlet, key) {
  const K = String(key).toUpperCase();
  const arr = outlet?.attributes || [];
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a && String(a.key).toUpperCase() === K) return a.value != null ? String(a.value) : '';
  }
  return '';
}

function inferPlugTypeFromOutletType(otVal = '') {
  const s = String(otVal).toUpperCase();
  if (s.includes('CCS')) return 'CCS';
  // Sonstige & alles andere => Type 2
  return 'Type 2';
}

function parseKWFromOutletType(otVal = '') {
  const m = String(otVal).match(/(\d+(?:[.,]\d+)?)\s*KW/i);
  if (!m) return null;
  const n = Number(String(m[1]).replace(',', '.'));
  return isNaN(n) ? null : n;
}

function getOutletPowerKW(outlet) {
  // 1) MAX_ELECTRIC_POWER (W) -> kW
  const maxW = outletAttr(outlet, 'MAX_ELECTRIC_POWER');
  if (maxW) {
    const n = Number(String(maxW).replace(',', '.'));
    if (!isNaN(n) && n > 0) return +(n / 1000).toFixed(1);
  }
  // 2) am Ende von OUTLET_TYPE …KW
  const ot = outletAttr(outlet, 'OUTLET_TYPE');
  const kw = parseKWFromOutletType(ot);
  if (kw) return kw;
  return null;
}

function buildOutletsView(detail) {
  const outlets = Array.isArray(detail?.outlets) ? detail.outlets : [];
  return outlets.map((o) => {
    const otVal   = outletAttr(o, 'OUTLET_TYPE');
    const type    = inferPlugTypeFromOutletType(otVal);
    const powerKW = getOutletPowerKW(o);
    return { type, powerKW };
  });
}
function stationAttrsMap(station) {
  const m = new Map();
  const attrs = collectAttributes(station) || [];
  for (const a of attrs) {
    if (!a || a.key == null) continue;
    m.set(String(a.key).toUpperCase(), a.value != null ? String(a.value) : '');
  }
  return m;
}
function hasAnyKeyTrue(attrsMap, keys) {
  for (const k of keys) {
    const v = attrsMap.get(String(k).toUpperCase());
    if (v == null) continue;
    const b = boolFromString(v);
    if (b === true) return true;
    if (b === null && String(v).trim() !== '') return true; // "vorhanden" ohne boolean
  }
  return false;
}
// Einzelne Prädikate
function csHasHeightLimit(st) {
  const M = stationAttrsMap(st);
  // Höhe gilt als vorhanden, wenn eine der Höhenangaben gesetzt ist
  return hasAnyKeyTrue(M, ['HEIGHT_LIMIT_CM','EINFAHRTSHOEHE_CM','EINFAHRTSHÖHE_CM','CLEARANCE_METERS','EINFAHRTSHOEHE_M','EINFAHRTSHÖHE_M']);
}
function csIsSurveilled(st) {
  const M = stationAttrsMap(st);
  return hasAnyKeyTrue(M, ['SURVEILLANCE','VIDEO_SURVEILLANCE','VIDEOÜBERWACHUNG']);
}
function csIsRoofed(st) {
  const M = stationAttrsMap(st);
  return hasAnyKeyTrue(M, ['ROOFED','UEBERDACHT','ÜBERDACHT']);
}
function csHasElevator(st) {
  const M = stationAttrsMap(st);
  return hasAnyKeyTrue(M, ['ELEVATOR','AUFZUG']);
}
function csHasBikeParking(st) {
  const M = stationAttrsMap(st);
  return hasAnyKeyTrue(M, ['BICYCLE_PARKING','BIKE_PARKING','FAHRRADSTELLPLATZ']);
}
function csHasFamilyParking(st) {
  const M = stationAttrsMap(st);
  return hasAnyKeyTrue(M, ['FAMILY_PARKING','FAMILIENPARKPLATZ']);
}
function csHasAvailable(st) {
  const M = stationAttrsMap(st);
  return hasAnyKeyTrue(M, ['AVAILABLE','IS_AVAILABLE']);
}
function csHasWomenParking(st) {
  const M = stationAttrsMap(st);
  return hasAnyKeyTrue(M, ['WOMEN_PARKING','FRAUENPARKPLATZ','LADIES_PARKING']);
}
function renderChargingDetail(detail) {
  const attrs = collectAttributes(detail);

  $('#csName').textContent    = (detail && (detail.name || detail.label)) || '–';
  $('#csAddress').innerHTML = extractAddressFromAttributes(detail) || (detail && detail.addressLine) || '–';

  const pay  = splitLines(getAttr(attrs, 'PAYMENT_OPTIONS'));
  chips($('#csPay'),  pay);
  try {
     const imgEl  = document.getElementById('csImage');
      const boxEl  = document.getElementById('csImageBox');
      const imgId = detail?.image?.id;
      if (imgEl && boxEl) {
          if (imgId) {
             // Proxy liefert Bild direkt durch → <img src="/api/charging-files/:id">
             imgEl.src = '/api/charging-files/' + imgId;
             imgEl.style.display = 'block';
          } else {
             imgEl.removeAttribute('src');
              imgEl.style.display = 'none';
           }
       }
    } catch {}



  // ---- Outlets (Steckertyp & Leistung je Outlet) ----
  const views = buildOutletsView(detail);

  // Steckertyp (unique)
  const typesUnique = Array.from(new Set(views.map(v => v.type))).filter(Boolean);
  $('#csPlugType').textContent = typesUnique.length ? typesUnique.join(', ') : '–';

  // Leistung (alle Outlets, Zeile je EVSE)
  if (views.length) {
    const lines = views.map(v => {
      const p = (v.powerKW != null) ? (v.powerKW + ' kW') : '–';
      return `${p} (${v.type})`;
    });
    $('#csPower').innerHTML = lines.join('<br>');
  } else {
    $('#csPower').textContent = '–';
  }

  $('#csRaw').textContent = safeJson(detail);
}

async function enrichFacilitiesWithFlags() {
  // Compute derived flags like "hasCharging" for each facility
  await Promise.all(
    FAC_ALL.map(async (f) => {
      const id = f && f.id;
      if (id == null) {
        f.hasCharging = false;
        return;
      }
      try {
        const rich = await getFacilityRich(id); // uses cache + loads devices
        const devices = Array.isArray(rich?.devices) ? rich.devices : [];
        const hasCharging = devices.some((d) => {
          if (!d) return false;
          const catKey = String(d?.category?.key || '').toUpperCase();
          const type   = String(d?.type || '').toUpperCase();
          return (
            catKey === 'CHARGINGSTATION' ||
            type.includes('CHARGING') ||
            type.includes('EVSE')
          );
        });
        f.hasCharging = hasCharging;
      } catch (e) {
        console.warn('hasCharging check failed for facility', id, e);
        f.hasCharging = false;
      }
    })
  );
}
// ---------- Boot ----------
async function reloadFacilities() {
  const data = await loadFacilities();
  const all = pickArray(data);

  // Nur Typ/Definition 14
  FAC_ALL = all
    .filter(f => ALLOWED_FAC_DEFS.has(String(f?.definitionId)))
    .sort((a, b) => Number(a.id) - Number(b.id));

  // Enrich facilities with flags like hasCharging
  //await enrichFacilitiesWithFlags();
  filterFacilities();
}
function setModeUI(mode) {
  const m = mode || ($('#modeSelect')?.value || 'parkhaus');
  // Nur die Filter-Sektionen umschalten
  $('#pfContainer').style.display = (m === 'parkhaus') ? 'grid' : 'none';
  $('#efContainer').style.display = (m === 'eladen')   ? 'grid' : 'none';
  $('.layout > .panel:first-of-type').style.display = (m === 'eladen')   ? 'none' : 'block';
  $('.layout > .panel:nth-of-type(2)').style.display = (m === 'eladen')   ? 'block' : 'none';
}
function readFeatureFlags() {
  // gleiche Semantik für pf-* und ef-*; wenn eins gesetzt ist, gilt es
  const q = (id) => !!(document.querySelector('#' + id)?.checked);

  return {
    surveillance: q('pf-surveillance'),
    roofed:       q('pf-roofed'),
    elevator:     q('pf-elevator'),
    accessible:   q('pf-accessible'),
    bike:         q('pf-bike'),
    family:       q('pf-family'),
    hasCharging:  q('pf-hascharging'),
    women:        q('pf-women'),
    available:    q('ef-available')
  };
}

function resetFilters(mode) {
  const m = mode || ($('#modeSelect')?.value || 'parkhaus');
  const box = (m === 'eladen') ? $('#efContainer') : $('#pfContainer');
  if (!box) return;
  box.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  if (m === 'eladen') {
    const cf = $('#chargeFilter'); if (cf) cf.value = '';
  } else {
    const ft = $('#filterText'); if (ft) ft.value = '';
  }
}

function applyTopFilters() {
  filterFacilities();
  applyChargingFilters();
}
function openOverlay(title) {
  const ov  = document.getElementById('overlay');
  const ttl = document.getElementById('overlayTitle');
  if (!ov) return;                // falls Overlay-HTML noch nicht eingebaut ist
  if (ttl && title) ttl.textContent = title;
  (title.indexOf("Lade") != -1) && ov.querySelector(".modal-grid").classList.add("lade");
  ov.classList.add('open');
  document.body.classList.add('modal-open');
}
function closeOverlay() {
  const ov = document.getElementById('overlay');
  if (!ov) return;
  ov.classList.remove('open');
  ov.querySelector(".modal-grid").classList.remove("lade");
  document.body.classList.remove('modal-open');
}
async function boot() {

  await reloadFacilities();        // lädt und filtert (Definition 14)
  await loadChargingAndWire();     // lädt CS initial + verdrahtet

  // Volltext wirkt links & rechts
  $('#filterText').addEventListener('input', () => {
    filterFacilities();
    applyChargingFilters();
  });

  // Mode-Schalter (nur UI)
  $('#modeSelect').addEventListener('change', () => {
    setModeUI();
    applyTopFilters();
  });
  setModeUI();

  wireFeatureCheckboxesBothPanels();

  // Globale Filterknöpfe
  $('#btnApplyFilters').addEventListener('click', () => {
    filterFacilities();
    applyChargingFilters();
  });
  $('#btnResetFilters').addEventListener('click', () => {
    resetFilters();
    filterFacilities();
    applyChargingFilters();
  });

  const ov = document.getElementById('overlay');
  const btnClose = document.getElementById('overlayClose');
  if (btnClose) btnClose.addEventListener('click', closeOverlay);
  if (ov) ov.addEventListener('click', (e) => { if (e.target === ov) closeOverlay(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });
}

window.addEventListener('DOMContentLoaded', boot);