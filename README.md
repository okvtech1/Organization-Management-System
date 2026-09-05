# OKV Organization Management System — Phase 2 ("Subscribe") online app

A multi-tenant, marketing-site-to-signed-in-dashboard funnel: a public sales page and
live demo, a 3-cycle × 2-tier pricing page, plan-aware signup with a 7-day free trial,
install instructions, login, and a full organization-management dashboard with
role-based team access, messaging, and offline-first sync — plus a separate **Super
Admin Dashboard** for OKV Technology Consults to manage every organization on the
platform, review upgrade payments (including a real Paystack checkout), send
platform-wide messages, and control branding (colors, logo, tagline), contact/bank
details, SMS/WhatsApp gateways, payment methods, and pricing/plans — all from one
dashboard, no code changes needed. Backed by Google Sheets + Apps Script.

## File structure

```
okv-oms-online/
├── index.html            Marketing/sales landing page — the first page a new
│                          visitor sees. Scroll-spy nav, hero, About, How It Works,
│                          Features, Cross-Platform, Why Us, 30-day guarantee, FAQ,
│                          footer. Links to demo.html and pricing.html — never
│                          registers the service worker (it's pre-install).
├── demo.html              Read-only live demo — the exact same app UI/logic as
│                          app.html, preloaded with sample data, every CRUD action
│                          blocked with a "sign up to make real changes" toast.
│                          No login, no server calls, no persistence.
├── pricing.html           Monthly / Bi-Annual / Yearly tabs, Starter + Growth tiers
│                          each with a target-audience line and feature list. Every
│                          "Start for Free" button links to signup.html with the
│                          plan pre-selected via query params.
├── signup.html            Creates the org + its owner/Admin account. Shows the
│                          plan chosen on pricing.html at the top. Fields: Org/
│                          Business Name, Full Name, Email, Phone, Password. On
│                          success, redirects to install.html (not straight into
│                          the app) — installing comes before logging in.
├── install.html           Dedicated install-only gate — the link Admins share
│                          with teammates (also where signup.html sends new
│                          Admins). Device-detecting install steps; redirects to
│                          login.html afterward. No login form here.
├── login.html             Login only (this used to be index.html in earlier
│                          builds — see "Renamed from index.html" below). Forgot-
│                          password flow, offline gate, small "not installed yet"
│                          helper link to install.html. Routes Super Admin logins
│                          to super-admin.html and everyone else to app.html.
├── reset-password.html    Token-based password reset, reached via the emailed link.
├── payment-callback.html   Where Paystack redirects back to after checkout — verifies
│                          the transaction and shows a success/failure state with a
│                          link back to the dashboard.
├── app.html                The org dashboard: Dashboard, all 12 data modules,
│                          Messages, User Manual, Team & Roles, Install Link,
│                          Subscription (with the upgrade/payment form), My
│                          Account, Settings. Session-gated, per-org IndexedDB
│                          cache, offline-first sync engine.
├── super-admin.html        The Super Admin Dashboard (OKV Technology Consults
│                          only) — every organization's details/contacts,
│                          suspend/activate/edit/delete an org, review payment
│                          requests without touching the Sheet, send messages to
│                          Admins across the platform, and edit the contact/bank
│                          details that appear everywhere else in the system.
├── shared.js              SHA-256 hashing, the API-call wrapper, localStorage
│                          session helpers, and applyLivePlatformSettings() (fills
│                          in any element tagged data-live-setting="..." with the
│                          current contact/bank details from the server) — used
│                          by every page except demo.html, which is fully static.
├── manifest.json           PWA manifest — start_url is login.html, so the
│                          installed icon opens straight to the login screen.
├── sw.js                  Service worker — caches the whole app shell (including
│                          the marketing/demo/pricing pages) for offline use.
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── apps-script/
    └── Code.gs             Google Apps Script backend — deploy as a Web App.
```

