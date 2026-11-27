"""Install JOPT Memory for the current Windows user and run its batch export."""

import argparse
import hashlib
import json
import locale
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from uuid import uuid4

if sys.version_info < (3, 12):
    raise SystemExit("JOPT Memory requires Python 3.12 or later.")

import tomllib

PACKAGE = Path(__file__).resolve().parent
BEGIN = "<!-- jopt-memory:start -->"
END = "<!-- jopt-memory:end -->"
PROJECT = "work-status-preview"
TARGET_MARKER = ".jopt-memory-upload-target.json"
LEGACY_HEADINGS = {"JOPT 共用知识库", "JOPT 知识库", "JOPT ナレッジベース", "JOPT knowledge base"}
CONNECTION = {
    "zh": "本地使用 {server} MCP 的 {project} 项目。先加载 jopt-handoff-memory Skill。",
    "ja": "ローカル MCP の {server} で {project} を使用する。先に jopt-handoff-memory Skill を読み込む。",
    "en": "Use the local {server} MCP server and {project} project. Load the jopt-handoff-memory Skill first.",
}
ACCOUNT = {
    "zh": "在能访问本机的会话使用 {server} MCP 的 {project} 项目。缺少本地工具时说明限制，并给出待写内容。",
    "ja": "端末にアクセスできる会話でローカル MCP の {server} と {project} を使用する。ローカルツールが使えない場合は理由と追記案を示す。",
    "en": "In a session with access to this computer, use local {server} MCP and the {project} project. If the local tools are unavailable, explain the limitation and provide a proposed note update.",
}
GROK = {
    "zh": "待验证。仅在员工明确批准本机执行且办公电脑在线时，尝试读写指定的本地测试 Markdown。请从 Codex 回读结果。验证前只提供正式笔记的待写文本；这项测试授权不延伸到正式笔记。",
    "ja": "未検証。端末がオンラインで利用者がローカル実行を明示的に承認した場合に、指定のテスト用 Markdown だけを読み書きし、Codex で読み返す。テストの承認で正式ノートを書き換えることはできない。検証までは追記案を示す。",
    "en": "Unverified. Edit only a designated local test Markdown when the device is online and its owner explicitly approves local execution. Verify from Codex. Test approval does not authorize business-note writes.",
}


