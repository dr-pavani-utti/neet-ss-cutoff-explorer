// NEET SS Cutoff Explorer — static, no backend. Loads docs/data/<year>.json and does everything client-side.

const SAFE = 1.2;   // closing rank ≥ 120% of your rank
const REACH = 0.85; // closing rank ≥ 85% of your rank (a stretch)
// Tab order; the first entry is the landing view.
const VIEWS = [
  ["states", "State map"],
  ["cutoffs", "Cutoff table"],
  ["predict", "Rank predictor"],
  ["specialities", "Speciality ladder"],
  ["trends", "Year-on-year"],
  ["rank", "Rank lookup"],
  ["about", "About data"],
];
const ROUND_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)"];

const app = { index: null, years: {}, data: null, model: null, view: VIEWS[0][0], p: {} };

// ------------------------------------------------------------------ utilities

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n == null ? "–" : n.toLocaleString("en-IN"));
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

const groupLabel = (g) =>
  g.replace(/ GROUP$/i, "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bAnd\b/g, "&").replace(/\bEnt\b/, "ENT");

// ------------------------------------------------------------------ model

function buildModel(d) {
  const nRounds = d.rounds.length;
  const seatMap = new Map();
  const groupMax = new Map();
  const byGroupRank = new Map(); // `${round}|${group}|${rank}` -> allotment index
  d.allotments.forEach((a, i) => {
    const [r, g, rank, inst, course, quota, cat] = a;
    byGroupRank.set(`${r}|${g}|${rank}`, i);
    groupMax.set(g, Math.max(groupMax.get(g) || 0, rank));
    const k = `${g}|${inst}|${course}|${quota}|${cat}`;
    let s = seatMap.get(k);
    if (!s) {
      const [degree, spec] = d.courses[course];
      const [instName, state, address] = d.institutes[inst];
      s = {
        g, group: d.groups[g], inst, instName, state, address, course, degree, spec,
        quota: d.quotas[quota], cat: d.categories[cat],
        ranks: Array.from({ length: nRounds }, () => []),
        xkey: crossYearKey(d.groups[g], degree, spec, address, d.quotas[quota], d.categories[cat]),
      };
      seatMap.set(k, s);
    }
    s.ranks[r].push(rank);
  });
  const seats = [...seatMap.values()];
  for (const s of seats) {
    s.ranks.forEach((list) => list.sort((x, y) => x - y));
    s.close = s.ranks.map((l) => (l.length ? l[l.length - 1] : null));
    s.open = s.ranks.map((l) => (l.length ? l[0] : null));
    s.best = Math.max(...s.close.filter((c) => c != null));
  }
  const byX = new Map(seats.map((s) => [s.xkey, s]));
  const groupsBySize = d.groups
    .map((name, g) => ({ name, g, n: d.allotments.filter((a) => a[1] === g).length }))
    .sort((a, b) => b.n - a.n);
  const uniq = (f) => [...new Set(seats.map(f))].sort();
  return {
    data: d, seats, byX, groupMax, byGroupRank, groupsBySize, nRounds,
    degrees: uniq((s) => s.degree), states: uniq((s) => s.state), specs: uniq((s) => s.spec),
    quotas: d.quotas, categories: d.categories.filter(Boolean),
  };
}

// Same identity rule as scripts/build_data.py: institute name (before the first comma) + last PIN code.
function crossYearKey(group, degree, spec, address, quota, cat) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const pins = address.match(/(?<!\d)\d{6}(?!\d)/g);
  const inst = norm(address.split(",")[0]) + (pins ? pins[pins.length - 1] : "");
  return [group, degree, norm(spec), inst, quota, cat].join("|");
}

const groupIndex = (model = app.model) => (app.p.g ? model.data.groups.indexOf(app.p.g) : -1);
const myRank = () => {
  const r = parseInt(app.p.rank, 10);
  return r > 0 ? r : null;
};
const roundIndex = (id) => app.data.rounds.findIndex((r) => r.id === id);

function filteredSeats({ needGroup = true, model = app.model, ignoreState = false } = {}) {
  const p = app.p;
  const g = groupIndex(model);
  const q = (p.q || "").trim().toLowerCase();
  if (needGroup && p.g && g < 0) return [];
  return model.seats.filter(
    (s) =>
      (!needGroup || g < 0 || s.g === g) &&
      (!p.deg || s.degree === p.deg) &&
      (!p.spec || s.spec === p.spec) &&
      (ignoreState || !p.state || s.state === p.state) &&
      (!p.quota || s.quota === p.quota) &&
      (!p.cat || s.cat === p.cat) &&
      (!q || s.instName.toLowerCase().includes(q) || s.spec.toLowerCase().includes(q) || s.address.toLowerCase().includes(q)),
  );
}

// ------------------------------------------------------------------ routing & state

function readHash() {
  const [view, query] = location.hash.replace(/^#\/?/, "").split("?");
  app.view = VIEWS.some(([v]) => v === view) ? view : VIEWS[0][0];
  const p = Object.fromEntries(new URLSearchParams(query || ""));
  const saved = JSON.parse(localStorage.getItem("neetss.profile") || "{}");
  app.p = { ...saved, ...p };
}

function writeHash() {
  const clean = Object.fromEntries(Object.entries(app.p).filter(([, v]) => v !== "" && v != null));
  const qs = new URLSearchParams(clean).toString();
  history.replaceState(null, "", `#${app.view}${qs ? "?" + qs : ""}`);
  localStorage.setItem("neetss.profile", JSON.stringify({ year: app.p.year, g: app.p.g, rank: app.p.rank }));
}

function setParam(changes, { full = false } = {}) {
  Object.assign(app.p, changes);
  writeHash();
  if (full) render();
  else renderResults();
}

// ------------------------------------------------------------------ controls

function selectCtl(label, param, options, { all = "All", onchange } = {}) {
  const sel = h(
    "select",
    { onchange: (e) => (onchange ? onchange(e.target.value) : setParam({ [param]: e.target.value })) },
    all != null ? h("option", { value: "" }, all) : null,
    options.map(([v, l]) => h("option", { value: v, selected: String(app.p[param] ?? "") === String(v) }, l)),
  );
  return h("label", { class: "ctl" }, h("span", {}, label), sel);
}

function inputCtl(label, param, attrs = {}) {
  let timer;
  const input = h("input", {
    value: app.p[param] || "",
    ...attrs,
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => setParam({ [param]: e.target.value }), 180);
    },
  });
  return h("label", { class: "ctl" }, h("span", {}, label), input);
}

