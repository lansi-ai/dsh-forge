#!/usr/bin/env node
'use strict';

/**
 * DSH Forge 发版脚本（M4 发布链自动化）
 *
 * 流程：预检 → 质量门禁 → 版本号 bump →（可选）本地打包 → commit + tag →（可选）推送
 *       →（可选 --publish-local）建 Release + 上传产物 + 匿名复核描述符
 *
 * 用法：
 *   npm run release -- <version> [--local] [--clean] [--push] [--publish-local] [--skip-gates] [--dry-run]
 *
 * 选项：
 *   <version>      目标版本号（显式传，如 0.1.1-alpha.6）
 *   --local        额外执行本地 Windows 打包（npm run dist）+ 产物名对齐 latest.yml path + SHA256SUMS
 *   --clean        打包前清理 release/ 中非目标版本的旧产物（需配合 --local）
 *   --push         真实推送 main 与 v<version> tag（默认只做本地 commit/tag 并打印待推命令）
 *   --publish-local  本地打包并**直接发布到 GitHub Release**（隐含 --local）。
 *                    只推 main、**不显式推 tag**；tag 由 `gh release create --target` 在远端隐式创建
 *                    （GitHub Release 必然绑定 tag）。**2026-09-15 起按坑 70 决策 B2，两个 release
 *                    workflow 已移除 `on: push: tags`（仅 workflow_dispatch）**，故 tag 创建不再触发
 *                    CI 重建 —— **本地产物即最终权威产物**；mac 产物需为每个版本手动
 *                    `gh workflow run release-mac.yml`。需要 GitHub CLI 且已 `gh auth login`。
 *   --skip-gates   跳过 typecheck/lint/test/build 门禁（仅调试用）
 *   --dry-run      只打印将执行的命令，不写文件/不提交/不打包
 *
 * 说明：
 *   1. tag 推送后由 .github/workflows/release-{win,mac}.yml 在云端构建双平台产物并上传 GitHub Release。
 *   2. 推送退出码不可信（沙箱拦 git 凭据库会伪失败，坑 44）→ 一律以 git ls-remote 回验为准。
 *   3. 本地打包需沙箱外运行（release/ 与 AppData 缓存在工作区外，见坑 0/38/42）；`gh` 的凭据同样。
 *   4. --publish-local 的上传清单与 release-win.yml 的 upload 步逐字一致：漏 latest.yml = 更新
 *      404（坑 66），漏 .blockmap = 差量更新失效，本地名带空格 = 描述符 path 对不上（坑 41）。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const PACKAGE_LOCK = path.join(ROOT, 'package-lock.json');
const RELEASE_DIR = path.join(ROOT, 'release');
const BUILDER_CONFIG = path.join(ROOT, 'electron-builder.yml');
const BRANCH = 'main';
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** 发布目标仓库（`gh` 用；从 electron-builder.yml 的 publish 段读，避免两处漂移）。 */
const REPO = (() => {
  try {
    const text = fs.readFileSync(BUILDER_CONFIG, 'utf8');
    const owner = /^\s*owner:\s*(\S+)\s*$/m.exec(text)?.[1];
    const repo = /^\s*repo:\s*(\S+)\s*$/m.exec(text)?.[1];
    if (owner && repo) return `${owner}/${repo}`;
  } catch {
    /* 读不到就退回下面的常量 */
  }
  return 'lansi-ai/dsh-forge';
})();

/**
 * 与 release-win.yml 的 upload 步**逐字一致**的上传清单。
 *
 * 刻意排除 `latest-mac.yml`：本地产不出 mac 包，若 release/ 里残留上一批 mac 描述符，
 * 传上去会让 mac 客户端拿到指向不存在资产的描述符。
 */
const UPLOAD_PATTERNS = [/setup\.exe$/, /portable\.exe$/, /\.blockmap$/, /^latest\.yml$/, /^SHA256SUMS$/];

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const version = argv.find((arg) => !arg.startsWith('--'));
const opts = {
  local: flags.has('--local'),
  clean: flags.has('--clean'),
  push: flags.has('--push'),
  publishLocal: flags.has('--publish-local'),
  skipGates: flags.has('--skip-gates'),
  dryRun: flags.has('--dry-run'),
};
// --publish-local 隐含本地打包；推送交给 pushBranchOnly()（只推 main，不推 tag）。
if (opts.publishLocal) {
  opts.local = true;
}

