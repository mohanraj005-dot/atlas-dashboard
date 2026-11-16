// tests/ui-format.test.js
// Unit coverage for public/app.js's formatRelativeTime, freshnessBand and
// renderPortfolio. Runs under @cloudflare/vitest-pool-workers (workerd), which
// has no `document` global — there is no jsdom/happy-dom dependency in this
// project (no build step, no framework). This file therefore constructs its
// own minimal DOM stub, sufficient to exercise renderPortfolio's querySelector/
// createElement/appendChild/textContent/classList surface without pulling in
// any dependency. app.js itself remains import-free and DOM-access-free at
// module top level, per its own contract.
//
// The stub now also supports with addEventListener/removeEventListener/
// dispatchEvent and a class/tag-selector querySelectorAll — the INSTRUMENT
// column's Copy-command button is the product's first click handler, and
// nothing in this file has ever needed to simulate one before.
import { describe, it, expect } from "vitest";
import { formatRelativeTime, freshnessBand, renderPortfolio } from "../public/app.js";

// ---- minimal fake DOM ----

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.id = "";
    this._classes = new Set();
    this._attributes = {};
    this.parentNode = null;
    this.ownerDocument = null;
    this._listeners = new Map();
  }

  get classList() {
    const self = this;
    return {
      add: (...names) => names.forEach((n) => self._classes.add(n)),
      remove: (...names) => names.forEach((n) => self._classes.delete(n)),
      contains: (n) => self._classes.has(n),
    };
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return Array.from(this._classes).join(" ");
  }

  setAttribute(name, value) {
    if (name === "id") this.id = value;
    else if (name === "class") this.className = value;
    else this._attributes[name] = value;
  }

  getAttribute(name) {
    if (name === "id") return this.id;
    if (name === "class") return this.className;
    return Object.prototype.hasOwnProperty.call(this._attributes, name)
      ? this._attributes[name]
      : null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  set textContent(value) {
    this.children = [];
    if (value !== "" && value != null) {
      this.children.push({ isText: true, data: String(value) });
    }
  }

  get textContent() {
    let out = "";
    for (const child of this.children) {
      out += child.isText ? child.data : child.textContent;
    }
    return out;
  }

  querySelector(selector) {
    if (!selector.startsWith("#")) {
      throw new Error(`fake DOM only supports #id selectors, got: ${selector}`);
    }
    const id = selector.slice(1);
    return findById(this, id);
  }

  // querySelectorAll — class (".foo") and bare tag ("button") selectors only,
  // enough to find .instrument-copy-btn / .cell-instrument nodes in a
  // rendered table. Not a general CSS engine.
  querySelectorAll(selector) {
    const matches = (node) => {
      if (selector.startsWith(".")) {
        return node.classList && node.classList.contains(selector.slice(1));
      }
      return typeof node.tagName === "string" && node.tagName.toLowerCase() === selector.toLowerCase();
    };
    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.isText) continue;
        if (matches(child)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this._listeners.get(type);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx !== -1) handlers.splice(idx, 1);
  }

  // dispatchEvent({type}) — invokes every registered handler synchronously
  // and returns the count invoked, so a test can assert a handler was
  // actually bound.
  dispatchEvent(event) {
    const handlers = this._listeners.get(event.type) || [];
    for (const handler of handlers) handler(event);
    return handlers.length;
  }
}

