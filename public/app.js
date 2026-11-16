// public/app.js
// Plain ES module, no imports, no build step. Drives public/index.html: fetches
// /api/portfolio and /api/health concurrently, renders the table and the two
// summary-strip segments, and formats relative time per the freshness contract. Exports formatRelativeTime, freshnessBand, renderPortfolio,
// buildSourceText and isSafeSlug so tests/ui-format.test.js can import this
// file directly in a non-DOM context — all DOM access therefore lives inside
// functions, never at module top level, and the bootstrap only runs when
// `document` exists. renderPortfolio's navigator argument (default
// globalThis.navigator) keeps this file free of top-level global access too —
// tests/ui-format.test.js relies on injecting a fake navigator instead of
// patching the runtime's own, which is read-only in workerd.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NINETY_DAYS = 90 * DAY;

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * formatRelativeTime(iso, now) — the exact bands of the freshness / as-of contract. `now` is injectable (a Date) so tests are
 * deterministic. `full` selects the table's "hours"/"days" wording; the
 * abbreviated "{n}m ago" form (used by the collector-health segment) is the
 * only form under an hour regardless of `full`.
 */
export function formatRelativeTime(iso, now) {
  const then = new Date(iso);
  const nowDate = now instanceof Date ? now : new Date(now);
  const diffSeconds = Math.max(0, Math.floor((nowDate.getTime() - then.getTime()) / 1000));

  if (diffSeconds < MINUTE) {
    return "just now";
  }
  if (diffSeconds < HOUR) {
    const minutes = Math.floor(diffSeconds / MINUTE);
    return `${minutes}m ago`;
  }
  if (diffSeconds < DAY) {
    const hours = Math.floor(diffSeconds / HOUR);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (diffSeconds < NINETY_DAYS) {
    const days = Math.floor(diffSeconds / DAY);
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }

  const month = MONTH_NAMES[then.getUTCMonth()];
  const day = then.getUTCDate();
  if (then.getUTCFullYear() === nowDate.getUTCFullYear()) {
    return `${month} ${day}`;
  }
  return `${month} ${day}, ${then.getUTCFullYear()}`;
}

/**
 * freshnessBand(iso, now) — "fresh" under 6h, "stale" 6h-24h, "old" beyond
 * 24h. Maps to --color-text / --color-accent / --color-text-muted. "old" is
 * deliberately muted, never destructive — a quiet project is not a failure;
 * destructive red is reserved for a failed collector run only.
 */
export function freshnessBand(iso, now) {
  const then = new Date(iso);
  const nowDate = now instanceof Date ? now : new Date(now);
  const diffSeconds = Math.max(0, Math.floor((nowDate.getTime() - then.getTime()) / 1000));

  if (diffSeconds < 6 * HOUR) return "fresh";
  if (diffSeconds < DAY) return "stale";
  return "old";
}

const FRESHNESS_CLASS = {
  fresh: "freshness-fresh",
  stale: "freshness-stale",
  old: "freshness-old",
};

function pluralize(count, noun) {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

function setText(el, text) {
  el.textContent = text;
}

function buildTierBadge(doc, tierValue) {
  const span = doc.createElement("span");
  const tier = typeof tierValue === "string" && tierValue ? tierValue : "T0";
  span.className = `tier-badge text-label tier-${tier}`;
  span.textContent = tier;
  return span;
}

/**
 * buildSourceText(project, now) — SOURCE column grammar, fixed order:
 *   {existing signal}[ · declared[ · {age}]][ · needs review]
 * Plain text only — no badge, no colour class.
 */
export function buildSourceText(project, now) {
  let text = project.provenance && project.provenance.value != null ? project.provenance.value : "unknown";

  if (project.managed && project.managed.value === "declared") {
    text += " · declared";
    if (project.declared_at && project.declared_at.value) {
      const band = freshnessBand(project.declared_at.value, now);
      if (band !== "fresh") {
        text += ` · ${formatRelativeTime(project.declared_at.value, now)}`;
      }
    }
  }

  if (project.review_state && project.review_state.value === "needs_review") {
    text += " · needs review";
  }

  return text;
}

/**
 * isSafeSlug(slug) — matches collector/lib/registry.mjs's assertValidSlug
 * pattern exactly, so the browser and the CLI agree on what a slug is. The
 * INSTRUMENT column renders a paste-able shell command built from this
 * value; an unsafe slug renders no command at all.
 */
export function isSafeSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

function buildRow(doc, project, now, navigator) {
  const tr = doc.createElement("tr");

  const nameCell = doc.createElement("td");
  nameCell.className = "cell-project";
  setText(nameCell, project.name && project.name.value != null ? project.name.value : project.slug);
  tr.appendChild(nameCell);

  const tierCell = doc.createElement("td");
  tierCell.className = "cell-tier";
  tierCell.setAttribute("data-label", "TIER");
  tierCell.appendChild(buildTierBadge(doc, project.tier ? project.tier.value : null));
  tr.appendChild(tierCell);

  const activityCell = doc.createElement("td");
  activityCell.className = "cell-activity";
  activityCell.setAttribute("data-label", "LAST ACTIVITY");
  const lastActivityValue = project.last_activity ? project.last_activity.value : null;
  if (lastActivityValue == null) {
    setText(activityCell, "— no data");
  } else {
    const band = freshnessBand(lastActivityValue, now);
    activityCell.classList.add(FRESHNESS_CLASS[band]);
    setText(activityCell, formatRelativeTime(lastActivityValue, now));
  }
  tr.appendChild(activityCell);

  const sourceCell = doc.createElement("td");
  sourceCell.className = "cell-source";
  sourceCell.setAttribute("data-label", "SOURCE");
  setText(sourceCell, buildSourceText(project, now));
  tr.appendChild(sourceCell);

  const instrumentCell = doc.createElement("td");
  instrumentCell.className = "cell-instrument";
  instrumentCell.setAttribute("data-label", "INSTRUMENT");
  const isDeclared = project.managed && project.managed.value === "declared";
  if (!isDeclared && isSafeSlug(project.slug)) {
    const displayName = project.name && project.name.value != null ? project.name.value : project.slug;
    const command = `atlas init ${project.slug}`;

    const code = doc.createElement("code");
    code.className = "instrument-command";
    setText(code, command);
    instrumentCell.appendChild(code);

    if (typeof navigator?.clipboard?.writeText === "function") {
      const button = doc.createElement("button");
      button.setAttribute("type", "button");
      button.className = "instrument-copy-btn";
      button.setAttribute("aria-label", `Copy atlas init command for ${displayName}`);
      setText(button, "Copy command");

      button.addEventListener("click", () => {
        try {
          navigator.clipboard
            .writeText(command)
            .then(() => {
              setText(button, "Copied");
              setTimeout(() => setText(button, "Copy command"), 2000);
            })
            .catch(() => {
              setText(button, "Copy failed — select manually");
              setTimeout(() => setText(button, "Copy command"), 2000);
            });
        } catch (err) {
          setText(button, "Copy failed — select manually");
          setTimeout(() => setText(button, "Copy command"), 2000);
        }
      });

      instrumentCell.appendChild(button);
    }
  }
  tr.appendChild(instrumentCell);

  return tr;
}

function renderCoverage(doc, root, portfolio) {
  const numeralEl = root.querySelector("#coverage-numeral");
  const captionEl = root.querySelector("#coverage-caption");
  const parsed = portfolio.coverage.parsed.value;
  const declared = portfolio.coverage.declared.value;
  const total = portfolio.coverage.total.value;
  // gap is computed server-side by predicate (src/portfolio.js), never
  // by subtraction here. tier and managed are orthogonal, so a
  // project can be both T3 and declared — total − parsed − declared would
  // double-count that project. Read the server's number as-is.
  const gap = portfolio.coverage.gap.value;

  setText(numeralEl, `${parsed} parsed · ${declared} declared · ${total} total`);
  setText(captionEl, `${pluralize(gap, "project")} visible by git or registry only`);
}

function renderHealth(doc, root, health, now) {
  const segmentEl = root.querySelector("#health-segment");
  const glyphEl = root.querySelector("#health-glyph");
  const textEl = root.querySelector("#health-text");

  segmentEl.classList.remove("state-no_run", "state-ok", "state-failed");
  segmentEl.classList.add(`state-${health.state}`);

  const age = health.last_run_at ? formatRelativeTime(health.last_run_at, now) : null;

  if (health.state === "no_run") {
    setText(glyphEl, "—");
    setText(textEl, "No runs yet — the collector hasn't pushed a snapshot");
  } else if (health.state === "ok") {
    setText(glyphEl, "✓");
    setText(textEl, `Healthy — last run ${age}, no changes`);
  } else {
    setText(glyphEl, "✕");
    setText(textEl, `Collector run failed ${age} — check ~/.atlas/logs`);
  }
}

/**
 * renderPortfolio(portfolio, health, root, now, navigator) — pure with
 * respect to its arguments given a root element. Renders every row in the
 * API's own order (stalest-first, already sorted server-side — never
 * re-sorted here), the coverage segment and the collector-health segment.
 * The coverage as-of is not printed a second time next to the numeral: it
 * IS the health segment's {age}, since parsed/declared/total/gap all come
 * from the same collector pass (each shares as_of with health.last_run_at,
 * enforced by tests) — this shared render is a page decision,
 * not licence to under-populate the API, which still carries the full
 * {value, confidence, source, as_of} shape on every leaf.
 *
 * `navigator` defaults to globalThis.navigator and is threaded down into
 * buildRow so the Copy-command button's Clipboard API access is injectable
 * rather than read off a global inside buildRow — the mechanism that keeps
 * tests/ui-format.test.js able to mock it in workerd, where the real
 * navigator global is read-only.
 */
export function renderPortfolio(portfolio, health, root, now, navigator = globalThis.navigator) {
  const doc = root.ownerDocument || (typeof document !== "undefined" ? document : null);
  if (!doc) {
    throw new Error("renderPortfolio requires a root element with an ownerDocument");
  }

  const tbody = root.querySelector("#portfolio-tbody");
  tbody.textContent = "";

  for (const project of portfolio.projects) {
    tbody.appendChild(buildRow(doc, project, now, navigator));
  }

  renderCoverage(doc, root, portfolio);
  renderHealth(doc, root, health, now);
}

function showOnly(doc, idToShow) {
  const ids = ["loading-state", "error-state", "empty-state", "portfolio-content"];
  for (const id of ids) {
    const el = doc.getElementById(id);
    if (!el) continue;
    el.style.display = id === idToShow ? "" : "none";
  }
}

async function bootstrap() {
  const doc = document;
  const root = doc.body;

  try {
    const [portfolioRes, healthRes] = await Promise.all([
      fetch("/api/portfolio"),
      fetch("/api/health"),
    ]);

    if (!portfolioRes.ok || !healthRes.ok) {
      showOnly(doc, "error-state");
      return;
    }

    const portfolio = await portfolioRes.json();
    const health = await healthRes.json();

    if (!Array.isArray(portfolio.projects) || portfolio.projects.length === 0) {
      showOnly(doc, "empty-state");
      return;
    }

    renderPortfolio(portfolio, health, root, new Date());
    showOnly(doc, "portfolio-content");
  } catch (err) {
    showOnly(doc, "error-state");
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    bootstrap();
  });
}
