/* KST wall-clock lookup and durable memos for explicitly registered CHZZK replays.
 * Port of stt_timeline/vodmemo.py; stored in the same shape as the desktop app's vod_memos.json. */
"use strict";

const VodStore = (() => {
  const Z = typeof Chzzk !== "undefined" ? Chzzk : require("./chzzk.js");
  const FORMAT = "stt-vod-memos/1";
  const KEY = "vod";
  const FORMULA_VERSION = 1;
  const MAX_VIDEOS = 50;
  const MAX_BATCH = 10;
  const MAX_TEXT = 500;
  const MAX_OFFSET_MS = 86400000;
  const STALE_MS = 86400000;
  const MIN_AT_MS = Date.UTC(2000, 0, 1) - Z.KST_OFFSET_MS;
  const MAX_AT_MS = Date.UTC(2100, 0, 1) - Z.KST_OFFSET_MS - 1;
  const WALL_RE = /^([0-9]{2}|[0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const FETCH_WORKERS = 4;
  const PLACE = "이 브라우저 (확장 프로그램 저장소)";

  class VodMemoError extends Error {
    constructor(code, message, status = 400) {
      super(message);
      this.name = "VodMemoError";
      this.code = code;
      this.status = status;
    }
  }
  const fail = (code, message, status) => new VodMemoError(code, message, status);
  const isInt = (v) => Number.isSafeInteger(v);
  const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);
  const newId = () => crypto.randomUUID();

  function checkInt(value, code = "INVALID_REQUEST", min = null, max = null) {
    if (!isInt(value) || (min != null && value < min) || (max != null && value > max)) {
      throw fail(code, "정수 값과 허용 범위를 확인하세요.");
    }
    return value;
  }

  /** "26-11-11 21:11:11" or "2026-11-11 21:11:11" (KST) -> [epoch ms, "2026-11-11 21:11:11"]. */
  function parseWallTime(text) {
    const m = typeof text === "string" ? WALL_RE.exec(text.trim()) : null;
    const bad = () => fail("INVALID_WALL_TIME", "한국 시간으로 입력하세요. 예: 26-11-11 21:11:11 (2000~2099년)");
    if (!m) throw bad();
    const parts = m.slice(1).map(Number);
    if (m[1].length === 2) parts[0] += 2000;
    if (parts[0] < 2000 || parts[0] > 2099) throw bad();
    const p = (n) => String(n).padStart(2, "0");
    const normalized = `${parts[0]}-${p(parts[1])}-${p(parts[2])} ${p(parts[3])}:${p(parts[4])}:${p(parts[5])}`;
    const ms = Z.liveOpenEpochMs(normalized);
    if (ms == null) throw bad();
    return [ms, normalized];
  }

  function normalizeMetadata(info) {
    const duration = info.duration;
    let opened = info.live_open_date;
    if (Z.liveOpenEpochMs(opened) == null) opened = null;
    return {
      url: Z.vodUrl(String(info.vod_id || "")),
      title: Z.cleanStr(info.title),
      channel: Z.cleanStr(info.channel),
      channel_id: Z.cleanStr(info.channel_id),
      live_open_date: opened,
      duration_ms: isInt(duration) && duration > 0 ? duration * 1000 : null,
    };
  }

  function hmsMs(ms) {
    const sec = Math.floor(ms / 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
  }

  function isStale(video, nowMs) {
    const success = video.last_success_ms;
    return success == null || nowMs - success > STALE_MS || !!video.last_error;
  }

  function matchVideo(video, atMs, nowMs) {
    checkInt(atMs, "INVALID_REQUEST", MIN_AT_MS, MAX_AT_MS);
    const metadata = video.metadata || {};
    const base = Z.clockBaseMs(metadata.live_open_date);
    const duration = metadata.duration_ms;
    const offset = video.manual_offset_ms || 0;
    const result = {
      vod_id: video.vod_id, registration_id: video.registration_id,
      match_revision: video.match_revision, status: "match",
      position_ms: null, position_s: null, position_text: null,
      base_ms: base, manual_offset_ms: offset,
      calibration: offset ? "manual" : "default", stale: isStale(video, nowMs),
      url: metadata.url || Z.vodUrl(video.vod_id),
      title: metadata.title || video.vod_id, channel: metadata.channel || "",
      last_error: video.last_error == null ? null : video.last_error,
    };
    const state = video.metadata_state;
    if (state === "unavailable" || state === "fetch_error") result.status = state;
    else if (base == null) result.status = "missing_start";
    else if (!isInt(duration) || duration <= 0) result.status = "missing_duration";
    else {
      const position = atMs - base - offset;
      if (position < 0) result.status = "before";
      else if (position >= duration) result.status = "after";
      else Object.assign(result, { position_ms: position, position_s: Math.floor(position / 1000), position_text: hmsMs(position) });
    }
    return result;
  }

  const signature = (video) => {
    const meta = video.metadata || {};
    return JSON.stringify([meta.live_open_date, meta.duration_ms, video.manual_offset_ms, video.metadata_state]);
  };

  function valid(data) {
    if (!data || typeof data !== "object" || data.format !== FORMAT || !isUuid(data.store_id) || !isInt(data.revision) || data.revision < 0) return false;
    if (!["videos", "memos", "receipts"].every((k) => Array.isArray(data[k]))) return false;
    if (data.videos.length > MAX_VIDEOS) return false;
    const ids = new Set();
    for (const v of data.videos) {
      if (!v || typeof v !== "object" || !/^[0-9]{3,12}$/.test(String(v.vod_id || ""))) return false;
      if (typeof v.vod_id !== "string" || ids.has(v.vod_id) || !isUuid(v.registration_id)) return false;
      ids.add(v.vod_id);
      if (typeof v.selected !== "boolean" || !isInt(v.manual_offset_ms) || Math.abs(v.manual_offset_ms) > MAX_OFFSET_MS) return false;
      if (["match_revision", "fetch_generation"].some((k) => !isInt(v[k]) || v[k] < 0)) return false;
      if (!["ready", "incomplete", "unavailable", "fetch_error"].includes(v.metadata_state) || !v.metadata || typeof v.metadata !== "object") return false;
      if (["last_success_ms", "last_attempt_ms"].some((k) => v[k] != null && !isInt(v[k]))) return false;
      if (v.last_error != null && typeof v.last_error !== "string") return false;
      const meta = v.metadata;
      if (["url", "title", "channel", "channel_id"].some((k) => typeof meta[k] !== "string")) return false;
      if (meta.duration_ms != null && (!isInt(meta.duration_ms) || meta.duration_ms <= 0)) return false;
      if (meta.live_open_date != null && Z.liveOpenEpochMs(meta.live_open_date) == null) return false;
    }
    const memoIds = new Set();
    for (const m of data.memos) {
      if (!m || typeof m !== "object" || !["id", "group", "vod_id", "text"].every((k) => typeof m[k] === "string")) return false;
      if (["at_ms", "position_ms", "created_ms"].some((k) => !isInt(m[k])) || !m.snapshot || typeof m.snapshot !== "object") return false;
      if (!isUuid(m.id) || !isUuid(m.group) || memoIds.has(m.id) || m.position_ms < 0) return false;
      memoIds.add(m.id);
    }
    const requestIds = new Set();
    for (const r of data.receipts) {
      if (!r || typeof r !== "object" || !isUuid(r.request_id) || typeof r.payload_hash !== "string") return false;
      if (!Array.isArray(r.memo_ids) || typeof r.group !== "string") return false;
      if (requestIds.has(r.request_id) || !isUuid(r.group) || r.memo_ids.some((x) => !isUuid(x))) return false;
      requestIds.add(r.request_id);
    }
    return true;
  }

  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  async function sha256(text) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  /** deps: {storage: {get(key), set(key, value)}, lock(name, fn), now(), get?, sleep?} */
  function create(deps) {
    let notice = "";
    const now = () => deps.now();
    const locked = (fn) => deps.lock(KEY, fn);
    const emptyStore = () => ({ format: FORMAT, store_id: newId(), revision: 0, videos: [], memos: [], receipts: [] });

    async function load() {
      const raw = await deps.storage.get(KEY);
      if (raw == null) {  // first use: create the store now, so every open page sees the same store id
        const fresh = emptyStore();
        await deps.storage.set(KEY, fresh);
        return fresh;
      }
      if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.format != null && raw.format !== FORMAT) {
        throw fail("UNSUPPORTED_STORE_VERSION", "이 버전에서 지원하지 않는 메모 저장소입니다. 저장소는 변경하지 않았습니다.", 500);
      }
      if (!valid(raw)) {
        await deps.storage.set(`${KEY}.broken-${now()}`, raw);
        const fresh = emptyStore();
        await deps.storage.set(KEY, fresh);
        notice = "손상된 저장소를 따로 보관하고 새로 시작했습니다. 다시 검색하세요. 보관본은 '전체 백업'에 함께 들어 있습니다.";
        return fresh;
      }
      return raw;
    }

    async function commit(data) {
      data.revision += 1;
      await deps.storage.set(KEY, data);
    }

    function view(data) {
      const out = {};
      for (const [k, v] of Object.entries(data)) if (k !== "receipts" && k !== "format") out[k] = structuredClone(v);
      Object.assign(out, { path: PLACE, timezone: "Asia/Seoul", lag_ms: Z.REPLAY_LAG_MS, formula_version: FORMULA_VERSION, notice });
      notice = "";
      for (const v of out.videos) v.stale = isStale(v, now());
      return out;
    }

    function checkStore(data, storeId) {
      if (data.store_id !== storeId) throw fail("STORE_CHANGED", "저장소가 변경됐습니다. 목록을 새로 읽고 다시 검색하세요.", 409);
    }

    function findVideo(data, vodId, registrationId = null) {
      const v = data.videos.find((x) => x.vod_id === vodId);
      if (!v) throw fail("UNKNOWN_VIDEO", "등록된 영상을 찾을 수 없습니다. 목록을 새로 읽으세요.");
      if (registrationId != null && v.registration_id !== registrationId) {
        throw fail("REGISTRATION_CHANGED", "영상 등록 정보가 변경됐습니다. 다시 검색하세요.", 409);
      }
      return v;
    }

    const snapshot = () => locked(async () => view(await load()));

    async function fetchOne([vodId, registration, generation]) {
      try {
        const info = await Z.fetchVideoInfo(vodId, { get: deps.get, sleep: deps.sleep, retries: 1, timeoutMs: 6000 });
        const metadata = normalizeMetadata(info);
        metadata.url = Z.vodUrl(vodId);
        return [[vodId, registration, generation], metadata, null, null];
      } catch (e) {
        if (e instanceof Z.ChzzkError) return [[vodId, registration, generation], null, e.message, e.status];
        return [[vodId, registration, generation], null, "영상 정보 형식을 확인할 수 없습니다.", "incomplete"];
      }
    }

    async function runFetches(storeId, tasks) {
      if (!tasks.length) return [];
      const answers = await pool(tasks, FETCH_WORKERS, fetchOne);
      return locked(async () => {
        const data = await load();
        checkStore(data, storeId);
        const results = [];
        let changed = false;
        for (const [[vodId, registration, generation], metadata, error, status] of answers) {
          const v = data.videos.find((x) => x.vod_id === vodId);
          if (!v || v.registration_id !== registration || v.fetch_generation !== generation) {
            results.push({ vod_id: vodId, status: "ignored" });
            continue;
          }
          const before = signature(v);
          v.last_error = error;
          if (metadata) {
            v.metadata = metadata;
            v.last_success_ms = now();
            v.metadata_state = metadata.live_open_date && metadata.duration_ms ? "ready" : "incomplete";
          } else if ([401, 403, 404].includes(status)) {
            v.metadata_state = "unavailable";
          } else if (status === "incomplete") {
            v.metadata_state = "incomplete";
            v.metadata.duration_ms = null;
          } else if (v.metadata_state !== "ready") {
            v.metadata_state = "fetch_error";
          }
          if (signature(v) !== before) v.match_revision += 1;
          changed = true;
          results.push({ vod_id: vodId, status: v.metadata_state, error });
        }
        if (changed) await commit(data);
        return results;
      });
    }

    async function addVideos({ store_id, lines }) {
      if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_BATCH || lines.some((s) => typeof s !== "string" || s.length > 32768)) {
        throw fail("LIMIT_EXCEEDED", "한 번에 링크 1~10개를 추가하세요.");
      }
      if (lines.reduce((n, s) => n + new TextEncoder().encode(s).length, 0) > 32768) {
        throw fail("LIMIT_EXCEEDED", "링크 입력은 한 번에 32KiB까지 가능합니다.");
      }
      const tasks = [], results = [];
      await locked(async () => {
        const data = await load();
        checkStore(data, store_id);
        for (const line of lines) {
          let vodId;
          try {
            vodId = Z.parseVodId(line);
          } catch (e) {
            if (!(e instanceof Z.ChzzkError)) throw e;
            results.push({ line, status: "invalid", error: e.message });
            continue;
          }
          const row = { line, vod_id: vodId };
          if (data.videos.some((v) => v.vod_id === vodId)) row.status = "duplicate";
          else if (data.videos.length >= MAX_VIDEOS) row.status = "limit_exceeded";
          else {
            const v = {
              vod_id: vodId, registration_id: newId(), selected: true, manual_offset_ms: 0, match_revision: 1,
              fetch_generation: 1, metadata_state: "fetch_error", metadata: normalizeMetadata({ vod_id: vodId }),
              last_success_ms: null, last_attempt_ms: now(), last_error: null,
            };
            data.videos.push(v);
            tasks.push([vodId, v.registration_id, 1]);
            row.status = "added";
          }
          results.push(row);
        }
        if (tasks.length) await commit(data);
      });
      const fetched = new Map((await runFetches(store_id, tasks)).map((r) => [r.vod_id, r]));
      for (const row of results) {
        if (row.status !== "added") continue;
        const answer = fetched.get(row.vod_id) || {};
        if (["fetch_error", "unavailable", "incomplete"].includes(answer.status)) {
          row.status = "added_fetch_failed";
          row.error = answer.error || "시작 시각 또는 영상 길이를 확인하세요.";
        }
      }
      return { state: await snapshot(), line_results: results };
    }

    function updateVideo({ store_id, vod_id, registration_id, selected = null, manual_offset_ms = null, expected_match_revision = null }) {
      return locked(async () => {
        const data = await load();
        checkStore(data, store_id);
        const v = findVideo(data, vod_id, registration_id);
        let changed = false;
        if (selected != null) {
          if (typeof selected !== "boolean") throw fail("INVALID_REQUEST", "체크 상태를 확인하세요.");
          changed = changed || v.selected !== selected;
          v.selected = selected;
        }
        if (manual_offset_ms != null) {
          checkInt(manual_offset_ms, "INVALID_OFFSET", -MAX_OFFSET_MS, MAX_OFFSET_MS);
          checkInt(expected_match_revision);
          if (v.match_revision !== expected_match_revision) throw fail("MATCH_CHANGED", "영상 정보가 변경됐습니다. 다시 검색하세요.", 409);
          if (v.manual_offset_ms !== manual_offset_ms) {
            v.manual_offset_ms = manual_offset_ms;
            v.match_revision += 1;
            changed = true;
          }
        }
        if (changed) await commit(data);
        return { state: view(data) };
      });
    }

    function removeVideo({ store_id, vod_id, registration_id }) {
      return locked(async () => {
        const data = await load();
        checkStore(data, store_id);
        const found = data.videos.find((v) => v.vod_id === vod_id);
        if (found) {
          findVideo(data, vod_id, registration_id);
          data.videos.splice(data.videos.indexOf(found), 1);
          await commit(data);
        }
        return { state: view(data) };
      });
    }

    async function refresh({ store_id, items }) {
      if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH) {
        throw fail("LIMIT_EXCEEDED", "한 번에 영상 1~10개를 새로고침하세요.");
      }
      const tasks = [];
      await locked(async () => {
        const data = await load();
        checkStore(data, store_id);
        const seen = new Set();
        for (const item of items) {
          const v = findVideo(data, item && item.vod_id, item && item.registration_id);
          if (seen.has(v.vod_id)) continue;
          seen.add(v.vod_id);
          v.fetch_generation += 1;
          v.last_attempt_ms = now();
          tasks.push([v.vod_id, v.registration_id, v.fetch_generation]);
        }
        await commit(data);
      });
      const results = await runFetches(store_id, tasks);
      return { state: await snapshot(), item_results: results };
    }

    async function find({ wall_time, vod_ids = null }) {
      const [atMs, normalized] = parseWallTime(wall_time);
      return locked(async () => {
        const data = await load();
        let chosen;
        if (vod_ids == null) chosen = data.videos.filter((v) => v.selected);
        else {
          if (!Array.isArray(vod_ids) || vod_ids.length > MAX_VIDEOS) throw fail("LIMIT_EXCEEDED", "검색할 영상 목록을 확인하세요.");
          chosen = [...new Set(vod_ids)].map((id) => findVideo(data, id));
        }
        if (!chosen.length) throw fail("NO_SELECTION", "검색할 다시보기를 선택하세요.");
        return {
          store_id: data.store_id, revision: data.revision, at_ms: atMs, normalized_kst: normalized,
          timezone: "Asia/Seoul", formula_version: FORMULA_VERSION,
          results: chosen.map((v) => matchVideo(v, atMs, now())),
        };
      });
    }

    async function addMemos({ store_id, request_id, at_ms, formula_version, text = "", items }) {
      if (!isUuid(request_id)) throw fail("INVALID_REQUEST", "저장 요청 ID를 확인하세요.");
      checkInt(at_ms, "INVALID_REQUEST", MIN_AT_MS, MAX_AT_MS);
      checkInt(formula_version);
      if (typeof text !== "string") throw fail("INVALID_REQUEST", "메모 내용을 확인하세요.");
      text = text.split(/\s+/).filter(Boolean).join(" ");
      if ([...text].length > MAX_TEXT) throw fail("LIMIT_EXCEEDED", "메모는 500자까지 쓸 수 있습니다.");
      if (!Array.isArray(items) || items.length < 1 || items.length > MAX_VIDEOS) throw fail("NO_SELECTION", "저장할 결과를 선택하세요.");
      const seen = new Set();
      for (const item of items) {
        if (!item || typeof item !== "object" || typeof item.vod_id !== "string" || seen.has(item.vod_id)) {
          throw fail("INVALID_REQUEST", "저장할 영상 ID가 중복되었거나 잘못되었습니다.");
        }
        if (!isUuid(item.registration_id)) throw fail("INVALID_REQUEST", "영상 등록 ID를 확인하세요.");
        checkInt(item.match_revision);
        seen.add(item.vod_id);
      }
      const payload = {
        at_ms, formula_version, text,
        items: [...items].sort((a, b) => (a.vod_id < b.vod_id ? -1 : a.vod_id > b.vod_id ? 1 : 0))
          .map(({ vod_id, registration_id, match_revision }) => ({ vod_id, registration_id, match_revision })),
      };
      const digest = await sha256(stable(payload));
      return locked(async () => {
        const data = await load();
        checkStore(data, store_id);
        const receipt = data.receipts.find((r) => r.request_id === request_id);
        if (receipt) {
          if (receipt.payload_hash !== digest) throw fail("REQUEST_ID_REUSED", "같은 저장 요청 ID에 다른 내용을 보낼 수 없습니다.", 409);
          const existing = new Set(data.memos.map((m) => m.id));
          const ids = receipt.memo_ids.filter((id) => existing.has(id));
          return { state: view(data), group: receipt.group, memo_ids: ids, replayed: true, deleted: !ids.length };
        }
        if (formula_version !== FORMULA_VERSION) throw fail("FORMULA_CHANGED", "시간 계산 기준이 변경됐습니다. 다시 검색하세요.", 409);
        const checked = [];
        for (const item of items) {
          let v;
          try {
            v = findVideo(data, item.vod_id, item.registration_id);
          } catch (e) {
            throw fail("REGISTRATION_CHANGED", "영상 등록 정보가 변경됐습니다. 다시 검색하세요.", 409);
          }
          if (v.match_revision !== item.match_revision) throw fail("MATCH_CHANGED", "영상 정보가 변경됐습니다. 다시 찾은 뒤 저장하세요.", 409);
          const result = matchVideo(v, at_ms, now());
          if (result.status !== "match") throw fail("MATCH_CHANGED", "저장할 수 없는 영상 위치입니다. 다시 검색하세요.", 409);
          checked.push([v, result]);
        }
        const group = newId(), t = now(), memoIds = [];
        for (const [v, result] of checked) {
          const mid = newId();
          memoIds.push(mid);
          const meta = v.metadata;
          const snap = {};
          for (const k of ["url", "title", "channel", "live_open_date", "duration_ms"]) snap[k] = meta[k] == null ? null : meta[k];
          Object.assign(snap, {
            base_ms: result.base_ms, manual_offset_ms: v.manual_offset_ms, calibration: result.calibration,
            formula_version: FORMULA_VERSION, stale: result.stale, last_success_ms: v.last_success_ms,
          });
          data.memos.push({ id: mid, group, vod_id: v.vod_id, at_ms, text, position_ms: result.position_ms, created_ms: t, snapshot: snap });
        }
        data.receipts.push({ request_id, payload_hash: digest, group, memo_ids: memoIds, created_ms: t });
        await commit(data);
        return { state: view(data), group, memo_ids: memoIds, replayed: false, deleted: false };
      });
    }

    function deleteMemos({ store_id, id = null, group = null }) {
      if ((id == null) === (group == null)) throw fail("INVALID_REQUEST", "메모 ID 또는 그룹 중 하나만 지정하세요.");
      return locked(async () => {
        const data = await load();
        checkStore(data, store_id);
        const before = data.memos.length;
        data.memos = data.memos.filter((m) => !(id != null ? m.id === id : m.group === group));
        if (data.memos.length !== before) await commit(data);
        return { state: view(data) };
      });
    }

    /** Add a backup / desktop vod_memos.json: unknown videos and memos are added, nothing is overwritten. */
    function merge(incoming) {
      if (!valid(incoming)) throw fail("INVALID_IMPORT", "다시보기 메모 형식이 아니거나 손상된 파일입니다.");
      const src = structuredClone(incoming);
      return locked(async () => {
        const data = await load();
        const result = { videos: 0, memos: 0, skippedVideos: 0 };
        for (const v of src.videos) {
          if (data.videos.some((x) => x.vod_id === v.vod_id)) continue;
          if (data.videos.length >= MAX_VIDEOS) { result.skippedVideos++; continue; }
          data.videos.push(v);
          result.videos++;
        }
        const have = new Set(data.memos.map((m) => m.id));
        for (const m of src.memos) {
          if (have.has(m.id)) continue;
          data.memos.push(m);
          have.add(m.id);
          result.memos++;
        }
        if (result.videos || result.memos) await commit(data);
        return result;
      });
    }

    return { snapshot, addVideos, updateVideo, removeVideo, refresh, find, addMemos, deleteMemos, merge };
  }

  return { FORMAT, KEY, FORMULA_VERSION, VodMemoError, create, parseWallTime, matchVideo, normalizeMetadata, valid };
})();

if (typeof module !== "undefined") module.exports = VodStore;
