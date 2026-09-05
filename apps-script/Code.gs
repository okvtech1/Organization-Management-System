/**
 * =====================================================================================
 * OKV Organization Management System — Phase 2 ("Subscribe") backend
 * -------------------------------------------------------------------------------------
 * Deploy this as a Web App (Deploy → New deployment → Web app):
 *   - Execute as:  Me (your own Google account)
 *   - Who has access: Anyone
 * Copy the resulting /exec URL into API_URL at the top of app.html, index.html,
 * signup.html, and reset-password.html.
 *
 * Set APP_BASE_URL below to wherever you host the HTML files (GitHub Pages, your own
 * domain, etc.) — it's used to build the password-reset email link.
 * =====================================================================================
 */
const APP_BASE_URL = 'https://example.com/okv-oms-online'; // <-- CHANGE THIS after hosting the HTML files
const USERS_SHEET = 'Users';
const DATA_SHEET = 'Data'; // legacy: master's own copy, pre-per-tenant-spreadsheet (see MIGRATION below).
                           // Also the tab name used inside every per-tenant spreadsheet.
const PAYMENTS_SHEET = 'PaymentRequests';
const MESSAGES_SHEET = 'Messages';
const CONFIG_SHEET = 'SystemConfig';
const RESET_TOKEN_TTL_MINUTES = 60;
const TRIAL_DAYS = 7;
const REMINDER_INTERVAL_DAYS = 15; // twice a month, per organization — see sendExpiryReminders()

// =====================================================================================
// PER-TENANT SPREADSHEETS + CELL-CAPACITY MONITORING
// -------------------------------------------------------------------------------------
// This spreadsheet (the one this script is bound to) is the MASTER/CONTROL spreadsheet.
// It holds only the tenant registry (OrgRegistry) plus platform-wide sheets (Users,
// PaymentRequests, Messages, SystemConfig, CapacityHistory) — never per-org transactional
// records. Each org's own member/finance/event/etc. records live in a separate Google
// Spreadsheet file, created automatically at signup (see createTenantSpreadsheet) and
// resolved on every request via getOrgSpreadsheet(orgId) — nobody should ever reach for
// SpreadsheetApp.getActiveSpreadsheet() when reading/writing org data.
// =====================================================================================
const ORG_REGISTRY_SHEET = 'OrgRegistry';
const CAPACITY_HISTORY_SHEET = 'CapacityHistory';
const ORG_REGISTRY_HEADERS = [
  'orgId','orgName','dataSpreadsheetId','dataSpreadsheetUrl','createdAt',
  'cellsUsed','cellsLimit','pctUsed','growthPerDay30','growthPerDay90',
  'estRemainingDays','estRemainingLabel','capacityStatus','capacityRecommendation',
  'lastCapacityCheckAt','lastCapacityAlertSentAt'
];
const CAPACITY_HISTORY_HEADERS = ['orgId','checkedAt','totalCells'];
const CELL_LIMIT_PER_SPREADSHEET = 10000000; // Google Sheets' hard per-file cell cap, summed across all tabs.
const CAPACITY_TARGET_PCT = 0.90; // "time remaining" counts down to this, not to 100%.
const CAPACITY_MONITOR_THRESHOLD = 0.70;  // >= this % used → "Monitor"
const CAPACITY_ACTION_THRESHOLD = 0.85;   // >= this % used → "Action Needed"
const CAPACITY_ALERT_INTERVAL_DAYS = 7;   // don't re-email the Super Admin about the same org more than this often
const CAPACITY_HISTORY_RETENTION_DAYS = 100; // a little over the 90-day growth window used below

// In-memory cache so a single request that touches the same org's spreadsheet more than
// once (e.g. getData then a follow-up lookup) doesn't re-open it repeatedly. Cleared
// automatically between executions (Apps Script gives each request a fresh global scope).
const _orgSpreadsheetCache = {};

// Defaults seeded into the SystemConfig sheet the first time initializeSheets() runs.
// After that, these three (plus the bank details) live in the sheet and are editable
// from the Super Admin Dashboard — these constants are only the starting values.
const DEFAULT_OWNER_EMAIL = 'technologyokv@gmail.com';
const DEFAULT_OWNER_PHONE = '+2348104141138';
const DEFAULT_OWNER_WEBSITE = 'www.okvtechnology.com';
const DEFAULT_BANK_ACCOUNT_NUMBER = '8104141138';
const DEFAULT_BANK_NAME = 'OPAY MFB';
const DEFAULT_BANK_ACCOUNT_NAME = 'Olasile Kehinde Victor';
const DEFAULT_BRAND_NAME = 'OKV OMS';
const DEFAULT_EMAIL_FROM_NAME = 'OKV Organization Management System';
const DEFAULT_SITE_TAGLINE = 'One system for your members, money, programs, and people — online or off.';
const DEFAULT_THEME_PRIMARY = '#0a2420'; // base for the --teal-* shades
const DEFAULT_THEME_ACCENT  = '#d6a13d'; // base for the --gold-* shades

// Every key the Super Admin Dashboard's Platform Settings / Integrations / Payment
// Methods tabs can read and write, with their starting values. All of it lives in the
// SystemConfig sheet (one row per key) — getAllConfig()/setConfigValue() below are the
// only things that touch that sheet, so adding a new setting is just adding a row here.
const CONFIG_DEFAULTS = {
  ownerEmail: DEFAULT_OWNER_EMAIL, ownerPhone: DEFAULT_OWNER_PHONE, ownerWebsite: DEFAULT_OWNER_WEBSITE,
  brandName: DEFAULT_BRAND_NAME, siteTagline: DEFAULT_SITE_TAGLINE, logoDataUrl: '',
  themePrimaryColor: DEFAULT_THEME_PRIMARY, themeAccentColor: DEFAULT_THEME_ACCENT,
  emailFromName: DEFAULT_EMAIL_FROM_NAME, emailReplyTo: DEFAULT_OWNER_EMAIL,
  smsEnabled: 'false', smsProvider: 'termii', smsApiKey: '', smsSenderId: '',
  whatsappEnabled: 'false', whatsappProvider: 'whatsapp_cloud', whatsappAccessToken: '', whatsappPhoneId: '',
  manualBankEnabled: 'true',
  bankAccountNumber: DEFAULT_BANK_ACCOUNT_NUMBER, bankName: DEFAULT_BANK_NAME, bankAccountName: DEFAULT_BANK_ACCOUNT_NAME,
  paystackEnabled: 'false', paystackPublicKey: '', paystackSecretKey: '', paystackCurrency: 'NGN',
  flutterwaveEnabled: 'false', flutterwavePublicKey: '', flutterwaveSecretKey: '',
  remitaEnabled: 'false', remitaMerchantId: '', remitaApiKey: '', remitaServiceTypeId: '',
  // Prices shown on pricing.html and used to compute the Paystack charge amount — override
  // any of these from the Super Admin Dashboard's Plans & Pricing tab; Nigerian Naira (NGN)
  // by default (see paystackCurrency below — Paystack charges in whatever currency you set
  // there; change both together if you switch currencies).
  price_starter_monthly: '15000',  price_growth_monthly: '35000',
  price_starter_biannual: '80000', price_growth_biannual: '190000',
  price_starter_yearly: '140000',  price_growth_yearly: '330000',
  // Hide a plan/cycle combination from pricing.html without deleting anything — set to 'false'.
  planActive_starter_monthly: 'true',  planActive_growth_monthly: 'true',
  planActive_starter_biannual: 'true', planActive_growth_biannual: 'true',
  planActive_starter_yearly: 'true',   planActive_growth_yearly: 'true'
};
// Fields actionGetPlatformConfig() (no login required) is allowed to return — every
// secret key (API/secret keys, access tokens) is deliberately left out of this list;
// only the Super Admin Dashboard (authenticated) can read those, via getPlatformConfigFull.
const PUBLIC_CONFIG_KEYS = [
  'ownerEmail','ownerPhone','ownerWebsite','brandName','siteTagline','logoDataUrl',
  'themePrimaryColor','themeAccentColor','manualBankEnabled','bankAccountNumber','bankName','bankAccountName',
  'paystackEnabled','paystackPublicKey','paystackCurrency','flutterwaveEnabled','flutterwavePublicKey','remitaEnabled',
  'price_starter_monthly','price_growth_monthly','price_starter_biannual','price_growth_biannual','price_starter_yearly','price_growth_yearly',
  'planActive_starter_monthly','planActive_growth_monthly','planActive_starter_biannual','planActive_growth_biannual','planActive_starter_yearly','planActive_growth_yearly'
];

// The Super Admin account's default credentials — see createSuperAdminAccount() below.
// Change this password immediately after first login (My Account works the same way
// for the Super Admin Dashboard as it does for org Admins).
const SUPER_ADMIN_USERNAME = 'technologyokv@gmail.com';
const SUPER_ADMIN_DEFAULT_PASSWORD = 'OKVOMS557'; // "OKVOMS" (the system's short name) + 557

const ROLE_OPTIONS = [
  'Organization Super Admin',
  'Executive Director / Organization Head',
  'Operations Manager',
  'HR / Staff Manager',
  'Program / Project Officer',
  'Finance Officer / Accountant',
  'Asset / Administrative Officer',
  'Staff / Data Entry Officer'
];

// Must match the plan ids used in pricing.html's data-plan attributes.
const PLAN_LABELS = {
  starter_monthly:  'Starter — Monthly',   growth_monthly:  'Growth — Monthly',
  starter_biannual: 'Starter — Bi-Annual', growth_biannual: 'Growth — Bi-Annual',
  starter_yearly:   'Starter — Yearly',    growth_yearly:   'Growth — Yearly'
};
// Days added to subscriptionExpiry once a payment request is confirmed, by billing cycle.
const CYCLE_DAYS = { monthly: 30, biannual: 182, yearly: 365 };

