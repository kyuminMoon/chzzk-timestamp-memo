/* Store logic of the extension (ported from stt_timeline/livememo.py and vodmemo.py), with a fake CHZZK and storage.
 * Run: node tests/test_stores.js */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const src = path.join(__dirname, "..", "src", "lib");

global.Chzzk = require(path.join(src, "chzzk.js"));
global.LiveStore = require(path.join(src, "livestore.js"));
global.VodStore = require(path.join(src, "vodstore.js"));
const Backend = require(path.join(src, "backend.js"));

const KST = (s) => Chzzk.liveOpenEpochMs(s);
const CH_A = "a".repeat(32), CH_B = "b".repeat(32);

function world(startMs) {
  const store = new Map();
  const w = {
    t: startMs,
    channels: { [CH_A]: "스트리머A", [CH_B]: "스트리머B" },
    lives: {},   // id -> live-detail content
    videos: {},  // vod id -> video content
    calls: [],
    storage: {
      get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : undefined),
      set: async (k, v) => { store.set(k, structuredClone(v)); },
      all: async () => Object.fromEntries([...store].map(([k, v]) => [k, structuredClone(v)])),
    },
    raw: store,
  };
  w.get = async (url) => {
    w.calls.push(url);
    let m;
    if ((m = /\/v1\/channels\/(\w+)$/.exec(url))) {
      const name = w.channels[m[1]];
      return [200, { code: 200, content: name ? { channelId: m[1], channelName: name } : { channelId: null } }];
    }
    if ((m = /\/v3\/channels\/(\w+)\/live-detail$/.exec(url))) return [200, { code: 200, content: w.lives[m[1]] || null }];
    if ((m = /\/v2\/videos\/(\d+)$/.exec(url))) {
      const v = w.videos[m[1]];
      return v ? [200, { code: 200, content: v }] : [404, { code: 404, message: "not found" }];
    }
    return [404, null];
  };
  w.backend = Backend.create({ storage: w.storage, now: () => w.t, get: w.get, sleep: async () => {} });
  w.call = (p, body) => w.backend.call(p, body === undefined ? {} : { method: "POST", body });
  return w;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------------ CHZZK helpers

test("KST parsing and channel / video links", () => {
  assert.equal(KST("2026-11-21 19:00:00"), Date.UTC(2026, 10, 21, 10, 0, 0));
  assert.equal(KST("2026-02-30 10:00:00"), null);
  assert.equal(KST(""), null);
  assert.equal(LiveStore.parseChannelId(`https://chzzk.naver.com/live/${CH_A.toUpperCase()}?x=1`), CH_A);
  assert.equal(LiveStore.parseChannelId(`https://m.chzzk.naver.com/${CH_A}`), CH_A);
  assert.throws(() => LiveStore.parseChannelId("https://chzzk.naver.com/video/123"), /다시보기 주소/);
  assert.equal(Chzzk.parseVodId("https://chzzk.naver.com/video/16136287?t=1"), "16136287");
  assert.throws(() => Chzzk.parseVodId("abc"), Chzzk.ChzzkError);
});

test("API errors: 403 is not retried, 5xx is", async () => {
  let n = 0;
  await assert.rejects(Chzzk.requestContent("u", { get: async () => { n++; return [403, null]; }, sleep: async () => {} }),
    (e) => e.status === 403 && /거부/.test(e.message));
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(Chzzk.requestContent("u", { retries: 3, get: async () => { n++; return [502, null]; }, sleep: async () => {} }),
    (e) => e.status === null);
  assert.equal(n, 3);
});

// ------------------------------------------------------------------ live memos

async function liveSetup() {
  const open = KST("2026-11-21 19:00:00");
  const w = world(open + 3600e3);
  w.lives[CH_A] = { liveId: 111, liveTitle: "합방", status: "OPEN", openDate: "2026-11-21 19:00:00" };
  w.lives[CH_B] = { liveId: 222, liveTitle: "합방 B", status: "OPEN", openDate: "2026-11-21 19:30:00" };
  await w.call("/api/live/channels", { url: `https://chzzk.naver.com/live/${CH_A}` });
  await w.call("/api/live/channels", { url: CH_B });
  return { w, open };
}

test("a memo is saved for every checked broadcast at its own position", async () => {
  const { w, open } = await liveSetup();
  const at = open + 3000e3;  // 19:50:00
  const r = await w.call("/api/live/memos", { at_ms: at, text: "  첫   곡 ", channels: [CH_A, CH_B] });
  assert.equal(r.saved.length, 2);
  const [a, b] = r.saved;
  assert.equal(a.text, "첫 곡");
  assert.equal(a.pos, 3000 - 4);          // 50 min minus the 4 s replay lag
  assert.equal(b.pos, 3000 - 1800 - 4);
  assert.equal(a.group, b.group);
  const state = await w.call("/api/live");
  assert.equal(state.memos.length, 2);
  assert.equal(state.channels[0].status, "OPEN");
  assert.equal(state.path, "이 브라우저 (확장 프로그램 저장소)");
});

