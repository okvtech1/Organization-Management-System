/* =====================================================================================
   OKV OMS — shared client helpers (loaded by every page)
===================================================================================== */

// >>> Paste your deployed Apps Script Web App URL here (ends in /exec) <<<
const API_URL = 'https://script.google.com/macros/s/AKfycbxWb56RBtQ_BaTKeZUU2e_9GOhJDUEY4-d1D2-oQWps7mSdreuFIVSO4wNLgeveBLU/exec';

/** SHA-256 hash → lowercase hex, using the browser's built-in Web Crypto API (no library needed). */
async function sha256Hex(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * POSTs to the Apps Script backend. Uses text/plain as the content type on purpose —
 * that keeps the browser from sending a CORS preflight (OPTIONS) request, which Apps
 * Script Web Apps can't answer. The server (Code.gs) reads and JSON.parses the raw body.
 */
async function apiCall(action, payload){
  if(!navigator.onLine){
    throw new Error('OFFLINE');
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...payload })
  });
  if(!res.ok) throw new Error('Network error (' + res.status + ')');
  return res.json();
}

// ---------------------------------------------------------------- SESSION (localStorage)
// Lightweight session: after login we cache the user's profile + password hash locally
// so the app can (a) work offline without re-authenticating every request, and
// (b) attach {orgId, requesterId, requesterPasswordHash} to authenticated API calls.
// This is intentionally simple for Phase 2 testing — Phase 3 should replace the raw
// cached hash with a real expiring session token issued by the server.
const SESSION_KEY = 'okv_oms_session';

function getSession(){
  try{ return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch(e){ return null; }
}
function setSession(session){
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function clearSession(){
  localStorage.removeItem(SESSION_KEY);
}
/** Common fields every authenticated API call needs. */
function authFields(session){
  return { orgId: session.orgId, requesterId: session.userId, requesterPasswordHash: session.passwordHash };
}

function formatRelativeTime(iso){
  if(!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if(hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days===1?'':'s'} ago`;
}

/** Reads a File (e.g. from an <input type="file">) into {base64, mimeType, filename}. */
function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result; // "data:<mime>;base64,<data>"
      const base64 = result.split(',')[1];
      resolve({ base64, mimeType: file.type || 'application/octet-stream', filename: file.name });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Formats a remaining duration in the most readable unit — days close in, weeks/months further out. */
function formatRemainingDuration(days){
  if(days <= 0) return 'Expired';
  if(days <= 13) return `${days} day${days===1?'':'s'} remaining`;
  if(days <= 60){
    const weeks = Math.round(days / 7);
    return `${weeks} week${weeks===1?'':'s'} remaining`;
  }
  const months = Math.round(days / 30);
  return `${months} month${months===1?'':'s'} remaining`;
}

/**
 * Fetches the Super Admin's live contact/bank/branding details (getPlatformConfig —
 * no auth needed, it's just display info) and applies them:
 *  - data-live-setting="<key>" elements get their textContent filled in
 *  - data-live-href="<key>" elements get their href filled in (mailto:/tel:/https:)
 *  - the color palette (--teal-950/900/800/700, --gold-500/600) is re-derived from
 *    themePrimaryColor/themeAccentColor if the Super Admin has changed them
 *  - every .brand-mark / .nav-mark element gets swapped for an uploaded logo image,
 *    if one has been set
 * Falls back to whatever's already in the HTML if offline or the request fails, so
 * pages never show a blank space or an unstyled flash. Call this on page load.
 */
async function applyLivePlatformSettings(){
  if(!navigator.onLine) return;
  try{
    const cfg = await apiCall('getPlatformConfig', {});
    if(!cfg || !cfg.success) return;

    document.querySelectorAll('[data-live-setting]').forEach(el => {
      const key = el.getAttribute('data-live-setting');
      if(cfg[key] !== undefined) el.textContent = cfg[key];
    });
    document.querySelectorAll('[data-live-href]').forEach(el => {
      const key = el.getAttribute('data-live-href');
      if(cfg[key] === undefined) return;
      const prefix = el.getAttribute('data-live-href-prefix') || '';
      el.setAttribute('href', prefix + cfg[key]);
    });

    if(cfg.themePrimaryColor) applyColorPalette('--teal', cfg.themePrimaryColor, [['950',0], ['900',8], ['800',18], ['700',30]]);
    if(cfg.themeAccentColor) applyColorPalette('--gold', cfg.themeAccentColor, [['500',0], ['600',-12]]);

    if(cfg.logoDataUrl){
      document.querySelectorAll('.brand-mark, .nav-mark').forEach(el => {
        el.innerHTML = `<img src="${cfg.logoDataUrl}" alt="Logo" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
      });
    }
  }catch(e){ /* best-effort — keep the static fallback already in the HTML */ }
}

