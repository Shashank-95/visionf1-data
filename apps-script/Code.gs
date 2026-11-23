/* =====================================================================================
   VisionF1 weekly F1 data update (Google Apps Script). Paste this whole file into
   Extensions > Apps Script of the "VisionF1 Data" sheet (replacing the old code),
   then run setup() once.

   Since Nov 2026 motorsport.com blocks Google's servers, so the scraping runs in GitHub
   Actions instead (repo Shashank-95/visionf1-data, Mondays 06:00 IST). It publishes
   data/tabs.json. Every Monday ~08:00 IST this script:
     1. Downloads data/tabs.json and data/status.json from that repo.
     2. Checks them: fresh (scraped in the last 4 days), every tab present with the same
        columns as the sheet, no tab shrinking below 60% of its rows.
     3. Only if all checks pass, rewrites the data tabs IN PLACE (tab IDs never change, so
        the website keeps reading the right tabs).
     4. If anything fails, last week's data stays untouched and you get an email.
   Run updateNow() any time to load the latest published data straight away.
   ===================================================================================== */

var VF_CONFIG = {
  DATA_URL: "https://raw.githubusercontent.com/Shashank-95/visionf1-data/main/data/",
  NOTIFY_EMAIL: true,          // email the sheet owner if an update fails
  MAX_AGE_DAYS: 4,             // the scrape must be at most this old
  MIN_ROW_RATIO: 0.6,          // abort if a tab would shrink below 60% of its current rows
  TABS: ["Results", "Standings", "Standings Round-by-Round", "Schedule", "Drivers", "Teams", "Qualifying",
    "Starting Grid", "Practice", "Pit Stops", "Tyre Stints", "Fastest Laps", "Championship History"]
};

/* ---------- public entry points ---------- */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (["weeklyUpdate", "continueUpdate"].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("weeklyUpdate").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).nearMinute(0)
    .inTimezone("Asia/Kolkata").create();
  PropertiesService.getScriptProperties().deleteProperty("VF_STATE");      // left over from the old scraper
  var ss = SpreadsheetApp.getActive(), stage = ss.getSheetByName("_vf_stage");
  if (stage) ss.deleteSheet(stage);                                         // old scraper's hidden staging tab
  vfStatus_("Weekly update scheduled: Mondays around 08:00 IST (data from GitHub Shashank-95/visionf1-data).");
}
function weeklyUpdate() { vfUpdate_(); }
function updateNow() { vfUpdate_(); }

/* ---------- update ---------- */
function vfUpdate_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var bust = "?t=" + Date.now(), status, tabs;
    try {
      status = JSON.parse(vfGet_(VF_CONFIG.DATA_URL + "status.json" + bust));
      tabs = JSON.parse(vfGet_(VF_CONFIG.DATA_URL + "tabs.json" + bust));
    } catch (e) { return vfFail_("Could not download the data from GitHub: " + e); }

    var problems = [], ss = SpreadsheetApp.getActive();
    var age = (Date.now() - new Date(status.generated).getTime()) / 86400000;
    if (!(age <= VF_CONFIG.MAX_AGE_DAYS))
      problems.push("the latest scrape is from " + status.generated + " (older than " + VF_CONFIG.MAX_AGE_DAYS +
        " days; check the Actions tab of github.com/Shashank-95/visionf1-data)");
    VF_CONFIG.TABS.forEach(function (tab) {
      var v = tabs[tab];
      if (!v || !v.length || !v[0].length) { problems.push("tab " + tab + " is missing"); return; }
      var sh = ss.getSheetByName(tab);
      if (!sh) return;
      var cur = Math.max(sh.getLastRow() - 1, 0), nxt = v.length - 1;
      if (cur > 20 && nxt < cur * VF_CONFIG.MIN_ROW_RATIO) problems.push(tab + " would shrink from " + cur + " to " + nxt + " rows");
      if (sh.getLastColumn() > 0) {
        var head = sh.getRange(1, 1, 1, v[0].length).getValues()[0].join("|");
        if (cur > 0 && head !== v[0].join("|")) problems.push(tab + " columns changed");
      }
    });
    if (problems.length) return vfFail_("Checks failed, data NOT changed: " + problems.join("; "));

    VF_CONFIG.TABS.forEach(function (tab) { vfWriteTab_(ss, tab, tabs[tab]); });
    var counts = VF_CONFIG.TABS.map(function (t) { return t + ": " + (tabs[t].length - 1); }).join(", ");
    vfStatus_("OK " + vfNow_() + " (scraped " + status.generated.slice(0, 16).replace("T", " ") + " UTC). Rows: " + counts +
      (status.notes && status.notes.length ? ". Notes: " + status.notes.join(" | ") : ""));
  } finally { lock.releaseLock(); }
}
function vfGet_(url) {
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (r.getResponseCode() !== 200) throw new Error("HTTP " + r.getResponseCode() + " for " + url.split("?")[0]);
  return r.getContentText("UTF-8");
}

/* ---------- rewrite one tab in place ---------- */
function vfWriteTab_(ss, tab, values) {
  var sh = ss.getSheetByName(tab);
  if (!sh) sh = ss.insertSheet(tab);           // only on first install; existing tabs keep their IDs
  var nr = values.length, nc = values[0].length;
  if (sh.getMaxRows() < nr) sh.insertRowsAfter(sh.getMaxRows(), nr - sh.getMaxRows());
  if (sh.getMaxColumns() < nc) sh.insertColumnsAfter(sh.getMaxColumns(), nc - sh.getMaxColumns());
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearContent();
  /* text columns are stored as plain text so values like 16:30 or 2026-05-21 are never turned into dates */
  for (var i = 0; i < nc; i++) {
    var first = null;
    for (var r = 1; r < nr && first === null; r++) if (values[r][i] !== "") first = values[r][i];
    sh.getRange(1, i + 1, nr, 1).setNumberFormat(typeof first === "number" ? "General" : "@");
  }
  sh.getRange(1, 1, nr, nc).setValues(values);
  if (sh.getMaxRows() > nr + 1) sh.deleteRows(nr + 2, sh.getMaxRows() - nr - 1);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, nc).setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#15151E");
}

/* ---------- status / failure ---------- */
function vfNow_() { return Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd HH:mm") + " IST"; }
function vfStatus_(msg) {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName("Data Notes") || ss.insertSheet("Data Notes");
  var n = Math.max(sh.getLastRow(), 1), col = sh.getRange(1, 1, n, 1).getValues(), row = -1;
  for (var i = 0; i < col.length; i++) if (col[i][0] === "Last update") row = i + 1;
  if (row < 0) row = n + 2;
  sh.getRange(row, 1, 1, 2).setNumberFormat("@").setValues([["Last update", msg]]);
}
function vfFail_(msg) {
  vfStatus_("FAILED " + vfNow_() + ": " + msg + " Last week's data is unchanged.");
  if (VF_CONFIG.NOTIFY_EMAIL) {
    try { MailApp.sendEmail(Session.getEffectiveUser().getEmail(), "VisionF1 F1 data update failed", msg + "\n\nThe sheet still holds last week's data. Run updateNow() from Extensions > Apps Script to retry."); } catch (e) {}
  }
}
