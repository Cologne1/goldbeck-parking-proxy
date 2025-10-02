const $ = (id) => document.getElementById(id);
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
  const city = $('city').value.trim();
  const name = $('name').value.trim();


  const params = new URLSearchParams();
  if (def) params.set('definitionId', def); // Upstream-Filter, wenn unterstützt
  if (city) params.set('city', city);
  if (name) params.set('name', name);


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
    const arr = typeof json === 'string' ? [{ note: 'Non-JSON response', body: json.slice(0,1000) }] : pickArray(json);
    const filtered = clientFilter(arr, q);
    show(filtered);
  } catch (e) {
    show({ error: String(e) });
  }
};


// Autoload beim Start
$('btn-load').click();