/* Replay lookup: KST parsing belongs to the server; drafts never come from snapshots. */
(() => {
  "use strict";
  const BASE = "/api/vod-memos";
  const PENDING_KEY = "stt-vod-memo-pending-v1";
  const RECOVERY_KEY = PENDING_KEY + "-recovery";
  const SHIFT_KEY = "stt-vod-copy-shift";
  const SHIFT_MAX = 36000;  // ±10 h
  const S = {
    state: null, retired: new Set(), loadSeq: 0, shown: 0, epoch: 0, generation: 0,
    query: null, queryStatus: "idle", selected: new Set(), editing: new Set(),
    addBusy: false, refreshBusy: false, batchBusy: false, checkBusy: false, saveCooldown: false, mutations: 0, queue: Promise.resolve(),
    pending: null, saving: false, saveMessage: "", recovery: "", sessionInvalid: false, filter: "all", sortNew: true, bound: false,
  };
  const statusText = {
    before: "방송 시작 전 시각입니다", after: "다시보기 길이를 벗어난 시각입니다",
    missing_start: "방송 시작 시각을 확인할 수 없습니다", missing_duration: "영상 길이를 확인할 수 없습니다",
    unavailable: "다시보기에 접근할 수 없습니다", fetch_error: "정보를 가져오지 못했습니다. 다시 시도하세요",
  };
  const kstFormatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const kstFull = (ms) => kstFormatter.format(ms);                          // 2026-11-11 21:10:37
  const kst = (ms) => Number.isFinite(ms) ? `${kstFull(ms)} KST` : "시각 확인 필요";
  const kstShort = (ms) => kstFull(ms).slice(5).replace("-", "/");          // 11/11 21:10:37
  const videos = () => S.state ? S.state.videos : [];
  const video = (id) => videos().find((v) => v.vod_id === id);
  const meta = (v) => (v && v.metadata) || {};
  const title = (v) => meta(v).title || `다시보기 ${v.vod_id}`;
  const name = (v) => meta(v).channel || "채널 확인 필요";
  const selectedVideos = () => videos().filter((v) => v.selected);
  const pos = (ms) => hms(Math.floor(ms / 1000));
  const url = (id) => /^[0-9]{3,12}$/.test(id) ? `https://chzzk.naver.com/video/${id}` : null;
  const calcKey = () => JSON.stringify(selectedVideos().map((v) => [v.vod_id, v.registration_id, v.match_revision]));
  const signature = () => JSON.stringify([$("vodWallTime").value.trim(), calcKey()]);
  function storeGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function storeSet(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* blocked storage: works for this visit */ } }
  function message(id, text, error = false) {
    $(id).textContent = text || "";
    $(id).classList.toggle("error", error);
  }
  function button(text, fn, disabled = false, cls = "secondary small") {
    const b = el("button", cls, text); b.type = "button"; b.disabled = disabled;
    b.addEventListener("click", fn); return b;
  }
  function originalLink(id, text = "원본 열기") {
    const a = el("a", "vodlink", text);
    const target = url(id);
    if (target) { a.href = target; a.target = "_blank"; a.rel = "noopener noreferrer"; }
    return a;
  }
  function calibration(row) {
    const n = row.manual_offset_ms || 0;
    return n ? `기본 보정 + 수동 ${n / 1000}초 · 수 초 오차 가능` : "기본 4초 보정 · 수 초 오차 가능";
  }
  function dirty() {
    S.generation++; S.queryStatus = S.query ? "dirty" : "idle"; S.selected.clear();
    if (S.query) message("vodFindMsg", "입력이 바뀌었습니다. 다시 찾기를 누르세요.");
    renderResults(); controls();
  }
  function controls() {
    const blocked = !S.state || S.sessionInvalid;
    $("vodAdd").disabled = blocked || S.addBusy || S.refreshBusy;
    $("vodRefresh").disabled = blocked || S.addBusy || S.refreshBusy || !videos().length;
    $("vodFind").disabled = blocked || S.queryStatus === "loading" || S.mutations > 0 || S.editing.size > 0 || !selectedVideos().length;
    $("vodSave").disabled = blocked || S.saving || S.saveCooldown || !!S.pending || S.queryStatus !== "ready" || !S.selected.size || !!S.editing.size || S.mutations > 0;
    $("vodCopySelected").disabled = S.queryStatus !== "ready" || !S.selected.size;
    const matches = S.queryStatus === "ready" ? S.query.results.filter((r) => r.status === "match") : [];
    $("vodResultsAll").disabled = !matches.length || matches.every((r) => S.selected.has(r.vod_id));
    $("vodResultsNone").disabled = !S.selected.size;
    const listBusy = blocked || S.checkBusy || S.addBusy || S.refreshBusy;
    $("vodVideosAll").disabled = listBusy || videos().every((v) => v.selected);
    $("vodVideosNone").disabled = listBusy || !videos().some((v) => v.selected);
    const none = !filteredMemos().length;
    $("vodCopyMemos").disabled = none;
    $("vodCopyWall").disabled = none;
    $("vodBatchSave").disabled = blocked || S.batchBusy || !selectedVideos().length || !!S.editing.size;
    if (S.sessionInvalid) document.querySelectorAll("#vodVideos button, #vodVideos input, #vodMemos button").forEach((node) => { node.disabled = true; });
  }
  function fail(error, region) {
    if (error instanceof SessionError) {
      S.sessionInvalid = true;
      message("vodNotice", error.message, true);
    }
    message(region, error.message || "요청을 처리하지 못했습니다.", true); controls();
  }
  function acceptState(state, allowReset = false, captured = null) {
    if (!state || !Array.isArray(state.videos) || !Array.isArray(state.memos)) return false;
    if (S.retired.has(state.store_id)) return false;
    if (S.state && captured && captured !== S.state.store_id) { load(); return false; }
    if (S.state && state.store_id !== S.state.store_id) {
      if (!allowReset) { load(); return false; }
      S.retired.add(S.state.store_id); dirty();
      message("vodNotice", "저장 파일이 복구되거나 초기화됐습니다. 다시 검색하세요.", true);
    } else if (S.state && state.revision < S.state.revision) return false;
    const before = S.state ? calcKey() : null;
    S.state = state;
    if (before !== null && before !== calcKey()) dirty();
    if (S.pending && S.pending.payload.store_id !== state.store_id) {
      preservePendingDraft(S.pending);
      clearPending(); renderPending("저장소가 바뀌어 이전 요청을 종료했습니다. 작성 내용을 확인하고 다시 검색하세요.");
    }
    $("vodPath").textContent = state.path || "";
    if (state.notice) message("vodNotice", state.notice, true);
    renderVideos(); renderMemos(); renderResults(); controls(); return true;
  }
  async function load() {
    const seq = ++S.loadSeq, epoch = S.epoch;
    try {
      const state = await api(BASE);
      if (seq !== S.loadSeq || seq < S.shown || epoch !== S.epoch) return;
      S.shown = seq; acceptState(state, true); renderPending();
    } catch (e) { if (seq === S.loadSeq) fail(e, "vodNotice"); }
  }
  function mutate(path, body) {
    const captured = S.state && S.state.store_id;
    S.mutations++; S.epoch++; controls();
    const run = async () => {
      if (S.sessionInvalid) throw new SessionError("서버가 다시 시작되었습니다. 페이지를 새로고침(F5)하세요.");
      if (!S.state || captured !== S.state.store_id) {
        const e = new Error("저장소가 변경됐습니다. 목록을 다시 확인하세요."); e.code = "STORE_CHANGED"; e.status = 409; throw e;
      }
      const response = await api(BASE + path, { method: "POST", body: { ...body, store_id: captured } });
      if (response.state) acceptState(response.state, false, captured);
      return response;
    };
    const request = S.queue.then(run, run);
    S.queue = request.catch(() => {});
    return request.finally(() => { S.mutations--; S.epoch++; controls(); }).catch((error) => {
      if (["STORE_CHANGED", "MATCH_CHANGED", "REGISTRATION_CHANGED"].includes(error.code)) load();
      throw error;
    });
  }
  /** Clipboard, or a box to copy from by hand when the browser refuses. Resolves true when copied. */
  async function copy(text, region = "vodFindMsg") {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      $("vodCopyBox").classList.add("hidden"); if (region) message(region, "복사했습니다.");
      return true;
    } catch (_) {
      $("vodCopyFallback").value = text; $("vodCopyBox").classList.remove("hidden");
      $("vodCopyFallback").focus(); $("vodCopyFallback").select();
      message(region || "vodNotice", "자동 복사를 사용할 수 없습니다. 표시된 내용을 Ctrl+C로 복사하세요.");
      return false;
    }
  }
  /** Copy and show "복사됨" on the button for a moment. label: its normal text, or a function giving it. */
  async function copyFrom(btn, text, region, label = btn.textContent) {
    if (!text) return;
    if (await copy(text, null)) {
      clearTimeout(btn.copiedTimer);
      btn.textContent = "복사됨";
      btn.copiedTimer = setTimeout(() => {
        if (btn.textContent === "복사됨") btn.textContent = typeof label === "function" ? label() : label;
      }, 1500);
    }
  }

  // ---------------------------------------------------------------- copy format (same as the live memo tab)

  // "-3", "-3초", "+2" -> seconds; "" -> 0; anything else -> null
  function copyShift() {
    const v = $("vodShift").value.replace(/\s+/g, "").replace(/초$/, "").replace(/^−/, "-");
    if (!v) return 0;
    if (!/^[+-]?\d{1,5}$/.test(v) || Math.abs(+v) > SHIFT_MAX) return null;
    return +v;
  }
  function updateShift() {
    const shift = copyShift(), note = $("vodShiftNote");
    note.classList.toggle("error", shift == null);
    note.classList.toggle("hint", shift != null);
    if (shift == null) note.textContent = "초 단위 정수로 쓰세요. 예: -3 (3초 앞당김), 2 (2초 늦춤)";
    else if (!shift) note.textContent = "저장된 위치 그대로 복사합니다.";
    else note.textContent = `복사할 때 모든 위치를 ${Math.abs(shift)}초 ${shift < 0 ? "앞당깁니다" : "늦춥니다"}. 예: 00:10:05 → ${hms(Math.max(0, 605 + shift))}`;
  }
  /** One replay's memos as ready-to-paste comment lines, in replay order: "HH:mm:ss 메모".
   *  withWall: each line starts with "(실제시간 - yyyy-MM-dd HH:mm:ss) " (KST), moved with the correction. */
  function memoLines(items, shift = 0, withWall = false) {
    return [...items].sort((a, b) => a.position_ms - b.position_ms || a.at_ms - b.at_ms).map((m) => {
      const p0 = Math.floor(m.position_ms / 1000), p = Math.max(0, p0 + shift);
      const line = m.text ? `${hms(p)} ${m.text}` : hms(p);
      return withWall ? `(실제시간 - ${kstFull(m.at_ms + (p - p0) * 1000)}) ${line}` : line;
    }).join("\n");
  }
  /** What a memo's replay is called, even after the replay was taken off the list (memos keep a snapshot). */
  function replayInfo(id) {
    const v = video(id), m = S.state && S.state.memos.find((x) => x.vod_id === id);
    const snap = (m && m.snapshot) || {};
    return {
      channel: (v && meta(v).channel) || snap.channel || "채널",
      title: (v && meta(v).title) || snap.title || `다시보기 ${id}`,
      opened: (v && meta(v).live_open_date) || snap.live_open_date || "",
    };
  }
  function memoIds() {
    const ids = [...new Set(S.state ? S.state.memos.map((m) => m.vod_id) : [])];
    return ids.sort((a, b) => (replayInfo(a).opened || "").localeCompare(replayInfo(b).opened || "") || a.localeCompare(b));
  }
  /** Chip / header name of a replay: the channel, plus the date when one channel has several replays. */
  function replayLabel(id) {
    const info = replayInfo(id);
    const twins = memoIds().filter((x) => replayInfo(x).channel === info.channel).length > 1;
    return twins && info.opened ? `${info.channel} ${info.opened.slice(5, 10).replace("-", "/")}` : info.channel;
  }
  function replayHeader(id) {
    const info = replayInfo(id);
    return `[${info.channel}] ${info.opened ? info.opened.slice(0, 16) + " 시작 방송 · " : ""}${info.title}`;
  }
  const filteredMemos = () => S.state ? S.state.memos.filter((m) => S.filter === "all" || m.vod_id === S.filter) : [];
  function copyText(shift, withWall) {
    const ids = S.filter === "all" ? memoIds() : [S.filter];
    const blocks = ids.map((id) => [id, S.state.memos.filter((m) => m.vod_id === id)]).filter(([, items]) => items.length);
    if (blocks.length === 1) return memoLines(blocks[0][1], shift, withWall);  // the usual case: just the lines
    return blocks.map(([id, items]) => `${replayHeader(id)}\n${memoLines(items, shift, withWall)}`).join("\n\n");
  }
  const copyLabel = () => S.filter === "all" ? "전체 복사" : `${replayLabel(S.filter)} 복사`;
  function copyShifted(btn, build, label) {
    const shift = copyShift();
    if (shift == null) { updateShift(); $("vodShift").focus(); return; }
    copyFrom(btn, build(shift), "vodNotice", label);
  }

  // ---------------------------------------------------------------- replay list

  async function add() {
    if (S.addBusy || S.sessionInvalid) return;
    const original = $("vodUrls").value;
    const lines = original.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length || lines.length > 50 || new Blob([original]).size > 32768) {
      message("vodAddMsg", "링크를 1~50줄, 전체 32KB 이하로 입력하세요.", true); return;
    }
    S.addBusy = true; controls();
    const summary = [];
    const said = { added: "추가했습니다", duplicate: "이미 목록에 있습니다", limit_exceeded: "목록이 가득 찼습니다 (50개)",
      added_fetch_failed: "추가했지만 영상 정보를 가져오지 못했습니다", invalid: "다시보기 링크가 아닙니다" };
    try {
      for (let i = 0; i < lines.length; i += 10) {
        message("vodAddMsg", `${i}/${lines.length}개 처리 중…`);
        const r = await mutate("/videos", { lines: lines.slice(i, i + 10) });
        for (const item of r.line_results || []) {
          const what = said[item.status] || item.status;
          summary.push(`${item.vod_id || item.line || "링크"}: ${what}${item.error && item.status !== "invalid" ? ` (${item.error})` : ""}`);
        }
      }
      message("vodAddMsg", `${lines.length}개 처리 완료.\n${summary.join("\n")}`);
      if ($("vodUrls").value === original) $("vodUrls").value = "";
    } catch (e) { fail(e, "vodAddMsg"); }
    finally { S.addBusy = false; controls(); }
  }
  async function refresh() {
    if (S.refreshBusy || !S.state) return;
    S.refreshBusy = true; controls();
    const items = videos().map((v) => ({ vod_id: v.vod_id, registration_id: v.registration_id }));
    try {
      for (let i = 0; i < items.length; i += 10) {
        message("vodAddMsg", `정보 확인 ${i}/${items.length}…`);
        await mutate("/refresh", { items: items.slice(i, i + 10) });
      }
      message("vodAddMsg", "정보 확인을 마쳤습니다. 영상별 상태를 확인하세요.");
    } catch (e) { fail(e, "vodAddMsg"); }
    finally { S.refreshBusy = false; controls(); }
  }
  function offsetMs(value) {
    const m = /^([+-]?)([0-9]+)(?:\.([0-9]{1,3}))?$/.exec(value.trim());
    if (!m) return null;
    const n = (Number(m[2]) * 1000 + Number((m[3] || "").padEnd(3, "0"))) * (m[1] === "-" ? -1 : 1);
    return Number.isSafeInteger(n) && Math.abs(n) <= 86400000 ? n : null;
  }
  function renderVideos(force = false) {
    const box = $("vodVideos");
    if (!force && (S.editing.size || box.contains(document.activeElement))) return;
    box.replaceChildren();
    if (!videos().length) { box.appendChild(el("p", "hint", "위에 다시보기 링크를 넣고 추가하세요.")); return; }
    for (const v of videos()) {
      const row = el("div", v.selected ? "vodrow on" : "vodrow"), label = el("label", "vodcheck"), checkbox = document.createElement("input");
      checkbox.type = "checkbox"; checkbox.checked = v.selected; checkbox.disabled = S.sessionInvalid;
      label.append(checkbox, el("span", "vodname", name(v)), el("span", "vodtitle", title(v))); row.appendChild(label);
      checkbox.addEventListener("change", async () => {
        dirty(); checkbox.disabled = true;
        try { await mutate("/videos/update", { vod_id: v.vod_id, registration_id: v.registration_id, selected: checkbox.checked }); }
        catch (e) { fail(e, "vodAddMsg"); }
        finally { renderVideos(true); }
      });
      const info = el("div", "vodmeta");
      const offset = (v.manual_offset_ms || 0) / 1000;
      info.appendChild(el("span", null, `${meta(v).live_open_date ? meta(v).live_open_date.slice(0, 16) + " 시작" : "시작 시각 확인 필요"} · 길이 ${meta(v).duration_ms > 0 ? pos(meta(v).duration_ms) : "확인 필요"}${offset ? ` · 보정 ${offset}초` : ""}`));
      info.appendChild(originalLink(v.vod_id));
      info.appendChild(button("목록에서 빼기", async () => {
        if (!confirm("목록에서 뺄까요? 저장한 메모는 그대로 남습니다.")) return;
        dirty(); S.editing.delete(v.vod_id);
        try { await mutate("/videos/remove", { vod_id: v.vod_id, registration_id: v.registration_id }); }
        catch (e) { fail(e, "vodAddMsg"); }
        finally { renderVideos(true); $("vodListTitle").focus(); }
      }, S.sessionInvalid, "linkbtn"));
      row.appendChild(info);
      if (v.metadata_state !== "ready") row.appendChild(el("p", "error", statusText[v.metadata_state] || "영상 정보 확인 필요"));
      if (v.stale) row.appendChild(el("p", "hint", "마지막 확인 정보 기준 · 정보 새로고침 권장"));
      if (v.last_error) row.appendChild(el("p", "error", typeof v.last_error === "string" ? v.last_error : v.last_error.message || "조회 실패"));
      const details = document.createElement("details"); details.appendChild(el("summary", null, `시간 보정 (${offset}초)`));
      const field = el("input", "vodoffset"); field.type = "text"; field.inputMode = "decimal";
      field.value = String(offset); field.id = `vod-offset-${v.vod_id}`;
      const fieldLabel = el("label", null, "추가 보정 (초, 소수 세 자리까지)"); fieldLabel.htmlFor = field.id;
      details.append(fieldLabel, field, el("p", "hint", "+4초이면 찾은 재생 위치에서 4초를 뺍니다. 기본 보정과 별개입니다."));
      field.addEventListener("input", () => { S.editing.add(v.vod_id); dirty(); });
      field.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
      const buttons = el("div", "row wrap");
      buttons.appendChild(button("적용", async () => {
        const value = offsetMs(field.value);
        if (value === null) { field.setAttribute("aria-invalid", "true"); message("vodAddMsg", "보정은 ±86400초 범위, 소수 세 자리까지 입력하세요.", true); return; }
        field.removeAttribute("aria-invalid");
        try {
          await mutate("/videos/update", { vod_id: v.vod_id, registration_id: v.registration_id,
            manual_offset_ms: value, expected_match_revision: v.match_revision });
          S.editing.delete(v.vod_id); dirty(); renderVideos(true);
        } catch (e) { fail(e, "vodAddMsg"); }
      }, S.sessionInvalid));
      buttons.appendChild(button("취소", () => { S.editing.delete(v.vod_id); renderVideos(true); controls(); }));
      details.appendChild(buttons); row.appendChild(details); box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- one wall time -> every checked replay

  async function find() {
    if ($("vodFind").disabled) return;
    const generation = ++S.generation, sig = signature();
    const ids = selectedVideos().map((v) => v.vod_id);
    S.queryStatus = "loading"; S.selected.clear(); renderResults(); controls(); message("vodFindMsg", "찾는 중…");
    try {
      const r = await api(BASE + "/find", { method: "POST", body: { wall_time: $("vodWallTime").value, vod_ids: ids } });
      if (generation !== S.generation || sig !== signature()) return;
      if (r.store_id !== S.state.store_id) { dirty(); await load(); return; }
      S.query = r; S.queryStatus = "ready";
      S.selected = new Set(r.results.filter((x) => x.status === "match").map((x) => x.vod_id));
      $("vodWallTime").removeAttribute("aria-invalid");
      message("vodFindMsg", `${r.normalized_kst} KST · ${r.results.length}개 중 ${S.selected.size}개 일치`);
      renderResults(); controls();
    } catch (e) {
      if (generation !== S.generation) return;
      S.queryStatus = "error";
      if (e.code === "INVALID_WALL_TIME" || e.status === 422) $("vodWallTime").setAttribute("aria-invalid", "true");
      fail(e, "vodFindMsg"); renderResults();
    }
  }
  /** A found position as a comment line for that replay: "HH:mm:ss 메모". */
  function resultLine(row) {
    const note = $("vodMemoText").value.trim();
    return note ? `${pos(row.position_ms)} ${note}` : pos(row.position_ms);
  }
  function renderResults() {
    const box = $("vodResults"); box.replaceChildren();
    if (!S.query) {
      box.appendChild(el("p", "hint", videos().length
        ? "실제 시각을 입력하고 찾기를 누르면, 체크한 다시보기마다 그 시각의 재생 위치가 여기에 나옵니다."
        : "먼저 아래 '다시보기 목록'에 치지직 다시보기 링크를 추가하세요."));
      return;
    }
    const valid = S.queryStatus === "ready";
    for (const r of S.query.results) {
      const v = video(r.vod_id) || { vod_id: r.vod_id };
      const row = el("div", `vodrow vodresult${valid ? "" : " voddirty"}`), label = el("label", "vodcheck");
      const check = document.createElement("input"); check.type = "checkbox";
      check.checked = S.selected.has(r.vod_id); check.disabled = !valid || r.status !== "match";
      check.addEventListener("change", () => { check.checked ? S.selected.add(r.vod_id) : S.selected.delete(r.vod_id); controls(); });
      label.append(check, el("span", "vodname", name(v)), el("span", "vodtitle", title(v))); row.appendChild(label);
      const line = el("div", "vodfound");
      if (r.status === "match") {
        line.appendChild(el("b", "vodposition", pos(r.position_ms)));
        line.appendChild(el("span", "hint", calibration(r) + (r.stale ? " · 마지막 확인 정보 기준" : "")));
        line.appendChild(button("위치 복사", (ev) => copyFrom(ev.currentTarget || ev.target, resultLine(r), "vodFindMsg", "위치 복사"), !valid));
      } else line.appendChild(el("span", "error", statusText[r.status] || "확인 필요"));
      line.appendChild(originalLink(r.vod_id, "원본"));
      row.appendChild(line); box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- saving (one request may be retried after F5)

  function savePendingStorage() {
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(S.pending)); }
    catch (_) { message("vodNotice", "이 창에서 재시도할 수 있습니다. 브라우저 저장이 차단되어 F5 후에는 미확정 요청을 복구할 수 없습니다.", true); }
  }
  function clearPending() {
    S.pending = null; try { sessionStorage.removeItem(PENDING_KEY); } catch (_) {}
  }
  function renderRecovery() {
    $("vodRecoveryBox").classList.toggle("hidden", !S.recovery);
    $("vodRecovered").value = S.recovery;
  }
  function preservePendingDraft(pending) {
    if (!pending) return;
    if (!$("vodMemoText").value.trim()) $("vodMemoText").value = pending.draft || pending.payload.text || "";
    S.recovery = JSON.stringify(pending.payload, null, 2);
    try { sessionStorage.setItem(RECOVERY_KEY, S.recovery); } catch (_) {}
    renderRecovery();
  }
  function renderPending(text) {
    const box = $("vodSaveMsg"); box.replaceChildren();
    if (text !== undefined) S.saveMessage = text;
    if (S.saveMessage) box.appendChild(el("p", null, S.saveMessage));
    if (S.pending) {
      box.appendChild(el("p", "hint", `저장 여부 확인 필요: ${kst(S.pending.payload.at_ms)} · ${S.pending.payload.text || "메모 없음"}`));
      box.appendChild(button("이전 저장 확인/재시도", () => sendSave(), S.saving || S.sessionInvalid));
      box.appendChild(button("요청 닫기", () => {
        if (confirm("이미 저장됐을 수 있습니다. 미확정 요청을 닫고 목록을 확인할까요?")) { clearPending(); renderPending(); controls(); }
      }, S.saving));
    }
  }
  async function save() {
    if ($("vodSave").disabled) return;
    const rows = S.query.results.filter((r) => r.status === "match" && S.selected.has(r.vod_id));
    S.pending = { version: 1, draft: $("vodMemoText").value, payload: {
      request_id: crypto.randomUUID(), store_id: S.state.store_id, at_ms: S.query.at_ms,
      formula_version: S.query.formula_version, text: $("vodMemoText").value,
      items: rows.map((r) => ({ vod_id: r.vod_id, registration_id: r.registration_id, match_revision: r.match_revision })),
    } };
    savePendingStorage(); await sendSave();
  }
  async function sendSave() {
    if (!S.pending || S.saving || S.sessionInvalid) return;
    const pending = S.pending; S.saving = true; controls(); renderPending("저장 결과를 확인하는 중…");
    try {
      if (pending.payload.store_id !== S.state.store_id) {
        const e = new Error("저장소가 바뀌었습니다. 다시 검색하세요."); e.code = "STORE_CHANGED"; e.status = 409; throw e;
      }
      const r = await mutate("/memos", pending.payload);
      if (!r.deleted && $("vodMemoText").value === pending.draft) $("vodMemoText").value = "";
      // the checks stay, so the next memo for the same replays is just text + Enter; a second click that
      // lands right after the answer (a double click) must not save another memo, hence the short pause
      S.saveCooldown = true;
      setTimeout(() => { S.saveCooldown = false; controls(); }, 1000);
      clearPending(); renderPending(r.deleted ? "이미 처리된 저장이며 메모는 삭제되었습니다." : `${(r.memo_ids || []).length}개 메모를 ${r.replayed ? "이미 저장했습니다" : "저장했습니다"}.`);
    } catch (e) {
      if (e instanceof SessionError) fail(e, "vodNotice");
      if ([400, 409, 422].includes(e.status)) {
        if (e.code === "STORE_CHANGED") preservePendingDraft(pending);
        clearPending(); dirty(); renderPending(e.message);
      }
      else renderPending(`${e.message || "응답을 받지 못했습니다."} 저장됐을 수 있으므로 같은 요청으로 확인하세요.`);
    } finally { S.saving = false; controls(); if (S.pending) renderPending(); }
  }

  // ---------------------------------------------------------------- many lines at once (pasted from the live memo tab)

  const WALL = "((?:\\d{4}|\\d{2})-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})";
  const BATCH_LINE = [
    // (실제시간 - 2026-11-21 23:30:31) 00:58:10 메모  — the live tab's "실제 시간 포함 복사"; its position is ignored
    new RegExp(`^\\s*\\(실제시간\\s*-\\s*${WALL}\\)\\s*(?:(?:\\d{1,3}:)?\\d{1,2}:\\d{2}(?=\\s|$))?\\s*(.*)$`),
    // 26-11-21 23:30:31 메모
    new RegExp(`^\\s*${WALL}(?=\\s|$)\\s*(.*)$`),
  ];
  function parseBatch(text) {
    const rows = [], skipped = [];
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const m = BATCH_LINE.map((re) => re.exec(raw)).find(Boolean);
      if (m) rows.push({ wall: m[1], note: m[2].trim() });
      else skipped.push(raw.trim());
    }
    return { rows, skipped };
  }
  async function saveBatch() {
    if (S.batchBusy || !S.state || S.sessionInvalid) return;
    const { rows, skipped } = parseBatch($("vodBatch").value);
    if (!rows.length) {
      message("vodBatchMsg", "줄 맨 앞에 실제 시각이 있는 줄이 없습니다. 예: (실제시간 - 2026-11-21 23:30:31) 00:58:10 메모", true);
      return;
    }
    const ids = selectedVideos().map((v) => v.vod_id);
    if (!ids.length) { message("vodBatchMsg", "위 목록에서 저장할 다시보기를 체크하세요.", true); return; }
    S.batchBusy = true; controls();
    let saved = 0, memos = 0, already = 0;
    const missed = [], failed = [];
    try {
      for (const [i, row] of rows.entries()) {
        message("vodBatchMsg", `${i + 1}/${rows.length}줄 저장 중…`);
        try {
          const f = await api(BASE + "/find", { method: "POST", body: { wall_time: row.wall, vod_ids: ids } });
          const text = row.note.split(/\s+/).filter(Boolean).join(" ");
          const hits = f.results.filter((r) => r.status === "match");
          const fresh = hits.filter((r) => !S.state.memos.some((m) => m.vod_id === r.vod_id && m.at_ms === f.at_ms && m.text === text));
          already += hits.length - fresh.length;
          if (!hits.length) { missed.push(row.wall); continue; }
          if (!fresh.length) continue;
          const r = await mutate("/memos", { request_id: crypto.randomUUID(), at_ms: f.at_ms, formula_version: f.formula_version, text,
            items: fresh.map((x) => ({ vod_id: x.vod_id, registration_id: x.registration_id, match_revision: x.match_revision })) });
          saved++; memos += (r.memo_ids || []).length;
        } catch (e) {
          failed.push(`${row.wall}: ${e.message}`);
          if (e instanceof SessionError) { fail(e, "vodNotice"); break; }
        }
      }
    } finally { S.batchBusy = false; controls(); }
    const parts = [`${rows.length}줄 중 ${saved}줄을 저장했습니다 (메모 ${memos}개).`];
    if (already) parts.push(`이미 있는 메모 ${already}개는 건너뛰었습니다.`);
    if (missed.length) parts.push(`체크한 다시보기 어디에도 없는 시각: ${missed.join(", ")}`);
    if (skipped.length) parts.push(`시각이 없어 건너뛴 줄 ${skipped.length}개`);
    if (failed.length) parts.push(`실패: ${failed.join(" / ")}`);
    message("vodBatchMsg", parts.join(" "), !!failed.length);
    if (!failed.length && !missed.length) $("vodBatch").value = "";
  }

  // ---------------------------------------------------------------- saved memos (same views as the live memo tab)

  function memoText(text) {
    return el("span", text ? "lmtext" : "lmtext muted", text || "(메모 없음)");
  }
  function renderMemos() {
    if (!S.state) return;
    const memos = S.state.memos, ids = memoIds();
    if (S.filter !== "all" && !ids.includes(S.filter)) S.filter = "all";
    const filters = $("vodMemoFilter"); filters.replaceChildren();
    const chip = (id, label) => {
      const b = button(label, () => { S.filter = id; renderMemos(); controls(); });
      b.className = `chip${S.filter === id ? " on" : ""}`; filters.appendChild(b);
    };
    chip("all", `전체 ${new Set(memos.map((m) => m.group)).size}`);
    for (const id of ids) chip(id, `${replayLabel(id)} ${memos.filter((m) => m.vod_id === id).length}`);
    $("vodCopyMemos").textContent = copyLabel();
    const box = $("vodMemos"); box.replaceChildren();
    if (!memos.length) { box.appendChild(el("p", "hint", "저장한 메모가 없습니다. 왼쪽에서 시각을 찾아 저장하거나, 여러 줄을 한 번에 저장하세요.")); return; }
    if (S.filter === "all") {
      const groups = new Map();
      for (const m of memos) { if (!groups.has(m.group)) groups.set(m.group, []); groups.get(m.group).push(m); }
      const list = [...groups].sort((a, b) => a[1][0].at_ms - b[1][0].at_ms);
      if (S.sortNew) list.reverse();
      for (const [group, items] of list) {
        const row = el("div", "lmemo"), head = el("div", "lmhead"), first = items[0];
        head.append(el("span", "lmat", kstShort(first.at_ms)), memoText(first.text));
        head.appendChild(button("삭제", () => deleteMemo({ group }, items.length), S.sessionInvalid, "linkbtn"));
        row.appendChild(head);
        const where = el("div", "lmpos");
        for (const m of [...items].sort((a, b) => replayLabel(a.vod_id).localeCompare(replayLabel(b.vod_id)))) {
          const c = el("span", "poschip");
          c.append(el("span", null, replayLabel(m.vod_id)), el("b", null, pos(m.position_ms)));
          where.appendChild(c);
        }
        row.appendChild(where); box.appendChild(row);
      }
      return;
    }
    const items = memos.filter((m) => m.vod_id === S.filter).sort((a, b) => a.position_ms - b.position_ms || a.at_ms - b.at_ms);
    if (S.sortNew) items.reverse();
    const info = replayInfo(S.filter), head = el("div", "lmlive");
    head.appendChild(el("span", null, `${info.opened ? info.opened.slice(0, 16) + " 시작 · " : ""}${info.title}`));
    head.appendChild(originalLink(S.filter));
    box.appendChild(head);
    for (const m of items) {
      const row = el("div", "lmemo lmone");
      row.append(el("b", "lmposbig", pos(m.position_ms)), memoText(m.text), el("span", "lmat muted", `실제 ${kstShort(m.at_ms)}`));
      row.appendChild(button("삭제", () => deleteMemo({ id: m.id }), S.sessionInvalid, "linkbtn"));
      box.appendChild(row);
    }
  }
  async function deleteMemo(body, count = 1) {
    const question = body.group
      ? (count > 1 ? `이 메모를 다시보기 ${count}개에서 모두 지울까요?` : "이 메모를 지울까요?")
      : "이 메모를 이 다시보기에서 지울까요?";
    if (!confirm(question)) return;
    try { await mutate("/memos/delete", body); }
    catch (e) { fail(e, "vodNotice"); }
  }

  // ---------------------------------------------------------------- check / uncheck everything

  function checkResults(on) {
    if (S.queryStatus !== "ready") return;
    S.selected = new Set(on ? S.query.results.filter((r) => r.status === "match").map((r) => r.vod_id) : []);
    renderResults(); controls();
  }
  async function checkVideos(on) {
    if (S.checkBusy || !S.state) return;
    const todo = videos().filter((v) => v.selected !== on);
    if (!todo.length) return;
    S.checkBusy = true; dirty();
    try {
      for (const v of todo) await mutate("/videos/update", { vod_id: v.vod_id, registration_id: v.registration_id, selected: on });
    } catch (e) { fail(e, "vodAddMsg"); }
    finally { S.checkBusy = false; renderVideos(true); controls(); }
  }

  window.showVodTab = () => { load(); };
  window.bindVod = () => {
    if (S.bound) return; S.bound = true;
    $("vodAdd").addEventListener("click", add); $("vodRefresh").addEventListener("click", refresh);
    $("vodFind").addEventListener("click", find); $("vodSave").addEventListener("click", save);
    $("vodWallTime").addEventListener("input", () => { $("vodWallTime").removeAttribute("aria-invalid"); dirty(); });
    $("vodWallTime").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && !e.repeat) { e.preventDefault(); find(); } });
    $("vodUrls").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey && !e.isComposing && !e.repeat) { e.preventDefault(); add(); } });
    $("vodMemoText").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && !e.repeat) { e.preventDefault(); save(); } });
    $("vodCopySelected").addEventListener("click", () => {
      if (S.queryStatus !== "ready") return;
      const lines = S.query.results.filter((r) => S.selected.has(r.vod_id))
        .map((r) => `[${name(video(r.vod_id) || { vod_id: r.vod_id })}] ${resultLine(r)}`);
      copyFrom($("vodCopySelected"), lines.join("\n"), "vodFindMsg", "체크한 결과 복사");
    });
    $("vodCopyMemos").addEventListener("click", () => { if (S.state) copyShifted($("vodCopyMemos"), (sh) => copyText(sh, false), copyLabel); });
    $("vodCopyWall").addEventListener("click", () => { if (S.state) copyShifted($("vodCopyWall"), (sh) => copyText(sh, true), "실제 시간 포함 복사"); });
    $("vodBatchSave").addEventListener("click", saveBatch);
    $("vodResultsAll").addEventListener("click", () => checkResults(true));
    $("vodResultsNone").addEventListener("click", () => checkResults(false));
    $("vodVideosAll").addEventListener("click", () => checkVideos(true));
    $("vodVideosNone").addEventListener("click", () => checkVideos(false));
    $("vodSort").addEventListener("click", (ev) => {
      const b = ev.target.closest ? ev.target.closest("button[data-sort]") : null;
      if (!b) return;
      S.sortNew = b.dataset.sort === "new";
      document.querySelectorAll("#vodSort button").forEach((x) => x.classList.toggle("on", x === b));
      renderMemos();
    });
    $("vodShift").value = storeGet(SHIFT_KEY) || "";
    $("vodShift").addEventListener("input", () => { storeSet(SHIFT_KEY, $("vodShift").value); updateShift(); });
    updateShift();
    $("vodDismissRecovery").addEventListener("click", () => {
      S.recovery = ""; try { sessionStorage.removeItem(RECOVERY_KEY); } catch (_) {} renderRecovery();
    });
    try { S.recovery = sessionStorage.getItem(RECOVERY_KEY) || ""; } catch (_) {}
    renderRecovery();
    try {
      const text = sessionStorage.getItem(PENDING_KEY);
      if (text && text.length <= 32768) {
        const pending = JSON.parse(text), p = pending.payload;
        if (pending.version === 1 && typeof pending.draft === "string" && p && typeof p.store_id === "string" && typeof p.request_id === "string" && Number.isSafeInteger(p.at_ms) && p.formula_version === 1 && typeof p.text === "string" && p.text.length <= 500 && Array.isArray(p.items) && p.items.length > 0 && p.items.length <= 50 && p.items.every((x) => x && typeof x.vod_id === "string" && typeof x.registration_id === "string" && Number.isSafeInteger(x.match_revision))) S.pending = pending;
      }
    } catch (_) { try { sessionStorage.removeItem(PENDING_KEY); } catch (_) {} }
    renderResults(); renderPending(); controls();
  };
  // exposed for tests
  window.vodMemoLines = memoLines;
  window.vodParseBatch = parseBatch;
})();
