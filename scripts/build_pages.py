"""Static, crawlable cutoff pages for search engines, generated from docs/data/<year>.json.

    .venv/bin/python scripts/build_pages.py

The explorer is a single-page app whose tabs are #fragments, so search engines see one URL. This
writes plain HTML pages that need no JavaScript:

    docs/cutoffs/index.html                      hub: every year, group, course and state
    docs/cutoffs/<year>/index.html               all courses that year, by exam group
    docs/cutoffs/<year>/<course>/index.html      every institute × quota for one course
    docs/cutoffs/<year>/group/<group>/index.html every course × institute in one exam group
    docs/cutoffs/<year>/state/<state>/index.html
    docs/sitemap.xml                             all of the above + the explorer

and refreshes the link block between <!-- seo-links --> markers in docs/index.html.
Run it after scripts/build_data.py.
"""
import datetime
import html
import json
import os
import re
from collections import defaultdict
from urllib.parse import urlencode

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
SITE = "https://dr-pavani-utti.github.io/neet-ss-cutoff-explorer/"
AUTHOR = {"name": "Dr. Pavani Utti", "linkedin": "https://www.linkedin.com/in/dr-pavani-utti/",
          "portfolio": "https://dr-pavani-utti.github.io/portfolio/",
          "repo": "https://github.com/dr-pavani-utti/neet-ss-cutoff-explorer"}
TODAY = datetime.date.today().isoformat()
esc = html.escape


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower().replace("&", "and").replace("/", "-")).strip("-")


def fmt(n):
    """Indian digit grouping, as on the site (1,23,456)."""
    if n is None:
        return "–"
    s = str(n)
    if len(s) <= 3:
        return s
    head = re.sub(r"(\d)(?=(\d\d)+$)", r"\1,", s[:-3])
    return f"{head},{s[-3:]}"


def group_label(g):
    """Same as the explorer: "OBSTETRICS AND GYNAECOLOGY GROUP" -> "Obstetrics & Gynaecology"."""
    words = re.sub(r" GROUP$", "", g, flags=re.I).title().split()
    return " ".join("&" if w == "And" else "ENT" if w == "Ent" else w for w in words)


def load_years():
    with open(os.path.join(DOCS, "data", "index.json")) as fh:
        years = [y["year"] for y in json.load(fh)["years"]]
    out = {}
    for y in years:
        with open(os.path.join(DOCS, "data", f"{y}.json")) as fh:
            out[y] = json.load(fh)
    return out


def seats_of(d):
    """Seat = group × institute × course × quota; ranks per round."""
    n = len(d["rounds"])
    seats = {}
    for r, g, rank, inst, course, quota, *_ in d["allotments"]:
        s = seats.setdefault((g, inst, course, quota), [[] for _ in range(n)])
        s[r].append(rank)
    out = []
    for (g, inst, course, quota), ranks in seats.items():
        name, state, _address = d["institutes"][inst]
        degree, spec = d["courses"][course]
        out.append({"group": d["groups"][g], "inst": name, "state": state, "degree": degree, "spec": spec,
                    "quota": d["quotas"][quota], "close": [max(l) if l else None for l in ranks],
                    "n": [len(l) for l in ranks]})
    return out


def first_close(s):
    return next((c for c in s["close"] if c is not None), 10 ** 9)


def course_name(s):
    return f'{s["degree"]} {s["spec"]}'


# ---------------------------------------------------------------- page shell


def page(path, title, description, crumbs, body):
    """Write docs/<path>/index.html. crumbs: [(label, url-relative-to-site)]; last is the page itself."""
    up = "../" * (path.count("/") + 1)
    url = SITE + path + "/"
    graph = [{
        "@type": "BreadcrumbList",
        "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": label, "item": SITE + href}
                            for i, (label, href) in enumerate(crumbs)],
    }]
    crumb_html = " › ".join(
        f'<a href="{up}{href}">{esc(label)}</a>' if i < len(crumbs) - 1 else f"<span>{esc(label)}</span>"
        for i, (label, href) in enumerate(crumbs))
    doc = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(description)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="author" content="{AUTHOR['name']}">
  <link rel="canonical" href="{url}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="NEET SS Cutoff Explorer">
  <meta property="og:title" content="{esc(title)}">
  <meta property="og:description" content="{esc(description)}">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="{SITE}assets/og.png">
  <meta property="og:locale" content="en_IN">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="{SITE}assets/og.png">
  <script type="application/ld+json">{json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False)}</script>
  <link rel="icon" href="{up}assets/caduceus.svg" type="image/svg+xml">
  <link rel="stylesheet" href="{up}assets/style.css">
  <script defer src="https://cloud.umami.is/script.js" data-website-id="7e6255cb-0030-419a-9e19-7918dbb368de" data-domains="dr-pavani-utti.github.io"></script>
