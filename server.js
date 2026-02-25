const express = require('express');
const fetch = require('node-fetch');
const { transit_realtime } = require('gtfs-realtime-bindings');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const GTFS_RT_URL = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates';

const MODES = {
  albion: {
    stopIds: ['600365', '600366', '600368'],
    directionId: 0,
    useDestination: false,
  },
  'roma-milton': {
    stopIds: ['600029'],
    requiredStopIds: ['600279', '600280'],
    useDestination: true,
  },
};

// Stop ID → platform number (from TransLink GTFS static data)
const PLATFORM_NAMES = {
  // Roma Street
  '600028': '7',
  '600029': '8',
  '600030': '6',
  '600033': '3',
  '600034': '5',
  '600035': '10',
  '600036': '4',
  '600038': '9',
  // Albion
  '600365': '1',
  '600366': '2',
  '600368': '3',
};

// Map 2-char route segment codes to display names
const LINE_NAMES = {
  AI: 'Airport',
  BD: 'Gold Coast',
  CA: 'Caboolture',
  CL: 'Cleveland',
  DB: 'Doomben',
  FG: 'Ferny Grove',
  GC: 'Gold Coast',
  GY: 'Gympie',
  IP: 'Ipswich',
  NA: 'Nambour',
  RP: 'Redcliffe',
  RW: 'Rosewood',
  SH: 'Shorncliffe',
  SM: 'Stradbroke',
  SP: 'Springfield',
  VL: 'Gold Coast',
};

// For Albion tab: decode origin (first 2 chars) — tells you which line is coming
// For Milton tab: decode destination (chars 2-4) — tells you where the train is going
function lineName(routeId, useDestination) {
  if (!routeId) return 'Train';
  const code = routeId.toUpperCase().split('-')[0];
  if (useDestination && code.length >= 4) {
    const dest = LINE_NAMES[code.slice(2, 4)];
    if (dest) return dest;
  }
  return LINE_NAMES[code.slice(0, 2)] || routeId;
}

// Cache with in-flight promise to prevent concurrent fetches
let cache = { data: null, timestamp: 0, inflight: null };
const CACHE_TTL_MS = 15000;

async function fetchGTFSRT() {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.data;
  }
  if (cache.inflight) {
    return cache.inflight;
  }
  cache.inflight = fetch(GTFS_RT_URL)
    .then(async response => {
      if (!response.ok) throw new Error(`TransLink API error: ${response.status}`);
      const buffer = await response.arrayBuffer();
      const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
      cache = { data: feed, timestamp: Date.now(), inflight: null };
      return feed;
    })
    .catch(err => {
      cache.inflight = null;
      throw err;
    });
  return cache.inflight;
}

function getDepartures(feed, mode) {
  const config = MODES[mode];
  if (!config) return [];

  const now = Date.now() / 1000;
  const results = [];
  const seenTripIds = new Set();

  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu || !tu.stopTimeUpdate?.length) continue;

    const tripId = tu.trip?.tripId;
    if (tripId && seenTripIds.has(tripId)) continue;

    // Direction filter (albion mode only)
    if (
      config.directionId !== undefined &&
      tu.trip?.directionId !== undefined &&
      tu.trip.directionId !== config.directionId
    ) continue;

    // Find the stop update for our target stop
    let targetUpdate = null;
    let targetStopId = null;
    let targetIdx = -1;
    for (let i = 0; i < tu.stopTimeUpdate.length; i++) {
      const stu = tu.stopTimeUpdate[i];
      // Use assignedStopId if present (real-time platform change), else stopId
      const effectiveStopId = stu.stopTimeProperties?.assignedStopId || stu.stopId;
      if (config.stopIds.includes(stu.stopId) || config.stopIds.includes(effectiveStopId)) {
        targetUpdate = stu;
        targetStopId = effectiveStopId;
        targetIdx = i;
        break;
      }
    }
    if (!targetUpdate) continue;

    // For roma-milton: confirm the trip also stops at Milton AFTER Roma St
    if (config.requiredStopIds) {
      const hasDownstream = tu.stopTimeUpdate
        .slice(targetIdx + 1)
        .some(s => config.requiredStopIds.includes(s.stopId));
      if (!hasDownstream) continue;
    }

    const dep = targetUpdate.departure || targetUpdate.arrival;
    if (!dep) continue;

    const depTimeSec = typeof dep.time === 'object' ? dep.time.toNumber() : Number(dep.time);
    if (isNaN(depTimeSec) || depTimeSec < now - 60) continue;

    const result = {
      line: lineName(tu.trip?.routeId || '', config.useDestination),
      minutes: Math.round((depTimeSec - now) / 60),
      departureTs: depTimeSec,
    };

    if (PLATFORM_NAMES[targetStopId]) {
      result.platform = PLATFORM_NAMES[targetStopId];
    }

    results.push(result);
    if (tripId) seenTripIds.add(tripId);
  }

  results.sort((a, b) => a.departureTs - b.departureTs);
  return results.slice(0, 5);
}

app.get('/api/departures', async (req, res) => {
  const mode = req.query.mode || 'albion';
  if (!MODES[mode]) {
    return res.status(400).json({ error: `Unknown mode: ${mode}` });
  }
  try {
    const feed = await fetchGTFSRT();
    const departures = getDepartures(feed, mode);
    res.json({ departures, fetchedAt: Date.now() });
  } catch (err) {
    console.error('Error fetching GTFS-RT:', err.message);
    res.status(502).json({ error: 'Could not fetch live data — check TransLink' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Albion Rush running at http://localhost:${PORT}`);
});
