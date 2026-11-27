"use strict";

const release = window.JOPT_RELEASE;
const find = (id) => document.getElementById(id);
const translations = {
  ja: {
    htmlLanguage: "ja", language: "言語", title: "JOPT Memory のインストール",
    step1: "ステップ 1：自動インストール（Codex・Claude Code など、パソコンのファイルを読める AI）",
    accountTitle: "ステップ 2：アカウントの指示を手動で貼る",
    accountIntro: "Codex と Claude Code の常設指示は、それぞれ AGENTS.md と CLAUDE.md に設定されます。ローカル MCP に接続した Claude や ChatGPT のデスクトップチャットで JOPT Memory を使う場合は、下の指示をアカウントのパーソナライズ設定に貼り付けて保存してください。新しいチャットで接続を確認します。",
    claudeWhere: "Claude の設定 →「マイ Claude」→「指示」に貼り付けて保存します。",
    copyClaude: "Claude 用の指示をコピー",
    chatgptWhere: "ChatGPT の設定 →「パーソナライズ」→「カスタム指示」に貼り付けて保存します。表示名はプランや版によって異なる場合があります。",
    copyChatgpt: "ChatGPT 用の指示をコピー",
    grokWhere: "実機検証待ちです。デスクトップ版の Settings → Computer → Your computer で、その都度確認する設定（Ask every time）を選び、コピーした指示を Bot のチャットに貼り付けてください。事前に Codex で jopt-tests/ に確認コード付きのテストノートを用意します。",
    copyGrok: "Grok Bot の読み取りテスト指示をコピー",
    grokCopied: "コピーしました。Grok Bot のチャットに貼り付けて送信してください。",
    grokPrompt: "Grok Bot デスクトップ版のローカル実行機能を使い、この端末にある JOPT Memory を読み取り専用でテストしてください。まず対象のテストノート名を私に確認し、ローカルで実行する操作を示して承認を待ってください。この端末の {binding} から source 項目を確認し、そのフォルダの jopt-tests/ にある指定ノートだけを読み、相対パスと本文の確認コードを返してください。設定やファイルへの書き込みは行わず、クラウド上の Bot のコンピューター、Google Drive、他のノートは使わないでください。実行できなければ失敗した手順と理由を伝えてください。",
    accountFile: "インストール後、同じ内容のファイルが {path} に保存されます。プロジェクト名を変えてインストールした場合は、そちらのファイルの内容を貼り付けてください。",
    accountCopied: "コピーしました。設定の指示欄に貼り付けて保存してください。",
    intro: "このパソコンにインストールします。AI が必要なソフトを確認し、Python がなければ、あなたの許可を得てインストールします。",
    platform: "このパソコンの種類", mac: "Mac 版は試験運用中です。実機での確認はこれからです。",
    start: "Codex でインストールを始める", copy: "Claude Code 用の指示をコピー",
    send: "Codex が開いたら、入力済みの指示を送信してください。Claude Code の場合は、コピーした指示を開いている会話に貼り付けて送信します。",
    drive: "Google Drive for desktop に会社アカウントでログインします。フォルダ選択画面が出たら、Google Drive の「共有ドライブ」で会社から指定された自分用の JOPT Memory フォルダを選びます。",
    approve: "AI やパソコンに確認画面が表示されたら、内容を確認して許可します。",
    manual: "自分でインストールする", download: "インストーラーをダウンロード",
    manualDescription: "Python 3.12 以上を用意し、ZIP を展開して JOPT-Memory/installer 内の {entry} を実行します。",
    copied: "コピーしました。Claude Code のローカル会話に貼り付けて送信してください。",
    fallback: "指示を選択しました。手動でコピーしてください。",
    prompt: "この {platform} に JOPT Memory をインストールしてください。まず Python 3.12 以上と Google Drive for desktop が使えるか調べてください。Python がなければ私に確認し、承認後に公式配布元からインストールしてください。{python} 利用できる Python の実行パスとバージョンを確認してから進めてください。Drive の設定は、会社アカウントでのログインと会社から指定された自分用の共有ドライブのフォルダ選択だけを案内してください。既存の Basic Memory とノートを再利用し、変更内容を示して承認を得たら、次の ZIP を取得して SHA-256 を照合し、JOPT-Memory/installer 内の {entry} を実行してください。照合に失敗したら中止してください。完了後は本機の MCP とアップロードタスクを確認し、私の操作が必要な場合だけ次の一手を日本語で案内してください。",
  },
  zh: {
    htmlLanguage: "zh-CN", language: "语言", title: "安装 JOPT Memory",
    step1: "第 1 步：自动安装（Codex、Claude Code 等能读本机文件的 AI）",
    accountTitle: "第 2 步：手动粘贴账号指示",
    accountIntro: "Codex 和 Claude Code 的常驻指示分别放在 AGENTS.md 和 CLAUDE.md。若要在连接了本地 MCP 的 Claude 或 ChatGPT 桌面聊天中使用 JOPT Memory，请把下方指示粘贴到账号的个性化设置并保存，再开一个新对话确认连接。",
    claudeWhere: "在 Claude 的设置 →「我的 Claude（マイ Claude）」→「指示」里粘贴并保存。",
    copyClaude: "复制 Claude 用指示",
    chatgptWhere: "在 ChatGPT 的设置 →「个性化」→「自定义指令」里粘贴并保存。菜单名可能随版本或方案变化。",
    copyChatgpt: "复制 ChatGPT 用指示",
    grokWhere: "待真机验证。打开 Grok Bot 桌面端的 Settings → Computer → Your computer，选择按次确认（Ask every time），把复制的指示粘贴到 Bot 对话。测试前先用 Codex 在 jopt-tests/ 准备一条带验证码的模拟笔记。",
    copyGrok: "复制 Grok Bot 只读测试指示",
    grokCopied: "已复制。请粘贴到 Grok Bot 对话并发送。",
    grokPrompt: "请用 Grok Bot 桌面端的本机执行功能，对这台电脑上的 JOPT Memory 做只读测试。先问我指定哪一条模拟笔记，再显示将在本机执行的操作并等我批准。从 {binding} 读取 source 字段，进入该目录下的 jopt-tests/，只读取我指定的笔记，返回相对路径和正文中的验证码。不要改动文件或配置，不要去 Bot 云电脑、Google Drive 或其他笔记找替代内容。如果无法完成，说明具体卡在哪一步及原因。",
    accountFile: "安装后，同样内容的文件保存在 {path}。如果安装时改了项目名，请粘贴那里的文件内容。",
    accountCopied: "已复制。请粘贴到设置里的指示栏并保存。",
    intro: "在这台电脑上安装。AI 会检查所需软件，缺少 Python 时会先问你，再帮你安装。",
    platform: "这台电脑的系统", mac: "Mac 版正在试点，尚待真机验证。",
    start: "用 Codex 开始安装", copy: "复制 Claude Code 安装指令",
    send: "Codex 打开后，发送已填好的指令。如果用 Claude Code，把复制的指令粘贴到本地会话并发送。",
    drive: "用公司账号登录 Google Drive 桌面版。弹出选目录窗口后，在 Google Drive 的「共享云端硬盘」里选公司分配给你的 JOPT Memory 文件夹。",
    approve: "AI 或系统弹出确认时，查看内容后点允许。",
    manual: "手动安装", download: "下载安装包",
    manualDescription: "准备 Python 3.12 或更新版本，解压 ZIP，然后运行 JOPT-Memory/installer 下的 {entry}。",
    copied: "已复制。请粘贴到 Claude Code 本地会话并发送。",
    fallback: "已选中指令，请手动复制。",
    prompt: "请在这台 {platform} 电脑上安装 JOPT Memory。先检查能否使用 Python 3.12 或更新版本和 Google Drive 桌面版。如果缺少 Python，先征得我的同意，再从官方来源安装。{python} 确认可用 Python 的位置和版本再继续。Drive 部分引导我用公司账号登录并选择公司分配给我的共有盘文件夹。复用现有 Basic Memory 和笔记，列出将做的改动，经我确认后下载以下 ZIP 并校验 SHA-256，再运行 JOPT-Memory/installer 下的 {entry}。校验失败则停止。完成后检查本地 MCP 和后台上传任务。只有需要我操作时，才用中文告诉我接下来点哪里。",
  },
  ko: {
    htmlLanguage: "ko", language: "언어", title: "JOPT Memory 설치",
    step1: "1단계: 자동 설치 (Codex, Claude Code 등 컴퓨터의 파일을 읽는 AI)",
    accountTitle: "2단계: 계정 지시를 직접 붙여넣기",
    accountIntro: "Codex와 Claude Code의 상시 지침은 각각 AGENTS.md와 CLAUDE.md에 설정됩니다. 로컬 MCP에 연결된 Claude 또는 ChatGPT 데스크톱 채팅에서 JOPT Memory를 사용하려면 아래 지침을 계정의 개인 맞춤 설정에 붙여넣어 저장하고 새 채팅에서 연결을 확인하세요.",
    claudeWhere: "Claude 설정 → ‘내 Claude(Your Claude)’ → ‘지침’에 붙여넣고 저장하세요.",
    copyClaude: "Claude용 지시 복사 (영어)",
    chatgptWhere: "ChatGPT 설정 → ‘개인 맞춤 설정’ → ‘맞춤형 지침’에 붙여넣고 저장하세요. 요금제나 버전에 따라 메뉴 이름이 다를 수 있습니다.",
    copyChatgpt: "ChatGPT용 지시 복사 (영어)",
    grokWhere: "실제 기기에서 검증이 필요합니다. Grok Bot 데스크톱 앱의 Settings → Computer → Your computer에서 매번 확인(Ask every time)을 선택하고, 복사한 지시를 Bot 대화에 붙여넣으세요. 테스트 전에 Codex로 jopt-tests/에 확인 코드가 들어 있는 테스트 노트를 준비하세요.",
    copyGrok: "Grok Bot 읽기 테스트 지시 복사",
    grokCopied: "복사했습니다. Grok Bot 대화에 붙여넣고 전송하세요.",
    grokPrompt: "Grok Bot 데스크톱 앱의 로컬 실행 기능으로 이 컴퓨터의 JOPT Memory 읽기 테스트를 진행해 주세요. 먼저 테스트할 노트 이름을 제게 물어보고, 이 컴퓨터에서 실행할 작업을 보여 준 뒤 제 승인을 기다리세요. {binding}에서 source 항목을 확인하고, 그 폴더의 jopt-tests/ 안에서 제가 지정한 노트만 읽어 상대 경로와 본문의 확인 코드를 반환하세요. 파일과 설정을 바꾸거나 Bot의 클라우드 컴퓨터, Google Drive, 다른 노트를 사용하지 마세요. 실행할 수 없다면 어느 단계에서 왜 실패했는지 알려 주세요.",
    accountFile: "설치 후 같은 내용의 파일이 {path}에 저장됩니다. 설치할 때 프로젝트 이름을 바꿨다면 그 파일의 내용을 붙여넣으세요.",
    accountCopied: "복사했습니다. 설정의 지시 칸에 붙여넣고 저장하세요.",
    intro: "이 컴퓨터에 설치합니다. AI가 필요한 프로그램을 확인하고 Python이 없으면 먼저 동의를 받은 뒤 설치해 드립니다.",
    platform: "이 컴퓨터의 운영체제", mac: "Mac 버전은 시범 운영 중이며 실제 기기에서 검증이 필요합니다.",
    start: "Codex에서 설치 시작", copy: "Claude Code용 설치 지시 복사",
    send: "Codex가 열리면 입력된 지시를 전송하세요. Claude Code를 쓰는 경우 복사한 지시를 로컬 대화에 붙여넣고 전송하세요.",
    drive: "회사 계정으로 데스크톱용 Google Drive에 로그인하세요. 폴더 선택 창이 열리면 Google Drive의 ‘공유 드라이브’에서 회사가 배정한 내 JOPT Memory 폴더를 고르세요.",
    approve: "AI나 시스템이 확인을 요청하면 내용을 확인한 뒤 허용하세요.",
    manual: "직접 설치", download: "설치 파일 다운로드",
    manualDescription: "Python 3.12 이상을 준비하고 ZIP을 푼 뒤 JOPT-Memory/installer 폴더 안의 {entry}을(를) 실행하세요.",
    copied: "복사했습니다. Claude Code의 로컬 대화에 붙여넣고 전송하세요.",
    fallback: "지시를 선택했습니다. 직접 복사하세요.",
    prompt: "이 {platform} 컴퓨터에 JOPT Memory를 설치해 주세요. 먼저 Python 3.12 이상과 데스크톱용 Google Drive를 사용할 수 있는지 확인하세요. Python이 없으면 제 동의를 받은 후 공식 배포 경로에서 설치하세요. {python} 사용할 Python의 경로와 버전을 확인한 뒤 진행하세요. Google Drive는 제가 회사 계정으로 로그인하고 배정받은 공유 드라이브 폴더를 선택할 수 있게 안내하세요. 기존 Basic Memory와 노트를 재사용하세요. 변경 내용을 보여 주고 제 승인을 받은 뒤 아래 ZIP을 다운로드하여 SHA-256을 확인하고, JOPT-Memory/installer 폴더의 {entry}을 실행하세요. 해시가 다르면 중단하세요. 설치가 끝나면 로컬 MCP와 백그라운드 업로드 작업을 확인하세요. 제가 직접 해야 할 작업이 있을 때만 한국어로 다음에 누를 곳을 알려 주세요.",
  },
};

