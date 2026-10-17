/**
 * Irrigation restrictions - Apps Script backend.
 *
 * Bound to the "Irrigation restrictions" spreadsheet. The page (index.html on
 * GitHub Pages) signs people in with Google and sends their Google ID token
 * with every request. This script checks the token with Google, then checks
 * the email is in the "users" tab. Nobody else can read or change anything.
 *
 * Tabs (made with the starting numbers the first time the script runs):
 *   users     Email | Name | Admin                 <- who can use the page. Admin = TRUE can add/remove users
 *   consents  Key | Name | Volume m3               <- full daily volume, not restricted
 *   groups    Consent | Group | Share %            <- share of the consent per farm
 *   pivots    Id | Consent | Group | Pivot | l/s | On | Hours
 *   settings  Key | Value                          <- allowed % today, who saved last
 *   log       Time | Email | Action | Details      <- every change
 *
 * Deploy: sh /c/dev/lhirrigation/deploy.sh  (web app: execute as me, anyone).
 */

const SCRIPT_VERSION = "2026-10-17-c";

// OAuth client ID of the page (Google Cloud console > APIs & Services > Credentials).
// It is not a secret: it is also in index.html.
const CLIENT_ID = "299650316460-f0o2vuc529fkb1sd9ipbc1f1h2jv1ct6.apps.googleusercontent.com";

const DEFAULTS = {
  restr: 60,
  users: [["juanignacioituarte@gmail.com", "Juani", true]],
  consents: [
    ["big", "Big consent", 34560],
    ["small", "Small consent", 20088],
  ],
  groups: [
    ["big", "Manuka", 36.75],
    ["big", "River Terrace", 63.25],
    ["small", "Manuka", 57],
    ["small", "Hill", 43],
  ],
  pivots: [
    ["big", "Manuka", "BDP", 60, true, 14],
    ["big", "Manuka", "HP", 64, true, 13.5],
    ["big", "Manuka", "Pylon", 17.5, true, 24],
    ["big", "River Terrace", "TTP", 78, true, 0],
    ["big", "River Terrace", "BTP", 73, true, 24],
    ["big", "River Terrace", "BP", 52, true, 24],
    ["big", "River Terrace", "C block pivot", 17.5, true, 9],
    ["big", "River Terrace", "C block sprinkler", 17.5, true, 9],
    ["big", "River Terrace", "Laterals", 12, true, 24],
    ["small", "Manuka", "MF Sprinklers", 37, true, 16],
    ["small", "Manuka", "MP", 78, true, 24],
    ["small", "Manuka", "Duck pond", 18, true, 24],
    ["small", "Hill", "Hill racecourse", 35, false, 24],
    ["small", "Hill", "Hill airstrip", 15, false, 24],
    ["small", "Hill", "Hill lower", 25, true, 9],
    ["small", "Hill", "Hill upper", 25, true, 9],
  ],
};

const HEADERS = {
  users: ["Email", "Name", "Admin"],
  consents: ["Key", "Name", "Volume m3"],
  groups: ["Consent", "Group", "Share %"],
  pivots: ["Id", "Consent", "Group", "Pivot", "l/s", "On", "Hours"],
  settings: ["Key", "Value"],
  log: ["Time", "Email", "Action", "Details"],
};

// ---------- web app ----------

function doGet(e) {
  // Only the version is public. Everything else needs a signed-in user (POST).
  return json({ ok: true, version: SCRIPT_VERSION });
}

