# Course Prerequisite Map

An interactive map of course prerequisites for Northwestern majors: Electrical &
Computer Engineering, Computer Science, and Materials Science & Engineering. Click a course to see everything it
requires and everything it unlocks, mark what you've taken to see what you can
take next, and highlight a degree requirement, technical track or quarter.

**Live site:** <https://yaaaaaaoxiao.github.io/nu-ece-prereqs/>

> Unofficial student project, not affiliated with Northwestern University.
> Always confirm prerequisites with the [official catalog](https://catalogs.northwestern.edu/)
> and your adviser.

## Features

- **The whole picture:** courses sit in columns by department and rows by prerequisite
  step (each course one row below its last prerequisite on the map, so MATH 228-2 sits
  above the courses that need it), with every link drawn, so chains are visible at a
  glance. The legend can switch rows to course levels (100, 200, 300) instead. Each course shows how many courses on the map it leads to
  (the badge gets darker the more it opens up) and the quarters it's offered this
  year (**F W S**, dark where it runs), the panel lists the map's gateway courses,
  and a minimap helps when zoomed in.
- **Prerequisite chains:** selecting a course lights up its full chain of prerequisites
  (violet) and every course it leads to (orange). Dashed links mean "one of several options".
- **Your plan on the map:** courses you've taken are solid blue, planned ones dashed
  blue (with their quarter), courses you can take now are green, and a planned course
  that needs a check is amber. Each status has its own icon too. Links out of courses
  you've taken turn blue, so you can see what they opened up.
- **Mark several at once:** Shift-click (or Cmd/Ctrl-click) courses, Shift-drag a box
  around them, long-press on a touch screen, or press **Mark courses**; then mark them
  taken or planned, or put them in a quarter, from the panel. A course's panel can
  also select it together with everything it requires. <kbd>T</kbd> <kbd>P</kbd>
  <kbd>N</kbd> mark the selection (or the focused course), and every change can be
  undone (Undo, or Cmd/Ctrl+Z).
- **Path to a course:** a course's panel shows how many courses you still need
  for it and the soonest quarter you could take it. **Show the path** outlines them
  on the map in violet, each with its quarter, and lists them quarter by quarter;
  **Add to my plan** plans them all. It starts from what you've taken, picks the
  usual option where one of several will do (or the one you've planned), and fills
  quarters from the next one using the current schedule, at most 2 to 5 courses a
  quarter (your choice) counting what's already planned.
- **Planner:** lay out future quarters in the **Plan** tab (add with "+ Add", drag
  between quarters). It warns when a prerequisite isn't done before the quarter you
  planned, a corequisite is missing, or the course wasn't offered in that quarter on
  the current schedule. Everything is saved in your browser only.
- **Majors and minors together:** pick any combination of majors and minors with the
  button at the top (e.g. Electrical Engineering BS + Materials Science and Engineering BS,
  or EE BS + Computer Science minor). The map shows every course in your majors'
  departments plus your minors' courses, combined from each program's map. The Plan
  tab shows each program's requirement lists checked against your plan, and flags
  courses that count toward more than one. It's a checklist from the catalog, not an
  official degree audit.
- **Highlights:** degree requirements, technical tracks/areas, and what's offered each quarter.
- **Search** by number or title (`EE 221`, `ce303`, `signals`).
- **List view:** an accessible, phone-friendly alternative to the graph, with a plan
  status on every row (Shift-click rows to select several here too).
- **Shareable links:** the URL keeps the selected course, highlight and view
  (e.g. `?course=ELEC_ENG+222-0`). Back/forward work.
- Keyboard support, dark mode, phone layout.

## Run it locally

The site is static (HTML, CSS, JavaScript modules, JSON). Browsers block
`fetch()` and modules from `file://`, so serve the folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Project layout

```
index.html              page shell
assets/css/style.css    all styles (light/dark tokens at the top)
assets/js/
  main.js               state, URL sync, wiring
  model.js              data model: edges, chains, search, programs, progress
  plan.js               the viewer's plan: statuses, quarters, prerequisite checks
  path.js               path to a course: fewest courses still needed, by quarter
  graph.js              layout (prerequisite steps or levels) + SVG, pan/zoom, keyboard nav
  panel.js              details panel
  list.js               list view
  planview.js           Plan tab: programs, quarter grid, requirements checklist
  search.js             search combobox
  store.js              localStorage preferences
data/
  maps.json             index of available maps (read by the site)
  ece.json              one file per map (generated, don't edit by hand)
scraper/
  config.json           which maps to build: departments, degree pages, schedule
  scrape.py             builds data/*.json from the catalog
  prereqs.py            prerequisite-sentence parser
  programs.py           major/minor requirement-list parser
  test_*.py             parser tests
  overrides.json        hand corrections for prerequisites the parser gets wrong
  verified.json         catalog text of prerequisites that were checked by hand
```

The graph uses [d3](https://d3js.org/) for rendering and pan/zoom, loaded from
jsDelivr with a pinned version and integrity hash. No build step.

**How the graph is laid out.** Each row is a course level (100, 200, 300, …)
and each column a department; "Other departments" goes wherever it makes links
shortest (for ECE, between CE and EE). Within a level, a course that needs
another course of the same level sits in a lower tier, and tiers line up across
departments, so every link runs downward. Inside a tier, each course takes the
free slot closest to its prerequisites and to what it unlocks, so chains stack
vertically; courses with no links on the map are drawn quieter at the bottom of
their cell. Links: a short drop to a course directly below, a "comb" down the
gutter beside a column, or an S-curve between columns. At rest, required links
are strongest, "one of several" options lighter and other departments' own
links faint; hovering or selecting a course brings its links forward. The
number of card columns per department is chosen to fit the screen, and a
minimap appears when part of the map is off screen. Zoomed in, a card's title
runs over two lines; zoomed out, cards show just the course code (large) and
status icon, leaving the title, quarters and "leads to" count for zooming in.

## Updating the data

```bash
pip install -r scraper/requirements.txt
python scraper/scrape.py --cache .cache --report report.md
```

`--cache` saves the downloaded pages so re-runs are instant (delete `.cache/` to
re-download). The scraper reads course pages, degree pages and the department
schedule, then writes `data/<map>.json` and `data/maps.json`.

**Reviewing prerequisites.** The catalog writes prerequisites as free text
("A or B; C recommended", "(A and B), or C, or instructor consent"), so the
parser is a heuristic. Every course's exact catalog text is compared with
`verified.json`; any course whose text is new or changed is listed in the report
as needing a check. For each one:

1. Compare the parsed result in the report with the catalog text.
2. If it's wrong, add an entry to `scraper/overrides.json` (see the examples there)
   including the `text` it was written against.
3. When everything listed is right, run
   `python scraper/scrape.py --cache .cache --mark-verified`.

The site shows each course's catalog text and whether it was checked by hand.

Courses from other departments (MATH, PHYSICS, COMP_SCI, ...) aren't reviewed.
Their prerequisites become faint "other department" links, and when the sentence
is plain (only course codes joined by and/or, no commas, notes or other words)
the parsed tree is kept as `autoPrereq` so the site can show whether a student
can take the course yet. Other sentences are too ambiguous to read reliably
("MATH 220-1, MATH 220-2, MATH 230-1 or MATH 290-1, PHYSICS 135-1"), so those
courses never show "can take now".

Parser tests: `python -m unittest discover scraper`

## Adding majors, minors and maps

**A major or minor** is an entry in `programs` in `scraper/config.json`:

```json
"cs-minor": {
  "name": "Computer Science minor (McCormick)",
  "type": "minor",
  "path": "/undergraduate/engineering-applied-science/computer-science/computer-science-minor/",
  "labels": { "3 engineering foundations courses": { "label": "Prerequisites: engineering foundations", "kind": "prereq" } }
}
```

List its id in a map's `programs` so students on that map can pick it (alone or
combined with others); `defaultPrograms` are shown when a student hasn't picked
any. The scraper reads the program page's course tables into requirement lists,
keeping "or" alternatives, "&" sequences and counts such as "(choose one)" or
"4 courses chosen from…". Rules the catalog only states in prose ("one course
from each of any three areas") are kept as notes for students to read. Use
`labels` to rename a list, hide it (`null`), or correct how it's read
(`{"label", "kind", "need", "flatten"}`; `flatten` treats rows the catalog
marks "or" as separate choices, for long lists formatted that way). `until`
stops reading the page at a heading, e.g. `"Concentrations"` for optional
extras whose headings repeat the requirement areas' names. Check the result in
the Plan tab.

McCormick degrees share a school core (math, science, engineering foundations,
design and writing, speaking). Degree pages often only name those areas, so a
program with `"core": "mccormick"` gets the core lists from the school's
requirements page (`cores` in the config); where the degree page lists courses
for an area itself (each degree's science, the CS math sequence), its list wins.

**A map** (another department's graph) is an entry in `maps`:

```json
{
  "id": "cs",
  "name": "Computer Science",
  "departments": ["COMP_SCI"],
  "programs": ["cs-bs", "cs-minor"],
  "defaultPrograms": ["cs-bs"]
}
```

- `departments` are catalog codes; their courses are the map's main nodes.
  Courses from other departments that they require are pulled in automatically,
  and so are the courses listed by its programs.
- `schedule` (optional) is a department schedule page. Only the McCormick
  format is supported so far (`"format": "mccormick"`).
- Add short names for new departments to `abbreviations` so nodes read "CS 214".

- Give each program a `short` name for the programs button ("EE BS").

Run the scraper, review the flagged prerequisites as above, and the map's
programs appear in the site's programs dialog (`data/maps.json` lists each map's
departments and programs). A major's map is the one listing it in
`defaultPrograms`; choosing majors from several maps combines them in the
browser (`combineData` in `model.js`). The site needs no changes.

## Deploying to GitHub Pages

1. Create a repository on GitHub and push this folder to it.
2. In the repository's **Settings → Pages**, set the source to the `main` branch, root folder.
3. The site appears at `https://<username>.github.io/<repository>/`.

"Report a problem" links on each course open a prefilled GitHub issue. The
repository is detected automatically on `github.io`; for a custom domain set
`REPO` at the top of `assets/js/main.js`.

## Automatic updates

`.github/workflows/update-data.yml` re-runs the scraper on the 1st of each month
(or on demand from the **Actions** tab) and opens a pull request when the data
changed, with the review report as its description. It needs **Settings →
Actions → General → Allow GitHub Actions to create and approve pull requests**.
`.github/workflows/ci.yml` runs the parser tests on every push.

## Data sources

- [Undergraduate catalog, COMP_ENG courses](https://catalogs.northwestern.edu/undergraduate/courses-az/comp_eng/)
- [Undergraduate catalog, ELEC_ENG courses](https://catalogs.northwestern.edu/undergraduate/courses-az/elec_eng/)
- [Electrical Engineering degree](https://catalogs.northwestern.edu/undergraduate/engineering-applied-science/electrical-computer-engineering/electrical-engineering-degree/)
  and [Computer Engineering degree](https://catalogs.northwestern.edu/undergraduate/engineering-applied-science/electrical-computer-engineering/computer-engineering-degree/)
- [Undergraduate catalog, COMP_SCI courses](https://catalogs.northwestern.edu/undergraduate/courses-az/comp_sci/)
  and [MAT_SCI courses](https://catalogs.northwestern.edu/undergraduate/courses-az/mat_sci/)
- [Computer Science BS](https://catalogs.northwestern.edu/undergraduate/engineering-applied-science/computer-science/computer-science-degree/),
  [Computer Science BA](https://catalogs.northwestern.edu/undergraduate/arts-sciences/computer-science/computer-science-major/)
  and [Materials Science and Engineering BS](https://catalogs.northwestern.edu/undergraduate/engineering-applied-science/materials-science-engineering/materials-science-engineering-degree/)
- [McCormick degree requirements](https://catalogs.northwestern.edu/undergraduate/engineering-applied-science/#requirementstext) (the school core)
- Course schedules for [ECE](https://www.mccormick.northwestern.edu/electrical-computer/academics/courses/),
  [CS](https://www.mccormick.northwestern.edu/computer-science/academics/courses/)
  and [MSE](https://www.mccormick.northwestern.edu/materials-science/academics/courses/)

Course descriptions are shown as the catalog has them, apart from characters
the catalog's source lost (it has "?" for some apostrophes, dashes and quotes,
put back by `tidy()` in `scraper/prereqs.py`); each course links to its catalog entry.
