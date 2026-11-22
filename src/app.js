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

// ------------------------------------------------------------------ live memo tab
// Several CHZZK channels are kept in a list; a memo (wall-clock time + note) is saved for every
// checked channel as "this many minutes into the broadcast that was on air then".

const LIVE_REFRESH_MS = 120000;
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
let LIVE = null;              // last /api/live state
let liveFilter = "all";       // "all" or a channel id
let liveSortNew = true;
let liveEdit = null;          // {key, form}: the saved memo being edited ("g:<group>" or "m:<id>")
let liveTimeManual = false;   // the user set the date/time: keep it instead of following the clock
let liveTextWasEmpty = true;
let liveTimer = null;
let liveRefreshedAt = 0;
let liveEpoch = 0;            // bumped by every change; answers to loads started before a change are dropped
let liveLoadSeq = 0;
let liveLoadShown = 0;
let liveRefreshing = false;
let liveAdding = false;
const liveSaving = new Set();  // "at|text" of saves in flight (several may run: CHZZK can be slow)
let liveLastSubmit = 0;

const pad2 = (n) => String(n).padStart(2, "0");

function wallText(ms, withDate = false) {
  if (ms == null) return "?";
  const d = new Date(ms);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  if (!withDate && d.toDateString() === new Date().toDateString()) return time;
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]}) ${time}`;
}

function livePos(openMs, atMs) {
  return Math.max(0, Math.floor((atMs - openMs - LIVE.lag_ms) / 1000));
}

function setLiveClock(ms) {
  const d = new Date(ms);
  $("liveDate").value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  $("liveTime").value = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function liveInputMs() {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec($("liveDate").value);
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec($("liveTime").value);
  if (!dm || !tm) return null;
  const t = new Date(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], +(tm[3] || 0)).getTime();
  return Number.isFinite(t) ? t : null;
}

function updateLiveTimeMode() {
  $("liveTimeMode").textContent = liveTimeManual
    ? "직접 정한 시각으로 저장합니다. '지금으로'를 누르면 다시 현재 시각을 따라갑니다."
    : "시계는 현재 시각을 따라가다가 메모를 쓰기 시작하는 순간 멈추고, 그 시각으로 저장됩니다.";
}

function liveChannelName(id) {
  const ch = LIVE && LIVE.channels.find((c) => c.id === id);
  if (ch) return ch.name;
  const m = LIVE && LIVE.memos.find((x) => x.channel === id);
  return (m && m.channel_name) || id.slice(0, 8);
}

function showLiveMsg(id, text, isError) {
  const box = $(id);
  box.textContent = text || "";
  box.classList.toggle("error", !!isError);
}

function showLiveSave(lines) {
  const box = $("liveSaveMsg");
  box.textContent = "";
  for (const [text, isError] of lines) box.appendChild(el("p", isError ? "error" : "okmsg", text));
}

async function loadLive(refresh) {
  if (refresh) {
    if (liveRefreshing) return;
    liveRefreshing = true;
  }
  const epoch = liveEpoch;
  const seq = ++liveLoadSeq;
  try {
    const state = await api(`/api/live?refresh=${refresh ? 1 : 0}`);
    if (epoch === liveEpoch && seq > liveLoadShown) {
      liveLoadShown = seq;
      applyLive(state);
    }
  } catch (e) {
    showLiveMsg("liveAddMsg", e.message, true);
  } finally {
    if (refresh) liveRefreshing = false;
  }
}

async function liveChange(path, body) {
  liveEpoch++;
  const r = await api(path, { method: "POST", body });
  liveEpoch++;
  applyLive(r.state || r);
  return r;
}

function applyLive(state) {
  LIVE = state;
  const known = new Set(state.channels.map((c) => c.id).concat(state.memos.map((m) => m.channel)));
  if (liveFilter !== "all" && !known.has(liveFilter)) liveFilter = "all";
  $("livePath").textContent = state.path;
  $("liveNotice").textContent = state.notice || "";
  renderLiveChannels();
  renderLiveFilter();
  renderLiveMemos();
  updateLiveSaveButton();
}

function updateLiveSaveButton() {
  const chosen = LIVE ? LIVE.channels.filter((c) => c.selected) : [];
  const n = chosen.length;
  $("liveSave").textContent = liveSaving.size ? "저장 중..." : n ? `저장 (방송 ${n}개)` : "저장";
  $("liveSave").disabled = !n;
  // where the next memo goes, without scrolling down to the list
  const box = $("liveTargets");
  box.textContent = "";
  if (!LIVE) return;
  if (!LIVE.channels.length) {
    box.appendChild(el("span", "hint", "아래 방송 목록에 라이브 주소를 추가하고, 메모할 방송에 체크하세요."));
    return;
  }
  if (!n) {
    box.appendChild(el("span", "error", "메모할 방송이 체크되어 있지 않습니다. 아래 방송 목록에서 체크하세요."));
    return;
  }
  box.appendChild(el("span", "hint", "저장할 방송 "));
  for (const c of chosen) {
    box.appendChild(el("span", c.status === "OPEN" ? "targetchip on" : "targetchip", c.name));
  }
}

function smallButton(cls, text, onClick) {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function renderLiveChannels() {
  const box = $("liveChannels");
  box.textContent = "";
  if (!LIVE.channels.length) {
    box.appendChild(el("p", "hint", "위에 치지직 라이브 주소를 넣어 방송을 추가하세요. 여러 개를 넣어 두고 메모할 방송만 체크하면 됩니다."));
    return;
  }
  for (const ch of LIVE.channels) {
    const row = el("div", ch.selected ? "lch on" : "lch");
    const top = el("div", "lchtop");
    const sel = el("label", "lchsel");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = ch.selected;
    cb.addEventListener("change", () => {
      const want = cb.checked;
      ch.selected = want;  // a save pressed before the server answers must already use the new selection
      row.classList.toggle("on", want);
      updateLiveSaveButton();
      liveChange("/api/live/channels/select", { id: ch.id, selected: want }).catch((e) => {
        ch.selected = !want;
        cb.checked = !want;
        row.classList.toggle("on", !want);
        updateLiveSaveButton();
        showLiveMsg("liveAddMsg", e.message, true);
      });
    });
    sel.appendChild(cb);
    sel.appendChild(el("span", "lchname", ch.name));
    if (ch.status === "OPEN") sel.appendChild(el("span", "livebadge on", "방송 중"));
    else sel.appendChild(el("span", "livebadge", ch.status === "CLOSE" ? "방송 종료" : "방송 기록 없음"));
    top.appendChild(sel);
    const acts = el("span", "lchacts");
    const mine = liveBroadcasts(ch.id);
    const latest = mine.at(-1);
    if (latest) {
      // one click per streamer after a collab: that streamer's newest broadcast as "HH:mm:ss 메모" lines
      // a streamer who restarted has several broadcasts: this copies only the newest one (say so)
      const cp = smallButton("secondary small", mine.length > 1 ? "최근 방송 메모 복사" : "메모 복사",
        () => copyLiveShifted((sh) => liveMemoLines(latest, sh), cp));
      cp.title = `${wallText(latest.open_ms, true)} 시작 방송의 메모 ${latest.items.length}개를 방송 위치 순으로 복사`;
      acts.appendChild(cp);
    }
    const link = el("a", null, "치지직에서 보기");
    link.href = `https://chzzk.naver.com/live/${ch.id}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    acts.appendChild(link);
    acts.appendChild(smallButton("linkbtn", "빼기", () => {
      if (!window.confirm(`'${ch.name}' 채널을 목록에서 뺄까요? 저장한 메모는 그대로 남습니다.`)) return;
      liveChange("/api/live/channels/remove", { id: ch.id }).catch((e) => showLiveMsg("liveAddMsg", e.message, true));
    }));
    top.appendChild(acts);
    row.appendChild(top);
    const lv = ch.live;
    if (lv) {
      // one line: when it started (and where it is now) · the title
      const meta = el("div", "lchmeta");
      if (ch.status === "OPEN") {
        meta.appendChild(document.createTextNode(`${wallText(lv.open_ms)} 시작 · 지금 `));
        const pos = el("b", "lchpos", hms(livePos(lv.open_ms, Date.now())));
        pos.dataset.open = lv.open_ms;
        meta.appendChild(pos);
      } else {
        meta.appendChild(document.createTextNode(`마지막 방송 ${wallText(lv.open_ms)} ~ ${wallText(lv.close_ms)}`));
      }
      if (lv.title) meta.appendChild(el("span", "lchtitle", ` · ${lv.title}`));
      meta.title = lv.title || "";
      row.appendChild(meta);
    }
    if (ch.error) row.appendChild(el("div", "error lcherr", `방송 정보를 새로 가져오지 못했습니다: ${ch.error}`));
    box.appendChild(row);
  }
}

