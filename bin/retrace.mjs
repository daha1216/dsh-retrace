#!/usr/bin/env node
/**
 * dsh-retrace · bin/retrace.mjs
 *
 * 会话日志考古 CLI（任务书 A1-A4）——只读，不写任何日志。
 *
 *   retrace index <session> [--json]
 *       工具调用索引：调用数 / 配对率 / 孤儿数 / 命令分布（A1）
 *   retrace query <session> --cmd <regex> [--json]
 *       按命令正则查工具输出（A1）
 *   retrace extract <session> --pattern <regex> --out <dir> [--min-size N]
 *       导出匹配命令的工具输出到目录（A2）
 *   retrace file-history <session> <path> [--json]
 *       某文件的所有 write/edit 历史版本（A3）
 *   retrace file-diff <session> <path> <v1> <v2>
 *       两个历史版本的行级 diff（A3）
 *   retrace lineage <session> [--json]
 *       会话 parent 链谱系（A4，分叉图数据源）
 *   retrace store inventory [--verify-hashes] [--json]
 *       产物库盘点：对象/引用/legacy/悬空/孤儿（只读，I）
 *   retrace store gc [--apply --yes] [--json]
 *       清理无人引用的对象（默认 dry-run，I）
 *
 * <session> 为完整文件路径或 sessionId（自动在 ~/.dsh/sessions 查找）。
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** 会话日志库只在考古命令里用到；store 子命令必须能在没装依赖时离线跑。 */
async function logContract() {
  return import('dsh-log-contract');
}
import { replayFileHistory, diffLines, resolveSessionFile, lineageOf } from '../lib/archaeology-cli.js';
import { inventory, migrate, pruneOrphans } from '../lib/store-cli.js';

const USAGE = `dsh-retrace 考古 CLI —— 会话日志数据/审计资产挖掘（只读）

用法：
  retrace index <session> [--json]
  retrace query <session> --cmd <regex> [--json]
  retrace extract <session> --pattern <regex> --out <dir> [--min-size N]
  retrace file-history <session> <path> [--json]
  retrace file-diff <session> <path> <v1> <v2>
  retrace lineage <session> [--json]
  retrace store inventory [--verify-hashes] [--json]
  retrace store gc [--apply --yes] [--json]
  retrace store migrate [--apply --yes] [--force] [--json]`;