test("a time before a broadcast started is skipped with the reason", async () => {
  const { w, open } = await liveSetup();
  const r = await w.call("/api/live/memos", { at_ms: open + 600e3, text: "", channels: [CH_A, CH_B] });
  assert.equal(r.saved.length, 1);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["before"]);
  await assert.rejects(w.call("/api/live/memos", { at_ms: w.t + 3600e3, text: "", channels: [CH_A] }), /아직 오지 않은/);
  await assert.rejects(w.call("/api/live/memos", { at_ms: open, text: "", channels: [] }), /하나 이상/);
});

test("a restarted broadcast keeps the earlier one for older times", async () => {
  const { w, open } = await liveSetup();
  w.lives[CH_A] = { liveId: 112, liveTitle: "재시작", status: "OPEN", openDate: "2026-11-21 20:10:00" };
  w.t = open + 4800e3;
  await w.call("/api/live?refresh=1");
  const r = await w.call("/api/live/memos", { at_ms: open + 3000e3, text: "재시작 전", channels: [CH_A] });
  assert.equal(r.saved[0].live_id, "111");
  const r2 = await w.call("/api/live/memos", { at_ms: open + 4700e3, text: "재시작 후", channels: [CH_A] });
  assert.equal(r2.saved[0].live_id, "112");
  assert.equal(r2.saved[0].pos, 4700 - 4200 - 4);
});

test("group edit: note and time shift reach every broadcast; impossible moves change nothing", async () => {
  const { w, open } = await liveSetup();
  const r = await w.call("/api/live/memos", { at_ms: open + 3000e3, text: "곡", channels: [CH_A, CH_B] });
  const group = r.saved[0].group;
  let s = await w.call("/api/live/memos/edit", { group, text: "곡 (수정)", shift: -10 });
  assert.deepEqual(s.memos.map((m) => [m.text, m.pos]), [["곡 (수정)", 2986], ["곡 (수정)", 1186]]);
  await assert.rejects(w.call("/api/live/memos/edit", { group, shift: -1200 }), /방송 시작/);
  s = await w.call("/api/live");
  assert.deepEqual(s.memos.map((m) => m.pos), [2986, 1186]);
  await assert.rejects(w.call("/api/live/memos/edit", { id: r.saved[0].id, shift: 5 }), /전체에 적용/);
});

test("group shift moves a memo saved just after its broadcast ended by exactly the same amount", async () => {
  // B ended at 20:30:00; memos saved 5..60 s later sit at B's last second while their clock says more.
  const open = KST("2026-11-21 19:00:00");
  const w = world(open + 3 * 3600e3);
  w.lives[CH_A] = { liveId: 111, liveTitle: "A", status: "OPEN", openDate: "2026-11-21 19:00:00" };
  w.lives[CH_B] = { liveId: 222, liveTitle: "B", status: "CLOSE", openDate: "2026-11-21 19:30:00", closeDate: "2026-11-21 20:30:00" };
  await w.call("/api/live/channels", { url: CH_A });
  await w.call("/api/live/channels", { url: CH_B });
  for (const after of [5, 8, 9, 20, 59]) {
    const r = await w.call("/api/live/memos", { at_ms: KST("2026-11-21 20:30:00") + after * 1000, text: `${after}`, channels: [CH_A, CH_B] });
    const [a, b] = r.saved;
    assert.equal(b.pos, 3600);
    const s = await w.call("/api/live/memos/edit", { group: a.group, shift: -5 });
    const by = Object.fromEntries(s.memos.filter((m) => m.group === a.group).map((m) => [m.channel, m]));
    assert.deepEqual([by[CH_A].pos - a.pos, by[CH_B].pos - b.pos, by[CH_B].at_ms - b.at_ms], [-5, -5, -5000], `${after}s`);
    await w.call("/api/live/memos/edit", { group: a.group, shift: 5 });
    await assert.rejects(w.call("/api/live/memos/edit", { group: a.group, shift: 1 }), /방송 길이.*하나도 바꾸지 않았습니다/);
  }
});