const USERS_HEADERS = [
  'id','orgId','orgName','fullName','username','phone','passwordHash','roles','isOwner','isSuperAdmin','status',
  'plan','billingCycle','subscriptionStatus','trialEndsAt','subscriptionStartedAt','subscriptionExpiry',
  'lastReminderSentAt','resetToken','resetTokenExpiry','createdAt','updatedAt'
];
const DATA_HEADERS = ['id','orgId','module','payload','createdBy','updatedAt','deleted'];
const PAYMENTS_HEADERS = [
  'id','orgId','requestedByUserId','orgName','contactEmail','contactPhone',
  'planRequested','billingCycle','paymentMethod','gatewayReference','status','reviewNote','submittedAt','reviewedAt'
];
const MESSAGES_HEADERS = [
  'id','orgId','fromUserId','fromUsername','audience','recipientLabel','recipientEmail','recipientPhone',
  'channel','subject','body','deliveryStatus','sentAt'
];
const CONFIG_HEADERS = ['key','value'];

// =====================================================================================
// ONE-TIME SETUP — run this once from the Apps Script editor (select it in the
// function dropdown, click Run) to create both sheets with the correct headers.
// =====================================================================================
function initializeSheets(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // NOTE: DATA_HEADERS/DATA_SHEET are intentionally NOT created here anymore — this
  // (master/control) spreadsheet never holds transactional org data. Each org's Data
  // tab lives in its own per-tenant spreadsheet, created at signup (createTenantSpreadsheet)
  // or by the one-time migrateLegacyDataToPerTenantSpreadsheets() below. If this master
  // file still has an old "Data" tab from before this change, that migration function
  // will move its rows out and rename the old tab rather than touch it here.
  [
    [USERS_SHEET, USERS_HEADERS],
    [PAYMENTS_SHEET, PAYMENTS_HEADERS], [MESSAGES_SHEET, MESSAGES_HEADERS],
    [CONFIG_SHEET, CONFIG_HEADERS], [ORG_REGISTRY_SHEET, ORG_REGISTRY_HEADERS],
    [CAPACITY_HISTORY_SHEET, CAPACITY_HISTORY_HEADERS]
  ].forEach(([name, headers]) => {
    let sheet = ss.getSheetByName(name);
    if(!sheet) sheet = ss.insertSheet(name);
    if(sheet.getLastRow() === 0){
      sheet.appendRow(headers);
      sheet.setFrozenRows(1);
    }
  });
  // Dropdown in PaymentRequests!status so reviewing is just "pick from the list" — see
  // onPaymentStatusEdit() below, which fires when this cell changes.
  const paySheet = ss.getSheetByName(PAYMENTS_SHEET);
  const statusCol = PAYMENTS_HEADERS.indexOf('status') + 1;
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(['pending','confirmed','rejected'], true).build();
  paySheet.getRange(2, statusCol, 500, 1).setDataValidation(rule);

  // Seed SystemConfig with defaults the first time — editable afterward from the
  // Super Admin Dashboard (or directly in this sheet) without redeploying code. Safe
  // to re-run later too: it only fills in keys that don't already have a row, so it
  // won't stomp on settings you've since changed (e.g. after adding a new setting in
  // a future update, just run initializeSheets() again to backfill its default row).
  const configSheet = ss.getSheetByName(CONFIG_SHEET);
  const existingKeys = configSheet.getLastRow() > 1
    ? configSheet.getRange(2, 1, configSheet.getLastRow() - 1, 1).getValues().map(r => r[0])
    : [];
  Object.keys(CONFIG_DEFAULTS).forEach(k => {
    if(existingKeys.indexOf(k) === -1) configSheet.appendRow([k, CONFIG_DEFAULTS[k]]);
  });

  SpreadsheetApp.getUi().alert(
    'Users, PaymentRequests, Messages, SystemConfig, OrgRegistry, and CapacityHistory sheets are ready.\n\n' +
    'A few more steps:\n' +
    '1) Run createSuperAdminAccount() once (function dropdown → select it → Run) to set up your Super Admin login.\n' +
    '2) If this spreadsheet already has an old "Data" tab with real org records in it (from before ' +
    'per-tenant spreadsheets), run migrateLegacyDataToPerTenantSpreadsheets() once to move each ' +
    "org's rows into its own new spreadsheet and register it.\n" +
    '3) Open Triggers (clock icon) → Add Trigger, three times:\n' +
    '   • function "onPaymentStatusEdit" → From spreadsheet → On edit\n' +
    '   • function "sendExpiryReminders" → Time-driven → Day timer (once daily)\n' +
    '   • function "checkAllTenantCapacities" → Time-driven → Day timer (once daily, e.g. overnight)\n' +
    'Those make payment reviews, trial/subscription reminders, and per-org cell-capacity monitoring happen automatically.'
  );
}

/**
 * ONE-TIME SETUP: creates the Super Admin account (technologyokv@gmail.com / OKVOMS557
 * by default — change the password immediately after your first login, from My Account
 * in the Super Admin Dashboard, the same way any org Admin changes theirs). Safe to run
 * more than once — it won't create a duplicate if the account already exists.
 */
function createSuperAdminAccount(){
  if(findUserByUsername(SUPER_ADMIN_USERNAME)){
    SpreadsheetApp.getUi().alert('A Super Admin account already exists for ' + SUPER_ADMIN_USERNAME + '.');
    return;
  }
  const user = {
    id: uuid(), orgId: 'PLATFORM', orgName: 'OKV Technology Consults', fullName: 'OKV Technology Consults',
    username: SUPER_ADMIN_USERNAME, phone: DEFAULT_OWNER_PHONE, passwordHash: sha256(SUPER_ADMIN_DEFAULT_PASSWORD),
    roles: '', isOwner: false, isSuperAdmin: true, status: 'active',
    plan: '', billingCycle: '', subscriptionStatus: 'active', trialEndsAt: '', subscriptionStartedAt: '', subscriptionExpiry: '',
    lastReminderSentAt: '', resetToken: '', resetTokenExpiry: '', createdAt: nowIso(), updatedAt: nowIso()
  };
  appendRow(USERS_SHEET, USERS_HEADERS, user);
  SpreadsheetApp.getUi().alert('Super Admin account created.\n\nLog in at login.html with:\nUsername: ' + SUPER_ADMIN_USERNAME + '\nPassword: ' + SUPER_ADMIN_DEFAULT_PASSWORD + '\n\nChange this password right away from the Super Admin Dashboard.');
}

// =====================================================================================
// WEB APP ENTRY POINTS
// -------------------------------------------------------------------------------------
// Every action goes through doPost as a JSON body, sent with
// Content-Type: text/plain;charset=utf-8 from the client (this avoids the browser's
// CORS preflight, which Apps Script Web Apps can't answer). doGet exists only as a
// simple health check.
// =====================================================================================
function doGet(e){
  return json({ ok: true, message: 'OKV OMS API is running.' });
}

function doPost(e){
  let body;
  try{
    body = JSON.parse(e.postData.contents);
  }catch(err){
    return json({ success:false, error:'Malformed request.' });
  }
  const action = body.action;
  try{
    switch(action){
      case 'signup':            return json(actionSignup(body));
      case 'login':             return json(actionLogin(body));
      case 'forgotPassword':    return json(actionForgotPassword(body));
      case 'resetPassword':     return json(actionResetPassword(body));
      case 'changePassword':    return json(actionChangePassword(body));
      case 'listUsers':         return json(actionListUsers(body));
      case 'createUser':        return json(actionCreateUser(body));
      case 'updateUserRoles':   return json(actionUpdateUserRoles(body));
      case 'setUserStatus':     return json(actionSetUserStatus(body));
      case 'setUserPassword':   return json(actionSetUserPassword(body));
      case 'deleteUser':        return json(actionDeleteUser(body));
      case 'getData':           return json(actionGetData(body));
      case 'pushData':          return json(actionPushData(body));
      case 'listTeamContacts':  return json(actionListTeamContacts(body));
      case 'sendMessage':       return json(actionSendMessage(body));
      case 'submitPaymentRequest': return json(actionSubmitPaymentRequest(body));
      case 'getPlatformConfig':    return json(actionGetPlatformConfig(body));
      case 'getPlatformConfigFull': return json(actionGetPlatformConfigFull(body));
      case 'updatePlatformConfig': return json(actionUpdatePlatformConfig(body));
      case 'listOrganizations':    return json(actionListOrganizations(body));
      case 'listTenantCapacity':   return json(actionListTenantCapacity(body));
      case 'updateOrganization':   return json(actionUpdateOrganization(body));
      case 'listAllPaymentRequests': return json(actionListAllPaymentRequests(body));
      case 'reviewPaymentRequest': return json(actionReviewPaymentRequest(body));
      case 'sendPlatformMessage':  return json(actionSendPlatformMessage(body));
      case 'initPaystackPayment':  return json(actionInitPaystackPayment(body));
      case 'verifyPaystackPayment': return json(actionVerifyPaystackPayment(body));
      default:                  return json({ success:false, error:'Unknown action.' });
    }
  }catch(err){
    return json({ success:false, error: String(err) });
  }
}