// "모두 체크" / "모두 해제" in the channel list; the save button and the target chips follow at once
async function setAllLiveChannels(selected) {
  if (!LIVE) return;
  const todo = LIVE.channels.filter((c) => c.selected !== selected);
  if (!todo.length) return;
  for (const c of todo) c.selected = selected;
  renderLiveChannels();
  updateLiveSaveButton();
  liveEpoch++;  // answers to loads started before this are dropped
  try {
    let state = null;
    for (const c of todo) state = await api("/api/live/channels/select", { method: "POST", body: { id: c.id, selected } });
    liveEpoch++;
    applyLive(state);  // once, at the end: no flicker of the channels not sent yet
  } catch (e) {
    liveEpoch++;
    showLiveMsg("liveAddMsg", e.message, true);
    loadLive(false);
  }
}

function liveFilterChannels() {
  // listed channels first, then channels taken off the list that still have memos
  const ids = LIVE.channels.map((c) => c.id);
  for (const m of LIVE.memos) if (!ids.includes(m.channel)) ids.push(m.channel);
  return ids;
}

function renderLiveFilter() {
  const box = $("liveFilter");
  box.textContent = "";
  const counts = new Map();
  for (const m of LIVE.memos) counts.set(m.channel, (counts.get(m.channel) || 0) + 1);
  const ids = liveFilterChannels();
  const chip = (key, label) => box.appendChild(smallButton(liveFilter === key ? "chip on" : "chip", label, () => {
    liveFilter = key;
    liveEdit = null;
    renderLiveFilter();
    renderLiveMemos();
  }));
  chip("all", `전체 ${new Set(LIVE.memos.map((m) => m.group)).size}`);
  for (const id of ids) chip(id, `${liveChannelName(id)} ${counts.get(id) || 0}`);
  $("liveCopy").textContent = liveCopyLabel();
  $("liveCopy").disabled = !LIVE.memos.some((m) => liveFilter === "all" || m.channel === liveFilter);
  $("liveCopyWall").disabled = $("liveCopy").disabled;
}

