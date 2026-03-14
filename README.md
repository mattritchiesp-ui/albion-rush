# Albion Rush

Small Express app that shows live Brisbane train departures using TransLink GTFS Realtime data.

## Modes

- **Albion** — next inbound trains at Albion station toward Roma Street
- **Roma → Milton** — next departures from Roma Street that continue to Milton

## Stack

- Node.js
- Express
- `gtfs-realtime-bindings`
- `node-fetch`

## Local development

```bash
npm install
npm start
```

Server starts on:

- `http://localhost:3000`
- or `process.env.PORT` when deployed

## API

### `GET /api/departures?mode=albion|roma-milton`

Example:

```bash
curl "http://localhost:3000/api/departures?mode=albion"
```

Example response:

```json
{
  "departures": [
    {
      "line": "Shorncliffe",
      "minutes": 3,
      "departureTs": 1773479321,
      "platform": "1"
    }
  ],
  "fetchedAt": 1773479311610
}
```

## Deployment

This app is suitable for Railway with default Node detection:

- install command: `npm install`
- start command: `npm start`

No database or build step is required.

## Notes

- GTFS realtime data is fetched from TransLink:
  `https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates`
- The server keeps a short in-memory cache to avoid unnecessary upstream fetches.
