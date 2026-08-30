# SLEFLAC — SLEF State Legislative Action Center

A national tracker for state-level, veteran-related legislation, built for
the [State Legislative Exchange Forum (SLEF)](https://www.slef-moaa.com).
Tracks bill status via the [LegiScan API](https://legiscan.com/legiscan) and
provides:

- An embeddable tracker widget for Squarespace showing live bill status,
  grouped by category, with a dynamic state selector and position badges
- A **nationwide advocacy campaign** card (e.g. "ask your legislator to
  introduce a resolution") that isn't tied to one state and appears
  regardless of which state pill is selected — see
  [Nationwide advocacy campaigns](#nationwide-advocacy-campaigns) below
- A "Take action" feature that looks up a user's state legislators by street
  address and ZIP code (via the [Open States API](https://open.pluralpolicy.com/))
  and generates a pre-filled, editable advocacy or opposition letter
- A "Suggest a bill" Google Form so any MOAA member can flag new bills for tracking

No API keys are ever exposed to the browser — LegiScan calls happen in
GitHub Actions, and Open States calls happen in a Cloudflare Worker.

> **Repository history:** this project's production repo is
> `slefmoaa/SLAC`. It was migrated from a personal account
> (`Resolute1950/SLEFLAC`), which is now archived and read-only. If you find
> old links pointing at `resolute1950.github.io/SLEFLAC`, update them to
> `slefmoaa.github.io/SLAC`.

---

## How it works

```
tracked-bills.json          bills.json               take-action.html
(curated source list)  -->  (live status cache)  -->  (public action page)
        |                         |
fetch-bill-status.mjs        worker.js
(GitHub Actions nightly)     (Cloudflare Worker)
```

### 1. Bill status tracking

- **`tracked-bills.json`** — the curated list of bills to track. Each entry
  has `state`, `bill_number`, `bill_url`, plus display metadata (`label`,
  `category`, `chapter`, `summary`, `priority`, `advocacy_url`, `position`,
  `position_notes`) and take-action fields (`chamber_target`,
  `email_subject`, `email_template`).

- **`scripts/fetch-bill-status.mjs`** — reads `tracked-bills.json`, queries
  LegiScan for each bill's current status (with automatic retry on transient
  network errors), stamps `final_date` when a bill first reaches a terminal
  status, prunes expired bills from both JSON files after 30 days, and
  writes `bills.json`. If the LegiScan call fails for a bill (or an entire
  state), the "View bill text" link doesn't disappear — the script falls
  back to the manually-curated `bill_url` from `tracked-bills.json`. Entries
  flagged `skip_legiscan: true` (used for non-bill advocacy campaigns — see
  [Nationwide advocacy campaigns](#nationwide-advocacy-campaigns)) bypass
  LegiScan entirely and pass straight through to `bills.json` with a static
  `"Ongoing"` status; they never reach a terminal status and are never
  auto-expired.

- **`.github/workflows/update-bill-status.yml`** — runs the script daily
  (12:00 UTC) and whenever `tracked-bills.json` changes, committing the
  updated `bills.json`.

- **`bills.json`** — auto-generated output served via GitHub Pages, fetched
  client-side by the Squarespace embed and the take-action page. Do not
  edit manually.

### 2. Tracker widget

- **`squarespace-embed.html`** — paste into a Squarespace Code Block.
  Fetches `bills.json` and renders:
  - A header bar with title and last-updated timestamp
  - An intro blurb explaining how the tracker works
  - A disclaimer (see below)
  - A **nationwide campaign card** — any entry with a `template_url` (and no
    fixed `state`) renders once, above the state selector, on every state's
    page. Shows pill badges (an automatic "PRIORITY" pill plus anything in
    `badges`), a title/description, a "Take action" button, and a "View
    Resolution Template" button linking to `template_url`. See
    [Nationwide advocacy campaigns](#nationwide-advocacy-campaigns).
  - A **state selector** (pills), built dynamically from the distinct
    `state` values in `bills.json` — new states appear automatically as
    bills are added, no embed changes needed. Defaults to the first state
    alphabetically on load.
  - Bills for the selected state, grouped by `category`, as full-width rows
    with a color-coded status rail, live status badge, position badge
    (▲ Supported / ▼ Opposed), last-action summary, and a "Take action" button
  - A **"Suggest a bill"** footer link to the Google Form

### 3. Take action (contact your legislator)

- **`take-action.html`** — standalone page (served via GitHub Pages) reached
  via `take-action.html?bill=<bill_number>&state=<state>`. Walks the user
  through:
  1. Enter street address and ZIP code
  2. Select their state legislator (filtered by the bill's `chamber_target`)
  3. Enter their name, city, and MOAA chapter/council — the chapter field
     is pre-filled from the bill's `chapter` when set, and left blank for
     nationwide campaigns (whose `chapter` is `""`) so the visitor enters
     their own
  4. Review/edit a pre-filled letter — framed as advocacy or opposition
     depending on the bill's `position` — then send via `mailto:` or copy

  The letter's `[STATE]` placeholder is filled from the visitor's own
  geocoded address (their actual state), not the tracked bill's `state`
  field — this matters for nationwide campaigns, which have no fixed state
  at all, and is more accurate for state-specific bills too. The page also
  skips its "this ZIP isn't in the bill's state" validation whenever the
  bill's `state` is blank.

- **`worker.js`** — Cloudflare Worker that the take-action page calls for
  the address → legislator lookup. It:
  1. Geocodes the street address via the US Census Bureau Geocoder (free,
     no key required) for parcel-level precision, retrying with a
     normalized (apartment/unit/suite stripped) version of the address if
     the first attempt doesn't match — some otherwise-valid addresses fail
     Census's strict matcher purely on formatting.
  2. If Census still can't match, falls back to a ZIP centroid via
     Zippopotam.us, and if Zippopotam *also* doesn't have that ZIP (it has
     known coverage gaps for some valid, standard US ZIPs), falls back
     again to Nominatim/OpenStreetMap before giving up entirely. The
     response's `location.geocoded_by` field (`census_address`,
     `zippopotam_zip`, or `nominatim_zip`) records which method matched, for
     debugging precision issues.
  3. Calls Open States `/people.geo` with the resulting lat/lng, using
     `OPENSTATES_API_KEY` (stored as a Worker secret — never sent to the browser)
  4. Filters out federal Congress members, returning only state legislators
  5. Returns a simplified legislator list (name, chamber, district, email
     if available, contact URL as fallback)

  See **`TAKE_ACTION_SETUP.md`** for full deployment steps. Note that
  `worker.js` is deployed manually via the Cloudflare dashboard (or
  `wrangler`) — committing it to this repo does **not** redeploy it; the
  copy here is kept for version history only.

### 4. Suggest a bill

The tracker footer includes a "Suggest a bill" link to the SLEF Google Form.
Any MOAA member can submit a bill — responses are emailed to
`Team@slef-moaa.com` for C-Chair review. To add an approved suggestion,
follow "Adding new bills" below.

---

## Disclaimer

The following disclaimer appears in both the tracker widget and the
take-action page:

> *This Legislative Action Center is a service provided by the State
> Legislative Exchange Forum (SLEF) to support member advocacy. Listing a
> bill does not constitute an endorsement of any particular legislative
> outcome. Positions shown reflect the views of the submitting MOAA chapter
> or council, not those of SLEF or MOAA.*

---

## Bill positions

Every bill in `tracked-bills.json` must have a `position` field:

- **`"support"`** — the tracker shows a green "▲ Supported" badge and the
  email template should be drafted as an advocacy letter urging the
  legislator to vote yes.
- **`"oppose"`** — the tracker shows a red "▼ Opposed" badge and the email
  template should be drafted as an opposition letter urging the legislator
  to vote no or seek amendments.

If `position_notes` is provided (e.g. `"Bill does not require VA
accreditation contrary to USC Title 38"`), it is stored in the data and
available for display on the action page so members understand the reasoning.

Write the `email_template` to match the position — the take-action page also
displays a one-line context banner ("You are writing in opposition to this
bill...") above the editable letter textarea.

---

## Bill expiry (automatic)

`fetch-bill-status.mjs` manages the full bill lifecycle automatically:

| Stage | What happens |
|---|---|
| Bill reaches `Passed`, `Vetoed`, or `Failed / Dead` | Script stamps `final_date` (today) in `tracked-bills.json`. Bill stays visible. |
| Days 1–29 after `final_date` | Bill continues to appear in `bills.json` and on the action page. |
| Day 30+ after `final_date` | Bill is removed from `bills.json` and pruned from `tracked-bills.json`. LegiScan fetches stop. |

To change the window, update `EXPIRY_DAYS` near the top of
`fetch-bill-status.mjs`.

---

## Setup

### 1. Add the LegiScan API key as a repo secret

Settings → Secrets and variables → Actions → New repository secret
- Name: `LEGISCAN_API_KEY`
- Value: your free LegiScan API key (https://legiscan.com/legiscan)

### 2. Enable GitHub Pages

Settings → Pages → Source: Deploy from a branch → `main` / `(root)`

### 3. Run the workflow once manually

Actions tab → "Update Bill Status" → Run workflow

### 4. Confirm `bills.json` is live

Visit `https://slefmoaa.github.io/SLAC/bills.json` — should
return JSON with current bill statuses.

### 5. Add the tracker to slef-moaa.com

In Squarespace: edit the `/slac` page → add a **Code Block** in a
full-width section → paste the contents of `squarespace-embed.html` → save.

If your GitHub username/org or repo name differs from `slefmoaa/SLAC`,
update `DATA_URL` near the top of the `<script>` in both
`squarespace-embed.html` and `take-action.html`, and `TAKE_ACTION_BASE` in
`squarespace-embed.html`.

### 6. Set up the Take Action feature

See **`TAKE_ACTION_SETUP.md`** for deploying the Cloudflare Worker, getting
an Open States API key, and wiring the Worker URL into `take-action.html`.

---

## Adding new bills

Edit `tracked-bills.json` and add a new entry to the `bills` array:

```json
{
  "state": "OH",
  "bill_number": "HB123",
  "bill_url": "https://<official state legislature link to the bill>",
  "label": "Short descriptive name",
  "category": "Category for grouping on the page",
  "chapter": "Which MOAA chapter/council is tracking this",
  "summary": "1-2 sentence plain-language summary",
  "priority": false,
  "advocacy_url": "https://link-to-take-action-page",
  "chamber_target": "lower",
  "position": "support",
  "position_notes": "Optional — why your chapter supports or opposes this bill.",
  "email_subject": "Support for HB 123 — Short Description",
  "email_template": "Dear [LEGISLATOR_NAME],\n\n...\n\nRespectfully,\n[FULL_NAME]\n[CITY], [STATE]\nMember, [CHAPTER]"
}
```

Field notes:

- `state` — 2-letter postal code (used for both LegiScan and Open States)
- `bill_number` — must match LegiScan's format (e.g. `HB123`, `SB45`, no space)
- `bill_url` — a stable, manually-set link to the official bill page
  (prefer the state legislature site; the LegiScan bill page also works).
  Used as the "View bill text" link whenever the LegiScan API fetch fails
  for that bill or state, so the link is never lost during an outage or
  rate limit. Update it if the URL ever changes.
- `category` — bills are grouped under this heading on the tracker; a new
  category creates a new section automatically, no embed changes needed
- `chamber_target` — `"lower"` (House/Assembly), `"upper"` (Senate), or
  `"both"`. Determines which legislators are shown on the take-action page
- `position` — required; must be `"support"` or `"oppose"`
- `position_notes` — optional; stored in the data and useful for opposition
  bills (e.g. cite the specific federal law conflict or amendment sought)
- `email_subject` / `email_template` — required for the take-action page to
  work. If omitted, "Take action" falls back to `advocacy_url` (or shows no
  button if that is also missing)
- `email_template` placeholders: `[LEGISLATOR_NAME]`, `[FULL_NAME]`,
  `[CITY]`, `[STATE]`, `[CHAPTER]` — `[STATE]` is filled from the visitor's
  own geocoded address, not this field, so it stays accurate even for
  nationwide campaigns (see below)
- `final_date` — do not set manually; stamped automatically by
  `fetch-bill-status.mjs` when the bill first reaches a terminal status
- `badges` — optional array of extra short pill labels (e.g. `["DISTRICT"]`)
  shown next to the automatic "PRIORITY" pill when `priority` is `true`
- `skip_legiscan` — optional; set `true` for advocacy asks that aren't a
  real, introduced bill (see below) so `fetch-bill-status.mjs` never
  queries LegiScan for this entry
- `template_url` — optional; a link to a model resolution/letter document.
  When set, `squarespace-embed.html` renders this entry as a **campaign
  card** with a "View Resolution Template" button, instead of a normal bill
  row

Commit the change — the workflow runs automatically on push to
`tracked-bills.json` and will populate status for the new bill within a
minute or two. Adding a bill from a new state automatically adds a new state
pill to the tracker widget — no embed changes needed.

---

## Nationwide advocacy campaigns

Some advocacy asks aren't tied to an already-introduced bill in any one
state — for example, asking every state's legislators to introduce a
resolution on a given topic. These are modeled as a `tracked-bills.json`
entry with three fields set differently than a normal bill:

- **`state: ""`** — blank, not a 2-letter code. `squarespace-embed.html`
  then shows this entry's card on every state's page (not filtered to one
  state), and `take-action.html` skips its "this ZIP isn't in the bill's
  state" check.
- **`chapter: ""`** — blank, since no single chapter owns a nationwide ask.
  The take-action page then asks the visitor for their own chapter instead
  of assuming one.
- **`skip_legiscan: true`** and **`template_url`** — see field notes above.

Example (the live "Richard Star Act - State Resolution" campaign):

```json
{
  "state": "",
  "bill_number": "STARACT-RES",
  "bill_url": "https://www.congress.gov/bill/119th-congress/house-bill/2102",
  "label": "Richard Star Act - State Resolution",
  "category": "Priority Campaign",
  "chapter": "",
  "summary": "Ask your state legislator to introduce a resolution supporting the Major Richard Star Act.",
  "priority": true,
  "badges": ["DISTRICT"],
  "skip_legiscan": true,
  "template_url": "https://www.staractalliance.org/media/vsefcjdy/major-richard-star-act-model-state-resolution-template.pdf",
  "chamber_target": "both",
  "position": "support",
  "position_notes": "This is a state resolution ask, not a bill — it would not change state law and requires no funding in any state.",
  "email_subject": "Request for Meeting — Major Richard Star Act State Resolution",
  "email_template": "Dear [LEGISLATOR_NAME],\n\n...\n\nRespectfully,\n[FULL_NAME]\n[CITY], [STATE]\nMember, [CHAPTER]"
}
```

Once a state's resolution is actually introduced as a real bill (as
happened for South Carolina's `H4575`), add it as a normal, state-specific
`tracked-bills.json` entry instead — real bill number, real `state`, no
`skip_legiscan` — so LegiScan can track its live status like any other bill.
A campaign and a state-specific bill on the same underlying topic can
coexist; nothing needs to be removed.

---

## Data schema reference

### `tracked-bills.json` fields

| Field | Type | Required | Description |
|---|---|---|---|
| `state` | string | ✓ | 2-letter postal code; `""` (blank) for a nationwide campaign — see [Nationwide advocacy campaigns](#nationwide-advocacy-campaigns) |
| `bill_number` | string | ✓ | LegiScan-format bill number |
| `bill_url` | string | ✓ | Stable manual link to the bill page; used as fallback "View bill text" link when LegiScan fetch fails |
| `label` | string | ✓ | Short display title |
| `category` | string | ✓ | Grouping heading on the tracker |
| `chapter` | string | ✓ | Submitting MOAA chapter or council; `""` (blank) for a nationwide campaign, prompting the visitor for their own on the take-action page |
| `summary` | string | ✓ | 1–2 sentence plain-language description |
| `priority` | boolean | ✓ | `true` highlights the bill in the tracker |
| `advocacy_url` | string | | Fallback Take Action URL |
| `chamber_target` | string | ✓ | `"lower"`, `"upper"`, or `"both"` |
| `position` | string | ✓ | `"support"` or `"oppose"` |
| `position_notes` | string | | Rationale for the position |
| `email_subject` | string | | Pre-filled email subject line |
| `email_template` | string | | Full letter text with placeholders |
| `final_date` | string | auto | `YYYY-MM-DD` — set automatically; do not edit |
| `badges` | array of strings | | Extra pill labels shown next to the automatic "PRIORITY" pill |
| `skip_legiscan` | boolean | | `true` to bypass LegiScan entirely (non-bill advocacy campaigns) |
| `template_url` | string | | Link to a model resolution/letter; renders this entry as a campaign card |

### `bills.json` additional fields (auto-generated)

| Field | Source |
|---|---|
| `title` | LegiScan full bill title |
| `status` | LegiScan numeric status code |
| `status_label` | `Introduced`, `Engrossed`, `Enrolled`, `Passed`, `Vetoed`, `Failed / Dead` — or `"Ongoing"` for `skip_legiscan` entries, which never reach a terminal status |
| `last_action_date` | Date of most recent legislative action |
| `last_action` | Text of most recent action |
| `committee` | Current committee name |
| `state_link` | Official state legislature URL |
| `legiscan_url` | LegiScan bill page URL |
| `updated` | ISO timestamp of last sync |

`badges` and `template_url` from `tracked-bills.json` are also carried
through unchanged onto the corresponding `bills.json` entry.

---

## LegiScan status codes

| Code | Label | Terminal? |
|---|---|---|
| 0 | Pending | |
| 1 | Introduced | |
| 2 | Engrossed | |
| 3 | Enrolled | |
| 4 | Passed | ✓ |
| 5 | Vetoed | ✓ |
| 6 | Failed / Dead | ✓ |

Terminal statuses trigger the 30-day expiry clock. The list is defined in
`FINAL_STATUSES` in `fetch-bill-status.mjs`.

---

## API usage notes

- **LegiScan** — free Public API allows 30,000 queries/month. Each state
  costs 2 queries (session lookup + master list) plus 1 per bill, run once
  daily. A handful of states and bills stays well under 1,000 queries/month.
- **Open States** — free tier handles per-user take-action lookups
  comfortably for a small-to-medium campaign. Street address lookups use the
  US Census Bureau Geocoder for parcel-level precision, retrying once with
  apartment/unit info stripped if the first attempt doesn't match. If Census
  still can't match, the Worker falls back to a ZIP centroid via
  Zippopotam.us, and if that ZIP isn't in Zippopotam's data either (it has
  known coverage gaps for some valid, standard US ZIPs), falls back again to
  Nominatim/OpenStreetMap before giving up. Any ZIP-centroid match is
  accurate for most addresses but can occasionally return a neighboring
  district for addresses near boundaries — check the lookup response's
  `location.geocoded_by` field if you need to tell which method was used.
- **Email coverage** — some state legislators don't have an email address on
  file in Open States. The take-action page falls back to the legislator's
  contact page URL in that case.

---

## Contact

Questions or bill submissions: **Team@slef-moaa.com**
