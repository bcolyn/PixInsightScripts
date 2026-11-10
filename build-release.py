#!/usr/bin/env python3
"""
Builds two PixInsight update repositories, each a single zip package of .js
scripts under src/scripts/bcolyn/ plus the updates.xri that describes it:

  release/            signed repository   <- *.js in the repo root (+ their .xsgn)
  release-unsigned/   unsigned repository <- *.js in unsigned/ (never signed)

See: https://pixinsight.com/doc/docs/PIRepositoryReference/PIRepositoryReference.html

Usage:
    python build-release.py [--version X.Y.Z] [--release-date YYYYMMDD]
"""

import argparse
import datetime
import hashlib
import re
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent
VENDOR = "bcolyn"
REPO_TITLE = "Benny Colyn's PixInsight Scripts"
PLATFORM_VERSION_RANGE = "1.8.8:1.9.9"
GPL_LICENSE_FILE = "LICENSE-GPL-3.0.txt"

FEATURE_INFO_RE = re.compile(r"^#feature-info\s+(.*)$")
GPL_RE = re.compile(r"^\s*\*?\s*License:\s*GPL-3\.0", re.MULTILINE)
CONTINUATION_RE = re.compile(r"^\s*(.*)$")


class Repo:
    def __init__(self, name, script_dir, release_dir, zip_stem, title, signed):
        self.name = name
        self.script_dir = script_dir
        self.release_dir = release_dir
        self.zip_stem = zip_stem
        self.title = title
        self.signed = signed


REPOS = [
    Repo("signed", ROOT, ROOT / "release", "bcolyn-scripts", REPO_TITLE, True),
    Repo("unsigned", ROOT / "unsigned", ROOT / "release-unsigned", "bcolyn-scripts-unsigned",
         REPO_TITLE + " (unsigned)", False),
]


def find_scripts(script_dir):
    if not script_dir.is_dir():
        return []
    return sorted(p for p in script_dir.glob("*.js") if p.is_file())


def parse_feature_id(text):
    match = re.search(r"^#feature-id\s+(.*)$", text, re.MULTILINE)
    if not match:
        return None
    value = match.group(1).strip()
    # "<script-id> : <menu-item>" -- keep the menu path for display, drop the id.
    if " : " in value:
        return value.split(" : ", 1)[1].strip()
    return value


def parse_feature_info(text):
    lines = text.splitlines()
    for i, line in enumerate(lines):
        match = FEATURE_INFO_RE.match(line)
        if not match:
            continue
        parts = [match.group(1)]
        j = i
        while parts[-1].rstrip().endswith("\\"):
            parts[-1] = parts[-1].rstrip()[:-1]
            j += 1
            parts.append(CONTINUATION_RE.match(lines[j]).group(1))
        info = " ".join(p.strip() for p in parts)
        info = re.sub(r"<br\s*/?>", "\n", info)
        info = re.sub(r"<[^>]+>", "", info)
        return info.strip()
    return None


def collect_script_metadata(scripts):
    metadata = []
    for path in scripts:
        text = path.read_text(encoding="utf-8")
        metadata.append({
            "file": path.name,
            "feature_id": parse_feature_id(text),
            "feature_info": parse_feature_info(text),
            "gpl": bool(GPL_RE.search(text)),
        })
    return metadata


def remove_previous_zips(release_dir, zip_stem):
    for old_zip in release_dir.glob(f"{zip_stem}-*.zip"):
        old_zip.unlink()


def signature_status(path):
    """Checks the .xsgn beside `path` for existence and freshness (mtime-based).

    This can't verify the signature itself -- only PixInsight's Ed25519
    verification can do that -- but it catches the common case of editing a
    script after signing it, which would otherwise silently bundle a stale
    signature. An invalid signature is worse than none: PixInsight always
    refuses to run a script whose signature fails verification, whereas an
    unsigned script just prompts.
    """
    signature = path.with_suffix(".xsgn")
    if not signature.exists():
        return "missing"
    if signature.stat().st_mtime < path.stat().st_mtime:
        return "stale"
    return "fresh"


