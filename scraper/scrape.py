"""Build the site's data files from Northwestern's catalog.

Each map in scraper/config.json (departments + degree pages + optional
schedule) becomes data/<id>.json, and data/maps.json lists them for the site.

Usage:
    python scraper/scrape.py                  # fetch live pages, rebuild every map
    python scraper/scrape.py --cache .cache   # save/reuse raw HTML in .cache/
    python scraper/scrape.py --map ece        # rebuild one map
    python scraper/scrape.py --report r.md    # also write a review summary
    python scraper/scrape.py --mark-verified  # record current prereq texts as hand-checked

Prerequisites are parsed heuristically (see prereqs.py). A course counts as
reviewed when its exact catalog text is in verified.json, or it has an entry
in overrides.json written against that text. Everything else is flagged.
"""

import argparse
import datetime
import difflib
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from bs4 import BeautifulSoup

from prereqs import clean, codes_in, is_plain, parse_requirements, tidy
from programs import core_lists, merge_core, parse_program, program_courses

ROOT = pathlib.Path(__file__).resolve().parent.parent
HERE = ROOT / "scraper"
DATA = ROOT / "data"


def load_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def without_comments(d):
    return {k: v for k, v in d.items() if not k.startswith("_")}


class Fetcher:
    def __init__(self, cache):
        self.cache = cache
        self.last = 0.0

    def get(self, url):
        path = None
        if self.cache:
            path = self.cache / (re.sub(r"[^A-Za-z0-9]+", "_", url).strip("_") + ".html")
            if path.exists():
                return path.read_text()
        time.sleep(max(0.0, 1.0 - (time.time() - self.last)))  # be polite
        req = urllib.request.Request(url, headers={"User-Agent": "nu-prereq-map scraper"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode("utf-8")
        self.last = time.time()
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        return text


# ---------------------------------------------------------------------------
# Catalog pages
# ---------------------------------------------------------------------------

class Catalog:
    """Department course lists, fetched on first use and shared between maps."""

    def __init__(self, base, fetcher):
        self.base, self.fetcher = base, fetcher
        self.depts = {}
        self.year = None

    def dept(self, code):
        if code not in self.depts:
            try:
                html = self.fetcher.get(f"{self.base}/undergraduate/courses-az/{code.lower()}/")
            except urllib.error.HTTPError as err:
                print(f"  ! no catalog page for {code} ({err.code})", file=sys.stderr)
                self.depts[code] = None
                return None
            self.depts[code] = parse_dept(html)
            m = re.search(r"Undergraduate Catalog (\d{4}-\d{4})", html)
            if m and not self.year:
                self.year = m.group(1)
        return self.depts[code]

    def course(self, cid):
        d = self.dept(cid.split(" ")[0])
        return d["courses"].get(cid) if d else None

    def url(self, cid):
        return f"{self.base}/search/?P={urllib.parse.quote(cid)}"


def parse_dept(html):
    soup = BeautifulSoup(html, "html.parser")
    name = ""
    for h1 in soup.find_all("h1"):
        m = re.match(r"(.*) \(([A-Z_]+)\)$", clean(h1.get_text()))
        if m:
            name = m.group(1)
    courses = {}
    for block in soup.select("div.courseblock"):
        head = clean(block.find("strong").get_text())
        m = re.match(r"([A-Z_]+) (\d{3}-\d) (.*?)\s*\(([\d.]+) Units?\)", head)
        if not m:
            continue  # study groups, variable-unit independent study, etc.
        dept, num, title, units = m.groups()
        text = ""
        for extra in block.select(".courseblockextra"):
            t = clean(extra.get_text(" "))
            if re.match(r"(Prerequisites?|Corequisites?)", t):
                text = t
        node = block.select_one(".courseblockdesc")
        desc = clean(node.get_text(" ")) if node else ""
        # A few courses put the prerequisite sentence at the end of the description.
        m = re.search(r"((?:Prerequisites?|Corequisites?)\s*:.*)$", desc)
        if m:
            text = text or m.group(1)
            desc = desc[:m.start()]
        courses[f"{dept} {num}"] = {
            "dept": dept, "num": num, "title": tidy(title), "units": float(units), "text": text,
            "desc": tidy(desc),
        }
    return {"name": name, "courses": courses}


def parse_mccormick_schedule(html):
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id="course_list")
    columns = [clean(th.get_text()) for th in table.select("thead th")[2:]]
    # Fall, winter and spring only: a summer column is the summer before the
    # school year, and the site plans the regular quarters.
    quarters = [q for q in columns if not q.startswith("Summer")]
    rows = []
    for tr in table.select("tbody tr"):
        cells = tr.find_all("td")
        if len(cells) < 2 + len(columns):
            continue
        offered = {}
        for q, cell in zip(columns, cells[2:]):
            text = " · ".join(clean(s) for s in cell.stripped_strings)
            if text and q in quarters:
                offered[q] = text
        rows.append((re.findall(r"\d{3}(?:-\d)?", cells[0].get_text()), clean(cells[1].get_text()), offered))
    return quarters, rows


def norm_title(t):
    t = t.lower().replace("&", "and")
    t = re.sub(r"\bintro\b", "introduction", t)
    t = re.sub(r"\bfund\b", "fundamentals", t)
    return re.sub(r"[^a-z0-9 ]", "", t)


def match_schedule(nodes, rows, aliases):
    """Attach schedule rows (bare numbers + titles) to courses on the map."""
    by_num = {}
    for cid, c in nodes.items():
        for key in {c["num"], c["num"].split("-")[0]}:
            by_num.setdefault(key, []).append(cid)
    unmatched = []
    for nums, title, offered in rows:
        if not offered:
            continue
        hit = False
        for n in nums:
            if aliases.get(n) in nodes:
                nodes[aliases[n]]["offered"] = offered
                hit = True
                continue
            for cid in by_num.get(n, []):
                c = nodes[cid]
                if not c["title"]:  # referenced but missing from the catalog
                    c["title"], c["offered"], hit = title, offered, True
                elif difflib.SequenceMatcher(None, norm_title(title), norm_title(c["title"])).ratio() >= 0.6:
                    c["offered"], hit = offered, True
        if not hit:
            unmatched.append(f"{'/'.join(nums)} {title}")
    return unmatched


# ---------------------------------------------------------------------------
# Building one map
# ---------------------------------------------------------------------------

def build_map(cfg, config, catalog, fetcher, overrides, verified):
    issues = {"unreviewed": [], "stale_overrides": [], "placeholders": [], "unmatched": [], "cycles": [],
              "empty_programs": []}
    nodes = {}
    # Short department names used in prereq text ("CS 214") -> catalog codes.
    aliases = {abbr: dept for dept, abbr in config["abbreviations"].items() if " " not in abbr}

    for dept in cfg["departments"]:
        for cid, c in catalog.dept(dept)["courses"].items():
            node = dict(c, role="main", **parse_requirements(c["text"], aliases))
            node["reviewed"] = verified.get(cid) == c["text"]
            if cid in overrides:
                o = overrides[cid]
                node.update({k: v for k, v in o.items() if k not in ("why", "text")})
                node["reviewed"] = o.get("text") == c["text"]
                if not node["reviewed"]:
                    issues["stale_overrides"].append(cid)
            if c["text"] and not node["reviewed"]:
                issues["unreviewed"].append(cid)
            nodes[cid] = node

    # Majors and minors students can pick (alone or combined) on this map. A
    # degree with a school core ("core") gets its math, foundations and design lists.
    programs = []
    for pid in cfg.get("programs", []):
        p = config["programs"][pid]
        url = config["catalog"] + p["path"]
        lists, notes = parse_program(fetcher.get(url), without_comments(p.get("labels", {})), until=p.get("until"))
        if p.get("core"):
            core = config["cores"][p["core"]]
            lists = merge_core(lists, core_lists(fetcher.get(config["catalog"] + core["path"]),
                                                 without_comments(core.get("labels", {})), core["container"]))
        programs.append({"id": pid, "name": p["name"], "type": p["type"], "url": url,
                         "default": pid in cfg.get("defaultPrograms", []), "lists": lists, "notes": notes})
        if not lists:
            issues["empty_programs"].append(pid)

    # Pull in every course referenced by a prerequisite or listed in a program.
    wanted = set()
    for n in list(nodes.values()):
        wanted |= set(codes_in(n["prereq"]) + codes_in(n["coreq"]) + n["recommended"])
    for p in programs:
        wanted |= {c for c in program_courses(p["lists"]) if catalog.course(c)}
    for cid in sorted(wanted - nodes.keys()):
        c = catalog.course(cid)
        if c:
            nodes[cid] = dict(c, role="external")
        else:
            dept, num = cid.split(" ")
            nodes[cid] = {"dept": dept, "num": num, "title": "", "units": None, "text": "", "desc": "",
                          "role": "external", "missing": True}
            issues["placeholders"].append(cid)

    # Courses from other departments: only keep links to courses already on the map.
    # They stay out of `prereq` (this map doesn't check them), but when their
    # prerequisites were checked by hand on another map (overrides, verified) or
    # the sentence is plain enough to parse reliably, the tree is kept as
    # `auto_prereq` so the site can tell students whether they can take it yet.
    for cid, n in nodes.items():
        if n["role"] == "external":
            reqs = parse_requirements(n["text"], aliases)
            fixed = overrides.get(cid, {})
            checked = verified.get(cid) == n["text"] or (fixed.get("text") == n["text"])
            if fixed.get("text") == n["text"]:
                reqs.update({k: v for k, v in fixed.items() if k in ("prereq", "coreq")})
            linked = set(codes_in(reqs["prereq"]) + codes_in(reqs["coreq"]))
            n.update(prereq=None, coreq=None, recommended=[], notes=[], reviewed=False,
                     links=sorted(linked & nodes.keys() - {cid}))
            if checked or is_plain(n["text"], aliases):
                n["auto_prereq"] = reqs["prereq"]

    quarters = []
    sched = cfg.get("schedule")
    if sched and sched["format"] == "mccormick":
        quarters, rows = parse_mccormick_schedule(fetcher.get(sched["url"]))
        issues["unmatched"] = match_schedule(nodes, rows, sched.get("aliases", {"211": "COMP_SCI 211-0"}))

    issues["cycles"] = find_cycles(nodes)
    order = {"main": 0, "external": 1}
    courses = []
    for cid in sorted(nodes, key=lambda k: (order[nodes[k]["role"]], k)):
        n = nodes[cid]
        rec = {
            "id": cid, "dept": n["dept"], "num": n["num"], "title": n["title"], "units": n["units"],
            "role": n["role"], "prereq": n.get("prereq"), "coreq": n.get("coreq"),
            "recommended": n.get("recommended", []), "notes": n.get("notes", []),
            "desc": n.get("desc", ""), "text": n["text"], "reviewed": n.get("reviewed", False),
            "offered": n.get("offered", {}), "url": catalog.url(cid),
        }
        if n.get("links"):
            rec["links"] = n["links"]
        if n.get("missing"):
            rec["missing"] = True
        elif "auto_prereq" in n:
            rec["autoPrereq"] = n["auto_prereq"]
        courses.append(rec)

    depts = {}
    for n in nodes.values():
        info = catalog.dept(n["dept"])
        depts[n["dept"]] = {
            "name": info["name"] if info else n["dept"],
            "abbr": config["abbreviations"].get(n["dept"], n["dept"]),
            "main": n["dept"] in cfg["departments"],
        }

    data = {
        "id": cfg["id"],
        "name": cfg["name"],
        "generated": datetime.date.today().isoformat(),
        "catalogYear": catalog.year,
        "quarters": quarters,
        "departments": dict(sorted(depts.items(), key=lambda kv: (not kv[1]["main"], kv[0]))),
        "programs": programs,
        "sources": ([f"{config['catalog']}/undergraduate/courses-az/{d.lower()}/" for d in cfg["departments"]]
                    + [p["url"] for p in programs] + ([sched["url"]] if sched else [])),
        "courses": courses,
    }
    return data, issues


def find_cycles(nodes):
    graph = {cid: set(codes_in(n.get("prereq")) + codes_in(n.get("coreq")) + n.get("links", []))
             for cid, n in nodes.items()}
    cycles, state = [], {}

    def visit(v, path):
        state[v] = 1
        for w in graph.get(v, ()):
            if state.get(w) == 1:
                cycles.append(" -> ".join(path[path.index(w):] + [w]))
            elif w not in state:
                visit(w, path + [w])
        state[v] = 2

    for v in graph:
        if v not in state:
            visit(v, [v])
    return cycles


# ---------------------------------------------------------------------------

def fmt(tree, top=True):
    if tree is None:
        return "-"
    if isinstance(tree, str):
        return tree
    op = next(iter(tree))
    s = f" {op.upper()} ".join(fmt(t, False) for t in tree[op])
    return s if top else f"({s})"


def write_report(path, results):
    lines = ["# Data review", ""]
    for data, issues in results:
        by_id = {c["id"]: c for c in data["courses"]}
        lines += [f"## {data['name']} (`{data['id']}`)", "",
                  f"{len(data['courses'])} courses, catalog {data['catalogYear']}.", ""]
        if issues["unreviewed"]:
            lines += ["### Prerequisites to check", "",
                      "Compare each parse with the catalog text. Fix wrong ones in `scraper/overrides.json`, "
                      "then run `python scraper/scrape.py --mark-verified`.", ""]
            for cid in issues["unreviewed"]:
                c = by_id[cid]
                lines += [f"- **{cid}**: {c['text']}",
                          f"  - parsed: prereq `{fmt(c['prereq'])}`, coreq `{fmt(c['coreq'])}`, notes {c['notes']}"]
            lines.append("")
        for key, title in [("empty_programs", "Program pages where no course lists were found"),
                           ("stale_overrides", "Overrides written against older catalog text"),
                           ("placeholders", "Referenced courses missing from the catalog"),
                           ("cycles", "Prerequisite cycles"),
                           ("unmatched", "Schedule rows not matched to a course")]:
            if issues[key]:
                lines += [f"### {title}", ""] + [f"- {x}" for x in issues[key]] + [""]
    pathlib.Path(path).write_text("\n".join(lines))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", type=pathlib.Path, help="directory to save/reuse raw HTML")
    ap.add_argument("--map", action="append", help="only build this map id (repeatable)")
    ap.add_argument("--report", help="write a markdown review summary here")
    ap.add_argument("--mark-verified", action="store_true",
                    help="record every current prereq text as hand-checked (only after reviewing!)")
    args = ap.parse_args()

    config = load_json(HERE / "config.json")
    overrides = without_comments(load_json(HERE / "overrides.json", {}))
    verified = load_json(HERE / "verified.json", {})
    fetcher = Fetcher(args.cache)
    catalog = Catalog(config["catalog"], fetcher)

    DATA.mkdir(exist_ok=True)
    index = load_json(DATA / "maps.json", {"maps": []})
    entries = {m["id"]: m for m in index["maps"]}
    results = []
    for cfg in config["maps"]:
        if args.map and cfg["id"] not in args.map:
            continue
        print(f"building {cfg['id']}...", file=sys.stderr)
        data, issues = build_map(cfg, config, catalog, fetcher, overrides, verified)
        (DATA / f"{cfg['id']}.json").write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
        entries[cfg["id"]] = {"id": cfg["id"], "name": cfg["name"], "file": f"{cfg['id']}.json",
                              "courses": len(data["courses"]), "catalogYear": data["catalogYear"],
                              "generated": data["generated"]}
        results.append((data, issues))
        print(f"  {len(data['courses'])} courses -> data/{cfg['id']}.json", file=sys.stderr)
        for key, items in issues.items():
            if items:
                print(f"  {key}: {', '.join(items[:12])}{' ...' if len(items) > 12 else ''}", file=sys.stderr)

    order = [m["id"] for m in config["maps"]]
    index = {"maps": sorted(entries.values(), key=lambda m: order.index(m["id"]) if m["id"] in order else 99)}
    (DATA / "maps.json").write_text(json.dumps(index, indent=1) + "\n")

    if args.mark_verified:
        for data, _ in results:
            for c in data["courses"]:
                if c["role"] == "main" and c["text"] and c["id"] not in overrides:
                    verified[c["id"]] = c["text"]
        (HERE / "verified.json").write_text(json.dumps(verified, indent=1, sort_keys=True) + "\n")
        print(f"verified.json now has {len(verified)} entries", file=sys.stderr)
    if args.report:
        write_report(args.report, results)


if __name__ == "__main__":
    main()
