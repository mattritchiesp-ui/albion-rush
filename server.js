const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { transit_realtime } = require('gtfs-realtime-bindings');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const GTFS_RT_URL = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates';

const ALBION_STOP_IDS = ['600365', '600366', '600368'];

// Map first 2 chars of route code to a display line name
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

function lineName(routeId) {
  if (!routeId) return 'Train';
  const code = routeId.toUpperCase().split('-')[0];
  return LINE_NAMES[code.slice(0, 2)] || routeId;
}

// Simple in-memory cache
let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 15000;

async function fetchGTFSRT() {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.data;
  }
  const response = await fetch(GTFS_RT_URL);
  if (!response.ok) throw new Error(`TransLink API error: ${response.status}`);
  const buffer = await response.arrayBuffer();
  const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
  cache = { data: feed, timestamp: now };
  return feed;
}

function getDepartures(feed) {
  const now = Date.now() / 1000;
  const results = [];
  const seenTripIds = new Set();

  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu || !tu.stopTimeUpdate || !tu.stopTimeUpdate.length) continue;

    const tripId = tu.trip && tu.trip.tripId;
    if (seenTripIds.has(tripId)) continue;

    // Inbound only (direction_id 0 = toward city)
    if (
      tu.trip &&
      tu.trip.directionId !== undefined &&
      tu.trip.directionId !== 0
    ) continue;

    // Find a stop update matching Albion stop IDs
    let targetUpdate = null;
    for (const stu of tu.stopTimeUpdate) {
      if (ALBION_STOP_IDS.includes(stu.stopId)) {
        targetUpdate = stu;
        break;
      }
    }
    if (!targetUpdate) continue;

    const dep = targetUpdate.departure || targetUpdate.arrival;
    if (!dep) continue;

    const depTimeSec = typeof dep.time === 'object' ? dep.time.toNumber() : Number(dep.time);
    if (isNaN(depTimeSec) || depTimeSec < now - 60) continue;

    const minutesAway = Math.round((depTimeSec - now) / 60);
    const rawRouteId = (tu.trip && tu.trip.routeId) || '';

    results.push({
      line: lineName(rawRouteId),
      minutes: minutesAway,
      departureTs: depTimeSec,
    });

    seenTripIds.add(tripId);
  }

  results.sort((a, b) => a.departureTs - b.departureTs);
  return results.slice(0, 5);
}

app.get('/api/departures', async (req, res) => {
  try {
    const feed = await fetchGTFSRT();
    const departures = getDepartures(feed);
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