function liveGroups() {
  // memos saved together (one time + note for several broadcasts)
  const map = new Map();
  for (const m of LIVE.memos) {
    if (!map.has(m.group)) map.set(m.group, { group: m.group, at_ms: m.at_ms, text: m.text, items: [] });
    map.get(m.group).items.push(m);
  }
  return [...map.values()].sort((a, b) => a.at_ms - b.at_ms);
}

function liveBroadcasts(channel) {
  // one channel's memos per broadcast, each sorted by position
  const map = new Map();
  for (const m of LIVE.memos) {
    if (m.channel !== channel) continue;
    if (!map.has(m.live_id)) map.set(m.live_id, { open_ms: m.open_ms, title: m.live_title, items: [] });
    map.get(m.live_id).items.push(m);
  }
  const list = [...map.values()].sort((a, b) => a.open_ms - b.open_ms);
  for (const lv of list) lv.items.sort((a, b) => a.pos - b.pos || a.at_ms - b.at_ms);
  return list;
}

function memoText(text) {
  return el("span", text ? "lmtext" : "lmtext muted", text || "(메모 없음)");
}

function deleteLive(body, question) {
  if (!window.confirm(question)) return;
  liveChange("/api/live/memos/delete", body).catch((e) => showLiveSave([[e.message, true]]));
}

// ---- editing a saved memo in place
// "전체": the note of a memo in every broadcast it was saved for. One channel: that memo's note and position.

function parseHms(text) {
  const m = /^\s*(?:(\d{1,2})\s*:\s*)?(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(text || "");
  if (!m || +m[2] > 59 || +m[3] > 59) return null;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]);
}

function startLiveEdit(key) {
  liveEdit = { key };
  renderLiveMemos(true);
}

function stopLiveEdit() {
  liveEdit = null;
  renderLiveMemos(true);
}

const LIVE_EDIT_BASE_KEY = "stt-timeline-live-edit-base";

// One editor for both views.
//  group: g.group + bases = every memo of the group. A base streamer and its position are shown; changing the
//         position moves every broadcast of the group by the same number of seconds (sent as `shift`).
//  one memo: id + bases = [that memo]. When it was saved together with others, "같이 저장한 방송에도 적용"
//         (on by default) sends the change to the whole group instead, so the broadcasts never drift apart.
function liveEditor({ group, id, text, bases, shared = 0 }) {
  const edit = liveEdit;
  const wrap = el("div", "lmeditwrap");
  const form = el("form", "lmedit");
  form.noValidate = true;
  let sel = null;
  if (bases.length > 1) {
    sel = el("select", "lmeditbase");
    sel.setAttribute("aria-label", "기준 방송");
    for (const b of bases) {
      const o = el("option", null, liveChannelName(b.channel));
      o.value = b.channel;
      sel.appendChild(o);
    }
    const remembered = storeGet(LIVE_EDIT_BASE_KEY);
    if (bases.some((b) => b.channel === remembered)) sel.value = remembered;
    form.appendChild(sel);
  }
  const base = () => bases.find((b) => b.channel === (sel ? sel.value : bases[0].channel)) || bases[0];
  const posIn = el("input", "lmeditpos");
  posIn.type = "text";
  posIn.inputMode = "numeric";
  posIn.value = hms(base().pos);
  posIn.placeholder = "HH:mm:ss";
  posIn.setAttribute("aria-label", "방송 위치 (HH:mm:ss)");
  form.appendChild(posIn);
  const textIn = el("input", "lmedittext");
  textIn.type = "text";
  textIn.maxLength = 500;
  textIn.value = text || "";
  textIn.placeholder = "메모 (비워 둬도 됩니다)";
  textIn.setAttribute("aria-label", "메모");
  const save = el("button", "primary small", "저장");
  save.type = "submit";
  const cancel = smallButton("linkbtn lmeditbtn", "취소", stopLiveEdit);
  form.append(textIn, save, cancel);
  wrap.appendChild(form);
  let together = null;
  if (id && shared > 1) {
    const lab = el("label", "switch lmedittogether");
    together = document.createElement("input");
    together.type = "checkbox";
    together.checked = true;
    lab.append(together, ` 같이 저장한 방송 ${shared}개 모두에 적용 (시간은 같은 초만큼 옮김)`);
    wrap.appendChild(lab);
  }
  const msg = el("div", "error lmediterr");
  msg.setAttribute("role", "alert");
  const note = el("p", "hint lmedithint");
  wrap.append(msg, note);
  const groupWide = () => !id || (together && together.checked);
  const describe = () => {
    const p = parseHms(posIn.value);
    const delta = p == null ? 0 : p - base().pos;
    const n = id ? shared : bases.length;
    const moved = delta ? `${Math.abs(delta)}초 ${delta < 0 ? "앞당겨집니다" : "늦춰집니다"}` : "";
    if (groupWide() && n > 1) {
      note.textContent = delta ? `같이 저장한 방송 ${n}개의 시간이 모두 ${moved}. 실제 시각도 함께 바뀝니다.`
        : `내용은 같이 저장한 방송 ${n}개 모두 바뀝니다. 시간을 바꾸면 모두 같은 초만큼 옮겨집니다.`;
    } else if (id && shared > 1) {
      note.textContent = "이 방송의 메모만 바뀝니다. 이 메모는 그룹에서 떨어져 '따로 수정됨'으로 표시되고, "
        + "이후 전체에서 고친 내용은 반영되지 않습니다.";
    } else {
      note.textContent = delta ? `시간이 ${moved}. 실제 시각도 함께 바뀝니다.` : "위치를 바꾸면 실제 시각도 함께 바뀝니다.";
    }
  };
  posIn.addEventListener("input", describe);
  if (together) together.addEventListener("change", describe);
  if (sel) {
    sel.addEventListener("change", () => {
      storeSet(LIVE_EDIT_BASE_KEY, sel.value);
      posIn.value = hms(base().pos);
      describe();
    });
  }
  describe();
  form.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); stopLiveEdit(); }
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (save.disabled) return;
    const p = parseHms(posIn.value);
    if (p == null) {
      msg.textContent = "방송 위치는 시:분:초로 쓰세요. 예: 01:10:44";
      posIn.focus();
      return;
    }
    // group: send where the base memo should go, not "move by n seconds". The server works the amount out
    // from the saved position, so a list that had not caught up with an earlier change (another tab, a save
    // still on its way) still puts the base exactly where it was typed, and every other broadcast moves as much.
    const b = base();
    const payload = groupWide()
      ? { group: group || b.group, text: textIn.value, ...(p !== b.pos ? { base: b.id, pos: p } : {}) }
      : { id, text: textIn.value, pos: p };
    save.disabled = true;
    msg.textContent = "";
    liveEpoch++;
    try {
      const state = await api("/api/live/memos/edit", { method: "POST", body: payload });
      liveEpoch++;
      if (liveEdit === edit) liveEdit = null;
      applyLive(state);
    } catch (e) {
      msg.textContent = e.message;
      save.disabled = false;
    }
  });
  edit.form = form;
  requestAnimationFrame(() => { textIn.focus(); textIn.select(); });
  return wrap;
}

