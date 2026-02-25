/**
 * Albion Rush — Train Departure Server
 *
 * Express server that fetches live GTFS-RT data from TransLink and exposes
 * a single API endpoint for train departures. Supports two modes:
 *
 *   albion      — Next inbound trains at Albion station (toward Roma Street)
 *   roma-milton — Next trains from Roma Street that stop at Milton
 *
 * GTFS-RT (General Transit Feed Specification — Realtime) is a binary protobuf
 * feed. TransLink publishes one for the SEQ (South East Queensland) network.
 *
 * API: GET /api/departures?mode=albion|roma-milton
 */

const express = require('express');
const fetch = require('node-fetch');
const { transit_realtime } = require('gtfs-realtime-bindings');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const GTFS_RT_URL = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates';

/**
 * Mode configuration.
 *
 * stopIds        — TransLink stop IDs to match against in the GTFS-RT feed.
 *                  Each physical platform has its own stop ID.
 * directionId    — GTFS direction_id filter. 0 = inbound (toward city) for Albion.
 *                  Omit to skip direction filtering.
 * requiredStopIds — If set, only include trips that also call at one of these
 *                  stops AFTER the target stop. Used to confirm Roma St trains
 *                  will actually reach Milton.
 * useDestination — If true, decode line name from the route ID destination
 *                  (chars 2–4) rather than origin (chars 0–2). At Roma Street
 *                  heading west, the destination is more useful to the user.
 */
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

/**
 * Maps TransLink stop IDs to platform numbers.
 * Sourced from stops.txt in the TransLink SEQ GTFS static dataset.
 * Roma Street has platforms 3–10; Albion has platforms 1–3.
 */
const PLATFORM_NAMES = {
  // Roma Street station
  '600028': '7',
  '600029': '8',
  '600030': '6',
  '600033': '3',
  '600034': '5',
  '600035': '10',
  '600036': '4',
  '600038': '9',
  // Albion station
  '600365': '1',
  '600366': '2',
  '600368': '3',
};

/**
 * Maps 2-character TransLink route segment codes to human-readable line names.
 *
 * TransLink route IDs follow the pattern ORIGDEST-version (e.g. RPSP-4484),
 * where ORIG and DEST are 2-character codes for the terminal stations/areas.
 * This map covers all SEQ rail lines.
 */
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

/**
 * Decodes a TransLink route ID into a display line name.
 *
 * @param {string} routeId       - Raw route ID from GTFS-RT (e.g. "RPSP-4484")
 * @param {boolean} useDestination - If true, decode from destination half of the
 *                                   route code (chars 2–4) rather than the origin.
 * @returns {string} Human-readable line name (e.g. "Springfield")
 */
function lineName(routeId, useDestination) {
  if (!routeId) return 'Train';
  const code = routeId.toUpperCase().split('-')[0]; // strip version suffix
  if (useDestination && code.length >= 4) {
    const dest = LINE_NAMES[code.slice(2, 4)];
    if (dest) return dest;
  }
  return LINE_NAMES[code.slice(0, 2)] || routeId;
}

/**
 * In-memory GTFS-RT cache.
 *
 * `inflight` holds the pending fetch promise so that concurrent requests
 * arriving while the cache is stale share a single upstream fetch rather
 * than each triggering their own.
 */
let cache = { data: null, timestamp: 0, inflight: null };
const CACHE_TTL_MS = 15000; // 15 seconds

/**
 * Returns the decoded GTFS-RT feed, either from cache or by fetching fresh data.
 * Concurrent calls while a fetch is in progress share the same promise.
 *
 * @returns {Promise<Object>} Decoded FeedMessage protobuf object
 */
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

/**
 * Extracts upcoming departures from a GTFS-RT feed for the given mode.
 *
 * For each trip in the feed:
 *   1. Skips wrong direction (albion mode only)
 *   2. Finds a stop time update matching the target stop IDs
 *   3. For roma-milton, confirms the trip also calls at Milton downstream
 *   4. Extracts departure time and builds a result object
 *
 * Returns up to 5 departures sorted by departure time.
 *
 * @param {Object} feed - Decoded GTFS-RT FeedMessage
 * @param {string} mode - One of the keys in MODES
 * @returns {Array<{line, minutes, departureTs, platform?}>}
 */
function getDepartures(feed, mode) {
  const config = MODES[mode];
  if (!config) return [];

  const now = Date.now() / 1000; // UNIX seconds
  const results = [];
  const seenTripIds = new Set();

  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu || !tu.stopTimeUpdate?.length) continue;

    // Deduplicate by trip ID to avoid double-counting the same service
    const tripId = tu.trip?.tripId;
    if (tripId && seenTripIds.has(tripId)) continue;

    // Filter by direction_id where configured
    if (
      config.directionId !== undefined &&
      tu.trip?.directionId !== undefined &&
      tu.trip.directionId !== config.directionId
    ) continue;

    // Find the stop time update for our target stop.
    // Prefer assignedStopId from stopTimeProperties if present — TransLink
    // populates this field when a train is assigned to a different platform
    // than scheduled (e.g. due to a line disruption).
    let targetUpdate = null;
    let targetStopId = null;
    let targetIdx = -1;
    for (let i = 0; i < tu.stopTimeUpdate.length; i++) {
      const stu = tu.stopTimeUpdate[i];
      const effectiveStopId = stu.stopTimeProperties?.assignedStopId || stu.stopId;
      if (config.stopIds.includes(stu.stopId) || config.stopIds.includes(effectiveStopId)) {
        targetUpdate = stu;
        targetStopId = effectiveStopId;
        targetIdx = i;
        break;
      }
    }
    if (!targetUpdate) continue;

    // For roma-milton: only include trips that stop at Milton after Roma Street.
    // This filters out trains that call at Roma Street but terminate or branch
    // before reaching Milton.
    if (config.requiredStopIds) {
      const hasDownstream = tu.stopTimeUpdate
        .slice(targetIdx + 1)
        .some(s => config.requiredStopIds.includes(s.stopId));
      if (!hasDownstream) continue;
    }

    // Get departure time (fall back to arrival if no departure data)
    const dep = targetUpdate.departure || targetUpdate.arrival;
    if (!dep) continue;

    // dep.time is a protobuf Long for large values; convert to JS number
    const depTimeSec = typeof dep.time === 'object' ? dep.time.toNumber() : Number(dep.time);
    if (isNaN(depTimeSec) || depTimeSec < now - 60) continue; // skip past trains (1 min grace)

    const result = {
      line: lineName(tu.trip?.routeId || '', config.useDestination),
      minutes: Math.round((depTimeSec - now) / 60),
      departureTs: depTimeSec,
    };

    // Add platform if we have a mapping for this stop
    if (PLATFORM_NAMES[targetStopId]) {
      result.platform = PLATFORM_NAMES[targetStopId];
    }

    results.push(result);
    if (tripId) seenTripIds.add(tripId);
  }

  results.sort((a, b) => a.departureTs - b.departureTs);
  return results.slice(0, 5);
}

/**
 * GET /api/departures?mode=albion|roma-milton
 *
 * Returns the next 5 departures for the given mode.
 *
 * Response: { departures: Array, fetchedAt: number (ms timestamp) }
 * Error:    { error: string }
 */
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
