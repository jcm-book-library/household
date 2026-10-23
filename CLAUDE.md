# Household: notes for Claude

**Read the house rules first:** [HOUSE-RULES.md](https://github.com/jcm-book-library/control-room/blob/main/HOUSE-RULES.md) in `control-room` (plain text: https://raw.githubusercontent.com/jcm-book-library/control-room/main/HOUSE-RULES.md). They cover Google Sheet safety, branches and pull requests into `main`, using cheaper models to save usage credits, and the build template. The notes below are this repo's own; where they are more specific, they win. The project charter is `project.json`.

## This repo
- Source: `app.html`. Rebuild `index.html` with `python3 tools/build-pages.py` after every change and commit both.
- Live site: https://jcm-book-library.github.io/household/ (from `main`). `?demo` runs on sample data with no sheet.
- Separate from The Brain on purpose: the Brain holds the routine slot, this app holds the specifics. Don't link or write to the Brain's sheet.
- The schedule engine (`ENGINE START` … `ENGINE END` in `app.html`) is pure date logic, tested by `tools/test-engine.js`. Change it only with new tests; dates are local `yyyy-mm-dd` strings, never UTC.
- Tests: `node tools/test-engine.js` and `NODE_PATH=$(npm root -g) node tools/test.js /tmp/hh-shots`. Run both before every push.

## Google Sheet
- Sheet: the owner's household sheet (id in the owner's browser settings, not here: the repo is public).
- Only touch tabs whose names start with 🏠: `🏠 Jobs`, `🏠 Zones`, `🏠 Groceries`, `🏠 Done`, `🏠 Settings`. Columns are in the README.
- sheetIds are looked up by tab title at load, not hard-coded. The app never deletes rows: remove = Active FALSE, untick = Void TRUE.
- Status: built before the move (early 2027); the sheet is still empty. The owner fills in zones, bins and office day once settled.