// The page sends text/plain so the browser does not do a CORS preflight.
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: "bad request" }); }

  const who = checkUser(req.token);
  if (!who.ok) return json(who);

  ensureSheets();
  const lock = LockService.getScriptLock();
  try {
    if (req.action === "load") return json(Object.assign({ ok: true, user: who.user }, readAll(who.user)));
    lock.waitLock(20000);
    if (req.action === "savePlan") { savePlan(req.data, who.user); }
    else if (req.action === "saveConfig") { saveConfig(req.data, who.user); }
    else if (req.action === "addUser") { addUser(req.data, who.user); }
    else if (req.action === "removeUser") { removeUser(req.data, who.user); }
    else return json({ ok: false, error: "unknown action" });
    SpreadsheetApp.flush();
    return json(Object.assign({ ok: true, user: who.user }, readAll(who.user)));
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- who is asking ----------

// Google checks the ID token for us. A good token is remembered for 10 minutes
// so we do not ask Google on every save. The users tab is read every time, so
// taking a person off the list works straight away.
function checkUser(token) {
  if (!token) return { ok: false, error: "signin" };
  const cache = CacheService.getScriptCache();
  const key = "tok_" + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  let email = cache.get(key);
  if (!email) {
    const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token),
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return { ok: false, error: "signin" };
    const t = JSON.parse(res.getContentText());
    const issOk = t.iss === "accounts.google.com" || t.iss === "https://accounts.google.com";
    if (t.aud !== CLIENT_ID || !issOk || String(t.email_verified) !== "true" || Number(t.exp) * 1000 < Date.now()) {
      return { ok: false, error: "signin" };
    }
    email = String(t.email).toLowerCase();
    const left = Math.min(600, Math.floor(Number(t.exp) - Date.now() / 1000) - 30);
    if (left > 0) cache.put(key, email, left);
  }
  ensureSheets();
  const users = rows("users");
  const u = users.find(r => String(r[0]).trim().toLowerCase() === email);
  if (!u) return { ok: false, error: "notallowed", email: email };
  return { ok: true, user: { email: email, name: String(u[1] || email), admin: isTrue(u[2]) } };
}

// ---------- the sheet ----------

function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet(name) {
  const s = ss().getSheetByName(name);
  if (!s) throw new Error("missing tab " + name);
  return s;
}

// Rows under the header row.
function rows(name) {
  const s = sheet(name);
  const n = s.getLastRow() - 1;
  if (n < 1) return [];
  return s.getRange(2, 1, n, HEADERS[name].length).getValues()
    .filter(r => r.some(c => c !== "" && c !== null));
}

function writeRows(name, data) {
  const s = sheet(name);
  const w = HEADERS[name].length;
  const n = s.getLastRow() - 1;
  if (n > 0) s.getRange(2, 1, n, w).clearContent();
  if (data.length) s.getRange(2, 1, data.length, w).setValues(data);
}

function ensureSheets() {
  const book = ss();
  Object.keys(HEADERS).forEach(name => {
    if (book.getSheetByName(name)) return;
    const s = book.insertSheet(name);
    s.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight("bold");
    s.setFrozenRows(1);
    if (name === "users") writeRows(name, DEFAULTS.users);
    if (name === "consents") writeRows(name, DEFAULTS.consents);
    if (name === "groups") writeRows(name, DEFAULTS.groups);
    if (name === "pivots") writeRows(name, DEFAULTS.pivots.map((p, i) => ["p" + (i + 1)].concat(p)));
    if (name === "settings") writeRows(name, [["restr", DEFAULTS.restr], ["plan_by", ""], ["plan_at", ""], ["config_by", ""], ["config_at", ""]]);
  });
  // Sheets made before the Admin column: add it, and make the first users admins.
  const us = book.getSheetByName("users");
  if (us.getRange(1, 3).getValue() === "") {
    us.getRange(1, 3).setValue("Admin").setFontWeight("bold");
    const first = DEFAULTS.users.map(u => u[0]);
    const n = us.getLastRow() - 1;
    if (n > 0) {
      const em = us.getRange(2, 1, n, 1).getValues();
      us.getRange(2, 3, n, 1).setValues(em.map(r => [first.indexOf(String(r[0]).trim().toLowerCase()) >= 0]));
    }
  }
  const blank = book.getSheetByName("Sheet1");
  if (blank && book.getSheets().length > 1 && blank.getLastRow() === 0) book.deleteSheet(blank);
}

function settings() {
  const o = {};
  rows("settings").forEach(r => { o[String(r[0])] = r[1]; });
  return o;
}

function setSettings(changes) {
  const s = settings();
  Object.assign(s, changes);
  writeRows("settings", Object.keys(s).map(k => [k, s[k]]));
}

function stamp(d) {
  return d instanceof Date ? Utilities.formatDate(d, "Pacific/Auckland", "d MMM yyyy HH:mm") : String(d || "");
}

function isTrue(v) { return v === true || String(v).trim().toUpperCase() === "TRUE"; }

