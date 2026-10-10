"""Build compact JSON datasets for the website from MCC NEET-SS allotment PDFs.

    .venv/bin/python scripts/build_data.py            # all years in scripts/sources.json
    .venv/bin/python scripts/build_data.py 2025       # one year

Reads PDFs listed in scripts/sources.json, caches raw table rows in build/, and writes
docs/data/<year>.json, docs/data/<year>-allotments.csv and docs/data/index.json.

Two table layouts are understood, detected from the header row:
  * single round:  SNo | Rank | Qualifying Exam | Allotted Institute | [Quota] | [Category] | Course | Remarks
  * upgrade round: SNo | <one Rank..Remarks block per earlier round> | Rank | Qualifying Exam | Allotted Institute
                   | Course | option No. | Remarks   (Round 2 repeats Round 1; stray/special rounds repeat 1 and 2)
"""
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor

import pdfplumber

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data")
CACHE = os.path.join(ROOT, "build")

# ---------------------------------------------------------------- extraction


def _page_rows(args):
    path, index = args
    with pdfplumber.open(path) as pdf:
        tables = pdf.pages[index].extract_tables()
    return [row for table in tables for row in table]


def extract_rows(pdf_path):
    """All table rows of a PDF, cached by file size + mtime."""
    st = os.stat(pdf_path)
    tag = f"{st.st_size}-{int(st.st_mtime)}"
    cache = os.path.join(CACHE, re.sub(r"[^\w.-]", "_", os.path.relpath(pdf_path, ROOT)) + ".json")
    if os.path.exists(cache):
        with open(cache) as fh:
            data = json.load(fh)
        if data.get("tag") == tag:
            return data["pages"], data["rows"]
    with pdfplumber.open(pdf_path) as pdf:
        count = len(pdf.pages)
    with ProcessPoolExecutor() as pool:
        pages = list(pool.map(_page_rows, [(pdf_path, i) for i in range(count)], chunksize=8))
    rows = [row for page in pages for row in page]
    os.makedirs(CACHE, exist_ok=True)
    with open(cache, "w") as fh:
        json.dump({"tag": tag, "pages": count, "rows": rows}, fh)
    return count, rows


# ---------------------------------------------------------------- normalisation


def clean(value):
    return re.sub(r"\s+", " ", (value or "").replace("\n", " ")).strip()


def key(value):
    return re.sub(r"[^a-z0-9]", "", value.lower())


SMALL_WORDS = {"and", "of", "the", "for", "in", "at", "&"}
ACRONYMS = {"AIIMS", "IPGMER", "JIPMER", "PGIMER", "SKIMS", "NIMHANS", "SGPGI", "SGPGIMS", "KIMS", "SIMS", "NIMS",
            "ESIC", "IGIMS", "RIMS", "GIPMER", "SCTIMST", "HCG", "MIOT", "SRM", "NRS", "KEM", "BYL", "PVT", "LTD",
            "LLP", "ILBS", "IGMC", "RMLIMS", "KGMU", "BHU", "CMC", "SMS", "GMCH", "AMRI", "KMC", "MGM"}


def tidy_caps(name):
    """Title-case names printed in ALL CAPS; keep short tokens (AIIMS-style acronyms) upper-case."""
    if any(ch.islower() for ch in name):
        return name
    words = []
    for word in name.split(" "):
        low = word.lower()
        if low in SMALL_WORDS:
            words.append(low)
        elif len(word.strip(".()-")) <= 3 or "." in word or word.strip(".()-,") in ACRONYMS:
            words.append(word)
        else:
            words.append(word.capitalize())
    return " ".join(words)


def to_int(value):
    value = clean(value)
    return int(value) if value.isdigit() else None