function rejoinLive(m) {
  if (!window.confirm("같이 저장했던 메모의 내용 · 실제 시각으로 맞추고 다시 묶을까요? 이 방송에서 따로 고친 내용은 사라집니다.")) return;
  liveChange("/api/live/memos/rejoin", { id: m.id }).catch((e) => showLiveSave([[e.message, true]]));
}

function splitTag(m) {
  const t = el("span", "tag lmsplit", "따로 수정됨");
  t.title = "이 방송에서만 따로 고친 메모입니다. 전체에서 고친 내용이 반영되지 않습니다.";
  return t;
}

function renderLiveMemos(force = false) {
  const box = $("liveMemos");
  if (liveEdit && !force) {
    // a refresh while typing: keep the editor; the list catches up when the edit is saved or cancelled
    if (liveEdit.form && box.contains(liveEdit.form)) return;
    liveEdit = null;
  }
  box.textContent = "";
  if (liveFilter === "all") {
    const groups = liveGroups();
    if (liveSortNew) groups.reverse();
    if (!groups.length) box.appendChild(el("p", "hint", "아직 저장한 메모가 없습니다."));
    for (const g of groups) {
      const row = el("div", "lmemo");
      const head = el("div", "lmhead");
      head.appendChild(el("span", "lmat", wallText(g.at_ms)));
      const key = `g:${g.group}`;
      if (liveEdit && liveEdit.key === key) {
        head.appendChild(liveEditor({ group: g.group, text: g.text, bases: g.items }));
      } else {
        head.appendChild(memoText(g.text));
        if (g.items.length === 1 && g.items[0].split_from) head.appendChild(splitTag(g.items[0]));
        head.appendChild(smallButton("linkbtn lmeditbtn", "수정", () => startLiveEdit(key)));
        head.appendChild(smallButton("linkbtn", "삭제", () => deleteLive({ group: g.group },
          g.items.length > 1 ? `이 메모를 방송 ${g.items.length}개에서 모두 지울까요?` : "이 메모를 지울까요?")));
      }
      row.appendChild(head);
      const pos = el("div", "lmpos");
      for (const m of g.items) {
        const c = el("span", "poschip");
        c.appendChild(el("span", null, liveChannelName(m.channel)));
        c.appendChild(el("b", null, hms(m.pos)));
        pos.appendChild(c);
      }
      row.appendChild(pos);
      const apart = LIVE.memos.filter((o) => o.split_from === g.group);
      if (apart.length) {
        row.appendChild(el("p", "hint lmapart", "따로 수정되어 이 줄에 포함되지 않은 방송: "
          + apart.map((o) => `${liveChannelName(o.channel)} ${hms(o.pos)}`).join(", ")
          + " — 채널을 골라 '다시 묶기'로 합칠 수 있습니다."));
      }
      box.appendChild(row);
    }
    return;
  }
  const blocks = liveBroadcasts(liveFilter);
  if (liveSortNew) { blocks.reverse(); blocks.forEach((lv) => lv.items.reverse()); }
  if (!blocks.length) box.appendChild(el("p", "hint", "이 방송에 저장한 메모가 없습니다."));
  for (const lv of blocks) {
    const head = el("div", "lmlive");
    head.appendChild(el("span", null, `${wallText(lv.open_ms, true)} 시작 방송${lv.title ? " · " + lv.title : ""}`));
    if (blocks.length > 1) {
      // several broadcasts: each one can be copied on its own, ready to paste as a comment
      const b = smallButton("secondary small", "이 방송 복사", () => copyLiveShifted((sh) => liveMemoLines(lv, sh), b));
      head.appendChild(b);
    }
    box.appendChild(head);
    for (const m of lv.items) {
      const key = `m:${m.id}`;
      if (liveEdit && liveEdit.key === key) {
        const shared = LIVE.memos.filter((o) => o.group === m.group).length;
        const row = el("div", "lmemo");
        row.appendChild(liveEditor({ id: m.id, text: m.text, bases: [m], shared }));
        box.appendChild(row);
        continue;
      }
      const row = el("div", "lmemo lmone");
      row.appendChild(el("b", "lmposbig", hms(m.pos)));
      row.appendChild(memoText(m.text));
      if (m.split_from) row.appendChild(splitTag(m));
      row.appendChild(el("span", "lmat muted", `실제 ${wallText(m.at_ms)}`));
      if (m.split_from) row.appendChild(smallButton("linkbtn lmeditbtn", "다시 묶기", () => rejoinLive(m)));
      row.appendChild(smallButton("linkbtn lmeditbtn", "수정", () => startLiveEdit(key)));
      row.appendChild(smallButton("linkbtn", "삭제", () => deleteLive({ id: m.id }, "이 메모를 이 방송에서 지울까요?")));
      box.appendChild(row);
    }
  }
}

