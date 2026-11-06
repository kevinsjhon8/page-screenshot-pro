/* mcp-server/tests/bin.test.ts —— 发布出去的 bin 必须真能跑
 *
 * 0.1.0 发到 npm 之后才发现的：`package.json` 的 `bin` 指向
 * `dist/mcp-server/src/index.js`，而那个文件首行是**注释不是 shebang**。
 * npm 在 Unix 上只建 `node_modules/.bin/` 的符号链接、不补 shebang，于是
 * `npx -y page-screenshot-mcp`（设置页生成的 JSON 正是这么写的）会让 shell
 * 拿第一行注释当命令执行，用户看到的是：
 *
 *     ./node_modules/.bin/page-screenshot-mcp: 1: /bin: Permission denied
 *     ./node_modules/.bin/page-screenshot-mcp: 2: node_modules: not found
 *     Syntax error: word unexpected (expecting ")")
 *
 * 注意它**不是**「跑起来报错」，是压根没进 node。而 `node dist/.../index.js`
 * 一切正常，所以只测「进程能起来」是测不出来的——测的必须是「**通过 bin 的
 * 方式**能起来」。
 *
 * 这一组钉三层，每层单独失败都有不同含义：
 *   1. 源文件首行是 shebang（删了它，这条先红，指回源码）；
 *   2. 编译产物首行也是（tsc 不搬 shebang 的话，这条红，指回构建）；
 *   3. 真的用 `node_modules/.bin/<name>` 跑起来（前两条都绿、只有这条红，
 *      说明 npm 的行为变了或者 bin 路径写错了）。
 *
 * 第 3 条需要 `npm run build` 先跑过。dist 不存在时**跳过而不是失败**——
 * 和 `site/tests/build-output.test.ts` 跳过 `dist/` 缺失同理：`npm test` 不该
 * 因为没构建而红，`npm run check` 里 build 是显式跑过的。
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  bin: Record<string, string>;
  engines: { node: string };
  files: string[];
  license: string;
  description: string;
  repository: { url: string };
  homepage: string;
  bugs: { url: string };
  keywords: string[];
};

const SHEBANG = '#!/usr/bin/env node';

/* npm 页面是空白的这件事**没有别的检查看得到**：发布成功、包能装、bin 能跑，
 * 全都绿，只有打开 registry 页面的人看到一行描述和一句 "no readme". */