### Renamed from index.html
Earlier in this build, `index.html` was the login page. It's now `login.html` —
`index.html` is the new marketing landing page, since that's what a first-time
visitor should see. Every internal link and redirect across the whole project was
updated to match; nothing still points at the old arrangement.

## The funnel, end to end

```
index.html (marketing)
  ├─ "View Live Demo"        → demo.html (read-only, sample data)
  ├─ "Start Free Trial" / nav "Pricing" → pricing.html
  │                                          └─ "Start for Free" (any plan) → signup.html?planId=...&plan=...&cycle=...
  │                                                                              └─ on success → install.html?org=...
  │                                                                                                  └─ (after install) → login.html
  │                                                                                                                          ├─ org Admin/User → app.html
  │                                                                                                                          └─ Super Admin → super-admin.html
  └─ "Log In" (footer)        → login.html
```

Both "Pricing" (nav) and "Start Free Trial" (hero/footer CTAs) lead to
**pricing.html** — signup always starts from a chosen plan, never bypasses it.
Everyone — org Admins, org Users, and the Super Admin — logs in from the same
`login.html`; the server tells the page where to send them next.

## Live contact/bank details

Every place the system shows OKV Technology Consults' contact info or bank details
(the marketing footer, the auth pages' "Need help?" lines, the Subscription tab's
payment form, the Settings contact panel) is tagged `data-live-setting="<key>"` and
gets filled in by `applyLivePlatformSettings()` (in `shared.js`) from whatever's
currently saved in the **SystemConfig** sheet — editable from the Super Admin
Dashboard's **Platform Settings** tab, no redeploying or file-editing needed. If a
page is offline or the request fails, it just keeps showing the static fallback text
already baked into the HTML, so nothing ever renders blank.

## Per-tenant spreadsheets — architecture

The spreadsheet you bind Code.gs to (below) is the **master/control spreadsheet**. It
holds the tenant registry and every platform-wide tab (Users, PaymentRequests, Messages,
SystemConfig, CapacityHistory) — it never holds any org's actual member/finance/event/etc.
records. Instead, **every organization gets its own dedicated Google Spreadsheet**,
created automatically the moment they sign up (`createTenantSpreadsheet()`, called from
`actionSignup`) and registered in the master's **OrgRegistry** tab (org name, admin
contact lives on the Users row as before, spreadsheet ID/URL, tier/plan info lives on
Users too, plus capacity stats — see below).

Nothing in Code.gs reads or writes an org's data via `getActiveSpreadsheet()` — every
function that touches org records (`actionGetData`, `actionPushData`, the capacity
checker) resolves the right spreadsheet dynamically through one central helper,
**`getOrgSpreadsheet(orgId)`**, which looks up the ID in OrgRegistry and opens it via
`SpreadsheetApp.openById()`. If you ever add a new function that needs an org's data,
route it through this same helper rather than assuming a bound/active spreadsheet.

**Already have an existing single-sheet install with real data in its `Data` tab?** Run
`migrateLegacyDataToPerTenantSpreadsheets()` once from the Apps Script editor. It groups
the legacy `Data` tab's rows by `orgId`, creates a new dedicated spreadsheet per org
(registering each in OrgRegistry), copies that org's rows across, and renames (not
deletes) the old `Data` tab to `Data_LEGACY_MIGRATED_<date>` so you can double-check it
before removing it yourself. It's safe to re-run — orgs that already have a registered
spreadsheet are skipped.

## Google Sheet — exact headers

