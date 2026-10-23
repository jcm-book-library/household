# Household

Household jobs in one week view: a cleaning-zone rotation, recurring jobs, bins, gardening timed for the green bin, and a grocery list split into two shops. Separate from The Brain: the Brain holds the routine block ("household jobs, 30 min"); this app holds what actually needs doing.

Live (once Pages is on): https://jcm-book-library.github.io/household/
Try it without a sheet: https://jcm-book-library.github.io/household/?demo

## How it works
- Sign in with Google; the page reads and writes its own Google Sheet directly (Sheets API). No personal data is stored in this repo.
- The sheet id and OAuth Client ID are saved in your browser (Settings). The Client ID is picked up from the book library automatically when both run on `jcm-book-library.github.io`.
- First time on an empty sheet, press **Set up sheet**: it adds the five 🏠 tabs below with headers and default settings. It never touches any other tab.
- Nothing is planned ahead into the sheet. The week is worked out live from the rules, so changing a job's rule changes every future week straight away. Ticking something adds a row to `🏠 Done` and updates Last done; unticking marks that row Void (rows are never deleted).

## How the schedule works
- **Fixed** jobs follow the calendar from their Anchor date: every N days, weeks or months (Day = weekday, or day of month / `last`). A fortnightly bin's Anchor is any real collection date, which sets which fortnight it's on.
- **Floating** jobs are due Every N after Last done (moved to Day if one is set). They stay overdue until done.
- **Linked** jobs fall on the last chosen Day *before* each date of another job. Gardening = Day `Sat`, Linked to the green bin.
- **If missed:** `Roll` keeps a fixed job on the Overdue list until done or until the next one comes round; `Skip` drops it (gardening: the bin has gone).
- **Zones:** one zone per zone day (default Mon–Fri). The next zone is the one cleaned longest ago, so a missed day shifts the queue along instead of doubling up.
- **Groceries:** `Light` goes in the commute shop (office day), `Heavy` in the weekend shop (or delivery), `Any` in whichever is sooner. Items with Restock days come back on the list when Last bought + Restock days falls on or before their shop.

## Sheet tabs
| Tab | Columns |
|---|---|
| 🏠 Jobs | id, Job, Area, Mode, Every, Unit, Anchor, Day, Linked to, Minutes, If missed, Last done, Active, Notes |
| 🏠 Zones | id, Zone, Order, Minutes, Checklist, Last cleaned, Active |
| 🏠 Groceries | id, Item, Shop, Status, Restock days, Last bought, Notes |
| 🏠 Done | id, Date, For, Kind, Ref, Name, Prev, Void |
| 🏠 Settings | Key, Value, Notes |

Bins are jobs with Area `Bins`. Keep the column order. Rows can be edited or sorted by hand; the page finds rows by id.

## Files
| File | What it is |
|---|---|
| `app.html` | The only source. The schedule engine sits between `ENGINE START` / `ENGINE END`. |
| `index.html` | Built from `app.html` by `python3 tools/build-pages.py`. Don't edit by hand. |
| `tools/test-engine.js` | Unit tests for the schedule engine (reads it out of `app.html`). |
| `tools/test.js` | Headless Chromium test against a fake, in-memory Sheets API. |

## Testing
```
python3 tools/build-pages.py
node tools/test-engine.js
NODE_PATH=$(npm root -g) node tools/test.js /tmp/hh-shots
```

## Ideas for after the move
Moving checklist, bills and rent dates (from the Finances sheet), meal planning feeding the grocery list, laundry days, council holiday changes to bin days.