function fail(msg) {
  process.stderr.write(`❌ ${msg}\n\n${USAGE}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);
const json = rest.includes('--json');
const positional = rest.filter((a) => !a.startsWith('-'));
const opt = (name, def) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : def;
};

async function main() {
  if (cmd === 'index') {
    const file = resolveSessionFile(positional[0] ?? fail('index 需要 <session>'));
    const { loadSessionLog, auditToolCalls } = await logContract();
    const log = loadSessionLog(file);
    const report = auditToolCalls(log.events.map((e) => e.event));
    if (json) return process.stdout.write(JSON.stringify({ file, ...report }, null, 2) + '\n');
    process.stdout.write(`📇 retrace index —— ${file}\n`);
    process.stdout.write(`   工具调用 ${report.calls} ｜ 结果 ${report.results} ｜ 孤儿 ${report.orphans} ｜ 配对率 ${(report.pairingRate * 100).toFixed(1)}%\n`);
    process.stdout.write(`   输出总字节 ${report.outputBytes}${report.largest ? ` ｜ 最大 ${report.largest.size}B（${(report.largest.command || '?').slice(0, 40)}）` : ''}\n`);
    process.stdout.write(`   命令分布（前 8）：\n`);
    for (const { command, count } of report.commands.top.slice(0, 8)) {
      process.stdout.write(`     ${String(count).padStart(4)}  ${(command || '(no-command)').slice(0, 70)}\n`);
    }
  } else if (cmd === 'query' || cmd === 'extract') {
    const pattern = opt('--cmd', opt('--pattern', ''));
    if (!pattern) fail(`${cmd} 需要 --cmd/--pattern <regex>`);
    const file = resolveSessionFile(positional[0] ?? fail(`${cmd} 需要 <session>`));
    const { loadSessionLog, extractToolOutputs } = await logContract();
    const log = loadSessionLog(file);
    const minSize = cmd === 'extract' ? Number(opt('--min-size', '50')) : 0;
    const { pairs, total } = extractToolOutputs(log.events.map((e) => e.event), pattern, { minSize });
    if (cmd === 'query') {
      if (json) return process.stdout.write(JSON.stringify({ file, pattern, matched: pairs.length, total, pairs: pairs.map((p) => ({ callId: p.callId, command: p.command, size: p.size, text: p.text.slice(0, 500) })) }, null, 2) + '\n');
      process.stdout.write(`🔎 retrace query —— ${file} ｜ /${pattern}/\n`);
      process.stdout.write(`   匹配 ${pairs.length} 个输出（共 ${total} 个调用）\n`);
      for (const p of pairs.slice(0, 5)) process.stdout.write(`   - [${p.size}B] ${p.command.slice(0, 50)}… ${p.text.slice(0, 70).replace(/\n/g, ' ')}…\n`);
      if (pairs.length > 5) process.stdout.write(`   … 其余 ${pairs.length - 5} 个（extract --out 导出全部）\n`);
    } else {
      const outDir = opt('--out', '');
      if (!outDir) fail('extract 需要 --out <dir>');
      fs.mkdirSync(outDir, { recursive: true });
      let written = 0;
      for (const p of pairs) {
        fs.writeFileSync(`${outDir}/${p.callId.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`, p.text);
        written += 1;
      }
      process.stdout.write(`📤 retrace extract —— ${file} ｜ /${pattern}/ ｜ ${written}/${pairs.length} 输出 → ${outDir}\n`);
    }
  } else if (cmd === 'file-history') {
    const file = resolveSessionFile(positional[0] ?? fail('file-history 需要 <session>'));
    const path = positional[1] ?? fail('file-history 需要 <path>');
    const { loadSessionLog } = await logContract();
    const log = loadSessionLog(file);
    const { files } = replayFileHistory(log.events.map((e) => e.event));
    const history = files.get(path) ?? [];
    if (json) return process.stdout.write(JSON.stringify({ file, path, versions: history.map((v) => ({ seq: v.seq, time: v.time, kind: v.kind, tool: v.tool, hash: v.hash, size: v.size })) }, null, 2) + '\n');
    process.stdout.write(`📜 retrace file-history —— ${path}（${file}）\n`);
    if (history.length === 0) {
      process.stdout.write('   （该文件无 write/edit 记录）\n');
    } else {
      history.forEach((v, i) => {
        process.stdout.write(`   v${i} [${v.kind}/${v.tool}] seq ${v.seq} ${v.size}B ${v.hash} ${(v.time ? new Date(v.time).toISOString().slice(5, 16) : '')}\n`);
      });
    }
  } else if (cmd === 'file-diff') {
    const file = resolveSessionFile(positional[0] ?? fail('file-diff 需要 <session>'));
    const path = positional[1] ?? fail('file-diff 需要 <path>');
    const v1 = Number(positional[2]);
    const v2 = Number(positional[3]);
    if (!Number.isInteger(v1) || !Number.isInteger(v2)) fail('file-diff 需要 <v1> <v2>（版本索引）');
    const { loadSessionLog } = await logContract();
    const log = loadSessionLog(file);
    const { files } = replayFileHistory(log.events.map((e) => e.event));
    const history = files.get(path) ?? [];
    if (v1 < 0 || v2 < 0 || v1 >= history.length || v2 >= history.length) fail(`版本索引越界（共 ${history.length} 个版本）`);
    const lines = diffLines(history[v1].content, history[v2].content);
    process.stdout.write(`🔀 retrace file-diff —— ${path} v${v1}(${history[v1].hash}) → v${v2}(${history[v2].hash})\n`);
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.op === 'add') added += 1;
      if (line.op === 'del') removed += 1;
    }
    process.stdout.write(`   +${added} / -${removed}\n`);
    for (const line of lines.slice(0, 40)) {
      process.stdout.write(`   ${line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '} ${line.text}\n`);
    }
    if (lines.length > 40) process.stdout.write(`   … 其余 ${lines.length - 40} 行\n`);
  } else if (cmd === 'lineage') {
    const file = resolveSessionFile(positional[0] ?? fail('lineage 需要 <session>'));
    const { loadSessionLog } = await logContract();
    const log = loadSessionLog(file);
    const lineage = lineageOf(log);
    if (json) return process.stdout.write(JSON.stringify(lineage, null, 2) + '\n');
    process.stdout.write(`🌿 retrace lineage —— ${lineage.id}\n`);
    process.stdout.write(`   parent: ${lineage.parentId ?? '(无，根会话)'}\n`);
  } else if (cmd === 'store') {
    const sub = positional[0];
    const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-retrace');
    const domainFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'retrace.json');
    if (sub === 'inventory' || sub === 'gc' || sub === 'migrate') {
      const report = inventory({ domainFile, root, verifyHashes: rest.includes('--verify-hashes') });
      if (sub === 'inventory') {
        if (json) return process.stdout.write(JSON.stringify({ root, domainFile, ...report, objects: report.objects.length }, null, 2) + '\n');
        process.stdout.write(`📦 retrace store inventory —— ${root}\n`);
        process.stdout.write(`   对象 ${report.objects.length} 个 / ${report.objectBytes} 字节 ｜ 引用行 ${report.refRows} ｜ 版本行 ${report.versionRows}\n`);
        process.stdout.write(`   引用：scoped ${report.scopedRefs.length} ｜ legacy ${report.legacyRefs.length}（归属不可恢复，永不自动回收）\n`);
        process.stdout.write(`   零引用行 ${report.zeroRefRows.length} ｜ 悬空引用 ${report.dangling.length} ｜ 孤儿对象 ${report.orphans.length}（${report.orphans.reduce((sum, object) => sum + object.size, 0)} 字节）\n`);
        if (report.mismatched.length > 0) process.stdout.write(`   ⚠ 内容哈希不符 ${report.mismatched.length} 个\n`);
        process.stdout.write(`   清理预演：retrace store gc（dry-run）；真正删除加 --apply --yes\n`);
      } else if (sub === 'migrate') {
        const apply = rest.includes('--apply');
        const yes = rest.includes('--yes');
        const force = rest.includes('--force');
        if (apply && !yes) fail('store migrate --apply 需要同时给 --yes（确认改写 domain 文件）');
        let result;
        try {
          result = migrate({ domainFile, root, apply, force });
        } catch (error) {
          if (error?.code === 'store-in-use') {
            fail(`拒绝改写：${error.message}\n   先停 dsh web，确认没有宿主在跑；确实要在线改再加 --force`);
          }
          throw error;
        }
        if (json) return process.stdout.write(JSON.stringify({ root, domainFile, ...result }, null, 2) + '\n');
        process.stdout.write(`🧾 retrace store migrate —— ${root}（${result.mode}）\n`);
        process.stdout.write(`   legacy 引用 ${result.frozen.legacyRefs} 条 / 涉及对象 ${result.frozen.objectsKept} 个（冻结保留）\n`);
        process.stdout.write(`   可清理的纯元数据行 ${result.droppableRows} 条\n`);
        if (apply) {
          process.stdout.write(`   已删除 ${result.droppedRows} 行；备份 ${result.backupPath}\n`);
          process.stdout.write(`   冻结说明 ${result.sidecarPath}\n`);
        } else {
          process.stdout.write('   未改写任何文件（加 --apply --yes 才执行）\n');
        }
      } else {
        const apply = rest.includes('--apply');
        const yes = rest.includes('--yes');
        if (apply && !yes) fail('store gc --apply 需要同时给 --yes（确认删除孤儿对象）');
        const result = apply ? pruneOrphans(report) : { removed: 0, bytes: 0, failed: [] };
        if (json) return process.stdout.write(JSON.stringify({ root, mode: apply ? 'apply' : 'dry-run', candidates: report.orphans.length, candidateBytes: report.orphans.reduce((sum, object) => sum + object.size, 0), ...result }, null, 2) + '\n');
        process.stdout.write(`🧹 retrace store gc —— ${root}（${apply ? 'APPLY' : 'dry-run'}）\n`);
        process.stdout.write(`   孤儿对象 ${report.orphans.length} 个 / ${report.orphans.reduce((sum, object) => sum + object.size, 0)} 字节\n`);
        if (apply) process.stdout.write(`   已删除 ${result.removed} 个 / ${result.bytes} 字节${result.failed.length > 0 ? ` ｜ 失败 ${result.failed.length}` : ''}\n`);
        else process.stdout.write('   未删除任何文件（加 --apply --yes 才执行）\n');
        if (report.legacyRefs.length > 0) process.stdout.write(`   注意：${report.legacyRefs.length} 条 legacy 引用指向的对象被保留（无法判断归属）\n`);
      }
    } else {
      fail(`未知 store 子命令 "${sub ?? ''}"（inventory / gc / migrate）`);
    }
  } else {
    fail(cmd ? `未知命令 "${cmd}"` : '缺少命令');
  }
}
await main();
