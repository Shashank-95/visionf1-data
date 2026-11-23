# VisionF1 F1 data

Weekly F1 data for the "VisionF1 Data" Google Sheet, which feeds the F1 Hub on visionf1.com.

- `scrape.js` scrapes motorsport.com F1 pages (results, standings, schedule, drivers, teams, qualifying, grid,
  practice, pit stops, tyre stints, fastest laps, championship history) using `core.js`, checks the result and
  writes `data/tabs.json` (one array of rows per sheet tab) and `data/status.json`.
- `.github/workflows/weekly.yml` runs it every Monday at 06:00 and 07:00 IST and commits the data.
  Run it any time from the Actions tab ("Run workflow").
- `apps-script/Code.gs` is the sheet's Apps Script. On Mondays at 08:00 IST it loads `data/tabs.json`,
  checks it (fresh, all tabs present, same columns, no tab shrinking below 60%) and rewrites the tabs in place.

If a run fails, the sheet keeps last week's data. GitHub emails the repo owner about a failed Action, and the
Apps Script emails the sheet owner and writes the reason in Data Notes > "Last update".

Local run: `node scrape.js` (Node 18+, no dependencies).
