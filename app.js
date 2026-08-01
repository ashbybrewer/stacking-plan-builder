/* ============================================================
   Stacking Plan Builder
   Zero-dependency vanilla JS + SVG. Runs from file:// or any
   static host. CSV in → interactive stacking plan out.
   ============================================================ */
(function () {
  "use strict";

  // ---------- constants ----------

  var SVG_NS = "http://www.w3.org/2000/svg";
  var W = 1000;          // viewBox width
  var GUT_L = 56;        // left gutter: floor labels
  var GUT_R = 84;        // right gutter: floor RSF
  var ROW = 40;          // floor row height (incl. 2px surface gap)
  var PAD_TOP = 8;
  var PAD_BOT = 14;
  var PLOT_W = W - GUT_L - GUT_R;
  var MS_MONTH = 86400000 * 30.4375;
  var MS_YEAR = 86400000 * 365.25;
  var HORIZON_MONTHS = 120; // slider range: today + 10 years

  var BUCKETS = {
    r0:  { cls: "b-r0",  label: "Expiring ≤ 12 mo" },
    r1:  { cls: "b-r1",  label: "1–3 yrs" },
    r2:  { cls: "b-r2",  label: "3+ yrs" },
    vac: { cls: "b-vac", label: "Vacant" }
  };

  // ---------- state ----------

  var state = {
    name: "",
    suites: [],       // model rows
    floors: [],       // [{label, sf, suites:[...]}] top -> bottom
    baseDate: null,   // "today" at load time
    monthIndex: 0,    // slider position
    asOf: null,
    stats: null,
    spotlight: null,  // bucket cls from legend, or null
    hoverTenant: null,
    pinnedSuite: null,
    view: "stack",
    issues: []
  };

  var els = {};       // DOM handles, filled in init()
  var playTimer = null;
  var measureCtx = document.createElement("canvas").getContext("2d");

  // ---------- tiny helpers ----------

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function fmtInt(n) { return Math.round(n).toLocaleString("en-US"); }

  function fmtCompact(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1e4) return (n / 1e3).toFixed(0) + "K";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return fmtInt(n);
  }

  function fmtMoney(n) { return "$" + fmtCompact(n); }

  function fmtMonthYear(d) {
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  }

  function utcNoon(y, m, d) { return new Date(Date.UTC(y, m, d, 12)); }

  function todayUTC() {
    var n = new Date();
    return utcNoon(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function addMonthsFromBase(base, k) {
    if (k <= 0) return base;
    return utcNoon(base.getUTCFullYear(), base.getUTCMonth() + k, 1);
  }

  function monthsBetween(a, b) { return (b - a) / MS_MONTH; }

  function natCmp(a, b) {
    var ax = String(a).match(/(\d+|\D+)/g) || [];
    var bx = String(b).match(/(\d+|\D+)/g) || [];
    for (var i = 0; i < Math.max(ax.length, bx.length); i++) {
      var as = ax[i], bs = bx[i];
      if (as === undefined) return -1;
      if (bs === undefined) return 1;
      var an = parseInt(as, 10), bn = parseInt(bs, 10);
      if (!isNaN(an) && !isNaN(bn)) { if (an !== bn) return an - bn; }
      else if (as !== bs) return as < bs ? -1 : 1;
    }
    return 0;
  }

  // ---------- CSV parsing ----------

  function parseCSV(text) {
    var rows = [], row = [], field = "", inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') {
        inQ = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) {
      return r.some(function (cell) { return cell.trim() !== ""; });
    });
  }

  var HEADER_ALIASES = {
    floor: ["floor", "level", "flr", "story", "storey"],
    suite: ["suite", "unit", "suiteno", "suitenumber", "space", "spaceid"],
    tenant: ["tenant", "tenantname", "name", "lessee", "occupant", "company"],
    sqft: ["sqft", "sf", "rsf", "area", "size", "squarefeet", "sqfeet", "rentablesf", "rentablesqft", "rentablearea"],
    start: ["leasestart", "start", "startdate", "commencement", "commencementdate", "from"],
    end: ["leaseend", "end", "enddate", "expiration", "expirationdate", "expiry", "expires", "leaseexpiration", "lxd", "lease_end", "expdate"],
    rent: ["rentpsf", "rentpersf", "rate", "baserent", "rentrate", "psf", "rent"],
    annualRent: ["annualrent", "totalrent", "annualbaserent"],
    use: ["use", "usetype", "type", "category", "spacetype"]
  };

  function normalizeHeader(h) { return String(h).toLowerCase().replace(/[^a-z0-9]/g, ""); }

  function mapHeaders(headerRow) {
    var map = {};
    headerRow.forEach(function (h, idx) {
      var n = normalizeHeader(h);
      for (var key in HEADER_ALIASES) {
        if (map[key] === undefined && HEADER_ALIASES[key].indexOf(n) !== -1) {
          map[key] = idx;
          return;
        }
      }
    });
    return map;
  }

  function parseDateStr(s) {
    s = String(s || "").trim();
    if (!s) return null;
    var m = s.match(/^(\d{4})[-\/](\d{1,2})(?:[-\/](\d{1,2}))?$/); // ISO: 2029-05-31 or 2029-05
    if (m) return utcNoon(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
    m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);        // US: 5/31/2029, 5/31/29
    if (m) {
      var y = +m[3];
      if (y < 100) y += y >= 70 ? 1900 : 2000;
      return utcNoon(y, +m[1] - 1, +m[2]);
    }
    var d = new Date(s); // last resort: "May 31, 2029"
    if (!isNaN(d)) return utcNoon(d.getFullYear(), d.getMonth(), d.getDate());
    return null;
  }

  function parseNum(s) {
    var v = parseFloat(String(s || "").replace(/[$,\s]/g, ""));
    return isNaN(v) ? null : v;
  }

  function floorRank(label) {
    var s = String(label).trim().toUpperCase();
    var m;
    if ((m = s.match(/^(?:B|SB)(\d*)$/))) return -(+m[1] || 1);
    if (/^(?:LL|LOWER)\d*$/.test(s)) return -1;
    if (/^(?:G|GF|GR|GRD|L|LBY|LOBBY)$/.test(s)) return 0;
    if (/^(?:M|MZ|MEZZ)$/.test(s)) return 0.5;
    if ((m = s.match(/^PH(\d*)$/))) return 100000 + (+m[1] || 0);
    if (/^(?:RF|ROOF)$/.test(s)) return 100010;
    var n = parseFloat(s);
    if (!isNaN(n)) return n;
    return -100000; // unknown labels sink to the bottom, in file order
  }

  function buildModel(csvText, name) {
    var rows = parseCSV(csvText);
    if (rows.length < 2) throw new Error("CSV needs a header row and at least one data row.");
    var map = mapHeaders(rows[0]);
    if (map.floor === undefined || map.sqft === undefined) {
      throw new Error("CSV must include at least 'floor' and 'sqft' columns (aliases like level / rsf / area work too).");
    }

    var suites = [];
    var issues = [];
    var rentVals = [];

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      function cell(key) { return map[key] !== undefined ? (r[map[key]] || "").trim() : ""; }
      var sqft = parseNum(cell("sqft"));
      var floor = cell("floor");
      if (!floor || !sqft || sqft <= 0) {
        issues.push("line " + (i + 1) + " (missing floor or sqft)");
        continue;
      }
      var tenant = cell("tenant");
      if (/^(vacant|available|empty|-+)$/i.test(tenant)) tenant = "";
      var endRaw = cell("end");
      var end = parseDateStr(endRaw);
      if (endRaw && !end) issues.push("line " + (i + 1) + " (bad date '" + endRaw + "')");
      var rent = parseNum(cell("rent"));
      if (rent != null) rentVals.push(rent);
      suites.push({
        floor: floor,
        suite: cell("suite") || String(i),
        tenant: tenant,
        sqft: sqft,
        start: parseDateStr(cell("start")),
        end: tenant ? end : null,
        rentPsf: tenant ? rent : null,
        annualRent: tenant ? parseNum(cell("annualRent")) : null,
        use: cell("use")
      });
    }

    if (!suites.length) throw new Error("No usable rows found in the CSV.");

    // A plain "rent" column might be annual rent, not $/SF — median tells us.
    var sorted = rentVals.slice().sort(function (a, b) { return a - b; });
    var median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    var rentIsAnnual = median > 400;
    suites.forEach(function (s) {
      if (rentIsAnnual && s.rentPsf != null) {
        s.annualRent = s.rentPsf;
        s.rentPsf = s.annualRent / s.sqft;
      } else if (s.rentPsf != null && s.annualRent == null) {
        s.annualRent = s.rentPsf * s.sqft;
      } else if (s.annualRent != null && s.rentPsf == null) {
        s.rentPsf = s.annualRent / s.sqft;
      }
    });

    // group into floors, top floor first
    var byFloor = new Map();
    suites.forEach(function (s) {
      var key = String(s.floor).trim();
      if (!byFloor.has(key)) byFloor.set(key, []);
      byFloor.get(key).push(s);
    });
    var floors = Array.from(byFloor.entries()).map(function (e) {
      var fs = e[1].slice().sort(function (a, b) { return natCmp(a.suite, b.suite); });
      return {
        label: e[0],
        rank: floorRank(e[0]),
        sf: fs.reduce(function (t, s) { return t + s.sqft; }, 0),
        suites: fs
      };
    });
    floors.sort(function (a, b) { return b.rank - a.rank; });

    return { name: name, suites: suites, floors: floors, issues: issues };
  }

  // ---------- bucket + stats ----------

  // r0: expiring within 12 months (or month-to-month) · r1: 1–3 yrs · r2: 3+ yrs
  // vac: vacant, including leases already rolled at the as-of date
  function bucketOf(s, asOf) {
    if (!s.tenant) return "vac";
    if (s.end && s.end <= asOf) return "vac";
    if (!s.end) return "r0"; // month-to-month
    var m = monthsBetween(asOf, s.end);
    if (m <= 12) return "r0";
    if (m <= 36) return "r1";
    return "r2";
  }

  function isRolled(s, asOf) { return !!(s.tenant && s.end && s.end <= asOf); }

  function computeStats(asOf) {
    var st = {
      totalSF: 0, occSF: 0, sfByBucket: { r0: 0, r1: 0, r2: 0, vac: 0 },
      waltNum: 0, rent: 0, rentSF: 0, mtmSF: 0,
      tenants: new Map(), rollover: new Map(), later: { sf: 0 },
      suiteCount: state.suites.length, floorCount: state.floors.length
    };
    var horizonYear = asOf.getUTCFullYear() + 9;
    state.suites.forEach(function (s) {
      st.totalSF += s.sqft;
      var b = bucketOf(s, asOf);
      st.sfByBucket[b] += s.sqft;
      if (b === "vac") return;
      st.occSF += s.sqft;
      st.tenants.set(s.tenant, (st.tenants.get(s.tenant) || 0) + s.sqft);
      if (s.rentPsf != null) { st.rent += s.annualRent; st.rentSF += s.sqft; }
      if (s.end) {
        st.waltNum += s.sqft * Math.max(0, (s.end - asOf) / MS_YEAR);
        var y = s.end.getUTCFullYear();
        if (y > horizonYear) { st.later.sf += s.sqft; }
        else {
          if (!st.rollover.has(y)) st.rollover.set(y, { r0: 0, r1: 0, r2: 0 });
          st.rollover.get(y)[b] += s.sqft;
        }
      } else {
        st.mtmSF += s.sqft;
      }
    });
    st.occPct = st.totalSF ? st.occSF / st.totalSF : 0;
    st.walt = st.occSF ? st.waltNum / st.occSF : 0;
    st.exp12 = st.sfByBucket.r0;
    var top = null;
    st.tenants.forEach(function (sf, name) { if (!top || sf > top.sf) top = { name: name, sf: sf }; });
    st.topTenant = top;
    return st;
  }

  // ---------- building SVG ----------

  var suiteNodes = []; // [{s, g, fill, hatch, lab, lab2, hit}]

  function measure(text, font) {
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  var FONT1 = '600 10.5px system-ui, -apple-system, "Segoe UI", sans-serif';
  var FONT2 = '500 9.5px system-ui, -apple-system, "Segoe UI", sans-serif';

  function fitLabel(text, maxW) {
    if (!text) return null;
    if (measure(text, FONT1) <= maxW) return text;
    var first = text.split(/\s+/)[0];
    if (first.length >= 3 && first.length < text.length) {
      var short = first + "…";
      if (measure(short, FONT1) <= maxW) return short;
    }
    return null;
  }

  function renderBuilding() {
    var svg = els.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    suiteNodes = [];

    var H = PAD_TOP + state.floors.length * ROW + PAD_BOT;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", "Stacking plan for " + state.name);

    // vacancy hatch pattern
    var defs = svgEl("defs");
    var pat = svgEl("pattern", {
      id: "hatch", patternUnits: "userSpaceOnUse",
      width: 7, height: 7, patternTransform: "rotate(45)"
    });
    var pline = svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 7, "stroke-width": 1.2 });
    pline.style.stroke = "var(--hatch)";
    pat.appendChild(pline);
    defs.appendChild(pat);
    svg.appendChild(defs);

    var maxSF = Math.max.apply(null, state.floors.map(function (f) { return f.sf; }));

    state.floors.forEach(function (f, fi) {
      var y = PAD_TOP + fi * ROW;
      var fw = (f.sf / maxSF) * PLOT_W;
      var x0 = GUT_L + (PLOT_W - fw) / 2;

      var flab = svgEl("text", { x: GUT_L - 10, y: y + ROW / 2 + 4, "text-anchor": "end", "class": "floor-lab" });
      flab.textContent = f.label;
      svg.appendChild(flab);

      var fsf = svgEl("text", { x: GUT_L + PLOT_W + 10, y: y + ROW / 2 + 4, "class": "floor-sf" });
      fsf.textContent = fmtInt(f.sf);
      svg.appendChild(fsf);

      var cx = x0;
      f.suites.forEach(function (s) {
        var sw = (s.sqft / f.sf) * fw;
        var g = svgEl("g", { "class": "suite" });
        g.dataset.tenant = s.tenant || "";

        // 2px surface gaps between neighbors: inset each fill by 1px per side
        var rx = cx + 1, rw = Math.max(sw - 2, 1.5);
        var ry = y + 1, rh = ROW - 2;

        var fill = svgEl("rect", { x: rx, y: ry, width: rw, height: rh, rx: 3, "class": "fillrect" });
        var hatch = svgEl("rect", { x: rx, y: ry, width: rw, height: rh, rx: 3, fill: "url(#hatch)", "class": "hatchrect" });
        g.appendChild(fill);
        g.appendChild(hatch);

        var lab = svgEl("text", { "text-anchor": "middle", "class": "lab" });
        var lab2 = svgEl("text", { "text-anchor": "middle", "class": "lab2" });
        var mid = rx + rw / 2;
        lab.setAttribute("x", mid); lab2.setAttribute("x", mid);
        g.appendChild(lab); g.appendChild(lab2);

        // hit target: at least 18px wide regardless of mark width
        var hw = Math.max(rw + 2, 18);
        var hit = svgEl("rect", {
          x: cx + sw / 2 - hw / 2, y: y, width: hw, height: ROW,
          rx: 3, "class": "hit", tabindex: 0, role: "button"
        });
        g.appendChild(hit);

        svg.appendChild(g);
        var node = { s: s, g: g, fill: fill, lab: lab, lab2: lab2, hit: hit, w: rw, cy: ry + rh / 2 };
        suiteNodes.push(node);

        hit.addEventListener("pointerenter", function (e) { onSuiteHover(node, e); });
        hit.addEventListener("pointermove", function (e) { moveTooltip(e); });
        hit.addEventListener("pointerleave", function () { onSuiteLeave(node); });
        hit.addEventListener("focus", function () { onSuiteFocus(node); });
        hit.addEventListener("blur", function () { onSuiteLeave(node); });
        hit.addEventListener("click", function (e) { e.stopPropagation(); onSuitePin(node, e); });
        hit.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSuitePin(node); }
        });

        cx += sw;
      });
    });

    // ground line under the lowest floor
    var by = PAD_TOP + state.floors.length * ROW + 4.5;
    svg.appendChild(svgEl("line", { x1: GUT_L - 26, y1: by, x2: GUT_L + PLOT_W + 26, y2: by, "class": "baseline" }));
  }

  function suiteLabelText(node, bucket) {
    var s = node.s;
    return { l1: bucket === "vac" ? "Vacant" : s.tenant, l2: fmtInt(s.sqft) + " SF" };
  }

  function suiteAria(node, bucket, asOf) {
    var s = node.s;
    var parts = ["Suite " + s.suite, "floor " + s.floor, fmtInt(s.sqft) + " square feet"];
    if (bucket === "vac") {
      parts.push(isRolled(s, asOf) ? "vacant, " + s.tenant + " lease expired " + fmtMonthYear(s.end) : "vacant");
    } else {
      parts.push(s.tenant);
      parts.push(s.end ? "expires " + fmtMonthYear(s.end) : "month-to-month");
    }
    return parts.join(", ");
  }

  // update fills, labels and aria for the current as-of date
  function updateRisk() {
    var asOf = state.asOf;
    suiteNodes.forEach(function (node) {
      var b = bucketOf(node.s, asOf);
      node.bucket = b;
      node.g.setAttribute("class", "suite " + BUCKETS[b].cls);
      var maxW = node.w - 14;
      var txt = suiteLabelText(node, b);
      var l1 = fitLabel(txt.l1, maxW);
      var l2 = l1 && measure(txt.l2, FONT2) <= maxW ? txt.l2 : null;
      node.lab.textContent = l1 || "";
      node.lab2.textContent = l2 || "";
      if (l1 && l2) {
        node.lab.setAttribute("y", node.cy - 3.5);
        node.lab2.setAttribute("y", node.cy + 9);
      } else if (l1) {
        node.lab.setAttribute("y", node.cy + 3.5);
      }
      node.hit.setAttribute("aria-label", suiteAria(node, b, asOf));
    });
    applyEmphasis();
  }

  // ---------- emphasis (legend spotlight + same-tenant hover) ----------

  function applyEmphasis() {
    suiteNodes.forEach(function (node) {
      var dim = false, hot = false;
      if (state.spotlight) dim = BUCKETS[node.bucket].cls !== state.spotlight;
      if (state.hoverTenant) {
        if (node.s.tenant === state.hoverTenant && node.bucket !== "vac") hot = true;
        else dim = true;
      }
      node.g.classList.toggle("dim", dim && !hot);
      node.g.classList.toggle("hot", hot);
    });
  }

  // ---------- tooltip ----------

  function statusText(s, asOf) {
    var b = bucketOf(s, asOf);
    if (b === "vac") return isRolled(s, asOf) ? "Vacant · rolled " + fmtMonthYear(s.end) : "Vacant";
    if (!s.end) return "Month-to-month";
    var m = monthsBetween(asOf, s.end);
    if (m < 1) return "Expires this month";
    if (m <= 18) return "Expires in " + Math.round(m) + " mo";
    return "Expires in " + (m / 12).toFixed(1) + " yrs";
  }

  function buildTooltip(node) {
    var s = node.s, asOf = state.asOf, b = node.bucket;
    var tt = els.tooltip;
    while (tt.firstChild) tt.removeChild(tt.firstChild);

    var vacant = b === "vac";
    tt.appendChild(el("div", "tt-name", vacant ? "Vacant" : s.tenant));
    var where = "Suite " + s.suite + " · Floor " + s.floor + (s.use ? " · " + s.use : "");
    tt.appendChild(el("div", "tt-where", where));

    function row(k, v) {
      var r = el("div", "tt-row");
      r.appendChild(el("span", "k", k));
      r.appendChild(el("span", "v", v));
      tt.appendChild(r);
    }
    row("Area", fmtInt(s.sqft) + " SF");
    if (!vacant && s.rentPsf != null) {
      row("Rent", "$" + s.rentPsf.toFixed(2) + "/SF");
      row("Annual", fmtMoney(s.annualRent));
    }
    if (!vacant && (s.start || s.end)) {
      row("Term", (s.start ? fmtMonthYear(s.start) : "—") + " → " + (s.end ? fmtMonthYear(s.end) : "MTM"));
    }
    if (vacant && isRolled(s, asOf)) {
      row("Prior tenant", s.tenant);
      row("Rolled", fmtMonthYear(s.end));
    }

    var st = el("div", "tt-status");
    st.appendChild(el("span", "dot " + BUCKETS[b].cls));
    st.appendChild(el("span", null, statusText(s, asOf)));
    tt.appendChild(st);
  }

  function moveTooltip(e) {
    var tt = els.tooltip;
    if (tt.hidden || !e) return;
    var pad = 14;
    var w = tt.offsetWidth, h = tt.offsetHeight;
    var x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
    tt.style.left = Math.max(8, x) + "px";
    tt.style.top = Math.max(8, y) + "px";
  }

  function placeTooltipAt(rect) {
    var tt = els.tooltip;
    var w = tt.offsetWidth, h = tt.offsetHeight;
    var x = rect.left + rect.width / 2 - w / 2;
    var y = rect.top - h - 10;
    if (y < 8) y = rect.bottom + 10;
    tt.style.left = Math.min(Math.max(8, x), window.innerWidth - w - 8) + "px";
    tt.style.top = Math.min(Math.max(8, y), window.innerHeight - h - 8) + "px";
  }

  function showTooltip(node, e) {
    buildTooltip(node);
    els.tooltip.hidden = false;
    if (e) moveTooltip(e);
    else placeTooltipAt(node.hit.getBoundingClientRect());
  }

  function hideTooltip() { els.tooltip.hidden = true; }

  function onSuiteHover(node, e) {
    if (state.pinnedSuite && state.pinnedSuite !== node) return;
    state.hoverTenant = node.bucket !== "vac" ? node.s.tenant : null;
    applyEmphasis();
    showTooltip(node, e);
  }

  function onSuiteFocus(node) {
    state.hoverTenant = node.bucket !== "vac" ? node.s.tenant : null;
    applyEmphasis();
    showTooltip(node, null);
  }

  function onSuiteLeave(node) {
    if (state.pinnedSuite === node) return;
    state.hoverTenant = null;
    applyEmphasis();
    if (!state.pinnedSuite) hideTooltip();
    else showTooltip(state.pinnedSuite, null);
  }

  function onSuitePin(node, e) {
    if (state.pinnedSuite === node) {
      state.pinnedSuite = null;
      state.hoverTenant = null;
      applyEmphasis();
      hideTooltip();
      return;
    }
    state.pinnedSuite = node;
    state.hoverTenant = node.bucket !== "vac" ? node.s.tenant : null;
    applyEmphasis();
    showTooltip(node, e || null);
  }

  function clearPin() {
    if (!state.pinnedSuite) return;
    state.pinnedSuite = null;
    state.hoverTenant = null;
    applyEmphasis();
    hideTooltip();
  }

  // ---------- KPI tiles ----------

  function renderKPIs() {
    var st = state.stats;
    var wrap = els.kpis;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    function tile(label, value, sub, opts) {
      var t = el("div", "tile");
      t.appendChild(el("div", "tile-label", label));
      var v = el("div", "tile-value", value);
      if (opts && opts.small) v.style.fontSize = "15px";
      t.appendChild(v);
      if (opts && opts.meter != null) {
        var m = el("div", "meter");
        var f = el("div", "meter-fill");
        f.style.width = (opts.meter * 100).toFixed(1) + "%";
        m.appendChild(f);
        t.appendChild(m);
      }
      if (sub) t.appendChild(el("div", "tile-sub", sub));
      wrap.appendChild(t);
      return t;
    }

    tile("Total RSF", fmtCompact(st.totalSF), st.suiteCount + " suites · " + st.floorCount + " floors");
    tile("Occupancy", (st.occPct * 100).toFixed(1) + "%", fmtCompact(st.occSF) + " SF leased", { meter: st.occPct });
    tile("WALT", st.walt.toFixed(1) + " yrs", "SF-weighted avg lease term");
    tile("Expiring ≤ 12 mo", fmtCompact(st.exp12) + " SF",
      (st.occSF ? (st.exp12 / st.occSF * 100).toFixed(1) : "0.0") + "% of leased" + (st.mtmSF ? " · incl. MTM" : ""));
    if (st.rent > 0) {
      tile("Annual rent", fmtMoney(st.rent), "$" + (st.rent / st.rentSF).toFixed(2) + "/SF avg");
    }
    if (st.topTenant) {
      tile("Top tenant", st.topTenant.name,
        fmtCompact(st.topTenant.sf) + " SF · " + (st.topTenant.sf / st.totalSF * 100).toFixed(0) + "% of building",
        { small: true });
    }
  }

  // ---------- legend ----------

  function renderLegend() {
    var st = state.stats;
    var wrap = els.legend;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    ["r0", "r1", "r2", "vac"].forEach(function (key) {
      var b = BUCKETS[key];
      var chip = el("button", "chip");
      chip.type = "button";
      chip.setAttribute("aria-pressed", state.spotlight === b.cls ? "true" : "false");
      chip.appendChild(el("span", "sw " + b.cls));
      chip.appendChild(el("span", null, b.label));
      chip.appendChild(el("span", "ct", fmtCompact(st.sfByBucket[key])));
      chip.addEventListener("click", function () {
        state.spotlight = state.spotlight === b.cls ? null : b.cls;
        renderLegend();
        applyEmphasis();
      });
      wrap.appendChild(chip);
    });
  }

  // ---------- rollover mini chart ----------

  function renderRollover() {
    var st = state.stats;
    var wrap = els.rollover;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    var y0 = state.asOf.getUTCFullYear();
    var rowsData = [];
    if (st.mtmSF > 0) rowsData.push({ label: "MTM", segs: { r0: st.mtmSF, r1: 0, r2: 0 }, total: st.mtmSF });
    for (var y = y0; y <= y0 + 9; y++) {
      var seg = st.rollover.get(y) || { r0: 0, r1: 0, r2: 0 };
      var total = seg.r0 + seg.r1 + seg.r2;
      rowsData.push({ label: String(y), segs: seg, total: total });
    }
    if (st.later.sf > 0) rowsData.push({ label: (y0 + 10) + "+", segs: { r0: 0, r1: 0, r2: st.later.sf }, total: st.later.sf });

    var max = Math.max.apply(null, rowsData.map(function (r) { return r.total; }));
    if (!max) { wrap.appendChild(el("div", "rr-empty", "No occupied leases at this date.")); return; }

    rowsData.forEach(function (r) {
      var row = el("div", "rr-row");
      row.appendChild(el("span", "rr-year", r.label));
      var track = el("div", "rr-track");
      ["r0", "r1", "r2"].forEach(function (k) {
        if (r.segs[k] > 0) {
          var seg = el("span", "rr-seg " + BUCKETS[k].cls);
          seg.style.width = Math.max(r.segs[k] / max * 100, 1) + "%";
          track.appendChild(seg);
        }
      });
      row.appendChild(track);
      row.appendChild(el("span", "rr-val", r.total ? fmtCompact(r.total) : "—"));
      row.title = r.label + ": " + fmtInt(r.total) + " SF expiring";
      wrap.appendChild(row);
    });
  }

  // ---------- rent roll table ----------

  function renderTable() {
    var tbody = els.tbody;
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    var asOf = state.asOf;

    state.floors.forEach(function (f) {
      f.suites.forEach(function (s) {
        var b = bucketOf(s, asOf);
        var vacant = b === "vac";
        var tr = document.createElement("tr");

        function td(text, cls) {
          var c = document.createElement("td");
          if (cls) c.className = cls;
          c.textContent = text;
          tr.appendChild(c);
          return c;
        }

        td(f.label);
        td(s.suite);
        var tn = document.createElement("td");
        if (vacant) tn.className = "vacant-cell";
        tn.appendChild(el("span", "dot " + BUCKETS[b].cls));
        tn.appendChild(document.createTextNode(vacant ? (isRolled(s, asOf) ? "Vacant (was " + s.tenant + ")" : "Vacant") : s.tenant));
        tr.appendChild(tn);
        td(fmtInt(s.sqft), "num");
        td(!vacant && s.rentPsf != null ? "$" + s.rentPsf.toFixed(2) : "—", "num");
        td(!vacant && s.annualRent != null ? "$" + fmtInt(s.annualRent) : "—", "num");
        td(!vacant && s.start ? fmtMonthYear(s.start) : "—");
        td(s.tenant && s.end ? fmtMonthYear(s.end) : (!vacant && s.tenant ? "MTM" : "—"));
        td(vacant ? "Vacant" : statusText(s, asOf).replace("Expires in ", ""));

        tbody.appendChild(tr);
      });
    });
  }

  // ---------- timeline ----------

  function setMonthIndex(idx, opts) {
    idx = Math.max(0, Math.min(HORIZON_MONTHS, idx));
    state.monthIndex = idx;
    state.asOf = addMonthsFromBase(state.baseDate, idx);
    if (els.slider.valueAsNumber !== idx) els.slider.value = idx;
    els.asofOut.textContent = idx === 0 ? "Today" : fmtMonthYear(state.asOf);

    state.stats = computeStats(state.asOf);
    updateRisk();
    renderKPIs();
    renderLegend();
    renderRollover();
    if (state.view === "table") renderTable();
    if (state.pinnedSuite) showTooltip(state.pinnedSuite, null);
  }

  function stopPlay() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    els.playBtn.textContent = "▶";
    els.playBtn.setAttribute("aria-label", "Play: scrub forward through time");
  }

  function togglePlay() {
    if (playTimer) { stopPlay(); return; }
    if (state.monthIndex >= HORIZON_MONTHS) setMonthIndex(0);
    els.playBtn.textContent = "❚❚";
    els.playBtn.setAttribute("aria-label", "Pause");
    playTimer = setInterval(function () {
      if (state.monthIndex >= HORIZON_MONTHS) { stopPlay(); return; }
      setMonthIndex(state.monthIndex + 1);
    }, 320);
  }

  // ---------- data loading ----------

  function loadData(csvText, name) {
    var model = buildModel(csvText, name); // throws on structural problems
    stopPlay();
    clearPin();
    state.name = model.name;
    state.suites = model.suites;
    state.floors = model.floors;
    state.issues = model.issues;
    state.baseDate = todayUTC();
    state.spotlight = null;
    state.hoverTenant = null;

    renderBuilding();
    setMonthIndex(0);
    renderTable();

    var totalSF = state.stats.totalSF;
    els.subtitle.textContent = state.name + " · " + fmtInt(totalSF) + " SF · " + state.floors.length + " floors";
    document.title = state.name + " — Stacking Plan";

    if (model.issues.length) {
      var msg = "Loaded " + state.suites.length + " suites. Skipped " + model.issues.length + " row" +
        (model.issues.length > 1 ? "s" : "") + ": " + model.issues.slice(0, 2).join("; ") +
        (model.issues.length > 2 ? "…" : "");
      toast(msg);
    }
  }

  function loadFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var base = file.name.replace(/\.[^.]*$/, "").replace(/[-_]+/g, " ").trim();
        loadData(String(reader.result), base || "Untitled building");
        toast("Loaded " + file.name);
      } catch (err) {
        toast("Couldn’t load CSV: " + err.message, true);
      }
    };
    reader.onerror = function () { toast("Couldn’t read the file.", true); };
    reader.readAsText(file);
  }

  var toastTimer = null;
  function toast(msg, isError) {
    var t = els.toast;
    t.textContent = msg;
    t.hidden = false;
    if (isError) t.style.background = "var(--c-crit)";
    else t.style.background = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 6000);
  }

  // ---------- export SVG ----------

  function exportSVGString() {
    var svg = els.svg;
    var clone = svg.cloneNode(true);
    var src = svg.querySelectorAll("*");
    var dst = clone.querySelectorAll("*");
    var props = ["fill", "stroke", "stroke-width", "opacity", "font-size", "font-weight", "font-family"];
    for (var i = 0; i < src.length; i++) {
      var cs = getComputedStyle(src[i]);
      for (var p = 0; p < props.length; p++) {
        var v = cs.getPropertyValue(props[p]);
        if (v) dst[i].setAttribute(props[p], v);
      }
      dst[i].removeAttribute("class");
      dst[i].removeAttribute("style");
      dst[i].removeAttribute("tabindex");
    }
    // hatch pattern line color resolves via computed style above; background:
    var bg = svgEl("rect", { x: 0, y: 0, width: "100%", height: "100%" });
    bg.setAttribute("fill", getComputedStyle(document.body).backgroundColor);
    clone.insertBefore(bg, clone.firstChild.nextSibling); // after <defs>
    clone.setAttribute("xmlns", SVG_NS);
    var vb = svg.getAttribute("viewBox").split(" ");
    clone.setAttribute("width", vb[2]);
    clone.setAttribute("height", vb[3]);
    return new XMLSerializer().serializeToString(clone);
  }

  function downloadSVG() {
    var s = exportSVGString();
    var blob = new Blob([s], { type: "image/svg+xml" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = state.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-stacking-plan.svg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // ---------- theme ----------

  function applyTheme(mode) {
    if (mode) document.documentElement.setAttribute("data-theme", mode);
    else document.documentElement.removeAttribute("data-theme");
    var dark = mode === "dark" || (!mode && matchMedia("(prefers-color-scheme: dark)").matches);
    els.themeBtn.textContent = dark ? "☀︎" : "☾";
    els.themeBtn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme");
    var dark = cur === "dark" || (!cur && matchMedia("(prefers-color-scheme: dark)").matches);
    var next = dark ? "light" : "dark";
    try { localStorage.setItem("spb-theme", next); } catch (e) { /* private mode */ }
    applyTheme(next);
  }

  // ---------- view toggle ----------

  function setView(v) {
    state.view = v;
    els.stackView.hidden = v !== "stack";
    els.tableView.hidden = v !== "table";
    els.viewStack.setAttribute("aria-selected", v === "stack" ? "true" : "false");
    els.viewTable.setAttribute("aria-selected", v === "table" ? "true" : "false");
    if (v === "table") renderTable();
  }

  // ---------- init ----------

  function init() {
    els.svg = $("stackSvg");
    els.subtitle = $("buildingName");
    els.slider = $("timeSlider");
    els.asofOut = $("asofOut");
    els.playBtn = $("playBtn");
    els.kpis = $("kpis");
    els.legend = $("legend");
    els.rollover = $("rolloverChart");
    els.tooltip = $("tooltip");
    els.toast = $("toast");
    els.tbody = $("rentRollBody");
    els.stackView = $("stackView");
    els.tableView = $("tableView");
    els.viewStack = $("viewStack");
    els.viewTable = $("viewTable");
    els.themeBtn = $("themeToggle");

    var stored = null;
    try { stored = localStorage.getItem("spb-theme"); } catch (e) { /* ignore */ }
    applyTheme(stored);
    els.themeBtn.addEventListener("click", toggleTheme);

    els.slider.max = HORIZON_MONTHS;
    els.slider.addEventListener("input", function () { stopPlay(); setMonthIndex(els.slider.valueAsNumber); });
    els.playBtn.addEventListener("click", togglePlay);
    $("resetBtn").addEventListener("click", function () { stopPlay(); setMonthIndex(0); });

    $("loadSampleBtn").addEventListener("click", function () {
      loadData(SAMPLE_CSV, SAMPLE_NAME);
      toast("Sample data loaded");
    });
    $("csvInput").addEventListener("change", function (e) {
      loadFile(e.target.files[0]);
      e.target.value = "";
    });
    $("exportBtn").addEventListener("click", downloadSVG);
    els.viewStack.addEventListener("click", function () { setView("stack"); });
    els.viewTable.addEventListener("click", function () { setView("table"); });

    // drag & drop CSV anywhere
    var dragDepth = 0;
    window.addEventListener("dragenter", function (e) {
      e.preventDefault(); dragDepth++;
      document.body.classList.add("dragging");
    });
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("dragleave", function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove("dragging");
    });
    window.addEventListener("drop", function (e) {
      e.preventDefault(); dragDepth = 0;
      document.body.classList.remove("dragging");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });

    document.addEventListener("click", function (e) {
      if (!e.target.closest || !e.target.closest(".suite")) clearPin();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { clearPin(); hideTooltip(); }
    });

    // expose for the export pipeline / tinkering
    window.StackingPlan = { loadData: loadData, exportSVGString: exportSVGString, state: state };

    loadData(SAMPLE_CSV, SAMPLE_NAME);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