// Copy format is a ready-to-paste timestamp comment: one "HH:mm:ss 메모" line per memo, in broadcast
// order (earliest position first, whatever the list's sort), using that streamer's own position.
// shift: seconds added to every time (the "복사 시간 보정" box; negative = earlier), never below 00:00:00.
// withWall: start each line with the real (wall-clock) moment, "(실제시간 - yyyy-MM-dd HH:mm:ss) ";
// it moves with the correction so it stays the moment that position was on screen.
function liveMemoLines(lv, shift = 0, withWall = false) {
  // always broadcast order: the list on screen may be showing (and holding) the newest first
  const items = [...lv.items].sort((a, b) => a.pos - b.pos || a.at_ms - b.at_ms);
  return items.map((m) => {
    const pos = Math.max(0, m.pos + shift);
    const line = m.text ? `${hms(pos)} ${m.text}` : hms(pos);
    return withWall ? `(실제시간 - ${wallFull(m.at_ms + (pos - m.pos) * 1000)}) ${line}` : line;
  }).join("\n");
}

function wallFull(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function liveCopyText(shift = 0, withWall = false) {
  const channels = liveFilter === "all" ? liveFilterChannels() : [liveFilter];
  const blocks = [];
  for (const id of channels) {
    for (const lv of liveBroadcasts(id)) blocks.push({ id, lv });
  }
  // a single broadcast of a single streamer is the usual case: just the lines, nothing else
  if (blocks.length === 1) return liveMemoLines(blocks[0].lv, shift, withWall);
  return blocks.map(({ id, lv }) =>
    `[${liveChannelName(id)}] ${wallText(lv.open_ms, true)} 시작 방송${lv.title ? " · " + lv.title : ""}\n${liveMemoLines(lv, shift, withWall)}`,
  ).join("\n\n");
}

function liveCopyLabel() {
  return liveFilter === "all" ? "전체 복사" : `${liveChannelName(liveFilter)} 복사`;
}

// label: the button's normal text, or a function giving it (the top button's label follows the filter)
function copyLive(text, button, label = button.textContent) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    clearTimeout(button.copiedTimer);
    button.textContent = "복사됨";
    button.copiedTimer = setTimeout(() => {
      if (button.textContent === "복사됨") button.textContent = typeof label === "function" ? label() : label;
    }, 1500);
  }).catch((e) => showLiveSave([[`복사하지 못했습니다: ${e.message}`, true]]));
}

// ---- copy time correction and the comment draft box

const LIVE_SHIFT_KEY = "stt-timeline-live-copy-shift";
const LIVE_DRAFT_KEY = "stt-timeline-live-copy-draft";
const LIVE_SHIFT_MAX = 36000;  // ±10 h

function storeGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function storeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* private window / blocked storage: still works for this visit */ }
}

// A "복사 시간 보정" box: "-3", "-3초", "+2", "2" -> seconds; "" -> 0; anything else -> null.
function parseCopyShift(value) {
  const v = String(value || "").replace(/\s+/g, "").replace(/초$/, "").replace(/^−/, "-");
  if (!v) return 0;
  if (!/^[+-]?\d{1,5}$/.test(v) || Math.abs(+v) > LIVE_SHIFT_MAX) return null;
  return +v;
}

function liveCopyShift() {
  return parseCopyShift($("liveShift").value);
}

function updateLiveShift() {
  const shift = liveCopyShift();
  const note = $("liveShiftNote");
  note.classList.toggle("error", shift == null);
  note.classList.toggle("hint", shift != null);
  if (shift == null) note.textContent = "초 단위 정수로 쓰세요. 예: -3 (3초 앞당김), 2 (2초 늦춤)";
  else if (!shift) note.textContent = "저장된 시각 그대로 복사합니다.";
  else note.textContent = `복사할 때 모든 시각을 ${Math.abs(shift)}초 ${shift < 0 ? "앞당깁니다" : "늦춥니다"}. `
    + `예: 00:10:05 → ${hms(Math.max(0, 605 + shift))}`;
  updateDraftShiftButton();
}

