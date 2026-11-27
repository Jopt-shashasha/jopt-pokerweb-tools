"""Write a single disposable test note to the installed local JOPT Memory project."""

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
import sys


def default_binding():
    if os.name == "nt":
        base = Path(os.environ["LOCALAPPDATA"])
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        raise ValueError("Run this test on the employee's Windows or Mac desktop.")
    return base / "JOPT Memory" / "upload.json"


def write_probe(explicit_source):
    if explicit_source:
        root = Path(explicit_source).expanduser().resolve(strict=True)
        if not any((root / name).is_dir() for name in ("jopt-history", "jopt-tests")):
            raise ValueError("Choose the actual Basic Memory notes directory containing jopt-history or jopt-tests.")
    else:
        binding = default_binding()
        if not binding.is_file():
            raise ValueError("JOPT Memory binding not found. Ask the user for the verified notes directory and pass --source.")
        config = json.loads(binding.read_text(encoding="utf-8"))
        root = Path(config["source"]).resolve(strict=True)
        destination = Path(config["destination"]).resolve()
        if destination == root or destination in root.parents:
            raise ValueError("The configured source overlaps the Drive destination.")
    if not root.is_dir():
        raise ValueError("Local notes directory not found.")
    if any((parent / ".jopt-memory-upload-target.json").exists() for parent in (root, *root.parents)):
        raise ValueError("Choose the local authoritative notes directory, not a Drive replica.")
    folder = root / "jopt-tests"
    folder.mkdir(exist_ok=True)
    if folder.resolve() != folder:
        raise ValueError("The simulation folder is redirected.")
    marker = secrets.token_hex(6).upper()
    note = folder / f"grok-local-{marker.lower()}.md"
    today = datetime.now(timezone(timedelta(hours=9))).date().isoformat()
    lines = [
        "---",
        f'title: "模拟 Grok Bot local {marker}"',
        "type: note",
        "tags: [jopt, simulation]",
        'source: "演练题面"',
        "---",
        "",
        f"Date (Asia/Tokyo): {today}",
        f"GROK-LOCAL-{marker}",
        "",
    ]
    with note.open("x", encoding="utf-8", newline="\n") as output:
        output.write("\n".join(lines))
    if f"GROK-LOCAL-{marker}" not in note.read_text(encoding="utf-8"):
        raise OSError("The test note could not be read back.")
    return {"note": note.relative_to(root).as_posix(), "marker": f"GROK-LOCAL-{marker}"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", help="Explicitly verified local Basic Memory notes folder")
    try:
        print(json.dumps(write_probe(parser.parse_args().source), ensure_ascii=False))
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Grok local test: {error}\n")
