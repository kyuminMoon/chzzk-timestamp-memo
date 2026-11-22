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
