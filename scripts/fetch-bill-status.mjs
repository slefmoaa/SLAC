// scripts/fetch-bill-status.mjs
//
// Reads tracked-bills.json (curated list of {state, bill_number, ...}),
// fetches current status for each from the LegiScan API, and writes
// bills.json with merged status + the original metadata (label,
// category, chapter, summary, priority, advocacy_url).
//
// Requires env var LEGISCAN_API_KEY (set as a GitHub Actions secret).
//
// LegiScan API docs: https://legiscan.com/gaits/documentation/legiscan

import fs from "fs/promises";

const API_KEY = process.env.LEGISCAN_API_KEY;

if (!API_KEY) {
  console.error("Missing LEGISCAN_API_KEY environment variable.");
  process.exit(1);
}

const BASE_URL = "https://api.legiscan.com/";
const TRACKED_BILLS_FILE = "tracked-bills.json";
const OUTPUT_FILE = "bills.json";

async function legiscanGet(op, params, retries = 3) {
  const url = new URL(BASE_URL);
  url.searchParams.set("key", API_KEY);
  url.searchParams.set("op", op);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        throw new Error(`LegiScan API error for op=${op}: ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      if (data.status !== "OK") {
        throw new Error(`LegiScan API returned non-OK status for op=${op}: ${JSON.stringify(data)}`);
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = attempt * 2000; // 2s, 4s, ...
        console.warn(`  Attempt ${attempt}/${retries} failed for op=${op} (${err.message}). Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// Build a map of normalized bill_number -> bill_id for a given state's
// current session, via getSessionList + getMasterListRaw. Also returns
// whether that session has formally adjourned (sine_die), which LegiScan
// reports as a first-class field on the session object — this is what
// lets us catch bills that die by inaction (no floor vote before
// adjournment) even though LegiScan may not have re-coded their numeric
// `status` to 6 ("Failed / Dead") yet. See "Bill status vs. session
// adjournment" note below simplifyBill().
async function buildBillIdMap(state) {
  const sessionData = await legiscanGet("getSessionList", { state });
  const sessions = sessionData.sessions || [];
  const currentYear = new Date().getFullYear();

  let session =
    sessions.find((s) => s.session_tag === "Regular Session" && !s.special && s.year_end >= currentYear) ||
    sessions.find((s) => s.year_end >= currentYear) ||
    sessions[sessions.length - 1];

  if (!session) {
    throw new Error(`No session found for state ${state}`);
  }

  console.log(
    `  [${state}] Using session: ${session.session_name} (id ${session.session_id}, sine_die=${session.sine_die})`
  );

  const masterData = await legiscanGet("getMasterListRaw", { id: session.session_id });
  const masterList = masterData.masterlist || {};

  const map = {};
  for (const key of Object.keys(masterList)) {
    if (key === "session") continue;
    const entry = masterList[key];
    if (!entry || !entry.number) continue;
    const normalized = entry.number.replace(/\s+/g, "").toUpperCase();
    map[normalized] = entry.bill_id;
  }

  return { map, sineDie: !!session.sine_die, sessionName: session.session_name };
}

async function fetchBillDetail(billId) {
  const data = await legiscanGet("getBill", { id: billId });
  return data.bill;
}

// LegiScan progress/status codes -> human-readable labels
const STATUS_LABELS = {
  0: "Pending",
  1: "Introduced",
  2: "Engrossed",
  3: "Enrolled",
  4: "Passed",
  5: "Vetoed",
  6: "Failed / Dead",
};

// Status codes that represent a bill still actively moving (i.e. not yet
// passed, vetoed, enrolled, or already marked dead). If the legislature's
// session has adjourned sine die while a bill is stuck in one of these
// states, the bill cannot proceed until it is reintroduced next session —
// it is functionally dead even though LegiScan hasn't recoded `status` to
// 6 yet. (3 "Enrolled" is deliberately excluded: an enrolled bill has
// already passed both chambers and is only awaiting gubernatorial action,
// which can still happen after sine die, so it is not dead.)
const NON_TERMINAL_IN_PROGRESS = new Set([0, 1, 2]);

// Status labels considered terminal — bill will be removed from bills.json
// 30 days after first reaching one of these states.
const FINAL_STATUSES = new Set(["Passed", "Vetoed", "Failed / Dead"]);
const EXPIRY_DAYS = 30;

function simplifyBill(bill, meta, sessionInfo) {
  const history = bill.history || [];
  const lastAction = history.length ? history[history.length - 1] : null;
  let statusLabel = STATUS_LABELS[bill.status] || "Unknown";
  let statusNote = null;

  // Bill status vs. session adjournment
  // --------------------------------------
  // LegiScan's numeric `status` code only changes when LegiScan's editors
  // (or the state's own data feed) explicitly recode a bill. Bills that
  // die quietly by inaction — never getting a committee hearing or floor
  // vote before the legislature adjourns sine die — often keep a stale
  // "Introduced"/"Engrossed" status code for a long time after they are,
  // in practice, dead for the biennium. `getSessionList` exposes a
  // `sine_die` flag on the session itself, so we use that (rather than
  // trying to scrape/parse LegiScan's free-text status descriptions,
  // which aren't part of the structured API response) to catch this case
  // and correct the label ourselves.
  if (sessionInfo?.sineDie && NON_TERMINAL_IN_PROGRESS.has(bill.status)) {
    statusNote = `Session adjourned sine die with bill still at "${statusLabel}" — treated as dead; must be reintroduced next session.`;
    console.log(`  [${meta.state}] ${bill.bill_number} — ${statusNote}`);
    statusLabel = "Failed / Dead";
  }

  // Stamp final_date the first time a bill reaches a terminal status.
  // Once set, never overwrite it — the 30-day expiry clock starts here.
  let finalDate = meta.final_date || null;
  if (FINAL_STATUSES.has(statusLabel) && !finalDate) {
    finalDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    console.log(`  [${meta.state}] ${bill.bill_number} reached final status "${statusLabel}" — stamping final_date ${finalDate}`);
  }

  return {
    state: meta.state,
    bill_number: bill.bill_number,
    label: meta.label || null,
    category: meta.category || null,
    chapter: meta.chapter || null,
    summary: meta.summary || bill.description || null,
    priority: !!meta.priority,
    advocacy_url: meta.advocacy_url || null,
    chamber_target: meta.chamber_target || 'both',
    position: meta.position || 'support',
    position_notes: meta.position_notes || '',
    email_subject: meta.email_subject || null,
    email_template: meta.email_template || null,
    title: bill.title,
    status: bill.status,
    status_label: statusLabel,
    status_note: statusNote,
    last_action_date: lastAction ? lastAction.date : null,
    last_action: lastAction ? lastAction.action : null,
    committee: bill.committee ? bill.committee.name : null,
    // Prefer the live LegiScan/state link, but fall back to the curated
    // bill_url from tracked-bills.json if the API ever returns one blank.
    state_link: bill.state_link || meta.bill_url || null,
    legiscan_url: bill.url || meta.bill_url || null,
    final_date: finalDate,
    updated: new Date().toISOString(),
  };
}

function errorEntry(state, entry, statusLabel, errorMsg) {
  return {
    state,
    bill_number: entry.bill_number,
    label: entry.label || null,
    category: entry.category || null,
    chapter: entry.chapter || null,
    summary: entry.summary || null,
    priority: !!entry.priority,
    advocacy_url: entry.advocacy_url || null,
    chamber_target: entry.chamber_target || 'both',
    email_subject: entry.email_subject || null,
    email_template: entry.email_template || null,
    status_label: statusLabel,
    status_note: null,
    // Hardwired fallback link — even when the LegiScan API call fails
    // (rate limit, outage, session lookup error), users can still read
    // the bill text via the manually-curated bill_url.
    state_link: entry.bill_url || null,
    legiscan_url: entry.bill_url || null,
    error: errorMsg,
    updated: new Date().toISOString(),
  };
}

async function main() {
  const trackedRaw = await fs.readFile(TRACKED_BILLS_FILE, "utf-8");
  const tracked = JSON.parse(trackedRaw);
  const trackedBills = tracked.bills || [];

  // Group tracked bills by state so we only build the bill-id map once per state
  const byState = {};
  for (const entry of trackedBills) {
    const state = (entry.state || "").toUpperCase();
    if (!byState[state]) byState[state] = [];
    byState[state].push(entry);
  }

  const results = [];

  for (const [state, entries] of Object.entries(byState)) {
    console.log(`Processing state: ${state} (${entries.length} bill(s))`);
    let billIdMap = {};
    let sessionInfo = null;
    try {
      const built = await buildBillIdMap(state);
      billIdMap = built.map;
      sessionInfo = { sineDie: built.sineDie, sessionName: built.sessionName };
    } catch (err) {
      console.error(`  [${state}] Failed to build bill ID map: ${err.message}`);
      for (const entry of entries) {
        results.push(errorEntry(state, entry, "Error", err.message));
      }
      continue;
    }

    for (const entry of entries) {
      const normalized = entry.bill_number.replace(/\s+/g, "").toUpperCase();
      const billId = billIdMap[normalized];
      if (!billId) {
        console.warn(`  [${state}] Could not resolve bill_id for ${entry.bill_number}`);
        results.push(errorEntry(state, entry, "Not found", null));
        continue;
      }

      try {
        console.log(`  [${state}] Fetching detail for ${entry.bill_number} (id ${billId})...`);
        const bill = await fetchBillDetail(billId);
        results.push(simplifyBill(bill, entry, sessionInfo));
        await new Promise((r) => setTimeout(r, 400)); // be polite to the API
      } catch (err) {
        console.error(`  [${state}] Error fetching ${entry.bill_number}: ${err.message}`);
        results.push(errorEntry(state, entry, "Error", err.message));
      }
    }
  }

  // Remove bills that reached a final status more than EXPIRY_DAYS ago.
  const now = Date.now();
  const activeBills = results.filter((b) => {
    if (!b.final_date) return true; // not final yet — keep
    const finalMs = new Date(b.final_date).getTime();
    const ageDays = (now - finalMs) / (1000 * 60 * 60 * 24);
    if (ageDays > EXPIRY_DAYS) {
      console.log(`  Removing ${b.state} ${b.bill_number} — final_date ${b.final_date} is ${Math.floor(ageDays)} days ago (>${EXPIRY_DAYS}-day limit)`);
      return false;
    }
    return true;
  });

  const removed = results.length - activeBills.length;
  if (removed > 0) {
    console.log(`Removed ${removed} expired bill(s) from output.`);
  }

  // Build a set of bill keys still active so we can prune tracked-bills.json
  // to match. A bill is pruned when it has been removed from activeBills —
  // i.e. its final_date is older than EXPIRY_DAYS. This stops the script
  // fetching it from LegiScan on future runs.
  const activeKeys = new Set(
    activeBills.map((b) => `${b.state.toUpperCase()}:${b.bill_number.replace(/\s+/g, "").toUpperCase()}`)
  );

  const remainingTracked = trackedBills.filter((b) => {
    const key = `${(b.state || "").toUpperCase()}:${(b.bill_number || "").replace(/\s+/g, "").toUpperCase()}`;
    if (!activeKeys.has(key)) {
      console.log(`  Pruning ${b.state} ${b.bill_number} from ${TRACKED_BILLS_FILE}`);
      return false;
    }
    return true;
  });

  // Also carry final_date back into tracked-bills.json so the expiry clock
  // survives across runs even before the bill is pruned.
  const finalDateMap = {};
  for (const b of results) {
    if (b.final_date) {
      const key = `${b.state.toUpperCase()}:${b.bill_number.replace(/\s+/g, "").toUpperCase()}`;
      finalDateMap[key] = b.final_date;
    }
  }
  for (const b of remainingTracked) {
    const key = `${(b.state || "").toUpperCase()}:${(b.bill_number || "").replace(/\s+/g, "").toUpperCase()}`;
    if (finalDateMap[key] && !b.final_date) {
      b.final_date = finalDateMap[key];
    }
  }

  const trackedPruned = remainingTracked.length < trackedBills.length;
  if (trackedPruned) {
    const updatedTracked = { ...tracked, bills: remainingTracked };
    await fs.writeFile(TRACKED_BILLS_FILE, JSON.stringify(updatedTracked, null, 2));
    console.log(`Updated ${TRACKED_BILLS_FILE}: ${remainingTracked.length} bill(s) remaining (${trackedBills.length - remainingTracked.length} pruned)`);
  } else if (Object.keys(finalDateMap).length > 0) {
    // No pruning, but final_dates may have been stamped — write back to preserve them
    const updatedTracked = { ...tracked, bills: remainingTracked };
    await fs.writeFile(TRACKED_BILLS_FILE, JSON.stringify(updatedTracked, null, 2));
    console.log(`Updated ${TRACKED_BILLS_FILE}: final_date stamped on newly finalised bill(s)`);
  }

  const output = {
    generated: new Date().toISOString(),
    bills: activeBills,
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT_FILE} with ${activeBills.length} bill(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
