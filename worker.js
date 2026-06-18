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
 * Setup:
 *   - wrangler secret put OPENSTATES_API_KEY   (or set via dashboard)
 *   - Deploy: wrangler deploy
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
// Legislator lookup helpers (unchanged)
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
  };
}

// Geocode a full street address using the US Census Bureau Geocoder.
// Free, no API key required. Returns lat/lng and the matched state.
// Falls back to ZIP centroid if the address cannot be matched.
async function geocodeAddress(street, zip) {
  var params = new URLSearchParams({
    street: street,
    zip: zip,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
  var url = 'https://geocoding.geo.census.gov/geocoder/locations/address?' + params.toString();

  try {
    var res = await fetch(url);
    if (!res.ok) throw new Error('Census geocoder HTTP ' + res.status);
    var data = await res.json();
    var matches = (data.result && data.result.addressMatches) || [];
    if (!matches.length) {
      // No match — fall back to ZIP centroid
      return geocodeZip(zip);
    }
    var match = matches[0];
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
  } catch (_) {
    // On any error fall back to ZIP centroid silently
    return geocodeZip(zip);
  }
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
    // GET /?zip=XXXXX[&street=123+Main+St] — legislator lookup
    // street is optional; when provided the Census Bureau Geocoder is used
    // for parcel-level precision instead of the ZIP centroid.
    // ------------------------------------------------------------------
    var zip = url.searchParams.get('zip');
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
        : await geocodeZip(zip);

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
