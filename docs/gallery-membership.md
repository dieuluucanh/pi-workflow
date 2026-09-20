# Gallery membership on pi.dev

Why a published Pi package can be installable, carry the `pi-package` keyword, have a working
pi.dev detail page — and still be **absent from the gallery catalog**, with `Downloads: not
available`, no catalog search hit and no “Recently published” entry.

Everything below was measured on **2026-09-20** (≈09:37–09:55 UTC) against live npm and pi.dev. The
numbers move; the mechanics do not. Re-measure with `npm run gallery -- --diagnose`.

- [TL;DR](#tldr)
- [What “in the gallery” actually means](#what-in-the-gallery-actually-means)
- [The mechanism](#the-mechanism)
- [Test membership by hand](#test-membership-by-hand)
- [Evidence: the five @dieulc packages](#evidence-the-five-dieulc-packages)
- [Hypotheses tested and refuted](#hypotheses-tested-and-refuted)
- [What this means for @dieulc/workflow](#what-this-means-for-dieulcworkflow)
- [Escalating to pi.dev](#escalating-to-pidev)
- [Tooling](#tooling)

## TL;DR

- The gallery is a **bounded, popularity-led slice of npm's search results** for
  `keywords:pi-package`, not a registry you publish into.
- On 2026-09-20 the catalog held **5,374 rows** while npm matched **10,255** packages on that
  keyword — so **~4,881 eligible packages had no catalog row at all**. Absence is normal, not
  evidence of a packaging defect.
- **Nothing in `package.json` gets a package in.** Publishing is *eligibility*, never *listing*.
- **A missing row is not proof of low traction.** The catalog contains packages with *fewer* downloads
  than ones it skips, so absence can be a per-package **ingest gap** — escalate it rather than assuming
  more installs are the answer.
- A republish sometimes flips a package in (the index record is refreshed) and sometimes does not.
  Treat it as a measured attempt, never a fix.

## What “in the gallery” actually means

pi.dev renders `https://pi.dev/packages/<name>` for **any** npm package that looks like a Pi package.
The detail page existing — with a parsed manifest, size, license, peers — is **not** proof of
listing. Two independent signals tell the two apart, and `npm run gallery` now reads both and
requires them to agree:

| Signal | Where | Catalogued | Not catalogued |
| --- | --- | --- | --- |
| **Catalog listing** (authoritative) | `https://pi.dev/packages?name=<term>` | a card whose `data-package-name` is the exact package | no such card |
| **Detail page `Downloads` row** | `https://pi.dev/packages/<name>` | a number, e.g. `441/mo · 247/wk` | `not available` |

“Recently published” is a view over the same catalog table, so a fresh publish appears there only if
the package already has a catalog record. Disagreement between the two signals — or an unreadable
page — is reported as `unreachable`, never as a confident “not indexed”.

## The mechanism

1. **npm search is the source.** Every catalog card is built from the package's npm search-index
   record: the card's `data-package-search` string is the record's name + description + publisher +
   keywords (with `pi-package` itself stripped, since that is the query), and the displayed
   `N/mo · N/wk` is the record's single `downloads.monthly` value printed twice.
2. **The crawl is bounded.** The catalog holds ~5.4k rows while the keyword matches ~10.3k packages.
   npm's search API serves pages only up to `from=5000` and rolls over to page 1 beyond that, so a
   crawler paging naively can only reach roughly half of the matching set
   ([pi#7885](https://github.com/earendil-works/pi/issues/7885)).
3. **Selection is relevance-ranked and popularity-led.** Whether a package lands inside that reachable
   window is decided by its search score, in which the download component dominates.
4. **The catalog is sorted by downloads**, so its *last* page holds the lowest figure pi.dev ingested.
   On 2026-09-20 that page (`?page=108`) held 24 rows between **87/mo and 96/mo** — the observed
   cut-off.
5. **The stored figures are frozen at ingest time.** npm's index reports an identical `monthly` and
   `weekly` value (a snapshot artifact), so a card can show a figure that no longer matches reality —
   `@dieulc/workflow` was stored at 104/mo while `api.npmjs.org` reported 280 downloads in the last
   30 days. The cut-off is therefore a *soft* boundary, not a strict threshold: a package sitting
   just above it can still be missing.

The practical consequence: a package's absence can be explained by the bounded window (clearly below
the cut-off), or can be **unexplained** (at or above it and still missing). The `--diagnose` verdict
distinguishes the two and will not claim the cut-off explains a case it does not.

## Test membership by hand

```bash
# Scoped names do NOT match in their @scope/name form — that filter returns 0 rows.
# Use the scope (author) or the unscoped basename:
open "https://pi.dev/packages?name=dieulc"      # 1-4 / 4 (of 5374) — every package by this author
open "https://pi.dev/packages?name=workflow"    # 1-50 / 317 (of 5374) — then page through

# And the detail page, cross-checking the Downloads row:
open "https://pi.dev/packages/@dieulc/workflow" # Downloads: not available → no catalog row
```

The counter above the grid has three shapes: `1-4 / 4 (of 5374)` (filtered, one page),
`5351-5374 / 5374` (last page) and `0 / 5374` (nothing matched). **If the counter shows more matched
rows than the page you are on, keep paging** (`&page=2`, `&page=3`, …) before concluding a package is
absent — a scoped-name lookup can legitimately be absent from page 1 while present later.

## Evidence: the five @dieulc packages

Measured 2026-09-20. All five carry `keywords: ["pi-package", …]`, resolve on npm, render a detail
page, and are installable; all four published that morning went to npm within the same 40 seconds
(`06:26:26`–`06:27:05Z`).

| package | npm index/mo | search score | index date (UTC) | real downloads/mo | catalog row |
| --- | --- | --- | --- | --- | --- |
| `@dieulc/pi-office-bridge` | 441 | 832.0 | 2026-09-19T13:38:45 | 441 | ✅ |
| `@dieulc/autocompact` | 175 | 667.5 | 2026-09-20T06:27:05 | 193 | ✅ |
| `@dieulc/server-logs` | 110 | 571.8 | 2026-09-20T06:26:29 | 117 | ✅ |
| `@dieulc/browser-inspector` | 107 | 595.5 | 2026-09-20T06:26:26 | 111 | ✅ |
| `@dieulc/workflow` | **104** | 539.6 | 2026-09-20T06:26:33 | 280 | ❌ **none** |

Context for the same measurement: `?name=dieulc` returned `1-4 / 4` — the four packages above and
**no match for `@dieulc/workflow`**. Its exclusion is **not** explained by a download floor:

- The catalog's last page (`?page=108`) held 24 rows between **87/mo and 96/mo**, below `workflow`'s
  104/mo.
- A full walk of `?name=workflow` (317 matched rows over 7 pages, complete: the counter ends at
  `301-317 / 317`) found **no card for `@dieulc/workflow`** — while that same result set contains
  pages of catalogued packages at 90–119/mo, 120–176/mo, 176–267/mo, … all sorted by downloads.

So the catalog demonstrably reaches packages with *less* traction than this one. What is true is that
`workflow` carries the lowest search-index figure of the five, it is the only one of four packages
published in the same 40-second window that was skipped, and it was skipped for two consecutive
versions — the shape of a **per-package ingest gap**, not a ranking outcome.

## Hypotheses tested and refuted

Every one of these was checked against live data before being rejected — do not re-open them without
new evidence.

| Hypothesis | Test | Result |
| --- | --- | --- |
| Tarball / single-file size cap (the 487 KB `index.ts` outlier) | catalog detail pages of large packages | **Refuted** — `pi-fabric` is catalogued at **10.2 MB** (15 deps), `pi-mcp-adapter` at **3 MB**; ours is 487 KB |
| Download-count cut-off (i.e. “not enough traction yet”) | last catalog page, plus a complete walk of `?name=workflow` | **Refuted** — catalogued rows sit at 87–119/mo, *below* `workflow`'s 104/mo |
| Peer-dependency count (5 peers) | manifests of catalogued packages | **Refuted** — catalogued packages carry up to 4 peers and 15 dependencies |
| Non-ASCII description (`Plan↔Build`) | rendering of the detail page | **Refuted** — pi.dev parsed and rendered the manifest and description fine |
| Crawl lag / stale cache | publish times vs catalog rows | **Refuted** — 3 of 4 ingested within hours; unrelated packages appear minutes after publish |
| “Yesterday's publish needs longer” | `0.3.0` published 2026-09-19 failed identically | **Refuted** — the same package missed the window twice |
| Splitting `index.ts` / ASCII-fying the description / renaming the package | — | **All rejected** — the first two address refuted causes; a rename starts a new name at 0 downloads, i.e. *worse* ranking |

## What this means for @dieulc/workflow

- It is **installable and correct**: `pi install npm:@dieulc/workflow` works, and the README, manifest,
  peers and keywords are all valid. Nothing in the repository is broken.
- Its absence from the gallery is a **server-side ingest gap** (with ~4.9k other eligible packages in the
  same position), not something a code or metadata change can be shown to fix. The evidence rules out
  packaging defects *and* a pure traction threshold.
- The levers, in order of value:
  1. **Escalate to pi.dev** — this is the only path that addresses the actual defect, and the evidence
     is unusually strong (four packages published in the same window, three listed; the missing one has
     *more* real downloads than two of them, and the catalog holds less-downloaded packages).
  2. **A measured republish** — refresh the search-index record and immediately re-run the diagnostic.
     If the row does not appear, do **not** publish again for that purpose.
  3. **Real downloads** — a plausible but *unproven* lever here: ranking may matter for packages near the
     crawl boundary, but this package is already above the observed floor, so treat traction as
     hygiene, not a fix.
- **Download-gaming is forbidden** (self-download loops, CI fetch farms). It violates npm's terms and
  would misrepresent the package's adoption.

## Escalating to pi.dev

Every catalog card links a **report** action
(`https://github.com/earendil-works/pi/issues/new?template=package-report.yml&labels=package-report&…`)
prefilled with the package name and version — that is the official channel for “this package is
missing from the gallery”.

A useful report contains, all reproducible from this repo:

1. `npm run gallery -- --packages workflow --diagnose` output (index figure, score, catalog row,
   cut-off, verdict).
2. The by-hand check: `https://pi.dev/packages?name=dieulc` → 4 of 5 packages; no match for
   `@dieulc/workflow`.
3. The contrast: the four sibling packages, published in the same 40-second window, all catalogued.
4. The scale of the underlying defect: catalog rows vs npm keyword matches (5,374 vs 10,255 on
   2026-09-20) and the `from=5000` rollover.

Upstream issues already referenced by the checker's notes: [pi#6991](https://github.com/earendil-works/pi/issues/6991)
(reported success after a metadata touch), [pi#7849](https://github.com/earendil-works/pi/issues/7849),
[pi#7885](https://github.com/earendil-works/pi/issues/7885) (the bounded slice),
[pi#7987](https://github.com/earendil-works/pi/issues/7987) and
[pi#8830](https://github.com/earendil-works/pi/issues/8830) (republish did not help).

## Tooling

```bash
npm run gallery                                   # all packages: ok / not-indexed / …
npm run gallery -- --packages workflow            # one package
npm run gallery -- --wait 900                     # poll for up to 15 minutes
npm run gallery -- --diagnose                     # index figures, catalog rows, cut-off, verdicts
npm run gallery -- --diagnose --json              # { packages, diagnose } for tooling
```

`--diagnose` prints a table of every selected package's npm search-index figure, search score,
catalog-listing answer, the figure pi.dev stored, and a verdict:

| Verdict | Meaning |
| --- | --- |
| `member` | the catalog listing has a card for it |
| `no row (below window)` | no row, and its index figure is below the measured cut-off — the bounded crawl does not reach it |
| `no row (unknown)` | no row, and the cut-off does **not** explain it (or the listing was unreadable) — worth a report if it persists |

The check's statuses and exit codes are documented in [publishing.md](publishing.md#checking-it);
`npm run release` runs the same check in `--warn-only` mode, so a missing catalog row never fails a
release.

## Filing status

| Draft | State |
| --- | --- |
| Appendix A — `@dieulc/workflow` missing from the catalog | **Held (not filed)** — awaiting explicit go-ahead. Nothing has been posted. |
| Appendix B — catalog reaches ~half of the matching packages | **Held (not filed)** — awaiting explicit go-ahead. |

Once either is filed, record the issue link, the date and any response in this table and in the daily
log, so the state stays traceable without re-reading the whole document.

## Appendix A — draft report: `@dieulc/workflow` is missing from the catalog

> **DRAFT — not filed.** Filing it is a public act under the user's GitHub account; get explicit
go-ahead first. Open it from the catalog card's own **report** action
> (`.../issues/new?template=package-report.yml&labels=package-report&title=Package+Report%3A+%40dieulc%2Fworkflow&package-name=%40dieulc%2Fworkflow&package-version=0.3.1`),
> or paste the body below into that template.

**Title:** Package Report: @dieulc/workflow

**Package name:** `@dieulc/workflow` · **Version:** 0.3.1 · **Publisher:** dieulc · **License:** MIT

**What is wrong.** The package is published, installable and renders a detail page, but pi.dev has no
catalog row for it, so it never appears in gallery search or “Recently published”, and its detail page
shows `Downloads: not available`. It has now missed the catalog for two consecutive versions:

| version | published (UTC) | catalog row |
| --- | --- | --- |
| 0.3.0 | 2026-09-19T15:49:05 | none |
| 0.3.1 | 2026-09-20T06:26:33 | none |

**Why it does not look like a traction problem.** The catalog demonstrably contains packages with
*less* npm traffic than this one:

- Its npm search-index record (`/-/v1/search?text=@dieulc/workflow&size=1`, measured 2026-09-20) looks
  healthy: `downloads.monthly 104`, `package.date 2026-09-20T06:26:33.115Z`,
  `keywords ["pi-package", "workflow", "plan-mode", "review-mode", "questionnaire", "rewind"]`.
- The catalog's own last page (`/packages?page=108`) holds rows between **87/mo and 96/mo**.
- A complete walk of `/packages?name=workflow` (317 matched rows, 7 pages, counter ends
  `301-317 / 317`) contains no card for `@dieulc/workflow`, while including catalogued packages at
  90–119/mo, 120–176/mo and 176–267/mo.
- `/packages?name=dieulc` returns `1-4 / 4 (of 5374)`: `@dieulc/pi-office-bridge` (441/mo),
  `@dieulc/autocompact` (175/mo), `@dieulc/server-logs` (110/mo), `@dieulc/browser-inspector`
  (107/mo) — and **no `@dieulc/workflow`**. All four are catalogued; three of them were published in
  the same 40-second window as the missing one.

**Ruled out on our side** (each checked against catalogued packages): tarball/file size (catalogued
packages reach 10.2 MB; ours is 487 KB), peer/dependency count (catalogued packages carry up to 15
dependencies and 4 peers), non-ASCII description, an invalid `pi` manifest (the detail page parses it
and shows `Types: extension`), and crawl lag (unrelated packages appear minutes after publish).

**Request.** Please check why this package's row is absent and ingest/restore it, and let us know
either (a) what makes this package ineligible for ingest, or (b) that we are hitting a known issue so
we can follow it.

**Diagnostic output** (reproducible with `npm run gallery -- --packages workflow --diagnose`):

```text
npm search index vs pi.dev catalog — measured 2026-09-20T09:57:04.133Z
package           index/mo  score  row  row/mo  verdict
----------------  --------  -----  ---  ------  ----------------
@dieulc/workflow  104       539.6  no   -       no row (unknown)

catalog cut-off: ~87/mo — lowest downloads figure on the catalog's last page (page 108, 24 rows, up to 96/mo)
catalog size: 5374 rows
npm matches for keywords:pi-package: 10255 package(s)
not ingested: ~4881 matching package(s) have no catalog row
```

## Appendix B — draft report: the catalog reaches only half of the matching packages

> **DRAFT — not filed.** Same rule as Appendix A; filing needs explicit go-ahead. This one is a
> structural issue rather than a single package (measured 2026-09-20; re-measure before filing).

**Title:** Package catalog ingests only ~half of the `pi-package` matches (and stores frozen download figures)

**Observation 1 — the catalog is bounded.** On 2026-09-20 the catalog reported **5,374** rows
(`/packages`, `1-50 / 5374`) while npm's search API reported **10,255** matches for
`text=keywords:pi-package&size=1`. So **~4,881 eligible packages have no catalog row** and are absent
from gallery search and “Recently published”, even though their detail pages render and they install
fine. npm's search API serves pages only up to `from=5000` and silently rolls over to page 1 beyond
that, which is a likely cause for a crawler that pages through results (previously reported as the
same class of problem; the gallery membership check cites #6991, #7849, #7885, #7987, #8830).

**Observation 2 — a row can be missing even above the cut-off.** The catalog is served sorted by
downloads and its last page (`?page=108`) still lists rows at 87–96/mo, yet `@dieulc/workflow`
(104/mo, valid `pi-package` keyword, healthy search-index record) has no row at all, while the three
sibling packages published in the same 40-second window do. Membership therefore does not look like a
strict popularity threshold; there seem to be per-package ingest gaps.

**Observation 3 — the stored figures are frozen and self-inconsistent.** Every search-index record we
sampled reports an identical `downloads.monthly` and `downloads.weekly`, and the catalog card renders
that single number as `N/mo · N/wk`. Measured example: `@dieulc/workflow` is stored/shown as **104/mo**
while `api.npmjs.org/downloads/point/last-month/@dieulc/workflow` reports **280**. Ranking input that
is both stale and duplicated across two periods distorts ordering for every low-volume package.

**Request.** (1) Page npm's search results in a way that reaches the full match set (e.g. smaller
pages with explicit `from` offsets, or another discovery source), or document the intended bound so
publishers know a row is not guaranteed. (2) Re-check why individual packages above the download floor
end up with no row. (3) Consider sourcing download figures from `api.npmjs.org` rather than the frozen
search-index values, and show distinct month/week numbers if both are meant to be shown.

**Evidence to attach:** the `--diagnose` output above, `/packages?name=dieulc` → `1-4 / 4`, the
`?name=workflow` 7-page walk result (`301-317 / 317`, no exact match), and `/packages?page=108`
(24 rows, 87–96/mo).