</head>
<body>
  <header class="top">
    <a class="brand plain" href="{up}">
      <span class="logo" aria-hidden="true"><i></i></span>
      <div>
        <strong class="brand-name">NEET Super Speciality Cutoff Explorer</strong>
        <p class="sub">Closing ranks from official MCC allotment lists</p>
      </div>
    </a>
    <a class="cta" href="{up}#predict">Open the rank predictor →</a>
  </header>
  <main class="static">
    <nav class="crumbs" aria-label="Breadcrumb">{crumb_html}</nav>
{body}
  </main>
  <footer class="foot">
    <p>Unofficial; verify with <a href="https://mcc.nic.in/super-speciality-counselling/" rel="noopener">MCC</a> before choice filling. Data: official MCC NEET SS allotment PDFs, <a href="{up}cutoffs/">all cutoff pages</a>, <a href="{up}#about">about the data</a>. Also by the same author: <a href="https://dr-pavani-utti.github.io/neet-pg-cutoff-explorer/">NEET PG Cutoff Explorer</a>.</p>
    <div class="credit"><div class="credit-who">Built by <b>{AUTHOR['name']}</b><span class="credit-links"><a href="{AUTHOR['linkedin']}" rel="noopener">LinkedIn</a><a href="{AUTHOR['portfolio']}" rel="noopener">Portfolio</a><a href="{AUTHOR['repo']}" rel="noopener">GitHub</a></span></div></div>
  </footer>