def read_json(path):
    if not path.exists():
        return {}
    result = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(result, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return result


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


UNSPECIFIED = object()


def put(path, content, before=UNSPECIFIED):
    current = path.read_bytes() if path.exists() else None
    if current == content:
        return False
    if before is not UNSPECIFIED and current != before:
        raise OSError(f"Changed while reading: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        pending = Path(file.name)
        file.write(content)
    try:
        os.replace(pending, path)
    finally:
        pending.unlink(missing_ok=True)
    return True


def publish_config(path, content, backup_dir, key):
    before = path.read_bytes() if path.exists() else None
    if before == content:
        return
    if before is not None:
        put(backup_dir / key, before)
    put(path, content, before=before)
    print(f"Updated {path}")


def instruction_change(path, rendered):
    before = path.read_bytes() if path.exists() else b""
    text = before.decode("utf-8-sig")
    block = f"{BEGIN}\n{rendered.rstrip()}\n{END}"
    if BEGIN in text or END in text:
        pattern = re.escape(BEGIN) + r"[\s\S]*?" + re.escape(END)
        updated, count = re.subn(pattern, lambda _: block, text)
        if count != 1 or text.count(BEGIN) != 1 or text.count(END) != 1:
            raise ValueError(f"Ambiguous JOPT Memory instruction block: {path}")
    elif any(re.search(r"(?m)^##\s+" + re.escape(heading) + r"\s*$", text) for heading in LEGACY_HEADINGS):
        print(f"Existing JOPT instructions retained: {path}")
        return None
    else:
        updated = block + "\n" if not text else text + (
            "" if text.endswith("\n\n") else "\n" if text.endswith("\n") else "\n\n"
        ) + block + "\n"
    if b"\r\n" in before:
        updated = updated.replace("\r\n", "\n").replace("\n", "\r\n")
    encoding = "utf-8-sig" if before.startswith(b"\xef\xbb\xbf") else "utf-8"
    return updated.encode(encoding)


def render(language, connection, server, project, *, trial=False):
    template = (PACKAGE / "instructions" / f"{language}.md").read_text(encoding="utf-8")
    if trial:
        approval_start = ("- 本规则即用户的事先授权", "- このルールを利用者の事前承認", "- The user authorizes qualifying")
        template = "\n".join(line for line in template.splitlines() if not line.startswith(approval_start)) + "\n"
    return template.replace("{{CONNECTION}}", connection.format(server=server, project=project))


def discover_language(path):
    if path.is_file():
        content = path.read_text(encoding="utf-8-sig")
        if re.search(r"(?m)^## JOPT (共用知识库|知识库)", content):
            return "zh"
        if "## JOPT ナレッジベース" in content:
            return "ja"
        if "## JOPT knowledge base" in content:
            return "en"
    system_language = (locale.getlocale()[0] or "en").lower()
    if system_language.startswith(("zh", "chinese")):
        return "zh"
    if system_language.startswith(("ja", "japanese")):
        return "ja"
    return "en"


def codex_change(current, spec):
    data = tomllib.loads(current.decode("utf-8-sig")) if current else {}
    previous = data.get("mcp_servers", {}).get("basic-memory")
    if previous:
        if not same_server(previous, spec):
            raise ValueError("Codex basic-memory points to a different project or executable.")
        tools = previous.get("tools", {})
        if any(tools.get(name, {}).get("approval_mode") != "approve" for name in ("bm_write", "bm_edit")):
            print("Existing Codex MCP settings retained. Check the bm_write and bm_edit approvals separately.")
        return current
    lines = [
        '[mcp_servers.basic-memory]',
        f'command = {json.dumps(spec["command"], ensure_ascii=False)}',
        f'args = {json.dumps(spec["args"])}',
        'tools.bm_write.approval_mode = "approve"',
        'tools.bm_edit.approval_mode = "approve"',
        '[mcp_servers.basic-memory.env]',
        f'BASIC_MEMORY_CONFIG_DIR = {json.dumps(spec["env"]["BASIC_MEMORY_CONFIG_DIR"], ensure_ascii=False)}',
    ]
    updated = current + (b"\n\n" if current else b"") + ("\n".join(lines) + "\n").encode("utf-8")
    tomllib.loads(updated.decode("utf-8-sig"))
    return updated


def claude_change(path, spec):
    current = read_json(path)
    servers = current.setdefault("mcpServers", {})
    previous = servers.get("basic-memory-jopt")
    if previous:
        if not same_server(previous, spec):
            raise ValueError("Claude Code basic-memory-jopt points to a different project or executable.")
        return path.read_bytes()
    servers["basic-memory-jopt"] = {"type": "stdio", **spec}
    return json_bytes(current)


def claude_permissions_change(path):
    current = read_json(path)
    permissions = current.setdefault("permissions", {})
    if not isinstance(permissions, dict):
        raise ValueError(f"Expected permissions object in {path}")
    allow = permissions.setdefault("allow", [])
    if not isinstance(allow, list):
        raise ValueError(f"Expected permissions.allow list in {path}")
    rules = ("mcp__basic-memory-jopt__bm_write", "mcp__basic-memory-jopt__bm_edit")
    missing = [rule for rule in rules if rule not in allow]
    if not missing:
        return path.read_bytes()
    allow.extend(missing)
    return json_bytes(current)


def same_server(existing, expected):
    current_config = existing.get("env", {}).get("BASIC_MEMORY_CONFIG_DIR")
    current_command = existing.get("command")
    return (
        existing.get("type", "stdio") == "stdio"
        and bool(current_command and current_config)
        and Path(current_command).resolve() == Path(expected["command"])
        and Path(current_config).resolve() == Path(expected["env"]["BASIC_MEMORY_CONFIG_DIR"])
        and existing.get("args") == expected["args"]
    )


def known_server(codex_path, claude_path):
    if codex_path.exists():
        data = tomllib.loads(codex_path.read_text(encoding="utf-8-sig"))
        server = data.get("mcp_servers", {}).get("basic-memory")
        if server:
            return server
    return read_json(claude_path).get("mcpServers", {}).get("basic-memory-jopt", {})


def select_folder():
    if sys.platform == "darwin":
        command = 'POSIX path of (choose folder with prompt "请选择公司共有 Google Drive 分配给你的 JOPT Memory 文件夹。请在 Finder 的 Google Drive / 共享云端硬盘下定位。")'
        result = subprocess.run(["/usr/bin/osascript", "-e", command], capture_output=True, text=True)
        if result.returncode:
            raise ValueError("Folder selection was canceled or unavailable.")
        return result.stdout.strip()
    import tkinter as tk
    from tkinter import filedialog, messagebox

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        messagebox.showinfo(
            "JOPT Memory 上传目录",
            "请在 Google Drive → 共享云端硬盘里，选择公司分配给你的 JOPT Memory 文件夹。\n\n"
            "如果还没有收到目录，请取消并联系负责人。",
            parent=root,
        )
        return filedialog.askdirectory(title="选择公司分配的 JOPT Memory 文件夹", mustexist=True, parent=root)
    finally:
        root.destroy()


def overlap(a, b):
    return a == b or a in b.parents or b in a.parents


def managed_engine(state):
    bin_dir = "Scripts" if os.name == "nt" else "bin"
    return state / "runtime" / bin_dir / ("bm.exe" if os.name == "nt" else "bm")


def engine_setup(engine, state, config, project, source):
    settings_path = config / "config.json"
    settings = read_json(settings_path)
    entry = settings.get("projects", {}).get(project)
    if isinstance(entry, str):
        entry = {"path": entry}
    if entry and (Path(entry["path"]).resolve() != source or entry.get("mode", "local") != "local"):
        raise ValueError(f"Existing Basic Memory project {project} is not this local source")
    if not entry and settings_path.exists():
        raise ValueError(f"Project {project} was not found in {settings_path}")
    if not Path(engine).is_file():
        managed = managed_engine(state)
        if Path(engine).resolve() != managed:
            raise FileNotFoundError(f"Basic Memory executable not found: {engine}")
        if not managed.exists():
            subprocess.run([sys.executable, "-m", "venv", str(state / "runtime")], check=True)
            subprocess.run(
                [str(managed.with_name("python.exe" if os.name == "nt" else "python")), "-m", "pip", "install", "basic-memory==1.0.0"],
                check=True,
            )
    if not entry:
        source.mkdir(parents=True, exist_ok=True)
        put(settings_path, json_bytes({"default_project": project, "projects": {
            project: {"path": str(source), "mode": "local"},
        }}))


def parse_install(args, state):
    home = Path(args.user_home).resolve() if args.user_home else Path.home()
    codex = Path(os.environ.get("CODEX_HOME", home / ".codex")) if not args.user_home else home / ".codex"
    claude = Path(os.environ.get("CLAUDE_CONFIG_DIR", home / ".claude")) if not args.user_home else home / ".claude"
    claude_settings = claude / ".claude.json" if claude != home / ".claude" else home / ".claude.json"
    # Normally the MCP registration is held in ~/.claude.json.
    old = known_server(codex / "config.toml", claude_settings)
    old_args = old.get("args", [])
    project = args.project or (old_args[old_args.index("--project") + 1] if "--project" in old_args else PROJECT)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", project):
        raise ValueError("Invalid Basic Memory project name")
    config = Path(args.bm_config or old.get("env", {}).get("BASIC_MEMORY_CONFIG_DIR") or state / "memory-config").resolve()
    raw_entry = read_json(config / "config.json").get("projects", {}).get(project, {})
    existing_source = raw_entry if isinstance(raw_entry, str) else raw_entry.get("path")
    source = Path(args.source or existing_source or state / "notes").resolve()
    current = read_json(state / "upload.json")
    candidate = args.destination or current.get("destination")
    if not candidate and not args.preview:
        candidate = select_folder()
    if not candidate:
        raise ValueError("Select your company-assigned Shared Drive folder or use --destination.")
    target = Path(candidate).resolve(strict=True)
    if not target.is_dir() or target == Path(target.anchor) or overlap(source, target) or overlap(state, target):
        raise ValueError("Select a separate, existing folder on the company Shared Drive.")
    if current and (Path(current["destination"]) != target or Path(current["source"]) != source):
        raise ValueError("This installation is already bound to another source or destination. Review upload.json before rebinding.")
    engine = Path(args.bm or old.get("command") or shutil.which("bm") or managed_engine(state)).resolve()
    return codex, claude, claude_settings, project, config, source, target, engine


def install(args, state):
    codex, claude, claude_settings, project, config, source, target, engine = parse_install(args, state)
    codex_md = codex / "AGENTS.md"
    claude_md = claude / "CLAUDE.md"
    languages = {
        "Codex": args.codex_language or args.language or discover_language(codex_md),
        "Claude": args.claude_language or args.language or discover_language(claude_md),
    }
    languages["ChatGPT"] = args.gpt_language or args.language or languages["Codex"]
    languages["Grok"] = args.grok_language or args.language or languages["Codex"]
    spec = {"command": str(engine), "args": ["mcp", "--transport", "stdio", "--project", project],
            "env": {"BASIC_MEMORY_CONFIG_DIR": str(config)}}
    codex_config = codex / "config.toml"
    current = codex_config.read_bytes() if codex_config.exists() else b""
    codex_data = codex_change(current, spec)
    claude_data = claude_change(claude_settings, spec)
    claude_permissions = claude / "settings.json"
    claude_permissions_data = claude_permissions_change(claude_permissions)
    print(f"Source: {source}\nAssigned destination: {target}\nProject: {project}\nLanguages: {languages}")
    print(f"Client targets: {codex_md}; {claude_md}; {codex_config}; {claude_settings}; {claude_permissions}")
    if args.preview:
        return
    if not args.yes and input("Install and bind this company folder? Type YES: ").strip() != "YES":
        print("Installation canceled.")
        return
    previous_binding = read_json(state / "upload.json")
    target_marker = target / TARGET_MARKER
    existing_marker = read_json(target_marker)
    target_id = previous_binding.get("target_id")
    if existing_marker and existing_marker.get("id") != target_id and not args.adopt_destination:
        raise ValueError("The selected folder is already assigned to another installation.")
    if target_id and (not existing_marker or existing_marker.get("id") != target_id):
        raise ValueError("The assigned target marker is unavailable. Check the Drive mount before reinstalling.")
    engine_setup(engine, state, config, project, source)
    backup = state / "backups" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    for label, root, path, server in (
        ("Codex", codex, codex_md, "basic-memory"),
        ("Claude", claude, claude_md, "basic-memory-jopt"),
    ):
        rendered = render(languages[label], CONNECTION[languages[label]], server, project)
        result = instruction_change(path, rendered)
        if result is not None:
            publish_config(path, result, backup, f"{label}-{path.name}")
        skill = PACKAGE.parent / "skills" / "jopt-handoff-memory" / "SKILL.md"
        publish_config(root / "skills" / "jopt-handoff-memory" / "SKILL.md", skill.read_bytes(), backup, f"{label}-SKILL.md")
    publish_config(codex_config, codex_data, backup, "Codex-config.toml")
    publish_config(claude_settings, claude_data, backup, "Claude-Code-config.json")
    publish_config(claude_permissions, claude_permissions_data, backup, "Claude-Code-settings.json")
    for label, filename, server in (
        ("ChatGPT", "ChatGPT-Instructions.md", "basic-memory"),
        ("Claude", "Claude-Chat-Instructions.md", "basic-memory-jopt"),
        ("Grok", "Grok-Bot-Instructions-UNVERIFIED.md", ""),
    ):
        language = languages[label]
        connection = GROK[language] if label == "Grok" else ACCOUNT[language]
        text = render(language, connection, server, project, trial=label == "Grok")
        put(state / "instructions" / filename, text.encode("utf-8"))
    put(state / "instructions" / "Claude-Desktop-MCP.json", json_bytes({"mcpServers": {"basic-memory-jopt": spec}}))
    target_id = target_id or existing_marker.get("id") or str(uuid4())
    if not existing_marker:
        put(target_marker, json_bytes({"id": target_id}), before=None)
    put(state / "upload.json", json_bytes({
        "source": str(source), "destination": str(target), "target_id": target_id,
    }))
    runtime = state / "upload-runner.py"
    put(runtime, Path(__file__).read_bytes())
    if not args.no_schedule and os.name == "nt":
        executable = Path(sys.executable)
        pythonw = executable.with_name("pythonw.exe")
        result = subprocess.run([
            "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
            str(PACKAGE / "register-task.ps1"), str(pythonw if pythonw.exists() else executable),
            str(runtime), str(state),
        ], check=True, capture_output=True, text=True)
        print(f"Scheduled: {result.stdout.strip()}")
    elif not args.no_schedule:
        register_mac_upload(state, runtime)
    print(f"Account instructions and Grok draft: {state / 'instructions'}")
    print("Restart local clients. Apply account-level instructions manually when appropriate.")


def register_mac_upload(state, runtime):
    label = "com.jopt.memory.upload"
    plist = Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"
    logs = state / "logs"
    logs.mkdir(exist_ok=True)
    specification = {
        "Label": label,
        "ProgramArguments": [sys.executable, str(runtime), "--state", str(state), "--upload"],
        "WorkingDirectory": str(state),
        "RunAtLoad": True,
        "StartInterval": 3600,
        "StandardOutPath": str(logs / "upload.log"),
        "StandardErrorPath": str(logs / "upload-error.log"),
    }
    domain = f"gui/{os.getuid()}"
    target = f"{domain}/{label}"
    launchctl = "/bin/launchctl"
    loaded = subprocess.run([launchctl, "print", target], capture_output=True).returncode == 0
    before = plist.read_bytes() if plist.exists() else None
    content = plistlib.dumps(specification)
    if loaded and before == content:
        print(f"Scheduled: {target}")
        return
    if loaded:
        subprocess.run([launchctl, "bootout", target], check=True, capture_output=True, text=True)
    try:
        put(plist, content, before=before)
        subprocess.run([launchctl, "bootstrap", domain, str(plist)], check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError):
        if before is not None:
            put(plist, before)
            if loaded:
                subprocess.run([launchctl, "bootstrap", domain, str(plist)], capture_output=True)
        raise
    print(f"Scheduled: {target}")


def eligible_notes(source):
    history = source / "jopt-history"
    if history.is_dir() and not history.is_symlink():
        for folder, dirs, files in os.walk(history, followlinks=False):
            base = Path(folder)
            dirs[:] = [name for name in dirs if not (base / name).is_symlink() and not name.startswith(".")]
            for name in sorted(files):
                path = base / name
                if path.suffix.lower() == ".md" and not name.startswith(".") and not path.is_symlink():
                    yield path
    previous = source / "pre-reservation-mailer-history.md"
    if previous.is_file() and not previous.is_symlink():
        yield previous


def upload(state):
    config = read_json(state / "upload.json")
    source = Path(config["source"]).resolve(strict=True)
    target = Path(config["destination"]).resolve(strict=True)
    if overlap(source, target) or not target.is_dir():
        raise ValueError("Upload destination is unavailable or overlaps the source.")
    if not config.get("target_id") or read_json(target / TARGET_MARKER).get("id") != config["target_id"]:
        raise ValueError("Drive mount does not contain the assigned folder marker.")
    manifest_path = state / "uploaded.json"
    manifest = read_json(manifest_path)
    copied = 0
    problems = []
    for note in eligible_notes(source):
        relative = note.relative_to(source)
        key = relative.as_posix()
        try:
            dest = target / relative
            if not dest.resolve().is_relative_to(target) or dest.is_symlink() or any(
                parent.is_symlink() for parent in dest.parents if parent != target and parent.is_relative_to(target)
            ):
                raise ValueError("Destination contains a redirected path")
            content = note.read_bytes()
            digest = hashlib.sha256(content).hexdigest()
            current_content = dest.read_bytes() if dest.exists() else None
            current = hashlib.sha256(current_content).hexdigest() if current_content is not None else None
            if current != digest:
                if current is not None and current != manifest.get(key):
                    raise ValueError("Drive contains a different version; kept for review")
                put(dest, content, before=current_content)
                if hashlib.sha256(dest.read_bytes()).hexdigest() != digest:
                    raise OSError("Destination readback did not match")
                copied += 1
            manifest[key] = digest
        except (OSError, ValueError) as error:
            problems.append(f"{key}: {error}")
    put(manifest_path, json_bytes(manifest))
    return copied, problems


def run_upload(state):
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        copied, problems = upload(state)
        status = {"attempt_at": now, "copied_to_drive_mount": copied, "errors": problems}
    except (OSError, ValueError, KeyError) as error:
        status = {"attempt_at": now, "copied_to_drive_mount": 0, "errors": [str(error)]}
    path = state / "upload-status.json"
    previous = read_json(path)
    status["last_successful_copy_at"] = previous.get("last_successful_copy_at")
    if not status["errors"]:
        status["last_successful_copy_at"] = now
    put(path, json_bytes(status))
    if sys.stdout is not None:
        print(json.dumps(status, ensure_ascii=False))
    return int(bool(status["errors"]))


def main():
    if os.name != "nt" and sys.platform != "darwin":
        raise SystemExit("JOPT Memory supports Windows and macOS.")
    parser = argparse.ArgumentParser()
    for field in ("user-home", "state", "source", "destination", "project", "bm", "bm-config"):
        parser.add_argument(f"--{field}")
    for field in ("language", "codex-language", "claude-language", "gpt-language", "grok-language"):
        parser.add_argument(f"--{field}", choices=tuple(CONNECTION))
    for field in ("upload", "preview", "yes", "no-schedule", "adopt-destination"):
        parser.add_argument(f"--{field}", action="store_true")
    args = parser.parse_args()
    if args.user_home and not (args.no_schedule or args.preview):
        parser.error("--user-home requires --no-schedule for an isolated installation.")
    default_base = Path(os.environ["LOCALAPPDATA"]) if os.name == "nt" else Path.home() / "Library" / "Application Support"
    state = Path(args.state or default_base / "JOPT Memory").resolve()
    if args.upload:
        return run_upload(state)
    install(args, state)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as exc:
        if isinstance(exc, subprocess.CalledProcessError) and exc.stderr:
            print(exc.stderr, file=sys.stderr)
        print(f"JOPT Memory: {exc}", file=sys.stderr)
        sys.exit(1)
