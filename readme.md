# Goldbeck Parking Proxy


Kleines Test-Tool um die Goldbeck-Parking-APIs über einen serverseitigen Proxy (Basic Auth) aufzurufen. Enthält eine minimalistische Web-UI mit Client-Filter.


## Quickstart
```bash
npm i
npm run start
# → http://localhost:4000
```


## Umgebungen
In `.env` umschalten:
```bash
# TEST
GB_BASE_URL=https://91.213.98.137/ipaw
# PROD
# GB_BASE_URL=https://control.goldbeck-parking.de/ipaw


GB_USER=CC webservicegps
GB_PASS=webservice
PORT=4000
```


## Endpunkte (Proxy)
- `GET /api/charging-stations` → `/services/charging/v1x0/charging-stations`
- `GET /api/charging-files/:fileAttachmentId` → `/services/charging/v1x0/files/{id}`
- `GET /api/facilities` → `/services/v4x0/facilities`
- `GET /api/facility-definitions` → `/services/v4x0/facilitydefinitions`
- `GET /api/features` → `/services/v4x0/features`
- `GET /api/filecontent` → `/services/v4x0/filecontent`
- `GET /api/occupancies` → `/services/v4x0/occupancies`


Alle Routen setzen Basic Auth **serverseitig**. Query-Parameter werden 1:1 weitergereicht.


## UI & Filter
Öffne `http://localhost:4000` – wähle Endpoint, optional `definitionId` (14 = Parkhaus, 1003 = E‑Charging), optionale Queries (z. B. `city`, `name`) und Client-Volltextfilter.