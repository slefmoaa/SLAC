/**
 * SLEFLAC Legislator Lookup Worker
 * ================================
 * Proxies legislator lookups for the "Take Action" feature so the
 * Open States API key never reaches the browser.
 *
 * Flow:
 *   1. Browser calls this Worker with a US ZIP code:
 *        GET https://<your-worker>.workers.dev/?zip=48933
 *   2. Worker geocodes the ZIP via Zippopotam.us (no key required)
 *   3. Worker calls Open States /people.geo with the resulting lat/lng,
 *      using OPENSTATES_API_KEY (set as a Worker secret)
 *   4. Worker returns a simplified list of state legislators
 *
 * Setup:
 *   - wrangler secret put OPENSTATES_API_KEY   (or set via dashboard)
 *   - Deploy: wrangler deploy
 *
 * CORS: allows requests from any origin (adjust ALLOWED_ORIGIN if you
 * want to restrict to self-moaa.com specifically).
 */

const ALLOWED_ORIGIN = '*'; // or 'https://www.slef-moaa.com'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

// Returns true if this person is a STATE legislator (not federal Congress).
// Open States /people.geo can return federal House/Senate members alongside
// state legislators; we filter those out here.
function isStateLegislator(person) {
  var jurisdictionId = (person.jurisdiction && person.jurisdiction.id) || '';
  var role = person.current_role || {};
  var roleJurisdiction = (role.jurisdiction && role.jurisdiction.id) || '';

  var combined = jurisdictionId + ' ' + roleJurisdiction;

  // Federal jurisdiction is 'ocd-jurisdiction/country:us/government'
  if (/country:us\/government/.test(combined)) return false;

  // State jurisdictions look like 'ocd-jurisdiction/country:us/state:mi/government'
  if (/country:us\/state:/.test(combined)) return true;

  // If jurisdiction info is missing/ambiguous, fall back to org_classification:
  // state legislatures use 'upper'/'lower'; US Congress people sometimes carry
  // the same values, so this is a last-resort heuristic only.
  return role.org_classification === 'upper' || role.org_classification === 'lower';
}

// Normalize a person from Open States into a simpler shape for the UI
function simplifyPerson(person) {
  var role = person.current_role || {};
  var email = null;
  var contactUrl = null;

  // Open States v3 sometimes exposes email directly on the person
  if (person.email) email = person.email;

  // links/openstates_url can serve as a fallback "contact" reference
  if (person.openstates_url) contactUrl = person.openstates_url;

  return {
    name: person.name || null,
    party: person.party || null,
    chamber: role.org_classification || null, // 'upper' (Senate) or 'lower' (House)
    district: role.district || null,
    title: role.title || null,
    email: email,
    contact_url: contactUrl,
    image: person.image || null,
  };
}

async function geocodeZip(zip) {
  var res = await fetch('https://api.zippopotam.us/us/' + encodeURIComponent(zip));
  if (!res.ok) {
    throw new Error('ZIP not found: ' + zip);
  }
  var data = await res.json();
  var place = (data.places && data.places[0]) || null;
  if (!place) throw new Error('No location data for ZIP: ' + zip);
  return {
    lat: parseFloat(place.latitude),
    lng: parseFloat(place.longitude),
    state: data['country abbreviation'] === 'US' ? place['state abbreviation'] : null,
    place_name: place['place name'] || null,
  };
}

async function lookupLegislators(lat, lng, apiKey) {
  var url = 'https://v3.openstates.org/people.geo?lat=' + lat + '&lng=' + lng;
  var res = await fetch(url, {
    headers: { 'X-API-KEY': apiKey },
  });
  if (!res.ok) {
    var text = await res.text();
    throw new Error('Open States error ' + res.status + ': ' + text);
  }
  var data = await res.json();
  var results = data.results || [];
  return results.filter(isStateLegislator).map(simplifyPerson);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    var url = new URL(request.url);
    var zip = url.searchParams.get('zip');

    if (!zip || !/^\d{5}$/.test(zip)) {
      return jsonResponse({ error: 'Provide a valid 5-digit ZIP code via ?zip=' }, 400);
    }

    if (!env.OPENSTATES_API_KEY) {
      return jsonResponse({ error: 'Server misconfiguration: missing API key' }, 500);
    }

    try {
      var geo = await geocodeZip(zip);
      var legislators = await lookupLegislators(geo.lat, geo.lng, env.OPENSTATES_API_KEY);

      return jsonResponse({
        zip: zip,
        location: { place_name: geo.place_name, state: geo.state },
        legislators: legislators,
      });
    } catch (err) {
      return jsonResponse({ error: err.message || 'Lookup failed' }, 502);
    }
  },
};
