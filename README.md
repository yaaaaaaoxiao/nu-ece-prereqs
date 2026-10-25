# Course Prerequisite Map

An interactive map of course prerequisites for Northwestern majors, starting
with Electrical & Computer Engineering. Click a course to see everything it
requires and everything it unlocks, mark what you've taken to see what you can
take next, and highlight a degree requirement, technical track or quarter.

> Unofficial student project, not affiliated with Northwestern University.
> Always confirm prerequisites with the [official catalog](https://catalogs.northwestern.edu/)
> and your adviser.

## Features

- **Level rows:** courses sit in rows by level (100, 200, 300) and columns by department.
- **Prerequisite chains:** selecting a course lights up its full chain of prerequisites
  (violet) and every course it leads to (orange). Dashed links mean "one of several options".
- **Planner:** mark courses as taken (saved in your browser only) and courses whose
  prerequisites you've met get a green ring.
- **Highlights:** degree requirements, technical tracks/areas, and what's offered each quarter.
- **Search** by number or title (`EE 221`, `ce303`, `signals`).
- **List view:** an accessible, phone-friendly alternative to the graph, with checkboxes.
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
  model.js              data model: edges, chains, search, planner logic
  graph.js              level layout + SVG rendering, pan/zoom, keyboard nav
  panel.js              details panel
  list.js               list view
  search.js             search combobox
  store.js              localStorage preferences
data/
  maps.json             index of available maps (read by the site)
  ece.json              one file per map (generated, don't edit by hand)
scraper/
  config.json           which maps to build: departments, degree pages, schedule
  scrape.py             builds data/*.json from the catalog
  prereqs.py            prerequisite-sentence parser
  test_prereqs.py       parser tests
  overrides.json        hand corrections for prerequisites the parser gets wrong
  verified.json         catalog text of prerequisites that were checked by hand
```

The graph uses [d3](https://d3js.org/) for rendering and pan/zoom, loaded from
jsDelivr with a pinned version and integrity hash. No build step.

**How the graph is laid out.** Each row is a course level (100, 200, 300, …)
and each column a department (the map's own, then "Other departments"). Within
a level, a course that needs another course of the same level is placed in a
lower tier, so progressions like CE 303 → 355 → 387 read top to bottom. The
number of card columns per department is chosen to fit the screen. Links are
drawn on demand (hover, keyboard focus, selection, highlighted lists), or all at
once with "Show every link" in the legend.

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

Parser tests: `python -m unittest discover scraper`

## Adding another major

Add an entry to `maps` in `scraper/config.json`:

```json
{
  "id": "cs",
  "name": "Computer Science",
  "departments": ["COMP_SCI"],
  "degrees": [
    { "id": "CS", "name": "Computer Science BS",
      "path": "/undergraduate/engineering-applied-science/computer-science/computer-science-degree/" }
  ]
}
```

- `departments` are catalog codes; their courses are the map's main nodes.
  Courses from other departments that they require are pulled in automatically.
- `degrees` (optional) are catalog degree pages; their course lists become
  highlights. If a list heading reads oddly, rename or hide it with `groupLabels`.
- `schedule` (optional) is a department schedule page. Only the McCormick
  format is supported so far (`"format": "mccormick"`).
- Add short names for new departments to `abbreviations` so nodes read "CS 214".

Run the scraper, review the flagged prerequisites as above, and the new map
appears in the site's program menu. The site needs no changes.

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
- [ECE course schedule](https://www.mccormick.northwestern.edu/electrical-computer/academics/courses/)

Course descriptions aren't copied; each course links to its catalog entry.
