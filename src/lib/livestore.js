/* Live broadcast time memos (라이브 메모). Port of stt_timeline/livememo.py.
 *
 * The user keeps a list of CHZZK channels. A memo is a wall-clock time plus a note; for every
 * selected channel the time is turned into a position in the broadcast that was on air then:
 *
 *     position = time - openDate - REPLAY_LAG
 *
 * which is the same clock the viewer uses for replays, so the position is also where the moment
 * is in the replay. The broadcasts seen for a channel (live id, start, end) are remembered, so a
 * time from before a restart still maps to the earlier broadcast. Everything lives in one storage
 * entry ("live") in the same shape as the desktop app's live_memos.json, so files move both ways.
 */
"use strict";

const LiveStore = (() => {
  const Z = typeof Chzzk !== "undefined" ? Chzzk : require("./chzzk.js");
  const FORMAT = "stt-live-memos/1";
  const KEY = "live";
  const MAX_CHANNELS = 50;
  const MAX_TEXT = 500;
  const MAX_POS_S = 100 * 3600 - 1;   // 99:59:59, the most the HH:mm:ss copy format can show
  const LIVES_KEPT = 30;              // broadcasts remembered per channel
  const END_GRACE_MS = 60000;         // viewers still see the stream for a little while after it closes
  const STALE_GRACE_MS = 10 * 60000;  // CHZZK unreachable: trust the last "on air" check for this long
  const FUTURE_SLACK_MS = 60000;      // tolerate a PC clock that runs slightly ahead
  const EARLIEST_MS = 1672531200000;  // 2023-01-01: CHZZK did not exist before; rejects garbage times
  const FETCH_RETRIES = 2;            // UI requests: fail fast instead of a long backoff
  const FETCH_TIMEOUT_MS = 6000;
  const FETCH_WORKERS = 8;
  const PLACE = "이 브라우저 (확장 프로그램 저장소)";

  const ID_RE = /^[0-9a-fA-F]{32}$/;
  const URL_RE = /^(?:https?:\/\/)?(?:m\.)?chzzk\.naver\.com\/(?:live\/)?([0-9a-fA-F]{32})(?:[/?#].*)?$/;

  class LiveMemoError extends Error {
    constructor(message) { super(message); this.name = "LiveMemoError"; }
  }
  const fail = (message) => new LiveMemoError(message);

  const isInt = (v) => Number.isSafeInteger(v);
  const intOrNone = (v) => v == null || isInt(v);
  const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

  function parseChannelId(text) {
    text = String(text || "").trim();
    if (ID_RE.test(text)) return text.toLowerCase();
    const m = URL_RE.exec(text);
    if (m) return m[1].toLowerCase();
    if (text.includes("/video/")) {
      throw fail("다시보기 주소입니다. 방송 중인 채널의 라이브 주소나 채널 주소를 넣으세요. 예: https://chzzk.naver.com/live/채널ID");
    }
    throw fail("치지직 라이브 주소나 채널 주소를 넣으세요. 예: https://chzzk.naver.com/live/채널ID");
  }

  // ----------------------------------------------------------------- CHZZK lookups

  function fetchMessage(e) {
    if (e.status === 404) return "채널을 찾을 수 없습니다. 주소를 확인하세요.";
    if (e.status == null) return "치지직에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.";
    return e.message;
  }

  async function content(url, deps) {
    try {
      return await Z.requestContent(url, { get: deps.get, sleep: deps.sleep, retries: FETCH_RETRIES, timeoutMs: FETCH_TIMEOUT_MS });
    } catch (e) {
      if (e instanceof Z.ChzzkError) throw fail(fetchMessage(e));
      throw e;
    }
  }

  async function fetchChannel(cid, deps) {
    const c = await content(`${Z.API}/v1/channels/${cid}`, deps);
    // unknown ids come back as 200 with an empty "(알 수 없음)" channel
    if (!c.channelId) throw fail("채널을 찾을 수 없습니다. 주소를 확인하세요.");
    return { id: cid, name: Z.cleanStr(c.channelName).trim() || cid.slice(0, 8) };
  }

  /** The channel's current or most recent broadcast, or null when it never broadcast.
   *  close_ms is null while it is on air, and also when CHZZK reports it closed without an end time. */
  async function fetchLive(cid, deps) {
    const c = await content(`${Z.API}/v3/channels/${cid}/live-detail`, deps);
    const open = Z.liveOpenEpochMs(c.openDate || "");
    if (open == null) return null;
    const status = c.status === "OPEN" ? "OPEN" : "CLOSE";
    const close = status === "OPEN" ? null : Z.liveOpenEpochMs(c.closeDate || "");
    const lid = c.liveId;
    return {
      live_id: lid !== null && lid !== undefined && lid !== "" ? String(lid) : `t${open}`,
      title: Z.cleanStr(c.liveTitle).trim(),
      open_ms: open,
      close_ms: close,
      status,
    };
  }

  // ----------------------------------------------------------------- time math (pure)

  /** The broadcast on air at `atMs` -> [live, null, null], or [null, reason, reference ms].
   *  onAirId: the broadcast CHZZK just reported as on air (null if the check failed).
   *  reason: "none" | "before" (ref = earliest start) | "after" (ref = its end) |
   *  "unknown_end" (never saw how long it lasted; ref = the last time it was seen on air). */
  function matchLive(lives, atMs, onAirId = null, graceMs = END_GRACE_MS) {
    const ordered = [...lives].sort((a, b) => a.open_ms - b.open_ms);
    if (!ordered.length) return [null, "none", null];
    let current = null;
    for (const lv of ordered) {
      if (lv.open_ms <= atMs) current = lv;
      else break;
    }
    if (current === null) return [null, "before", ordered[0].open_ms];
    const close = current.close_ms;
    if (close != null) return atMs > close + END_GRACE_MS ? [null, "after", close] : [current, null, null];
    if (onAirId != null && current === ordered[ordered.length - 1] && current.live_id === onAirId) return [current, null, null];
    const seen = Math.max(current.seen_open_ms || 0, current.open_ms);
    if (atMs <= seen + graceMs) return [current, null, null];
    return [null, "unknown_end", seen];
  }

  /** Seconds into the broadcast (and its replay) that viewers were watching at `atMs`. */
  function positionS(live, atMs) {
    let pos = Math.floor((atMs - live.open_ms - Z.REPLAY_LAG_MS) / 1000);
    if (live.close_ms != null) pos = Math.min(pos, Math.floor((live.close_ms - live.open_ms) / 1000));
    return Math.max(0, pos);
  }

  /** Merge a live-detail answer (requested at `fetchedMs`) into the channel's broadcast history.
   *  Answers older than the last one applied are ignored, and a known end time is never forgotten. */
  function rememberLive(channel, live, fetchedMs) {
    if (fetchedMs < (channel.checked_ms || 0)) return;
    channel.checked_ms = fetchedMs;
    delete channel.error;
    if (!Array.isArray(channel.lives)) channel.lives = [];
    const lives = channel.lives;
    if (live == null) {
      channel.status = lives.length ? "CLOSE" : "NONE";
      return;
    }
    let entry = lives.find((lv) => lv.live_id === live.live_id);
    if (!entry) {
      entry = { live_id: live.live_id, close_ms: null };
      lives.push(entry);
    }
    entry.title = live.title || entry.title || "";
    entry.open_ms = live.open_ms;
    if (live.close_ms != null) entry.close_ms = live.close_ms;
    if (live.status === "OPEN") entry.seen_open_ms = Math.max(entry.seen_open_ms || 0, fetchedMs);
    lives.sort((a, b) => a.open_ms - b.open_ms);
    if (lives.length > LIVES_KEPT) lives.splice(0, lives.length - LIVES_KEPT);
    channel.status = live.status;
  }

  function hmsText(sec) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
  }

  function cleanMemoText(text) {
    text = String(text == null ? "" : text).split(/\s+/).filter(Boolean).join(" ");
    if ([...text].length > MAX_TEXT) throw fail(`메모는 ${MAX_TEXT}자까지 쓸 수 있습니다.`);
    return text;
  }

  // ----------------------------------------------------------------- stored data

  const validLive = (lv) => lv && typeof lv === "object" && typeof lv.live_id === "string" && isInt(lv.open_ms)
    && intOrNone(lv.close_ms) && intOrNone(lv.seen_open_ms);
  const validChannel = (ch) => ch && typeof ch === "object" && typeof ch.id === "string" && ID_RE.test(ch.id);
  const MEMO_TYPES = { id: "string", group: "string", channel: "string", live_id: "string", open_ms: "int", at_ms: "int", pos: "int" };
  const validMemo = (m) => m && typeof m === "object"
    && Object.entries(MEMO_TYPES).every(([k, t]) => (t === "int" ? isInt(m[k]) : typeof m[k] === t));
  const asList = (v) => (Array.isArray(v) ? v : []);

  /** Drop entries a hand edit broke instead of failing the whole tab -> [clean data, dropped anything]. */
  function sanitize(data) {
    let dropped = !Array.isArray(data.channels) || !Array.isArray(data.memos);
    const channels = [];
    for (const ch of asList(data.channels)) {
      if (!(validChannel(ch) && channels.every((c) => c.id !== ch.id))) {
        dropped = true;
        continue;
      }
      const lives = asList(ch.lives);
      const kept = lives.filter(validLive);
      dropped = dropped || kept.length !== lives.length || !Array.isArray(ch.lives);
      ch.lives = kept;
      ch.name = String(ch.name || ch.id.slice(0, 8));
      ch.selected = !!ch.selected;
      channels.push(ch);
    }
    const memos = asList(data.memos).filter(validMemo);
    dropped = dropped || memos.length !== asList(data.memos).length;
    return [{ format: FORMAT, channels, memos }, dropped];
  }

  const empty = () => ({ format: FORMAT, channels: [], memos: [] });

  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
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
    let refreshing = false;
    const now = () => deps.now();
    const locked = (fn) => deps.lock(KEY, fn);

    async function load() {
      const raw = await deps.storage.get(KEY);
      if (raw == null) return empty();
      if (typeof raw !== "object" || Array.isArray(raw)) {
        await deps.storage.set(`${KEY}.broken-${now()}`, raw);
        notice = "메모 저장소가 손상되어 원래 내용을 따로 보관하고 새로 시작했습니다. 백업 탭의 '전체 백업'에 함께 들어 있습니다.";
        await deps.storage.set(KEY, empty());
        return empty();
      }
      const [clean, dropped] = sanitize(structuredClone(raw));
      if (dropped) {
        await deps.storage.set(`${KEY}.broken-${now()}`, raw);
        await deps.storage.set(KEY, clean);
        notice = "메모 저장소에서 읽을 수 없는 항목을 빼고 열었습니다. 원래 내용은 따로 보관했고 '전체 백업'에 함께 들어 있습니다.";
      }
      return clean;
    }

    const save = (data) => deps.storage.set(KEY, data);

    /** {id: [true, live|null, requested at] | [false, error message, requested at]} — in parallel. */
    async function fetchLives(ids) {
      const answers = await pool(ids, FETCH_WORKERS, async (cid) => {
        const started = now();
        try {
          return [cid, [true, await fetchLive(cid, deps), started]];
        } catch (e) {
          if (e instanceof LiveMemoError) return [cid, [false, e.message, started]];
          throw e;
        }
      });
      return new Map(answers);
    }

    function apply(data, results) {
      for (const ch of data.channels) {
        if (!results.has(ch.id)) continue;
        const [ok, value, started] = results.get(ch.id);
        if (ok) rememberLive(ch, value, started);
        else if (started >= (ch.checked_ms || 0)) ch.error = value;
      }
    }

    function view(data) {
      const channels = data.channels.map((ch) => {
        const lives = ch.lives || [];
        const cur = lives.length ? lives[lives.length - 1] : null;
        return {
          id: ch.id, name: ch.name, selected: ch.selected,
          status: ch.status || (lives.length ? "CLOSE" : "NONE"),
          live: cur && { live_id: cur.live_id, title: cur.title, open_ms: cur.open_ms, close_ms: cur.close_ms },
          checked_ms: ch.checked_ms == null ? null : ch.checked_ms, error: ch.error == null ? null : ch.error,
        };
      });
      const shown = notice;
      notice = "";  // shown once
      return { path: PLACE, now_ms: now(), lag_ms: Z.REPLAY_LAG_MS, channels, memos: data.memos, notice: shown };
    }

    /** Content without the check times, which change on every refresh. */
    const fingerprint = (data) => stable({ ...data, channels: data.channels.map(({ checked_ms, ...rest }) => rest) });

    async function snapshot(refresh = false) {
      if (refresh && !refreshing) {  // one refresh at a time; others just read
        refreshing = true;
        try {
          const ids = (await locked(load)).channels.map((c) => c.id);
          const results = await fetchLives(ids);
          return await locked(async () => {
            const data = await load();
            const before = fingerprint(data);
            apply(data, results);
            if (fingerprint(data) !== before) await save(data);
            return view(data);
          });
        } finally {
          refreshing = false;
        }
      }
      return locked(async () => view(await load()));
    }

    // -- channels

    async function addChannel(text) {
      const cid = parseChannelId(text);
      await locked(async () => {
        const data = await load();
        if (data.channels.some((c) => c.id === cid)) throw fail("이미 목록에 있는 채널입니다.");
        if (data.channels.length >= MAX_CHANNELS) throw fail(`채널은 ${MAX_CHANNELS}개까지 넣을 수 있습니다. 쓰지 않는 채널을 빼고 다시 시도하세요.`);
      });
      const info = await fetchChannel(cid, deps);
      const results = await fetchLives([cid]);
      return locked(async () => {
        const data = await load();
        if (!data.channels.some((c) => c.id === cid)) {
          if (data.channels.length >= MAX_CHANNELS) {  // another window added channels meanwhile
            throw fail(`채널은 ${MAX_CHANNELS}개까지 넣을 수 있습니다. 쓰지 않는 채널을 빼고 다시 시도하세요.`);
          }
          data.channels.push({ id: cid, name: info.name, selected: true, added_ms: now(), lives: [] });
          apply(data, results);
          await save(data);
        }
        return view(data);
      });
    }

    /** Memos of the channel stay (they carry the channel name). */
    function removeChannel(cid) {
      return locked(async () => {
        const data = await load();
        const kept = data.channels.filter((c) => c.id !== cid);
        if (kept.length !== data.channels.length) {
          data.channels = kept;
          await save(data);
        }
        return view(data);
      });
    }

    function setSelected(cid, selected) {
      return locked(async () => {
        const data = await load();
        const ch = data.channels.find((c) => c.id === cid);
        if (!ch) throw fail("목록에 없는 채널입니다. 새로고침하세요.");
        if (ch.selected !== !!selected) {
          ch.selected = !!selected;
          await save(data);
        }
        return view(data);
      });
    }

    // -- memos

    /** Save one memo for every channel that was on air at `atMs`; report the others. */
    async function addMemo(atMs, text, channelIds) {
      text = cleanMemoText(text);
      const ids = [...new Set((channelIds || []).map(String))];
      if (!ids.length) throw fail("메모할 방송을 목록에서 하나 이상 체크하세요.");
      const t = now();
      if (!isInt(atMs) || atMs < EARLIEST_MS) throw fail("날짜와 시각을 확인하세요.");
      if (atMs > t + FUTURE_SLACK_MS) throw fail("아직 오지 않은 시각입니다. 날짜와 시각을 확인하세요.");
      const known = new Set((await locked(load)).channels.map((c) => c.id));
      if (ids.some((i) => !known.has(i))) throw fail("목록에 없는 채널이 있습니다. 새로고침한 뒤 다시 저장하세요.");
      const results = await fetchLives(ids);
      return locked(async () => {
        const data = await load();
        apply(data, results);
        const channels = new Map(data.channels.map((c) => [c.id, c]));
        const group = newId();
        const saved = [], skipped = [];
        for (const cid of ids) {
          const ch = channels.get(cid);
          if (!ch) {  // removed by another window meanwhile
            skipped.push({ channel: cid, name: cid.slice(0, 8), reason: "removed", ref_ms: null });
            continue;
          }
          const [ok, value] = results.get(cid);
          const onAir = ok && value && value.status === "OPEN" ? value.live_id : null;
          const [live, reason, ref] = matchLive(ch.lives, atMs, onAir, ok ? END_GRACE_MS : STALE_GRACE_MS);
          if (!live) {
            if (!ok && reason === "none") skipped.push({ channel: cid, name: ch.name, reason: "error", ref_ms: null, detail: value });
            else skipped.push({ channel: cid, name: ch.name, reason, ref_ms: ref });
            continue;
          }
          const memo = {
            id: newId(), group, channel: cid, channel_name: ch.name, live_id: live.live_id,
            live_title: live.title || "", open_ms: live.open_ms, at_ms: atMs, pos: positionS(live, atMs),
            text, created_ms: t,
          };
          data.memos.push(memo);
          saved.push({ ...memo, stale: !ok });
        }
        await save(data);
        return { saved, skipped, state: view(data) };
      });
    }

    /** Position of memo `m` if its moment were `atMs` (same broadcast); throws when that cannot be. */
    function place(data, m, atMs, t) {
      const pos = Math.floor((atMs - m.open_ms - Z.REPLAY_LAG_MS) / 1000);
      checkPlace(data, m, pos, atMs, t);
      return pos;
    }

    /** Memo `m` moved by `shift` seconds -> [position, wall-clock ms]. The position moves by exactly `shift`
     *  from the one on screen, not recomputed from the clock: a memo saved just after its broadcast ended has
     *  its position held at the end (positionS), and recomputing moved it by the wrong amount (-5 s became
     *  -1 s) or refused the whole group. */
    function move(data, m, shift, t) {
      const pos = m.pos + shift, at = m.at_ms + shift * 1000;
      checkPlace(data, m, pos, at, t);
      return [pos, at];
    }

    function checkPlace(data, m, pos, atMs, t) {
      const who = m.channel_name || m.channel.slice(0, 8);
      if (pos < 0) throw fail(`${who}: 방송 시작(${hmsText(0)})보다 앞으로는 옮길 수 없습니다.`);
      if (pos > MAX_POS_S) throw fail("방송 위치는 00:00:00 ~ 99:59:59 사이로 쓰세요.");
      const ch = data.channels.find((c) => c.id === m.channel);
      const live = ((ch && ch.lives) || []).find((lv) => lv.live_id === m.live_id);
      if (live && live.close_ms != null && pos > Math.floor((live.close_ms - m.open_ms) / 1000)) {
        throw fail(`${who}: 방송 길이(${hmsText(Math.floor((live.close_ms - m.open_ms) / 1000))})보다 뒤의 위치입니다.`);
      }
      if (atMs > t + FUTURE_SLACK_MS) throw fail("아직 방송이 거기까지 오지 않았습니다. 위치를 확인하세요.");
    }

    /** Change a memo.
     *  group: the note and/or the time of every memo saved together: `shift` seconds, or `base` (one memo
     *      of the group) + `pos`: that memo goes to `pos` and the others move as much. The amount is worked
     *      out from the saved position, so a screen that had not caught up still lands where the user typed.
     *  id: one memo's note and/or position. It then leaves its group and remembers where it came
     *      from (`split_from`), so the screens can show it and `rejoinMemo` can put it back. */
    function editMemo({ id = null, group = null, text = null, pos = null, shift = null, base = null } = {}) {
      if (!id && !group) throw fail("고칠 메모를 고르세요.");
      if (base != null && (!group || id)) throw fail("기준 방송은 같이 저장한 메모 전체를 고칠 때만 씁니다.");
      if (pos != null && !id && base == null) throw fail("방송 위치는 방송마다 다르므로 채널을 골라서 고치세요.");
      if (shift != null && !group) throw fail("시간 보정은 같이 저장한 메모 전체에 적용됩니다.");
      if (shift != null && pos != null) throw fail("시간 보정과 위치는 함께 보낼 수 없습니다.");
      if (shift != null && (!isInt(shift) || Math.abs(shift) > MAX_POS_S)) throw fail("시간 보정은 초 단위 정수로 쓰세요.");
      if (text == null && pos == null && !shift) throw fail("고칠 내용이 없습니다.");
      if (text != null) text = cleanMemoText(text);
      if (pos != null && (!isInt(pos) || pos < 0 || pos > MAX_POS_S)) throw fail("방송 위치는 00:00:00 ~ 99:59:59 사이로 쓰세요.");
      return locked(async () => {
        const data = await load();
        const memos = data.memos;
        const targets = memos.filter((m) => (id ? m.id === id : m.group === group));
        if (!targets.length) throw fail("이미 지워진 메모입니다. 새로고침하세요.");
        const t = now();
        const changed = [];
        if (id) {
          const m = targets[0];
          let newPos = m.pos, newAt = m.at_ms;
          if (pos != null && pos !== m.pos) {
            newAt = m.open_ms + Z.REPLAY_LAG_MS + pos * 1000;
            newPos = place(data, m, newAt, t);
          }
          const newText = text == null ? (m.text || "") : text;
          if (newPos !== m.pos || newAt !== m.at_ms || newText !== (m.text || "")) {
            m.pos = newPos; m.at_ms = newAt; m.text = newText;
            if (memos.some((o) => o !== m && o.group === m.group)) {
              if (!("split_from" in m)) m.split_from = m.group;
              m.group = newId();
            }
            changed.push(m);
          }
        } else {
          if (base != null) {
            const anchor = targets.find((m) => m.id === base);
            if (!anchor) throw fail("기준으로 고른 방송의 메모가 이 그룹에 없습니다. 새로고침한 뒤 다시 고치세요.");
            shift = pos - anchor.pos;
          }
          const moves = new Map();
          if (shift) {
            for (const m of targets) {  // check every broadcast before touching any
              try {
                moves.set(m.id, move(data, m, shift, t));
              } catch (e) {
                if (targets.length === 1 || !(e instanceof LiveMemoError)) throw e;
                throw fail(`${e.message} 같이 저장한 방송의 시간은 하나도 바꾸지 않았습니다.`);
              }
            }
          }
          for (const m of targets) {
            const before = [m.pos, m.at_ms, m.text || ""].join("|");
            if (moves.has(m.id)) [m.pos, m.at_ms] = moves.get(m.id);
            if (text != null) m.text = text;
            if ([m.pos, m.at_ms, m.text || ""].join("|") !== before) changed.push(m);
          }
        }
        if (changed.length) {
          for (const m of changed) m.edited_ms = t;
          await save(data);
        }
        return view(data);
      });
    }

    /** Put a memo that was edited on its own back into the group it was saved with. */
    function rejoinMemo(id) {
      return locked(async () => {
        const data = await load();
        const memos = data.memos;
        const m = memos.find((x) => x.id === id);
        if (!m) throw fail("이미 지워진 메모입니다. 새로고침하세요.");
        const home = memos.filter((x) => x.group === m.split_from && x !== m);
        if (!home.length) {
          delete m.split_from;
          await save(data);
          throw fail("같이 저장했던 메모가 모두 지워져서 다시 묶을 곳이 없습니다.");
        }
        const ref = home[0];
        const t = now();
        m.pos = place(data, m, ref.at_ms, t);
        m.at_ms = ref.at_ms; m.text = ref.text || ""; m.group = ref.group;
        delete m.split_from;
        m.edited_ms = t;
        await save(data);
        return view(data);
      });
    }

    function deleteMemos({ id = null, group = null } = {}) {
      if (!id && !group) throw fail("지울 메모를 고르세요.");
      return locked(async () => {
        const data = await load();
        const kept = data.memos.filter((m) => !((id && m.id === id) || (group && m.group === group)));
        if (kept.length !== data.memos.length) {
          data.memos = kept;
          await save(data);
        }
        return view(data);
      });
    }

    /** Add a backup / desktop live_memos.json: unknown channels and memos are added, nothing is overwritten.
     *  Broadcast histories of channels on both sides are joined, so older broadcasts stay matchable. */
    function merge(incoming) {
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) throw fail("라이브 메모 형식이 아닙니다.");
      const [clean, dropped] = sanitize(structuredClone(incoming));
      return locked(async () => {
        const data = await load();
        const result = { channels: 0, memos: 0, skippedChannels: 0, dropped };
        for (const ch of clean.channels) {
          const mine = data.channels.find((c) => c.id === ch.id);
          if (mine) {
            for (const lv of ch.lives) if (!mine.lives.some((x) => x.live_id === lv.live_id)) mine.lives.push(lv);
            mine.lives.sort((a, b) => a.open_ms - b.open_ms);
            if (mine.lives.length > LIVES_KEPT) mine.lives.splice(0, mine.lives.length - LIVES_KEPT);
          } else if (data.channels.length < MAX_CHANNELS) {
            data.channels.push(ch);
            result.channels++;
          } else {
            result.skippedChannels++;
          }
        }
        const have = new Set(data.memos.map((m) => m.id));
        for (const m of clean.memos) {
          if (have.has(m.id)) continue;
          data.memos.push(m);
          have.add(m.id);
          result.memos++;
        }
        await save(data);
        return result;
      });
    }

    return {
      snapshot, addChannel, removeChannel, setSelected, addMemo, editMemo, rejoinMemo, deleteMemos, merge,
    };
  }

  return {
    FORMAT, KEY, MAX_CHANNELS, LiveMemoError, create, parseChannelId, matchLive, positionS, rememberLive,
    cleanMemoText, sanitize,
  };
})();

if (typeof module !== "undefined") module.exports = LiveStore;