test("group time set by a base memo's position uses the saved position (stale screen)", async () => {
  const { w, open } = await liveSetup();
  const r = await w.call("/api/live/memos", { at_ms: open + 3000e3, text: "곡", channels: [CH_A, CH_B] });
  const [a, b] = r.saved;
  await w.call("/api/live/memos/edit", { group: a.group, shift: -4 });  // done in another tab
  const s = await w.call("/api/live/memos/edit", { group: a.group, base: b.id, pos: b.pos - 5 });
  assert.deepEqual(s.memos.map((m) => m.pos), [a.pos - 5, b.pos - 5]);
  await assert.rejects(w.call("/api/live/memos/edit", { group: a.group, base: "nope", pos: 10 }), /그룹에 없습니다/);
  await assert.rejects(w.call("/api/live/memos/edit", { group: a.group, pos: 10 }), /채널을 골라서/);
});

test("editing one broadcast splits it from its group, and rejoin puts it back", async () => {
  const { w, open } = await liveSetup();
  const r = await w.call("/api/live/memos", { at_ms: open + 3000e3, text: "곡", channels: [CH_A, CH_B] });
  const [a, b] = r.saved;
  let s = await w.call("/api/live/memos/edit", { id: b.id, text: "B만", pos: 1000 });
  const nb = s.memos.find((m) => m.id === b.id);
  assert.equal(nb.split_from, a.group);
  assert.notEqual(nb.group, a.group);
  assert.equal(nb.pos, 1000);
  assert.equal(nb.at_ms, KST("2026-11-21 19:30:00") + 4000 + 1000e3);
  s = await w.call("/api/live/memos/rejoin", { id: b.id });
  const back = s.memos.find((m) => m.id === b.id);
  assert.equal(back.group, a.group);
  assert.equal(back.text, "곡");
  assert.equal(back.pos, b.pos);
  assert.equal("split_from" in back, false);
});

test("delete, select and remove channel", async () => {
  const { w, open } = await liveSetup();
  const r = await w.call("/api/live/memos", { at_ms: open + 3000e3, text: "x", channels: [CH_A, CH_B] });
  let s = await w.call("/api/live/memos/delete", { id: r.saved[0].id });
  assert.equal(s.memos.length, 1);
  s = await w.call("/api/live/channels/select", { id: CH_A, selected: false });
  assert.equal(s.channels[0].selected, false);
  s = await w.call("/api/live/channels/remove", { id: CH_B });
  assert.equal(s.channels.length, 1);
  assert.equal(s.memos.length, 1);  // memos of a removed channel stay
  await assert.rejects(w.call("/api/live/channels", { url: CH_A }), /이미 목록/);
  await assert.rejects(w.call("/api/live/channels", { url: "c".repeat(32) }), /채널을 찾을 수 없습니다/);
});

test("broken stored entries are dropped, kept aside, and reported once", async () => {
  const w = world(Date.now());
  await w.storage.set("live", { format: "stt-live-memos/1", channels: [{ id: CH_A, name: "A", lives: [{ live_id: 1 }] }, { id: "bad" }],
    memos: [{ id: "x" }] });
  let s = await w.call("/api/live");
  assert.equal(s.channels.length, 1);
  assert.equal(s.channels[0].live, null);  // its broken broadcast entry was dropped
  assert.equal(s.memos.length, 0);
  assert.match(s.notice, /읽을 수 없는 항목/);
  assert.ok([...w.raw.keys()].some((k) => k.startsWith("live.broken-")));
  s = await w.call("/api/live");
  assert.equal(s.notice, "");
});

// ------------------------------------------------------------------ replay lookup

async function vodSetup() {
  const w = world(KST("2026-11-22 12:00:00"));
  w.videos["16136287"] = { videoNo: 16136287, videoTitle: "다시보기", channel: { channelName: "A", channelId: CH_A },
    duration: 7200, liveOpenDate: "2026-11-21 19:00:00" };
  w.videos["16136497"] = { videoNo: 16136497, videoTitle: "길이 없음", channel: { channelName: "B", channelId: CH_B },
    duration: "abc", liveOpenDate: "2026-11-21 19:30:00" };
  const st = await w.call("/api/vod-memos");
  const r = await w.call("/api/vod-memos/videos", { store_id: st.store_id,
    lines: ["https://chzzk.naver.com/video/16136287", "16136497", "16136287", "https://chzzk.naver.com/video/999999", "nope"] });
  return { w, r, store: st.store_id };
}

test("replay: wall time parsing", () => {
  assert.deepEqual(VodStore.parseWallTime("26-11-21 19:50:00"), [KST("2026-11-21 19:50:00"), "2026-11-21 19:50:00"]);
  assert.throws(() => VodStore.parseWallTime("26-02-30 19:50:00"), (e) => e.code === "INVALID_WALL_TIME");
  assert.throws(() => VodStore.parseWallTime("2026-11-21 19:50"), (e) => e.code === "INVALID_WALL_TIME");
});