function findById(node, id) {
  for (const child of node.children) {
    if (child.isText) continue;
    if (child.id === id) return child;
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function makeFakeDocument() {
  const doc = {
    createElement(tag) {
      const el = new FakeNode(tag);
      el.ownerDocument = doc;
      return el;
    },
  };
  return doc;
}

function makeFakeRoot() {
  const doc = makeFakeDocument();
  const root = doc.createElement("div");

  const tbody = doc.createElement("tbody");
  tbody.id = "portfolio-tbody";
  root.appendChild(tbody);

  const coverageNumeral = doc.createElement("p");
  coverageNumeral.id = "coverage-numeral";
  root.appendChild(coverageNumeral);

  const coverageCaption = doc.createElement("p");
  coverageCaption.id = "coverage-caption";
  root.appendChild(coverageCaption);

  const healthSegment = doc.createElement("div");
  healthSegment.id = "health-segment";
  root.appendChild(healthSegment);

  const healthGlyph = doc.createElement("span");
  healthGlyph.id = "health-glyph";
  healthSegment.appendChild(healthGlyph);

  const healthText = doc.createElement("span");
  healthText.id = "health-text";
  healthSegment.appendChild(healthText);

  return root;
}

// makeClipboard(behavior) — a mockable stand-in for `navigator`, threaded
// into renderPortfolio as its injected navigator argument. Tests never patch
// the runtime's own navigator global (read-only in workerd); this object is
// passed explicitly instead.
//   "resolve" (default) — writeText resolves, recording every call
//   "reject"            — writeText rejects, recording every call
//   "absent"            — navigator.clipboard is undefined (feature-detection path)
function makeClipboard(behavior = "resolve") {
  if (behavior === "absent") {
    return { clipboard: undefined };
  }
  const calls = [];
  function writeText(text) {
    calls.push(text);
    if (behavior === "reject") {
      return Promise.reject(new Error("denied"));
    }
    return Promise.resolve();
  }
  writeText.calls = calls;
  return { clipboard: { writeText } };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---- fixtures ----

function field(value, overrides) {
  return { value, confidence: "measured", source: "git", as_of: "2026-08-09T00:00:00.000Z", ...overrides };
}

function makeProject(slug, overrides = {}) {
  return {
    slug,
    name: overrides.name || field(slug),
    tier: overrides.tier || field("T1"),
    provenance: overrides.provenance || field("git only"),
    last_activity: overrides.last_activity || field("2026-08-08T00:00:00.000Z"),
    managed: overrides.managed || field("discovered"),
    review_state: overrides.review_state || field("ok"),
    declared_at: overrides.declared_at || field(null),
  };
}

function makeHealth(state, overrides = {}) {
  return {
    state,
    last_run_at: "2026-08-09T00:00:00.000Z",
    age_seconds: 840,
    projects_seen: 11,
    errors_count: state === "failed" ? 1 : 0,
    as_of: "2026-08-09T00:14:00.000Z",
    ...overrides,
  };
}

// coverage.{parsed,declared,total,gap} — the post-02-05 shape. Every
// renderPortfolio fixture in this file uses this (coverage.instrumented no
// longer exists, per src/portfolio.js).
function makeCoverage(overrides = {}) {
  return {
    parsed: field(2),
    declared: field(3),
    total: field(11),
    gap: field(6),
    ...overrides,
  };
}

function isoOffset(now, deltaSeconds) {
  return new Date(now.getTime() - deltaSeconds * 1000).toISOString();
}

// ---- formatRelativeTime ----

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-08-09T12:00:00.000Z");
  const iso = (deltaSeconds) => new Date(NOW.getTime() - deltaSeconds * 1000).toISOString();

  it("returns 'just now' at 30s", () => {
    expect(formatRelativeTime(iso(30), NOW)).toBe("just now");
  });

  it("returns '14m ago' at 14m", () => {
    expect(formatRelativeTime(iso(14 * 60), NOW)).toBe("14m ago");
  });

  it("returns '2 hours ago' at 2h", () => {
    expect(formatRelativeTime(iso(2 * 3600), NOW)).toBe("2 hours ago");
  });

  it("returns '1 hour ago' at 1h (singular)", () => {
    expect(formatRelativeTime(iso(3600), NOW)).toBe("1 hour ago");
  });

  it("returns '12 days ago' at 12d", () => {
    expect(formatRelativeTime(iso(12 * 86400), NOW)).toBe("12 days ago");
  });

  it("returns '31 days ago' at 31d", () => {
    expect(formatRelativeTime(iso(31 * 86400), NOW)).toBe("31 days ago");
  });

  it("returns an absolute 'Mon D' form at 120d", () => {
    const result = formatRelativeTime(iso(120 * 86400), NOW);
    expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(result).not.toMatch(/ago/);
  });

  describe("band boundaries", () => {
    it("59s -> 'just now'", () => {
      expect(formatRelativeTime(iso(59), NOW)).toBe("just now");
    });
    it("60s -> '1m ago'", () => {
      expect(formatRelativeTime(iso(60), NOW)).toBe("1m ago");
    });
    it("59m -> '59m ago'", () => {
      expect(formatRelativeTime(iso(59 * 60), NOW)).toBe("59m ago");
    });
    it("60m -> '1 hour ago'", () => {
      expect(formatRelativeTime(iso(60 * 60), NOW)).toBe("1 hour ago");
    });
    it("23h -> '23 hours ago'", () => {
      expect(formatRelativeTime(iso(23 * 3600), NOW)).toBe("23 hours ago");
    });
    it("24h -> '1 day ago'", () => {
      expect(formatRelativeTime(iso(24 * 3600), NOW)).toBe("1 day ago");
    });
    it("89d -> '89 days ago'", () => {
      expect(formatRelativeTime(iso(89 * 86400), NOW)).toBe("89 days ago");
    });
    it("90d -> absolute date form", () => {
      const result = formatRelativeTime(iso(90 * 86400), NOW);
      expect(result).not.toMatch(/ago/);
      expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}/);
    });
  });
});

