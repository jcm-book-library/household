// Headless test: serves index.html with a fake Sheets API held in memory. Never touches real Google.
// Run: NODE_PATH=$(npm root -g) node tools/test.js /tmp/hh-shots   (after python3 tools/build-pages.py)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const OUT = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

/* "Today" is Tue 12 Jan 2027, everywhere. */
const T = '2027-01-12';
const serial = s => { const [y, m, d] = s.split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5); };
const SERIAL_RE = /^\d{4}-\d{2}-\d{2}$/;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
}

/* ---------- fake database ---------- */
const HEADS = {
  '🏠 Jobs': ['id', 'Job', 'Area', 'Mode', 'Every', 'Unit', 'Anchor', 'Day', 'Linked to', 'Minutes', 'If missed', 'Last done', 'Active', 'Notes'],
  '🏠 Zones': ['id', 'Zone', 'Order', 'Minutes', 'Checklist', 'Last cleaned', 'Active'],
  '🏠 Groceries': ['id', 'Item', 'Shop', 'Status', 'Restock days', 'Last bought', 'Notes'],
  '🏠 Done': ['id', 'Date', 'For', 'Kind', 'Ref', 'Name', 'Prev', 'Void'],
  '🏠 Settings': ['Key', 'Value', 'Notes']
};
const blank = n => Array(n).fill('');
function seedTabs(full) {
  const J = (id, job, area, mode, every, unit, anchor, day, link, mins, missed, last, active = true) =>
    [id, job, area, mode, every, unit, anchor ? serial(anchor) : '', day, link, mins, missed, last ? serial(last) : '', active, ''];
  const tabs = {};
  for (const k of Object.keys(HEADS)) tabs[k] = [HEADS[k].slice()];
  tabs['🏠 Settings'].push(['office_day', 'Thu', ''], ['weekend_shop_day', 'Sat', ''], ['delivery', 'no', ''], ['zone_days', 'Mon, Tue, Wed, Thu, Fri', ''], ['zone_minutes', 30, ''], ['daily_cap', 60, '']);
  if (!full) return tabs;
  tabs['🏠 Jobs'].push(
    J(1, 'Green bin out', 'Bins', 'Fixed', 2, 'week', '2027-01-18', 'Mon', '', 2, 'Roll', ''),
    J(2, 'Gardening', 'Garden', 'Fixed', '', '', '', 'Sat', 1, 45, 'Skip', ''),
    J(3, 'Red bin out', 'Bins', 'Fixed', 1, 'week', '2027-01-04', 'Mon', '', 2, 'Roll', ''),
    J(4, 'Water pots', 'Garden', 'Fixed', 1, 'week', '2027-01-04', 'Mon', '', 10, 'Skip', ''),
    J(5, 'Clean fridge', 'Kitchen', 'Floating', 30, 'day', '', '', '', 20, 'Roll', '2026-12-01'),
    J(6, 'Descale kettle', 'Kitchen', 'Floating', 3, 'month', '', '', '', 10, 'Roll', '2026-11-30'),
    J(7, 'Wash towels', 'Laundry', 'Floating', 1, 'week', '', '', '', 10, 'Roll', '2027-01-07'),
    J(8, 'Old job', 'Admin', 'Floating', 1, 'month', '', '', '', 5, 'Roll', '2026-12-01', false),
    blank(14), blank(14));
  tabs['🏠 Zones'].push(
    [1, 'Kitchen', 1, 30, 'Wipe benches\nMop floor', '', true], [2, 'Bathroom', 2, 30, 'Scrub shower', '', true],
    [3, 'Lounge', 3, 20, '', serial('2027-01-05'), true], [4, 'Bedroom', 4, 30, '', serial('2027-01-06'), true], [5, 'Study', 5, 30, '', '', false], blank(7));
  tabs['🏠 Groceries'].push(
    [1, 'Milk', 'Light', 'Need', '', '', ''], [2, 'Bread', 'Light', 'Need', '', '', ''], [3, 'Dog food', 'Heavy', 'Need', '', '', ''], [4, 'Eggs', 'Any', 'Need', '', '', ''],
    [5, 'Butter', 'Light', 'Got', 7, serial('2027-01-04'), ''], [6, 'Coffee', 'Any', 'Got', 30, serial('2027-01-08'), ''], [7, 'Rice', 'Heavy', 'Got', 60, serial('2027-01-01'), ''], blank(7));
  tabs['🏠 Done'].push([7, serial('2027-01-05'), serial('2027-01-05'), 'Job', 5, 'Clean fridge', '', true], blank(8), blank(8));
  return tabs;
}