STATES = {
    "Andaman and Nicobar": "Andaman & Nicobar", "Andhra Pradesh": None, "Arunachal Pradesh": None,
    "Assam": None, "Bihar": None, "Chandigarh": None, "Chhattisgarh": None, "Delhi": None, "Goa": None,
    "Gujarat": None, "Haryana": None, "Himachal Pradesh": None, "Jammu and Kashmir": "Jammu & Kashmir",
    "Jammu & Kashmir": None, "Jharkhand": None, "Karnataka": None, "Kerala": None, "Ladakh": None,
    "Madhya Pradesh": None, "Maharashtra": None, "Manipur": None, "Meghalaya": None, "Mizoram": None,
    "Nagaland": None, "Odisha": None, "Orissa": "Odisha", "Puducherry": None, "Pondicherry": "Puducherry",
    "Punjab": None, "Rajasthan": None, "Sikkim": None, "Tamil Nadu": None, "Telangana": None,
    "Tripura": None, "Uttar Pradesh": None, "Uttarakhand": None, "West Bengal": None,
}
# Addresses that never spell out the state.
CITY_STATE = {
    "ahmedabad": "Gujarat", "kachchh": "Gujarat", "mumbai": "Maharashtra", "hyderabad": "Telangana",
    "kannur": "Kerala", "guwahati": "Assam", "bhopal": "Madhya Pradesh", "dehradun": "Uttarakhand",
    "bangalore": "Karnataka", "bengaluru": "Karnataka", "varanasi": "Uttar Pradesh", "chennai": "Tamil Nadu",
    "kolkata": "West Bengal", "pune": "Maharashtra", "lucknow": "Uttar Pradesh", "jaipur": "Rajasthan",
    "madurai": "Tamil Nadu",
}
STATE_RX = re.compile(r"\b(" + "|".join(re.escape(s) for s in sorted(STATES, key=len, reverse=True)) + r")\b", re.I)
CITY_RX = re.compile(r"\b(" + "|".join(CITY_STATE) + r")\b", re.I)
STATE_CANON = {s.lower(): (alias or s) for s, alias in STATES.items()}


def detect_state(address):
    hits = STATE_RX.findall(address)
    if hits:
        return STATE_CANON[hits[-1].lower()]
    hits = CITY_RX.findall(address)
    return CITY_STATE[hits[-1].lower()] if hits else "Unknown"


DEGREES = [("D. M.", "DM"), ("D.M.", "DM"), ("M.CH.", "MCh"), ("M.Ch.", "MCh"), ("M.Ch", "MCh"),
           ("DNBSS", "DNB-SS"), ("DrNB", "DNB-SS")]
# Canonical speciality per (lower-cased) course text after the degree prefix. Unknown
# names fall through unchanged, so a new year never breaks the build.
SPECIALITY = {
    "clinical haematology": "Clinical Haematology", "hematology": "Clinical Haematology",
    "clinical immunology and rheumatology": "Rheumatology", "rheumatology": "Rheumatology",
    "infectious disease": "Infectious Diseases", "specialty infectious diseases": "Infectious Diseases",
    "interventional radiology": "Interventional Radiology",
    "endovascular and interventional radiology": "Interventional Radiology",
    "medical gastroenterology": "Gastroenterology", "gastroenterology": "Gastroenterology",
    "nephrology": "Nephrology", "neuro anesthesia": "Neuro Anaesthesia",
    "neuro anaesthesia and critical care": "Neuro Anaesthesia", "neuro-radiology": "Neuroradiology",
    "organ transplant anesthesia and critical care": "Organ Transplant Anaesthesia & Critical Care",
    "paediatric and neonatal anaethesia": "Paediatric & Neonatal Anaesthesia",
    "paediatrics cardiology": "Paediatric Cardiology", "pediatric cardiology": "Paediatric Cardiology",
    "paediatrics gastroenterology": "Paediatric Gastroenterology", "pediatric hepatology": "Paediatric Hepatology",
    "pediatric intensive care": "Paediatric Intensive Care", "paediatric surgery": "Paediatric Surgery",
    "paediatrics surgery": "Paediatric Surgery", "cardio thoracic surgery": "Cardiothoracic & Vascular Surgery",
    "cardio vascular and thoracic surgery": "Cardiothoracic & Vascular Surgery",
    "genito urinary surgery (urology)": "Urology", "gynaecologic oncology": "Gynaecological Oncology",
    "gynecological oncology": "Gynaecological Oncology", "neuro surgery": "Neurosurgery",
    "peripheral vascular surgery": "Vascular Surgery", "plastic surgery": "Plastic & Reconstructive Surgery",
    "plastic and reconstructructive surgery": "Plastic & Reconstructive Surgery",
    "hepatopancreatto billary surgery": "HPB Surgery", "cardiac anaesthesia": "Cardiac Anaesthesia",
}
SPECIALITY_BY_KEY = {key(k): v for k, v in SPECIALITY.items()}