// ---- freshnessBand ----

describe("freshnessBand", () => {
  const NOW = new Date("2026-08-09T12:00:00.000Z");
  const iso = (deltaSeconds) => new Date(NOW.getTime() - deltaSeconds * 1000).toISOString();

  it("returns 'fresh' at 5h59m", () => {
    expect(freshnessBand(iso(5 * 3600 + 59 * 60), NOW)).toBe("fresh");
  });

  it("returns 'stale' at 6h", () => {
    expect(freshnessBand(iso(6 * 3600), NOW)).toBe("stale");
  });

  it("returns 'stale' at 23h59m", () => {
    expect(freshnessBand(iso(23 * 3600 + 59 * 60), NOW)).toBe("stale");
  });

  it("returns 'old' at 24h", () => {
    expect(freshnessBand(iso(24 * 3600), NOW)).toBe("old");
  });

  it("returns 'old' at 31d", () => {
    expect(freshnessBand(iso(31 * 86400), NOW)).toBe("old");
  });

  it("never returns a value the page maps to --color-destructive", () => {
    const samples = [0, 60, 3600, 6 * 3600, 24 * 3600, 31 * 86400, 400 * 86400];
    const allowed = new Set(["fresh", "stale", "old"]);
    for (const s of samples) {
      const band = freshnessBand(iso(s), NOW);
      expect(allowed.has(band)).toBe(true);
      expect(band).not.toBe("destructive");
    }
  });
});

// ---- FakeNode event-stub infrastructure ----

describe("FakeNode event stub", () => {
  it("dispatchEvent invokes every addEventListener-registered handler and returns the count invoked", () => {
    const doc = makeFakeDocument();
    const el = doc.createElement("button");
    let calls = 0;
    el.addEventListener("click", () => {
      calls += 1;
    });
    el.addEventListener("click", () => {
      calls += 1;
    });
    const invoked = el.dispatchEvent({ type: "click" });
    expect(calls).toBe(2);
    expect(invoked).toBe(2);
  });
});

// ---- renderPortfolio ----