Seven tabs on the **master spreadsheet**, created automatically the first time you run
`initializeSheets()` from the Apps Script editor (select it in the function dropdown,
click **Run**), or create them by hand with these exact headers. (The `Data` tab described
below lives on each **org's own spreadsheet** instead — see "Per-tenant spreadsheets" above.)

**Users**
```
id | orgId | orgName | fullName | username | phone | passwordHash | roles | isOwner | isSuperAdmin | status |
plan | billingCycle | subscriptionStatus | trialEndsAt | subscriptionStartedAt | subscriptionExpiry |
lastReminderSentAt | resetToken | resetTokenExpiry | createdAt | updatedAt
```
- `roles` — comma-separated, from the 8 fixed role options (see Code.gs `ROLE_OPTIONS`)
- `isOwner` — `true` for the account that ran signup (full Admin panel access);
  anyone later given the "Organization Super Admin" role also gets Admin access
- `isSuperAdmin` — `true` only for the one platform-owner row created by `createSuperAdminAccount()` (see Deployment below); this is a completely different thing from the `isOwner` flag or the "Organization Super Admin" role, which are both scoped to a single org
- `status` — `active` | `suspended` (Activate/Suspend, from the Team panel or, platform-wide, from the Super Admin Dashboard's Organizations tab)
- `subscriptionStatus` — `trialing` | `active` | `inactive`
- `trialEndsAt` — set automatically to 7 days after signup; checked at login while `subscriptionStatus` is `trialing`
- `subscriptionStartedAt` / `subscriptionExpiry` — set automatically once a payment is confirmed, by either method below; shown on the Subscription tab as the start date and countdown
- `lastReminderSentAt` — used by `sendExpiryReminders()` (see Deployment) to keep reminder emails to twice a month per org (see "Reminder emails" below), not one every time the trigger runs

**Data** (lives on each org's own dedicated spreadsheet, NOT the master — see above)
```
id | orgId | module | payload | createdBy | updatedAt | deleted
```
- `payload` — JSON string of the full record (all module fields)
- `createdBy` — the userId who owns the record; Users only ever see/sync their own, Admins see everything in their org

**OrgRegistry** (master spreadsheet — the tenant registry)
```
orgId | orgName | dataSpreadsheetId | dataSpreadsheetUrl | createdAt |
cellsUsed | cellsLimit | pctUsed | growthPerDay30 | growthPerDay90 |
estRemainingDays | estRemainingLabel | capacityStatus | capacityRecommendation |
lastCapacityCheckAt | lastCapacityAlertSentAt
```
- One row per organization, created automatically by `createTenantSpreadsheet()` at signup (or by the migration script for pre-existing orgs)
- `dataSpreadsheetId`/`dataSpreadsheetUrl` — what `getOrgSpreadsheet(orgId)` resolves; never hardcode or assume a spreadsheet elsewhere in the code
- The `cellsUsed` → `lastCapacityAlertSentAt` columns are written only by `checkAllTenantCapacities()` (see "Cell-capacity monitoring" below) — don't hand-edit them, they're overwritten on the next check anyway
- This is the ONLY place capacity data is surfaced — via the Super Admin Dashboard's **Storage & Capacity** view (`actionListTenantCapacity`, Super-Admin-gated). Org Admins and Users never see it.

**CapacityHistory** (master spreadsheet — append-only log, auto-pruned)
```
orgId | checkedAt | totalCells
```
- One row per org per daily/weekly capacity check — this is what `checkAllTenantCapacities()` uses to derive a 30-day and 90-day growth rate (cells added per day) for each org
- Auto-pruned to the last ~100 days by the same function, so this tab doesn't grow forever

**PaymentRequests**
```
id | orgId | requestedByUserId | orgName | contactEmail | contactPhone |
planRequested | billingCycle | paymentMethod | gatewayReference | status | reviewNote | submittedAt | reviewedAt
```
- Created either by an Admin submitting the bank-transfer form (`paymentMethod: 'manual'`, screenshot emailed to you, `gatewayReference` blank) or by starting a Paystack checkout (`paymentMethod: 'paystack'`, `gatewayReference` holds the Paystack transaction reference)
- `status` starts at `pending` (dropdown-restricted to `pending`/`confirmed`/`rejected`) — for manual requests, review by changing this cell directly **or** from the Super Admin Dashboard's **Payment Requests** tab (Approve/Reject); Paystack requests confirm themselves the moment payment succeeds, via `actionVerifyPaystackPayment` — no manual review needed for those
- All three paths (sheet edit, Super Admin dashboard, Paystack auto-verify) run through the same shared `applyPaymentDecision()` function, so behavior is identical no matter how a request gets reviewed. Setting `confirmed` upgrades every user in that org (new `plan`/`billingCycle`/`subscriptionStartedAt`/`subscriptionExpiry`) and emails the requester automatically; `rejected` emails them your `reviewNote` instead. Both only fire once per row (checks `reviewedAt` is still blank) so re-reviewing the same row never sends duplicate emails.

**Messages**
```
id | orgId | fromUserId | fromUsername | audience | recipientLabel | recipientEmail | recipientPhone |
channel | subject | body | deliveryStatus | sentAt
```
- A log of every message sent from an org's **Messages** tab or the Super Admin Dashboard's **Messages** tab — one row per recipient per channel
- `deliveryStatus` — `sent` (delivered through a real gateway — MailApp for email, or a configured SMS/WhatsApp provider), `manual-link` (SMS/WhatsApp with no gateway configured — see "Real SMS/WhatsApp sending" below), `failed`, or `skipped-no-contact-info`
- Platform-wide messages from the Super Admin use `orgId: 'PLATFORM'`

**SystemConfig**
```
key | value
```
Every setting the Super Admin Dashboard's Platform Settings tab can edit lives here as
one row per key — seeded automatically by `initializeSheets()` with sensible defaults.
You can edit any of it directly in this sheet too; the dashboard is just a friendlier
way to do the same thing. Full key list (see `CONFIG_DEFAULTS` in Code.gs):

| Group | Keys |
|---|---|
| Contact | `ownerEmail`, `ownerPhone`, `ownerWebsite` |
| Branding | `brandName`, `siteTagline`, `logoDataUrl` (a base64 data URL — set by uploading a file in the dashboard, not meant for hand-editing), `themePrimaryColor`, `themeAccentColor` |
| Email | `emailFromName`, `emailReplyTo` |
| SMS | `smsEnabled`, `smsProvider` (`termii` or `twilio`), `smsApiKey`, `smsSenderId` |
| WhatsApp | `whatsappEnabled`, `whatsappProvider`, `whatsappAccessToken`, `whatsappPhoneId` |
| Manual payment | `manualBankEnabled`, `bankAccountNumber`, `bankName`, `bankAccountName` |
| Paystack | `paystackEnabled`, `paystackPublicKey`, `paystackSecretKey`, `paystackCurrency` |
| Flutterwave | `flutterwaveEnabled`, `flutterwavePublicKey`, `flutterwaveSecretKey` |
| Remita | `remitaEnabled`, `remitaMerchantId`, `remitaApiKey`, `remitaServiceTypeId` |
| Pricing | `price_<planId>` and `planActive_<planId>` for each of the 6 plan/cycle combinations |

`actionGetPlatformConfig` (used by every public page) only ever returns the keys listed
in `PUBLIC_CONFIG_KEYS` — every secret key/API token is deliberately left out of that
list and only readable by an authenticated Super Admin via `actionGetPlatformConfigFull`.

## Deployment

1. Create a new Google Sheet, open **Extensions → Apps Script**, paste in `apps-script/Code.gs`.
2. Set `APP_BASE_URL` at the top of Code.gs to wherever you'll host the HTML files (used to build the password-reset link, the welcome email, and the Paystack checkout's `callback_url`). The `DEFAULT_*` constants below it are just the starting values seeded into SystemConfig on first run — change actual values later from the Super Admin Dashboard, not by re-editing this file.
3. Run `initializeSheets()` once (function dropdown → select it → Run) — creates the master spreadsheet's seven tabs with headers, a status dropdown on PaymentRequests, and default SystemConfig values. (It does **not** create a `Data` tab here — each org gets its own spreadsheet automatically at signup; see "Per-tenant spreadsheets" above.)
4. Run `createSuperAdminAccount()` once — creates your platform-owner login (default: `technologyokv@gmail.com` / `OKVOMS557`, from `SUPER_ADMIN_USERNAME`/`SUPER_ADMIN_DEFAULT_PASSWORD` at the top of Code.gs). **Change this password immediately after your first login** — My Account works the same way on the Super Admin Dashboard as it does for org Admins.
5. **Migrating an existing single-sheet install?** Run `migrateLegacyDataToPerTenantSpreadsheets()` once now, before deploying — see "Per-tenant spreadsheets" above. Skip this on a brand-new install.
6. **Set up three triggers:** click the clock icon (Triggers) in the left sidebar → **Add Trigger**, three times:
   - function `onPaymentStatusEdit` → event source **From spreadsheet** → event type **On edit** — without this, editing a PaymentRequests status cell by hand won't send the email/upgrade (reviewing from the Super Admin Dashboard, or a Paystack payment, don't need this trigger — they call the shared logic directly).
   - function `sendExpiryReminders` → event source **Time-driven** → type **Day timer** (pick any hour) — the function itself only actually sends once every 15 days per org (see "Reminder emails" below), so this trigger just needs to run at least daily to catch that window; without it, only the in-app dashboard countdown/warning icon still works, not the email side.
   - function `checkAllTenantCapacities` → event source **Time-driven** → type **Day timer** (any hour, e.g. overnight) — measures every org's spreadsheet cell usage, logs a snapshot, and refreshes the Super Admin Dashboard's Storage & Capacity numbers; without it that view just stays empty/stale. Weekly also works if you'd rather check less often — a **Week timer** trigger is fine too, it just means less granular growth-rate data.
7. **Deploy → New deployment → Web app.** Execute as **Me**, access **Anyone**. Copy the `/exec` URL.
8. Paste that URL into `API_URL` at the top of `shared.js`.
9. Host all the files (any static host works — GitHub Pages, Netlify, your own server). They must all sit in the same folder/origin as written (relative links).
10. **(Optional) Enable Paystack:** create a Paystack account, grab your test (or live) Public/Secret keys, and enter them in the Super Admin Dashboard → Platform Settings → Payment Gateways → Paystack, then flip Enable on. No further Paystack-side configuration needed — the callback URL is sent per-transaction, not pre-registered in their dashboard.
11. **(Optional) Enable real SMS/WhatsApp sending:** same tab, "Email / SMS / WhatsApp" — enter your Termii or Twilio API key for SMS, or your WhatsApp Cloud API access token + phone number ID for WhatsApp, and flip each Enable switch on. Leave a channel disabled and the Messages tab falls back to tap-to-send links instead (see below).
12. Open `index.html` in a browser to confirm the marketing page loads, then run through the testing walkthrough below.

### Cell-capacity monitoring — how the numbers get made
`checkAllTenantCapacities()` (the trigger from step 6) is the only thing that scans
spreadsheets for usage — it never runs on a page load. For each org it sums
`getLastRow() × getLastColumn()` across every tab in that org's spreadsheet (their actual
used range, not the full default grid), logs that total to CapacityHistory, then looks
back over the last 30 (falling back to 90) days of logged snapshots to derive a cells-
per-day growth rate. From there it computes how many days remain until usage would hit
90% of the 10,000,000-cell cap at that pace, and writes `pctUsed`, `estRemainingLabel`,
and a `capacityStatus` (`Healthy` below 70%, `Monitor` from 70%, `Action Needed` from
85%) back to that org's OrgRegistry row, along with a plain-language recommendation
(archive older records into a separate archive spreadsheet, or split the tenant's data
further). The Super Admin Dashboard's **Storage & Capacity** view just reads those stored
values — org Admins and Users never see any of this. Whenever an org is newly flagged (or
remains) `Action Needed`, `checkAllTenantCapacities()` also emails the Super Admin
(`ownerEmail` from SystemConfig) directly, throttled to at most once every 7 days per org
so it doesn't turn into daily noise.