function json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================================
// SHEET HELPERS
// =====================================================================================
// Every helper below takes an optional trailing `ss` (Spreadsheet object). Omit it and
// they operate on this script's own bound (master/control) spreadsheet, exactly as
// before — pass one (typically the result of getOrgSpreadsheet(orgId)) to operate on a
// per-tenant spreadsheet instead. This is the ONLY thing that changed about these
// helpers; every existing call site (Users/PaymentRequests/Messages/SystemConfig) is
// untouched and keeps reading/writing the master spreadsheet exactly as before.
function sheet(name, ss){
  const sh = (ss || SpreadsheetApp.getActiveSpreadsheet()).getSheetByName(name);
  if(!sh) throw new Error(`Sheet "${name}" not found — run initializeSheets() once from the editor.`);
  return sh;
}
function readRows(sheetName, ss){
  const sh = sheet(sheetName, ss);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  return values.slice(1).map((row, i) => {
    const obj = { _row: i + 2 }; // 1-based sheet row, +1 for header
    headers.forEach((h, idx) => obj[h] = row[idx]);
    return obj;
  });
}
function appendRow(sheetName, headers, obj, ss){
  sheet(sheetName, ss).appendRow(headers.map(h => obj[h] !== undefined ? obj[h] : ''));
}
function updateRow(sheetName, headers, rowIndex, obj, ss){
  const sh = sheet(sheetName, ss);
  headers.forEach((h, idx) => {
    if(obj[h] !== undefined) sh.getRange(rowIndex, idx + 1).setValue(obj[h]);
  });
}
function nowIso(){ return new Date().toISOString(); }
function contactFooter(){
  const cfg = getAllConfig();
  return `\n\n—\nOKV Technology Consults\nEmail: ${cfg.ownerEmail || DEFAULT_OWNER_EMAIL}\nPhone: ${cfg.ownerPhone || DEFAULT_OWNER_PHONE}\nWebsite: ${cfg.ownerWebsite || DEFAULT_OWNER_WEBSITE}`;
}

/** Every email OKV Technology itself sends (welcome, password reset, payment
 * confirmations, trial/expiry reminders, capacity alerts, platform broadcasts) goes
 * through this — merges in a From display name carrying the system's name and a
 * Reply-To of the actual email address we use, both editable from Platform Settings.
 * Deliberately NOT used by actionSendMessage() — messages an organization sends to its
 * own members/team should carry that organization's identity, not ours. */
function platformMailOptions(options){
  const cfg = getAllConfig();
  return Object.assign({
    name: cfg.emailFromName || DEFAULT_EMAIL_FROM_NAME,
    replyTo: cfg.emailReplyTo || cfg.ownerEmail || DEFAULT_OWNER_EMAIL
  }, options);
}

function uuid(){ return Utilities.getUuid(); }
/** Same SHA-256 hex scheme as the client's sha256Hex() (Web Crypto) — used only for
 * the Super Admin's server-created default password (createSuperAdminAccount). */
function sha256(str){
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

// =====================================================================================
// TENANT REGISTRY — the master spreadsheet's OrgRegistry tab: one row per organization,
// holding only pointers/metadata (which spreadsheet holds its data, capacity stats) —
// never the org's actual records. getOrgSpreadsheet(orgId) is the ONLY function that
// should ever be used to reach an org's data; nothing else should hardcode a spreadsheet
// reference or fall back to getActiveSpreadsheet() for org data.
// =====================================================================================
function findOrgRegistryRow(orgId){
  return readRows(ORG_REGISTRY_SHEET).find(r => r.orgId === orgId);
}

/** Creates a brand-new per-tenant spreadsheet (Data tab only, correct headers), and
 * registers it in OrgRegistry. Called once, from actionSignup. */
function createTenantSpreadsheet(orgId, orgName){
  const ss = SpreadsheetApp.create(`OKV OMS — ${orgName || orgId} — Data`);
  const dataSheet = ss.getSheets()[0];
  dataSheet.setName(DATA_SHEET);
  dataSheet.getRange(1, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS]);
  dataSheet.setFrozenRows(1);

  appendRow(ORG_REGISTRY_SHEET, ORG_REGISTRY_HEADERS, {
    orgId, orgName, dataSpreadsheetId: ss.getId(), dataSpreadsheetUrl: ss.getUrl(), createdAt: nowIso(),
    cellsUsed: 0, cellsLimit: CELL_LIMIT_PER_SPREADSHEET, pctUsed: 0,
    growthPerDay30: '', growthPerDay90: '', estRemainingDays: '', estRemainingLabel: 'Not yet checked',
    capacityStatus: 'Healthy', capacityRecommendation: '', lastCapacityCheckAt: '', lastCapacityAlertSentAt: ''
  });
  _orgSpreadsheetCache[orgId] = ss;
  return ss;
}

/** Central helper: resolves any org's dedicated Spreadsheet object from the registry.
 * Every backend function that needs an org's records (getData/pushData, capacity checks,
 * migration) goes through this instead of assuming "the active spreadsheet". Throws a
 * clear error if the org has no registered spreadsheet yet (shouldn't happen for any org
 * created after this change — see createTenantSpreadsheet — but is a helpful signal if
 * an older/unmigrated org slips through). */
function getOrgSpreadsheet(orgId){
  if(_orgSpreadsheetCache[orgId]) return _orgSpreadsheetCache[orgId];
  const reg = findOrgRegistryRow(orgId);
  if(!reg || !reg.dataSpreadsheetId){
    throw new Error(`No data spreadsheet registered for this organization. Run migrateLegacyDataToPerTenantSpreadsheets() if this is an older org from before per-tenant spreadsheets.`);
  }
  const ss = SpreadsheetApp.openById(reg.dataSpreadsheetId);
  _orgSpreadsheetCache[orgId] = ss;
  return ss;
}

// =====================================================================================
// ONE-TIME MIGRATION — moves any org data still sitting in this master spreadsheet's own
// legacy "Data" tab (pre-per-tenant-spreadsheets) out into a dedicated spreadsheet per
// org, and registers each one in OrgRegistry. Safe to run more than once: orgs that
// already have a registry row (already migrated, or already signed up under the new
// per-tenant flow) are skipped. Run manually from the Apps Script editor — this is NOT
// wired to any trigger or web-app action.
// =====================================================================================
function migrateLegacyDataToPerTenantSpreadsheets(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const legacySheet = ss.getSheetByName(DATA_SHEET);
  if(!legacySheet){
    SpreadsheetApp.getUi().alert('No legacy "Data" tab found on this spreadsheet — nothing to migrate.');
    return;
  }
  const legacyRows = readRows(DATA_SHEET); // ss = active/master, i.e. this legacy tab
  if(!legacyRows.length){
    SpreadsheetApp.getUi().alert('The legacy "Data" tab is empty — nothing to migrate. You can rename or delete it manually.');
    return;
  }

  const byOrg = {};
  legacyRows.forEach(r => { (byOrg[r.orgId] = byOrg[r.orgId] || []).push(r); });

  const users = readRows(USERS_SHEET);
  let migratedOrgs = 0, migratedRows = 0, skippedOrgs = [];

  Object.keys(byOrg).forEach(orgId => {
    if(findOrgRegistryRow(orgId)){ skippedOrgs.push(orgId); return; } // already has its own spreadsheet
    const owner = users.find(u => u.orgId === orgId);
    const orgName = (owner && owner.orgName) || orgId;
    const tenantSS = createTenantSpreadsheet(orgId, orgName);
    const sh = tenantSS.getSheetByName(DATA_SHEET);
    const rows = byOrg[orgId].map(r => DATA_HEADERS.map(h => r[h] !== undefined ? r[h] : ''));
    if(rows.length) sh.getRange(2, 1, rows.length, DATA_HEADERS.length).setValues(rows);
    migratedOrgs++; migratedRows += rows.length;
  });

  legacySheet.setName(`Data_LEGACY_MIGRATED_${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')}`);

  SpreadsheetApp.getUi().alert(
    `Migration complete.\n\nOrganizations migrated: ${migratedOrgs} (${migratedRows} records moved to their own spreadsheets)\n` +
    (skippedOrgs.length ? `Skipped (already had a spreadsheet): ${skippedOrgs.length}\n` : '') +
    `\nThe old "Data" tab has been renamed (not deleted) so you can double-check it before removing it yourself.`
  );
}

// =====================================================================================
// SYSTEM CONFIG — owner contact info + bank details, editable from the Super Admin
// Dashboard (or directly in the SystemConfig sheet) instead of being hardcoded.
// =====================================================================================
function getAllConfig(){
  const sh = sheet(CONFIG_SHEET);
  const values = sh.getDataRange().getValues();
  const config = {};
  values.slice(1).forEach(row => { if(row[0]) config[row[0]] = row[1]; });
  return config;
}
function setConfigValue(key, value){
  const sh = sheet(CONFIG_SHEET);
  const values = sh.getDataRange().getValues();
  for(let i = 1; i < values.length; i++){
    if(values[i][0] === key){ sh.getRange(i + 1, 2).setValue(value); return; }
  }
  sh.appendRow([key, value]); // key didn't exist yet
}

/**
 * Attempts a real SMS send via whichever provider is configured (Termii or Twilio).
 * Returns true on a confirmed send, false otherwise (caller falls back to a tap-to-send
 * link either way, so a misconfigured or down gateway never loses the message entirely).
 */
function trySendSms(phone, message, cfg){
  if(cfg.smsEnabled !== 'true' || !cfg.smsApiKey) return false;
  try{
    if(cfg.smsProvider === 'twilio'){
      // Twilio expects "accountSid:authToken" in smsApiKey/smsSenderId as "SID|TOKEN"; simplest
      // single-field approach: smsApiKey holds "SID:TOKEN", smsSenderId holds the Twilio number.
      const [sid, token] = String(cfg.smsApiKey).split(':');
      if(!sid || !token || !cfg.smsSenderId) return false;
      const res = UrlFetchApp.fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'post',
        headers: { Authorization: 'Basic ' + Utilities.base64Encode(sid + ':' + token) },
        payload: { To: phone, From: cfg.smsSenderId, Body: message },
        muteHttpExceptions: true
      });
      return res.getResponseCode() < 300;
    }
    // Default: Termii (https://developers.termii.com)
    const res = UrlFetchApp.fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({
        to: phone, from: cfg.smsSenderId || 'OKV OMS', sms: message,
        type: 'plain', channel: 'generic', api_key: cfg.smsApiKey
      })
    });
    return res.getResponseCode() < 300;
  }catch(e){ return false; }
}

