"""Read the requirement lists of a catalog major/minor page.

Catalog program pages are tables of courses under headings. A page becomes:

    lists: [{label, kind, need, items}]   in page order
    notes: ["6 courses chosen from the technical elective tracks below", ...]

Each item is one requirement: a list of alternatives ("or" rows), each of which
is a list of courses taken together (a sequence such as MATH 220-1 & 220-2):

    [["COMP_SCI 180-0"], ["COMP_SCI 111-0"]]   CS 180 or CS 111
    [["MATH 220-1", "MATH 220-2"]]              MATH 220-1 and 220-2

`need` is how many items the list asks for when the heading says so ("choose
one", "4 courses chosen...", "(2 units)"), else None. Rules the catalog only
states in prose ("one course from each of any three areas") are kept as notes
for people to read; they aren't enforced.
"""

import re

from bs4 import BeautifulSoup

from prereqs import CODE_RE, clean

# Degree-page sections that are school-wide (math/science core), not part of the major.
SKIP_SECTIONS = ("Core Courses",)
NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8}


def heading(text):
    """Strip footnote markers and trailing colons from a heading."""
    return re.sub(r"[\s:]*\d+(,\d+)*$|:$", "", clean(text)).strip()


def need_from(text):
    t = text.lower()
    m = re.search(r"choose (\w+)", t)
    if m and (m.group(1).isdigit() or m.group(1) in NUMBER_WORDS):
        return int(m.group(1)) if m.group(1).isdigit() else NUMBER_WORDS[m.group(1)]
    m = re.match(r"(\d+)\s+(?:additional\s+)?(?:[a-z-]+\s+){0,3}?(?:courses?|units?)\b", t)
    if m:
        return int(m.group(1))
    m = re.search(r"\((\d+)\s+units?", t)
    return int(m.group(1)) if m else None


def classify(label, from_header):
    lower = label.lower()
    if lower.startswith("prerequisite"):
        return "prereq"
    if "required" in lower or lower.startswith(("core", "minor requirements", "major requirements")):
        return "required"
    if "design" in lower and from_header:
        return "design"
    return "elective" if from_header else "track"


def parse_program(html, labels=None):
    """labels maps a heading to what the site shows: a new label, None to ignore
    that list, or {"label", "kind", "need"} to correct how a list is read."""
    labels = labels or {}
    container = BeautifulSoup(html, "html.parser").find(id="textcontainer")
    lists, notes = [], []
    section = header = ""
    key, current = None, None
    headers_with_items = set()
    candidates = []  # headings that may turn out to be notes
    started = False  # rule sentences only count once the requirements begin

    for el in container.find_all(["h2", "h3", "tr", "p"]):
        if el.name == "p":
            text = clean(el.get_text(" "))
            if (started and re.search(r"\b(must|minimum)\b", text, re.I) and len(text) < 250
                    and not el.find_parent(["table", "dl"])):
                notes.append(text)
            continue
        started = True
        if el.name != "tr":
            section, header = heading(el.get_text(" ")), ""
            if not section.startswith(SKIP_SECTIONS):
                candidates.append(section)
            continue
        if section.startswith(SKIP_SECTIONS):
            continue
        cls = el.get("class") or []
        if "areaheader" in cls or "areasubheader" in cls:
            header = heading(el.get_text(" "))
            candidates.append(header)
            continue
        codecol = el.find("td", class_="codecol")
        codes = [" ".join(c) for c in CODE_RE.findall(clean(codecol.get_text(" ")))] if codecol else []
        if not codes:
            # A comment row such as "2 additional McCormick courses at 200-level or higher".
            text = clean(el.get_text(" "))
            if re.match(r"\d", text) and labels.get(header, "") is not None:
                notes.append(heading(text))
            continue

        title = header or section
        if (section, header) != key:
            key = (section, header)
            spec = labels.get(title, title)
            fix = spec if isinstance(spec, dict) else {}
            label = fix.get("label", title) if isinstance(spec, dict) else spec
            current = None
            if label:
                label = label[:1].upper() + label[1:]
                current = next((l for l in lists if l["label"] == label), None)
                if not current:
                    current = {"label": label, "kind": fix.get("kind") or classify(label, bool(header)),
                               "need": fix.get("need", need_from(title)), "items": []}
                    lists.append(current)
        headers_with_items.add(title)
        if current is None:
            continue
        if "orclass" in cls and current["items"]:
            current["items"][-1].append(codes)
        else:
            current["items"].append([codes])

    for lst in lists:
        n = len(lst["items"])
        if lst["kind"] in ("required", "prereq") or n == 1:
            lst["need"] = min(lst["need"] or n, n)
        elif lst["need"] is not None:
            lst["need"] = min(lst["need"], n)
    # Headings that had no courses of their own but state a count are rules to read.
    for text in candidates:
        if (text not in headers_with_items and re.search(r"\d", text) and text not in notes
                and labels.get(text, "") is not None and not text.startswith("Requirements (")):
            notes.append(text)
    return lists, list(dict.fromkeys(notes))


def program_courses(lists):
    return [c for lst in lists for item in lst["items"] for alt in item for c in alt]