def split_course(text):
    for prefix, degree in DEGREES:
        if text.startswith(prefix):
            rest = text[len(prefix):].strip()
            break
    else:
        degree, rest = "Other", text
    # Wrapped cells sometimes split words ("ANAESTHESIOL OGY"), so match on letters only.
    canon = SPECIALITY_BY_KEY.get(key(rest))
    if canon is None:
        canon = rest if rest != rest.upper() else rest.title()
    return degree, canon


class Table:
    """Interning table: value -> index, preserving first-seen order."""

    def __init__(self):
        self.items, self.index = [], {}

    def add(self, k, value=None):
        if k not in self.index:
            self.index[k] = len(self.items)
            self.items.append(value if value is not None else k)
        return self.index[k]


# ---------------------------------------------------------------- parsing


def header_row(rows):
    for row in rows:
        if row and clean(row[0]) == "SNo":
            return [clean(c) for c in row if clean(c)]
    raise ValueError("no SNo header row found")


def data_rows(rows, width):
    out = []
    for row in rows:
        if not row or not clean(row[0]).isdigit():
            continue
        row = [clean(c) for c in row]
        # The first page of some PDFs carries one extra empty column.
        while len(row) > width:
            gap = next((i for i, c in enumerate(row) if c == "" and i > 0), None)
            if gap is None:
                raise ValueError(f"cannot fit row to header: {row}")
            del row[gap]
        if len(row) != width:
            raise ValueError(f"row width {len(row)} != header {width}: {row}")
        out.append(row)
    sno = [int(r[0]) for r in out]
    if sno != list(range(1, len(sno) + 1)):
        raise ValueError("serial numbers are not contiguous 1..N; extraction lost rows")
    return out


OUTCOMES = {
    "upgraded": "Upgraded", "noupgradation": "No Upgradation", "notallotted": "Not Allotted",
    "didnotfillupfreshchoices": "Did not fill up fresh choices",
    "didnotoptforupgradation": "Did not opt for Upgradation",
}


def normalise_outcome(text):
    k = key(text)
    if k.startswith("freshallotted"):  # "Fresh Allotted in 2nd Round" / "... 3nd Round"
        return "Fresh allotment"
    return OUTCOMES.get(k, text.rstrip("."))



QUOTAS = {"AI": "All India", "TA": "Tamil Nadu All India"}