/**
 * Wires a show/hide "eye" toggle onto every <input type="password"> already present in
 * the page. Runs on DOMContentLoaded so it doesn't matter whether shared.js is loaded in
 * <head> (before the password fields exist in the DOM, e.g. app.html) or near the bottom
 * of <body> (e.g. login.html) — by DOMContentLoaded the whole document, including
 * fields inside not-yet-opened Bootstrap modals, has been parsed either way.
 * Idempotent: safe to call more than once, skips inputs already wired.
 */
function wirePasswordToggles(){
  if(!document.getElementById('pwToggleStyle')){
    const style = document.createElement('style');
    style.id = 'pwToggleStyle';
    style.textContent = `
      .pw-toggle-wrap{position:relative;}
      .pw-toggle-wrap input[type="password"], .pw-toggle-wrap input[type="text"].pw-revealed{padding-right:40px;}
      .pw-toggle-btn{position:absolute; top:0; right:0; height:100%; width:40px; border:none; background:transparent;
        display:flex; align-items:center; justify-content:center; color:#8a978f; cursor:pointer; padding:0;}
      .pw-toggle-btn:hover{color:#3b4a44;}
      .pw-toggle-btn:focus{outline:none;}
    `;
    document.head.appendChild(style);
  }

  document.querySelectorAll('input[type="password"]').forEach(input => {
    if(input.closest('.pw-toggle-wrap')) return; // already wired

    const wrap = document.createElement('div');
    wrap.className = 'pw-toggle-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle-btn';
    btn.tabIndex = -1; // keep tab order on the password field itself, not the icon
    btn.setAttribute('aria-label', 'Show password');
    btn.innerHTML = '<i class="bi bi-eye"></i>';
    btn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      input.classList.toggle('pw-revealed', !showing);
      btn.innerHTML = showing ? '<i class="bi bi-eye"></i>' : '<i class="bi bi-eye-slash"></i>';
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
    wrap.appendChild(btn);
  });
}
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', wirePasswordToggles);
}else{
  wirePasswordToggles(); // DOM already parsed by the time shared.js ran
}

/** Sets --{prefix}-{suffix} custom properties, lightened/darkened from a base hex color. */
function applyColorPalette(prefix, baseHex, shades){
  shades.forEach(([suffix, lightenPercent]) => {
    document.documentElement.style.setProperty(`${prefix}-${suffix}`, adjustHexLightness(baseHex, lightenPercent));
  });
}

/** Lightens (positive) or darkens (negative) a #rrggbb color by roughly the given percent. */
function adjustHexLightness(hex, percent){
  hex = String(hex || '').replace('#', '');
  if(hex.length !== 6) return '#' + hex;
  const num = parseInt(hex, 16);
  let r = (num >> 16) & 0xff, g = (num >> 8) & 0xff, b = num & 0xff;
  const amt = Math.round(2.55 * percent);
  r = Math.max(0, Math.min(255, r + amt));
  g = Math.max(0, Math.min(255, g + amt));
  b = Math.max(0, Math.min(255, b + amt));
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}