// The comment draft card is shared by the live memo and replay tabs: it moves to whichever is shown,
// and "시각 보정 적용" uses that tab's copy time correction.
function draftShiftBox() {
  const vod = $("tab-vod");
  return vod && !vod.classList.contains("hidden") && $("vodShift") ? $("vodShift") : $("liveShift");
}

function draftShift() {
  return parseCopyShift(draftShiftBox().value);
}

function updateDraftShiftButton() {
  const shift = draftShift();
  const btn = $("liveDraftShift");
  btn.disabled = !shift;
  btn.textContent = shift ? `시각 ${shift < 0 ? "-" : "+"}${Math.abs(shift)}초 적용` : "시각 보정 적용";
}

function placeDraftCard(tab) {
  const card = $("draftCard");
  const main = $(`tab-${tab}`);
  if (!card || !main || (tab !== "live" && tab !== "vod")) return;
  const columns = main.querySelectorAll(".column");
  const target = columns[columns.length - 1];
  const before = tab === "vod" ? $("vodCopyBox") : null;  // under the saved memos, above the replay tab's fallback boxes
  if (before && before.parentNode === target) target.insertBefore(card, before);
  else if (card.parentNode !== target) target.appendChild(card);
  updateDraftShiftButton();
}

function copyLiveShifted(build, button, label) {
  const shift = liveCopyShift();
  if (shift == null) {
    updateLiveShift();
    $("liveShift").focus();
    return;
  }
  copyLive(build(shift), button, label);
}

