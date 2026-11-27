"""Build the release page and its versioned installer assets."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
from zipfile import ZIP_DEFLATED, ZipFile

SITE = Path(__file__).resolve().parent
INSTALLER = SITE.parent
sys.path.insert(0, str(INSTALLER))
sys.dont_write_bytecode = True
from install import ACCOUNT, GROK, render

ASSETS = (
    "Install.cmd", "Install-Mac.command", "install.py", "register-task.ps1", "README.md",
    "instructions/zh.md", "instructions/ja.md", "instructions/en.md",
)


def build(destination):
    assets = destination / "downloads"
    assets.mkdir(parents=True, exist_ok=True)
    archive = assets / "jopt-memory-pilot-1.zip"
    with ZipFile(archive, "w", ZIP_DEFLATED) as bundle:
        for name in ASSETS:
            bundle.write(INSTALLER / name, f"JOPT-Memory/installer/{name}")
        skill = "skills/jopt-handoff-memory/SKILL.md"
        bundle.write(INSTALLER.parent / skill, f"JOPT-Memory/{skill}")
    probe = assets / "grok-local-probe-1.py"
    shutil.copyfile(SITE / "grok_probe.py", probe)
    data = {
        "zip": {"path": f"downloads/{archive.name}", "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()},
        "probe": {"path": f"downloads/{probe.name}", "sha256": hashlib.sha256(probe.read_bytes()).hexdigest()},
        "instructions": {
            language: {
                "claude": render(language, ACCOUNT[language], "basic-memory-jopt", "work-status-preview"),
                "gpt": render(language, ACCOUNT[language], "basic-memory", "work-status-preview"),
                "grok": render(language, GROK[language], "", "", trial=True),
            }
            for language in ACCOUNT
        },
    }
    payload = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
    shutil.copyfile(SITE / "index.html", destination / "index.html")
    shutil.copyfile(SITE / "app.js", destination / "app.js")
    shutil.copyfile(SITE / "style.css", destination / "style.css")
    (destination / "release.js").write_text("window.JOPT_RELEASE = " + payload + ";\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    build(parser.parse_args().destination)
