/**
 * SLEFLAC Legislator Lookup Worker
 * ================================
 * Proxies legislator lookups for the "Take Action" feature so the
 * Open States API key never reaches the browser.
 *
 * Flow:
 *   1. Browser calls this Worker with a ZIP code and optional street address:
 *        GET https://<your-worker>.workers.dev/?zip=48933
 *        GET https://<your-worker>.workers.dev/?zip=48933&street=123+Main+St
 *   2a. If street is provided: Worker geocodes via the US Census Bureau
 *       Geocoder (free, no key) for parcel-level precision — resolves
 *       addresses near district boundaries that ZIP centroids get wrong.
 *   2b. If no street: Worker geocodes the ZIP centroid via Zippopotam.us.
 *   3. Worker calls Open States /people.geo with the resulting lat/lng,
 *      using OPENSTATES_API_KEY (set as a Worker secret)
 *   4. Worker returns a simplified list of state legislators
 *
 * Bill Submission (Step 3 — position-aware):
 *   POST /suggest-bill  { ...fields, position: 'support'|'oppose', position_notes: '...' }
 *   Validates the payload, then forwards a formatted email to Team@slef-moaa.com
 *   via MailChannels (built into Cloudflare Workers — no extra API key required).
 *   Subject line flags opposition submissions so C-Chairs notice them immediately.
 *
 * Click Tracking:
 *   POST /track  { state: 'MI', bill_number: 'HB5262' }
 *   Increments a per-bill click counter stored in Cloudflare KV (binding: CLICKS).
 *   Called fire-and-forget from take-action.html when the user clicks "Send."
 *   KV key format: click:MI:HB5262
 *
 *   GET /counts
 *   Returns all click counts as JSON: { counts: { "MI:HB5262": 47, ... } }
 *   Useful for dashboards and admin reporting.
 *
 * Setup:
 *   - wrangler secret put OPENSTATES_API_KEY   (or set via dashboard)
 *   - wrangler kv namespace create CLICKS      (add the returned IDs to wrangler.toml)
 *   - Deploy: wrangler deploy
 *
 * wrangler.toml KV binding (add this stanza):
 *   [[kv_namespaces]]
 *   binding = "CLICKS"
 *   id = "<your-kv-namespace-id>"
 *   preview_id = "<your-preview-kv-namespace-id>"  # optional, for wrangler dev
 *
 * CORS: allows requests from any origin (adjust ALLOWED_ORIGIN if you
 * want to restrict to slef-moaa.com specifically).
 */

const ALLOWED_ORIGIN = '*'; // or 'https://www.slef-moaa.com'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SUBMISSION_TO   = 'Team@slef-moaa.com';
const SUBMISSION_FROM = 'noreply@slef-moaa.com'; // must be a domain you control / have verified with MailChannels

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// Legislator lookup helpers
// ---------------------------------------------------------------------------

// Returns true if this person is a STATE legislator (not federal Congress).
function isStateLegislator(person) {
  var jurisdictionId = (person.jurisdiction && person.jurisdiction.id) || '';
  var role = person.current_role || {};
  var roleJurisdiction = (role.jurisdiction && role.jurisdiction.id) || '';
  var combined = jurisdictionId + ' ' + roleJurisdiction;
  if (/country:us\/government/.test(combined)) return false;
  if (/country:us\/state:/.test(combined)) return true;
  return role.org_classification === 'upper' || role.org_classification === 'lower';
}

// Normalize a person from Open States into a simpler shape for the UI
function simplifyPerson(person) {
  var role = person.current_role || {};
  var email = null;
  var contactUrl = null;
  if (person.email) email = person.email;
  if (person.openstates_url) contactUrl = person.openstates_url;
  return {
    name: person.name || null,
    party: person.party || null,
    chamber: role.org_classification || null,
    district: role.district || null,
    title: role.title || null,
    email: email,
    contact_url: contactUrl,
    image: person.image || null,
  };
}