// Shift the time at the start of each line of a pasted comment ("1:02:03 ...", "02:03 ..."), leaving the rest alone.
function shiftLineTimes(text, shift) {
  let n = 0;
  const re = /^([ \t]*)(?:\(실제시간 - (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\)([ \t]+))?((?:\d{1,2}:)?\d{1,2}:\d{2})(?=[ \t]|$)/gm;
  const out = text.replace(re, (all, lead, y, mo, d, hh, mi, ss, gap, t) => {
    const p = parseHms(t);
    if (p == null) return all;
    n++;
    const pos = Math.max(0, p + shift);
    const wall = y ? `(실제시간 - ${wallFull(new Date(+y, mo - 1, +d, +hh, +mi, +ss).getTime() + (pos - p) * 1000)})${gap}` : "";
    return lead + wall + hms(pos);
  });
  return { text: out, count: n };
}

function setDraft(text) {
  $("liveDraft").value = text;
  storeSet(LIVE_DRAFT_KEY, text);
}

function showDraftMsg(text, undo) {
  const msg = $("liveDraftMsg");
  msg.textContent = text;
  if (undo != null) {
    const b = smallButton("linkbtn lmeditbtn", "되돌리기", () => {
      setDraft(undo);
      showDraftMsg("되돌렸습니다.");
    });
    msg.append(" ", b);
  }
}

function bindLiveDraft() {
  const shiftBox = $("liveShift");
  shiftBox.value = storeGet(LIVE_SHIFT_KEY) || "";
  shiftBox.addEventListener("input", () => {
    storeSet(LIVE_SHIFT_KEY, shiftBox.value);
    updateLiveShift();
  });
  updateLiveShift();
  const vodShift = $("vodShift");
  if (vodShift) vodShift.addEventListener("input", updateDraftShiftButton);

  const draft = $("liveDraft");
  draft.value = storeGet(LIVE_DRAFT_KEY) || "";
  draft.addEventListener("input", () => {
    storeSet(LIVE_DRAFT_KEY, draft.value);
    $("liveDraftMsg").textContent = "";
  });
  $("liveDraftShift").addEventListener("click", () => {
    const shift = draftShift();
    if (!shift) return;
    const before = draft.value;
    const r = shiftLineTimes(before, shift);
    if (!r.count) {
      showDraftMsg("줄 맨 앞에 시:분:초가 있는 줄이 없습니다.");
      return;
    }
    setDraft(r.text);
    showDraftMsg(`${r.count}줄의 시각을 ${Math.abs(shift)}초 ${shift < 0 ? "앞당겼습니다" : "늦췄습니다"}.`, before);
  });
  $("liveDraftCopy").addEventListener("click", () => copyLive(draft.value.trim(), $("liveDraftCopy")));
  $("liveDraftClear").addEventListener("click", () => {
    if (!draft.value) return;
    const before = draft.value;
    setDraft("");
    showDraftMsg("비웠습니다.", before);
    draft.focus();
  });
}

function skipText(s) {
  const name = s.name || liveChannelName(s.channel);
  if (s.reason === "after") return `${name}: 방송이 ${wallText(s.ref_ms)}에 끝나서 그 시각에는 방송 중이 아니었습니다. 저장하지 않았습니다.`;
  if (s.reason === "before") return `${name}: ${wallText(s.ref_ms)}에 시작한 방송보다 이른 시각이라 저장하지 않았습니다. `
    + "그 전에 방송을 껐다 다시 켰다면, 앞 방송은 앱이 확인한 적이 없어 시작 시각을 알 수 없습니다.";
  if (s.reason === "unknown_end") return `${name}: 이 방송이 언제 끝났는지 앱이 확인하지 못했습니다. `
    + `마지막으로 방송 중인 것을 본 ${wallText(s.ref_ms)} 이후 시각이라, 위치를 추측하지 않고 저장하지 않았습니다.`;
  if (s.reason === "none") return `${name}: 방송한 기록이 없어 저장하지 않았습니다.`;
  if (s.reason === "error") return `${name}: ${s.detail} 저장하지 않았습니다.`;
  return `${name}: 목록에서 빠진 채널이라 저장하지 않았습니다.`;
}

async function saveLiveMemo() {
  if (!LIVE) return;
  const ids = LIVE.channels.filter((c) => c.selected).map((c) => c.id);
  if (!ids.length) return showLiveSave([["메모할 방송을 위 목록에서 체크하세요.", true]]);
  const text = $("liveText").value;
  if (!text && Date.now() - liveLastSubmit < 1000) return;  // a double Enter must not add an empty memo
  if (!liveTimeManual && !text) setLiveClock(Date.now());  // a quick mark is "now", not the last clock tick
  const at = liveInputMs();
  if (at == null) return showLiveSave([["날짜와 시각을 확인하세요.", true]]);
  if (at > Date.now() + 60000) return showLiveSave([["아직 오지 않은 시각입니다. 날짜와 시각을 확인하세요.", true]]);
  const key = `${at}|${text}`;
  if (liveSaving.has(key)) return;  // the same memo is already being saved
  const manual = liveTimeManual;
  liveLastSubmit = Date.now();
  liveSaving.add(key);
  updateLiveSaveButton();
  // the box is free for the next memo while this one is saved (fetching CHZZK can take seconds)
  $("liveText").value = "";
  liveTextWasEmpty = true;
  if (!manual) setLiveClock(Date.now());
  try {
    const r = await liveChange("/api/live/memos", { at_ms: at, text, channels: ids });
    const lines = [];
    if (r.saved.length) {
      const where = r.saved.map((m) => `${liveChannelName(m.channel)} ${hms(m.pos)}${m.stale ? " (치지직 연결 실패: 저장해 둔 방송 정보로 계산)" : ""}`);
      lines.push([`${wallText(at)} ${text ? `"${text}" ` : ""}저장 · ${where.join(" · ")}`, false]);
    }
    for (const s of r.skipped) lines.push([skipText(s), true]);
    showLiveSave(lines);
    if (r.saved.length && manual && liveTimeManual) {
      liveTimeManual = false;  // back to following the clock after a memo for a typed time
      if (!$("liveText").value) setLiveClock(Date.now());
      updateLiveTimeMode();
    }
    if (!r.saved.length) restoreLiveText(text);
  } catch (e) {
    showLiveSave([[e.message, true]]);
    restoreLiveText(text);
  } finally {
    liveSaving.delete(key);
    updateLiveSaveButton();
  }
}

function restoreLiveText(text) {
  // nothing was saved: give the memo back unless the user already started the next one
  if (text && !$("liveText").value) {
    $("liveText").value = text;
    liveTextWasEmpty = false;
  }
}

async function addLiveChannel() {
  if (liveAdding) return;
  const url = $("liveUrl").value.trim();
  if (!url) return showLiveMsg("liveAddMsg", "치지직 라이브 주소를 넣으세요.", true);
  liveAdding = true;
  $("liveAdd").disabled = true;
  showLiveMsg("liveAddMsg", "채널 정보를 가져오는 중...", false);
  try {
    const state = await liveChange("/api/live/channels", { url });
    $("liveUrl").value = "";
    const added = state.channels[state.channels.length - 1];
    showLiveMsg("liveAddMsg", added ? `'${added.name}' 채널을 추가하고 체크해 두었습니다.` : "", false);
  } catch (e) {
    showLiveMsg("liveAddMsg", e.message, true);
  } finally {
    liveAdding = false;
    $("liveAdd").disabled = false;
  }
}

function liveTick() {
  if ($("tab-live").classList.contains("hidden") || !LIVE) return;
  const now = Date.now();
  if (!liveTimeManual && !$("liveText").value) setLiveClock(now);
  document.querySelectorAll("#liveChannels .lchpos").forEach((b) => { b.textContent = hms(livePos(+b.dataset.open, now)); });
  if (document.visibilityState === "visible" && now - liveRefreshedAt > LIVE_REFRESH_MS) {
    liveRefreshedAt = now;
    loadLive(true);
  }
}

function showLiveTab() {
  if (!liveTimer) liveTimer = setInterval(liveTick, 1000);
  if (!liveTimeManual && !$("liveText").value) setLiveClock(Date.now());
  updateLiveTimeMode();
  loadLive(false);  // the saved list at once, then fresh broadcast status from CHZZK
  liveRefreshedAt = Date.now();
  loadLive(true);
}

function bindLive() {
  $("liveAdd").addEventListener("click", addLiveChannel);
  $("liveUrl").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.isComposing && ev.keyCode !== 229) addLiveChannel();
  });
  $("liveRefresh").addEventListener("click", () => { liveRefreshedAt = Date.now(); loadLive(true); });
  $("liveCheckAll").addEventListener("click", () => setAllLiveChannels(true));
  $("liveCheckNone").addEventListener("click", () => setAllLiveChannels(false));
  for (const id of ["liveDate", "liveTime"]) {
    $(id).addEventListener("input", () => { liveTimeManual = true; updateLiveTimeMode(); });
  }
  $("liveNow").addEventListener("click", () => {
    liveTimeManual = false;
    setLiveClock(Date.now());
    updateLiveTimeMode();
  });
  $("liveText").addEventListener("input", () => {
    // the moment the memo is started is the moment being noted, not when Enter is pressed
    const empty = !$("liveText").value;
    if (!liveTimeManual && liveTextWasEmpty && !empty) setLiveClock(Date.now());
    liveTextWasEmpty = empty;
  });
  $("liveText").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    if (!ev.repeat) saveLiveMemo();  // a held Enter must not save a row of empty memos
  });
  document.addEventListener("visibilitychange", () => {
    // background tabs throttle the 1 s clock; show the real time again on return
    if (document.visibilityState === "visible" && !liveTimeManual && !$("liveText").value) setLiveClock(Date.now());
  });
  $("liveSave").addEventListener("click", saveLiveMemo);
  $("liveSort").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-sort]");
    if (!b) return;
    liveSortNew = b.dataset.sort === "new";
    liveEdit = null;
    document.querySelectorAll("#liveSort button").forEach((x) => x.classList.toggle("on", x === b));
    if (LIVE) renderLiveMemos();
  });
  $("liveCopy").addEventListener("click", () => {
    if (LIVE) copyLiveShifted((sh) => liveCopyText(sh), $("liveCopy"), liveCopyLabel);
  });
  $("liveCopyWall").addEventListener("click", () => {
    if (LIVE) copyLiveShifted((sh) => liveCopyText(sh, true), $("liveCopyWall"), "실제 시간 포함 복사");
  });
  bindLiveDraft();
}

