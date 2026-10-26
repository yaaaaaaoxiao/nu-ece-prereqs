"""Turn a catalog prerequisite sentence into an expression tree.

    tree := "DEPT NNN-N" | {"and": [tree, ...]} | {"or": [tree, ...]}

The catalog writes prerequisites as free text ("A or B; C recommended",
"(A and B), or C, or instructor consent"), so this is a heuristic parser.
Conditions that are not courses (consent, standing, "or equivalent") are
pulled out as notes. Anything it gets wrong is fixed in overrides.json.
"""

import re

CODE_RE = re.compile(r"\b([A-Z][A-Z_]+) (\d{3}-\d)\b")

# (pattern, note); note=None means drop the phrase without recording it.
NOTE_PATTERNS = [
    (r"\bor (?:the )?(?:consent|permission) of (?:the )?instructor", "or instructor consent"),
    (r"\b(?:consent|permission) of (?:the )?instructor", "instructor consent"),
    (r"\bor instructor (?:consent|permission)", "or instructor consent"),
    (r"\bor graduate standing", "or graduate standing"),
    (r"\bsenior standing", "senior standing"),
    (r"\bjunior standing", "junior standing"),
    (r"\bor equivalent", "or equivalent"),
    (r"\bCE or EE majors? only", "CE or EE majors only"),
    (r"\band basic programming skills", "basic programming skills"),
    (r"Students must have completed", None),
    (r"Basic probability theory", None),
]


def clean(text):
    return re.sub(r"\s+", " ", text).strip()


# The catalog's source has "?" where a character was lost. Put back what's
# clear from context; a "?" that may be a real question mark stays.
LOST_CHARACTERS = [
    (r"(?<=[A-Za-z])\?(?=(?:s|t|ll|re|ve|d|m)\b)", "’"),  # China?s, doesn?t, You?ll
    (r"(?<=s)\?(?= [a-z])", "’"),  # materials? performance
    (r"(?<![\w?])\?(?=\w)([^?]{1,60}?)(?<=[\w.!])\?(?=[\s.,;:)\]]|$)", "“\\1”"),  # ?life as it could be?
    (r"(?<= )\?(?=\w)", ""),  # an opening quote whose closing one is gone: World ?Wide Web
    (r" \? ", " — "),  # challenges ? including
    (r"\?(?= [A-Z_]{3,} \d{3})", ""),  # with or after? COMP_SCI 111-0
    (r"(?<=[.;:,)])\s*\?\s*", " "),  # calculus.?Students
    (r"(?<=[A-Za-z])\?(?=[a-z])", " "),  # as?time, Part I?deals
]


def tidy(text):
    """Catalog prose (titles, descriptions) with lost characters put back and
    the spaces around linked course codes ("MATH 218-1 , MATH 218-2 .") closed up."""
    for pattern, repl in LOST_CHARACTERS:
        text = re.sub(pattern, repl, text)
    text = re.sub(r"\s+([.,;:!?)\]])", r"\1", text)
    return clean(re.sub(r"([(\[])\s+", r"\1", text))


def normalize_codes(text, aliases):
    """'CS 214' / 'Comp_sci 208' / 'COMP_SCI 180_0' -> 'COMP_SCI 214-0' etc.

    aliases maps short names to catalog codes, e.g. {"CS": "COMP_SCI"}.
    """
    def fix(m):
        word, num, seq = m.groups()
        dept = word.upper()
        if dept in aliases:
            dept = aliases[dept]
        elif not ("_" in word or (word.isupper() and len(word) > 2)):
            return m.group(0)  # an ordinary word that happens to precede a number
        return f"{dept} {num}-{seq or '0'}"

    return re.sub(r"\b([A-Za-z][A-Za-z_]+) (\d{3})(?:[-_](\d))?(?![\d-])", fix, text)


def strip_exclusions(text):
    """Drop sentences like 'Students cannot concurrently be enrolled in X' or
    'may not receive credit for both X and Y' - they name courses but aren't prerequisites."""
    sentences = re.split(r"(?<=\.)\s+(?=[A-Z])", text)
    keep = [s for s in sentences
            if not re.search(r"\b(cannot|may not|not receive credit|not open to|not be taken)\b", s, re.I)]
    return " ".join(keep)


def tokenize(text):
    tokens = []
    for m in re.finditer(r"[A-Z][A-Z_]+ \d{3}-\d|\(|\)|;|,|&|\band\b|\bor\b", text, re.I):
        t = m.group(0)
        if CODE_RE.fullmatch(t):
            tokens.append(("CODE", t))
        elif t in "();,":
            tokens.append((t, t))
        elif t == "&" or t.lower() == "and":
            tokens.append(("and", t))
        else:
            tokens.append(("or", t))
    return resolve_commas(drop_remarks(tokens))


def drop_remarks(tokens):
    """Remove parentheses that hold no course, such as '(former)' or '(C- or better)'."""
    out, opens = [], []
    for tok in tokens:
        if tok[0] == "(":
            opens.append(len(out))
            out.append(tok)
        elif tok[0] == ")" and opens:
            start = opens.pop()
            if any(kind == "CODE" for kind, _ in out[start + 1:]):
                out.append(tok)
            else:
                del out[start:]
        else:
            out.append(tok)
    return out