/** Attempts a real WhatsApp send via the WhatsApp Cloud API. Same fallback contract as trySendSms. */
function trySendWhatsApp(phone, message, cfg){
  if(cfg.whatsappEnabled !== 'true' || !cfg.whatsappAccessToken || !cfg.whatsappPhoneId) return false;
  try{
    const res = UrlFetchApp.fetch(`https://graph.facebook.com/v18.0/${cfg.whatsappPhoneId}/messages`, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + cfg.whatsappAccessToken },
      payload: JSON.stringify({
        messaging_product: 'whatsapp', to: phone.replace(/[^0-9]/g, ''),
        type: 'text', text: { body: message }
      })
    });
    return res.getResponseCode() < 300;
  }catch(e){ return false; }
}

// =====================================================================================
// USERS
// =====================================================================================
function findUserByUsername(username){
  return readRows(USERS_SHEET).find(u => String(u.username).toLowerCase() === String(username).toLowerCase());
}
function findUserById(id){
  return readRows(USERS_SHEET).find(u => u.id === id);
}
function rolesToArray(rolesStr){
  return String(rolesStr || '').split(',').map(r => r.trim()).filter(Boolean);
}
function isAdminUser(u){
  return u.isOwner === true || u.isOwner === 'true' || rolesToArray(u.roles).indexOf('Organization Super Admin') !== -1;
}
function publicUser(u){
  return {
    id: u.id, orgId: u.orgId, orgName: u.orgName, fullName: u.fullName, username: u.username, phone: u.phone,
    roles: rolesToArray(u.roles), isOwner: (u.isOwner === true || u.isOwner === 'true'),
    isAdmin: isAdminUser(u), isSuperAdmin: (u.isSuperAdmin === true || u.isSuperAdmin === 'true'), status: u.status,
    plan: u.plan, billingCycle: u.billingCycle,
    subscriptionStatus: u.subscriptionStatus, trialEndsAt: u.trialEndsAt, subscriptionStartedAt: u.subscriptionStartedAt, subscriptionExpiry: u.subscriptionExpiry
  };
}
/** True once "trialing" has run past trialEndsAt with no paid subscriptionExpiry taking over. */
function isAccessExpired(u){
  const expiryStr = (u.subscriptionStatus === 'trialing') ? u.trialEndsAt : u.subscriptionExpiry;
  if(!expiryStr) return false; // no expiry set = unlimited (e.g. Phase 2 test accounts)
  return new Date(expiryStr).getTime() < Date.now();
}

/** Verifies {requesterId, requesterPasswordHash, orgId} and returns the requester row, or throws. */
function requireUser(body){
  const u = findUserById(body.requesterId);
  if(!u || u.orgId !== body.orgId) throw new Error('Not authorized.');
  if(u.passwordHash !== body.requesterPasswordHash) throw new Error('Not authorized.');
  if(u.status !== 'active') throw new Error('Your account is not active.');
  if(u.subscriptionStatus === 'inactive' || isAccessExpired(u)) throw new Error('Your subscription has expired.');
  return u;
}
function requireAdmin(body){
  const u = requireUser(body);
  if(!isAdminUser(u)) throw new Error('Admin access required.');
  return u;
}
function requireSuperAdmin(body){
  const u = requireUser(body);
  if(!(u.isSuperAdmin === true || u.isSuperAdmin === 'true')) throw new Error('Super Admin access required.');
  return u;
}

// ---- signup: creates a brand-new org + its owner/admin user, starts a 7-day free trial ----
function actionSignup(body){
  const username = String(body.username || '').trim();
  const orgName = String(body.orgName || '').trim();
  const fullName = String(body.fullName || '').trim();
  const phone = String(body.phone || '').trim();
  const plan = PLAN_LABELS[body.planId] || String(body.plan || '').trim();
  if(!username || !body.passwordHash || !orgName || !fullName) return { success:false, error:'Organization name, full name, email, and password are required.' };
  if(findUserByUsername(username)) return { success:false, error:'That email is already registered.' };

  const orgId = uuid();
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
  const user = {
    id: uuid(), orgId, orgName, fullName, username, phone, passwordHash: body.passwordHash,
    roles: 'Organization Super Admin', isOwner: true, status: 'active',
    plan, billingCycle: body.billingCycle || '',
    subscriptionStatus: 'trialing', trialEndsAt, subscriptionStartedAt: nowIso(), subscriptionExpiry: '',
    resetToken: '', resetTokenExpiry: '', createdAt: nowIso(), updatedAt: nowIso()
  };
  appendRow(USERS_SHEET, USERS_HEADERS, user);
  createTenantSpreadsheet(orgId, orgName); // this org's own dedicated data spreadsheet — see getOrgSpreadsheet()

  try{
    MailApp.sendEmail(platformMailOptions({
      to: username,
      subject: `Welcome to OKV Organization Management System — your 7-day free trial has started`,
      body: `Hi ${fullName},\n\n${orgName} is all set up on OKV Organization Management System.\n\n` +
            `Plan selected: ${plan || 'Not specified'}\n` +
            `Your free trial runs through ${new Date(trialEndsAt).toDateString()} (${TRIAL_DAYS} days) — no card required.\n\n` +
            `Next step: install the app and log in with the email and password you just created.\n${APP_BASE_URL}/install.html?org=${encodeURIComponent(orgName)}\n\n` +
            `You can review or change your plan any time from your dashboard.\n\nWelcome aboard!` +
            contactFooter()
    }));
  }catch(e){
    // Email is best-effort — a Gmail send failure shouldn't block account creation.
  }

  return { success:true, user: publicUser(user) };
}

// ---- login ----
function actionLogin(body){
  const u = findUserByUsername(body.username || '');
  if(!u || u.passwordHash !== body.passwordHash) return { success:false, error:'Invalid username or password.' };
  if(u.status !== 'active') return { success:false, error:'Your account has been suspended. Contact your organization admin.' };
  if(u.subscriptionStatus === 'inactive') return { success:false, error:"Your organization's subscription is inactive. Visit the pricing page to reactivate." };
  if(isAccessExpired(u)){
    const msg = (u.subscriptionStatus === 'trialing')
      ? 'Your 7-day free trial has ended. Choose a plan to keep using OKV OMS.'
      : "Your subscription has expired. Renew to keep using OKV OMS.";
    return { success:false, error: msg, expired:true };
  }
  return { success:true, user: publicUser(u) };
}

// ---- forgot password (Admin/owner self-serve, email + token) ----
function actionForgotPassword(body){
  const u = findUserByUsername(body.username || '');
  // Always return success (don't reveal whether the account exists).
  if(!u) return { success:true };
  const token = uuid();
  const expiry = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60000).toISOString();
  updateRow(USERS_SHEET, USERS_HEADERS, u._row, { resetToken: token, resetTokenExpiry: expiry, updatedAt: nowIso() });
  const link = `${APP_BASE_URL}/reset-password.html?token=${token}`;
  MailApp.sendEmail(platformMailOptions({
    to: u.username,
    subject: `Reset your ${u.orgName || 'OKV OMS'} password`,
    body: `Hi,\n\nSomeone requested a password reset for your OKV Organization Management System account.\n\nReset your password here (link expires in ${RESET_TOKEN_TTL_MINUTES} minutes):\n${link}\n\nIf you didn't request this, you can safely ignore this email.` + contactFooter()
  }));
  return { success:true };
}

// ---- reset password via token ----
function actionResetPassword(body){
  const rows = readRows(USERS_SHEET);
  const u = rows.find(r => r.resetToken && r.resetToken === body.token);
  if(!u) return { success:false, error:'This reset link is invalid.' };
  if(!u.resetTokenExpiry || new Date(u.resetTokenExpiry).getTime() < Date.now()){
    return { success:false, error:'This reset link has expired. Please request a new one.' };
  }
  updateRow(USERS_SHEET, USERS_HEADERS, u._row, {
    passwordHash: body.newPasswordHash, resetToken: '', resetTokenExpiry: '', updatedAt: nowIso()
  });
  return { success:true };
}

// ---- change own password (Admin or User, from their dashboard) ----
function actionChangePassword(body){
  const u = requireUser(body); // requester === the account changing its own password
  if(u.passwordHash !== body.oldPasswordHash) return { success:false, error:'Current password is incorrect.' };
  updateRow(USERS_SHEET, USERS_HEADERS, u._row, { passwordHash: body.newPasswordHash, updatedAt: nowIso() });
  return { success:true };
}

// ---- admin: list org users ----
function actionListUsers(body){
  requireAdmin(body);
  const users = readRows(USERS_SHEET).filter(u => u.orgId === body.orgId).map(publicUser);
  return { success:true, users, roleOptions: ROLE_OPTIONS };
}

// ---- admin: create a user in their own org ----
function actionCreateUser(body){
  const admin = requireAdmin(body);
  const username = String(body.username || '').trim();
  const fullName = String(body.fullName || '').trim();
  if(!username || !body.passwordHash) return { success:false, error:'Username and password are required.' };
  if(findUserByUsername(username)) return { success:false, error:'That username is already registered.' };
  const roles = Array.isArray(body.roles) ? body.roles.filter(r => ROLE_OPTIONS.indexOf(r) !== -1) : [];
  const user = {
    id: uuid(), orgId: admin.orgId, orgName: admin.orgName, fullName, username, phone: String(body.phone || ''), passwordHash: body.passwordHash,
    roles: roles.join(','), isOwner: false, status: 'active',
    plan: admin.plan, billingCycle: admin.billingCycle, // team members share the org's plan/trial/subscription
    subscriptionStatus: admin.subscriptionStatus, trialEndsAt: admin.trialEndsAt, subscriptionStartedAt: admin.subscriptionStartedAt, subscriptionExpiry: admin.subscriptionExpiry,
    resetToken: '', resetTokenExpiry: '', createdAt: nowIso(), updatedAt: nowIso()
  };
  appendRow(USERS_SHEET, USERS_HEADERS, user);
  return { success:true, user: publicUser(user) };
}

// ---- admin: add/remove a user's roles ----
function actionUpdateUserRoles(body){
  const admin = requireAdmin(body);
  const target = findUserById(body.targetUserId);
  if(!target || target.orgId !== admin.orgId) return { success:false, error:'User not found in your organization.' };
  const roles = Array.isArray(body.roles) ? body.roles.filter(r => ROLE_OPTIONS.indexOf(r) !== -1) : [];
  updateRow(USERS_SHEET, USERS_HEADERS, target._row, { roles: roles.join(','), updatedAt: nowIso() });
  return { success:true };
}

