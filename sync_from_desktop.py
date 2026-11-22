"""Rebuild the extension's screens from the desktop app's, so the two never drift apart.

    python sync_from_desktop.py [path/to/stt_timeline/web]

The path defaults to $STT_TIMELINE_WEB, then to ../stt_timeline/web next to this folder (the layout where
the extension lives inside the desktop app's project). The desktop app is not part of this repository.

The live memo and replay tabs (markup, the live memo part of app.js, vodmemo.js, style.css) come from
stt_timeline/web. What only the extension has lives in shell/:
  page-top.html / page-bottom.html  page head, header, tab buttons, the backup tab, script tags
  head.js / footer.js               api() answered in the page, tab switching, backup / import, sync between tabs
  extra.css                         styles of the backup tab
The store logic in src/lib is a separate port of the Python code and is not touched here.
"""
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
WEB = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("STT_TIMELINE_WEB")
                   or HERE.parent / "stt_timeline" / "web").resolve()
SRC = HERE / "src"
SHELL = HERE / "shell"


def read(path: pathlib.Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def write(path: pathlib.Path, text: str) -> None:
    path.write_bytes(text.encode("utf-8"))
    print(f"  {path.relative_to(HERE)}")


def cut(text: str, start: str, end: str, *, include_end: bool) -> str:
    i = text.index(start)
    j = text.index(end, i)
    return text[i:j + (len(end) if include_end else 0)]


def main() -> int:
    if not (WEB / "index.html").is_file() or not (WEB / "vodmemo.js").is_file():
        print(f"데스크톱 앱의 화면 폴더(stt_timeline/web)를 찾지 못했습니다: {WEB}\n"
              "사용법: python sync_from_desktop.py <stt_timeline/web 경로>  (또는 STT_TIMELINE_WEB 환경 변수)")
        return 1
    index = read(WEB / "index.html")
    live = cut(index, '<main class="layout hidden" id="tab-live">', "</main>", include_end=True)
    vod = cut(index, '<main class="layout hidden" id="tab-vod">', "</main>", include_end=True)
    live = live.replace('<main class="layout hidden" id="tab-live">', '<main class="layout" id="tab-live">', 1)
    note = '<p class="hint">저장 위치 <code id="livePath"></code></p>'
    if note in live:
        live = live.replace(note, '<p class="hint">저장 위치: <span id="livePath"></span> · 백업 탭에서 파일로 받아 둘 수 있습니다.</p>')
    vod = vod.replace('<p class="hint">저장 위치 <code id="vodPath"></code></p>', '<p class="hint">저장 위치: <span id="vodPath"></span></p>')
    page = read(SHELL / "page-top.html") + live + "\n\n" + vod + "\n\n" + read(SHELL / "page-bottom.html")
    if "/static/" in page or "__VERSION__" in page or "__SESSION_TOKEN__" in page:
        print("desktop-only markup leaked into the page; check stt_timeline/web/index.html")
        return 1

    app = read(WEB / "app.js")
    live_js = cut(app, "// ------------------------------------------------------------------ live memo tab",
                  "// The viewer (another tab) can add a word", include_end=False).rstrip() + "\n\n"
    script = read(SHELL / "head.js") + live_js + read(SHELL / "footer.js")

    print("extension files rebuilt from the desktop app:")
    write(SRC / "app.html", page)
    write(SRC / "app.js", script)
    write(SRC / "vodmemo.js", read(WEB / "vodmemo.js"))
    write(SRC / "style.css", read(WEB / "style.css").rstrip() + "\n\n" + read(SHELL / "extra.css"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
