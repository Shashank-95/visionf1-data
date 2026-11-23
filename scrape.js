/* VisionF1 F1 data: weekly scrape (runs in GitHub Actions, or locally with `node scrape.js`).
   Scrapes motorsport.com with core.js, checks the result, and writes:
     data/tabs.json   one array of rows per sheet tab (header row first), exactly what the sheet holds
     data/status.json when it ran, row counts, notes
   The "VisionF1 Data" sheet's Apps Script reads both files and rewrites its tabs.
   Exits with an error (and writes nothing) when checks fail, so a bad scrape never reaches the sheet. */
const fs = require("fs"), path = require("path");
const core = require("./core.js");
const OUT = path.join(__dirname, "data");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const MIN_ROW_RATIO = 0.6; // a tab shrinking below 60% of last week's rows means the site changed: stop
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fetched = 0;

async function fetchOne(p) {
  const url = p.startsWith("http") ? p : core.BASE + p;
  let last;
  for (let a = 0; a < 4; a++) {
    try {
      await sleep(250);
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
      if (res.status === 404) return "";
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      fetched++;
      return await res.text();
    } catch (e) { last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}
async function fetchMany(paths) {
  const out = new Array(paths.length); let i = 0;
  await Promise.all([0, 1, 2, 3].map(async () => { while (i < paths.length) { const k = i++; out[k] = await fetchOne(paths[k]); } }));
  return out;
}
async function runUnit(u, now) {
  const g = core.makeUnit(u, now); let r = g.next();
  while (!r.done) r = g.next(await fetchMany(r.value));
  return r.value;
}

(async () => {
  const now = Date.now(), acc = {}, warns = [];
  const queue = core.plan(now);
  while (queue.length) {
    const u = queue.shift(), res = await runUnit(u, now);
    if (u.type === "standings") queue.push(...core.historyUnits(res._meta.season));
    if (res._enqueue) queue.push(...res._enqueue);
    if (res._warn) warns.push(...res._warn);
    for (const k of Object.keys(res)) if (k[0] !== "_") (acc[k] = acc[k] || []).push(...res[k]);
  }
  core.finalize(acc);
  const problems = core.validate(acc);

  const tabs = {}, rows = {};
  for (const t of Object.keys(core.TABS)) { tabs[t] = core.toValues(t, acc[t] || []); rows[t] = tabs[t].length - 1; }

  /* site-change guards against last week's file */
  const prevFile = path.join(OUT, "tabs.json");
  if (fs.existsSync(prevFile)) {
    const prev = JSON.parse(fs.readFileSync(prevFile, "utf8"));
    for (const t of Object.keys(tabs)) {
      const cur = prev[t] ? prev[t].length - 1 : 0;
      if (cur > 20 && rows[t] < cur * MIN_ROW_RATIO) problems.push(t + " would shrink from " + cur + " to " + rows[t] + " rows");
    }
  }
  /* nationality goes blank when motorsport.com changes its driver cell markup (happened Nov 2026) */
  const res = tabs["Results"], natCol = res[0].indexOf("Driver Nationality");
  const withNat = res.slice(1).filter(r => r[natCol] !== "").length;
  if (rows["Results"] > 20 && withNat < rows["Results"] * 0.9) problems.push("Results: only " + withNat + " of " + rows["Results"] + " rows have a driver nationality (site markup changed?)");

  console.log(JSON.stringify({ fetched, warns, problems, rows }, null, 1));
  if (problems.length) { console.error("Checks failed, data NOT written: " + problems.join("; ")); process.exit(1); }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(prevFile, JSON.stringify(tabs));
  fs.writeFileSync(path.join(OUT, "status.json"), JSON.stringify({
    generated: new Date(now).toISOString(), rows, notes: warns, source: "motorsport.com"
  }, null, 1) + "\n");
})().catch(e => { console.error(e); process.exit(1); });