describe("renderPortfolio", () => {
  const NOW = new Date("2026-08-09T12:00:00.000Z");

  it("renders '— no data' (never 0, never blank) when last_activity.value is null", () => {
    const root = makeFakeRoot();
    const portfolio = {
      coverage: makeCoverage(),
      projects: [makeProject("p1", { last_activity: field(null, { confidence: "unknown", source: "collector" }) })],
    };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);

    const tbody = root.querySelector("#portfolio-tbody");
    const activityCell = tbody.children[0].children[2];
    expect(activityCell.textContent).toBe("— no data");
    expect(activityCell.textContent).not.toBe("0");
    expect(activityCell.textContent.trim()).not.toBe("");
  });

  // Was "renders '2 of 11 instrumented' ..." — that copy contract no longer
  // exists after the coverage.instrumented field was removed. Superseded by the dedicated tests below; kept
  // in place (not deleted) so the "declared, gap-count" scenario this test
  // originally covered stays exercised.
  it("renders the three-number coverage tile and correctly pluralised caption for parsed=2/declared=3/total=11/gap=9", () => {
    const root = makeFakeRoot();
    const projects = Array.from({ length: 11 }, (_, i) => makeProject(`p${i}`));
    const portfolio = {
      coverage: makeCoverage({ parsed: field(2), declared: field(3), total: field(11), gap: field(9) }),
      projects,
    };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);

    expect(root.querySelector("#coverage-numeral").textContent).toBe("2 parsed · 3 declared · 11 total");
    expect(root.querySelector("#coverage-caption").textContent).toBe(
      "9 projects visible by git or registry only"
    );
  });

  it("renders a distinct glyph for each of the three health states", () => {
    const portfolio = {
      coverage: makeCoverage(),
      projects: [makeProject("p1")],
    };

    const rootNoRun = makeFakeRoot();
    renderPortfolio(portfolio, makeHealth("no_run", { last_run_at: null }), rootNoRun, NOW);
    expect(rootNoRun.querySelector("#health-glyph").textContent).toBe("—");

    const rootOk = makeFakeRoot();
    renderPortfolio(portfolio, makeHealth("ok"), rootOk, NOW);
    expect(rootOk.querySelector("#health-glyph").textContent).toBe("✓");

    const rootFailed = makeFakeRoot();
    renderPortfolio(portfolio, makeHealth("failed"), rootFailed, NOW);
    expect(rootFailed.querySelector("#health-glyph").textContent).toBe("✕");

    const glyphs = new Set([
      rootNoRun.querySelector("#health-glyph").textContent,
      rootOk.querySelector("#health-glyph").textContent,
      rootFailed.querySelector("#health-glyph").textContent,
    ]);
    expect(glyphs.size).toBe(3);
  });

  it("preserves the API's project order (never re-sorts)", () => {
    const root = makeFakeRoot();
    const projects = [makeProject("zzz"), makeProject("aaa"), makeProject("mmm")];
    const portfolio = {
      coverage: makeCoverage(),
      projects,
    };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);

    const tbody = root.querySelector("#portfolio-tbody");
    const renderedNames = tbody.children.map((row) => row.children[0].textContent);
    expect(renderedNames).toEqual(["zzz", "aaa", "mmm"]);
  });
});

// ---- Coverage tile ----