const pythonHelp = {
  ja: {
    windows: "WinGet が使える場合は Python.Python.3.12 を使い、使えない場合は python.org の公式 Windows インストーラーを案内してください。",
    mac: "Homebrew が既にあれば python@3.12 を使い、なければ python.org の公式 macOS インストーラーを案内してください。",
  },
  zh: {
    windows: "可用 WinGet 时用 Python.Python.3.12，否则引导我用 python.org 官方 Windows 安装程序。",
    mac: "已有 Homebrew 时用 python@3.12，否则引导我用 python.org 官方 macOS 安装程序。",
  },
  ko: {
    windows: "WinGet이 있으면 Python.Python.3.12를 사용하고, 없으면 python.org의 공식 Windows 설치 프로그램을 안내하세요.",
    mac: "Homebrew가 이미 있으면 python@3.12를 사용하고, 없으면 python.org 공식 macOS 설치 프로그램을 안내하세요.",
  },
};

const accountLanguage = { ja: "ja", zh: "zh", ko: "en" };
const accountFolder = {
  windows: "%LOCALAPPDATA%\\JOPT Memory\\instructions\\",
  mac: "~/Library/Application Support/JOPT Memory/instructions/",
};
const uploadBinding = {
  windows: "%LOCALAPPDATA%\\JOPT Memory\\upload.json",
  mac: "~/Library/Application Support/JOPT Memory/upload.json",
};
const language = find("language");
const downloadURL = new URL(release.zip.path, window.location.href).href;
const labels = document.querySelectorAll("[data-label]");