// Everything the page needs, in the shape the page uses. Admins also get the users list.
function readAll(user) {
  const st = settings();
  const consents = {}, order = [];
  rows("consents").forEach(r => {
    const key = String(r[0]).trim();
    consents[key] = { name: String(r[1]), volume: Number(r[2]) || 0, groups: [] };
    order.push(key);
  });
  rows("groups").forEach(r => {
    const c = consents[String(r[0]).trim()];
    if (c) c.groups.push({ name: String(r[1]), share: Number(r[2]) || 0, blocks: [] });
  });
  rows("pivots").forEach(r => {
    const c = consents[String(r[1]).trim()];
    const g = c && c.groups.find(x => x.name === String(r[2]));
    if (g) g.blocks.push({ id: String(r[0]), name: String(r[3]), ls: Number(r[4]) || 0, on: isTrue(r[5]), h: Number(r[6]) || 0 });
  });
  const users = user && user.admin
    ? rows("users").map(r => ({ email: String(r[0]).trim().toLowerCase(), name: String(r[1]), admin: isTrue(r[2]) }))
    : null;
  return {
    users: users,
    version: SCRIPT_VERSION,
    restr: Number(st.restr),
    plan: { by: String(st.plan_by || ""), at: stamp(st.plan_at) },
    config: { by: String(st.config_by || ""), at: stamp(st.config_at) },
    order: order,
    consents: consents,
  };
}

// ---------- saving ----------

const num = (v, lo, hi) => {
  const n = Number(v);
  if (!isFinite(n)) throw new Error("not a number: " + v);
  return Math.max(lo, Math.min(hi, n));
};

// Ticks, hours and the allowed % for today.
function savePlan(d, user) {
  const changes = {};
  (d.pivots || []).forEach(p => { changes[String(p.id)] = { on: !!p.on, h: num(p.h, 0, 24) }; });
  const all = rows("pivots");
  all.forEach(r => {
    const c = changes[String(r[0])];
    if (c) { r[5] = c.on; r[6] = c.h; }
  });
  writeRows("pivots", all);
  const s = { plan_by: user.name, plan_at: new Date() };
  if (d.restr !== undefined) s.restr = num(d.restr, 0, 100);
  setSettings(s);
  log(user, "plan", { restr: d.restr, pivots: d.pivots });
}

// Consent volumes, farm shares, pivot names and l/s. Ticks and hours are kept.
function saveConfig(d, user) {
  const old = {};
  rows("pivots").forEach(r => { old[String(r[0])] = r; });
  const cons = [], grps = [], pivs = [];
  (d.order || Object.keys(d.consents)).forEach(key => {
    const c = d.consents[key];
    if (!c) return;
    cons.push([key, String(c.name), num(c.volume, 0, 1e7)]);
    (c.groups || []).forEach(g => {
      const gname = String(g.name).trim();
      if (!gname) throw new Error("a farm has no name");
      grps.push([key, gname, num(g.share, 0, 100)]);
      (g.blocks || []).forEach(b => {
        const id = String(b.id || ("p" + Date.now() + Math.floor(Math.random() * 1000)));
        const was = old[id];
        pivs.push([id, key, gname, String(b.name).trim() || "Pivot", num(b.ls, 0, 10000),
          was ? was[5] : false, was ? was[6] : 0]);
      });
    });
  });
  if (!cons.length) throw new Error("no consents");
  writeRows("consents", cons);
  writeRows("groups", grps);
  writeRows("pivots", pivs);
  setSettings({ config_by: user.name, config_at: new Date() });
  log(user, "config", d);
}

// Admins only. A new user is never an admin: tick Admin in the sheet for that.
function addUser(d, user) {
  if (!user.admin) throw new Error("only an admin can change users");
  const email = String(d.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("not an email: " + email);
  const all = rows("users");
  if (all.some(r => String(r[0]).trim().toLowerCase() === email)) throw new Error(email + " is already on the list");
  all.push([email, String(d.name || "").trim() || email, false]);
  writeRows("users", all);
  log(user, "addUser", { email: email, name: d.name });
}

// Admins only. Admins cannot be removed from the page (do it in the sheet).
function removeUser(d, user) {
  if (!user.admin) throw new Error("only an admin can change users");
  const email = String(d.email || "").trim().toLowerCase();
  const all = rows("users");
  const u = all.find(r => String(r[0]).trim().toLowerCase() === email);
  if (!u) throw new Error(email + " is not on the list");
  if (isTrue(u[2])) throw new Error("an admin can only be removed in the sheet");
  writeRows("users", all.filter(r => r !== u));
  log(user, "removeUser", { email: email });
}

function log(user, action, details) {
  sheet("log").appendRow([new Date(), user.email, action, JSON.stringify(details)]);
}

// Run once from the editor to make the tabs without waiting for the page.
function setup() { ensureSheets(); }
