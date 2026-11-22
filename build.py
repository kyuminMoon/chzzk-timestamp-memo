"""Package src/ into dist/chzzk-memo-extension-<version>.zip for the Chrome Web Store / Edge Add-ons / Whale Store.

    python build.py

manifest.json sits at the root of the zip, as the stores require. Only the files the extension uses go in.
"""
import json
import pathlib
import sys
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "src"
ALLOWED = {".json", ".js", ".html", ".css", ".png"}


def main() -> int:
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    # hidden files and folders (.git, editor / tool state) never go in
    files = sorted(p for p in SRC.rglob("*")
                   if p.is_file() and not any(part.startswith(".") for part in p.relative_to(SRC).parts))
    stray = [p for p in files if p.suffix.lower() not in ALLOWED]
    if stray:
        print("src/ 안에 넣지 않을 파일이 있습니다:", *[str(p.relative_to(SRC)) for p in stray], sep="\n  ")
        return 1
    for icon in manifest["icons"].values():
        if not (SRC / icon).is_file():
            print("아이콘이 없습니다:", icon)
            return 1
    out = HERE / "dist" / f"chzzk-memo-extension-{version}.zip"
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, p.relative_to(SRC).as_posix())
    print(f"{out}  ({len(files)}개 파일, {out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
