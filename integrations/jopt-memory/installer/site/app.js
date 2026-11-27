"use strict";

const release = window.JOPT_RELEASE;
const find = (id) => document.getElementById(id);
const link = (path) => new URL(path, window.location.href).href;
const osLabel = () => document.querySelector('input[name="os"]:checked').value;
const language = () => find("language").value;

function launchPrompt(asset, message) {
  return message + "\n\n下载地址：" + link(asset.path) + "\nSHA-256：" + asset.sha256;
}

function currentInstall() {
  const platform = osLabel();
  const launch = platform === "mac"
    ? "使用 Python 3.12+，解压到临时目录后从 JOPT-Memory/installer 运行 bash Install-Mac.command。Mac 是待真机验证的试点。"
    : "使用 Python 3.12+，解压到临时目录后从 JOPT-Memory/installer 运行 Install.cmd。";
  return launchPrompt(release.zip, "请在我这台" + (platform === "mac" ? " Mac " : " Windows ") +
    "电脑上安装 JOPT Memory。先核对系统、现有 Basic Memory 和目标目录；请我选择或确认公司分配给我的共有 Drive 文件夹，显示将配置的客户端和上传任务，等我确认后执行。" +
    "从下面的安装页资产下载并核对 SHA-256。若下载要求登录，请用已登录浏览器下载，或请我提供从该网页下载的同一文件。校验失败则停止。\n" + launch +
    "\n复用已有项目和笔记。安装一次即配置 Codex 和 Claude Code；重复安装复用上传任务。安装后检查本地 MCP、日语 Skill 和上传任务，说明还需由我确认的操作。");
}

function currentGrok() {
  const platform = osLabel() === "mac" ? "在本机 Mac 用 python3 运行" : "在本机 Windows 用 Python Launcher 或已安装的 Python 运行";
  return launchPrompt(release.probe,
    "请只在我的实体办公电脑上验证 JOPT Memory。先请我核对即将批准的是本机执行；云电脑执行不算通过。" +
    "将以下 Python 脚本下载到本机临时目录，核对 SHA-256，" + platform +
    "。默认读取已安装的本地 JOPT Memory 配置；如果配置缺失，请我确认现有 Basic Memory 笔记文件夹，然后传 --source。下载需登录时请我从这个安装页下载。只允许创建一条 jopt-tests/ 下的模拟笔记，" +
    "不要查阅正式笔记、访问 Drive 或创建定时任务。把脚本输出的相对文件名和校验词分别告诉我；出错时报告实际原因，不要在云电脑伪造结果。");
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    find("feedback").textContent = label;
    find("feedback").hidden = false;
  } catch {
    const field = find("manual-copy");
    find("clipboard-fallback").hidden = false;
    field.value = text;
    field.focus();
    field.select();
    find("feedback").textContent = "浏览器未开放剪贴板，已选中指令。";
    find("feedback").hidden = false;
  }
}

function refresh() {
  const mac = osLabel() === "mac";
  find("os-status").textContent = mac ? "Mac 安装试点 · 真机待验证" : "Windows 安装试点 · 已验证首次自动上传";
  find("directory-app").textContent = mac ? "Finder" : "文件资源管理器";
  const prompt = currentInstall();
  find("install-prompt").value = prompt;
  find("codex-install").href = "codex://new?prompt=" + encodeURIComponent(prompt);
  const grok = currentGrok();
  if (grok.length > 1000) throw new Error("Grok Bot deep link exceeds the documented limit.");
  find("grok-link").href = "grokbot://app/v1/prompt?text=" + encodeURIComponent(grok);
  find("download").href = link(release.zip.path);
}

for (const item of document.querySelectorAll('input[name="os"]')) item.addEventListener("change", refresh);
if (/Mac/i.test(navigator.userAgent) && !/iPhone|iPad/i.test(navigator.userAgent)) {
  document.querySelector('input[value="mac"]').checked = true;
}
find("copy-install").addEventListener("click", () => copy(currentInstall(), "已复制本机安装指令"));
find("claude-install").addEventListener("click", () => copy(currentInstall(), "已复制，请在本地 Claude Code 会话中粘贴并发送"));
find("copy-grok").addEventListener("click", () => copy(currentGrok(), "已复制 Grok Bot 本机测试指令"));
find("verify-grok").addEventListener("click", () => copy(
  "请通过我的本地 Basic Memory MCP 搜索 jopt-tests/ 中最新一条标题包含「模拟 Grok Bot local」的测试笔记。读取其正文，并返回相对文件名和正文里的 GROK-LOCAL 校验词。只有实际读到才回答。",
  "已复制，请在 Codex 新开的本地会话里发送"));
find("seed").addEventListener("click", () => copy(
  "请在本机做一次 JOPT 交接记忆初始化。仅查看我明确授权的过往 JOPT 公司记录，先问我希望使用哪些来源，再检索当前本地 Basic Memory 项目。列出建议新建、补充和原件待核对的事项，附原件和依据；排除私事、客户个人信息及凭据。等我确认后，按一项工作一条笔记写入，正文跟随当前对话语言。已有内容不重复写入。不要改上传运行方式。",
  "已复制首次整理指令"));
find("check-upload").addEventListener("click", () => copy(
  "请在本机只读检查 JOPT Memory 的上传设置、最后一次执行结果和最近成功复制时间。核对目标是公司分配给我的共有 Drive 文件夹。若本地复制成功但尚未从 Drive 网页核对，请说明云端仍待确认。发现错误先报告原因。",
  "已复制上传检查指令"));
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", () => copy(release.instructions[language()][button.dataset.copy], "已复制所选语言的指示"));
}
refresh();
