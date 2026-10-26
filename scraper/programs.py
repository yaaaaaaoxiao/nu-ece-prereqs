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

McCormick degree pages start with a "Core Courses" section shared by every
engineering degree. Its lists get kind "core" and a common label per area
(CORE_AREAS), so the school-wide page can fill in the areas a degree page only
names (see core_lists and merge_core).
"""

import re

from bs4 import BeautifulSoup

from prereqs import CODE_RE, clean

# The school-wide part of a degree page, and the label each of its areas gets.
CORE_SECTION = "Core Courses"
CORE_AREAS = (("math", "Mathematics"), ("science", "Basic science"), ("foundation", "Engineering foundations"),
              ("design", "Design and writing"))
NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8}


def heading(text):
    """Strip footnote markers and trailing colons from a heading."""
    return re.sub(r"[\s:]*\d+(,\d+)*$|:$", "", clean(text.replace("\u200b", ""))).strip()


def core_area(header):
    """'4 mathematics courses' -> 'Mathematics'; None for areas without courses to list."""
    lower = header.lower()
    return next((label for key, label in CORE_AREAS if key in lower), None)


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


def parse_program(html, labels=None, container="textcontainer", until=None, major_from=None):
    """labels maps a heading to what the site shows: a new label, None to ignore
    that list, or {"label", "kind", "need", "flatten"} to correct how a list is
    read ("flatten": rows the catalog marks "or" are separate choices). Reading
    stops at a heading starting with `until` (optional extras such as concentrations).
    `major_from` names the first heading of the major's own courses, for pages
    that put them under the core section's heading."""
    labels = labels or {}
    container = BeautifulSoup(html, "html.parser").find(id=container)
    lists, notes = [], []
    section = header = ""
    key, current = None, None
    headers_with_items = set()
    candidates = []  # headings that may turn out to be notes
    started = False  # rule sentences only count once the requirements begin

    for el in container.find_all(["h2", "h3", "h4", "tr", "p"]):
        if el.name == "p":
            text = clean(el.get_text(" "))
            if (started and re.search(r"\b(must|minimum)\b", text, re.I) and len(text) < 250
                    and not el.find_parent(["table", "dl"])):
                notes.append(text)
            continue
        started = True
        if el.name != "tr":
            section, header = heading(el.get_text(" ")), ""
            if until and section.startswith(until):
                break
            if not section.startswith(CORE_SECTION):
                candidates.append(section)
            continue
        in_core = section.startswith(CORE_SECTION)
        cls = el.get("class") or []
        if "areaheader" in cls or "areasubheader" in cls:
            header = heading(el.get_text(" "))
            if major_from and header.startswith(major_from):
                section, in_core = "Major Program", False
            if not in_core:
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
        if in_core:
            if not core_area(title):
                continue
            title = core_area(title)
        if (section, header) != key:
            key = (section, header)
            spec = labels.get(title, {"label": title, "kind": "core"} if in_core else title)
            fix = spec if isinstance(spec, dict) else {}
            label = fix.get("label", title) if isinstance(spec, dict) else spec
            current = None
            if label:
                label = label[:1].upper() + label[1:]
                current = next((l for l in lists if l["label"] == label), None)
                if not current:
                    current = {"label": label, "kind": fix.get("kind") or classify(label, bool(header)),
                               "need": fix.get("need", need_from(header if in_core else title)), "items": [],
                               "flatten": fix.get("flatten", False)}
                    lists.append(current)
        headers_with_items.add(title)
        if current is None:
            continue
        if "orclass" in cls and current["items"] and not current["flatten"]:
            current["items"][-1].append(codes)
        else:
            current["items"].append([codes])

    for lst in lists:
        del lst["flatten"]
        n = len(lst["items"])
        if lst["kind"] in ("required", "prereq", "core") or n == 1:
            lst["need"] = min(lst["need"] or n, n)
        elif lst["need"] is not None:
            lst["need"] = min(lst["need"], n)
    # Headings that had no courses of their own but state a count are rules to read.
    for text in candidates:
        if (text not in headers_with_items and re.search(r"\d", text) and text not in notes
                and labels.get(text, "") is not None and not text.startswith("Requirements (")):
            notes.append(text)
    return lists, list(dict.fromkeys(notes))


def core_lists(html, labels, container):
    """The school-wide core requirements page, as lists labeled like CORE_AREAS."""
    lists, _ = parse_program(html, labels, container)
    return [lst for lst in lists if lst["kind"] == "core"]


def merge_core(lists, core):
    """A degree page's lists with the school core first; areas the degree page
    lists courses for itself (CS math, each degree's science) keep its version."""
    own = {lst["label"]: lst for lst in lists if lst["kind"] == "core"}
    merged = [own.pop(lst["label"], lst) for lst in core] + list(own.values())
    order = [label for _, label in CORE_AREAS]
    merged.sort(key=lambda lst: order.index(lst["label"]) if lst["label"] in order else len(order))
    return merged + [lst for lst in lists if lst["kind"] != "core"]


def program_courses(lists):
    return [c for lst in lists for item in lst["items"] for alt in item for c in alt]
