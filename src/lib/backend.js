/* In-page replacement for the desktop app's local server: the screens keep calling api("/api/...")
 * and get the same answers, computed here and kept in chrome.storage.local. */
"use strict";

const Backend = (() => {
  const BACKUP_FORMAT = "chzzk-memo-backup/1";

  class ApiError extends Error {
    constructor(message, status = 400, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  // ---- storage and locking (several extension tabs may be open at once)

  const chromeStorage = {
    get: async (key) => (await chrome.storage.local.get(key))[key],
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
    all: () => chrome.storage.local.get(null),
  };

  function makeLock() {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return (name, fn) => navigator.locks.request(`chzzk-memo:${name}`, fn);  // shared by every tab of the extension
    }
    const tails = new Map();
    return (name, fn) => {
      const run = (tails.get(name) || Promise.resolve()).then(fn, fn);
      tails.set(name, run.catch(() => {}));
      return run;
    };
  }

  function create(deps = {}) {
    const d = {
      storage: deps.storage || chromeStorage,
      lock: deps.lock || makeLock(),
      now: deps.now || (() => Date.now()),
      get: deps.get,
      sleep: deps.sleep,
    };
    const live = LiveStore.create(d);
    const vod = VodStore.create(d);

    const body = (b) => (b && typeof b === "object" ? b : {});
    const routes = {
      "GET /api/live": (_, q) => live.snapshot(q.get("refresh") === "1" || q.get("refresh") === "true"),
      "POST /api/live/channels": (b) => live.addChannel(String(b.url || "")),
      "POST /api/live/channels/remove": (b) => live.removeChannel(String(b.id || "")),
      "POST /api/live/channels/select": (b) => live.setSelected(String(b.id || ""), !!b.selected),
      "POST /api/live/memos": (b) => live.addMemo(b.at_ms, b.text || "", Array.isArray(b.channels) ? b.channels : []),
      "POST /api/live/memos/delete": (b) => live.deleteMemos({ id: b.id || null, group: b.group || null }),
      "POST /api/live/memos/edit": (b) => {
        if (b.pos != null && (!Number.isSafeInteger(b.pos) || b.pos < 0)) throw new ApiError("방송 위치는 00:00:00 ~ 99:59:59 사이로 쓰세요.");
        return live.editMemo({ id: b.id || null, group: b.group || null, text: b.text == null ? null : b.text,
          pos: b.pos == null ? null : b.pos, shift: b.shift == null ? null : b.shift,
          base: b.base == null ? null : String(b.base) });
      },
      "POST /api/live/memos/rejoin": (b) => live.rejoinMemo(String(b.id || "")),
      "GET /api/vod-memos": () => vod.snapshot(),
      "POST /api/vod-memos/videos": (b) => vod.addVideos(b),
      "POST /api/vod-memos/videos/update": (b) => vod.updateVideo(b),
      "POST /api/vod-memos/videos/remove": (b) => vod.removeVideo(b),
      "POST /api/vod-memos/refresh": (b) => vod.refresh(b),
      "POST /api/vod-memos/find": (b) => vod.find(b),
      "POST /api/vod-memos/memos": (b) => vod.addMemos(b),
      "POST /api/vod-memos/memos/delete": (b) => vod.deleteMemos(b),
    };

    /** Same contract as the desktop page's fetch helper: resolves with the JSON answer, or throws an
     *  Error with .status (and .code for the replay screen). */
    async function call(path, { method = "GET", body: payload } = {}) {
      const url = new URL(path, "https://local.invalid");
      const route = routes[`${method} ${url.pathname}`];
      if (!route) throw new ApiError(`알 수 없는 요청입니다: ${method} ${url.pathname}`, 404);
      try {
        // a deep copy, like a request body sent over the network: the store never holds the page's objects
        const result = await route(structuredClone(body(payload)), url.searchParams);
        return structuredClone(result);
      } catch (e) {
        if (e instanceof LiveStore.LiveMemoError) throw new ApiError(e.message, 400);
        if (e instanceof VodStore.VodMemoError) throw new ApiError(e.message, e.status, e.code);
        if (e instanceof ApiError) throw e;
        throw new ApiError(`${(e && e.name) || "Error"}: ${(e && e.message) || e}`, 500);
      }
    }

    // ---- backup and import

    async function exportAll() {
      const all = await d.storage.all();
      const extras = {};
      for (const [k, v] of Object.entries(all)) if (k !== LiveStore.KEY && k !== VodStore.KEY) extras[k] = v;
      return {
        format: BACKUP_FORMAT,
        exported_at: new Date(d.now()).toISOString(),
        live: all[LiveStore.KEY] || null,
        vod: all[VodStore.KEY] || null,
        ...(Object.keys(extras).length ? { extras } : {}),
      };
    }

    /** Accepts this extension's backup, or the desktop app's live_memos.json / vod_memos.json.
     *  Adds what is missing; never overwrites or deletes. */
    async function importData(data) {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("JSON 객체가 아닙니다.");
      const out = { live: null, vod: null };
      let liveSrc = null, vodSrc = null;
      if (data.format === BACKUP_FORMAT) {
        liveSrc = data.live;
        vodSrc = data.vod;
      } else if (data.format === LiveStore.FORMAT || (Array.isArray(data.channels) && Array.isArray(data.memos))) {
        liveSrc = data;
      } else if (data.format === VodStore.FORMAT) {
        vodSrc = data;
      } else {
        throw new ApiError("알 수 없는 파일입니다. 이 확장 프로그램의 백업 파일이나 데스크톱 앱의 live_memos.json, vod_memos.json을 고르세요.");
      }
      try {
        if (liveSrc) out.live = await live.merge(liveSrc);
        if (vodSrc) out.vod = await vod.merge(vodSrc);
      } catch (e) {
        if (e instanceof LiveStore.LiveMemoError || e instanceof VodStore.VodMemoError) throw new ApiError(e.message);
        throw e;
      }
      return out;
    }

    return { call, exportAll, importData };
  }

  return { create, ApiError, BACKUP_FORMAT };
})();

if (typeof module !== "undefined") module.exports = Backend;