async function geocodeZip(zip) {
  var res = await fetch('https://api.zippopotam.us/us/' + encodeURIComponent(zip));
  if (!res.ok) throw new Error('ZIP not found: ' + zip);
  var data = await res.json();
  var place = (data.places && data.places[0]) || null;
  if (!place) throw new Error('No location data for ZIP: ' + zip);
  return {
    lat: parseFloat(place.latitude),
    lng: parseFloat(place.longitude),
    state: data['country abbreviation'] === 'US' ? place['state abbreviation'] : null,
    place_name: place['place name'] || null,
    geocoded_by: 'zippopotam_zip',
  };
}

// Full-name -> 2-letter abbreviation, used only to normalize Nominatim's
// state field (it returns full names, e.g. "Arizona", not "AZ").
var STATE_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC',
};

// Second-choice ZIP-centroid fallback, used only when BOTH the Census
// street match AND Zippopotam.us fail. Zippopotam's underlying dataset
// has known coverage gaps for some otherwise-valid, standard US ZIPs
// (see e.g. ZIP 86005 — a real, populated Flagstaff, AZ ZIP that
// Zippopotam does not have indexed). Nominatim/OpenStreetMap has much
// broader postal-code coverage and needs no API key, just a descriptive
// User-Agent per its usage policy.
async function geocodeZipViaNominatim(zip) {
  var url = 'https://nominatim.openstreetmap.org/search?postalcode=' +
    encodeURIComponent(zip) + '&country=us&format=jsonv2&addressdetails=1&limit=1';
  var res = await fetch(url, {
    headers: { 'User-Agent': 'SLEF-SLAC-LegislatorLookup/1.0 (team@slef-moaa.com)' },
  });
  if (!res.ok) throw new Error('Nominatim lookup failed for ZIP: ' + zip);
  var results = await res.json();
  var place = (results && results[0]) || null;
  if (!place) throw new Error('No location data from Nominatim for ZIP: ' + zip);
  var stateName = (place.address && place.address.state || '').toLowerCase();
  return {
    lat: parseFloat(place.lat),
    lng: parseFloat(place.lon),
    state: STATE_ABBR[stateName] || null,
    place_name: place.display_name || null,
    geocoded_by: 'nominatim_zip',
  };
}

// Tries Zippopotam first (fast, simple), and only falls back to Nominatim
// if Zippopotam itself fails — keeping the common case cheap while still
// covering the ZIPs Zippopotam is missing.
async function geocodeZipWithFallback(zip) {
  try {
    return await geocodeZip(zip);
  } catch (_) {
    return await geocodeZipViaNominatim(zip);
  }
}