test("replay: add, find, save (idempotent), offset, delete", async () => {
  const { w, r, store } = await vodSetup();
  assert.deepEqual(r.line_results.map((x) => x.status), ["added", "added_fetch_failed", "duplicate", "added_fetch_failed", "invalid"]);
  const ready = r.state.videos.find((v) => v.vod_id === "16136287");
  assert.equal(ready.metadata_state, "ready");
  assert.equal(r.state.videos.find((v) => v.vod_id === "999999").metadata_state, "unavailable");
  const f = await w.call("/api/vod-memos/find", { wall_time: "2026-11-21 19:50:00", vod_ids: ["16136287", "16136497"] });
  assert.equal(f.results[0].status, "match");
  assert.equal(f.results[0].position_ms, 3000e3 - 4000);
  assert.equal(f.results[0].position_text, "00:49:56");
  assert.equal(f.results[1].status, "missing_duration");
  const req = { store_id: store, request_id: crypto.randomUUID(), at_ms: f.at_ms, formula_version: 1, text: " 장면 ",
    items: [{ vod_id: "16136287", registration_id: ready.registration_id, match_revision: ready.match_revision }] };
  const s1 = await w.call("/api/vod-memos/memos", req);
  const s2 = await w.call("/api/vod-memos/memos", req);
  assert.equal(s2.replayed, true);
  assert.deepEqual(s2.memo_ids, s1.memo_ids);
  assert.equal(s2.state.memos.length, 1);
  assert.equal(s2.state.memos[0].text, "장면");
  await assert.rejects(w.call("/api/vod-memos/memos", { ...req, text: "다른 내용" }), (e) => e.code === "REQUEST_ID_REUSED" && e.status === 409);
  const u = await w.call("/api/vod-memos/videos/update", { store_id: store, vod_id: "16136287", registration_id: ready.registration_id,
    manual_offset_ms: 2500, expected_match_revision: ready.match_revision });
  assert.equal(u.state.videos[0].match_revision, ready.match_revision + 1);
  const f2 = await w.call("/api/vod-memos/find", { wall_time: "26-11-21 19:50:00", vod_ids: ["16136287"] });
  assert.equal(f2.results[0].position_ms, 3000e3 - 4000 - 2500);
  await assert.rejects(w.call("/api/vod-memos/memos", { ...req, request_id: crypto.randomUUID() }), (e) => e.code === "MATCH_CHANGED");
  await assert.rejects(w.call("/api/vod-memos/videos/remove", { store_id: "x", vod_id: "16136287", registration_id: ready.registration_id }),
    (e) => e.code === "STORE_CHANGED");
  const d = await w.call("/api/vod-memos/memos/delete", { store_id: store, group: s1.group });
  assert.equal(d.state.memos.length, 0);
});

// ------------------------------------------------------------------ backup / import

test("import: desktop files and own backups add what is missing, never overwrite", async () => {
  const { w: src, open } = await liveSetup();
  await src.call("/api/live/memos", { at_ms: open + 3000e3, text: "원본", channels: [CH_A, CH_B] });
  const { w: vsrc } = await vodSetup();
  const backup = await src.backend.exportAll();
  const vodFile = (await vsrc.backend.exportAll()).vod;
  vodFile.format = "stt-vod-memos/1";

  const dst = world(Date.now());
  const r1 = await dst.backend.importData(backup.live);  // a desktop live_memos.json has the same shape
  assert.deepEqual([r1.live.channels, r1.live.memos], [2, 2]);
  const r2 = await dst.backend.importData(backup);         // again, as a backup file: nothing new
  assert.deepEqual([r2.live.channels, r2.live.memos], [0, 0]);
  const r3 = await dst.backend.importData(vodFile);
  assert.equal(r3.vod.videos, 3);
  const st = await dst.call("/api/vod-memos");
  assert.notEqual(st.store_id, vodFile.store_id);  // imported into this store, not replacing it
  await assert.rejects(dst.backend.importData({ hello: 1 }), /알 수 없는 파일/);
  const s = await dst.call("/api/live");
  assert.equal(s.memos[0].text, "원본");
});

test("unknown request and bad position are reported like the server did", async () => {
  const w = world(Date.now());
  await assert.rejects(w.call("/api/nope", {}), (e) => e.status === 404);
  await assert.rejects(w.call("/api/live/memos/edit", { id: "x", pos: -1 }), /99:59:59/);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}\n${e.stack}`);
    }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
