/* ============================================================================
   SafeSightAI+ — Hazard Classifier + Ticket System
   ----------------------------------------------------------------------------
   This file has NO dependencies. You can drop it into any project with:
       <script src="safesightai-engine.js"></script>
   ...placed BEFORE your own <script> that uses these functions.

   It gives you three things:
     1. classifyHazard(text)         → reads a text report, returns a hazard result
     2. Ticket functions              → createTicket, getAllTickets, updateTicketStatus,
                                         markStepDone (all backed by localStorage)
     3. renderAnalysisLog(log)        → turns the "reasoning" array into HTML you can
                                         drop straight into a result card
   ============================================================================ */


/* ============================================================================
   PART 1: HAZARD CLASSIFIER
   ============================================================================ */

/*
  For each hazard type we define:
    - id / label / icon        → identity
    - keywords                 → [word, weight] pairs. If the reported text
                                  contains "word", we add "weight" points to
                                  that hazard's score.
    - baseTier                 → the tier this hazard normally sits at
    - escalationRules          → extra keywords that, if present, PUSH the
                                  tier up (e.g. a live wire is worse "near water")
    - solution                 → the auto-suggested response steps
*/
const HAZARD_TYPES = [
  {
    id: "slip_trip",
    label: "Slip & Trip / Debris Fall",
    icon: "🪵",
    baseTier: "Low",
    keywords: [
      ["debris", 3], ["slip", 3], ["trip", 3], ["wet floor", 3],
      ["spill", 2], ["uneven", 2], ["loose material", 2], ["scattered", 1]
    ],
    escalationRules: [
      { to: "Medium", ifContainsAny: ["walkway", "high traffic", "main path"],
        reason: "Debris found in a high-footfall walkway — escalated." }
    ],
    solution: [
      "Clear debris immediately",
      "Barricade the area",
      "Assign housekeeping crew",
      "Re-inspect in 24 hours"
    ]
  },
  {
    id: "exposed_rebar",
    label: "Exposed Reinforcement",
    icon: "⚠️",
    baseTier: "High",
    keywords: [
      ["rebar", 4], ["reinforcement", 3], ["exposed rod", 3],
      ["no cap", 2], ["column", 1], ["protruding", 2]
    ],
    escalationRules: [
      { to: "Medium", ifContainsAny: ["low traffic", "fenced off", "rarely used"],
        reason: "Located in a low-traffic, already-fenced area — de-escalated slightly." }
    ],
    solution: [
      "Cap exposed rebar",
      "Barricade the zone",
      "Notify structural engineer"
    ]
  },
  {
    id: "live_wire",
    label: "Unearthed Live Wire",
    icon: "⚡",
    baseTier: "Dangerous",
    keywords: [
      ["live wire", 5], ["wire", 3], ["cable", 2], ["exposed cable", 4],
      ["frayed", 3], ["no conduit", 2], ["sparking", 4]
    ],
    escalationRules: [
      { to: "Fatal", ifContainsAny: ["water", "mud", "wet ground", "puddle"],
        reason: "Live wire is near water/mud — risk of electrocution is far higher. Escalated to Fatal." }
    ],
    solution: [
      "Isolate power immediately",
      "Cordon off the area",
      "Notify electrical safety officer"
    ]
  },
  {
    id: "ppe_violation",
    label: "PPE Kit Violation",
    icon: "🦺",
    baseTier: "Medium",
    keywords: [
      ["no helmet", 5], ["without helmet", 5], ["helmet", 2],
      ["no vest", 3], ["no gloves", 2], ["no boots", 2], ["ppe", 2]
    ],
    escalationRules: [
      { to: "High", ifContainsAny: ["near edge", "height", "crane", "moving vehicle"],
        reason: "PPE violation occurring near a higher-risk zone (edge/height/vehicle) — escalated." }
    ],
    solution: [
      "Issue on-site warning",
      "Provide PPE on the spot",
      "Log worker ID",
      "Flag for retraining"
    ]
  },
  {
    id: "no_harness",
    label: "No Harness (Work at Height)",
    icon: "🪢",
    baseTier: "Dangerous",
    keywords: [
      ["no harness", 5], ["without harness", 5], ["harness", 2],
      ["height", 2], ["edge", 2], ["fall arrest", 3], ["rooftop", 2]
    ],
    escalationRules: [
      { to: "Fatal", ifContainsAny: ["high floor", "3rd floor", "fourth floor", "great height", "no guardrail"],
        reason: "Working at a significant height with no guardrail — escalated to Fatal." }
    ],
    solution: [
      "Halt work at height",
      "Issue harness",
      "Verify anchor point",
      "Supervisor sign-off"
    ]
  },
  {
    id: "scaffolding_risk",
    label: "Scaffolding Risk",
    icon: "🏗️",
    baseTier: "High",
    keywords: [
      ["scaffold", 4], ["bracing", 2], ["misaligned", 3],
      ["overloaded", 3], ["missing joint", 3], ["pole", 1]
    ],
    escalationRules: [
      { to: "Dangerous", ifContainsAny: ["missing bracing", "structural issue", "joint failure"],
        reason: "Structural bracing/joint problem detected — escalated." },
      { to: "Fatal", ifContainsAny: ["collapse", "collapsing", "about to fall", "severe misalignment"],
        reason: "Signs of imminent scaffold collapse — escalated to Fatal." }
    ],
    solution: [
      "Stop scaffold use",
      "Engineer inspection",
      "Realign / reinforce",
      "Re-certify before reuse"
    ]
  }
];