describe("renderPortfolio — coverage tile", () => {
  const NOW = new Date("2026-08-09T12:00:00.000Z");

  it("renders '{parsed} parsed · {declared} declared · {total} total' and the gap caption", () => {
    const root = makeFakeRoot();
    const projects = Array.from({ length: 11 }, (_, i) => makeProject(`p${i}`));
    const portfolio = {
      coverage: makeCoverage({ parsed: field(2), declared: field(3), total: field(11), gap: field(6) }),
      projects,
    };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);

    expect(root.querySelector("#coverage-numeral").textContent).toBe("2 parsed · 3 declared · 11 total");
    expect(root.querySelector("#coverage-caption").textContent).toBe(
      "6 projects visible by git or registry only"
    );
  });

  it("renders the singular caption at gap 1", () => {
    const root = makeFakeRoot();
    const projects = Array.from({ length: 11 }, (_, i) => makeProject(`p${i}`));
    const portfolio = {
      coverage: makeCoverage({ parsed: field(9), declared: field(1), total: field(11), gap: field(1) }),
      projects,
    };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);

    expect(root.querySelector("#coverage-caption").textContent).toBe(
      "1 project visible by git or registry only"
    );
  });

  it("renders the server's gap verbatim, never recomputed client-side", () => {
    const root = makeFakeRoot();
    const projects = Array.from({ length: 11 }, (_, i) => makeProject(`p${i}`));
    // Deliberately inconsistent: parsed(2) + declared(3) + gap(9) != total(11).
    // If the client ever recomputed gap as total - parsed - declared it
    // would render 6, not 9 — this proves it reads coverage.gap.value as-is.
    const portfolio = {
      coverage: makeCoverage({ parsed: field(2), declared: field(3), total: field(11), gap: field(9) }),
      projects,
    };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);

    expect(root.querySelector("#coverage-caption").textContent).toBe(
      "9 projects visible by git or registry only"
    );
  });
});

// ---- SOURCE token composition ----

describe("buildRow — SOURCE column composition", () => {
  const NOW = new Date("2026-08-09T12:00:00.000Z");

  it("not declared: renders the existing signal only", () => {
    const root = makeFakeRoot();
    const project = makeProject("p1", { provenance: field("git only") });
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);
    const row = root.querySelector("#portfolio-tbody").children[0];
    expect(row.children[3].textContent).toBe("git only");
  });

  it("declared, fresh (< 6h): appends ' · declared' with no age", () => {
    const root = makeFakeRoot();
    const project = makeProject("p1", {
      provenance: field("registry only"),
      managed: field("declared"),
      declared_at: field(isoOffset(NOW, 3600)), // 1h ago -> fresh
    });
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);
    const row = root.querySelector("#portfolio-tbody").children[0];
    expect(row.children[3].textContent).toBe("registry only · declared");
  });

  it("declared, aged (>= 6h): appends ' · declared · {age}'", () => {
    const root = makeFakeRoot();
    const project = makeProject("p1", {
      provenance: field("git only"),
      managed: field("declared"),
      declared_at: field(isoOffset(NOW, 47 * 86400)),
    });
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);
    const row = root.querySelector("#portfolio-tbody").children[0];
    expect(row.children[3].textContent).toBe("git only · declared · 47 days ago");
  });

  it("declared, needs_review: appends ' · needs review'", () => {
    const root = makeFakeRoot();
    const project = makeProject("p1", {
      provenance: field("git only"),
      managed: field("declared"),
      declared_at: field(isoOffset(NOW, 3600)),
      review_state: field("needs_review"),
    });
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);
    const row = root.querySelector("#portfolio-tbody").children[0];
    expect(row.children[3].textContent).toBe("git only · declared · needs review");
  });

  it("declared, aged, needs_review: all three tokens in fixed order", () => {
    const root = makeFakeRoot();
    const project = makeProject("p1", {
      provenance: field("git only"),
      managed: field("declared"),
      declared_at: field(isoOffset(NOW, 47 * 86400)),
      review_state: field("needs_review"),
    });
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);
    const row = root.querySelector("#portfolio-tbody").children[0];
    expect(row.children[3].textContent).toBe("git only · declared · 47 days ago · needs review");
  });
});

// ---- INSTRUMENT column ----