// ---- admin: activate/suspend a user ----
function actionSetUserStatus(body){
  const admin = requireAdmin(body);
  if(body.targetUserId === admin.id && body.status === 'suspended'){
    return { success:false, error:"You can't suspend your own account." };
  }
  const target = findUserById(body.targetUserId);
  if(!target || target.orgId !== admin.orgId) return { success:false, error:'User not found in your organization.' };
  if(['active','suspended'].indexOf(body.status) === -1) return { success:false, error:'Invalid status.' };
  updateRow(USERS_SHEET, USERS_HEADERS, target._row, { status: body.status, updatedAt: nowIso() });
  return { success:true };
}

// ---- admin: set a user's password directly (no email/token) ----
function actionSetUserPassword(body){
  const admin = requireAdmin(body);
  const target = findUserById(body.targetUserId);
  if(!target || target.orgId !== admin.orgId) return { success:false, error:'User not found in your organization.' };
  updateRow(USERS_SHEET, USERS_HEADERS, target._row, { passwordHash: body.newPasswordHash, updatedAt: nowIso() });
  return { success:true };
}

// ---- admin: delete a user ----
function actionDeleteUser(body){
  const admin = requireAdmin(body);
  if(body.targetUserId === admin.id) return { success:false, error:"You can't delete your own account." };
  const target = findUserById(body.targetUserId);
  if(!target || target.orgId !== admin.orgId) return { success:false, error:'User not found in your organization.' };
  sheet(USERS_SHEET).deleteRow(target._row);
  return { success:true };
}

// =====================================================================================
// DATA (org records — members, finance, events, etc. — one row per record, tagged by
// module, stored as a JSON payload so every module shares the same sheet/columns)
// =====================================================================================
function actionGetData(body){
  const requester = requireUser(body);
  const admin = isAdminUser(requester);
  const orgSS = getOrgSpreadsheet(body.orgId); // this org's own spreadsheet — never the master
  const since = body.since ? new Date(body.since).getTime() : 0;
  const rows = readRows(DATA_SHEET, orgSS).filter(r => {
    if(!admin && r.createdBy !== requester.id) return false;
    if(since && new Date(r.updatedAt).getTime() <= since) return false;
    return true;
  });
  const records = rows.map(r => {
    let payload = {};
    try{ payload = JSON.parse(r.payload); }catch(e){}
    return { id: r.id, module: r.module, record: payload, createdBy: r.createdBy, updatedAt: r.updatedAt, deleted: (r.deleted === true || r.deleted === 'true') };
  });
  return { success:true, records, serverTime: nowIso() };
}

function actionPushData(body){
  const requester = requireUser(body);
  const admin = isAdminUser(requester);
  const orgSS = getOrgSpreadsheet(body.orgId); // this org's own spreadsheet — never the master
  const changes = Array.isArray(body.changes) ? body.changes : [];
  const rows = readRows(DATA_SHEET, orgSS);
  const byId = {};
  rows.forEach(r => byId[r.id] = r);
  const accepted = [], rejected = [];

  changes.forEach(ch => {
    const existing = byId[ch.id];
    if(existing && !admin && existing.createdBy !== requester.id){ rejected.push(ch.id); return; } // can't edit others' records
    const createdBy = existing ? existing.createdBy : requester.id; // ownership is fixed at creation
    const rowObj = {
      id: ch.id, orgId: body.orgId, module: ch.module,
      payload: JSON.stringify(ch.record || {}),
      createdBy, updatedAt: ch.updatedAt || nowIso(),
      deleted: !!ch.deleted
    };
    if(existing){
      updateRow(DATA_SHEET, DATA_HEADERS, existing._row, rowObj, orgSS);
    } else {
      appendRow(DATA_SHEET, DATA_HEADERS, rowObj, orgSS);
    }
    accepted.push(ch.id);
  });

  return { success:true, accepted, rejected, serverTime: nowIso() };
}

// =====================================================================================
// TEAM CONTACTS — a lightweight, non-admin-gated directory lookup so any active team
// member (not just Admins) can pick internal recipients when sending a message.
// =====================================================================================
function actionListTeamContacts(body){
  const requester = requireUser(body);
  const contacts = readRows(USERS_SHEET)
    .filter(u => u.orgId === body.orgId)
    .map(u => ({ id: u.id, username: u.username, fullName: u.fullName, roles: rolesToArray(u.roles) }));
  return { success:true, contacts };
}

// =====================================================================================
// MESSAGING — Admins and Users can message Members (individually or in bulk), their
// teammates, or themselves, over Email, SMS, or WhatsApp.
// -------------------------------------------------------------------------------------
// Email always sends (MailApp). SMS and WhatsApp send for real too, IF the Super Admin
// has configured and enabled a gateway (Platform Settings → Email/SMS/WhatsApp) — see
// trySendSms()/trySendWhatsApp() above. If a gateway isn't configured, isn't enabled, or
// the send attempt fails, this falls back to a tap-to-send link (sms: / wa.me) per
// recipient instead, so a message is never silently lost either way.
// =====================================================================================
function actionSendMessage(body){
  const requester = requireUser(body);
  const recipients = Array.isArray(body.recipients) ? body.recipients : []; // [{label, email, phone}]
  const channels = Array.isArray(body.channels) ? body.channels : [];
  const subject = String(body.subject || 'Message from ' + (requester.orgName || 'your organization'));
  const messageBody = String(body.body || '');
  if(!recipients.length || !channels.length || !messageBody.trim()){
    return { success:false, error:'At least one recipient, one channel, and a message are required.' };
  }
  const cfg = getAllConfig();

  let emailsSent = 0;
  const smsLinks = [], whatsappLinks = [];

  recipients.forEach(r => {
    channels.forEach(ch => {
      let deliveryStatus = 'logged';
      if(ch === 'email' && r.email){
        try{
          MailApp.sendEmail({ to: r.email, subject, body: messageBody });
          emailsSent++;
          deliveryStatus = 'sent';
        }catch(e){ deliveryStatus = 'failed'; }
      } else if(ch === 'sms' && r.phone){
        if(trySendSms(r.phone, messageBody, cfg)){
          deliveryStatus = 'sent';
        } else {
          smsLinks.push({ label: r.label, phone: r.phone, url: 'sms:' + r.phone + '?body=' + encodeURIComponent(messageBody) });
          deliveryStatus = 'manual-link';
        }
      } else if(ch === 'whatsapp' && r.phone){
        if(trySendWhatsApp(r.phone, messageBody, cfg)){
          deliveryStatus = 'sent';
        } else {
          whatsappLinks.push({ label: r.label, phone: r.phone, url: 'https://wa.me/' + r.phone.replace(/[^0-9]/g,'') + '?text=' + encodeURIComponent(messageBody) });
          deliveryStatus = 'manual-link';
        }
      } else {
        deliveryStatus = 'skipped-no-contact-info';
      }
      appendRow(MESSAGES_SHEET, MESSAGES_HEADERS, {
        id: uuid(), orgId: body.orgId, fromUserId: requester.id, fromUsername: requester.username,
        audience: body.audience || '', recipientLabel: r.label || '', recipientEmail: r.email || '', recipientPhone: r.phone || '',
        channel: ch, subject, body: messageBody, deliveryStatus, sentAt: nowIso()
      });
    });
  });

  return { success:true, emailsSent, smsLinks, whatsappLinks };
}

// =====================================================================================
// PAYMENT REQUESTS — the manual bank-transfer upgrade flow. A submission here does NOT
// upgrade anyone automatically (there's no payment processor wired up); it emails you
// (OWNER_EMAIL) the details + screenshot so you can verify the transfer yourself, then
// records a row you review by editing the "status" cell in the PaymentRequests sheet.
// onPaymentStatusEdit() below (set up as an installable trigger — see README) watches
// for that edit and does the actual upgrade + sends the requester their status email.
// =====================================================================================
function actionSubmitPaymentRequest(body){
  const admin = requireAdmin(body); // upgrading is a billing action — Admin only
  const planRequested = PLAN_LABELS[body.planId] || String(body.plan || '').trim();
  if(!planRequested || !body.billingCycle) return { success:false, error:'Please choose a plan and billing cycle.' };
  if(!body.contactEmail) return { success:false, error:'A contact email is required.' };

  const request = {
    id: uuid(), orgId: admin.orgId, requestedByUserId: admin.id, orgName: body.orgName || admin.orgName,
    contactEmail: body.contactEmail, contactPhone: body.contactPhone || '',
    planRequested, billingCycle: body.billingCycle, paymentMethod: 'manual', gatewayReference: '', status: 'pending', reviewNote: '',
    submittedAt: nowIso(), reviewedAt: ''
  };
  appendRow(PAYMENTS_SHEET, PAYMENTS_HEADERS, request);

  try{
    const options = platformMailOptions({ to: getAllConfig().ownerEmail || DEFAULT_OWNER_EMAIL, subject: `Upgrade payment submitted — ${request.orgName}`,
      body: `Organization: ${request.orgName}\nOrg ID: ${admin.orgId}\nContact: ${body.contactEmail} / ${body.contactPhone || 'no phone given'}\nPlan requested: ${planRequested}\nBilling cycle: ${body.billingCycle}\nSubmitted: ${request.submittedAt}\n\nReview this in the PaymentRequests sheet — set its "status" cell to "confirmed" or "rejected" (with an optional reviewNote) to notify the organization automatically.` });
    if(body.screenshotBase64){
      const blob = Utilities.newBlob(Utilities.base64Decode(body.screenshotBase64), body.screenshotMimeType || 'image/png', body.screenshotFilename || 'payment-screenshot.png');
      options.attachments = [blob];
    }
    MailApp.sendEmail(options);
  }catch(e){
    // Email is best-effort — the request is already saved either way.
  }

  return { success:true };
}

