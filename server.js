const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { transit_realtime } = require('gtfs-realtime-bindings');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const GTFS_RT_URL = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates';

// Friendly line names from TransLink route ID codes (format: ORIG→DEST-version)
// Codes are 2–4 char abbreviations: BD=Beenleigh, BN=Brisbane, BR=Brisbane,
// CA=Caboolture, CL=Cleveland, DB=Doomben, FG=Ferny Grove, GY=Gympie,
// IP=Ipswich, NA=Nambour/Airport, RP=Redcliffe Peninsula, RW=Rosewood,
// SH=Shorncliffe, SM=Stradbroke, SP=Springfield, VL=Varsity Lakes
const ROUTE_SEGMENTS = {
  BD: 'Beenleigh', BN: 'Brisbane', BR: 'Brisbane City',
  CA: 'Caboolture', CL: 'Cleveland', DB: 'Doomben',
  FG: 'Ferny Grove', GY: 'Gympie', IP: 'Ipswich',
  NA: 'Nambour/Airport', RP: 'Redcliffe', RW: 'Rosewood',
  SH: 'Shorncliffe', SP: 'Springfield', VL: 'Varsity Lakes',
  AI: 'Airport', GC: 'Gold Coast',
};

function friendlyRoute(routeId) {
  if (!routeId) return 'Train';
  const id = routeId.toUpperCase();
  // Try to decode ORIG+DEST pattern (e.g. CLSH = Cleveland→Shorncliffe)
  if (/^[A-Z]{4,6}-/.test(id)) {
    const code = id.split('-')[0]; // e.g. "CLSH", "RPSP", "NAIP"
    // 4-char codes: split into 2+2
    if (code.length === 4) {
      const orig = ROUTE_SEGMENTS[code.slice(0, 2)];
      const dest = ROUTE_SEGMENTS[code.slice(2, 4)];
      if (orig && dest) return `${orig} ↔ ${dest}`;
      if (dest) return dest;
      if (orig) return orig;
    }
    // Fallback: check first 2 chars for destination clue
    const dest = ROUTE_SEGMENTS[code.slice(2, 4)];
    if (dest) return dest;
  }
  return routeId;
}

// Stop ID config
const STOP_CONFIG = {
  albion: {
    stopIds: ['600365', '600366', '600368'],
    label: 'Albion → City',
    // Filter: only trips heading citybound (direction_id 0)
    directionId: 0,
  },
  'to-milton': {
    // From Roma Street, trains that will also stop at Milton
    // direction_id not reliable here — use requiredStopIds filter only
    stopIds: ['600028', '600029'],
    label: 'Roma Street → Milton',
    requiredStopIds: ['600279', '600280'],
  },
  'to-albion': {
    // From Roma Street, trains that will also stop at Albion
    stopIds: ['600028', '600029'],
    label: 'Roma Street → Albion',
    requiredStopIds: ['600365', '600366', '600368'],
  },
};

// Platform name lookup for Roma Street stop IDs
const PLATFORM_NAMES = {
  '600028': '7',
  '600029': '8',
  '600365': '1',
  '600366': '2',
  '600368': '3',
  '600279': '1',
  '600280': '2',
};

// Simple in-memory cache
let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 15000;

async function fetchGTFSRT() {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.data;
  }

  const response = await fetch(GTFS_RT_URL);
  if (!response.ok) {
    throw new Error(`TransLink API error: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
  cache = { data: feed, timestamp: now };
  return feed;
}

function getDepartures(feed, mode) {
  const config = STOP_CONFIG[mode];
  if (!config) return [];

  const now = Date.now() / 1000; // UNIX seconds
  const results = [];
  const seenTripIds = new Set();

  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu || !tu.stopTimeUpdate || !tu.stopTimeUpdate.length) continue;

    const tripId = tu.trip && tu.trip.tripId;
    if (seenTripIds.has(tripId)) continue;

    // Filter by direction_id if available
    if (
      config.directionId !== undefined &&
      tu.trip &&
      tu.trip.directionId !== undefined &&
      tu.trip.directionId !== config.directionId
    ) {
      continue;
    }

    // Find the stop update for our target stop IDs
    let targetUpdate = null;
    let targetStopId = null;
    for (const stu of tu.stopTimeUpdate) {
      if (config.stopIds.includes(stu.stopId)) {
        targetUpdate = stu;
        targetStopId = stu.stopId;
        break;
      }
    }
    if (!targetUpdate) continue;

    // For to-milton and to-albion: also check that the trip will stop at the required downstream stop
    if (config.requiredStopIds) {
      const tripStops = tu.stopTimeUpdate.map((s) => s.stopId);
      const hasRequired = config.requiredStopIds.some((id) => tripStops.includes(id));
      if (!hasRequired) continue;
    }

    // Get departure time
    const dep = targetUpdate.departure || targetUpdate.arrival;
    if (!dep) continue;

    // dep.time is a Long (protobuf); convert safely
    const depTimeSec = typeof dep.time === 'object' ? dep.time.toNumber() : Number(dep.time);
    if (isNaN(depTimeSec) || depTimeSec < now - 60) continue; // skip past trains (allow 1min grace)

    const minutesAway = Math.round((depTimeSec - now) / 60);
    const scheduledDate = new Date(depTimeSec * 1000);
    const scheduledTime = scheduledDate.toLocaleTimeString('en-AU', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const platform = PLATFORM_NAMES[targetStopId] || '?';
    const rawRouteId = (tu.trip && tu.trip.routeId) || '';
    const headsign = (tu.trip && tu.trip.headsign) || friendlyRoute(rawRouteId);
    const routeId = friendlyRoute(rawRouteId);

    results.push({
      tripId,
      minutes: minutesAway,
      scheduledTime,
      headsign,
      routeId,
      platform,
      departureTs: depTimeSec,
    });

    seenTripIds.add(tripId);
  }

  // Sort by departure time, return next 3
  results.sort((a, b) => a.departureTs - b.departureTs);
  return results.slice(0, 3).map(({ tripId, departureTs, ...rest }) => rest);
}

app.get('/api/departures', async (req, res) => {
  const mode = req.query.mode || 'albion';
  if (!STOP_CONFIG[mode]) {
    return res.status(400).json({ error: `Unknown mode: ${mode}` });
  }

  try {
    const feed = await fetchGTFSRT();
    const departures = getDepartures(feed, mode);
    res.json({ mode, label: STOP_CONFIG[mode].label, departures, fetchedAt: Date.now() });
  } catch (err) {
    console.error('Error fetching GTFS-RT:', err.message);
    res.status(502).json({ error: 'Could not fetch live data — check TransLink' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Albion Rush running at http://localhost:${PORT}`);
});