const groupOptions = () => app.model.groupsBySize.map(({ name }) => [name, groupLabel(name)]);
const roundOptions = () => app.data.rounds.map((r) => [r.id, r.label]);

function filterBar({ round = false, anyRound = false, search = true, spec = true } = {}) {
  const m = app.model;
  return h(
    "div",
    { class: "filters" },
    round ? selectCtl("Round", "round", [...roundOptions(), ...(anyRound ? [["any", "Best of all rounds"]] : [])], { all: null }) : null,
    selectCtl("Degree", "deg", m.degrees.map((d) => [d, d])),
    spec ? selectCtl("Speciality", "spec", specsForGroup().map((s) => [s, s])) : null,
    selectCtl("State", "state", m.states.map((s) => [s, s])),
    m.quotas.length > 1 ? selectCtl("Quota", "quota", m.quotas.map((q) => [q, q])) : null,
    m.categories.length > 1 ? selectCtl("Category", "cat", m.categories.map((c) => [c, c])) : null,
    search ? inputCtl("Search", "q", { type: "search", placeholder: "Institute, city, speciality…" }) : null,
  );
}

function specsForGroup() {
  const g = groupIndex();
  return [...new Set(app.model.seats.filter((s) => g < 0 || s.g === g).map((s) => s.spec))].sort();
}

function renderProfile() {
  const el = $("#profile");
  el.replaceChildren(
    selectCtl("Year", "year", app.index.years.map((y) => [y.year, y.year]), {
      all: null,
      onchange: async (v) => {
        app.p.year = v;
        writeHash();
        await loadYear(v);
        render();
      },
    }),
    selectCtl("Your exam group", "g", groupOptions(), {
      all: "Choose group…",
      onchange: (v) => setParam({ g: v, spec: "" }, { full: true }),
    }),
    inputCtl("Your rank", "rank", { type: "number", min: 1, inputmode: "numeric", placeholder: "e.g. 850" }),
  );
}

// ------------------------------------------------------------------ render shell

function render() {
  $("#tabs").replaceChildren(
    ...VIEWS.map(([id, label]) =>
      h("a", { href: `#${id}`, class: id === app.view ? "active" : "", onclick: (e) => { e.preventDefault(); app.view = id; writeHash(); render(); } }, label),
    ),
  );
  renderProfile();
  const view = $("#view");
  const def = RENDERERS[app.view];
  view.replaceChildren(h("section", { class: "head" }, h("h2", {}, def.title), h("p", { class: "lede" }, def.lede)), def.controls ? def.controls() : "", h("div", { id: "results" }));
  renderResults();
}

function renderResults() {
  const box = $("#results");
  if (!box) return;
  box.replaceChildren(RENDERERS[app.view].results());
}

function needGroup(msg = "Pick your exam group (top right) to see this view.") {
  return h("div", { class: "empty" }, h("strong", {}, "Choose a group"), h("p", {}, msg), h("p", { class: "muted" }, "NEET SS ranks are issued per group, so a rank only means something within its group."));
}

// ------------------------------------------------------------------ view: predictor

function chance(close, rank) {
  if (close == null) return null;
  if (close >= rank * SAFE) return "safe";
  if (close >= rank) return "likely";
  if (close >= rank * REACH) return "reach";
  return null;
}
const CHANCE_LABEL = { safe: "Safe", likely: "Likely", reach: "Reach" };

function predictResults() {
  const rank = myRank();
  if (groupIndex() < 0 || !rank) {
    return needGroup("Enter your exam group and rank (top right). You'll get every seat whose closing rank was at or beyond yours.");
  }
  const roundSel = app.p.round || app.data.rounds[0].id;
  const r = roundIndex(roundSel);
  const rows = [];
  for (const s of filteredSeats()) {
    const close = r >= 0 ? s.close[r] : s.best;
    const c = chance(close, rank);
    if (c) rows.push({ s, close, c, past: pastYears(s, r, rank) });
  }
  rows.sort((a, b) => a.close - b.close);
  const withPast = rows.filter((x) => x.past.some((p) => p.close != null));
  const steady = withPast.filter((x) => x.past.every((p) => p.close == null || p.c)).length;
  const counts = { safe: 0, likely: 0, reach: 0 };
  rows.forEach((x) => counts[x.c]++);
  const bySpec = new Map();
  rows.filter((x) => x.c !== "reach").forEach(({ s }) => bySpec.set(`${s.degree} ${s.spec}`, (bySpec.get(`${s.degree} ${s.spec}`) || 0) + 1));
  const specChips = [...bySpec.entries()].sort((a, b) => b[1] - a[1]);
  const max = app.model.groupMax.get(groupIndex());

  return h(
    "div",
    {},
    h(
      "div",
      { class: "cards" },
      card("Safe", counts.safe, `closing rank ≥ ${Math.round(rank * SAFE)}`, "safe"),
      card("Likely", counts.likely, `closed between ${rank} and ${Math.round(rank * SAFE) - 1}`, "likely"),
      card("Reach", counts.reach, `closed ${Math.ceil(rank * REACH)}–${rank - 1}; needs luck`, "reach"),
      card("Your position", `${pct(rank, max)}%`, `of the ${fmt(max)} ranks that got any seat in this group`, ""),
      app.index.years.length > 1
        ? card("Consistent", steady, `of ${withPast.length} seats that also existed in other years reached your rank every year`, "safe")
        : null,
    ),
    specChips.length
      ? h("div", { class: "chips" }, h("span", { class: "muted" }, "Safe + likely seats by speciality:"), specChips.slice(0, 18).map(([name, n]) => h("span", { class: "chip" }, name, h("b", {}, n))))
      : null,
    rows.length
      ? seatTable(rows, { rank, max, showChance: true, history: true })
      : h("div", { class: "empty" }, h("strong", {}, "No seat closed at or beyond this rank"), h("p", {}, "Try “Best of all rounds” or remove filters: stray-round seats often go to much later ranks.")),
  );
}