function installOptions() {
  const platform = document.querySelector('input[name="os"]:checked').value;
  return {
    os: platform,
    platform: platform === "mac" ? "Mac" : "Windows",
    entry: platform === "mac" ? "bash Install-Mac.command" : "Install.cmd",
    python: pythonHelp[language.value][platform],
  };
}

function installPrompt() {
  const options = installOptions();
  const template = translations[language.value].prompt;
  return template.replace(/\{(platform|entry|python)\}/g, (_, key) => options[key]) +
    "\n\n" + downloadURL + "\nSHA-256: " + release.zip.sha256;
}

function refresh() {
  const messages = translations[language.value];
  const options = installOptions();
  document.documentElement.lang = messages.htmlLanguage;
  document.title = messages.title;
  for (const label of labels) label.textContent = messages[label.dataset.label];
  find("platform-status").textContent = messages.mac;
  find("platform-status").hidden = options.os !== "mac";
  find("manual-description").textContent = messages.manualDescription.replace("{entry}", options.entry);
  find("start").href = "codex://new?prompt=" + encodeURIComponent(installPrompt());
  find("manual-copy").hidden = true;
  find("feedback").hidden = true;
  find("account-file").textContent = messages.accountFile.replace("{path}", accountFolder[options.os]);
  find("account-copy").hidden = true;
  find("account-feedback").hidden = true;
}