function log(message) {
  console.log(`[release] ${message}`);
}

function die(message) {
  console.error(`[release] ✗ ${message}`);
  process.exit(1);
}

/** 执行 git 子命令（数组传参，规避 shell 引号与中文编码问题）。 */
function git(args, { capture = false, allowFail = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) {
    die(`git ${args.join(' ')} 执行失败：${result.error.message}`);
  }
  if (!allowFail && result.status !== 0) {
    die(`git ${args.join(' ')} 退出码 ${result.status}`);
  }
  return capture ? (result.stdout || '').trim() : '';
}

/** 执行 npm script（Windows 下 npm 为 .cmd，必须走 shell）。 */
function npmRun(script) {
  const command = `npm run ${script}`;
  if (opts.dryRun) {
    log(`(dry-run) ${command}`);
    return;
  }
  log(`▶ ${command}`);
  const result = spawnSync(command, { cwd: ROOT, shell: true, stdio: 'inherit' });
  if (result.error) {
    die(`${command} 执行失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    die(`${command} 退出码 ${result.status}`);
  }
}

/** 执行 scripts/ 下的本地脚本。 */
function runScript(fileName, extraArgs = []) {
  const scriptPath = path.join(ROOT, 'scripts', fileName);
  if (opts.dryRun) {
    log(`(dry-run) node scripts/${fileName} ${extraArgs.join(' ')}`.trim());
    return;
  }
  log(`▶ node scripts/${fileName}`);
  const result = spawnSync(process.execPath, [scriptPath, ...extraArgs], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) {
    die(`scripts/${fileName} 执行失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    die(`scripts/${fileName} 退出码 ${result.status}`);
  }
}

/** 执行 gh 子命令（--publish-local 用；文件清单显式传参，不依赖 shell glob）。 */
function gh(args, { capture = false, allowFail = false } = {}) {
  const result = spawnSync('gh', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) {
    die(`gh ${args.join(' ')} 执行失败：${result.error.message}（需要 GitHub CLI，且已 gh auth login）`);
  }
  if (!allowFail && result.status !== 0) {
    die(`gh ${args.join(' ')} 退出码 ${result.status}`);
  }
  return { status: result.status ?? 1, stdout: (result.stdout || '').trim() };
}

/** 解析语义化版本号；非法返回 null。 */
function parseVersion(value) {
  const match = VERSION_RE.exec(value);
  if (!match) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** 语义化比较：-1 / 0 / 1（无预发布 > 有预发布，数字标识符 < 字母标识符）。 */
function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] > right.core[index] ? 1 : -1;
    }
  }
  if (left.pre.length === 0 && right.pre.length === 0) {
    return 0;
  }
  if (left.pre.length === 0) {
    return 1;
  }
  if (right.pre.length === 0) {
    return -1;
  }
  const length = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index++) {
    const leftToken = left.pre[index];
    const rightToken = right.pre[index];
    if (leftToken === undefined) {
      return -1;
    }
    if (rightToken === undefined) {
      return 1;
    }
    if (leftToken === rightToken) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(leftToken);
    const rightNumeric = /^\d+$/.test(rightToken);
    if (leftNumeric && rightNumeric) {
      return Number(leftToken) > Number(rightToken) ? 1 : -1;
    }
    if (leftNumeric) {
      return -1;
    }
    if (rightNumeric) {
      return 1;
    }
    return leftToken > rightToken ? 1 : -1;
  }
  return 0;
}

/** 文本级替换版本号（保持文件原有格式，避免整文件重排产生巨大 diff）。 */
function bumpVersionField(filePath, oldVersion, newVersion, expectedCount) {
  const fileName = path.basename(filePath);
  const text = fs.readFileSync(filePath, 'utf8');
  const escaped = oldVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`"version":\\s*"${escaped}"`, 'g');
  const hits = text.match(pattern) || [];
  if (hits.length !== expectedCount) {
    die(`${fileName} 中版本号 "${oldVersion}" 出现 ${hits.length} 次（预期 ${expectedCount} 次）`);
  }
  if (opts.dryRun) {
    log(`(dry-run) ${fileName}: ${oldVersion} → ${newVersion}`);
    return;
  }
  fs.writeFileSync(filePath, text.replace(pattern, `"version": "${newVersion}"`), 'utf8');
  log(`${fileName}: ${oldVersion} → ${newVersion}`);
}