def resolve_commas(tokens):
    """Commas mean OR in lists like 'A, B, or C' and AND in 'A, B'."""
    out = []
    for i, tok in enumerate(tokens):
        # ", or" -> "or"
        if tok[0] == "," and i + 1 < len(tokens) and tokens[i + 1][0] == "or":
            continue
        out.append(tok)
    # Decide separately for each parenthesis level, and within it for each
    # part between semicolons ("A, B, or C; D" is "(A or B or C) and D").
    stack, levels = [[]], []
    for idx, (kind, _) in enumerate(out):
        if kind == "(":
            stack.append([])
        elif kind == ")" and len(stack) > 1:
            levels.append(stack.pop())
        else:
            stack[-1].append(idx)
    levels.extend(stack)
    for level in levels:
        part = []
        for i in level + [None]:
            if i is not None and out[i][0] != ";":
                part.append(i)
                continue
            kinds = {out[j][0] for j in part}
            as_or = "or" in kinds and "and" not in kinds
            for j in part:
                if out[j][0] == ",":
                    out[j] = ("or" if as_or else "and", ",")
            part = []
    return out


class _Parser:
    """Precedence, loosest first: ';'  then 'or'  then 'and' / ','."""

    def __init__(self, tokens):
        self.t, self.i = tokens, 0

    def peek(self):
        return self.t[self.i][0] if self.i < len(self.t) else None

    def take(self):
        self.i += 1
        return self.t[self.i - 1]

    def semi(self):
        parts = [self.or_()]
        while self.peek() == ";":
            self.take()
            parts.append(self.or_())
        return combine("and", parts)

    def or_(self):
        parts = [self.and_()]
        while self.peek() == "or":
            self.take()
            parts.append(self.and_())
        return combine("or", parts)

    def and_(self):
        parts = [self.atom()]
        while self.peek() == "and":
            self.take()
            parts.append(self.atom())
        return combine("and", parts)

    def atom(self):
        # Skip stray separators left behind after notes were removed.
        while self.peek() in ("and", "or", ";"):
            self.take()
        kind = self.peek()
        if kind == "CODE":
            return self.take()[1]
        if kind == "(":
            self.take()
            node = self.semi()
            if self.peek() == ")":
                self.take()
            return node
        return None


def combine(op, parts):
    flat = []
    for p in parts:
        if p is None:
            continue
        for item in (p[op] if isinstance(p, dict) and op in p else [p]):
            if item not in flat:
                flat.append(item)
    if not flat:
        return None
    return flat[0] if len(flat) == 1 else {op: flat}


def parse_expression(text):
    return _Parser(tokenize(text)).semi()


def parse_requirements(raw, aliases=None):
    """Split a catalog line into prereq / coreq trees, recommended courses and notes."""
    result = {"prereq": None, "coreq": None, "recommended": [], "notes": []}
    text = normalize_codes(strip_exclusions(raw), aliases or {})
    parts = re.split(r"(Prerequisites?|Corequisites?)\s*:", text)
    for label, body in zip(parts[1::2], parts[2::2]):
        body = clean(body).rstrip(".")
        key = "coreq" if label.lower().startswith("co") else "prereq"
        kept = []
        for seg in body.split(";"):
            if "recommended" in seg.lower():
                result["recommended"] += [" ".join(c) for c in CODE_RE.findall(seg)]
            else:
                kept.append(seg)
        body = ";".join(kept)
        for pattern, note in NOTE_PATTERNS:
            if re.search(pattern, body, re.I):
                if note and note not in result["notes"]:
                    result["notes"].append(note)
                body = re.sub(pattern, " ", body, flags=re.I)
        result[key] = parse_expression(body)
    return result


def is_plain(raw, aliases=None):
    """True when the prerequisite part of a catalog line is only course codes
    joined by and/or, semicolons and parentheses (or there is none). Those parse
    reliably without a hand check; commas, notes and other words don't."""
    text = normalize_codes(strip_exclusions(raw), aliases or {})
    if not text.strip():
        return True
    parts = re.split(r"(Prerequisites?|Corequisites?)\s*:", text)
    bodies = [body for label, body in zip(parts[1::2], parts[2::2]) if label.lower().startswith("pre")]
    if len(parts) < 3 or any(re.search(p, text, re.I) for p, _ in NOTE_PATTERNS):
        return False
    for body in bodies:
        body = ";".join(s for s in body.split(";") if "recommended" not in s.lower())
        rest = re.sub(r"\(former\)|\b(?:and|or)\b|[&();.\s]", "", CODE_RE.sub("", body), flags=re.I)
        if rest:
            return False
    return True


def codes_in(tree):
    if tree is None:
        return []
    if isinstance(tree, str):
        return [tree]
    return [c for sub in next(iter(tree.values())) for c in codes_in(sub)]