function card(title, value, note, tone) {
  return h("div", { class: `card ${tone}` }, h("span", { class: "card-title" }, title), h("strong", {}, value), h("small", {}, note));
}

// The same course × institute in every other loaded year, at the same round position (or best round when r < 0).
function pastYears(s, r, rank) {
  return app.index.years
    .filter((y) => y.year !== app.data.year && app.years[y.year])
    .map(({ year }) => {
      const other = app.years[year].model.byX.get(s.xkey);
      const close = other ? (r >= 0 ? other.close[r] : other.best) : null;
      return { year, close, c: close != null ? chance(close, rank) : null };
    });
}

// Seat table shared by predictor and cutoff views.
function seatTable(rows, { rank = null, max, showChance = false, history = false, limit = 400 } = {}) {
  const rounds = app.data.rounds;
  const sortKey = app.p.sort || (showChance ? "" : "spec");
  const dir = app.p.dir === "desc" ? -1 : 1;
  const keyed = {
    spec: (x) => `${x.s.spec} ${x.s.degree}`,
    inst: (x) => x.s.instName,
    state: (x) => x.s.state,
    ...Object.fromEntries(rounds.map((r, i) => [r.id, (x) => x.s.close[i] ?? Infinity])),
  };
  if (keyed[sortKey]) {
    const f = keyed[sortKey];
    rows = [...rows].sort((a, b) => {
      const va = f(a), vb = f(b);
      const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return c * dir || (a.s.close[0] ?? 1e9) - (b.s.close[0] ?? 1e9);
    });
  }
  const th = (k, label, cls = "") =>
    h("th", { class: `${cls} sortable ${sortKey === k ? "sorted " + (dir < 0 ? "desc" : "asc") : ""}`, onclick: () => setParam({ sort: k, dir: sortKey === k && dir > 0 ? "desc" : "asc" }) }, label);
  const shown = app.p.all ? rows : rows.slice(0, limit);
  const table = h(
    "table",
    { class: "seats" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        showChance ? h("th", {}, "Chance") : null,
        th("spec", "Course"),
        th("inst", "Institute"),
        th("state", "State"),
        rounds.map((r) => th(r.id, r.label, "num")),
        h("th", { class: "gauge-h" }, rank ? "Your rank vs allotted range" : "Allotted rank range"),
        history ? h("th", {}, "Same seat, other years") : null,
      ),
    ),
    h(
      "tbody",
      {},
      shown.map(({ s, c, past }) =>
        h(
          "tr",
          {},
          showChance ? h("td", {}, h("span", { class: `badge ${c}` }, CHANCE_LABEL[c])) : null,
          h("td", {}, h("span", { class: `deg deg-${s.degree.replace(/\W/g, "")}` }, s.degree), " ", s.spec, s.quota !== "All India" ? h("span", { class: "tag" }, s.quota) : null, s.cat ? h("span", { class: "tag" }, s.cat) : null),
          h("td", { class: "inst", title: s.address }, s.instName),
          h("td", {}, s.state),
          rounds.map((_, i) => h("td", { class: "num" }, s.close[i] == null ? h("span", { class: "muted" }, "–") : h("span", { title: `${s.ranks[i].length} seat(s); opening ${fmt(s.open[i])}` }, fmt(s.close[i]), h("small", {}, ` ×${s.ranks[i].length}`)))),
          h("td", { class: "gauge", html: gaugeSvg(s, rank, max) }),
          history ? h("td", { class: "past" }, past.map((p) => h("span", { class: `yr ${p.close == null ? "none" : p.c || "miss"}`, title: p.close == null ? `${p.year}: seat not filled in this round` : `${p.year}: closed at ${fmt(p.close)}` }, `’${p.year.slice(2)} `, h("b", {}, p.close == null ? "–" : fmt(p.close))))) : null,
        ),
      ),
    ),
  );
  return h(
    "div",
    {},
    h("div", { class: "table-meta" }, h("span", {}, `${fmt(rows.length)} seats (course × institute)`), h("button", { class: "link", onclick: () => downloadCsv(rows) }, "Download CSV")),
    h("div", { class: "scroll" }, table),
    rows.length > shown.length ? h("button", { class: "more", onclick: () => setParam({ all: "1" }) }, `Show all ${fmt(rows.length)} rows`) : null,
  );
}

// Inline SVG: each round's allotted range as a bar on a shared 0..groupMax axis, plus your rank.
function gaugeSvg(s, rank, max) {
  const W = 160, rowH = 6, n = s.ranks.length;
  const x = (v) => (v / max) * W;
  let out = `<svg viewBox="0 0 ${W} ${n * rowH + 4}" width="${W}" height="${n * rowH + 4}" aria-hidden="true">`;
  s.ranks.forEach((list, i) => {
    if (!list.length) return;
    const y = 2 + i * rowH;
    out += `<rect x="${x(list[0])}" y="${y}" width="${Math.max(2, x(list[list.length - 1]) - x(list[0]))}" height="${rowH - 2}" rx="2" fill="${ROUND_COLORS[i]}" opacity=".85"/>`;
  });
  if (rank) out += `<line x1="${x(rank)}" x2="${x(rank)}" y1="0" y2="${n * rowH + 4}" stroke="var(--fg)" stroke-width="1.5"/>`;
  return out + "</svg>";
}