def build_zip(scripts, zip_path, signed):
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in scripts:
            zf.write(path, f"src/scripts/{VENDOR}/{path.name}")
            if signed and signature_status(path) == "fresh":
                signature = path.with_suffix(".xsgn")
                zf.write(signature, f"src/scripts/{VENDOR}/{signature.name}")
        # Aster-PI.js is GPL-3.0-or-later (ported from a GPL script); the GPL
        # requires the license text to travel with distributed copies.
        if any(p.name == "Aster-PI.js" for p in scripts):
            zf.write(ROOT / GPL_LICENSE_FILE, f"src/scripts/{VENDOR}/{GPL_LICENSE_FILE}")


def sha1_of(path):
    digest = hashlib.sha1()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def build_description_xml(metadata, indent):
    paragraphs = []
    for item in metadata:
        name = item["feature_id"] or item["file"]
        info = item["feature_info"] or ""
        first_line = info.splitlines()[0] if info else ""
        paragraph = f"{name}: {first_line}".strip(": ")
        if item.get("gpl"):
            paragraph += (f" Licensed under the GNU General Public License v3.0 or later; "
                          f"the license text is bundled as {GPL_LICENSE_FILE} next to the script.")
        paragraphs.append(paragraph)
    lines = [f"{indent}<description>"]
    for p in paragraphs:
        lines.append(f"{indent}   <p>{escape(p)}</p>")
    lines.append(f"{indent}</description>")
    return "\n".join(lines)


def build_updates_xri(title, zip_name, sha1, release_date, version, metadata):
    package_description = build_description_xml(metadata, indent="         ")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<xri version="1.0">
   <description>
      <p>{escape(title)}</p>
   </description>
   <platform os="all" arch="noarch" version="{PLATFORM_VERSION_RANGE}">
      <package fileName="{escape(zip_name)}" sha1="{sha1}" type="script" releaseDate="{release_date}">
         <title>{escape(title)} v{escape(version)}</title>
{package_description}
      </package>
   </platform>
</xri>
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default=datetime.date.today().strftime("%Y.%m.%d"),
                         help="Release version to show in the package title (default: today's date)")
    parser.add_argument("--release-date", default=datetime.date.today().strftime("%Y%m%d"),
                         help="Release date in YYYYMMDD format (default: today)")
    parser.add_argument("--build-time", default=datetime.datetime.now().strftime("%Y%m%d%H%M%S"),
                         help="Build timestamp embedded in the zip filename (default: now, YYYYMMDDHHMMSS)")
    args = parser.parse_args()

    for repo in REPOS:
        build_repo(repo, args)


def build_repo(repo, args):
    scripts = find_scripts(repo.script_dir)
    if not scripts:
        print(f"[{repo.name}] no .js scripts found in {repo.script_dir} -- skipped")
        return

    metadata = collect_script_metadata(scripts)

    repo.release_dir.mkdir(parents=True, exist_ok=True)
    remove_previous_zips(repo.release_dir, repo.zip_stem)
    zip_name = f"{repo.zip_stem}-{args.build_time}.zip"
    zip_path = repo.release_dir / zip_name
    build_zip(scripts, zip_path, repo.signed)
    sha1 = sha1_of(zip_path)

    xri_content = build_updates_xri(repo.title, zip_name, sha1, args.release_date, args.version, metadata)
    (repo.release_dir / "updates.xri").write_text(xri_content, encoding="utf-8", newline="\n")

    print(f"[{repo.name}] Packaged {len(scripts)} script(s) into {zip_path}")
    stale = []
    for item, path in zip(metadata, scripts):
        tag = ""
        if repo.signed:
            status = signature_status(path)
            tag = {"fresh": " [signed]", "stale": " [STALE SIGNATURE -- excluded]", "missing": ""}[status]
            if status == "stale":
                stale.append(item["file"])
        print(f"  - {item['file']} ({item['feature_id'] or 'no feature-id'}){tag}")
    print(f"  sha1: {sha1}")
    note = "unsigned -- sign with Script > Development > CodeSign" if repo.signed else "intentionally unsigned"
    print(f"  Wrote {repo.release_dir / 'updates.xri'} ({note})")
    if stale:
        print(f"\nWARNING: {len(stale)} script(s) were edited after signing and were bundled "
              f"WITHOUT their stale .xsgn. Re-sign with Script > Development > CodeSign, then rebuild: "
              + ", ".join(stale))


if __name__ == "__main__":
    main()