/**
 * Shared by both the manual sheet-edit trigger (onPaymentStatusEdit) and the Super
 * Admin Dashboard's "Confirm"/"Reject" buttons (actionReviewPaymentRequest) — so
 * either path does the exact same upgrade + email logic, with no duplication.
 */
function applyPaymentDecision(request, decision, reviewNote){
  if(request.reviewedAt) return; // already processed — never send duplicate emails

  if(decision === 'confirmed'){
    const cycleDays = CYCLE_DAYS[request.billingCycle] || 30;
    const startedAt = nowIso();
    const expiry = new Date(Date.now() + cycleDays * 86400000).toISOString();
    // The whole org shares one plan/subscription — update every user row in this org.
    const users = readRows(USERS_SHEET).filter(u => u.orgId === request.orgId);
    users.forEach(u => {
      updateRow(USERS_SHEET, USERS_HEADERS, u._row, {
        plan: request.planRequested, billingCycle: request.billingCycle,
        subscriptionStatus: 'active', subscriptionStartedAt: startedAt, subscriptionExpiry: expiry,
        updatedAt: nowIso()
      });
    });
    try{
      MailApp.sendEmail(platformMailOptions({
        to: request.contactEmail,
        subject: `You're upgraded — ${request.planRequested}`,
        body: `Good news! Your payment has been confirmed.\n\nPlan: ${request.planRequested}\nBilling cycle: ${request.billingCycle}\nStart date: ${new Date(startedAt).toDateString()}\nNext renewal due: ${new Date(expiry).toDateString()}\n\nYour dashboard will reflect this the next time you log in or sync — thank you!` + contactFooter()
      }));
    }catch(err){}
  } else {
    try{
      MailApp.sendEmail(platformMailOptions({
        to: request.contactEmail,
        subject: `We couldn't confirm your payment`,
        body: `We weren't able to confirm your recent payment submission for ${request.planRequested}.\n\n${reviewNote ? 'Note: ' + reviewNote + '\n\n' : ''}Please double-check the transfer details and submit again from your dashboard, or reply to this email if you believe this is a mistake.` + contactFooter()
      }));
    }catch(err){}
  }

  const rows = readRows(PAYMENTS_SHEET);
  const row = rows.find(r => r.id === request.id);
  if(row) updateRow(PAYMENTS_SHEET, PAYMENTS_HEADERS, row._row, { status: decision, reviewNote: reviewNote || '', reviewedAt: nowIso() });
}

// =====================================================================================
// PAYSTACK — real checkout: initialize a transaction, send the org's Admin to Paystack's
// hosted payment page, then verify the transaction when Paystack redirects back to
// payment-callback.html. Confirmed payments run through the exact same
// applyPaymentDecision() as a manually-reviewed bank transfer, so both methods behave
// identically from the organization's point of view and show up in the same
// PaymentRequests sheet / Super Admin "Payment Requests" tab.
//
// Flutterwave and Remita have their credentials configurable from the Super Admin
// Dashboard (Payment Methods tab) but are NOT wired up to a real checkout flow yet —
// only Paystack is. See the README for notes on extending this same pattern to them.
// =====================================================================================
function actionInitPaystackPayment(body){
  const admin = requireAdmin(body);
  const cfg = getAllConfig();
  if((cfg.paystackEnabled || CONFIG_DEFAULTS.paystackEnabled) !== 'true') return { success:false, error:'Card payment is not enabled.' };
  const secretKey = cfg.paystackSecretKey;
  if(!secretKey) return { success:false, error:'Card payment is not configured yet — contact support.' };

  const planRequested = PLAN_LABELS[body.planId] || String(body.plan || '').trim();
  const priceKey = 'price_' + body.planId;
  const amountMajorUnits = Number(cfg[priceKey] !== undefined ? cfg[priceKey] : CONFIG_DEFAULTS[priceKey]);
  if(!planRequested || !body.billingCycle || !amountMajorUnits) return { success:false, error:'Please choose a valid plan.' };
  if(!body.contactEmail) return { success:false, error:'A contact email is required.' };

  const request = {
    id: uuid(), orgId: admin.orgId, requestedByUserId: admin.id, orgName: body.orgName || admin.orgName,
    contactEmail: body.contactEmail, contactPhone: body.contactPhone || '',
    planRequested, billingCycle: body.billingCycle, paymentMethod: 'paystack', gatewayReference: '',
    status: 'pending', reviewNote: '', submittedAt: nowIso(), reviewedAt: ''
  };
  appendRow(PAYMENTS_SHEET, PAYMENTS_HEADERS, request);

  const currency = cfg.paystackCurrency || CONFIG_DEFAULTS.paystackCurrency;
  const payload = {
    email: body.contactEmail,
    amount: Math.round(amountMajorUnits * 100), // Paystack expects the smallest currency unit (kobo/cents)
    currency,
    callback_url: `${APP_BASE_URL}/payment-callback.html`,
    metadata: { paymentRequestId: request.id, orgId: admin.orgId, planId: body.planId, billingCycle: body.billingCycle }
  };

  try{
    const res = UrlFetchApp.fetch('https://api.paystack.co/transaction/initialize', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + secretKey },
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText());
    if(!data.status) return { success:false, error: data.message || 'Could not start payment.' };

    const rows = readRows(PAYMENTS_SHEET);
    const row = rows.find(r => r.id === request.id);
    if(row) updateRow(PAYMENTS_SHEET, PAYMENTS_HEADERS, row._row, { gatewayReference: data.data.reference });

    return { success:true, authorizationUrl: data.data.authorization_url, reference: data.data.reference };
  }catch(err){
    return { success:false, error:'Could not reach the payment provider. Please try again.' };
  }
}

/** Called from payment-callback.html after Paystack redirects back — no login required
 *  (the person may land here mid-flow without their session handy), the reference
 *  itself is the proof of a specific transaction. */
function actionVerifyPaystackPayment(body){
  const cfg = getAllConfig();
  const secretKey = cfg.paystackSecretKey;
  const reference = body.reference;
  if(!secretKey || !reference) return { success:false, error:'Missing payment reference.' };

  const rows = readRows(PAYMENTS_SHEET);
  const request = rows.find(r => r.gatewayReference === reference);
  if(!request) return { success:false, error:'We could not find this payment.' };
  if(request.reviewedAt){
    return { success:true, alreadyProcessed:true, planRequested: request.planRequested, billingCycle: request.billingCycle };
  }

  try{
    const res = UrlFetchApp.fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
      method: 'get', headers: { Authorization: 'Bearer ' + secretKey }, muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText());
    if(data.status && data.data && data.data.status === 'success'){
      applyPaymentDecision(request, 'confirmed', 'Paid via Paystack (auto-verified)');
      return { success:true, verified:true, planRequested: request.planRequested, billingCycle: request.billingCycle };
    }
    return { success:true, verified:false, planRequested: request.planRequested };
  }catch(err){
    return { success:false, error:'Could not verify this payment right now. If you were charged, contact support and we\'ll confirm it manually.' };
  }
}

/**
 * Installable trigger (set up manually — see README): fires whenever a cell in this
 * spreadsheet is edited. Only acts when the edit is the "status" column of the
 * PaymentRequests sheet, changed to "confirmed" or "rejected".
 */
function onPaymentStatusEdit(e){
  if(!e || !e.range) return;
  const sheet = e.range.getSheet();
  if(sheet.getName() !== PAYMENTS_SHEET) return;
  const statusCol = PAYMENTS_HEADERS.indexOf('status') + 1;
  if(e.range.getColumn() !== statusCol) return;

  const row = e.range.getRow();
  if(row === 1) return; // header row
  const newStatus = String(e.value || '').trim().toLowerCase();
  if(newStatus !== 'confirmed' && newStatus !== 'rejected') return;

  const rowValues = sheet.getRange(row, 1, 1, PAYMENTS_HEADERS.length).getValues()[0];
  const request = {};
  PAYMENTS_HEADERS.forEach((h, i) => request[h] = rowValues[i]);
  applyPaymentDecision(request, newStatus, request.reviewNote);
}

// =====================================================================================
// SUPER ADMIN DASHBOARD — platform-wide oversight across every organization. Distinct
// from an org's own "Organization Super Admin" *role* (see ROLE_OPTIONS) — this is the
// one platform account (technologyokv@gmail.com by default) that can see every org.
// =====================================================================================

// ---- public: contact + bank details shown wherever the app needs them (pricing page,
// the Subscription/payment form, marketing footer, etc.) — no login required, nothing
// sensitive here. ----
function actionGetPlatformConfig(body){
  const cfg = getAllConfig();
  const out = { success:true };
  PUBLIC_CONFIG_KEYS.forEach(k => { out[k] = (cfg[k] !== undefined && cfg[k] !== '') ? cfg[k] : CONFIG_DEFAULTS[k]; });
  return out;
}

// ---- Super Admin only: every setting, including secret API keys, for editing ----
function actionGetPlatformConfigFull(body){
  requireSuperAdmin(body);
  const cfg = getAllConfig();
  const out = { success:true };
  Object.keys(CONFIG_DEFAULTS).forEach(k => { out[k] = (cfg[k] !== undefined && cfg[k] !== '') ? cfg[k] : CONFIG_DEFAULTS[k]; });
  return out;
}

function actionUpdatePlatformConfig(body){
  requireSuperAdmin(body);
  Object.keys(CONFIG_DEFAULTS).forEach(f => { if(body[f] !== undefined) setConfigValue(f, String(body[f])); });
  return { success:true };
}