function downloadCsv(rows) {
  const rounds = app.data.rounds;
  const head = ["Group", "Degree", "Speciality", "Institute", "State", "Quota", ...rounds.flatMap((r) => [`${r.label} closing`, `${r.label} opening`, `${r.label} seats`]), "Address"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(",")];
  for (const { s } of rows) {
    lines.push([s.group, s.degree, s.spec, s.instName, s.state, s.quota, ...rounds.flatMap((_, i) => [s.close[i], s.open[i], s.ranks[i].length || ""]), s.address].map(q).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `neet-ss-${app.data.year}-cutoffs.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ view: cutoff table

function cutoffResults() {
  const rows = filteredSeats().map((s) => ({ s }));
  const g = groupIndex();
  const max = g >= 0 ? app.model.groupMax.get(g) : Math.max(...app.model.groupMax.values());
  if (!rows.length) return h("div", { class: "empty" }, h("strong", {}, "Nothing matches these filters"));
  return seatTable(rows, { rank: myRank() && g >= 0 ? myRank() : null, max });
}

// ------------------------------------------------------------------ view: speciality ladder

function specialityResults() {
  const g = groupIndex();
  if (g < 0) return needGroup();
  const r = Math.max(0, roundIndex(app.p.round || app.data.rounds[0].id));
  const buckets = new Map();
  for (const s of filteredSeats()) {
    const list = s.ranks[r];
    if (!list.length) continue;
    const k = `${s.degree}|${s.spec}`;
    if (!buckets.has(k)) buckets.set(k, { degree: s.degree, spec: s.spec, ranks: [], seats: 0 });
    const b = buckets.get(k);
    b.ranks.push(...list);
    b.seats++;
  }
  const rows = [...buckets.values()].map((b) => {
    b.ranks.sort((x, y) => x - y);
    return { ...b, med: quantile(b.ranks, 0.5), q1: quantile(b.ranks, 0.25), q3: quantile(b.ranks, 0.75), close: b.ranks[b.ranks.length - 1] };
  });
  if (!rows.length) return h("div", { class: "empty" }, h("strong", {}, "No allotments for these filters in this round"));
  rows.sort((a, b) => a.med - b.med);
  const max = app.model.groupMax.get(g);
  const rank = myRank();
  const L = 270, W = 980, rowH = 30, top = 30, plotW = W - L - 70;
  const x = (v) => L + (v / max) * plotW;
  const H = top + rows.length * rowH + 10;
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Allotted rank distribution per speciality">`;
  const ticks = niceTicks(max, 6);
  for (const t of ticks) svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 10}" class="grid"/><text x="${x(t)}" y="${top - 12}" class="tick" text-anchor="middle">${fmt(t)}</text>`;
  rows.forEach((row, i) => {
    const y = top + i * rowH + rowH / 2;
    const tip = `${row.degree} ${row.spec}: ${row.ranks.length} allotments at ${row.seats} institutes · best ${fmt(row.ranks[0])} · median ${fmt(row.med)} · closing ${fmt(row.close)}`;
    svg += `<g class="row" data-tip="${esc(tip)}"><rect x="0" y="${y - rowH / 2}" width="${W}" height="${rowH}" class="hit"/>`;
    svg += `<text x="${L - 10}" y="${y + 4}" text-anchor="end" class="label">${esc(row.spec)} <tspan class="deg-t">${esc(row.degree)}</tspan></text>`;
    svg += `<rect x="${x(row.q1)}" y="${y - 8}" width="${Math.max(2, x(row.q3) - x(row.q1))}" height="16" rx="4" class="iqr"/>`;
    row.ranks.forEach((v) => {
      const jitter = ((Math.imul(v, 2654435761) >>> 0) % 13) - 6;
      svg += `<circle cx="${x(v).toFixed(1)}" cy="${(y + jitter).toFixed(1)}" r="2.2" class="dot"/>`;
    });
    svg += `<line x1="${x(row.med)}" x2="${x(row.med)}" y1="${y - 10}" y2="${y + 10}" class="median"/>`;
    svg += `<text x="${x(row.close) + 6}" y="${y + 4}" class="close">${fmt(row.close)}</text></g>`;
  });
  if (rank) svg += `<line x1="${x(rank)}" x2="${x(rank)}" y1="${top - 6}" y2="${H - 10}" class="you"/><text x="${x(rank)}" y="${H - 1}" text-anchor="middle" class="you-t">you · ${fmt(rank)}</text>`;
  svg += "</svg>";
  return h(
    "div",
    {},
    h("div", { class: "legend" }, legendItem("dot", "one allotted candidate"), legendItem("iqr", "middle 50% of allotted ranks"), legendItem("median", "median"), h("span", {}, "number = closing rank"), rank ? legendItem("you", "your rank") : null),
    h("div", { class: "chart-wrap", html: svg }),
    h("p", { class: "muted small" }, "Sorted by median allotted rank: the higher a course sits, the earlier its seats go. Hover a row for numbers."),
  );
}

function legendItem(cls, label) {
  return h("span", { class: "lg" }, h("i", { class: `lg-${cls}` }), label);
}

function niceTicks(max, count) {
  const step0 = max / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

// ------------------------------------------------------------------ view: year-on-year

const ROUND_POS = [["0", "Round 1"], ["1", "Round 2"], ["2", "Last round (stray / special)"]];

function trendsResults() {
  const years = [...app.index.years].map((y) => y.year).filter((y) => app.years[y]).sort();
  if (years.length < 2) return h("div", { class: "empty" }, h("strong", {}, "Only one year loaded"));
  if (!app.p.g) return needGroup("Pick a group to compare the same courses and seats across years.");
  const pos = Number(app.p.rpos || 0);
  const rank = myRank();
  const models = years.map((y) => app.years[y].model);
  const perYear = models.map((model) => filteredSeats({ model }));
  const roundName = (y) => app.years[y].data.rounds[Math.min(pos, app.years[y].data.rounds.length - 1)].label;

  // Speciality level: every allotted rank in that round position, per year.
  const specs = new Map();
  perYear.forEach((seats, yi) => {
    for (const s of seats) {
      const list = s.ranks[pos] || [];
      if (!list.length) continue;
      const k = `${s.degree}|${s.spec}`;
      if (!specs.has(k)) specs.set(k, { degree: s.degree, spec: s.spec, ranks: years.map(() => []) });
      specs.get(k).ranks[yi].push(...list);
    }
  });
  const specRows = [...specs.values()].map((row) => {
    const stats = row.ranks.map((l) => {
      l.sort((a, b) => a - b);
      return l.length ? { n: l.length, med: quantile(l, 0.5), close: l[l.length - 1] } : null;
    });
    return { ...row, stats };
  });
  const latest = years.length - 1;
  specRows.sort((a, b) => (a.stats[latest]?.med ?? 1e9) - (b.stats[latest]?.med ?? 1e9));

  // Seat level: same course × institute across years.
  const seatRows = new Map();
  perYear.forEach((seats, yi) => {
    for (const s of seats) {
      if (!s.ranks[pos]?.length) continue;
      if (!seatRows.has(s.xkey)) seatRows.set(s.xkey, { s, close: years.map(() => null), n: years.map(() => 0) });
      const row = seatRows.get(s.xkey);
      row.s = s; // newest year's naming wins
      row.close[yi] = s.close[pos];
      row.n[yi] = s.ranks[pos].length;
    }
  });
  const seatList = [...seatRows.values()].sort((a, b) => (a.close[latest] ?? 1e9) - (b.close[latest] ?? 1e9));
  const shown = app.p.all ? seatList : seatList.slice(0, 300);
  const delta = (vals) => {
    const known = vals.filter((v) => v != null);
    if (known.length < 2) return h("span", { class: "muted" }, "–");
    const dlt = known[known.length - 1] - known[0];
    return h("span", { class: dlt > 0 ? "up" : dlt < 0 ? "down" : "muted", title: "latest minus earliest closing rank" }, `${dlt > 0 ? "+" : ""}${fmt(dlt)}`);
  };
  const cell = (v, n) => (v == null ? h("span", { class: "muted" }, "–") : h("span", { class: rank ? (v >= rank ? "hit" : "") : "" }, fmt(v), h("small", {}, ` ×${n}`)));

  const reachCards = rank
    ? h("div", { class: "cards" }, years.map((y, yi) => {
        const seats = perYear[yi].filter((s) => s.close[pos] != null);
        const ok = seats.filter((s) => s.close[pos] >= rank).length;
        return card(`${y} · ${roundName(y)}`, fmt(ok), `of ${fmt(seats.length)} seats closed at or after rank ${fmt(rank)}`, ok ? "likely" : "reach");
      }))
    : null;

  return h(
    "div",
    {},
    reachCards,
    h("h3", {}, "Speciality trend"),
    h("p", { class: "muted small" }, "Median and closing allotted rank per year. Sparkline shows the closing rank (higher point = closed at a later rank, so easier that year)."),
    h("div", { class: "scroll" }, h("table", { class: "seats" },
      h("thead", {}, h("tr", {}, h("th", {}, "Course"), years.map((y) => h("th", { class: "num" }, `${y} median / closing`)), h("th", {}, "Closing trend"), h("th", { class: "num" }, "Change"))),
      h("tbody", {}, specRows.map((row) => h("tr", {},
        h("td", {}, h("span", { class: `deg deg-${row.degree.replace(/\W/g, "")}` }, row.degree), " ", row.spec),
        row.stats.map((st) => h("td", { class: "num" }, st ? [fmt(st.med), h("span", { class: "muted" }, " / "), h("span", { class: rank && st.close >= rank ? "hit" : "" }, fmt(st.close)), h("small", {}, ` ×${st.n}`)] : h("span", { class: "muted" }, "–"))),
        h("td", { html: sparkline(row.stats.map((st) => st?.close ?? null), years, rank) }),
        h("td", { class: "num" }, delta(row.stats.map((st) => st?.close ?? null))),
      ))),
    )),
    h("h3", {}, "Same seat, year by year"),
    h("p", { class: "muted small" }, `Closing rank of each course × institute in ${ROUND_POS[pos][1]}, matched across years by institute name and PIN code.${rank ? " Highlighted = closed at or after your rank." : ""}`),
    h("div", { class: "table-meta" }, h("span", {}, `${fmt(seatList.length)} seats`)),
    h("div", { class: "scroll" }, h("table", { class: "seats" },
      h("thead", {}, h("tr", {}, h("th", {}, "Course"), h("th", {}, "Institute"), h("th", {}, "State"), years.map((y) => h("th", { class: "num" }, y)), h("th", { class: "num" }, "Change"))),
      h("tbody", {}, shown.map(({ s, close, n }) => h("tr", {},
        h("td", {}, h("span", { class: `deg deg-${s.degree.replace(/\W/g, "")}` }, s.degree), " ", s.spec),
        h("td", { class: "inst", title: s.address }, s.instName),
        h("td", {}, s.state),
        close.map((v, yi) => h("td", { class: "num" }, cell(v, n[yi]))),
        h("td", { class: "num" }, delta(close)),
      ))),
    )),
    seatList.length > shown.length ? h("button", { class: "more", onclick: () => setParam({ all: "1" }) }, `Show all ${fmt(seatList.length)} rows`) : null,
  );
}

function sparkline(vals, years, rank) {
  const W = 110, H = 30, pad = 4;
  const known = vals.filter((v) => v != null);
  if (!known.length) return "";
  const lo = Math.min(...known, rank || Infinity), hi = Math.max(...known, rank || 0);
  const x = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, vals.length - 1);
  const y = (v) => H - pad - ((v - lo) / Math.max(1, hi - lo)) * (H - 2 * pad);
  let path = "";
  vals.forEach((v, i) => { if (v != null) path += `${path ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="spark">`;
  if (rank && rank >= lo && rank <= hi) svg += `<line x1="0" x2="${W}" y1="${y(rank)}" y2="${y(rank)}" class="spark-you"/>`;
  svg += `<path d="${path}" class="spark-line"/>`;
  vals.forEach((v, i) => { if (v != null) svg += `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" class="spark-dot"><title>${years[i]}: ${fmt(v)}</title></circle>`; });
  return svg + "</svg>";
}

// ------------------------------------------------------------------ view: state map

// Simplified state boundaries (scripts/build_map.py); fetched the first time the view opens.
let indiaMap = null;
function loadIndiaMap() {
  indiaMap ||= fetch("assets/india-map.json").then((r) => r.json()).then((m) => (indiaMap = m) && renderResults());
  return indiaMap;
}

function stateResults() {
  if (!indiaMap || indiaMap instanceof Promise) {
    loadIndiaMap();
    return h("p", { class: "loading" }, "Loading map…");
  }
  const r = Math.max(0, roundIndex(app.p.round || app.data.rounds[0].id));
  const rank = myRank();
  const g = groupIndex();
  const metric = app.p.metric || (rank && g >= 0 ? "reach" : "seats");
  const stats = new Map();
  // The map always shows every state; the State filter only highlights one.
  for (const s of filteredSeats({ ignoreState: true })) {
    const list = s.ranks[r];
    if (!list.length) continue;
    const st = stats.get(s.state) || { seats: 0, ranks: [], reach: 0, inst: new Set() };
    st.seats += list.length;
    st.ranks.push(...list);
    st.inst.add(s.inst);
    if (rank) st.reach += list.filter((v) => v >= rank).length;
    stats.set(s.state, st);
  }
  for (const st of stats.values()) { st.ranks.sort((a, b) => a - b); st.median = quantile(st.ranks, 0.5); }
  const value = (st) => (metric === "median" ? st.median : st[metric]);
  const vals = [...stats.values()].map(value);
  const vmax = Math.max(1, ...vals), vmin = Math.min(...vals);
  // Median: lower rank = more competitive = darker.
  const shade = (v) => 0.12 + 0.88 * (metric === "median" ? 1 - (v - vmin) / Math.max(1, vmax - vmin) : v / vmax);
  const tipFor = (name, st) => (st ? `${name}: ${fmt(st.seats)} seats at ${st.inst.size} institutes · median allotted rank ${fmt(st.median)}${rank ? ` · ${fmt(st.reach)} closed at/after your rank` : ""}` : `${name}: no seats for these filters`);

  const { width: W, height: H, states } = indiaMap;
  const SMALL = 150; // map units²: too small to see or click, drawn as a marker instead
  let shapes = "", markers = "", labels = "";
  for (const [name, shape] of Object.entries(states)) {
    const st = stats.get(name);
    const sel = app.p.state === name ? " selected" : "";
    const fill = st ? `fill="var(--accent)" fill-opacity="${shade(value(st)).toFixed(2)}" class="state${sel}"` : `class="state empty-state"`;
    shapes += `<path d="${shape.d}" ${fill} data-state="${esc(name)}" data-tip="${esc(tipFor(name, st))}"/>`;
    if (!st) continue;
    if (shape.area < SMALL) {
      markers += `<circle cx="${shape.x}" cy="${shape.y}" r="7" class="marker-bg"/><circle cx="${shape.x}" cy="${shape.y}" r="7" fill="var(--accent)" fill-opacity="${shade(value(st)).toFixed(2)}" class="state marker${sel}" data-state="${esc(name)}" data-tip="${esc(tipFor(name, st))}"/>`;
    } else if (shape.area > 900) {
      const dark = shade(value(st)) > 0.55 ? " on" : "";
      labels += `<text x="${shape.x}" y="${shape.y + 4}" text-anchor="middle" class="map-v${dark}">${fmt(value(st))}</text>`;
    }
  }
  const svg = `<svg viewBox="-4 -4 ${W + 8} ${H + 8}" class="chart india" role="img" aria-label="India map shaded by ${metric}">${shapes}${markers}${labels}</svg>`;

  const list = [...stats.entries()].sort((a, b) => value(b[1]) - value(a[1]));
  if (metric === "median") list.reverse();
  const pick = (name) => setParam({ state: app.p.state === name ? "" : name, sort: "" }, { full: true });
  const caption = metric === "median"
    ? "Darker = lower median allotted rank = more competitive."
    : metric === "reach" ? `Seats in ${app.data.rounds[r].label} that went to rank ${fmt(rank)} or later. Darker = more options for you.` : "Darker = more seats filled.";
  return h("div", {},
    h("p", { class: "muted small" }, caption, " Click a state to select it; click again to clear. Small UTs are shown as dots."),
    h("div", { class: "map-layout" },
      h("div", { class: "chart-wrap map" },
        h("div", { html: svg, onclick: (e) => { const st = e.target.closest("[data-state]")?.dataset.state; if (st && stats.has(st)) pick(st); } }),
        h("div", { class: "scale" }, h("span", {}, fmt(metric === "median" ? vmax : 0)), h("i", {}), h("span", {}, fmt(metric === "median" ? vmin : vmax)))),
      h("div", { class: "scroll" }, h("table", { class: "seats compact" },
        h("thead", {}, h("tr", {}, h("th", {}, "State"), h("th", { class: "num" }, "Seats"), h("th", { class: "num" }, "Institutes"), h("th", { class: "num" }, "Median rank"), rank ? h("th", { class: "num" }, "Within reach") : null)),
        h("tbody", {}, list.map(([name, st]) => h("tr", { class: `click${app.p.state === name ? " me" : ""}`, onclick: () => pick(name) }, h("td", {}, name), h("td", { class: "num" }, fmt(st.seats)), h("td", { class: "num" }, st.inst.size), h("td", { class: "num" }, fmt(st.median)), rank ? h("td", { class: "num" }, fmt(st.reach)) : null))),
      )),
    ),
    app.p.state && stats.has(app.p.state) ? stateSeats(app.p.state, r, rank) : null,
  );
}

// Seats in the selected state, so a click on the map leads straight to institutes.
function stateSeats(state, r, rank) {
  const rows = filteredSeats().filter((s) => s.ranks[r].length).sort((a, b) => b.close[r] - a.close[r]).map((s) => ({ s }));
  const g = groupIndex();
  const max = g >= 0 ? app.model.groupMax.get(g) : Math.max(...app.model.groupMax.values());
  return h("div", {}, h("h3", {}, `Seats in ${state}`), seatTable(rows, { rank: rank && g >= 0 ? rank : null, max, limit: 150 }));
}

// ------------------------------------------------------------------ view: rank lookup

function rankResults() {
  const d = app.data, m = app.model;
  const g = groupIndex(), rank = myRank();
  if (g < 0 || !rank) return needGroup("Enter a group and a rank (top right) to trace what that rank got in every round.");
  const seatText = (i) => {
    const a = d.allotments[i];
    const [degree, spec] = d.courses[a[4]];
    return h("div", { class: "seat" }, h("span", { class: `deg deg-${degree.replace(/\W/g, "")}` }, degree), " ", h("b", {}, spec), h("div", { class: "muted" }, `${d.institutes[a[3]][0]} · ${d.institutes[a[3]][1]}${d.quotas[a[5]] !== "All India" ? " · " + d.quotas[a[5]] : ""}`));
  };
  const steps = d.rounds.map((r, ri) => {
    const i = m.byGroupRank.get(`${ri}|${g}|${rank}`);
    const t = d.transitions.find((t) => t[0] === ri && ((t[1] >= 0 && d.allotments[t[1]][1] === g && d.allotments[t[1]][2] === rank) || (t[4] >= 0 && d.allotments[t[4]][1] === g && d.allotments[t[4]][2] === rank)));
    let body;
    if (t) {
      body = [h("div", { class: "muted" }, `Seat going in: ${d.statuses[t[2]]}`), h("div", { class: "pill" }, d.outcomes[t[3]] + (t[5] ? ` · choice #${t[5]}` : "")), t[4] >= 0 ? seatText(t[4]) : null];
    } else if (i != null) {
      body = [h("div", { class: "pill" }, d.kinds[d.allotments[i][7]]), seatText(i)];
    } else {
      body = [h("div", { class: "muted" }, "Not in this round's list")];
    }
    return h("div", { class: `step ${i != null || t?.[4] >= 0 ? "got" : ""}` }, h("span", { class: "step-n", style: `background:${ROUND_COLORS[ri]}` }, r.id), h("strong", {}, r.label), body);
  });
  // Neighbouring ranks in the first round show what the rank band typically got.
  const near = [];
  for (let v = Math.max(1, rank - 8); v <= rank + 8; v++) {
    const i = m.byGroupRank.get(`0|${g}|${v}`);
    if (i != null) near.push([v, i]);
  }
  return h(
    "div",
    {},
    h("div", { class: "timeline" }, steps),
    h("h3", {}, `Ranks around ${fmt(rank)} in ${d.rounds[0].label}`),
    h("div", { class: "scroll" }, h("table", { class: "seats compact" },
      h("thead", {}, h("tr", {}, h("th", { class: "num" }, "Rank"), h("th", {}, "Course"), h("th", {}, "Institute"), h("th", {}, "State"))),
      h("tbody", {}, near.map(([v, i]) => {
        const a = d.allotments[i];
        const [degree, spec] = d.courses[a[4]];
        return h("tr", { class: v === rank ? "me" : "" }, h("td", { class: "num" }, fmt(v)), h("td", {}, h("span", { class: `deg deg-${degree.replace(/\W/g, "")}` }, degree), " ", spec), h("td", { class: "inst" }, d.institutes[a[3]][0]), h("td", {}, d.institutes[a[3]][1]));
      })),
    )),
    h("p", { class: "muted small" }, "Ranks missing from the list did not take a seat in that round (or are a different group's rank)."),
  );
}

// ------------------------------------------------------------------ view: about

function aboutResults() {
  const d = app.data;
  return h(
    "div",
    { class: "prose" },
    h("h3", {}, `Sources for ${d.year}`),
    h("table", { class: "seats compact" },
      h("thead", {}, h("tr", {}, h("th", {}, "Round"), h("th", {}, "PDF"), h("th", { class: "num" }, "Pages"), h("th", { class: "num" }, "Rows"), h("th", { class: "num" }, "Allotments used"))),
      h("tbody", {}, d.sources.map((s) => h("tr", {}, h("td", {}, d.rounds.find((r) => r.id === s.round).label), h("td", {}, s.file.split("/").pop()), h("td", { class: "num" }, s.pages), h("td", { class: "num" }, fmt(s.rows)), h("td", { class: "num" }, fmt(s.allotments)))))),
    h("h3", {}, "How to read the numbers"),
    h("ul", {},
      h("li", {}, h("b", {}, "Ranks are per group. "), "Medical group rank 500 and Surgical group rank 500 are different candidates. Always pick your group first."),
      h("li", {}, h("b", {}, "Closing rank "), "= the last (highest) rank that got that course at that institute in that round. Opening rank = the first. “×3” = number of seats filled."),
      h("li", {}, h("b", {}, "Round 2 "), "counts only seats newly allotted in Round 2 (upgrades and fresh allotments). Candidates who kept their Round 1 seat are not re-counted."),
      h("li", {}, h("b", {}, "No category split. "), "These PDFs list category codes in the legend but not per row, so cutoffs mix all categories."),
      h("li", {}, h("b", {}, "Chance bands "), `are a rule of thumb: Safe if the seat closed ≥ ${Math.round((SAFE - 1) * 100)}% past your rank, Likely if at/after it, Reach if within ${Math.round((1 - REACH) * 100)}% before it. Seat matrices and competition change every year.`),
      h("li", {}, "Institute names are cleaned from MCC's address strings; hover a name to see the original address."),
    ),
    h("p", {}, "Download the raw allotment rows: ", h("a", { href: `data/${d.year}-allotments.csv`, download: true }, `${d.year}-allotments.csv`), "."),
    h("h3", {}, "Credits"),
    h("ul", {},
      h("li", {}, "State boundaries: ", h("a", { href: "https://github.com/datta07/INDIAN-SHAPEFILES", target: "_blank", rel: "noopener" }, "datta07/INDIAN-SHAPEFILES"), " (MIT), simplified."),
      h("li", {}, "Caduceus logo: ", h("a", { href: "https://commons.wikimedia.org/wiki/File:Caduceus.svg", target: "_blank", rel: "noopener" }, "Wikimedia Commons"), " (public domain)."),
    ),
  );
}

const RENDERERS = {
  predict: { title: "Which seats does my rank reach?", lede: "Every course × institute whose closing rank was at or beyond yours, sorted from most to least competitive.", controls: () => filterBar({ round: true, anyRound: true }), results: predictResults },
  cutoffs: { title: "Closing ranks, every seat", lede: "Opening/closing rank per course × institute per round. Click headers to sort; bars show each round's allotted range.", controls: () => filterBar(), results: cutoffResults },
  specialities: { title: "Speciality ladder", lede: "Where every allotted candidate's rank fell, per speciality. Shows which branches fill first.", controls: () => filterBar({ round: true, spec: false }), results: specialityResults },
  trends: { title: "Year-on-year", lede: "The same specialities and seats across every loaded year. Spot courses that are getting tougher or easier.", controls: () => { const bar = filterBar(); bar.prepend(selectCtl("Round", "rpos", ROUND_POS, { all: null })); return bar; }, results: trendsResults },
  states: { title: "Seats across India", lede: "Filled seats by state. Switch the metric to see competitiveness or seats within your reach; click a state to list its seats.", controls: () => { const bar = filterBar({ round: true }); bar.prepend(selectCtl("Metric", "metric", [...(myRank() && groupIndex() >= 0 ? [["reach", "Seats within your rank"]] : []), ["seats", "Seats filled"], ["median", "Median allotted rank"]], { all: null })); return bar; }, results: stateResults },
  rank: { title: "Rank lookup", lede: "Trace one rank through every round, and see what neighbouring ranks took.", controls: null, results: rankResults },
  about: { title: "About the data", lede: "Built from official MCC NEET SS allotment PDFs. No database: the data is static JSON shipped with the site.", controls: null, results: aboutResults },
};

// ------------------------------------------------------------------ tooltip

function initTooltip() {
  const tip = $("#tooltip");
  document.addEventListener("mousemove", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.transform = `translate(${x}px, ${e.clientY + 16}px)`;
  });
}

// ------------------------------------------------------------------ boot

const pending = {};
function fetchYear(year) {
  pending[year] ||= fetch(`data/${year}.json`).then(async (res) => {
    if (!res.ok) throw new Error(`data/${year}.json: HTTP ${res.status}`);
    const data = await res.json();
    app.years[year] = { data, model: buildModel(data) };
  });
  return pending[year];
}

async function loadYear(year) {
  await fetchYear(year);
  app.data = app.years[year].data;
  app.model = app.years[year].model;
  if (app.p.g && !app.data.groups.includes(app.p.g)) app.p.g = "";
  $("#foot").replaceChildren(
    h("span", {}, `${app.data.year}: ${fmt(app.data.allotments.length)} allotments, ${app.data.institutes.length} institutes, ${app.data.rounds.map((r) => r.label).join(" · ")}.`),
    h("span", {}, " Unofficial; verify with ", h("a", { href: "https://mcc.nic.in/super-speciality-counselling/", target: "_blank", rel: "noopener" }, "MCC"), " before choice filling."),
  );
}

async function boot() {
  readHash();
  initTooltip();
  try {
    const res = await fetch("data/index.json");
    app.index = await res.json();
    if (!app.index.years.some((y) => y.year === app.p.year)) app.p.year = app.index.years[0].year;
    await loadYear(app.p.year);
    // Other years feed the year-on-year view and the predictor's "other years" column.
    Promise.all(app.index.years.map((y) => fetchYear(y.year)))
      .then(() => { if (app.view === "trends" || app.view === "predict") renderResults(); })
      .catch((err) => console.error(err));
  } catch (err) {
    $("#view").replaceChildren(h("div", { class: "empty" }, h("strong", {}, "Could not load data"), h("p", {}, String(err))));
    return;
  }
  writeHash();
  render();
  window.addEventListener("hashchange", async () => {
    readHash();
    if (!app.index.years.some((y) => y.year === app.p.year)) app.p.year = app.data.year;
    if (app.p.year !== app.data.year) await loadYear(app.p.year);
    render();
  });
}

boot();