class YearBuilder:
    def __init__(self, year):
        self.year = year
        self.groups, self.states, self.quotas, self.categories = Table(), Table(), Table(), Table()
        self.statuses, self.outcomes = Table(), Table()
        self.courses, self.institutes = Table(), Table()
        self.allotments = []  # [round, group, rank, inst, course, quota, category, kind]
        self.transitions = []  # [round, prevAllot, prevStatus, outcome, newAllot, option]
        self.rounds = []
        self.by_round = []  # per round: {rank: [allotment indices]}
        self.kinds = Table()
        self.quotas.add("All India")

    def course(self, text):
        degree, spec = split_course(text)
        return self.courses.add(f"{degree}|{key(spec)}", [degree, spec])

    def institute(self, text):
        """Same institute is printed with differing addresses across rounds; identify it by name + PIN."""
        name = text.split(",")[0].strip()
        pins = re.findall(r"(?<!\d)\d{6}(?!\d)", text)
        k = key(name) + pins[-1] if pins else key(text)
        if k not in self.institutes.index:
            self.institutes.add(k, {"name": name, "address": text, "state": detect_state(text)})
        return self.institutes.index[k]

    def add_allotment(self, rnd, group, rank, inst, course, quota="All India", category="", kind="Allotted"):
        idx = len(self.allotments)
        self.allotments.append([rnd, self.groups.add(key(group), group), rank, self.institute(inst), self.course(course),
                                self.quotas.add(QUOTAS.get(quota, quota)), self.categories.add(category),
                                self.kinds.add(kind)])
        return idx

    def parse_single(self, rnd, header, rows):
        col = {name: i for i, name in enumerate(header)}
        need = ["Rank", "Qualifying Exam", "Allotted Institute", "Course"]
        missing = [n for n in need if n not in col]
        if missing:
            raise ValueError(f"missing columns {missing} in {header}")
        quota = next((i for n, i in col.items() if n.startswith("Quota") or n == "Allotted Quota"), None)
        cat = next((i for n, i in col.items() if "Category" in n), None)
        for r in data_rows(rows, len(header)):
            self.add_allotment(rnd, r[col["Qualifying Exam"]], int(r[col["Rank"]]), r[col["Allotted Institute"]],
                               r[col["Course"]], r[quota] if quota is not None else "All India",
                               r[cat] if cat is not None else "")

    def link_previous(self, prev_round, rank, short_inst, course_text):
        """Find the previous-round allotment a row refers to (only rank, short name and course are printed)."""
        cands = [i for i in self.by_rank(prev_round).get(rank, [])]
        if not cands:
            return -1
        ckey, ikey = self.course(course_text), key(short_inst)

        def score(i):
            a = self.allotments[i]
            inst_key = key(self.institutes.items[a[3]]["address"])
            return (a[4] == ckey) * 2 + inst_key.startswith(ikey) + (ikey[:12] in inst_key)

        best = max(cands, key=score)
        return best if score(best) > 0 else -1

    def by_rank(self, rnd):
        while len(self.by_round) <= rnd:
            self.by_round.append(None)
        if self.by_round[rnd] is None:
            index = defaultdict(list)
            for i, a in enumerate(self.allotments):
                if a[0] == rnd:
                    index[a[2]].append(i)
            self.by_round[rnd] = index
        return self.by_round[rnd]

    def parse_upgrade(self, rnd, header, rows):
        """Upgrade lists repeat every earlier round's columns, then the current round's allotment."""
        starts = [i for i, n in enumerate(header) if n == "Rank"]
        sections = []
        for s, start in enumerate(starts):
            end = starts[s + 1] if s + 1 < len(starts) else len(header)
            sections.append({n: i for i, n in enumerate(header[start:end], start)})
        *prev, cur = sections
        first_prev_round = rnd - len(prev)
        opt = next(i for n, i in cur.items() if n.lower().startswith("option"))
        seen = set()
        for r in data_rows(rows, len(header)):
            sig = tuple(r[1:])
            if sig in seen:  # candidates ranked in two groups are printed once per group
                continue
            seen.add(sig)
            # The seat held going into this round is the latest earlier section that shows one.
            prev_idx, status = -1, "New in this round"
            for s in range(len(prev) - 1, -1, -1):
                sec = prev[s]
                prev_rank = to_int(r[sec["Rank"]])
                if prev_rank:
                    prev_idx = self.link_previous(first_prev_round + s, prev_rank, r[sec["Allotted Institute"]],
                                                  r[sec["Course"]])
                    status = r[sec["Remarks"]]
                    break
            new_idx = -1
            outcome = normalise_outcome(r[cur["Remarks"]])
            new_rank = to_int(r[cur["Rank"]])
            if new_rank:
                kind = "Upgraded" if outcome == "Upgraded" else "Fresh"
                new_idx = self.add_allotment(rnd, r[cur["Qualifying Exam"]], new_rank, r[cur["Allotted Institute"]],
                                             r[cur["Course"]], kind=kind)
            self.transitions.append([rnd, prev_idx, self.statuses.add(status), self.outcomes.add(outcome),
                                     new_idx, to_int(r[opt]) or 0])

    def parse_round(self, rnd, path):
        pages, rows = extract_rows(path)
        header = header_row(rows)
        if header.count("Rank") >= 2:
            self.parse_upgrade(rnd, header, rows)
        else:
            self.parse_single(rnd, header, rows)
        return pages, sum(1 for r in rows if r and clean(r[0]).isdigit())

    def institute_labels(self):
        insts = self.institutes.items
        # Bare acronyms ("PGIMER") say little on their own; append the next address segment.
        labels = [i["name"] if len(i["name"]) >= 12 or not self._second_segment(i)
                  else f"{i['name']}, {self._second_segment(i)}" for i in insts]
        for extra in (self._second_segment, lambda i: i["state"], lambda i: re.findall(r"\d{6}", i["address"])[-1:]):
            counts = Counter(l.lower() for l in labels)
            for n, inst in enumerate(insts):
                if counts[labels[n].lower()] > 1:
                    add = extra(inst)
                    add = add[0] if isinstance(add, list) else add
                    if add and add.lower() not in labels[n].lower():
                        labels[n] = f"{labels[n]}, {add}"
        return [tidy_caps(l) for l in labels]

    @staticmethod
    def _second_segment(inst):
        parts = [s.strip() for s in inst["address"].split(",")]
        seg = parts[1] if len(parts) > 1 else ""
        return seg if seg and len(seg) <= 40 and not seg.isdigit() else ""

    def to_json(self, meta):
        labels = self.institute_labels()
        return {
            "year": self.year,
            "rounds": self.rounds,
            "groups": self.groups.items,
            "quotas": self.quotas.items,
            "categories": self.categories.items,
            "kinds": self.kinds.items,
            "statuses": self.statuses.items,
            "outcomes": self.outcomes.items,
            "courses": self.courses.items,
            "institutes": [[labels[n], i["state"], i["address"]] for n, i in enumerate(self.institutes.items)],
            "allotments": self.allotments,
            "transitions": self.transitions,
            "sources": meta,
        }