// ---- Super Admin: every organization on the platform, with owner contact + subscription info ----
function actionListOrganizations(body){
  requireSuperAdmin(body);
  const all = readRows(USERS_SHEET).filter(u => u.orgId !== 'PLATFORM');
  const byOrg = {};
  all.forEach(u => {
    if(!byOrg[u.orgId]) byOrg[u.orgId] = { orgId: u.orgId, orgName: u.orgName, users: [] };
    byOrg[u.orgId].users.push(u);
  });
  const orgs = Object.values(byOrg).map(o => {
    const owner = o.users.find(u => u.isOwner === true || u.isOwner === 'true') || o.users[0];
    return {
      orgId: o.orgId, orgName: o.orgName,
      ownerFullName: owner.fullName, ownerEmail: owner.username, ownerPhone: owner.phone,
      plan: owner.plan, billingCycle: owner.billingCycle, subscriptionStatus: owner.subscriptionStatus,
      trialEndsAt: owner.trialEndsAt, subscriptionStartedAt: owner.subscriptionStartedAt, subscriptionExpiry: owner.subscriptionExpiry,
      status: owner.status, userCount: o.users.length
    };
  });
  return { success:true, organizations: orgs };
}

// ---- Super Admin ONLY: per-org spreadsheet cell-capacity — see checkAllTenantCapacities()
// below for how these numbers get computed/refreshed (a daily trigger, not on every load).
// This is display data for the Super Admin Dashboard only — org Admins/Users never see it. ----
function actionListTenantCapacity(body){
  requireSuperAdmin(body);
  const rows = readRows(ORG_REGISTRY_SHEET).map(r => ({
    orgId: r.orgId, orgName: r.orgName,
    cellsUsed: r.cellsUsed, cellsLimit: r.cellsLimit, pctUsed: r.pctUsed,
    estRemainingLabel: r.estRemainingLabel, capacityStatus: r.capacityStatus || 'Healthy',
    capacityRecommendation: r.capacityRecommendation, lastCapacityCheckAt: r.lastCapacityCheckAt,
    dataSpreadsheetUrl: r.dataSpreadsheetUrl
  }));
  return { success:true, tenants: rows };
}

// ---- Super Admin: edit an org's contact details and/or plan/subscription ----
function actionUpdateOrganization(body){
  requireSuperAdmin(body);
  const targetOrgId = body.targetOrgId;
  const orgUsers = readRows(USERS_SHEET).filter(u => u.orgId === targetOrgId);
  if(!orgUsers.length) return { success:false, error:'Organization not found.' };
  const owner = orgUsers.find(u => u.isOwner === true || u.isOwner === 'true') || orgUsers[0];

  // Contact details apply to the org's owner row only.
  const ownerUpdates = {};
  ['fullName','phone'].forEach(f => { if(body[f] !== undefined) ownerUpdates[f] = body[f]; });
  if(Object.keys(ownerUpdates).length){
    ownerUpdates.updatedAt = nowIso();
    updateRow(USERS_SHEET, USERS_HEADERS, owner._row, ownerUpdates);
  }

  // Org name and plan/subscription fields are shared — apply to every user row in the org.
  const orgWideUpdates = {};
  ['orgName','plan','billingCycle','subscriptionStatus','subscriptionExpiry'].forEach(f => { if(body[f] !== undefined) orgWideUpdates[f] = body[f]; });
  if(Object.keys(orgWideUpdates).length){
    orgWideUpdates.updatedAt = nowIso();
    orgUsers.forEach(u => updateRow(USERS_SHEET, USERS_HEADERS, u._row, orgWideUpdates));
  }
  return { success:true };
}

// ---- Super Admin: all payment requests (any status), for review from the dashboard ----
function actionListAllPaymentRequests(body){
  requireSuperAdmin(body);
  const requests = readRows(PAYMENTS_SHEET).map(r => { const c = {...r}; delete c._row; return c; });
  return { success:true, requests };
}

// ---- Super Admin: confirm/reject a payment request from the dashboard (no sheet-editing needed) ----
function actionReviewPaymentRequest(body){
  requireSuperAdmin(body);
  if(body.decision !== 'confirmed' && body.decision !== 'rejected') return { success:false, error:'Invalid decision.' };
  const requests = readRows(PAYMENTS_SHEET);
  const request = requests.find(r => r.id === body.requestId);
  if(!request) return { success:false, error:'Payment request not found.' };
  if(request.reviewedAt) return { success:false, error:'This request has already been reviewed.' };
  applyPaymentDecision(request, body.decision, body.reviewNote || '');
  return { success:true };
}

// ---- Super Admin: message one, several, or all organizations' owners ----
function actionSendPlatformMessage(body){
  requireSuperAdmin(body);
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  const channels = Array.isArray(body.channels) ? body.channels : [];
  const subject = String(body.subject || 'A message from OKV Technology Consults');
  const messageBody = String(body.body || '');
  if(!recipients.length || !channels.length || !messageBody.trim()){
    return { success:false, error:'At least one recipient, one channel, and a message are required.' };
  }
  const cfg = getAllConfig();

  let emailsSent = 0;
  const smsLinks = [], whatsappLinks = [];
  recipients.forEach(r => {
    channels.forEach(ch => {
      let deliveryStatus = 'logged';
      if(ch === 'email' && r.email){
        try{ MailApp.sendEmail(platformMailOptions({ to: r.email, subject, body: messageBody + contactFooter() })); emailsSent++; deliveryStatus = 'sent'; }
        catch(e){ deliveryStatus = 'failed'; }
      } else if(ch === 'sms' && r.phone){
        if(trySendSms(r.phone, messageBody, cfg)){
          deliveryStatus = 'sent';
        } else {
          smsLinks.push({ label: r.label, phone: r.phone, url: 'sms:' + r.phone + '?body=' + encodeURIComponent(messageBody) });
          deliveryStatus = 'manual-link';
        }
      } else if(ch === 'whatsapp' && r.phone){
        if(trySendWhatsApp(r.phone, messageBody, cfg)){
          deliveryStatus = 'sent';
        } else {
          whatsappLinks.push({ label: r.label, phone: r.phone, url: 'https://wa.me/' + r.phone.replace(/[^0-9]/g,'') + '?text=' + encodeURIComponent(messageBody) });
          deliveryStatus = 'manual-link';
        }
      } else {
        deliveryStatus = 'skipped-no-contact-info';
      }
      appendRow(MESSAGES_SHEET, MESSAGES_HEADERS, {
        id: uuid(), orgId: 'PLATFORM', fromUserId: 'super-admin', fromUsername: SUPER_ADMIN_USERNAME,
        audience: body.audience || 'platform', recipientLabel: r.label || '', recipientEmail: r.email || '', recipientPhone: r.phone || '',
        channel: ch, subject, body: messageBody, deliveryStatus, sentAt: nowIso()
      });
    });
  });
  return { success:true, emailsSent, smsLinks, whatsappLinks };
}

// =====================================================================================
// TRIAL / SUBSCRIPTION EXPIRY REMINDERS
// -------------------------------------------------------------------------------------
// Time-driven trigger (set up manually — see README — Triggers → sendExpiryReminders
// → Time-driven → Day timer). Runs daily, but throttles itself to at most once every
// REMINDER_INTERVAL_DAYS (15 — twice a month) per organization, so this stays a
// helpful nudge rather than a disturbing daily notification. Each email reports where
// their trial/subscription stands and suggests whichever plan/tier or billing cycle
// makes sense next for them. The in-app countdown badge/banner on their dashboard
// (computed client-side from the same trialEndsAt/subscriptionExpiry fields) is the
// "automatically on the Dashboard too" half of this, and updates in real time rather
// than twice a month.
// =====================================================================================
function sendExpiryReminders(){
  const owners = readRows(USERS_SHEET).filter(u =>
    (u.isOwner === true || u.isOwner === 'true') && !(u.isSuperAdmin === true || u.isSuperAdmin === 'true')
  );

  owners.forEach(u => {
    const trialing = u.subscriptionStatus === 'trialing';
    const expiryStr = trialing ? u.trialEndsAt : u.subscriptionExpiry;
    if(!expiryStr) return; // nothing to count down to

    const daysSinceLastReminder = u.lastReminderSentAt
      ? (Date.now() - new Date(u.lastReminderSentAt).getTime()) / 86400000
      : Infinity;
    if(daysSinceLastReminder < REMINDER_INTERVAL_DAYS) return; // keep it to twice a month, max

    const daysRemaining = Math.ceil((new Date(expiryStr).getTime() - Date.now()) / 86400000);
    const expired = daysRemaining <= 0;
    const kind = trialing ? 'free trial' : 'subscription';
    const statusLine = expired
      ? `Your ${kind} for ${u.orgName} ended on ${new Date(expiryStr).toDateString()}.`
      : `Your ${kind} for ${u.orgName} ${trialing ? 'ends' : 'is due'} on ${new Date(expiryStr).toDateString()} (${daysRemaining} day${daysRemaining===1?'':'s'} left).`;
    const subject = expired
      ? `Action needed — your ${kind} has ended`
      : `Your ${kind} update — ${daysRemaining} day${daysRemaining===1?'':'s'} left`;

    const body = `Hi ${u.fullName || ''},\n\n${statusLine}\n\n${suggestNextTier(u.plan, u.billingCycle)}\n\nYou can renew or upgrade any time from your dashboard's Subscription tab.`;

    try{
      MailApp.sendEmail(platformMailOptions({ to: u.username, subject, body: body + contactFooter() }));
      updateRow(USERS_SHEET, USERS_HEADERS, u._row, { lastReminderSentAt: nowIso() });
    }catch(e){}
  });
}

