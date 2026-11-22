"use strict";
/* 합방 타임스탬프 메모 — the live memo and replay lookup screens of the desktop STT Timeline,
 * running inside the extension. api() is answered in the page by lib/backend.js. */

const $ = (id) => document.getElementById(id);
const TAB_KEY = "chzzk-memo-tab";
const BACKEND = Backend.create();

// The replay screen checks for this; there is no server session to expire here.
class SessionError extends Error {}

function api(path, opts = {}) {
  return BACKEND.call(path, opts);
}

function hms(sec) {
  if (sec == null || !isFinite(sec)) return "-";
  sec = Math.max(0, Math.round(sec));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