// Strips apartment/unit/suite markers and collapses whitespace. The
// Census geocoder's address matcher can be thrown off by unit info or
// stray punctuation that doesn't affect which parcel/district the
// address falls in, so retrying without it recovers a real match in
// cases that would otherwise incorrectly fall through to a ZIP-only
// (and therefore less precise) lookup.
function normalizeStreet(street) {
  return street
    .replace(/[,#]?\s*(apt|apartment|unit|ste|suite|#)\.?\s*[\w-]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function tryCensusMatch(street, zip) {
  var params = new URLSearchParams({
    street: street,
    zip: zip,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
  var url = 'https://geocoding.geo.census.gov/geocoder/locations/address?' + params.toString();
  var res = await fetch(url);
  if (!res.ok) throw new Error('Census geocoder HTTP ' + res.status);
  var data = await res.json();
  var matches = (data.result && data.result.addressMatches) || [];
  return matches.length ? matches[0] : null;
}

// Geocode a full street address using the US Census Bureau Geocoder.
// Free, no API key required. Returns lat/lng and the matched state.
//
// Retries with a normalized (unit/apartment-stripped) version of the
// street before giving up on Census entirely, since a surprising share
// of "no match" results are caused by formatting Census's strict
// matcher rejects rather than the address genuinely not existing.
//
// If Census can't match in either form, falls back to a ZIP-centroid
// lookup (Zippopotam, then Nominatim) rather than failing outright.
async function geocodeAddress(street, zip) {
  var candidates = [street, normalizeStreet(street)];
  var tried = {};

  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    if (!candidate || tried[candidate]) continue;
    tried[candidate] = true;

    try {
      var match = await tryCensusMatch(candidate, zip);
      if (match) {
        var coords = match.coordinates;
        // Census returns state FIPS; derive abbreviation from the matched address components
        var stateAbbr = (match.addressComponents && match.addressComponents.state) || null;
        return {
          lat: coords.y,
          lng: coords.x,
          state: stateAbbr,
          place_name: match.matchedAddress || null,
          geocoded_by: 'census_address',
        };
      }
    } catch (_) {
      // Try the next candidate form; if none work, fall through below.
    }
  }

  return geocodeZipWithFallback(zip);
}

async function lookupLegislators(lat, lng, apiKey) {
  var url = 'https://v3.openstates.org/people.geo?lat=' + lat + '&lng=' + lng;
  var res = await fetch(url, { headers: { 'X-API-KEY': apiKey } });
  if (!res.ok) {
    var text = await res.text();
    throw new Error('Open States error ' + res.status + ': ' + text);
  }
  var data = await res.json();
  var results = data.results || [];
  return results.filter(isStateLegislator).map(simplifyPerson);
}

// ---------------------------------------------------------------------------
// Bill submission — validation
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = [
  'state', 'bill_number', 'label', 'category',
  'summary', 'position',
  'submitter_name', 'chapter', 'email',
];

const VALID_POSITIONS = ['support', 'oppose'];

function validateSubmission(body) {
  var errors = [];

  REQUIRED_FIELDS.forEach(function (field) {
    if (!body[field] || String(body[field]).trim() === '') {
      errors.push('Missing required field: ' + field);
    }
  });

  if (body.state && !/^[A-Za-z]{2}$/.test(body.state.trim())) {
    errors.push('state must be a 2-letter postal code');
  }

  if (body.position && !VALID_POSITIONS.includes(body.position)) {
    errors.push('position must be "support" or "oppose"');
  }

  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
    errors.push('email is not valid');
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Bill submission — email formatting
// ---------------------------------------------------------------------------

function buildEmailSubject(body) {
  var positionTag = body.position === 'oppose'
    ? '[OPPOSE] '
    : '[SUPPORT] ';
  return positionTag + 'Bill Suggestion: ' + body.state.toUpperCase() + ' ' + body.bill_number + ' — ' + body.label;
}

function buildEmailText(body) {
  var positionLine = body.position === 'oppose'
    ? 'POSITION:         OPPOSE'
    : 'POSITION:         SUPPORT';

  var notesLine = (body.position_notes && body.position_notes.trim())
    ? 'POSITION NOTES:   ' + body.position_notes.trim()
    : 'POSITION NOTES:   (none provided)';

  var priorityLine = body.priority === true || body.priority === 'true'
    ? 'PRIORITY:         Yes'
    : 'PRIORITY:         No';

  var chamberMap = { lower: 'House/Assembly (lower)', upper: 'Senate (upper)', both: 'Both' };
  var chamberLine = 'CHAMBER TARGET:   ' + (chamberMap[body.chamber_target] || body.chamber_target || '—');

  var lines = [
    'SLEF MOAA — Bill Suggestion Submission',
    '========================================',
    '',
    '--- Bill Information ---',
    'STATE:            ' + body.state.toUpperCase(),
    'BILL NUMBER:      ' + body.bill_number,
    'LABEL:            ' + body.label,
    'CATEGORY:         ' + body.category,
    '',
    'SUMMARY:',
    body.summary,
    '',
    'WHY IT MATTERS TO VETERANS:',
    (body.why_matters || '(not provided)'),
    '',
    '--- Position ---',
    positionLine,
    notesLine,
    '',
    '--- Legislative Details ---',
    priorityLine,
    chamberLine,
    'STATE BILL LINK:  ' + (body.state_link || '—'),
    '',
    '--- Submitter ---',
    'NAME:             ' + body.submitter_name,
    'CHAPTER/COUNCIL:  ' + body.chapter,
    'EMAIL:            ' + body.email,
    'PHONE:            ' + (body.phone || '—'),
    '',
    '========================================',
    'Submitted via SLEF MOAA Bill Suggestion Form',
  ];

  return lines.join('\n');
}

function buildEmailHtml(body) {
  var isOppose = body.position === 'oppose';
  var positionColor  = isOppose ? '#8b1a1a' : '#1a6b3c';
  var positionBg     = isOppose ? '#faeaea' : '#eaf5ef';
  var positionBorder = isOppose ? '#d98080' : '#7dbf99';
  var positionLabel  = isOppose ? '&#9660; OPPOSE' : '&#9650; SUPPORT';

  var notesHtml = (body.position_notes && body.position_notes.trim())
    ? '<p style="margin:8px 0 0;">' + escHtml(body.position_notes.trim()) + '</p>'
    : '<p style="margin:8px 0 0;color:#6e6e73;font-style:italic;">(none provided)</p>';

  var priorityHtml = (body.priority === true || body.priority === 'true')
    ? '<span style="background:#fff8e1;color:#7a5c00;border:1px solid #f0d060;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;">&#9733; Priority</span>'
    : '<span style="color:#6e6e73;font-size:13px;">Standard tracking</span>';

  var chamberMap = { lower: 'House / Assembly (lower)', upper: 'Senate (upper)', both: 'Both' };
  var chamberLabel = chamberMap[body.chamber_target] || body.chamber_target || '—';

  var stateLinkHtml = body.state_link
    ? '<a href="' + escHtml(body.state_link) + '" style="color:#1a2744;">' + escHtml(body.state_link) + '</a>'
    : '—';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- Header -->
  <tr><td style="background:#1a2744;border-radius:12px 12px 0 0;padding:28px 32px 24px;border-bottom:3px solid #c9a84c;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#e8d5a0;">SLEF — MOAA Legislative Action</p>
    <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;">Bill Suggestion Received</h1>
    <p style="margin:6px 0 0;font-size:13px;color:#b0bcd4;">Submitted for C-Chair review before tracker entry.</p>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#ffffff;padding:28px 32px;border-radius:0 0 12px 12px;box-shadow:0 2px 12px rgba(0,0,0,0.07);">

    <!-- Bill info -->
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:#1a2744;border-bottom:1.5px solid #c9a84c;padding-bottom:5px;">Bill information</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#6e6e73;width:160px;">State / Bill number</td>
        <td style="padding:6px 0;font-size:14px;font-weight:600;color:#1c1c1e;">${escHtml(body.state.toUpperCase())} ${escHtml(body.bill_number)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#6e6e73;">Label</td>
        <td style="padding:6px 0;font-size:14px;color:#1c1c1e;">${escHtml(body.label)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#6e6e73;">Category</td>
        <td style="padding:6px 0;font-size:14px;color:#1c1c1e;">${escHtml(body.category)}</td>
      </tr>
    </table>

    <p style="margin:0 0 6px;font-size:13px;color:#6e6e73;font-weight:600;">Summary</p>
    <p style="margin:0 0 16px;font-size:14px;color:#1c1c1e;line-height:1.6;">${escHtml(body.summary)}</p>

    <p style="margin:0 0 6px;font-size:13px;color:#6e6e73;font-weight:600;">Why it matters to veterans</p>
    <p style="margin:0 0 24px;font-size:14px;color:#1c1c1e;line-height:1.6;">${escHtml(body.why_matters || '(not provided)')}</p>

    <!-- Position -->
    <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:#1a2744;border-bottom:1.5px solid #c9a84c;padding-bottom:5px;">Position</p>
    <div style="background:${positionBg};border:1.5px solid ${positionBorder};border-radius:10px;padding:14px 18px;margin-bottom:20px;">
      <p style="margin:0;font-size:16px;font-weight:700;color:${positionColor};">${positionLabel}</p>
      ${notesHtml}
    </div>

    <!-- Legislative details -->
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:#1a2744;border-bottom:1.5px solid #c9a84c;padding-bottom:5px;">Legislative details</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#6e6e73;width:160px;">Priority</td>
        <td style="padding:6px 0;">${priorityHtml}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#6e6e73;">Chamber target</td>
        <td style="padding:6px 0;font-size:14px;color:#1c1c1e;">${escHtml(chamberLabel)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#6e6e73;">State bill link</td>
        <td style="padding:6px 0;font-size:14px;">${stateLinkHtml}</td>
      </tr>
    </table>

    <!-- Submitter -->
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:#1a2744;border-bottom:1.5px solid #c9a84c;padding-bottom:5px;">Submitter</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#6e6e73;width:160px;">Name</td>
        <td style="padding:6px 0;font-size:14px;color:#1c1c1e;">${escHtml(body.submitter_name)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#6e6e73;">Chapter / Council</td>
        <td style="padding:6px 0;font-size:14px;color:#1c1c1e;">${escHtml(body.chapter)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#6e6e73;">Email</td>
        <td style="padding:6px 0;font-size:14px;"><a href="mailto:${escHtml(body.email)}" style="color:#1a2744;">${escHtml(body.email)}</a></td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#6e6e73;">Phone</td>
        <td style="padding:6px 0;font-size:14px;color:#1c1c1e;">${escHtml(body.phone || '—')}</td>
      </tr>
    </table>

  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:20px 0 0;text-align:center;">
    <p style="margin:0;font-size:12px;color:#6e6e73;">Submitted via SLEF MOAA Bill Suggestion Form</p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Bill submission — send via MailChannels
// ---------------------------------------------------------------------------

async function sendSubmissionEmail(body) {
  var subject = buildEmailSubject(body);

  var payload = {
    personalizations: [{
      to: [{ email: SUBMISSION_TO, name: 'SLEF C-Chairs' }],
      reply_to: { email: body.email, name: body.submitter_name },
    }],
    from: { email: SUBMISSION_FROM, name: 'SLEF MOAA Bill Tracker' },
    subject: subject,
    content: [
      { type: 'text/plain', value: buildEmailText(body) },
      { type: 'text/html',  value: buildEmailHtml(body) },
    ],
  };

  var res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok && res.status !== 202) {
    var text = await res.text().catch(function () { return ''; });
    throw new Error('MailChannels error ' + res.status + ': ' + text);
  }
}

// ---------------------------------------------------------------------------
// Click tracking — KV helpers
// ---------------------------------------------------------------------------

// Builds the KV key for a bill, e.g. "click:MI:HB5262", or
// "click:US:STARACT-RES" for a nationwide campaign (blank state).
function clickKey(state, billNumber) {
  return 'click:' + state.toUpperCase() + ':' + billNumber.replace(/\s+/g, '').toUpperCase();
}

// Atomically increment a click counter in KV.
// KV doesn't have native atomic increment, so we read-then-write.
// Race conditions are acceptable here — off-by-one on a counter is fine.
async function incrementClick(kv, state, billNumber) {
  var key = clickKey(state, billNumber);
  var current = parseInt((await kv.get(key)) || '0', 10);
  var next = current + 1;
  await kv.put(key, String(next));
  return next;
}

// Return all click counts as a plain object: { "MI:HB5262": 47, ... }
async function getAllCounts(kv) {
  var list = await kv.list({ prefix: 'click:' });
  var counts = {};
  // fetch all values in parallel
  var entries = await Promise.all(
    list.keys.map(async function (item) {
      var val = await kv.get(item.name);
      return { key: item.name.replace(/^click:/, ''), count: parseInt(val || '0', 10) };
    })
  );
  entries.forEach(function (e) { counts[e.key] = e.count; });
  return counts;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    var url = new URL(request.url);

    // ------------------------------------------------------------------
    // POST /suggest-bill — bill submission from the standalone form
    // ------------------------------------------------------------------
    if (request.method === 'POST' && url.pathname === '/suggest-bill') {
      var body;
      try {
        body = await request.json();
      } catch (_) {
        return jsonResponse({ error: 'Request body must be valid JSON' }, 400);
      }

      var errors = validateSubmission(body);
      if (errors.length > 0) {
        return jsonResponse({ error: 'Validation failed', details: errors }, 400);
      }

      try {
        await sendSubmissionEmail(body);
        return jsonResponse({ ok: true, message: 'Submission received — thank you.' });
      } catch (err) {
        return jsonResponse({ error: err.message || 'Failed to send submission email' }, 502);
      }
    }

    // ------------------------------------------------------------------
    // POST /track — increment click count for a bill
    // Body: { state: 'MI', bill_number: 'HB5262' }
    // state may be '' for a nationwide campaign (stored under "US").
    // Called fire-and-forget from take-action.html on send button click.
    // ------------------------------------------------------------------
    if (request.method === 'POST' && url.pathname === '/track') {
      if (!env.CLICKS) {
        // KV not configured — fail silently so the UI is never affected
        return jsonResponse({ ok: false, error: 'KV binding CLICKS not configured' }, 500);
      }

      var body;
      try {
        body = await request.json();
      } catch (_) {
        return jsonResponse({ error: 'Request body must be valid JSON' }, 400);
      }

      var state      = (body.state || '').trim().toUpperCase();
      var billNumber = (body.bill_number || '').trim();

      // A blank state is valid — it represents a nationwide advocacy
      // campaign (see tracked-bills.json's skip_legiscan/template_url
      // entries), which by design isn't tied to one state. Anything
      // non-blank must still be a real 2-letter postal code.
      if (state && !/^[A-Z]{2}$/.test(state)) {
        return jsonResponse({ error: 'state must be blank (nationwide campaign) or a 2-letter postal code' }, 400);
      }
      if (!billNumber) {
        return jsonResponse({ error: 'bill_number is required' }, 400);
      }

      // Nationwide campaigns are stored under a "US" placeholder key
      // instead of an empty string, since KV/metrics keys read more
      // sensibly as "US:STARACT-RES" than ":STARACT-RES".
      var keyState = state || 'US';

      try {
        var newCount = await incrementClick(env.CLICKS, keyState, billNumber);
        return jsonResponse({ ok: true, count: newCount });
      } catch (err) {
        return jsonResponse({ error: err.message || 'Failed to record click' }, 502);
      }
    }

    // ------------------------------------------------------------------
    // GET /counts — return all per-bill click counts
    // Response: { counts: { "MI:HB5262": 47, "PA:SB1209": 12 }, total: 59 }
    // ------------------------------------------------------------------
    if (request.method === 'GET' && url.pathname === '/counts') {
      if (!env.CLICKS) {
        return jsonResponse({ error: 'KV binding CLICKS not configured' }, 500);
      }

      try {
        var counts = await getAllCounts(env.CLICKS);
        var total  = Object.values(counts).reduce(function (sum, n) { return sum + n; }, 0);
        return jsonResponse({ counts: counts, total: total });
      } catch (err) {
        return jsonResponse({ error: err.message || 'Failed to retrieve counts' }, 502);
      }
    }

    // ------------------------------------------------------------------
    // GET /?zip=XXXXX[&street=123+Main+St] — legislator lookup
    // street is optional; when provided the Census Bureau Geocoder is used
    // for parcel-level precision instead of the ZIP centroid.
    // ------------------------------------------------------------------
    var zip    = url.searchParams.get('zip');
    var street = (url.searchParams.get('street') || '').trim();

    if (!zip || !/^\d{5}$/.test(zip)) {
      return jsonResponse({ error: 'Provide a valid 5-digit ZIP code via ?zip=' }, 400);
    }

    if (!env.OPENSTATES_API_KEY) {
      return jsonResponse({ error: 'Server misconfiguration: missing API key' }, 500);
    }

    try {
      var geo = street
        ? await geocodeAddress(street, zip)
        : await geocodeZipWithFallback(zip);

      var legislators = await lookupLegislators(geo.lat, geo.lng, env.OPENSTATES_API_KEY);

      return jsonResponse({
        zip: zip,
        street: street || null,
        location: {
          place_name: geo.place_name,
          state: geo.state,
          geocoded_by: geo.geocoded_by || 'zip_centroid',
        },
        legislators: legislators,
      });
    } catch (err) {
      return jsonResponse({ error: err.message || 'Lookup failed' }, 502);
    }
  },
};