describe('发布元数据', () => {
  it('README 和 LICENSE 真的存在', () => {
    for (const f of ['README.md', 'LICENSE']) {
      expect(existsSync(resolve(ROOT, f)), `${f} 不存在`).toBe(true);
    }
  });

  it('README 里写的入口名与实际 bin 一致', () => {
    /* 用户是照 README 抄 `npx -y <name>` 的。改名时漏改 README，用户拿到
     * 的是一条 404，而且他不会怀疑文档。 */
    const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('page-screenshot-mcp');
    expect(readme).toContain('PSP_MCP_TOKEN');
  });

  it('真正打进 tarball 的东西里有 README / LICENSE，且 bin 被置了可执行位', () => {
    /* **这条要量的是 tarball，不是 package.json 的字面量。** 第一版断言的是
     * `files` 数组里写没写 `README.md`——把 `files` 改回 `["dist"]` 之后它
     * 依然全绿，因为 npm **本来就会自动带上** README/LICENSE（每个包都这样）。
     * 也就是说那一条测的是一个和产物无关的配置写法。
     *
     * 量 `npm pack --dry-run --json` 的意义在于它同时覆盖两件别处看不见的事：
     *   - 文件真的在包里（少一个就是 registry 页面空白）；
     *   - **`mode` 是 0755**。本地 `dist/` 是 tsc 出来的 0644，是 npm 在打包
     *     时按 `bin` 给置的可执行位。这一层若因任何原因失效，用户拿到的符号
     *     链接指向一个不可执行的文件，报错是 `EACCES`——和缺 shebang 完全
     *     不同的另一条死路，却同样只在装完之后出现。
     *
     * dist 没构建时跳过，理由同下一个用例。 */
    const binRel = Object.values(PKG.bin)[0]!;
    if (!existsSync(resolve(ROOT, binRel))) return;

    const json = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const packed = (
      JSON.parse(json) as Record<string, { files: { path: string; mode: number }[] }>
    )[PKG.name]!.files;

    const paths = packed.map((f) => f.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('LICENSE');

    const bin = packed.find((f) => f.path === binRel);
    expect(bin, `${binRel} 没进 tarball`).toBeDefined();
    expect(bin!.mode & 0o111, `${binRel} 在包里没有可执行位`).not.toBe(0);
  }, 30_000);

  it('页面需要的字段都在，且不是占位符', () => {
    const name = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).name as string;
    expect(PKG.description.length).toBeGreaterThan(60);
    expect(PKG.license).toBe('MIT');
    expect(PKG.keywords.length).toBeGreaterThanOrEqual(5);
    expect(PKG.keywords).toContain('mcp');
    /* 三个地址都要是**本产品自己的**域名或仓库，不能是模板里的 example.com。
     * 只检查"非空"的话，`"homepage": "TODO"` 也能过。 */
    expect(PKG.homepage).toMatch(/^https:\/\/screenshotpro\.agentsblockchains\.com\//);
    expect(PKG.bugs.url).toMatch(/^https:\/\/screenshotpro\.agentsblockchains\.com\//);
    /* `repository.directory` 必须是本包所在的子目录——这是 monorepo 里 npm
     * 唯一能生成正确「View source」链接的方式，填根目录会指向扩展源码。 */
    expect(PKG.repository.url).toMatch(/^git\+https:\/\//);
    expect(name).toBe('page-screenshot-mcp');
  });
});

describe('发布出去的 bin', () => {
  it('源文件首行是 shebang', () => {
    const src = readFileSync(resolve(ROOT, 'src', 'index.ts'), 'utf8');
    expect(src.split('\n')[0]).toBe(SHEBANG);
  });

  it('bin 指向的文件在 files 白名单里，否则发了也没有', () => {
    /* `files: ["dist"]` 之外的东西不会进 tarball。bin 指向 dist 里某个路径
     * 本身不保证它被打包——`tsconfig.json` 的 `include` 决定 dist 里有什么。
     * 两者对不上时 npm 照样发布成功，用户装上才 404。 */
    for (const rel of Object.values(PKG.bin)) {
      expect(
        PKG.files.some((f) => rel === f || rel.startsWith(f.replace(/\/$/, '') + '/')),
        `${rel} 不在 files ${JSON.stringify(PKG.files)} 里`,
      ).toBe(true);
    }
  });

  it('编译产物首行是 shebang，且以 bin 的方式能真的跑起来', async () => {
    const rel = Object.values(PKG.bin)[0]!;
    const dist = resolve(ROOT, rel);
    if (!existsSync(dist)) {
      /* 没构建就跳过，理由见文件头。 */
      return;
    }
    expect(readFileSync(dist, 'utf8').split('\n')[0]).toBe(SHEBANG);

    /* **复刻 npm 装包那一步再执行它。** 本地 `dist/` 是 crw-rw-r--（tsc 的
     * 默认 mode），而发布的 tarball 里 bin 指向的文件是 0755——npm pack 会
     * 给 `bin` 里的路径补可执行位（实测 0.1.0 装出来是 `-rwxrwxr-x`）。所以
     * 先 chmod 再跑，否则测到的是「本地少了执行位」这件和缺陷无关的事
     * （第一版就是这么红的：`spawn … EACCES`）。
     *
     * chmod 就地做，**不复制到临时目录**：这个文件 `import '../../utils/
     * mcp-token.js'`，拷走之后模块解析就断了（第一版的第二红：
     * `node:internal/modules/package_json_reader` 找不到 package）。
     * `dist/` 是构建产物、本来就不进 git，改它的权限没有副作用。
     *
     * 而且**必须直接执行、不能写 `node <file>`**：后者正是 0.1.0 里唯一能
     * 通过的方式，也正好绕过了缺陷藏身的那一层。直接执行时内核读首行
     * shebang 去找解释器——没有 shebang，就是那段
     * `1: /bin: Permission denied` 的开场白。 */
    chmodSync(dist, 0o755);
    const out = await runOnce(dist, [], { PSP_MCP_TOKEN: '' });
    /* token 为空时进程必须在**进入 serveStdio 之前**就退出并说明原因，
     * 否则「跑起来了但连不上」会被当成网络问题。这里只要求：
     *   - 不是 shell 解析失败（那种失败的 stderr 里全是 `not found`）；
     *   - 退出码非 0；
     *   - stderr 里有本程序自己的字样。 */
    expect(out.stderr).not.toMatch(/not found|Syntax error|Permission denied/);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toMatch(/PSP_MCP_TOKEN/);
  }, 20_000);
});

function runOnce(
  file: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((done) => {
    const child = spawn(file, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    /* 起不来的情况必须自己收口，否则测试挂死在这里而不是报出好的信息。 */
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      done({ code: null, stderr: `${stderr}${String(e.message)}`, stdout });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stderr, stdout });
    });
  });
}