### Reminder emails — twice a month, not constant
`sendExpiryReminders()` only emails an org's Admin once every 15 days (`REMINDER_INTERVAL_DAYS`), tracked per-org via `lastReminderSentAt` — regardless of how often the trigger itself runs. Each reminder includes a plain-language suggestion tailored to their current plan (`suggestNextTier()`): Starter accounts get told what Growth adds, Growth-Monthly/Bi-Annual accounts get told what switching to a longer cycle saves, and Growth-Yearly accounts just get a thank-you. The in-app dashboard countdown/warning icon is unrelated to this cadence — that's still computed live every page load from `trialEndsAt`/`subscriptionExpiry`, so it's always accurate even between reminder emails.

### Real SMS/WhatsApp sending (once configured) — and what's still not wired
- **Paystack is a real, working checkout** — org Admins can pay by card/bank on Paystack's hosted page from the Subscription tab's "Pay Online Now" panel (only shown once Paystack is enabled), and `actionVerifyPaystackPayment` (called from `payment-callback.html` when Paystack redirects back) upgrades them automatically the moment payment succeeds — no manual review.
- **Flutterwave and Remita** have full credential storage and an enable/disable toggle in the Super Admin Dashboard, but no live checkout flow yet — only Paystack does. Their config exists so the keys are ready whenever that gets built; `actionInitPaystackPayment`/`actionVerifyPaystackPayment` are the pattern to follow for wiring up either of them the same way.
- **SMS** sends for real once `smsEnabled` is on and an API key is set (Termii or Twilio — see `trySendSms()`); same for **WhatsApp** via the Cloud API (`trySendWhatsApp()`). With no gateway configured, `sendMessage`/`sendPlatformMessage` fall back to generating `sms:` / `https://wa.me/` tap-to-send links per recipient instead, rendered in the Messages tab — the send then happens from the sender's own phone/browser rather than the server.
- Manual bank transfer and its screenshot-upload flow work exactly as before, and can be turned off entirely (`manualBankEnabled`) if you'd rather only offer Paystack.