</body>
</html>
"""
    out = os.path.join(DOCS, path, "index.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        fh.write(doc)
    return url


def seat_table(rows, rounds, show_course=False, show_state=True, show_quota=True):
    head = "".join(f'<th class="num">{esc(r["label"])}</th>' for r in rounds)
    out = ['<div class="scroll"><table class="seats compact"><thead><tr>',
           "<th>Course</th>" if show_course else "", "<th>Institute</th>", "<th>State</th>" if show_state else "",
           "<th>Quota</th>" if show_quota else "", f"{head}</tr></thead><tbody>"]
    for s in rows:
        cells = "".join(f'<td class="num">{fmt(c)}{f"<small> ×{n}</small>" if c else ""}</td>'
                        for c, n in zip(s["close"], s["n"]))
        course = f"<td>{esc(course_name(s))}</td>" if show_course else ""
        state = f'<td>{esc(s["state"])}</td>' if show_state else ""
        quota = f'<td>{esc(s["quota"])}</td>' if show_quota else ""
        out.append(f'<tr>{course}<td class="inst">{esc(s["inst"])}</td>{state}{quota}{cells}</tr>')
    out.append("</tbody></table></div>")
    return "".join(out)


ROUND_NOTE = ('<p class="muted small">NEET SS ranks are issued per exam group, so a closing rank is the last rank '
              "in that group allotted the seat in that round; ×n = seats filled. Round 2 and stray/special rounds "
              "count only seats newly allotted in that round. – = no allotment.</p>")


# ---------------------------------------------------------------- pages


def course_pages(year, d, seats, course_years):
    rounds = d["rounds"]
    rlabels = ", ".join(r["label"] for r in rounds)
    urls, index = [], []
    by_course = defaultdict(list)
    for s in seats:
        by_course[(s["degree"], s["spec"])].append(s)
    for (degree, spec), rows in by_course.items():
        name = f"{degree} {spec}"
        sl = slug(name)
        path = f"cutoffs/{year}/{sl}"
        groups = sorted({s["group"] for s in rows})
        glabel = " / ".join(group_label(g) for g in groups)
        r1 = [s for s in rows if s["close"][0]]
        n_seats = sum(sum(s["n"]) for s in rows)
        n_inst = len({s["inst"] for s in rows})
        lede = (f"NEET SS {year} {name} cutoff ({glabel} group): {fmt(n_seats)} seats filled at {n_inst} "
                f"institutes across {rlabels}.")
        if r1:
            best = min(r1, key=lambda s: s["close"][0])
            last = max(r1, key=lambda s: s["close"][0])
            lede += (f" Round 1 closing ranks ran from {fmt(best['close'][0])} ({best['inst']}) to "
                     f"{fmt(last['close'][0])} ({last['inst']}).")
        rows = sorted(rows, key=lambda s: (first_close(s), s["inst"]))
        multi_quota = len({s["quota"] for s in rows}) > 1
        related = [f'<a href="../../{y}/{sl}/">NEET SS {y} {esc(name)} cutoff</a>'
                   for y in sorted(course_years[(degree, spec)], reverse=True) if y != year]
        related += [f'<a href="../group/{slug(group_label(g))}/">{esc(group_label(g))} group {year}</a>' for g in groups]
        explorer = "../../../#cutoffs?" + urlencode({"year": year, "g": groups[0], "deg": degree, "spec": spec})
        body = f"""    <h1>NEET SS {year} {esc(name)} cutoff: closing ranks by institute</h1>
    <p class="lede">{esc(lede)}</p>
    <p><a class="cta" href="{esc(explorer)}">Filter, sort and compare in the explorer →</a></p>
    {ROUND_NOTE}
    {seat_table(rows, rounds, show_quota=multi_quota)}
    <h2>Related</h2><p class="links">{" · ".join(related)}</p>"""
        title = f"NEET SS {year} {name} Cutoff: Closing Ranks by College & Round"
        desc = (f"NEET SS {year} {name} closing ranks ({glabel} group) for all {n_inst} institutes, {rlabels}. "
                "From official MCC allotment lists.")
        urls.append(page(path, title, desc, [("NEET SS Cutoff Explorer", ""), ("Cutoffs", "cutoffs/"),
                                             (year, f"cutoffs/{year}/"), (name, path + "/")], body))
        index.append({"degree": degree, "spec": spec, "slug": sl, "groups": groups, "seats": n_seats,
                      "inst": n_inst, "r1": (min(s["close"][0] for s in r1), max(s["close"][0] for s in r1)) if r1 else None,
                      "last": max((c for s in rows for c in s["close"] if c), default=None)})
    return urls, index


def listing_pages(year, d, seats, key, kind):
    """Group or state pages: every course × institute in it."""
    rounds = d["rounds"]
    urls, index = [], []
    buckets = defaultdict(list)
    for s in seats:
        if s[key] != "Unknown":
            buckets[s[key]].append(s)
    for value, rows in buckets.items():
        label = group_label(value) if kind == "group" else value
        sl = slug(label)
        path = f"cutoffs/{year}/{kind}/{sl}"
        n_seats = sum(sum(s["n"]) for s in rows)
        insts = {s["inst"] for s in rows}
        rows = sorted(rows, key=lambda s: (s["spec"], s["degree"], first_close(s)))
        if kind == "group":
            h1 = f"NEET SS {year} {label} group cutoff: every course and college"
            lede = (f"{fmt(n_seats)} {label} group seats were filled at {len(insts)} institutes in NEET SS {year} "
                    "MCC counselling. Ranks in this group are only comparable with other ranks in the same group.")
            cta = "../../../../#specialities?" + urlencode({"year": year, "g": value})
            cta_label = f"See the {label} group speciality ladder →"
            title = f"NEET SS {year} {label} Group Cutoff: College-wise Closing Ranks"
            desc = (f"NEET SS {year} {label} group closing ranks: every DM, MCh and DNB SS course at {len(insts)} "
                    "colleges, all MCC rounds.")
        else:
            h1 = f"NEET SS {year} cutoff in {label}: all colleges and courses"
            lede = (f"{fmt(n_seats)} NEET SS seats were filled through MCC counselling at {len(insts)} institutes "
                    f"in {label} in {year}. Ranks are per exam group; the group is shown for each course.")
            cta = "../../../../#states?" + urlencode({"year": year, "state": value})
            cta_label = f"See {label} on the map →"
            title = f"NEET SS {year} Cutoff {label}: College-wise Closing Ranks"
            desc = (f"NEET SS {year} closing ranks for {len(insts)} colleges in {label}: every DM, MCh and DNB SS "
                    "course, all MCC rounds.")
        group_col = kind == "state"
        table_rows = [dict(s, spec=f'{s["spec"]} ({group_label(s["group"])} group)') if group_col else s for s in rows]
        body = f"""    <h1>{esc(h1)}</h1>
    <p class="lede">{esc(lede)}</p>
    <p><a class="cta" href="{esc(cta)}">{esc(cta_label)}</a></p>
    {ROUND_NOTE}
    {seat_table(table_rows, rounds, show_course=True, show_state=kind == "group",
                show_quota=len({s["quota"] for s in rows}) > 1)}"""
        urls.append(page(path, title, desc, [("NEET SS Cutoff Explorer", ""), ("Cutoffs", "cutoffs/"),
                                             (year, f"cutoffs/{year}/"), (label, path + "/")], body))
        index.append({"label": label, "slug": sl, "seats": n_seats})
    return urls, sorted(index, key=lambda x: -x["seats"])


def year_page(year, d, courses, groups, states):
    rounds = ", ".join(r["label"] for r in d["rounds"])
    sections = []
    for g in sorted({g for c in courses for g in c["groups"]}, key=group_label):
        label = group_label(g)
        rows = "".join(
            f'<tr><td><a href="{c["slug"]}/">{esc(c["degree"])} {esc(c["spec"])}</a></td>'
            f'<td class="num">{fmt(c["seats"])}</td><td class="num">{c["inst"]}</td>'
            f'<td class="num">{f"{fmt(c["r1"][0])} – {fmt(c["r1"][1])}" if c["r1"] else "–"}</td>'
            f'<td class="num">{fmt(c["last"])}</td></tr>'
            for c in sorted((c for c in courses if g in c["groups"]), key=lambda c: c["r1"][0] if c["r1"] else 10 ** 9))
        sections.append(
            f'<h2><a href="group/{slug(label)}/">{esc(label)} group</a></h2><div class="scroll"><table class="seats compact">'
            '<thead><tr><th>Course</th><th class="num">Seats filled</th><th class="num">Institutes</th>'
            '<th class="num">Round 1 closing (lowest – highest)</th><th class="num">Last rank allotted, any round</th>'
            f"</tr></thead><tbody>{rows}</tbody></table></div>")
    state_links = " · ".join(f'<a href="state/{s["slug"]}/">{esc(s["label"])}</a>' for s in states)
    body = f"""    <h1>NEET SS {year} cutoff: closing ranks for every DM, MCh and DNB SS course</h1>
    <p class="lede">{fmt(len(d["allotments"]))} seats were allotted in NEET SS {year} MCC counselling ({rounds}). Ranks are issued per exam group, so courses are listed by group and ordered by their best Round 1 closing rank. Each course links to its full college-wise cutoff list.</p>
    <p><a class="cta" href="../../#predict?year={year}">Check which seats your rank gets →</a></p>
    {''.join(sections)}
    <h2>NEET SS {year} cutoff by state</h2>
    <p class="links">{state_links}</p>"""
    title = f"NEET SS {year} Cutoff: Group-wise, Course-wise & College-wise Closing Ranks"
    desc = (f"NEET SS {year} cutoff ranks for all {len(courses)} DM, MCh and DNB SS courses in {len(groups)} exam "
            f"groups across {rounds}, with college-wise closing ranks from MCC allotment lists.")
    return page(f"cutoffs/{year}", title, desc,
                [("NEET SS Cutoff Explorer", ""), ("Cutoffs", "cutoffs/"), (year, f"cutoffs/{year}/")], body)


def hub_page(per_year):
    blocks = []
    for year, (courses, groups, states) in per_year.items():
        links = lambda items, sub: " · ".join(f'<a href="{year}/{sub}{i["slug"]}/">{esc(i["label"])}</a>' for i in items)
        course_links = " · ".join(f'<a href="{year}/{c["slug"]}/">{esc(c["degree"])} {esc(c["spec"])}</a>'
                                  for c in sorted(courses, key=lambda c: (c["spec"], c["degree"])))
        blocks.append(f'<h2><a href="{year}/">NEET SS {year} cutoff</a></h2>'
                      f'<h3>By exam group</h3><p class="links">{links(groups, "group/")}</p>'
                      f'<h3>By course</h3><p class="links">{course_links}</p>'
                      f'<h3>By state</h3><p class="links">{links(states, "state/")}</p>')
    years = ", ".join(per_year)
    body = f"""    <h1>NEET SS cutoffs {years}: every group, course, college and state</h1>
    <p class="lede">College-wise NEET Super Speciality closing ranks for MCC counselling, every round, every exam group. Built from the official MCC allotment PDFs by {AUTHOR['name']}.</p>
    {''.join(blocks)}"""
    return page("cutoffs", f"NEET SS Cutoff {years}: All Groups, Courses, Colleges & States",
                f"NEET SS cutoff ranks for {years}: group-wise, course-wise, college-wise and state-wise closing ranks for every MCC round.",
                [("NEET SS Cutoff Explorer", ""), ("Cutoffs", "cutoffs/")], body)


def write_sitemap(urls):
    items = "".join(f"  <url>\n    <loc>{u}</loc>\n    <lastmod>{TODAY}</lastmod>\n  </url>\n" for u in urls)
    with open(os.path.join(DOCS, "sitemap.xml"), "w") as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<!-- Generated by scripts/build_pages.py. The explorer\'s tabs are #fragments, so its root is one URL. -->\n'
                 f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{items}</urlset>\n')


def update_index_links(per_year):
    """Plain links from the explorer page so crawlers find the static pages."""
    path = os.path.join(DOCS, "index.html")
    with open(path) as fh:
        doc = fh.read()
    year_links = " · ".join(f'<a href="cutoffs/{y}/">NEET SS {y} cutoff</a>' for y in per_year)
    latest, (courses, groups, states) = next(iter(per_year.items()))
    group_links = " · ".join(f'<a href="cutoffs/{latest}/group/{g["slug"]}/">{esc(g["label"])}</a>' for g in groups)
    top = sorted(courses, key=lambda c: -c["seats"])[:12]
    course_links = " · ".join(f'<a href="cutoffs/{latest}/{c["slug"]}/">{esc(c["degree"])} {esc(c["spec"])}</a>' for c in top)
    state_links = " · ".join(f'<a href="cutoffs/{latest}/state/{s["slug"]}/">{esc(s["label"])}</a>' for s in states[:12])
    block = (f'<!-- seo-links -->\n  <nav class="seo-links" aria-label="Cutoff pages">\n'
             f'    <p><b>Cutoff lists:</b> {year_links} · <a href="cutoffs/">all groups, courses &amp; states</a></p>\n'
             f'    <p><b>{latest} by group:</b> {group_links}</p>\n'
             f'    <p><b>{latest} by course:</b> {course_links}</p>\n'
             f'    <p><b>{latest} by state:</b> {state_links}</p>\n'
             f'  </nav>\n  <!-- /seo-links -->')
    doc, n = re.subn(r"<!-- seo-links -->.*?<!-- /seo-links -->", block, doc, flags=re.S)
    if n != 1:
        raise ValueError("docs/index.html needs exactly one <!-- seo-links --> … <!-- /seo-links --> block")
    with open(path, "w") as fh:
        fh.write(doc)


def main():
    years = load_years()
    all_seats = {y: seats_of(d) for y, d in years.items()}
    course_years = defaultdict(set)
    for y, seats in all_seats.items():
        for s in seats:
            course_years[(s["degree"], s["spec"])].add(y)
    urls = [SITE, SITE + "cutoffs/"]
    per_year = {}
    for y, d in years.items():
        c_urls, courses = course_pages(y, d, all_seats[y], course_years)
        g_urls, groups = listing_pages(y, d, all_seats[y], "group", "group")
        s_urls, states = listing_pages(y, d, all_seats[y], "state", "state")
        urls += [year_page(y, d, courses, groups, states)] + c_urls + g_urls + s_urls
        per_year[y] = (courses, groups, states)
        print(f"{y}: {len(c_urls)} course, {len(g_urls)} group, {len(s_urls)} state pages")
    hub_page(per_year)
    write_sitemap(urls)
    update_index_links(per_year)
    print(f"sitemap: {len(urls)} URLs")


if __name__ == "__main__":
    main()