// ------------------------------------------------------------------ tabs

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  for (const t of ["live", "vod", "backup"]) $(`tab-${t}`).classList.toggle("hidden", name !== t);
  storeSet(TAB_KEY, name);
  placeDraftCard(name);
  if (name === "live") showLiveTab();
  if (name === "vod") showVodTab();
}

// ------------------------------------------------------------------ backup / import

function downloadJson(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  const a = el("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function importSummary(r) {
  const parts = [];
  if (r.live) {
    parts.push(`라이브 메모: 채널 ${r.live.channels}개, 메모 ${r.live.memos}개를 더했습니다`
      + (r.live.skippedChannels ? ` (채널 수 제한으로 ${r.live.skippedChannels}개는 넣지 못했습니다)` : "")
      + (r.live.dropped ? " · 읽을 수 없는 항목은 건너뛰었습니다" : ""));
  }
  if (r.vod) {
    parts.push(`다시보기: 영상 ${r.vod.videos}개, 메모 ${r.vod.memos}개를 더했습니다`
      + (r.vod.skippedVideos ? ` (영상 수 제한으로 ${r.vod.skippedVideos}개는 넣지 못했습니다)` : ""));
  }
  return parts.join(" / ") || "더할 내용이 없었습니다.";
}

function bindBackup() {
  $("backupExport").addEventListener("click", async () => {
    try {
      const data = await BACKEND.exportAll();
      const d = new Date();
      const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
      downloadJson(`chzzk-memo-backup-${stamp}.json`, data);
      const nl = data.live ? data.live.memos.length : 0;
      const nv = data.vod ? data.vod.memos.length : 0;
      showLiveMsg("backupMsg", `라이브 메모 ${nl}개, 다시보기 메모 ${nv}개를 백업 파일로 내려받았습니다.`, false);
    } catch (e) {
      showLiveMsg("backupMsg", `백업하지 못했습니다: ${e.message}`, true);
    }
  });
  $("importFile").addEventListener("change", async (ev) => {
    const input = ev.target;
    const box = $("importMsg");
    box.textContent = "";
    for (const file of [...input.files]) {
      let line;
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("파일이 너무 큽니다 (20MB 초과).");
        let data;
        try { data = JSON.parse(await file.text()); } catch (_) { throw new Error("JSON 파일이 아닙니다."); }
        line = [`${file.name}: ${importSummary(await BACKEND.importData(data))}`, false];
      } catch (e) {
        line = [`${file.name}: ${e.message}`, true];
      }
      box.appendChild(el("p", line[1] ? "error" : "okmsg", line[0]));
    }
    input.value = "";
    loadLive(false);
    showVodTab();
  });
}

// ------------------------------------------------------------------ other open tabs of the extension

// Another tab (or the import) changed the stored memos: show them here too, without redrawing for nothing.
const syncLive = debounce(async () => {
  if (!LIVE) return;
  const epoch = liveEpoch;
  try {
    const s = await api("/api/live");
    if (epoch !== liveEpoch || !LIVE) return;
    if (JSON.stringify([s.channels, s.memos]) === JSON.stringify([LIVE.channels, LIVE.memos])) return;
    applyLive(s);
  } catch (_) { /* the next refresh shows the error */ }
}, 300);

const syncVod = debounce(() => {
  if (!$("tab-vod").classList.contains("hidden")) showVodTab();
}, 300);

function bindSync() {
  if (!(typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged)) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.live) syncLive();
    if (changes.vod) syncVod();
  });
}

function init() {
  try { $("ver").textContent = `v${chrome.runtime.getManifest().version}`; } catch (_) { /* opened outside the extension */ }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  bindLive();
  bindVod();
  bindBackup();
  bindSync();
  const last = storeGet(TAB_KEY);
  switchTab(["live", "vod", "backup"].includes(last) ? last : "live");
}

init();
