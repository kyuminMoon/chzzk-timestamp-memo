/* CHZZK (치지직) public API: the few lookups the memo screens need.
 * Port of stt_timeline/chzzk.py. Extension pages send no Origin header on these GET requests
 * (host permission), which the API requires; a page on another site would be refused. */
"use strict";

const Chzzk = (() => {
  const API = "https://api.chzzk.naver.com/service";
  // Measured on several replays: a chat sent at wall-clock W shows up at replay position
  // W - liveOpenDate - 4 s, i.e. replay position P was on air (for viewers) at liveOpen + P + 4 s.
  const REPLAY_LAG_MS = 4000;
  const KST_OFFSET_MS = 9 * 3600 * 1000;

  class ChzzkError extends Error {
    constructor(message, status = null) {
      super(message);
      this.name = "ChzzkError";
      this.status = status;
    }
  }

  // API strings can hold half of a surrogate pair (text cut by UTF-16 length upstream).
  function cleanStr(value) {
    if (typeof value !== "string") return value == null ? "" : String(value);
    return typeof value.toWellFormed === "function" ? value.toWellFormed() : value;
  }

  function vodUrl(vodId) {
    return `https://chzzk.naver.com/video/${vodId}`;
  }

  // https://chzzk.naver.com/video/123, m.chzzk..., with query strings, or the bare number.
  function parseVodId(text) {
    text = String(text || "").trim();
    if (/^\d{3,12}$/.test(text)) return text;
    const m = /^(?:https?:\/\/)?(?:m\.)?chzzk\.naver\.com\/(?:[^/?#]+\/)?video\/(\d{3,12})(?:[/?#].*)?$/.exec(text);
    if (!m) throw new ChzzkError("치지직 다시보기 링크 형식이 아닙니다. 예: https://chzzk.naver.com/video/12345678");
    return m[1];
  }

  async function getJson(url, timeoutMs = 15000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { credentials: "omit", cache: "no-store", signal: ctl.signal,
        headers: { Accept: "application/json" } });
      let body = null;
      try { body = await res.json(); } catch (_) { /* HTML error page */ }
      return [res.status, body];
    } finally {
      clearTimeout(timer);
    }
  }

  function apiMessage(status, body) {
    const msg = body && typeof body === "object" ? body.message : null;
    if (status === 401 || status === 403) {
      return `치지직이 접근을 거부했습니다 (HTTP ${status}). 성인 인증이 필요한 다시보기이거나 비공개 영상일 수 있습니다.`;
    }
    if (status === 404) return "다시보기를 찾을 수 없습니다. 링크를 확인하세요.";
    return `치지직 API 오류 (HTTP ${status}${msg ? ", " + msg : ""})`;
  }

  const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** GET an API url and return its `content`. Retries network errors, 429 and 5xx with backoff. */
  async function requestContent(url, { get = getJson, sleep = realSleep, retries = 6, timeoutMs = 15000 } = {}) {
    let delay = 1000;
    let last = "";
    for (let attempt = 0; attempt < retries; attempt++) {
      let status, body;
      try {
        [status, body] = await get(url, timeoutMs);
      } catch (e) {
        last = `네트워크 오류: ${e && e.name === "AbortError" ? "응답 시간 초과" : (e && e.message) || e}`;
        status = null;
      }
      if (status != null) {
        if (status === 200 && body && typeof body === "object" && body.code === 200) return body.content || {};
        if (status === 429 || status >= 500) last = `HTTP ${status}`;
        else throw new ChzzkError(apiMessage(status, body), status);
      }
      if (attempt < retries - 1) {
        await sleep(delay);
        delay = Math.min(delay * 2, 30000);
      }
    }
    throw new ChzzkError(`치지직 서버에 연결하지 못했습니다 (${last}). 잠시 후 다시 시도하세요.`);
  }

  /** '2026-11-11 19:35:32' (KST) -> epoch ms, or null. */
  function liveOpenEpochMs(text) {
    const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})\s*$/.exec(typeof text === "string" ? text : "");
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
    const utc = Date.UTC(y, mo - 1, d, h, mi, s);
    const back = new Date(utc);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
        || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) return null;
    return utc - KST_OFFSET_MS;
  }

  /** Wall-clock epoch ms of replay position 0 (add position ms to get the broadcast time). */
  function clockBaseMs(liveOpen) {
    const base = liveOpenEpochMs(liveOpen);
    return base != null ? base + REPLAY_LAG_MS : null;
  }

  async function fetchVideoInfo(vodId, opts = {}) {
    const content = await requestContent(`${API}/v2/videos/${vodId}`, opts);
    if (!content || !content.videoNo) throw new ChzzkError("다시보기 정보를 가져오지 못했습니다. 링크를 확인하세요.");
    const channel = content.channel || {};
    const duration = Number(content.duration || 0);
    return {
      vod_id: String(content.videoNo),
      url: vodUrl(String(content.videoNo)),
      title: cleanStr(content.videoTitle),
      channel: cleanStr(channel.channelName),
      channel_id: cleanStr(channel.channelId),
      duration: Number.isFinite(duration) ? Math.trunc(duration) : 0,
      live_open_date: content.liveOpenDate == null ? null : content.liveOpenDate,
    };
  }

  return {
    API, REPLAY_LAG_MS, KST_OFFSET_MS, ChzzkError, cleanStr, vodUrl, parseVodId, getJson,
    requestContent, liveOpenEpochMs, clockBaseMs, fetchVideoInfo,
  };
})();

if (typeof module !== "undefined") module.exports = Chzzk;