/** Picks a plain-language upgrade/renewal suggestion based on the org's current plan and billing cycle. */
function suggestNextTier(plan, billingCycle){
  const p = String(plan || '').toLowerCase();
  if(!p){
    return "Not sure which plan fits best? Starter suits small teams just getting organized; Growth adds unlimited team members, full Reports, CSV/JSON exports, and Backup & Restore. Compare them any time on pricing.html.";
  }
  if(p.indexOf('starter') !== -1){
    return "You're on the Starter plan. If your team has grown past 5 members, or you'd like full Reports, CSV/JSON exports, and Backup & Restore, Growth includes all of that — take a look at pricing.html to compare.";
  }
  if(p.indexOf('growth') !== -1){
    if(billingCycle === 'monthly') return "You're on the Growth plan, billed monthly. Switching to the Yearly cycle saves 20% versus monthly — worth a look on pricing.html if you're planning to stick around.";
    if(billingCycle === 'biannual') return "You're on the Growth plan, billed bi-annually. Switching to the Yearly cycle saves a little more (20% vs 10%) — see pricing.html for the numbers.";
    return "You're on our top Growth Yearly plan — thank you for being with us! No further upgrade needed, just keep an eye on your renewal date.";
  }
  return "Take a look at pricing.html any time to see if a different plan or billing cycle fits your organization better.";
}

// =====================================================================================
// CELL-CAPACITY MONITORING
// -------------------------------------------------------------------------------------
// Google Sheets caps every spreadsheet FILE at 10,000,000 cells total, summed across all
// its tabs — and since each org now has its own dedicated spreadsheet, that cap applies
// per organization. checkAllTenantCapacities() is meant to run on a daily (or weekly)
// time-driven trigger — see the initializeSheets() alert for setup — NOT on every page
// load: it walks every org in OrgRegistry, measures actual cell usage, logs a snapshot,
// derives a growth rate from recent snapshots, and writes the results back to
// OrgRegistry, which is all the Super Admin Dashboard ever reads (actionListTenantCapacity
// above) — the dashboard itself does no spreadsheet-scanning of its own.
// =====================================================================================

/** Sums getLastRow()*getLastColumn() (actual used range, not the full default grid) across
 * every tab in the spreadsheet — this matches how Google counts a file toward the 10M cap. */
function computeSpreadsheetCellUsage(ss){
  return ss.getSheets().reduce((total, sh) => total + (sh.getLastRow() * sh.getLastColumn()), 0);
}

function logCapacitySnapshot(orgId, totalCells){
  appendRow(CAPACITY_HISTORY_SHEET, CAPACITY_HISTORY_HEADERS, { orgId, checkedAt: nowIso(), totalCells });
}

/** Cells-per-day growth rate for one org over the last `windowDays`, from CapacityHistory
 * snapshots (one gets logged per org every time checkAllTenantCapacities runs). Needs at
 * least two snapshots inside the window to say anything — returns null otherwise (e.g. a
 * brand-new org, or the very first week after this feature is turned on). */
function computeGrowthPerDay(historyForOrg, windowDays){
  const cutoff = Date.now() - windowDays * 86400000;
  const inWindow = historyForOrg
    .filter(h => new Date(h.checkedAt).getTime() >= cutoff)
    .sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt));
  if(inWindow.length < 2) return null;
  const first = inWindow[0], last = inWindow[inWindow.length - 1];
  const elapsedDays = (new Date(last.checkedAt).getTime() - new Date(first.checkedAt).getTime()) / 86400000;
  if(elapsedDays < 1) return null; // avoid a noisy same-day divide
  return (last.totalCells - first.totalCells) / elapsedDays;
}

function capacityStatusFor(pctUsed){
  if(pctUsed >= CAPACITY_ACTION_THRESHOLD) return 'Action Needed';
  if(pctUsed >= CAPACITY_MONITOR_THRESHOLD) return 'Monitor';
  return 'Healthy';
}

function capacityRecommendationFor(status, estRemainingLabel){
  if(status === 'Action Needed'){
    return `Approaching the cell limit (${estRemainingLabel || 'soon'}) — archive older records into a separate archive spreadsheet, or split this tenant's data (e.g. by year or module) to free up headroom.`;
  }
  if(status === 'Monitor'){
    return `Usage is climbing — worth planning an archive/split strategy before it becomes urgent (${estRemainingLabel || 'time remaining unknown'}).`;
  }
  return 'No action needed.';
}

function humanRemainingLabel(days){
  if(days === null || days === undefined || !isFinite(days)) return 'Not enough data yet';
  if(days < 0) return 'Already past 90%';
  if(days < 1) return 'Less than a day';
  if(days < 60) return `~${Math.round(days)} day${Math.round(days)===1?'':'s'}`;
  if(days < 730) return `~${Math.round(days/30)} month${Math.round(days/30)===1?'':'s'}`;
  return `~${(days/365).toFixed(1)} years`;
}

/** The daily/weekly job. Measures every org's spreadsheet, logs a snapshot, updates
 * OrgRegistry with fresh capacity numbers, and emails the Super Admin about any org that
 * has just crossed (or remains past, no more than once every CAPACITY_ALERT_INTERVAL_DAYS)
 * the "Action Needed" threshold. */
function checkAllTenantCapacities(){
  const orgs = readRows(ORG_REGISTRY_SHEET);
  if(!orgs.length) return;

  // Pull all history once and group by org, instead of re-reading the sheet per org.
  const allHistory = readRows(CAPACITY_HISTORY_SHEET);
  const historyByOrg = {};
  allHistory.forEach(h => { (historyByOrg[h.orgId] = historyByOrg[h.orgId] || []).push(h); });

  const toAlert = [];

  orgs.forEach(org => {
    let ss;
    try{ ss = SpreadsheetApp.openById(org.dataSpreadsheetId); }
    catch(e){ return; } // spreadsheet missing/inaccessible — skip rather than fail the whole run

    const totalCells = computeSpreadsheetCellUsage(ss);
    logCapacitySnapshot(org.orgId, totalCells);

    const pctUsed = totalCells / CELL_LIMIT_PER_SPREADSHEET;
    const history = (historyByOrg[org.orgId] || []).concat([{ orgId: org.orgId, checkedAt: nowIso(), totalCells }]);
    const growth30 = computeGrowthPerDay(history, 30);
    const growth90 = computeGrowthPerDay(history, 90);
    // Prefer the 30-day rate (more responsive to recent pace); fall back to 90-day if the
    // org doesn't have a full 30 days of history yet.
    const growthPerDay = (growth30 !== null ? growth30 : growth90);

    const targetCells = CELL_LIMIT_PER_SPREADSHEET * CAPACITY_TARGET_PCT;
    const cellsUntilTarget = targetCells - totalCells;
    const estRemainingDays = (growthPerDay && growthPerDay > 0) ? (cellsUntilTarget / growthPerDay) : null;
    const estRemainingLabel = (cellsUntilTarget <= 0)
      ? 'Already past 90%'
      : (growthPerDay && growthPerDay > 0) ? humanRemainingLabel(estRemainingDays) : 'Not enough data yet';

    const status = capacityStatusFor(pctUsed);
    const recommendation = capacityRecommendationFor(status, estRemainingLabel);

    updateRow(ORG_REGISTRY_SHEET, ORG_REGISTRY_HEADERS, org._row, {
      cellsUsed: totalCells, cellsLimit: CELL_LIMIT_PER_SPREADSHEET, pctUsed: Math.round(pctUsed * 10000) / 100, // store as a %, e.g. 72.35
      growthPerDay30: growth30 !== null ? Math.round(growth30) : '', growthPerDay90: growth90 !== null ? Math.round(growth90) : '',
      estRemainingDays: estRemainingDays !== null ? Math.round(estRemainingDays) : '', estRemainingLabel,
      capacityStatus: status, capacityRecommendation: recommendation, lastCapacityCheckAt: nowIso()
    });

    if(status === 'Action Needed'){
      const daysSinceLastAlert = org.lastCapacityAlertSentAt
        ? (Date.now() - new Date(org.lastCapacityAlertSentAt).getTime()) / 86400000
        : Infinity;
      if(daysSinceLastAlert >= CAPACITY_ALERT_INTERVAL_DAYS){
        toAlert.push({ row: org._row, orgId: org.orgId, orgName: org.orgName, pctUsed, estRemainingLabel, dataSpreadsheetUrl: org.dataSpreadsheetUrl });
      }
    }
  });

  // Prune old history so CapacityHistory doesn't grow forever (keep just past the 90-day window).
  pruneCapacityHistory();

  if(toAlert.length) sendCapacityAlertEmail(toAlert);
}

function pruneCapacityHistory(){
  const sh = sheet(CAPACITY_HISTORY_SHEET);
  const cutoff = Date.now() - CAPACITY_HISTORY_RETENTION_DAYS * 86400000;
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const checkedAtCol = headers.indexOf('checkedAt');
  // Walk bottom-up so deleting a row doesn't shift the index of rows still to check.
  for(let i = values.length - 1; i >= 1; i--){
    if(new Date(values[i][checkedAtCol]).getTime() < cutoff) sh.deleteRow(i + 1);
  }
}

/** Emails the Super Admin (ownerEmail from SystemConfig) about every org that just crossed,
 * or remains past, the "Action Needed" threshold — in addition to the dashboard display. */
function sendCapacityAlertEmail(alerts){
  const cfg = getAllConfig();
  const to = cfg.ownerEmail || DEFAULT_OWNER_EMAIL;
  const lines = alerts.map(a =>
    `• ${a.orgName} — ${(a.pctUsed * 100).toFixed(1)}% of its cell limit used, ${a.estRemainingLabel} until ~90%.\n  Spreadsheet: ${a.dataSpreadsheetUrl}`
  ).join('\n\n');
  try{
    MailApp.sendEmail(platformMailOptions({
      to,
      subject: `Action Needed: ${alerts.length} organization${alerts.length===1?'':'s'} approaching its Google Sheets cell limit`,
      body: `The following organizations have crossed the ${Math.round(CAPACITY_ACTION_THRESHOLD*100)}% cell-usage threshold on their data spreadsheet:\n\n${lines}\n\n` +
            `Recommended next step for each: archive older records into a separate archive spreadsheet, or split the tenant's data further.\n\n` +
            `Full details are on the Super Admin Dashboard's Storage & Capacity view.`
    }));
    const now = nowIso();
    alerts.forEach(a => updateRow(ORG_REGISTRY_SHEET, ORG_REGISTRY_HEADERS, a.row, { lastCapacityAlertSentAt: now }));
  }catch(e){}
}