## Testing walkthrough

1. **Marketing page** — open `index.html`. Click each nav link (About, How It Works, Features, Why Us, FAQ) and confirm it smooth-scrolls to the right section. Click the FAQ questions to confirm they expand/collapse. Confirm the footer shows the contact details.
2. **Live demo** — click "View Live Demo". Confirm the dashboard loads with sample data (Riverside Community Foundation), you can click through every nav tab including Messages and User Manual, but clicking Add/Edit/Delete/Import/Settings-save/Send Message shows a "sign up to make real changes" toast instead of actually doing anything. Wait ~20 seconds and confirm the "Get Started Now" popup appears; click it and confirm it goes to `pricing.html`.
3. **Pricing → Signup** — on `pricing.html`, switch between Monthly/Bi-Annual/Yearly and confirm prices update. Click "Start for Free" on any card and confirm `signup.html` shows the right plan name and billing cycle at the top.
4. **Signup → Install → Login** — fill out the signup form (Org Name, Full Name, Email, Phone, Password) and submit. Confirm you land on `install.html` with your org name shown, and that you received a welcome email. Complete the install steps (or the manual-confirm fallback), confirm you land on `login.html`, then log in with the email/password you just created — confirm you reach `app.html`.
5. **Trial countdown** — on the dashboard, confirm the gold trial banner shows "Free trial active" with days remaining, and the same info appears under the **Subscription** tab (including Start Date). Confirm the topbar warning icon is hidden (trial just started, more than 3 days left).
6. **Reminder email cadence** — in the Sheet, clear that user's `lastReminderSentAt`, then run `sendExpiryReminders()` once manually from the Apps Script editor. Confirm a reminder email arrives with a next-tier suggestion matching their plan. Run it again immediately afterward and confirm no second email goes out (it's within the 15-day window now).
7. **Expired trial blocks login** — set `trialEndsAt` to a past date, then try logging in again (or reload the app while a session is cached). Confirm login is refused with a "trial has ended — choose a plan" message and a link to `pricing.html`, and that an already-open session gets logged out on its next sync attempt.
8. **Manual payment request → review → upgrade** — on the Subscription tab, fill out the bank-transfer form (fields should already show your org name/email/phone, editable), pick a plan, attach any image as the "screenshot," and submit. Confirm the SystemConfig `ownerEmail` address receives an email with the details and the image attached, and a new row appears in PaymentRequests with `paymentMethod: manual`, `status: pending`. Try both review paths: (a) change the sheet cell to `confirmed` directly, and (b) log in as Super Admin and click Approve on a different pending request from the Payment Requests tab. Confirm both send the requester a confirmation email, fill in `reviewedAt`, and update that org's plan/start date/countdown on reload. Try a `rejected` case too and confirm a rejection email goes out using `reviewNote` if you filled one in, and nothing on the account changes.
9. **Paystack checkout (needs test API keys)** — as Super Admin, enable Paystack with your test keys under Platform Settings → Payment Gateways. Log back in as an org Admin, confirm the "Pay Online Now" panel now appears on the Subscription tab, pick a plan, and click Pay — confirm you land on Paystack's hosted page. Complete a test payment, confirm Paystack redirects you to `payment-callback.html`, and that it shows a success state and your org is upgraded immediately (check the Subscription tab/PaymentRequests row: `paymentMethod: paystack`, `status: confirmed`, no manual review needed).
10. **Messages** — on an org's Messages tab, send a message to "Members" (select one or more, Email channel) and confirm the email arrives. Try "My Team" and "Myself" too. With SMS/WhatsApp left unconfigured, confirm tap-to-send links appear after sending instead of an actual text/WhatsApp message; if you've configured a real SMS/WhatsApp provider, confirm it actually sends instead. Check the Messages sheet for a logged row per recipient/channel.
11. **User Manual** — open the User Manual tab as an Admin and confirm both "User Guide" and "Admin Guide" appear (plus "Growth Plan Guide" if that org's `plan` contains "Growth"); log in as a non-admin teammate and confirm only "User Guide" shows. Download one and confirm it's a readable Markdown file.
12. **Super Admin login & Organizations** — log in at `login.html` with `technologyokv@gmail.com` / `OKVOMS557` (or whatever you've since changed it to) and confirm you land on `super-admin.html`, not `app.html`. On the Organizations tab, confirm every org you've created shows up with its Admin's name/email/phone/plan/status. Edit one org's details and confirm the change reflects both in the Sheet and next time that org's Admin loads their Subscription tab. Try Suspend on an org, then confirm that org's Admin can no longer log in; Activate to restore it.
13. **Super Admin branding & plans** — on Platform Settings → Branding, change the primary/accent color and upload a small logo image, save, then reload `index.html` and an org's `app.html` (with internet on) and confirm the new colors and logo appear — that's `applyLivePlatformSettings()`'s color/logo logic in `shared.js`. On Plans & Pricing, change a price or disable a plan, save, then reload `pricing.html` and confirm it reflects immediately.
14. **Super Admin messaging & contact settings** — from the Super Admin Dashboard's Messages tab, send a platform-wide (or selected-orgs) message and confirm delivery the same way as step 10. On Platform Settings → Contact, change `ownerEmail`, save, then reload `index.html`, `pricing.html`, and an org's Subscription tab and confirm the new value appears everywhere within a page reload.
15. **Two isolated orgs** — repeat signup with a different email/org name; confirm the two organizations' data, team, and Sheet rows never overlap (same checks as the earlier Phase 2 walkthrough: roles, Team & Roles, Install Link, offline+sync, forgot-password, admin password reset — all still apply exactly as before, just now reached through the new funnel).
