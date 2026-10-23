"""Build index.html for GitHub Pages from app.html.

app.html is the single source. It is also what gets published as the claude.ai
artifact (which adds its own document skeleton), so it has no <head>. This adds
the doctype, metadata, icons and manifest that a normal website needs.

Starter copy from control-room/templates. Change the three settings below for
the new app, then leave the rest alone.

Run from the repo root:  python3 tools/build-pages.py
"""
from html import escape
from pathlib import Path

SHORT_NAME = "Household"        # Home-screen label, 12 characters or fewer
THEME_COLOUR = "#15141c"  # Matches the shared dark look
LANG = "en-AU"

HEAD = f"""<!doctype html>
<html lang="{LANG}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="{THEME_COLOUR}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="{escape(SHORT_NAME)}">
<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="manifest" href="manifest.webmanifest">
<!-- Built from app.html by tools/build-pages.py. Edit app.html, not this file. -->
"""

root = Path(__file__).resolve().parent.parent
app = (root / "app.html").read_text(encoding="utf-8")
if "<head" in app.lower():
    raise SystemExit("app.html should have no <head>; the build adds it.")
(root / "index.html").write_text(HEAD + app, encoding="utf-8")
print("index.html built,", len(HEAD + app), "bytes")