describe("buildRow — INSTRUMENT column", () => {
  const NOW = new Date("2026-08-09T12:00:00.000Z");

  it("renders a selectable command and a Copy button for a non-declared row with the Clipboard API present", () => {
    const root = makeFakeRoot();
    const project = makeProject("acme-co", {
      name: field("Acme Co"),
      managed: field("discovered"),
    });
    const nav = makeClipboard("resolve");
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW, nav);

    const row = root.querySelector("#portfolio-tbody").children[0];
    const instrumentCell = row.children[4];
    expect(instrumentCell.className).toContain("cell-instrument");
    expect(instrumentCell.getAttribute("data-label")).toBe("INSTRUMENT");

    const codes = instrumentCell.querySelectorAll("code");
    expect(codes.length).toBe(1);
    expect(codes[0].textContent).toBe("atlas init acme-co");

    const buttons = instrumentCell.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toBe("Copy command");
    expect(buttons[0].getAttribute("aria-label")).toBe("Copy atlas init command for Acme Co");
  });

  it("is empty (no children, no text) for an already-declared row", () => {
    const root = makeFakeRoot();
    const project = makeProject("acme-co", { managed: field("declared") });
    const nav = makeClipboard("resolve");
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW, nav);

    const row = root.querySelector("#portfolio-tbody").children[0];
    const instrumentCell = row.children[4];
    expect(instrumentCell.children.length).toBe(0);
    expect(instrumentCell.textContent).toBe("");
  });

  it("renders the command with no button when the Clipboard API is unavailable (progressive enhancement)", () => {
    const root = makeFakeRoot();
    const project = makeProject("acme-co", { managed: field("discovered") });
    const nav = makeClipboard("absent");
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW, nav);

    const row = root.querySelector("#portfolio-tbody").children[0];
    const instrumentCell = row.children[4];
    expect(instrumentCell.querySelectorAll("code").length).toBe(1);
    expect(instrumentCell.querySelectorAll("button").length).toBe(0);
  });

  it("clicking the Copy button writes the command to the clipboard and shows 'Copied'", async () => {
    const root = makeFakeRoot();
    const project = makeProject("acme-co", { managed: field("discovered") });
    const nav = makeClipboard("resolve");
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW, nav);

    const row = root.querySelector("#portfolio-tbody").children[0];
    const button = row.children[4].querySelectorAll("button")[0];

    button.dispatchEvent({ type: "click" });
    await flushMicrotasks();

    expect(nav.clipboard.writeText.calls).toEqual(["atlas init acme-co"]);
    expect(button.textContent).toBe("Copied");
  });

  it("clicking the Copy button on a rejecting clipboard shows the failure copy and does not throw", async () => {
    const root = makeFakeRoot();
    const project = makeProject("acme-co", { managed: field("discovered") });
    const nav = makeClipboard("reject");
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW, nav);

    const row = root.querySelector("#portfolio-tbody").children[0];
    const button = row.children[4].querySelectorAll("button")[0];

    expect(() => button.dispatchEvent({ type: "click" })).not.toThrow();
    await flushMicrotasks();

    expect(button.textContent).toBe("Copy failed — select manually");
  });

  it("renders no INSTRUMENT content at all for a slug containing shell metacharacters", () => {
    const root = makeFakeRoot();
    const project = makeProject("evil; rm -rf ~", { managed: field("discovered") });
    const nav = makeClipboard("resolve");
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW, nav);

    const row = root.querySelector("#portfolio-tbody").children[0];
    const instrumentCell = row.children[4];
    expect(instrumentCell.querySelectorAll("code").length).toBe(0);
    expect(instrumentCell.querySelectorAll("button").length).toBe(0);
  });

  it("every row has exactly five cells in the fixed order, first four unchanged", () => {
    const root = makeFakeRoot();
    const project = makeProject("acme-co", { managed: field("discovered") });
    const portfolio = { coverage: makeCoverage(), projects: [project] };
    renderPortfolio(portfolio, makeHealth("ok"), root, NOW);

    const row = root.querySelector("#portfolio-tbody").children[0];
    expect(row.children.length).toBe(5);
    expect(row.children[0].className).toContain("cell-project");
    expect(row.children[1].className).toContain("cell-tier");
    expect(row.children[2].className).toContain("cell-activity");
    expect(row.children[3].className).toContain("cell-source");
    expect(row.children[4].className).toContain("cell-instrument");
  });
});
