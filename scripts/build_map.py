"""Build docs/assets/india-map.json (projected, simplified SVG paths per state) for the State map view.

    python3 scripts/build_map.py

Source: INDIA_STATES.geojson from https://github.com/datta07/INDIAN-SHAPEFILES (MIT licence), which uses
current state/UT boundaries (Telangana, Ladakh) with LGD codes. The file is downloaded into build/ once.
"""
import json
import math
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_URL = "https://raw.githubusercontent.com/datta07/INDIAN-SHAPEFILES/master/INDIA/INDIA_STATES.geojson"
SRC = os.path.join(ROOT, "build", "geo", "INDIA_STATES.geojson")
OUT = os.path.join(ROOT, "docs", "assets", "india-map.json")
WIDTH = 600           # SVG units
TOLERANCE = 0.03     # degrees, Douglas–Peucker (~3 km; invisible at 600 px wide)
MIN_RING_AREA = 0.004 # square degrees; smaller islands are dropped (largest ring of a state is always kept)
LAT0 = math.radians(22)  # equirectangular standard parallel, keeps India's proportions


def simplify(points, tol):
    """Douglas–Peucker on a closed ring: split at the point farthest from the start, simplify both halves."""
    if points[0] == points[-1]:
        points = points[:-1]
    if len(points) < 4:
        return points
    far = max(range(len(points)), key=lambda i: math.dist(points[0], points[i]))
    return _dp(points[: far + 1], tol)[:-1] + _dp(points[far:] + points[:1], tol)[:-1]


def _dp(points, tol):
    """Iterative Douglas–Peucker on an open polyline."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = points[a], points[b]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy) or 1e-12
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            x0, y0 = points[i]
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / norm
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def ring_area(ring):
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))) / 2


def centroid(ring):
    a = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        cross = x1 * y2 - x2 * y1
        a += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    if abs(a) < 1e-12:
        xs, ys = zip(*ring)
        return sum(xs) / len(xs), sum(ys) / len(ys)
    return cx / (3 * a), cy / (3 * a)


def main():
    if not os.path.exists(SRC):
        os.makedirs(os.path.dirname(SRC), exist_ok=True)
        urllib.request.urlretrieve(SRC_URL, SRC)
    with open(SRC) as fh:
        features = json.load(fh)["features"]

    states = {}
    for f in features:
        name = f["properties"]["STNAME_SH"]
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        rings = [[(x * math.cos(LAT0), -y) for x, y in poly[0]] for poly in polys]  # outer rings only
        rings.sort(key=ring_area, reverse=True)
        kept = [rings[0]] + [r for r in rings[1:] if ring_area(r) >= MIN_RING_AREA]
        states[name] = {"rings": [simplify(r, TOLERANCE) for r in kept], "label": centroid(rings[0]),
                        "area": sum(ring_area(r) for r in rings)}

    xs = [x for s in states.values() for r in s["rings"] for x, _ in r]
    ys = [y for s in states.values() for r in s["rings"] for _, y in r]
    x0, y0 = min(xs), min(ys)
    scale = WIDTH / (max(xs) - x0)
    height = round((max(ys) - y0) * scale)
    P = lambda x, y: (round((x - x0) * scale, 1), round((y - y0) * scale, 1))

    out = {}
    for name, s in sorted(states.items()):
        d = ""
        for ring in s["rings"]:
            pts = [P(x, y) for x, y in ring]
            d += "M" + "L".join(f"{x:g},{y:g}" for x, y in pts) + "Z"
        lx, ly = P(*s["label"])
        out[name] = {"d": d, "x": lx, "y": ly, "area": round(s["area"] * scale * scale)}
    with open(OUT, "w") as fh:
        json.dump({"width": WIDTH, "height": height, "source": SRC_URL, "states": out}, fh, separators=(",", ":"))
    print(f"{OUT}: {len(out)} states, {os.path.getsize(OUT) // 1024} KB, {WIDTH}x{height}")


if __name__ == "__main__":
    main()