async function copyPrompt() {
  const message = installPrompt();
  const strings = translations[language.value];
  const feedback = find("feedback");
  try {
    await navigator.clipboard.writeText(message);
    feedback.textContent = strings.copied;
  } catch {
    const field = find("manual-copy");
    field.hidden = false;
    field.value = message;
    field.setAttribute("aria-label", strings.copy);
    field.focus();
    field.select();
    feedback.textContent = strings.fallback;
  }
  feedback.hidden = false;
}

async function copyConfiguration(client) {
  const strings = translations[language.value];
  const isGrok = client === "grok";
  const message = isGrok
    ? strings.grokPrompt.replace("{binding}", uploadBinding[installOptions().os])
    : release.account[accountLanguage[language.value]][client];
  const feedback = find("account-feedback");
  try {
    await navigator.clipboard.writeText(message);
    feedback.textContent = isGrok ? strings.grokCopied : strings.accountCopied;
  } catch {
    const field = find("account-copy");
    field.hidden = false;
    field.value = message;
    field.focus();
    field.select();
    feedback.textContent = strings.fallback;
  }
  feedback.hidden = false;
}

find("download").href = downloadURL;
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", () => copyConfiguration(button.dataset.copy));
}
find("copy").addEventListener("click", copyPrompt);
language.addEventListener("change", refresh);
for (const choice of document.querySelectorAll('input[name="os"]')) choice.addEventListener("change", refresh);
const platform = navigator.userAgentData?.platform || navigator.platform || "";
if (/^Mac/i.test(platform) && !/iPhone|iPad/i.test(navigator.userAgent)) {
  document.querySelector('input[value="mac"]').checked = true;
}
refresh();