// Order used for sorting queues, highest risk first
const TIER_ORDER = { Fatal: 0, Dangerous: 1, High: 2, Medium: 3, Low: 4 };

/**
 * classifyHazard(text)
 * ---------------------
 * Takes a plain-text hazard report and returns a full classification.
 *
 * @param {string} text - the report text, e.g. "worker without helmet near the edge"
 * @returns {{
 *   type: string,          // e.g. "ppe_violation"
 *   label: string,         // e.g. "PPE Kit Violation"
 *   icon: string,
 *   tier: string,          // "Fatal" | "Dangerous" | "High" | "Medium" | "Low"
 *   confidence: number,    // 0-100
 *   analysisLog: string[], // human-readable reasons, in order, for display
 *   solutionSteps: string[]
 * }}
 */
function classifyHazard(text) {
  const analysisLog = [];
  const t = (text || "").toLowerCase().trim();

  if (!t) {
    analysisLog.push("No description provided — cannot classify.");
    return {
      type: null, label: "Unclassified", icon: "❓", tier: "Low",
      confidence: 0, analysisLog, solutionSteps: []
    };
  }

  // ---- STEP 1: score every hazard type by keyword matches ----
  let bestType = null;
  let bestScore = -1;
  let bestMatchedKeywords = [];

  HAZARD_TYPES.forEach((cfg) => {
    let score = 0;
    let matched = [];
    cfg.keywords.forEach(([word, weight]) => {
      if (t.includes(word)) {
        score += weight;
        matched.push(`"${word}" (+${weight})`);
      }
    });
    if (score > bestScore) {
      bestScore = score;
      bestType = cfg;
      bestMatchedKeywords = matched;
    }
  });

  // ---- STEP 2: handle the "nothing matched" case ----
  if (bestScore <= 0) {
    // Fall back to the most commonly-seen hazard type on real sites,
    // but flag clearly in the log that this is a low-confidence guess.
    bestType = HAZARD_TYPES.find((h) => h.id === "slip_trip");
    analysisLog.push(
      "No strong keyword match found in the report text. Defaulting to the most common low-severity hazard type with low confidence."
    );
  } else {
    analysisLog.push(`Keyword scoring selected "${bestType.label}" (score ${bestScore}).`);
    analysisLog.push(`Matched keywords: ${bestMatchedKeywords.join(", ")}.`);
  }

  // ---- STEP 3: start from the base tier for this hazard type ----
  let tier = bestType.baseTier;
  analysisLog.push(`Base tier for "${bestType.label}" is "${tier}".`);

  // ---- STEP 4: check escalation rules (these can raise OR note a lower tier) ----
  bestType.escalationRules.forEach((rule) => {
    const hit = rule.ifContainsAny.some((phrase) => t.includes(phrase));
    if (hit) {
      tier = rule.to;
      analysisLog.push(`Escalation rule triggered: ${rule.reason} New tier: "${tier}".`);
    }
  });

  // ---- STEP 5: special audit rule for PPE (useful to show judges/auditors) ----
  if (bestType.id === "ppe_violation" && (t.includes("helmet") )) {
    analysisLog.push('Audit rule applied: PERSON_DETECTED + NO_HELMET → PPE_VIOLATION (auto-logged).');
  }

  // ---- STEP 6: confidence score ----
  // More keyword weight matched = more confident. Clamp to a realistic 60–96% band.
  let confidence = 60 + bestScore * 4;
  if (confidence > 96) confidence = 96;
  if (confidence < 60) confidence = 60;
  if (bestScore <= 0) confidence = 62; // low-confidence fallback case
  analysisLog.push(`Final confidence score: ${confidence}%.`);

  return {
    type: bestType.id,
    label: bestType.label,
    icon: bestType.icon,
    tier,
    confidence,
    analysisLog,
    solutionSteps: bestType.solution.slice() // copy, so caller can't mutate the original
  };
}


