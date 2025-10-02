const $ = (id) => document.getElementById(id);
const out = $('out');
const count = $('count');


const show = (data) => {
  const n = Array.isArray(data) ? data.length : (Array.isArray(data?.items) ? data.items.length : 0);
  count.textContent = String(n);
  out.textContent = JSON.stringify(data, null, 2);
};


const pickArray = (json) => {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.results)) return json.results;
  return [];
};


const clientFilter = (arr, q) => {
  if (!q) return arr;
  const needle = q.toLowerCase();
  return arr.filter((x) => JSON.stringify(x).toLowerCase().includes(needle));
};


$('btn-load').onclick = async () => {
  const ep = $('endpoint').value;
  const q = $('q').value.trim();
  const def = $('def').value;
  const facilityId = $('facility').value.trim();


// Upstream unterstützte Filter
  const params = new URLSearchParams();


// Nur dort anhängen, wo es sinnvoll ist
  if (def && (ep === '/api/facilities' || ep === '/api/features' || ep === '/api/facility-definitions' || ep === '/api/charging-stations')) {
    params.set('definitionId', def);
  }
  if (facilityId && (ep === '/api/occupancies' || ep === '/api/charging-stations')) {
    params.set('facilityId', facilityId);
  }


// Occupancies brauchen oft facilityId → sanfter Hinweis
  if (ep === '/api/occupancies' && !facilityId) {
    out.textContent = 'Tipp: Für Occupancies eine facilityId setzen (sonst kommt evtl. nichts / sehr viel).';
  }


  const url = ep + (params.toString() ? `?${params.toString()}` : '');


  out.textContent = 'Lade ' + url + ' ...';
  count.textContent = '…';


  try {
    const res = await fetch(url);
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      const text = await res.text().catch(()=>'');
      show({ error: res.status + ' ' + res.statusText, body: text });
      return;
    }
    const json = ct.includes('application/json') ? await res.json() : await res.text();
    const arr = typeof json === 'string' ? [{ note: 'Non-JSON response', body: json.slice(0, 1000) }] : pickArray(json);
    const filtered = clientFilter(arr, q);
    show(filtered);
  } catch (e) {
    show({ error: String(e) });
  }
};


// Autoload
$('btn-load').click();