function parseA1(r) { // "'🏠 Jobs'!A2:N", "'🏠 Jobs'!A5"
  const i = r.lastIndexOf('!'); let tab = r.slice(0, i); if (tab.startsWith("'")) tab = tab.slice(1, -1).replace(/''/g, "'");
  const [a, b] = r.slice(i + 1).split(':'); const single = b === undefined;
  const p = s => { const m = s.match(/^([A-Z]+)(\d*)$/); return { c: m[1].charCodeAt(0) - 65, r: m[2] ? Number(m[2]) : null }; };
  const A = p(a), B = b ? p(b) : A; return { tab, r0: A.r, c0: A.c, r1: B.r, c1: B.c, single };
}
function userEntered(v) {
  if (typeof v === 'string') {
    if (SERIAL_RE.test(v)) return serial(v);
    if (v.startsWith("'")) return v.slice(1);
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  }
  return v;
}

/* ---------- scenario runner ---------- */
const browserP = chromium.launch();
const MIME = { '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
async function scenario(name, opts, fn) {
  console.log('--- ' + name);
  const b = await browserP;
  const ctx = await b.newContext({ viewport: opts.viewport || { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [], calls = [];
  const db = { tabs: opts.tabs || {}, sids: {}, rowCount: {} };
  let nextSid = 100;
  Object.keys(db.tabs).forEach(k => { db.sids[k] = nextSid++; db.rowCount[k] = 1000; });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.clock.setFixedTime(new Date(2027, 0, 12, 10, 0, 0));
  await page.route(/^https:\/\/household\.test\//, r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/') return r.fulfill({ contentType: 'text/html', body: HTML });
    const f = path.join(ROOT, u.pathname);
    if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return r.fulfill({ contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
    return r.fulfill({ status: 404, body: '' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route(/accounts\.google\.com/, r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route(/sheets\.googleapis\.com/, async r => {
    const u = new URL(r.request().url()), method = r.request().method();
    const p = decodeURIComponent(u.pathname.replace(/^\/v4\/spreadsheets\/[^/:]+/, ''));
    const post = r.request().postData(); calls.push({ method, path: p, body: post ? JSON.parse(post) : null });
    const json = (o, status) => r.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(o) });
    const bad = m => json({ error: { message: m } }, 400);
    if (p === '') return json({ sheets: Object.keys(db.tabs).map(t => ({ properties: { sheetId: db.sids[t], title: t, gridProperties: { rowCount: db.rowCount[t] } } })) });
    if (p === '/values:batchGet') {
      const ranges = u.searchParams.getAll('ranges'); const out = [];
      for (const rg of ranges) { const a = parseA1(rg); if (!db.tabs[a.tab]) return bad('no tab ' + a.tab); out.push({ range: rg, values: db.tabs[a.tab].slice(a.r0 - 1).map(row => row.slice(a.c0, a.c1 + 1)) }); }
      return json({ valueRanges: out });
    }
    if (p.startsWith('/values/')) {
      const a = parseA1(p.slice(8)); if (!db.tabs[a.tab]) return bad('no tab ' + a.tab);
      if (method === 'GET') {
        if (a.single) return json({ values: a.r0 && db.tabs[a.tab][a.r0 - 1] ? [[db.tabs[a.tab][a.r0 - 1][a.c0] ?? '']] : [[]] });
        return json({ values: db.tabs[a.tab].slice(a.r0 - 1).map(row => [row[a.c0] ?? '']) });
      }
      if (method === 'PUT') {
        const vals = JSON.parse(post).values;
        vals.forEach((rv, i) => { const ri = a.r0 - 1 + i; while (db.tabs[a.tab].length <= ri) db.tabs[a.tab].push([]); rv.forEach((v, j) => { db.tabs[a.tab][ri][a.c0 + j] = userEntered(v); }); });
        return json({ updatedRows: vals.length });
      }
    }
    if (p === ':batchUpdate') {
      const replies = [];
      for (const q of JSON.parse(post).requests) {
        if (q.addSheet) { const t = q.addSheet.properties.title; if (db.tabs[t]) return bad('exists'); db.tabs[t] = []; db.sids[t] = nextSid++; db.rowCount[t] = 1000; replies.push({ addSheet: { properties: { sheetId: db.sids[t], title: t, gridProperties: { rowCount: 1000 } } } }); }
        else if (q.appendDimension) { const t = Object.keys(db.sids).find(k => db.sids[k] === q.appendDimension.sheetId); db.rowCount[t] += q.appendDimension.length; replies.push({}); }
        else if (q.deleteDimension) { const t = Object.keys(db.sids).find(k => db.sids[k] === q.deleteDimension.range.sheetId); db.tabs[t].splice(q.deleteDimension.range.startIndex, 1); replies.push({}); }
        else return bad('unsupported request');
      }
      return json({ replies });
    }
    return bad('unhandled ' + method + ' ' + p);
  });
  if (opts.token !== false) await page.addInitScript(exp => {
    localStorage.setItem('jm-google-token', JSON.stringify({ t: 'x', exp }));
    localStorage.setItem('household_config', JSON.stringify({ clientId: 'abc.apps.googleusercontent.com', sheetId: 'TESTSHEET1234567890abc' }));
  }, new Date(2027, 0, 13).getTime());
  else await page.addInitScript(() => localStorage.setItem('household_config', JSON.stringify({ clientId: 'abc.apps.googleusercontent.com', sheetId: 'TESTSHEET1234567890abc' })));
  await page.goto('https://household.test/' + (opts.query || ''));
  const settle = async () => { await page.waitForTimeout(80); await page.waitForSelector('#status:not([data-state=loading])', { timeout: 8000 }); await page.waitForTimeout(60); };
  const ctxo = { page, db, calls, settle, errors };
  try { await fn(ctxo); } catch (e) { check(name + ': ran without throwing', false, String(e.message).split('\n')[0]); }
  check(name + ': no console or page errors', errors.length === 0, errors);
  await ctx.close();
}
const text = (page, sel) => page.locator(sel).first().innerText();
const card = (page, d) => page.locator(`.dcard[data-date="${d}"]`);
async function layout(page, label, widths) {
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(120);
    for (const t of ['week', 'zones', 'groceries', 'jobs']) {
      await page.click(`.tab[data-tab=${t}]`); await page.waitForTimeout(80);
      const sw = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      check(`${label}: ${t} has no sideways scroll at ${w}px`, sw[0] <= sw[1], sw);
      await page.screenshot({ path: path.join(OUT, `${label}-${t}-${w}.png`), fullPage: true });
    }
    await page.click('.tab[data-tab=week]');
  }
}
const live = page => page.waitForSelector('#status[data-state=live]', { timeout: 8000 });

(async () => {
  /* 1. empty sheet: setup flow, then starter jobs, and it looks right when empty */
  const other = [['Name', 'Qty'], ['Hello', 3]];
  await scenario('setup', { tabs: { Other: JSON.parse(JSON.stringify(other)) } }, async ({ page, db, calls, settle }) => {
    await page.waitForSelector('#gate [data-act=setup]');
    check('setup: notice says the sheet is not set up', (await text(page, '#gate')).includes("This sheet isn't set up for Household yet"));
    check('setup: tabs and week hidden until set up', !(await page.locator('#main').isVisible()));
    const before = calls.length;
    await page.click('[data-act=setup]'); await page.waitForSelector('#askDlg[open]');
    const listed = await page.locator('#askBody li').allInnerTexts();
    check('setup: confirm lists exactly the 5 tabs', JSON.stringify(listed) === JSON.stringify(Object.keys(HEADS)), listed);
    check('setup: nothing written before confirming', calls.length === before);
    await page.click('#askYes'); await live(page); await page.waitForTimeout(200);
    const added = Object.keys(db.tabs).filter(k => k !== 'Other');
    check('setup: adds exactly 5 tabs', added.length === 5 && Object.keys(HEADS).every(k => added.includes(k)), added);
    check('setup: headers written correctly', Object.keys(HEADS).every(k => JSON.stringify(db.tabs[k][0]) === JSON.stringify(HEADS[k])), Object.keys(HEADS).map(k => db.tabs[k][0]));
    const st = db.tabs['🏠 Settings'].slice(1).map(r => r[0] + '=' + r[1]);
    check('setup: default settings seeded', JSON.stringify(st) === JSON.stringify(['office_day=Thu', 'weekend_shop_day=Sat', 'delivery=no', 'zone_days=Mon, Tue, Wed, Thu, Fri', 'zone_minutes=30', 'daily_cap=60']), st);
    check('setup: unrelated tab untouched', JSON.stringify(db.tabs.Other) === JSON.stringify(other));
    const writes = calls.filter(c => c.method !== 'GET');
    check('setup: only addSheet batchUpdate + writes to new tabs', writes.every(c => (c.path === ':batchUpdate' && c.body.requests.every(q => q.addSheet && Object.keys(q.addSheet.properties).join() === 'title')) || (c.method === 'PUT' && /🏠/.test(c.path))), writes.map(c => c.method + c.path));
    check('setup: no row deletes', !calls.some(c => JSON.stringify(c.body || '').includes('deleteDimension')));
    check('setup: week renders after set up (7 cards, all clear)', (await page.locator('.dcard').count()) === 7 && (await text(page, '#strip')).includes('All clear'));
    check('setup: empty states show', (await text(page, '#days')).includes('Nothing planned'));
    await page.click('.tab[data-tab=zones]'); check('empty zones message', (await text(page, '#zonesBody')).includes('No zones yet. Add the rooms of the new place: + Zone'));
    await page.click('.tab[data-tab=groceries]'); check('empty groceries message', (await text(page, '#grocBody')).includes('Nothing needed for this shop'));
    await page.click('.tab[data-tab=jobs]'); check('empty jobs offers starter jobs', await page.locator('[data-act=starter]').count() === 1);
    await layout(page, 'empty', [390, 1280]);
    await page.click('.tab[data-tab=jobs]');
    // starter jobs
    await page.click('[data-act=starter]'); await page.waitForSelector('#askDlg[open]');
    check('starter: preview lists 9 jobs', (await page.locator('#askBody li').count()) === 9);
    const w0 = calls.filter(c => c.method !== 'GET').length;
    await page.click('#askYes'); await settle();
    const rows = db.tabs['🏠 Jobs'].slice(1);
    check('starter: 9 rows appended with ids 1..9', rows.length === 9 && rows.every((r, i) => r[0] === i + 1), rows.map(r => r[0]));
    check('starter: one append write', calls.filter(c => c.method !== 'GET').length === w0 + 1);
    check('starter: floating unless noted, sheets are fixed fortnightly Sun', rows.filter(r => r[3] === 'Floating').length === 7 && rows.find(r => r[1] === 'Change sheets')[3] === 'Fixed' && rows.find(r => r[1] === 'Change sheets')[7] === 'Sun' && rows.find(r => r[1] === 'Change sheets')[6] === serial('2027-01-17'));
    check('starter: no bins', !rows.some(r => String(r[2]).toLowerCase() === 'bins'));
    check('starter: list shows them and the button is gone', (await page.locator('.jrow').count()) === 9 && (await page.locator('[data-act=starter]').count()) === 0);
  });

  /* 2-8, 11: seeded sheet */
  await scenario('seeded', { tabs: seedTabs(true) }, async ({ page, db, calls, settle }) => {
    await live(page); await page.waitForTimeout(200);
    check('week: 7 day cards', (await page.locator('.dcard').count()) === 7);
    check('week: label', (await text(page, '#weekTitle')) === 'Week of Mon 11 Jan');
    const today = page.locator('.dcard[data-today=true]');
    check('week: today is Tue 12 Jan and shows the first zone in the queue', (await today.getAttribute('data-date')) === T && (await today.innerText()).includes('Kitchen'));
    const strip = await text(page, '#strip');
    const od = await text(page, '#strip [data-kind=overdue]');
    check('strip: overdue floating job', od.includes('Clean fridge') && od.includes('since Thu 31 Dec'), od);
    check('strip: missed Roll bin is overdue', od.includes('Red bin out') && od.includes('since Mon 11 Jan'), od);
    check('strip: missed Skip job is not overdue', !od.includes('Water pots') && !od.includes('Gardening'), od);
    check('strip: rest of week lists the floating job due Thursday', (await text(page, '#strip [data-kind=rest]')).includes('Wash towels'));
    check('strip: no all-clear while jobs are due', !strip.includes('All clear'));
    check('week: Skip job shows as missed on Monday', /Water pots\s+missed/.test(await card(page, '2027-01-11').innerText()));
    check('week: gardening is the Saturday before the green bin', (await card(page, '2027-01-16').innerText()).includes('Gardening') && !(await card(page, '2027-01-11').innerText()).includes('Gardening'));
    check('week: green bin tag on its Monday is next week, red bin tag on Monday', (await card(page, '2027-01-11').locator('.bin[data-c=red]').count()) === 1 && (await page.locator('.bin[data-c=green]').count()) === 0);
    check('week: shop lines on commute and weekend days', (await card(page, '2027-01-14').innerText()).includes('Commute shop · 4 items') && (await card(page, '2027-01-16').innerText()).includes('Weekend shop · 1 item'));
    check('week: Monday is dimmed (past), nothing unrelated', (await card(page, '2027-01-11').getAttribute('data-past')) === 'true' && (await card(page, '2027-01-13').getAttribute('data-past')) === 'false');
    check('week: future zones cannot be ticked', await card(page, '2027-01-13').locator('input[data-zone]').isDisabled());
    // 5. missed zone yesterday
    check('zones: yesterday shows "Zone missed", today shows the zone that was due', (await card(page, '2027-01-11').innerText()).includes('Zone missed') && (await today.innerText()).includes('Kitchen'));
    check('zones: queue continues Wed Bathroom, Thu Lounge, Fri Bedroom', (await card(page, '2027-01-13').innerText()).includes('Bathroom') && (await card(page, '2027-01-14').innerText()).includes('Lounge') && (await card(page, '2027-01-15').innerText()).includes('Bedroom'));
    check('zones: Saturday and Sunday have no zone', !/Kitchen|Bathroom|Lounge|Bedroom/.test(await card(page, '2027-01-16').innerText()));
    await today.locator('[data-zonelist="1"]').click(); await page.waitForSelector('#clDlg[open]');
    check('zones: checklist dialog shows items', (await page.locator('#clBody label').count()) === 2 && (await text(page, '#clTitle')) === 'Kitchen');
    await page.click('#clDlg [data-close]');

    // 10. layout and screenshots
    await layout(page, 'shot', [390, 1280]);
    await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(100);
    check('layout: day cards are one column on a phone', await page.evaluate(() => getComputedStyle(document.getElementById('days')).gridTemplateColumns.split(' ').length === 1));
    await page.setViewportSize({ width: 800, height: 900 }); await page.waitForTimeout(100);
    check('layout: two columns at 800px', await page.evaluate(() => getComputedStyle(document.getElementById('days')).gridTemplateColumns.split(' ').length === 2));
    await page.setViewportSize({ width: 1280, height: 1000 }); await page.waitForTimeout(100);
    check('layout: four columns at 1280px', await page.evaluate(() => getComputedStyle(document.getElementById('days')).gridTemplateColumns.split(' ').length === 4));

    // 3. tick / untick a job
    db.tabs['🏠 Jobs'].find(r => r[0] === 7)[13] = 'typed in the sheet';
    const putsBefore = calls.length;
    await page.locator('#strip input[data-job="7"]').click(); await settle();
    check('tick: a hand edit to another cell in the row survives', db.tabs['🏠 Jobs'].find(r => r[0] === 7)[13] === 'typed in the sheet');
    check('tick: job write covers only the Last done cell', calls.slice(putsBefore).some(c => c.method === 'PUT' && /Jobs'!L\d+:L\d+/.test(c.path || c.url || '')), calls.slice(putsBefore).map(c => c.method + ' ' + (c.path || c.url)));
    let done = db.tabs['🏠 Done'], dr = done.find(r => r[0] === 8);
    check('tick: Done row appended after the last row with new id', !!dr && done.indexOf(dr) === 2, done.map(r => r[0]));
    check('tick: Done row has date, for, kind, ref, name, prev', !!dr && dr[1] === serial(T) && dr[2] === serial('2027-01-14') && dr[3] === 'Job' && dr[4] === 7 && dr[5] === 'Wash towels' && dr[6] === serial('2027-01-07') && dr[7] === false, dr);
    const jr = () => db.tabs['🏠 Jobs'].find(r => r[0] === 7);
    check('tick: floating job Last done = today', jr()[11] === serial(T), jr());
    check('tick: still shows ticked on its due day', await card(page, '2027-01-14').locator('input[data-job="7"]').isChecked());
    await card(page, '2027-01-14').locator('input[data-job="7"]').click(); await settle();
    check('untick: Done row voided, not deleted', db.tabs['🏠 Done'].find(r => r[0] === 8)[7] === true);
    check('untick: Last done restored from Prev', jr()[11] === serial('2027-01-07'), jr());
    // overdue fixed (Roll) and overdue floating
    await page.locator('#strip input[data-job="3"]').click(); await settle();
    const bin = db.tabs['🏠 Done'].find(r => r[0] === 9);
    check('tick overdue bin: Done for = the missed date', !!bin && bin[2] === serial('2027-01-11') && bin[4] === 3);
    check('tick overdue bin: fixed job Last done = max(current, for)', db.tabs['🏠 Jobs'].find(r => r[0] === 3)[11] === serial('2027-01-11'));
    check('tick overdue bin: leaves the overdue list', !(await text(page, '#strip [data-kind=overdue]')).includes('Red bin out'));
    await page.locator('#strip input[data-job="5"]').click(); await settle();
    check('tick overdue floating: for = due date, Last done = today', db.tabs['🏠 Done'].find(r => r[0] === 10)[2] === serial('2026-12-31') && db.tabs['🏠 Jobs'].find(r => r[0] === 5)[11] === serial(T));
    check('strip: overdue group gone', (await page.locator('#strip [data-kind=overdue]').count()) === 0);
    check('tick: no row deletes anywhere', !calls.some(c => JSON.stringify(c.body || '').includes('deleteDimension')));

    // 4. tick today's zone
    await today.locator('input[data-zone="1"]').click(); await settle();
    const zd = db.tabs['🏠 Done'].find(r => r[3] === 'Zone');
    check('zone tick: Done row for today', !!zd && zd[2] === serial(T) && zd[4] === 1 && zd[5] === 'Kitchen', zd);
    check('zone tick: Last cleaned = today', db.tabs['🏠 Zones'].find(r => r[0] === 1)[5] === serial(T));
    check('zone tick: today shows Kitchen done, next day still the next zone', (await today.locator('input[data-zone="1"]').isChecked()) && (await card(page, '2027-01-13').innerText()).includes('Bathroom') && (await card(page, '2027-01-14').innerText()).includes('Lounge'));
    await page.click('.tab[data-tab=zones]');
    check('zones tab: queue lists Bathroom first, Kitchen last', await page.evaluate(() => { const n = [...document.querySelectorAll('#zonesBody .queue li .linkish')].map(x => x.textContent); return n[0] === 'Bathroom' && n[n.length - 1] === 'Kitchen'; }));
    check('zones tab: hint text', (await text(page, '#zonesBody .hint')).includes('5 slots a week, so 7–10 zones means each room every 1½–2 weeks.'));
    await page.click('[data-newzone]'); await page.fill('#zName', 'Garage'); await page.fill('#zList', '- sweep\nsort boxes'); await page.click('#zoneForm button[type=submit]'); await settle();
    const nz = db.tabs['🏠 Zones'].find(r => r[1] === 'Garage');
    check('zone add: new row id 6 after the last row, checklist kept', !!nz && nz[0] === 6 && db.tabs['🏠 Zones'].indexOf(nz) === 6 && nz[4] === "- sweep\nsort boxes", nz);

    // 6. groceries
    await page.click('.tab[data-tab=groceries]');
    const com = await text(page, '#colCommute'), wk = await text(page, '#colWeekend'), rest = await text(page, '#colRest');
    check('groceries: column titles', com.includes('Commute shop · Thu 14 Jan · Light') && wk.includes('Weekend shop · Sat 16 Jan · Heavy'), [com.slice(0, 40), wk.slice(0, 40)]);
    check('groceries: Light in commute, Heavy in weekend, Any in the sooner shop', ['Milk', 'Bread', 'Eggs'].every(x => com.includes(x)) && wk.includes('Dog food') && !com.includes('Dog food') && !wk.includes('Eggs'));
    check('groceries: staple due again is on the list with a staple tag', com.includes('Butter') && (await page.locator('#colCommute li:has-text("Butter") .tag').innerText()) === 'staple' && (await page.locator('#colCommute li:has-text("Milk") .tag').count()) === 0);
    check('groceries: staples not yet due are in the rest list', rest.includes('Coffee') && rest.includes('Rice') && !rest.includes('Butter'));
    await page.locator('[data-bought="1"]').click(); await settle();
    const milk = db.tabs['🏠 Groceries'].find(r => r[0] === 1);
    check('groceries: bought writes Got + Last bought', milk[3] === 'Got' && milk[5] === serial(T), milk);
    check('groceries: bought item moves to the rest list', !(await text(page, '#colCommute')).includes('Milk') && (await text(page, '#colRest')).includes('Milk'));
    await page.fill('#qaItem', 'Apples'); await page.selectOption('#qaShop', 'Light'); await page.click('#quickAdd button[type=submit]'); await settle();
    const ap = db.tabs['🏠 Groceries'].find(r => r[1] === 'Apples');
    check('groceries: quick add appends a Need row with the next id', !!ap && ap[0] === 8 && ap[2] === 'Light' && ap[3] === 'Need' && db.tabs['🏠 Groceries'].indexOf(ap) === 8, ap);
    await page.locator('[data-need="1"]').click(); await settle();
    check('groceries: Need button puts it back on the list', db.tabs['🏠 Groceries'].find(r => r[0] === 1)[3] === 'Need' && (await text(page, '#colCommute')).includes('Milk'));

    // 7. add job through the dialog
    await page.click('.tab[data-tab=jobs]');
    const jobsText = await text(page, '#jobsBody');
    check('jobs: grouped by area with schedule in words', /bins/i.test(jobsText) && jobsText.includes('Every 2 weeks · Mon') && jobsText.includes('30 days after last done') && jobsText.includes('Sat before Green bin out'), jobsText);
    check('jobs: inactive job is under a collapsed Paused group', (await page.locator('#jobsBody details.paused summary').innerText()).includes('Paused (1)') && !(await page.locator('#jobsBody details.paused').evaluate(d => d.open)));
    check('jobs: statuses', (await page.locator('.jrow:has-text("Water pots") .tag').innerText()) === 'OK');
    await page.click('[data-newjob]'); await page.waitForSelector('#jobDlg[open]');
    await page.fill('#jJob', 'Take out compost'); await page.fill('#jArea', 'Kitchen'); await page.selectOption('#jMode', 'Fixed'); await page.fill('#jEvery', '1'); await page.selectOption('#jUnit', 'week');
    await page.fill('#jAnchor', T); await page.fill('#jDay', 'Sat'); await page.fill('#jMins', '5');
    check('add job: live preview shows the next 3 dates', (await text(page, '#jPreview')) === 'Next 3: Sat 16 Jan, Sat 23 Jan, Sat 30 Jan', await text(page, '#jPreview'));
    await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(100);
    const box = await page.locator('#jobDlg').boundingBox();
    check('add job: dialog fits a phone screen', box.x >= 0 && box.x + box.width <= 390, box);
    await page.screenshot({ path: path.join(OUT, 'shot-jobdialog-390.png') });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.click('#jobForm button[type=submit]'); await settle();
    const nj = db.tabs['🏠 Jobs'].find(r => r[1] === 'Take out compost');
    check('add job: new row id = max+1 appended after the last non-empty row', !!nj && nj[0] === 9 && db.tabs['🏠 Jobs'].indexOf(nj) === 9, nj && [nj[0], db.tabs['🏠 Jobs'].indexOf(nj)]);
    check('add job: cells written correctly', !!nj && nj[3] === 'Fixed' && nj[4] === 1 && nj[5] === 'week' && nj[6] === serial(T) && nj[7] === 'Sat' && nj[9] === 5 && nj[12] === true, nj);
    check('add job: appears in the Jobs list', (await text(page, '#jobsBody')).includes('Take out compost'));
    // linked job preview
    await page.click('[data-newjob]'); await page.fill('#jJob', 'Tip run'); await page.selectOption('#jLink', '1'); await page.fill('#jDay', 'Sat');
    check('add job: linked preview = Saturdays before the green bin', (await text(page, '#jPreview')) === 'Next 3: Sat 16 Jan, Sat 30 Jan, Sat 13 Feb', await text(page, '#jPreview'));
    await page.click('#jobDlg [data-close]');

    // 8. edit guard
    await page.click('[data-editjob="5"]'); await page.waitForSelector('#jobDlg[open]'); await page.fill('#jJob', 'Hacked');
    const row5 = db.tabs['🏠 Jobs'].find(r => r[0] === 5); row5[0] = 99; // sheet changed behind the page's back
    const before = JSON.stringify(row5);
    await page.click('#jobForm button[type=submit]'); await settle();
    check('edit guard: error notice shown', (await page.locator('#notice').isVisible()) && (await text(page, '#notice')).includes('changed'), await text(page, '#notice'));
    check('edit guard: row not overwritten', JSON.stringify(row5) === before && row5[1] === 'Clean fridge');
    check('edit guard: nothing written for that save', !calls.some(c => c.method === 'PUT' && c.body && JSON.stringify(c.body.values || '').includes('Hacked')));
    row5[0] = 5;

    // 11. settings dialog saves each value as its own row
    await page.click('#settingsBtn'); await page.waitForSelector('#setDlg[open]');
    check('settings: shows sheet id and values', (await page.inputValue('#sSheet')) === 'TESTSHEET1234567890abc' && (await page.inputValue('#sOffice')) === 'Thu' && (await page.inputValue('#sDelivery')) === 'no');
    await page.selectOption('#sDelivery', 'yes'); await page.fill('#sZoneMins', '45');
    const sCalls = calls.length; await page.click('#setForm button[type=submit]'); await settle();
    const sr = Object.fromEntries(db.tabs['🏠 Settings'].slice(1).map(r => [r[0], r[1]]));
    check('settings: changed values saved, others untouched', sr.delivery === 'yes' && String(sr.zone_minutes) === '45' && sr.office_day === 'Thu' && sr.zone_days === 'Mon, Tue, Wed, Thu, Fri' && String(sr.daily_cap) === '60', sr);
    check('settings: only the changed rows written', calls.slice(sCalls).filter(c => c.method === 'PUT').length === 2, calls.slice(sCalls).filter(c => c.method === 'PUT').map(c => c.path));
    check('settings: delivery moves the weekend shop to an order the day before', (await card(page, '2027-01-15').innerText()).includes('Delivery order') && !(await card(page, '2027-01-16').innerText()).includes('Weekend shop'));
    check('seeded: no row deletes in the whole run', !calls.some(c => JSON.stringify(c.body || '').includes('deleteDimension')));
  });

  /* backpack warning and busy tag */
  const heavy = seedTabs(true);
  for (let i = 0; i < 12; i++) heavy['🏠 Groceries'].splice(1, 0, [20 + i, 'Light thing ' + i, 'Light', 'Need', '', '', '']);
  heavy['🏠 Settings'].find(r => r[0] === 'daily_cap')[1] = 25;
  await scenario('backpack', { tabs: heavy }, async ({ page }) => {
    await live(page);
    check('busy: day over the daily cap is flagged', (await page.locator('.dcard[data-date="2027-01-12"] .tag.warn').innerText()) === 'Busy');
    await page.click('.tab[data-tab=groceries]');
    check('groceries: backpack warning over 12 items', (await text(page, '#colCommute')).includes('backpack'));
  });

  /* 9. demo + not connected */
  await scenario('demo', { token: false, query: '?demo' }, async ({ page, calls }) => {
    await page.waitForSelector('.dcard');
    check('demo: banner', (await text(page, '#demoBanner')).includes('Demo: sample data, nothing is saved'));
    check('demo: week has 7 cards, overdue items, zones', (await page.locator('.dcard').count()) === 7 && (await page.locator('#strip [data-kind=overdue] .srow').count()) >= 1 && (await page.locator('.dcard input[data-zone]').count()) >= 4);
    const od0 = await page.locator('#strip [data-kind=overdue] .srow').count();
    await page.locator('#strip [data-kind=overdue] input[data-job]').first().click(); await page.waitForTimeout(150);
    check('demo: ticking works in memory', (await page.locator('#strip [data-kind=overdue] .srow').count()) === od0 - 1);
    await page.click('.tab[data-tab=jobs]'); check('demo: jobs and areas listed', (await page.locator('.jrow').count()) >= 12);
    await page.click('[data-newjob]'); await page.fill('#jJob', 'Demo job'); await page.fill('#jAnchor', '2027-01-12'); await page.click('#jobForm button[type=submit]'); await page.waitForTimeout(150);
    check('demo: add job lands in memory', (await text(page, '#jobsBody')).includes('Demo job'));
    await layout(page, 'demo', [390, 1280]);
    check('demo: zero Sheets API calls', calls.length === 0, calls);
  });
  await scenario('not-connected', { token: false }, async ({ page, calls }) => {
    await page.waitForSelector('#gate:not([hidden])');
    check('gate: offers Connect and sample data', (await text(page, '#gate')).includes('Try with sample data') && (await page.locator('[data-act=connect]').count()) === 1);
    await page.screenshot({ path: path.join(OUT, 'shot-gate-1280.png') });
    await page.click('[data-act=demo]'); await page.waitForSelector('.dcard');
    check('gate: sample data button loads the demo with no API calls', (await page.locator('.dcard').count()) === 7 && calls.length === 0 && await page.locator('#demoBanner').isVisible());
  });

  await (await browserP).close();
  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