/** 预检：工作区、分支、tag 唯一性、远程同步、（本地发布时）gh 可用性。 */
function preflight() {
  if (opts.publishLocal && !opts.dryRun) {
    const probe = gh(['--version'], { capture: true, allowFail: true });
    if (probe.status !== 0) {
      die('--publish-local 需要 GitHub CLI：请安装 gh 并确保它在 PATH 上');
    }
    if (gh(['auth', 'status'], { capture: true, allowFail: true }).status !== 0) {
      die('--publish-local 需要已登录的 gh：请先执行 `gh auth login`');
    }
    log(`✓ gh 就绪（发布目标 ${REPO}）`);
  }

  const dirty = git(['status', '--porcelain'], { capture: true });
  if (dirty) {
    // 干跑是"预览计划"：状态不满足只警告，不拦——否则想看一眼计划都得先提交
    if (opts.dryRun) {
      log(`(dry-run) 工作区不干净，真实发版会在此中止：\n${dirty}`);
    } else {
      die(`工作区不干净，请先提交或暂存以下改动：\n${dirty}`);
    }
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
  if (branch !== BRANCH) {
    die(`当前分支为 ${branch}，发版必须在 ${BRANCH} 上进行`);
  }

  if (git(['rev-parse', '-q', '--verify', `refs/tags/v${version}`], { capture: true, allowFail: true })) {
    die(`tag v${version} 已存在（本地）`);
  }

  log('同步远程…');
  if (opts.dryRun) {
    // 干跑不碰 .git（git fetch 会写 FETCH_HEAD）也不依赖网络：只预览将要执行的命令
    log('(dry-run) 跳过 git fetch 与落后检查');
  } else {
    git(['fetch', 'origin', BRANCH]);
    // 允许本地领先（未推的功能提交随发版一并推送），但落后/分叉必须先对齐
    const behind = git(['rev-list', '--count', `HEAD..origin/${BRANCH}`], { capture: true });
    if (Number(behind) > 0) {
      die(`本地 ${BRANCH} 落后 origin/${BRANCH} ${behind} 个提交，请先 pull 对齐`);
    }
  }

  const remoteTag = git(['ls-remote', '--tags', 'origin', `refs/tags/v${version}`], { capture: true });
  if (remoteTag) {
    die(`tag v${version} 已存在（远程）`);
  }
}

/** 质量门禁：typecheck / lint / test / build，任一失败即中止。 */
function gates() {
  if (opts.skipGates) {
    log('⚠ 已跳过质量门禁（--skip-gates）');
    return;
  }
  for (const script of ['typecheck', 'lint', 'test', 'build']) {
    npmRun(script);
  }
  log('✓ 质量门禁通过（typecheck / lint / test / build）');
}

/** 产物名里「版本号之后的部件」——用于把 `DSH-Forge-<版本>-<部件>.<扩展名>` 的版本切出来。 */
const ARTIFACT_KINDS = new Set(['setup', 'portable', 'arm64', 'x64', 'ia32', 'armv7l', 'universal']);

/**
 * 从产物名解析它对应的版本号。
 *
 * 为什么不能拿 `name.includes(version)` 判过期：目标 `0.1.1` 是 `0.1.1-rc.5` 的**子串**，
 * 于是同核心的旧预发布产物会被判成"仍是目标版本"而永不清除，随后又被上传清单按扩展名
 * 收进 Release（rc.5 实测：两个 130MB 旧安装包会被一起传上 v0.1.1）。
 *
 * @param {string} name - release/ 下的文件名。
 * @returns 精确版本号；名字不符合本仓产物格式时返回 undefined（不猜、不动）。
 */
function versionOfArtifact(name) {
  const matched = /^DSH-Forge-(.+?)\.(exe|dmg|zip)(?:\.blockmap)?$/u.exec(name);
  if (matched === null) {
    return undefined;
  }
  const stem = matched[1];
  const cut = stem.lastIndexOf('-');
  if (cut <= 0) {
    return undefined;
  }
  const kind = stem.slice(cut + 1);
  return ARTIFACT_KINDS.has(kind) ? stem.slice(0, cut) : undefined;
}

/** 清理 release/ 中非目标版本的旧产物（仅 --clean 显式开启）。 */
function cleanStaleArtifacts() {
  if (!fs.existsSync(RELEASE_DIR)) {
    return;
  }
  const stale = fs.readdirSync(RELEASE_DIR).filter((name) => {
    const artifactVersion = versionOfArtifact(name);
    return artifactVersion !== undefined && artifactVersion !== version;
  });
  if (stale.length === 0) {
    log('release/ 无旧版本产物需清理');
    return;
  }
  for (const name of stale) {
    if (opts.dryRun) {
      log(`(dry-run) 删除 release/${name}`);
      continue;
    }
    fs.rmSync(path.join(RELEASE_DIR, name), { force: true });
    log(`已清理旧产物 release/${name}`);
  }
}

/** 本地打包：electron-builder 出包 → 产物名对齐 latest.yml path → 生成 SHA256SUMS。 */
function packageLocal() {
  cleanStaleArtifacts();
  npmRun('dist');
  runScript('align-release-assets.cjs');
  runScript('make-sums.cjs');
  log('✓ 本地打包完成（release/ 产物名已与 latest.yml path 对齐）');
}

/** 提交版本号并打 tag。 */
function commitAndTag() {
  const message = `chore(release): 版本号升至 ${version}`;
  if (opts.dryRun) {
    log('(dry-run) git add package.json package-lock.json');
    log(`(dry-run) git commit -m "${message}"`);
    log(`(dry-run) git tag v${version}`);
    return;
  }
  git(['add', 'package.json', 'package-lock.json']);
  git(['commit', '-m', message]);
  git(['tag', `v${version}`]);
  log(`✓ 已提交并打 tag v${version}`);
}

/** 推送 main 与 tag（默认只打印待推命令）；推送后以 ls-remote 回验（坑 44）。 */
function push() {
  const tag = `v${version}`;
  if (!opts.push) {
    log('未指定 --push，本地 commit/tag 已完成。待推命令：');
    console.log(`  git push origin ${BRANCH}`);
    console.log(`  git push origin ${tag}`);
    log('推送后 CI 自动构建 win+mac 并上传 GitHub Release（预发布）');
    return;
  }
  if (opts.dryRun) {
    log(`(dry-run) git push origin ${BRANCH}`);
    log(`(dry-run) git push origin ${tag}`);
    return;
  }

  // 坑 44：沙箱拦 git 凭据库会让 push 报非 0，但推送实际可能已成功 → 不据此判定失败
  for (const ref of [BRANCH, tag]) {
    git(['push', 'origin', ref], { allowFail: true });
  }

  const localHead = git(['rev-parse', 'HEAD'], { capture: true });
  const remoteHead = git(['ls-remote', 'origin', `refs/heads/${BRANCH}`], { capture: true });
  const remoteTag = git(['ls-remote', 'origin', `refs/tags/${tag}`], { capture: true });
  if (!remoteHead.startsWith(localHead)) {
    die(`回验失败：origin/${BRANCH} 未指向 ${localHead.slice(0, 7)}`);
  }
  if (!remoteTag.startsWith(localHead)) {
    die(`回验失败：origin tag ${tag} 未指向 ${localHead.slice(0, 7)}`);
  }
  log(`✓ 推送并回验通过：origin/${BRANCH} 与 ${tag} → ${localHead.slice(0, 7)}`);
  log('CI 已触发：release-win + release-mac 将构建并上传 GitHub Release');
}

/**
 * 只推 `main`（`--publish-local` 专用）：函数自身不推 tag。
 *
 * tag 随后由 `gh release create --target` 在远端创建（指向同一个提交），因此
 * `releases/download/<tag>/latest.yml` 这类更新 URL 成立。⚠️ 历史上因 release-{win,mac}
 * 监听 `push: tags`，这一步会连带触发 CI 重建并 `--clobber` 覆盖本地产物（坑 70 实测）；
 * **2026-09-15 决策 B2 已移除该触发**，故此路径不再引发重建。
 */
function pushBranchOnly() {
  const tag = `v${version}`;
  if (opts.dryRun) {
    log(`(dry-run) git push origin ${BRANCH}`);
    log(`(dry-run) gh release create ${tag} --target ${BRANCH} …`);
    return;
  }
  // 坑 44：push 退出码不可信（凭据库被拦也报非 0）→ 只以 ls-remote 回验判定
  git(['push', 'origin', BRANCH], { allowFail: true });
  const localHead = git(['rev-parse', 'HEAD'], { capture: true });
  const remoteHead = git(['ls-remote', 'origin', `refs/heads/${BRANCH}`], { capture: true });
  if (!remoteHead.startsWith(localHead)) {
    die(`回验失败：origin/${BRANCH} 未指向 ${localHead.slice(0, 7)}`);
  }
  log(`✓ origin/${BRANCH} 已指向 ${localHead.slice(0, 7)}（tag 不推，交由 Release 创建）`);
}

/** 按与 CI 一致的清单列出 release/ 下待上传的产物（顺序稳定，便于日志核对）。 */
function artifactsToUpload() {
  if (!fs.existsSync(RELEASE_DIR)) {
    die('release/ 不存在：请确认本地打包已完成');
  }
  const matched = fs
    .readdirSync(RELEASE_DIR)
    .filter((name) => UPLOAD_PATTERNS.some((pattern) => pattern.test(name)))
    .sort();
  // 第二道闸：即便没人加 --clean，也不能把别的版本号的产物传进本版 Release。
  // 与 cleanStaleArtifacts 同一判定函数，避免两处口径分叉。
  const files = [];
  for (const name of matched) {
    const artifactVersion = versionOfArtifact(name);
    if (artifactVersion !== undefined && artifactVersion !== version) {
      log(`⚠ 跳过非本版产物 release/${name}（属于 ${artifactVersion}）——建议带 --clean 重跑`);
      continue;
    }
    files.push(path.join('release', name));
  }
  if (!files.some((file) => file.endsWith('latest.yml'))) {
    die('release/latest.yml 缺失——没有更新描述符就上传，等于发布了一个谁也更新不到的新版（坑 66）');
  }
  if (!files.some((file) => file.endsWith('SHA256SUMS'))) {
    die('release/SHA256SUMS 缺失——M4-e 门禁要求校验和可外部验证');
  }
  return files;
}

/** 匿名 HEAD 复核一个发布 URL（发布完成后更新链是否真的可达）。 */
async function headStatus(url) {
  try {
    // 走 globalThis：本脚本是纯 CJS（ESLint 的 script 环境未声明 fetch），Node ≥ 18 全局自带
    const response = await globalThis.fetch(url, { method: 'HEAD', redirect: 'follow' });
    return response.status;
  } catch {
    return 0;
  }
}

/**
 * 匿名复核描述符可达（带重试：CDN 传播偶尔滞后几秒）。
 *
 * @param urls - 待复核的完整下载 URL。
 * @returns 全部 200 时为 true。
 */
async function descriptorsReachable(urls) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const results = [];
    for (const url of urls) {
      results.push([url, await headStatus(url)]);
    }
    if (results.every(([, status]) => status === 200)) {
      for (const [url] of results) {
        log(`✓ 匿名 HEAD 200 ${url}`);
      }
      return true;
    }
    for (const [url, status] of results) {
      log(`… 第 ${attempt} 次复核未通过（HTTP ${status}）：${url}`);
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  return false;
}

/**
 * 本地发布（`--publish-local`）：建 Release → 上传清单 → 核对资产 → 匿名复核。
 *
 * 与 `release-win.yml` 的差异只有一处：资产由本地构建产出（CI 那套仍可用作补传）。
 * 建 Release 严格「先查后建」，避免与 mac CI 撞车（坑 66）。
 */
async function publishLocal() {
  const tag = `v${version}`;
  const prerelease = (parseVersion(version)?.pre.length ?? 0) > 0;
  const files = artifactsToUpload();
  log(`发布清单（${files.length} 个）：${files.join(' · ')}`);

  if (opts.dryRun) {
    log(`(dry-run) gh release view ${tag} --repo ${REPO}`);
    log(`(dry-run) gh release create ${tag} --target ${BRANCH}${prerelease ? ' --prerelease' : ''} --repo ${REPO}`);
    log(`(dry-run) gh release upload ${tag} <${files.length} 个产物> --clobber --repo ${REPO}`);
    return;
  }

  const viewed = gh(['release', 'view', tag, '--repo', REPO], { capture: true, allowFail: true });
  if (viewed.status !== 0) {
    const notes =
      `本地发布（${new Date().toISOString().slice(0, 10)}）：Windows 产物由维护者本机构建上传。` +
      '更新说明待人工补充（gh release edit <tag> --notes-file <file>）。';
    const createArgs = ['release', 'create', tag, '--target', BRANCH, '--title', tag, '--notes', notes, '--repo', REPO];
    if (prerelease) {
      createArgs.push('--prerelease');
    }
    gh(createArgs);
    log(`✓ 已创建 Release ${tag}${prerelease ? '（预发布）' : ''}（tag 指向 ${BRANCH}）`);
  } else {
    log(`Release ${tag} 已存在，直接上传（幂等）`);
  }

  gh(['release', 'upload', tag, ...files, '--clobber', '--repo', REPO]);
  log(`✓ 已上传 ${files.length} 个产物`);

  const listed = gh(['release', 'view', tag, '--json', 'assets', '--repo', REPO], { capture: true });
  const assets = new Set((JSON.parse(listed.stdout || '{"assets":[]}').assets || []).map((one) => one.name));
  const missing = files.map((file) => path.basename(file)).filter((name) => !assets.has(name));
  if (missing.length > 0) {
    die(`Release 资产核对失败，缺：${missing.join(', ')}`);
  }
  log(`✓ Release 资产核对通过（${assets.size} 个在册）`);

  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const reachable = await descriptorsReachable([`${base}/latest.yml`, `${base}/SHA256SUMS`]);
  if (!reachable) {
    die(`匿名复核失败：${base}/latest.yml 或 SHA256SUMS 不可达——客户端更新会 404`);
  }
  log('✓ 本地发布完成（应用内检查更新可直接命中）');
  log('提醒：本地产物即权威（B2 后 tag 不再触发 CI 重建）；mac 产物需为每个版本手动 `gh workflow run release-mac.yml` 补一次');
  log(`提醒：更新说明请人工写入 Release（gh release edit ${tag} --notes-file <file>）`);
}

async function main() {
  if (!version) {
    die(
      '用法：npm run release -- <version> [--local] [--clean] [--push] [--publish-local] [--skip-gates] [--dry-run]',
    );
  }
  const target = parseVersion(version);
  if (!target) {
    die(`版本号格式非法：${version}（期望 x.y.z 或 x.y.z-<prerelease>）`);
  }
  if (opts.clean && !opts.local) {
    die('--clean 需配合 --local 使用');
  }

  const currentVersion = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version;
  const current = parseVersion(currentVersion);
  if (!current) {
    die(`package.json 中的版本号无法解析：${currentVersion}`);
  }
  if (compareVersions(target, current) <= 0) {
    die(`目标版本 ${version} 必须高于当前版本 ${currentVersion}`);
  }

  const plan = [
    opts.local ? '本地打包' : null,
    opts.publishLocal ? '本地发布到 GitHub Release' : opts.push ? '推送触发 CI' : '仅本地',
  ]
    .filter(Boolean)
    .join(' · ');
  log(`发版计划：${currentVersion} → ${version}（${plan}）`);

  preflight();
  gates();
  bumpVersionField(PACKAGE_JSON, currentVersion, version, 1);
  bumpVersionField(PACKAGE_LOCK, currentVersion, version, 2);
  if (opts.local) {
    packageLocal();
  }
  commitAndTag();
  if (opts.publishLocal) {
    pushBranchOnly();
    await publishLocal();
  } else {
    push();
  }
  if (!opts.local) {
    log('提示：未指定 --local，本次未生成本地安装包（release/ 无本版产物）；需要本地包请下次加 --local');
  }
  log('✓ 发版流程完成');
}

void main().catch((error) => {
  console.error(`[release] ✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