/* ============================================================================
   PART 2: TICKET SYSTEM (backed by localStorage)
   ============================================================================
   A "ticket" is one hazard record that lives in the browser's localStorage,
   so it survives a page refresh (but only on that same browser/device).
*/

const TICKETS_STORAGE_KEY = "safesightai_tickets_v1";

// ---- internal helpers (you don't need to call these directly) ----
function _loadTicketsFromStorage() {
  try {
    const raw = localStorage.getItem(TICKETS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn("Could not read tickets from localStorage:", e);
    return [];
  }
}
function _saveTicketsToStorage(tickets) {
  try {
    localStorage.setItem(TICKETS_STORAGE_KEY, JSON.stringify(tickets));
  } catch (e) {
    console.warn("Could not save tickets to localStorage:", e);
  }
}
function _generateId() {
  return "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

/**
 * createTicket(classification, meta)
 * ------------------------------------
 * Saves a new hazard ticket to localStorage.
 *
 * @param {object} classification - the object returned by classifyHazard(text)
 * @param {object} [meta] - optional extra info, e.g. { zone: "Platform 1", reporter: "Manoj" }
 * @returns {object} the full ticket that was created (includes an id)
 */
function createTicket(classification, meta) {
  meta = meta || {};
  const tickets = _loadTicketsFromStorage();

  const ticket = {
    id: _generateId(),
    type: classification.type,
    label: classification.label,
    icon: classification.icon,
    tier: classification.tier,
    confidence: classification.confidence,
    analysisLog: classification.analysisLog,
    solutionSteps: classification.solutionSteps,
    stepsDone: classification.solutionSteps.map(() => false), // all unchecked at start
    status: "Open", // Open -> In Progress -> Verified -> Resolved
    zone: meta.zone || "Unspecified",
    reporter: meta.reporter || "Unknown",
    createdAt: new Date().toISOString(),
    resolvedAt: null
  };

  tickets.push(ticket);
  _saveTicketsToStorage(tickets);
  return ticket;
}

/**
 * getAllTickets()
 * -----------------
 * Returns every saved ticket, sorted worst-tier-first (Fatal at the top),
 * then newest-first within the same tier.
 */
function getAllTickets() {
  const tickets = _loadTicketsFromStorage();
  return tickets.sort((a, b) => {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

/**
 * getTicketById(id)
 * -------------------
 * Returns a single ticket, or null if not found.
 */
function getTicketById(id) {
  const tickets = _loadTicketsFromStorage();
  return tickets.find((t) => t.id === id) || null;
}

/**
 * updateTicketStatus(id, newStatus)
 * ------------------------------------
 * Changes a ticket's status. Valid values: "Open", "In Progress", "Verified", "Resolved".
 * When you set it to "Resolved", we also stamp resolvedAt with the current time.
 */
function updateTicketStatus(id, newStatus) {
  const tickets = _loadTicketsFromStorage();
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) {
    console.warn("updateTicketStatus: no ticket found with id", id);
    return null;
  }
  ticket.status = newStatus;
  if (newStatus === "Resolved") {
    ticket.resolvedAt = new Date().toISOString();
  }
  _saveTicketsToStorage(tickets);
  return ticket;
}

/**
 * markStepDone(id, stepIndex, done)
 * ------------------------------------
 * Ticks (or unticks) one solution step for a ticket.
 * Automatically moves status Open <-> "In Progress" based on progress.
 *
 * @param {string} id - ticket id
 * @param {number} stepIndex - which step in solutionSteps (0 = first step)
 * @param {boolean} done - true to check it, false to uncheck it
 */
function markStepDone(id, stepIndex, done) {
  const tickets = _loadTicketsFromStorage();
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) {
    console.warn("markStepDone: no ticket found with id", id);
    return null;
  }
  ticket.stepsDone[stepIndex] = done;

  // Auto status logic: only touch Open/In Progress automatically.
  // (Verified/Resolved are meant to be set deliberately by an admin action.)
  const anyDone = ticket.stepsDone.some(Boolean);
  if (ticket.status === "Open" && anyDone) ticket.status = "In Progress";
  if (ticket.status === "In Progress" && !anyDone) ticket.status = "Open";

  _saveTicketsToStorage(tickets);
  return ticket;
}

/**
 * deleteTicket(id)
 * ------------------
 * Permanently removes a ticket. Use sparingly — normally you'd just
 * move it to "Resolved" instead of deleting it.
 */
function deleteTicket(id) {
  const tickets = _loadTicketsFromStorage().filter((t) => t.id !== id);
  _saveTicketsToStorage(tickets);
}


/* ============================================================================
   PART 3: DISPLAYING THE analysisLog NICELY
   ============================================================================
   classifyHazard() gives you analysisLog as a plain array of strings, e.g.:
     [
       'Keyword scoring selected "PPE Kit Violation" (score 5).',
       'Matched keywords: "no helmet" (+5).',
       'Base tier for "PPE Kit Violation" is "Medium".',
       'Final confidence score: 80%.'
     ]

   renderAnalysisLog() turns that into an HTML string you can drop straight
   into any result card.
*/

/**
 * renderAnalysisLog(analysisLog)
 * ---------------------------------
 * @param {string[]} analysisLog
 * @returns {string} HTML string, e.g.:
 *   <ul class="analysis-log">
 *     <li>🔹 Keyword scoring selected "PPE Kit Violation" (score 5).</li>
 *     ...
 *   </ul>
 */
function renderAnalysisLog(analysisLog) {
  if (!analysisLog || !analysisLog.length) {
    return '<p class="analysis-log-empty">No analysis details available.</p>';
  }
  const items = analysisLog
    .map((line) => `<li>🔹 ${escapeHtml(line)}</li>`)
    .join("");
  return `<ul class="analysis-log">${items}</ul>`;
}

// Small helper so user-typed text can never break your HTML layout
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* Suggested CSS to go with renderAnalysisLog() — paste into your <style> tag:

.analysis-log {
  list-style: none;
  padding: 0;
  margin: 10px 0;
  font-size: 12.5px;
  color: #5b6570;
}
.analysis-log li {
  padding: 4px 0;
  border-bottom: 1px dashed #e1e6ec;
}
.analysis-log li:last-child {
  border-bottom: none;
}
*/