def build_year(year, spec):
    b = YearBuilder(year)
    meta = []
    for rnd, entry in enumerate(spec["rounds"]):
        path = os.path.join(ROOT, entry["file"])
        pages, rows = b.parse_round(rnd, path)
        b.rounds.append({"id": entry["id"], "label": entry["label"]})
        n = sum(1 for a in b.allotments if a[0] == rnd)
        meta.append({"round": entry["id"], "file": entry["file"], "pages": pages, "rows": rows, "allotments": n})
        print(f"  {entry['id']}: {pages} pages, {rows} rows, {n} allotments")
    unknown = [i["name"] for i in b.institutes.items if i["state"] == "Unknown"]
    if unknown:
        print(f"  warning: state unknown for {len(unknown)} institutes: {unknown[:5]}")
    unlinked = sum(1 for t in b.transitions if t[1] < 0 and b.statuses.items[t[2]] != "New in this round")
    if unlinked:
        print(f"  warning: {unlinked} upgrade rows not linked to a previous-round seat")
    return b, b.to_json(meta)


def write_csv(path, data):
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["year", "round", "group", "rank", "degree", "speciality", "institute", "state", "quota",
                    "category", "kind"])
        for a in data["allotments"]:
            course, inst = data["courses"][a[4]], data["institutes"][a[3]]
            w.writerow([data["year"], data["rounds"][a[0]]["label"], data["groups"][a[1]], a[2], course[0],
                        course[1], inst[0], inst[1], data["quotas"][a[5]], data["categories"][a[6]],
                        data["kinds"][a[7]]])


def main(argv):
    with open(os.path.join(ROOT, "scripts", "sources.json")) as fh:
        sources = json.load(fh)
    years = argv or list(sources)
    os.makedirs(OUT, exist_ok=True)
    for year in years:
        print(f"{year}:")
        _, data = build_year(year, sources[year])
        with open(os.path.join(OUT, f"{year}.json"), "w") as fh:
            json.dump(data, fh, separators=(",", ":"), ensure_ascii=False)
        write_csv(os.path.join(OUT, f"{year}-allotments.csv"), data)
    index = [{"year": y, "rounds": [r["label"] for r in sources[y]["rounds"]]}
             for y in sorted(sources, reverse=True) if os.path.exists(os.path.join(OUT, f"{y}.json"))]
    with open(os.path.join(OUT, "index.json"), "w") as fh:
        json.dump({"years": index}, fh, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
