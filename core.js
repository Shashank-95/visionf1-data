/* VisionF1 F1 data pipeline: scraper core.
   Plain JavaScript with no dependencies, so the same file runs in Google Apps Script (weekly job)
   and in Node (local runs and tests). Source: motorsport.com F1 pages.

   The job is a queue of "units". Each unit is a generator: it yields arrays of paths to fetch,
   receives their HTML, and returns rows for the sheet tabs. Drivers (Apps Script / Node) only do I/O. */
var VFCore = (function () {
  "use strict";
  var BASE = "https://www.motorsport.com";

  /* ======================= tab layouts (column order = sheet columns) ======================= */
  var TABS = {
    "Results": ["Series", "Series Slug", "Season", "Event", "Event Title (as on site)", "Event Start Date", "Event End Date", "Venue", "Country",
      "Session Code", "Session", "Row Order", "Pos", "Car No.", "Driver(s)", "Driver Nationality", "Team", "Chassis", "Engine", "Laps",
      "Total Time", "Gap to Leader", "Interval", "Avg Speed", "Speed Unit", "Pits", "Points", "Retirement Reason",
      "Driver Profile URL(s)", "Team URL", "Car Image Label", "Car Image URL", "Source URL"],
    "Standings": ["Series", "Series Slug", "Season", "Championship (tab on site)", "Standings Type", "Row Order", "Pos", "Name", "Nationality",
      "Team", "Points", "Rounds in Table", "Rounds Scored", "Wins (finish pos 1)", "Profile URL", "Source URL"],
    "Standings Round-by-Round": ["Series", "Season", "Championship (tab on site)", "Standings Type", "Pos", "Name", "Round #", "Round Code",
      "Round Country", "Points", "Finish Pos"],
    "Schedule": ["Series", "Series Slug", "Season", "Event Order", "Event", "Entry Kind", "Championship Round", "Status", "Country Code",
      "Event Main Date (local)", "Event Main Time (local)", "Event Main Start (UTC)", "Session #", "Session", "Session Date (local)",
      "Session Time (local)", "Local UTC Offset", "Session Start (local, ISO)", "Session Start (UTC, ISO)", "Time TBC", "Location URL", "Source URL"],
    "Drivers": ["Season", "Car No.", "Driver", "Team", "Date of Birth", "Nationality", "Profile URL", "Source URL"],
    "Teams": ["Season", "Team", "Car", "Country", "Driver Numbers", "Drivers", "Team URL", "Source URL"],
    "Qualifying": ["Season", "Event", "Event Start Date", "Session Code", "Session", "Row Order", "Pos", "Car No.", "Driver", "Driver Nationality",
      "Team", "Chassis", "Engine", "Laps", "Time", "Gap to Leader", "Interval", "Tyre", "Avg Speed (km/h)", "Driver Profile URL", "Source URL"],
    "Starting Grid": ["Season", "Event", "Event Start Date", "Row Order", "Grid Pos", "Car No.", "Driver", "Driver Nationality", "Team",
      "Chassis", "Engine", "Qualifying Time", "Gap to Pole", "Avg Speed (km/h)", "Driver Profile URL", "Source URL"],
    "Practice": ["Season", "Event", "Event Start Date", "Session Code", "Session", "Row Order", "Pos", "Car No.", "Driver", "Driver Nationality",
      "Team", "Chassis", "Engine", "Laps", "Time", "Gap to Leader", "Interval", "Tyre", "Avg Speed (km/h)", "Driver Profile URL", "Source URL"],
    "Pit Stops": ["Season", "Event", "Event Start Date", "Row Order", "Car No.", "Driver", "Team", "Chassis", "Engine", "Lap", "Time", "Driver Profile URL", "Source URL"],
    "Tyre Stints": ["Season", "Event", "Event Start Date", "Race Pos", "Car No.", "Driver", "Team", "Stint", "Compound", "Laps", "Driver Profile URL", "Source URL"],
    "Fastest Laps": ["Season", "Event", "Event Start Date", "Row Order", "Pos", "Car No.", "Driver", "Driver Nationality", "Team", "Chassis", "Engine", "Lap",
      "Time", "Gap to Leader", "Interval", "Tyre", "Avg Speed (km/h)", "Driver Profile URL", "Source URL"],
    "Championship History": ["Season", "Championship", "Row Order", "Pos", "Name", "Nationality", "Team", "Points", "Profile URL", "Source URL"]
  };
  /* numeric columns are written as numbers; every other column is written as plain text */
  var NUMERIC = { "Season": 1, "Row Order": 1, "Event Order": 1, "Session #": 1, "Round #": 1, "Rounds in Table": 1, "Rounds Scored": 1,
    "Wins (finish pos 1)": 1, "Stint": 1 };
  var NUMERIC_IF_NUMBER = { "Pos": 1, "Laps": 1, "Pits": 1, "Points": 1, "Finish Pos": 1, "Grid Pos": 1, "Race Pos": 1, "Lap": 1 };
  var QUALI_CODES = { "Q1": "Q1", "Q2": "Q2", "Q3": "Q3", "CQ": "Qualifying (combined)", "SQ1": "Sprint Q1", "SQ2": "Sprint Q2", "SQ3": "Sprint Q3", "CSQ": "Sprint Qualifying (combined)" };
  var PRACTICE_CODES = { "FP1": "Practice 1", "FP2": "Practice 2", "FP3": "Practice 3" };
  var RACE_CODE = /^(RACE\d*|SPR)$/;

  /* ======================= HTML helpers (regex based: Apps Script has no DOM) ======================= */
  var ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "..." };
  function decode(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e[0] === "#") { var c = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return c === 160 ? " " : String.fromCharCode(c); }
      return ENT.hasOwnProperty(e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
    });
  }
  function clean(s) { return decode(String(s || "")).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
  function text(html) {
    return clean(String(html || "").replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "));
  }
  function attr(tag, name) {
    var m = new RegExp("\\b" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", "i").exec(tag || "");
    return m ? decode(m[2] !== undefined ? m[2] : m[3]).trim() : "";
  }
  function absUrl(h) { if (!h) return ""; if (h.indexOf("//") === 0) return "https:" + h; if (h[0] === "/") return BASE + h; return h; }
  function firstTag(html, re) { var m = re.exec(html); return m ? m[0] : ""; }
  function inner(html, re) { var m = re.exec(html); return m ? m[1] : null; }
  function fieldOf(tagAttrs) { var m = /ms-table_field--([A-Za-z0-9_-]+)/.exec(tagAttrs || ""); return m ? m[1] : ""; }
  function num(v) { return /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : v; }

  /* ======================= generic table parsing (port of the verified Python parser) ======================= */
  function tableHtml(html, cls) {
    var i = html.indexOf(cls ? '<table class="' + cls : "<table");
    if (cls && i < 0) { var re = new RegExp('<table[^>]*class="[^"]*' + cls), m = re.exec(html); i = m ? m.index : -1; }
    if (i < 0) return "";
    var j = html.indexOf("</table>", i);
    return j < 0 ? "" : html.slice(i, j + 8);
  }
  function headers(table) {
    var out = [], thead = inner(table, /<thead\b[^>]*>([\s\S]*?)<\/thead>/i) || "", re = /<th\b([^>]*)>([\s\S]*?)<\/th>/gi, m;
    while ((m = re.exec(thead))) out.push({ field: fieldOf(m[1]), label: text(m[2]), html: m[2] });
    return out;
  }
  function bodyRows(table) {
    var tbody = inner(table, /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i) || "", rows = [], re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, m;
    while ((m = re.exec(tbody))) {
      var cells = [], cre = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi, c;
      while ((c = cre.exec(m[1]))) cells.push({ field: fieldOf(c[1]), html: c[2] });
      if (cells.length) rows.push(cells);
    }
    return rows;
  }
  var DRIVER_FIELDS = { result_driver_id: 1, driver: 1, result_driver: 1, drivers: 1 };
  var TEAM_FIELDS = { result_team: 1, team: 1, result_team_id: 1 };
  function spanText(html, cls) {
    var m = new RegExp('<span\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)</span>', "i").exec(html);
    return m ? text(m[1]) : null;
  }
  function nameOf(html) {
    var v = spanText(html, "name-full"); if (v !== null) return v;
    v = spanText(html, "name-short"); if (v !== null) return v;
    v = spanText(html, "name"); if (v !== null) return v;
    return text(html);
  }
  function parseCell(cell) {
    var html = cell.html, field = cell.field, out = {};
    /* driver blocks: linked <a href="/driver/..."> and unlinked <div class="info"> (not inside a link) */
    var units = [], are = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi, m, linkSpans = [];
    while ((m = are.exec(html))) {
      linkSpans.push([m.index, m.index + m[0].length]);
      var href = attr(m[1], "href");
      if (/\/driver\//.test(href) && /class="[^"]*\binfo\b/.test(m[2])) units.push({ at: m.index, html: m[2], href: href, img: firstTag(m[2], /<img\b[^>]*>/i) });
    }
    if (!TEAM_FIELDS[field]) {
      var dre = /<div\b[^>]*class="[^"]*\binfo\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
      while ((m = dre.exec(html))) {
        var inLink = linkSpans.some(function (s) { return m.index >= s[0] && m.index < s[1]; });
        if (inLink) continue;
        var hasName = /name-short|name-full/.test(m[1]);
        if (!hasName && !DRIVER_FIELDS[field]) continue;
        var before = html.slice(0, m.index), imgM = /<img\b[^>]*>\s*$/i.exec(before);
        units.push({ at: m.index, html: m[1], href: "", img: imgM ? imgM[0] : "" });
      }
    }
    if (units.length) {
      units.sort(function (a, b) { return a.at - b.at; });
      var names = [], nats = [], urls = [], teams = [];
      units.forEach(function (u) {
        /* Nov 2026 layout: <div class="info-wrapper"><img alt=nat><span class="info"><a class="name" href="/driver/..">
           <a class="team">Team</a></span></div>, so flag, profile link and team sit inside the block */
        if (!u.img) u.img = firstTag(u.html, /<img\b[^>]*>/i);
        if (!u.href) { var dl = /<a\b([^>]*href="[^"]*\/driver\/[^"]*"[^>]*)>/i.exec(u.html); if (dl) u.href = attr(dl[1], "href"); }
        if (spanText(u.html, "team") === null) { var ta = spanTextTag(u.html, "a", "team"); if (ta) u.html += '<span class="team">' + ta + "</span>"; }
        names.push(nameOf(u.html)); nats.push(u.img ? attr(u.img, "alt") : ""); urls.push(u.href ? absUrl(u.href) : "");
        var tm = spanText(u.html, "team"); if (tm !== null) teams.push(tm);
      });
      out["Driver"] = names.join(" / ");
      out["Driver Nationality"] = nats.some(Boolean) ? nats.join(" / ") : "";
      if (teams.length) out["Team"] = teams.join(" / ");
      out["Driver URL"] = urls.some(Boolean) ? urls.join(" | ") : "";
      return out;
    }
    if (TEAM_FIELDS[field]) {
      var nm = spanText(html, "name"), cl = spanText(html, "class"), a = firstTag(html, /<a\b[^>]*href=[^>]*>/i), img = firstTag(html, /<img\b[^>]*>/i);
      out["Team"] = nm !== null ? nm : text(html);
      if (cl !== null) out["Class"] = cl;
      if (img && attr(img, "alt")) out["Team Nationality"] = attr(img, "alt");
      out["Team URL"] = a ? absUrl(attr(a, "href")) : "";
      return out;
    }
    if (field === "car_logo") {
      var im = firstTag(html, /<img\b[^>]*>/i), an = firstTag(html, /<a\b[^>]*href=[^>]*>/i);
      out["Car (image label)"] = im ? attr(im, "alt") : "";
      out["Car Image URL"] = im ? absUrl(attr(im, "src")) : "";
      out["Team URL"] = an ? absUrl(attr(an, "href")) : "";
      return out;
    }
    if (field === "time") {
      var ps = [], pre = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
      while ((m = pre.exec(html))) { var t = text(m[1]); if (t) ps.push(t); }
      if (!ps.length) { var tt = text(html); if (tt) ps.push(tt); }
      if (ps.length >= 2) { out["Gap to Leader"] = ps[0]; out["Total Time"] = ps[ps.length - 1]; }
      else if (ps.length === 1) { if (ps[0][0] === "+") { out["Gap to Leader"] = ps[0]; out["Total Time"] = ""; } else { out["Gap to Leader"] = ""; out["Total Time"] = ps[0]; } }
      else { out["Gap to Leader"] = ""; out["Total Time"] = ""; }
      return out;
    }
    if (field === "tyre-history") {
      out.value = text(html);
      /* compound letter is in <strong class="label"> or <span class="label"> */
      var lb = /<(strong|span)\b[^>]*class="[^"]*\blabel\b[^"]*"[^>]*>([^<]*)/i.exec(html);
      out.compound = lb ? clean(lb[2]) : "";
      /* the site's markup is malformed here ("<span class="value">16</td></span>"), so read up to the next tag */
      var lv = /<span\b[^>]*class="[^"]*\bvalue\b[^"]*"[^>]*>([^<]*)/i.exec(html);
      out.laps = lv ? clean(lv[1]) : "";
      return out;
    }
    var sub = /<sub\b[^>]*>([\s\S]*?)<\/sub>/i.exec(html);
    if (sub) { out.value = text(html.replace(sub[0], " ")); out.sub = text(sub[1]); return out; }
    out.value = text(html);
    return out;
  }
  function spanTextTag(html, tag, cls) {
    var m = new RegExp("<" + tag + '\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)</' + tag + ">", "i").exec(html);
    return m ? text(m[1]) : "";
  }
  var FIELD_LABEL = { pos: "Pos", number: "Car No.", laps: "Laps", interval: "Interval", avg_speed: "Avg Speed", pits: "Pits", points: "Points",
    retirement: "Retirement Reason", car_make: "Chassis", engine_make: "Engine", car_model: "Car Model", tyre: "Tyre", best_lap: "Best Lap",
    best_lap_time: "Best Lap Time", gap: "Gap", grid: "Grid", class_pos: "Class Pos", "class": "Class", manufacturer: "Manufacturer" };
  var FIXED = { pos: "Pos", number: "Car No.", retirement: "Retirement Reason", car_model: "Car Model", stage_time: "Stage Time",
    bonus_points: "Bonus Points", speed_trap: "Speed Trap", points: "Points", laps: "Laps", interval: "Interval", pits: "Pits" };

  function parseResultTable(html) {
    var table = tableHtml(html, "ms-table ms-table--result");
    if (!table) return { rows: [], heads: [] };
    var heads = headers(table), rows = [];
    bodyRows(table).forEach(function (cells) {
      var row = {}, stints = [];
      cells.forEach(function (cell, idx) {
        var f = cell.field, hdr = idx < heads.length ? heads[idx].label : f, p = parseCell(cell);
        if (f === "tyre-history") { stints.push({ stint: hdr, compound: p.compound || "", laps: p.laps || "" }); return; }
        if (p.hasOwnProperty("value")) {
          var label = FIXED[f] || hdr || FIELD_LABEL[f] || f;
          if (f === "avg_speed" && hdr) label = "Avg Speed (" + hdr + ")";
          row[label] = p.value;
          if (p.sub) row[label + " (sub)"] = p.sub;
        } else {
          Object.keys(p).forEach(function (k) {
            var v = p[k];
            if (row[k] && v && row[k] !== v) row[k] = row[k] + " / " + v;
            else if (!row.hasOwnProperty(k) || !row[k]) row[k] = v;
          });
        }
      });
      if (stints.length) row._stints = stints;
      rows.push(row);
    });
    return { rows: rows, heads: heads };
  }

  function parseStandings(html) {
    var table = tableHtml(html, "");
    if (!table) return { rows: [], rounds: [] };
    var heads = headers(table), rounds = [];
    heads.forEach(function (h) { if (h.field === "race_points") { var img = firstTag(h.html, /<img\b[^>]*>/i); rounds.push({ code: h.label, country: img ? attr(img, "alt") : "" }); } });
    var rows = bodyRows(table).map(function (cells) {
      var row = {}, rr = [];
      cells.forEach(function (cell, idx) {
        var f = cell.field, hdr = idx < heads.length ? heads[idx].label : f, p = parseCell(cell);
        if (f === "race_points") { rr.push({ points: p.value || "", pos: (p.sub || "").replace(/^\/+/, "") }); }
        else if (p.hasOwnProperty("value")) { row[{ pos: "Pos", total_points: "Points" }[f] || hdr || f] = p.value; }
        else Object.keys(p).forEach(function (k) { if (!row.hasOwnProperty(k)) row[k] = p[k]; });
      });
      row._rounds = rr;
      return row;
    });
    return { rows: rows, rounds: rounds };
  }
  function currentTab(html) {
    var re = /<li\b([^>]*class="[^"]*ms-tab-menu__item[^"]*"[^>]*)>([\s\S]*?)<\/li>/gi, m, cur = "", all = [];
    while ((m = re.exec(html))) { var t = text(m[2]); all.push(t); if (/\bcurrent\b/.test(attr(m[1], "class"))) cur = cur || t; }
    return { current: cur, all: all };
  }

  /* ---------- event page ---------- */
  var MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  function isoDate(s) { var m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(s); return m ? m[3] + "-" + ("0" + MONTHS[m[1]]).slice(-2) + "-" + ("0" + m[2]).slice(-2) : ""; }
  function eventHeader(html) {
    var h1m = /<h1\b[^>]*class="[^"]*msnt-heading[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (!h1m) return null;
    var title = text(h1m[1]), after = html.slice(h1m.index + h1m[0].length, h1m.index + h1m[0].length + 6000);
    var flag = firstTag(after, /<img\b[^>]*msnt-select__option-flag[^>]*>/i);
    var dm = /([A-Z][a-z]{2} \d{1,2}, \d{4})(?: to ([A-Z][a-z]{2} \d{1,2}, \d{4}))?/.exec(text(after.slice(0, 3000)));
    var loc = /<a\b[^>]*href="([^"]*\/location\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(after);
    var start = dm ? isoDate(dm[1]) : "", end = dm ? (dm[2] ? isoDate(dm[2]) : start) : "";
    return { title: title, country: flag ? attr(flag, "alt") : "", datesText: dm ? dm[0] : "", start: start, end: end,
      venue: loc ? text(loc[2]) : "", venueUrl: loc ? absUrl(loc[1]) : "" };
  }
  function sessionTabs(html, path) {
    var out = [], seen = {}, re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi, m;
    while ((m = re.exec(html))) {
      var href = attr(m[1], "href"), q = /\?st=([A-Za-z0-9_]+)$/.exec(href);
      if (q && href.split("?")[0] === path && !seen[q[1]]) { seen[q[1]] = 1; out.push({ code: q[1], label: text(m[2]) }); }
    }
    return out;
  }

  /* ---------- schedule ---------- */
  function times(html) {
    var loc = "", utc = "", re = /<msnt-formatted-date\b([^>]*)>([\s\S]*?)<\/msnt-formatted-date>/gi, m;
    while ((m = re.exec(html))) {
      var t = firstTag(m[2], /<time\b[^>]*>/i); if (!t) continue;
      var dt = attr(t, "datetime");
      if (/date--your/.test(attr(m[1], "class"))) { if (!utc) utc = dt; } else if (!loc) loc = dt;
    }
    return { loc: loc, utc: utc };
  }
  function cellByClass(trHtml, cls) {
    var re = new RegExp('<td\\b[^>]*class="[^"]*' + cls + '[^"]*"[^>]*>([\\s\\S]*?)</td>', "i"), m = re.exec(trHtml);
    return m ? m[1] : null;
  }
  function parseSchedule(html) {
    var events = [], re = /<tbody\b([^>]*class="[^"]*ms-schedule-table__item\b[^"]*"[^>]*)>([\s\S]*?)<\/tbody>/gi, m;
    while ((m = re.exec(html))) {
      var cls = attr(m[1], "class"), sm = /ms-schedule-table__item--(upcoming|past|live|canceled|cancelled)(\s|$)/.exec(cls);
      var trs = [], tre = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, t;
      while ((t = tre.exec(m[2]))) trs.push(t[1]);
      if (!trs.length) continue;
      var main = trs[0];
      var titleBlk = inner(main, /ms-schedule-table-item-main__title"[^>]*>([\s\S]*?)<\/div>/i) || "";
      var serA = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(titleBlk);
      var evBlk = inner(main, /ms-schedule-table-item-main__event"[^>]*>([\s\S]*?)<\/div>/i);
      var evA = evBlk ? firstTag(evBlk, /<a\b[^>]*href=[^>]*>/i) : "";
      var flag = firstTag(main, /<img\b[^>]*ms-schedule-table-item-main__flag[^>]*>/i);
      var dateTd = cellByClass(main, "ms-schedule-table__cell--date");
      var tm = dateTd !== null ? times(dateTd) : { loc: "", utc: "" };
      var ev = {
        series: serA ? text(serA[2]) : "", event: evBlk !== null ? text(evBlk) : "", eventUrl: evA ? absUrl(attr(evA, "href")) : "",
        cc: flag ? (attr(flag, "src").split("/").pop().split("-")[0] || "").toUpperCase() : "",
        status: sm ? sm[1] : "", mainLocal: tm.loc, mainUtc: tm.utc, mainText: (dateTd !== null && !tm.loc) ? text(dateTd) : "", sessions: []
      };
      trs.slice(1).forEach(function (tr) {
        var tt = /<span\b[^>]*class="[^"]*ms-schedule-table-subevent-day__title[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(tr) ||
                 /<span\b[^>]*class="[^"]*ms-schedule-table-subevent-day__title[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(tr);
        if (!tt) return;
        var titleHtml = tt[1].replace(/<span\b[^>]*class="hidden"[^>]*>[\s\S]*?<\/span>/gi, " ").replace(/<span\b[^>]*\bhidden\b[^>]*>[\s\S]*?<\/span>/gi, " ");
        var st2 = times(tr), dc = cellByClass(tr, "ms-schedule-table__cell--date");
        ev.sessions.push({ session: text(titleHtml), local: st2.loc, utc: st2.utc, text: st2.loc ? "" : (dc !== null ? text(dc) : "") });
      });
      events.push(ev);
    }
    return events;
  }
  function hasPage(html, n) { return html.indexOf("&amp;p=" + n + '"') >= 0 || html.indexOf("&p=" + n + '"') >= 0; }

  /* ---------- drivers / teams pages ---------- */
  function parseDrivers(html) {
    var out = [], re = /<a\b[^>]*class="ms-item--driver[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, m;
    while ((m = re.exec(html))) {
      var b = m[2];
      var info = function (label) {
        var r = new RegExp(label + ':</span>([\\s\\S]*?)</div>', "i").exec(b);
        return r ? text(r[1].replace(/<span\b[^>]*info-row--age[^>]*>[\s\S]*?<\/span>/i, "")) : "";
      };
      out.push({ no: text(inner(b, /ms-item-driver__number[^>]*>([\s\S]*?)<\/span>/i) || ""), name: text(inner(b, /<p\b[^>]*ms-item__title[^>]*>([\s\S]*?)<\/p>/i) || ""),
        team: info("Team"), born: info("Born"), nat: info("Nationality"), url: absUrl(m[1]) });
    }
    return out;
  }
  function parseTeams(html) {
    var out = [], re = /<a\b[^>]*class="ms-item--team[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, m;
    while ((m = re.exec(html))) {
      var b = m[2], rows = [], rre = /<div\b[^>]*ms-item-team__info-row[^>]*>([\s\S]*?)<\/div>\s*(?=<div\b[^>]*ms-item-team__info-row|<\/div>)/gi, r;
      var name = text(inner(b, /<span\b[^>]*ms-item__title[^>]*>([\s\S]*?)<\/span>/i) || "");
      var car = "", country = "";
      var infoRows = b.split(/<div\b[^>]*class="ms-item-team__info-row[^"]*"[^>]*>/i).slice(1);
      if (infoRows[1]) car = text(infoRows[1].split(/<\/div>/i)[0]);
      infoRows.forEach(function (x) { var c = /Country:<\/span>([\s\S]*?)<\/div>/i.exec(x); if (c) country = text(c[1]); });
      var nums = [], names = [], dre = /<li\b[^>]*ms-item-team_driver\b[^>]*>([\s\S]*?)<\/li>/gi, d;
      while ((d = dre.exec(b))) { var n = text(inner(d[1], /ms-item-team_driver-number[^>]*>([\s\S]*?)<\/span>/i) || ""); nums.push(n); names.push(text(d[1].replace(/<span\b[^>]*ms-item-team_driver-number[\s\S]*?<\/span>/i, ""))); }
      void rows; void rre;
      out.push({ name: name, car: car, country: country, nums: nums, drivers: names, url: absUrl(m[1]) });
    }
    return out;
  }

  /* ======================= row builders ======================= */
  function splitIso(iso) {
    if (!iso) return ["", "", ""];
    var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso);
    if (!m) return ["", "", ""];
    var off = !m[3] || m[3] === "Z" ? "+00:00" : (m[3].length === 5 ? m[3].slice(0, 3) + ":" + m[3].slice(3) : m[3]);
    return [m[1], m[2], "UTC" + off];
  }
  function scheduleRows(evs, season, champKeys, sourceUrl, nowMs) {
    var STATUS = { upcoming: "Upcoming", canceled: "Cancelled", cancelled: "Cancelled", live: "Live", past: "Completed" };
    var out = [];
    evs.forEach(function (e, i) {
      var key = e.event + "|" + (e.mainLocal || e.mainText).slice(0, 10);
      var champ = champKeys[key] ? "Yes" : "No";
      var st = STATUS[e.status] || "";
      if (!st) { var ref = e.mainUtc || (e.sessions.length ? e.sessions[e.sessions.length - 1].utc : ""); st = ref && Date.parse(ref) < nowMs ? "Completed" : "Scheduled"; }
      var nm = e.event.toLowerCase(), kind;
      if (champ === "Yes") kind = "Championship round";
      else if (nm === "news" || nm === "infographics") kind = "Site placeholder (not an event)";
      else if (/launch|unveil|pictures/.test(nm)) kind = "Team/car launch";
      else if (/test|shakedown|pre-season|prologue|roar before/.test(nm)) kind = "Test";
      else kind = "Non-championship event";
      var hasTime = !!e.mainUtc, ms = splitIso(e.mainLocal);
      var base = { "Series": "Formula 1", "Series Slug": "f1", "Season": season, "Event Order": i + 1, "Event": e.event, "Entry Kind": kind,
        "Championship Round": champ, "Status": st, "Country Code": e.cc, "Event Main Date (local)": ms[0] || e.mainText,
        "Event Main Time (local)": hasTime ? ms[1] : "", "Event Main Start (UTC)": e.mainUtc };
      var sess = e.sessions.length ? e.sessions : [null];
      sess.forEach(function (s, k) {
        var row = {}; Object.keys(base).forEach(function (x) { row[x] = base[x]; });
        if (s) {
          var p = splitIso(s.local), ok = !!s.utc;
          row["Session #"] = k + 1; row["Session"] = s.session; row["Session Date (local)"] = p[0] || s.text;
          row["Session Time (local)"] = ok ? p[1] : ""; row["Local UTC Offset"] = ok ? p[2] : ""; row["Session Start (local, ISO)"] = ok ? s.local : "";
          row["Session Start (UTC, ISO)"] = s.utc; row["Time TBC"] = ok ? "No" : "Yes";
        } else {
          row["Session #"] = ""; row["Session"] = ""; row["Session Date (local)"] = ""; row["Session Time (local)"] = ""; row["Local UTC Offset"] = "";
          row["Session Start (local, ISO)"] = ""; row["Session Start (UTC, ISO)"] = ""; row["Time TBC"] = hasTime ? "No" : "Yes";
        }
        row["Location URL"] = e.eventUrl; row["Source URL"] = sourceUrl;
        out.push(row);
      });
    });
    return out;
  }
  function shortEvent(title, season) { var p = season + " Formula 1 "; return title.indexOf(p) === 0 ? title.slice(p.length) : title; }
  function resultRows(ev, tab, parsed, url, season) {
    return parsed.rows.map(function (r, i) {
      var sk = Object.keys(r).filter(function (k) { return /^Avg Speed/.test(k); })[0];
      return { "Series": "Formula 1", "Series Slug": "f1", "Season": season, "Event": shortEvent(ev.title, season), "Event Title (as on site)": ev.title,
        "Event Start Date": ev.start, "Event End Date": ev.end, "Venue": ev.venue, "Country": ev.country, "Session Code": tab.code, "Session": tab.label,
        "Row Order": i + 1, "Pos": r["Pos"] || "", "Car No.": r["Car No."] || "", "Driver(s)": r["Driver"] || "", "Driver Nationality": r["Driver Nationality"] || "",
        "Team": r["Team"] || "", "Chassis": r["Chassis"] || r["Bike"] || r["Manufacturer"] || "", "Engine": r["Engine"] || "", "Laps": r["Laps"] || "",
        "Total Time": r["Total Time"] || "", "Gap to Leader": r["Gap to Leader"] || "", "Interval": r["Interval"] || "",
        "Avg Speed": sk ? r[sk] : "", "Speed Unit": sk && r[sk] ? sk.replace(/^.*\(|\)$/g, "") : "", "Pits": r["Pits"] || "", "Points": r["Points"] || "",
        "Retirement Reason": r["Retirement Reason"] || "", "Driver Profile URL(s)": r["Driver URL"] || "", "Team URL": r["Team URL"] || "",
        "Car Image Label": r["Car (image label)"] || "", "Car Image URL": r["Car Image URL"] || "", "Source URL": url };
    });
  }
  function timingRow(ev, tab, r, i, url, season, labels) {
    return { "Season": season, "Event": shortEvent(ev.title, season), "Event Start Date": ev.start, "Session Code": tab.code, "Session": labels[tab.code] || tab.label,
      "Row Order": i + 1, "Pos": r["Pos"] || "", "Car No.": r["Car No."] || "", "Driver": r["Driver"] || "", "Driver Nationality": r["Driver Nationality"] || "",
      "Team": r["Team"] || "", "Chassis": r["Chassis"] || "", "Engine": r["Engine"] || "", "Laps": r["Laps"] || "", "Time": r["Total Time"] || "",
      "Gap to Leader": r["Gap to Leader"] || "", "Interval": r["Interval"] || "", "Tyre": r["Tyres"] || "", "Avg Speed (km/h)": r["Avg Speed (km/h)"] || "",
      "Driver Profile URL": r["Driver URL"] || "", "Source URL": url };
  }

  /* ======================= units ======================= */
  function* unitSchedule(season, nowMs) {
    var pAll = "/f1/schedule/" + season + "/?all_event_types=1", pChamp = "/f1/schedule/" + season + "/?all_event_types=0";
    var first = yield [pAll, pChamp];
    var hAll = first[0], hChamp = first[1];
    if (!hAll || hAll.indexOf("ms-schedule-table") < 0) return {};          // season not published yet
    function* pages(path, h) {
      var evs = parseSchedule(h), n = 2;
      while (hasPage(h, n)) { h = (yield [path + "&p=" + n])[0]; if (!h) break; evs = evs.concat(parseSchedule(h)); n++; }
      return evs;
    }
    var all = yield* pages(pAll, hAll);
    var champ = hChamp ? yield* pages(pChamp, hChamp) : [];
    var keys = {}; champ.forEach(function (e) { keys[e.event + "|" + (e.mainLocal || e.mainText).slice(0, 10)] = 1; });
    return { "Schedule": scheduleRows(all, season, keys, BASE + pAll, nowMs), _meta: { season: season, events: all.length, champ: champ.length } };
  }
  function standingsRows(parsed, season, label, type, url) {
    var TYPE_FROM_LABEL = [["manufacturer", "Manufacturer"], ["constructor", "Constructor"], ["team", "Team"], ["driver", "Driver"], ["rider", "Driver"]];
    var typ = type || "";
    if (!typ) { var lab = label.toLowerCase(); typ = (TYPE_FROM_LABEL.filter(function (x) { return lab.indexOf(x[0]) >= 0; })[0] || [0, "Driver"])[1]; }
    if (typ === "Manufacturers") typ = "Manufacturer";
    var st = [], rr = [];
    parsed.rows.forEach(function (r, i) {
      var name = r["Driver"] || r["Rider"] || r["Team"] || r["Teams"] || r["Chassis"] || "", isDriver = !!(r["Driver"] || r["Rider"]), rounds = r._rounds;
      st.push({ "Series": "Formula 1", "Series Slug": "f1", "Season": season, "Championship (tab on site)": label, "Standings Type": typ, "Row Order": i + 1,
        "Pos": r["Pos"] || "", "Name": name, "Nationality": isDriver ? (r["Driver Nationality"] || "") : (r["Team Nationality"] || ""), "Team": isDriver ? (r["Team"] || "") : "",
        "Points": r["Points"] || "", "Rounds in Table": rounds.length, "Rounds Scored": rounds.filter(function (x) { return x.points !== "" && x.points !== "-"; }).length,
        "Wins (finish pos 1)": rounds.filter(function (x) { return x.pos === "1"; }).length,
        "Profile URL": isDriver ? (r["Driver URL"] || "") : (r["Team URL"] || ""), "Source URL": url });
      rounds.forEach(function (x, k) {
        var rd = parsed.rounds[k] || { code: "", country: "" };
        rr.push({ "Series": "Formula 1", "Season": season, "Championship (tab on site)": label, "Standings Type": typ, "Pos": r["Pos"] || "", "Name": name,
          "Round #": k + 1, "Round Code": rd.code, "Round Country": rd.country, "Points": x.points, "Finish Pos": x.pos });
      });
    });
    return { st: st, rr: rr };
  }
  function* unitStandings() {
    var land = (yield ["/f1/standings/"])[0];
    var sm = /href="\/f1\/standings\/(\d{4})\/\?type=Driver/.exec(land);
    var season = sm ? +sm[1] : null;
    if (!season) throw new Error("standings season not found");
    var base = "/f1/standings/" + season + "/", seen = {}, queue = [""], out = { "Standings": [], "Standings Round-by-Round": [] }, sigs = {};
    var pages = [];
    while (queue.length) {
      var q = queue.shift(); if (seen[q]) continue; seen[q] = 1;
      var h = (yield [base + q])[0]; pages.push([q, h]);
      var re = new RegExp('href="(' + base.replace(/\//g, "\\/") + '\\?[^"]*)"', "g"), m;
      while ((m = re.exec(h))) { var nq = decode(m[1]).slice(base.length); if (!seen[nq]) queue.push(nq); }
    }
    pages.forEach(function (pg) {
      var parsed = parseStandings(pg[1]); if (!parsed.rows.length) return;
      var sig = JSON.stringify(parsed.rows); if (sigs[sig]) return; sigs[sig] = 1;
      var qs = {}; pg[0].replace(/^\?/, "").split("&").forEach(function (kv) { if (!kv) return; var i = kv.indexOf("="); qs[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent((kv.slice(i + 1) || "").replace(/\+/g, " ")); });
      var r = standingsRows(parsed, season, currentTab(pg[1]).current, qs.type || "", BASE + base + pg[0]);
      out["Standings"] = out["Standings"].concat(r.st); out["Standings Round-by-Round"] = out["Standings Round-by-Round"].concat(r.rr);
    });
    out._meta = { season: season, tables: Object.keys(sigs).length };
    return out;
  }
  function* unitHistory(year) {
    var hs = yield ["/f1/standings/" + year + "/?type=Driver&class=", "/f1/standings/" + year + "/?type=Team&class="];
    var rows = [];
    ["Drivers", "Teams"].forEach(function (kind, k) {
      var parsed = parseStandings(hs[k] || ""), url = BASE + "/f1/standings/" + year + "/?type=" + (k ? "Team" : "Driver") + "&class=";
      parsed.rows.forEach(function (r, i) {
        var isDriver = !!r["Driver"];
        rows.push({ "Season": year, "Championship": kind, "Row Order": i + 1, "Pos": r["Pos"] || "", "Name": r["Driver"] || r["Team"] || "",
          "Nationality": isDriver ? (r["Driver Nationality"] || "") : (r["Team Nationality"] || ""), "Team": isDriver ? (r["Team"] || "") : "",
          "Points": r["Points"] || "", "Profile URL": isDriver ? (r["Driver URL"] || "") : (r["Team URL"] || ""), "Source URL": url });
      });
      if (!parsed.rows.length) throw new Error("no " + kind + " standings for " + year);
    });
    return { "Championship History": rows };
  }
  function* unitGrid(season) {
    var hs = yield ["/f1/drivers/", "/f1/teams/"];
    var drivers = parseDrivers(hs[0]), teams = parseTeams(hs[1]);
    if (!drivers.length || !teams.length) throw new Error("drivers/teams page empty");
    return {
      "Drivers": drivers.map(function (d) { return { "Season": season, "Car No.": d.no, "Driver": d.name, "Team": d.team, "Date of Birth": d.born, "Nationality": d.nat, "Profile URL": d.url, "Source URL": BASE + "/f1/drivers/" }; }),
      "Teams": teams.map(function (t) { return { "Season": season, "Team": t.name, "Car": t.car, "Country": t.country, "Driver Numbers": t.nums.join(" | "), "Drivers": t.drivers.join(" | "), "Team URL": t.url, "Source URL": BASE + "/f1/teams/" }; })
    };
  }
  /* results landing: discovers the season and its events, returns event units to queue */
  function* unitResultsIndex() {
    var h = (yield ["/f1/results/"])[0];
    var m = /<h1\b[^>]*msnt-heading[^>]*>\s*(\d{4}) Formula 1/.exec(h) || /href="\/f1\/results\/(\d{4})\/[^"?#]+\/"/.exec(h);
    var season = m ? +m[1] : null, paths = [], re = /href="(\/f1\/results\/\d{4}\/[^"?#]+\/)"/g, x;
    while ((x = re.exec(h))) if (paths.indexOf(x[1]) < 0 && x[1].indexOf("/f1/results/" + season + "/") === 0) paths.push(x[1]);
    return { _meta: { season: season, events: paths.length }, _enqueue: paths.map(function (p) { return { type: "event", path: p, season: season }; }) };
  }
  function* unitEvent(path, season, todayYmd) {
    var h = (yield [path])[0];
    if (!h) return { _warn: ["event page missing: " + path] };
    var ev = eventHeader(h);
    if (!ev || !ev.start) return { _warn: ["no dates for " + path] };
    var tabs = sessionTabs(h, path), want = tabs.filter(function (t) { return RACE_CODE.test(t.code) || QUALI_CODES[t.code] || PRACTICE_CODES[t.code] || /^(GRID|FL|TH|PT)$/.test(t.code); });
    if (!want.length) return { _warn: ["no session results published: " + path] };
    var pages = yield want.map(function (t) { return path + "?st=" + t.code; });
    var out = { "Results": [], "Qualifying": [], "Practice": [], "Starting Grid": [], "Pit Stops": [], "Tyre Stints": [], "Fastest Laps": [], _event: { start: ev.start, path: path }, _warn: [] };
    want.forEach(function (t, k) {
      var url = BASE + path + "?st=" + t.code, parsed = parseResultTable(pages[k] || "");
      if (!parsed.rows.length) { out._warn.push("empty table " + url); return; }
      if (RACE_CODE.test(t.code)) out["Results"] = out["Results"].concat(resultRows(ev, t, parsed, url, season));
      else if (QUALI_CODES[t.code]) parsed.rows.forEach(function (r, i) { out["Qualifying"].push(timingRow(ev, t, r, i, url, season, QUALI_CODES)); });
      else if (PRACTICE_CODES[t.code]) parsed.rows.forEach(function (r, i) { out["Practice"].push(timingRow(ev, t, r, i, url, season, PRACTICE_CODES)); });
      else if (t.code === "GRID") parsed.rows.forEach(function (r, i) {
        out["Starting Grid"].push({ "Season": season, "Event": shortEvent(ev.title, season), "Event Start Date": ev.start, "Row Order": i + 1, "Grid Pos": r["Pos"] || "",
          "Car No.": r["Car No."] || "", "Driver": r["Driver"] || "", "Driver Nationality": r["Driver Nationality"] || "", "Team": r["Team"] || "", "Chassis": r["Chassis"] || "",
          "Engine": r["Engine"] || "", "Qualifying Time": r["Total Time"] || "", "Gap to Pole": r["Gap to Leader"] || "", "Avg Speed (km/h)": r["Avg Speed (km/h)"] || "",
          "Driver Profile URL": r["Driver URL"] || "", "Source URL": url });
      });
      else if (t.code === "FL") parsed.rows.forEach(function (r, i) {
        out["Fastest Laps"].push({ "Season": season, "Event": shortEvent(ev.title, season), "Event Start Date": ev.start, "Row Order": i + 1, "Pos": r["Pos"] || "",
          "Car No.": r["Car No."] || "", "Driver": r["Driver"] || "", "Driver Nationality": r["Driver Nationality"] || "", "Team": r["Team"] || "", "Chassis": r["Chassis"] || "", "Engine": r["Engine"] || "", "Lap": r["Lap"] || r["Laps"] || "",
          "Time": r["Total Time"] || "", "Gap to Leader": r["Gap to Leader"] || "", "Interval": r["Interval"] || "", "Tyre": r["Tyres"] || "",
          "Avg Speed (km/h)": r["Avg Speed (km/h)"] || "", "Driver Profile URL": r["Driver URL"] || "", "Source URL": url });
      });
      else if (t.code === "PT") parsed.rows.forEach(function (r, i) {
        out["Pit Stops"].push({ "Season": season, "Event": shortEvent(ev.title, season), "Event Start Date": ev.start, "Row Order": i + 1, "Car No.": r["Car No."] || "",
          "Driver": r["Driver"] || "", "Team": r["Team"] || "", "Chassis": r["Chassis"] || "", "Engine": r["Engine"] || "", "Lap": r["Lap"] || "", "Time": r["Total Time"] || "", "Driver Profile URL": r["Driver URL"] || "", "Source URL": url });
      });
      else if (t.code === "TH") parsed.rows.forEach(function (r, ri) {
        (r._stints || []).forEach(function (s, si) {
          if (!s.compound && !s.laps) return;
          out["Tyre Stints"].push({ "Season": season, "Event": shortEvent(ev.title, season), "Event Start Date": ev.start, "Race Pos": r["Pos"] || "", "Car No.": r["Car No."] || "",
            "Driver": r["Driver"] || "", "Team": r["Team"] || "", "Stint": Number(s.stint) || s.stint, "Compound": s.compound, "Laps": s.laps,
            "Driver Profile URL": r["Driver URL"] || "", "Source URL": url, _ord: ri * 100 + si });
        });
      });
    });
    if (!out._warn.length) delete out._warn;
    void todayYmd;
    return out;
  }

  /* ======================= job ======================= */
  function plan(now) {
    var d = new Date(now), y = d.getUTCFullYear();
    var units = [{ type: "schedule", season: y }, { type: "schedule", season: y + 1 }, { type: "standings" }, { type: "grid", season: y }, { type: "resultsIndex" }];
    return units;
  }
  function historyUnits(currentSeason) { var u = []; for (var y = 2015; y < currentSeason; y++) u.push({ type: "history", season: y }); return u; }
  function makeUnit(u, now) {
    switch (u.type) {
      case "schedule": return unitSchedule(u.season, now);
      case "standings": return unitStandings();
      case "grid": return unitGrid(u.season);
      case "resultsIndex": return unitResultsIndex();
      case "event": return unitEvent(u.path, u.season, new Date(now).toISOString().slice(0, 10));
      case "history": return unitHistory(u.season);
    }
    throw new Error("unknown unit " + u.type);
  }
  /* final ordering so that chunked (Apps Script) and single (Node) runs give identical tables */
  var SESSION_ORDER = { "FP1": 1, "FP2": 2, "FP3": 3, "SQ1": 4, "SQ2": 5, "SQ3": 6, "CSQ": 7, "SPR": 8, "Q1": 9, "Q2": 10, "Q3": 11, "CQ": 12, "RACE": 13 };
  function finalize(acc) {
    var by = function (keys) { return function (a, b) { for (var i = 0; i < keys.length; i++) { var k = keys[i], x = a[k], y = b[k]; if (x < y) return -1; if (x > y) return 1; } return 0; }; };
    var ses = function (r) { return SESSION_ORDER[r["Session Code"]] || 50; };
    ["Results", "Qualifying", "Practice"].forEach(function (t) { (acc[t] || []).sort(function (a, b) { return (a["Event Start Date"] < b["Event Start Date"] ? -1 : a["Event Start Date"] > b["Event Start Date"] ? 1 : 0) || ses(a) - ses(b) || a["Row Order"] - b["Row Order"]; }); });
    ["Starting Grid", "Pit Stops", "Fastest Laps"].forEach(function (t) { (acc[t] || []).sort(by(["Event Start Date", "Row Order"])); });
    (acc["Tyre Stints"] || []).sort(function (a, b) { return (a["Event Start Date"] < b["Event Start Date"] ? -1 : a["Event Start Date"] > b["Event Start Date"] ? 1 : 0) || a._ord - b._ord; });
    (acc["Schedule"] || []).sort(by(["Season", "Event Order", "Session #"]));
    (acc["Championship History"] || []).sort(function (a, b) { return b["Season"] - a["Season"] || (a["Championship"] < b["Championship"] ? -1 : a["Championship"] > b["Championship"] ? 1 : 0) || a["Row Order"] - b["Row Order"]; });
    return acc;
  }
  /* rows (objects) -> 2D values with header, numbers typed where appropriate */
  function toValues(tab, rows) {
    var cols = TABS[tab];
    return [cols].concat(rows.map(function (r) {
      return cols.map(function (c) {
        var v = r.hasOwnProperty(c) ? r[c] : "";
        if (v === null || v === undefined) v = "";
        if (NUMERIC[c] && v !== "") return Number(v);
        if (NUMERIC_IF_NUMBER[c]) return num(v);
        return String(v);
      });
    }));
  }
  function validate(acc) {
    var problems = [];
    var need = { "Results": 1, "Standings": 1, "Standings Round-by-Round": 1, "Schedule": 1, "Drivers": 1, "Teams": 1, "Qualifying": 1, "Starting Grid": 1,
      "Practice": 1, "Pit Stops": 1, "Tyre Stints": 1, "Fastest Laps": 1, "Championship History": 1 };
    Object.keys(need).forEach(function (t) { if (!(acc[t] || []).length) problems.push("tab " + t + " is empty"); });
    (acc["Results"] || []).forEach(function (r) { if (!r["Driver(s)"]) problems.push("result row without driver: " + r["Source URL"]); });
    return problems;
  }

  return { TABS: TABS, plan: plan, historyUnits: historyUnits, makeUnit: makeUnit, finalize: finalize, toValues: toValues, validate: validate,
    parse: { resultTable: parseResultTable, standings: parseStandings, schedule: parseSchedule, drivers: parseDrivers, teams: parseTeams, eventHeader: eventHeader, sessionTabs: sessionTabs, currentTab: currentTab },
    BASE: BASE, text: text };
})();
if (typeof module !== "undefined") module.exports = VFCore;
