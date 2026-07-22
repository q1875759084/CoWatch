/**
 * QA 回归测试：CoWatch 录制跨 ffmpeg 会话连续时间轴锚点逻辑
 *
 * 方式：用 CommonJS require 桩替换 electron / ffmpeg-static，加载**真实编译产物**
 * electron/handlers/recorder/__qa__/build/shared.js（源自 shared.ts），
 * 直接调用 registerSessionAnchor / getOutputTsOffset / resetSessionAnchors，
 * 验证暂停截断分片后时间轴连续、无 7s 空洞（Bug #遮挡卡死+丢声 的治本修复）。
 *
 * 运行：node electron/handlers/recorder/__qa__/runAnchorTest.cjs
 */
'use strict';

const path = require('path');
const Module = require('module');

// ─── 模块桩：让 shared.js 能在 Node 下被 require ───────────────────────────────
// shared.ts 顶部 import { app } from 'electron' 与 import ffmpegPath from 'ffmpeg-static'。
// 锚点函数本身不触碰这两者（getFfmpegPath 仅在 spawnFfmpeg/transcode 时调用），
// 但 require 解析需要这两个模块存在。
const electronStub = {
  app: {
    isPackaged: false,
    getAppPath: () => '/fake/app',
    resourcesPath: '/fake/resources',
  },
  desktopCapturer: { getSources: async () => [] },
};
const ffmpegStaticStub = '/fake/ffmpeg';

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (request === 'ffmpeg-static') return ffmpegStaticStub;
  return origLoad.apply(this, arguments);
};

const shared = require(path.join(__dirname, 'build', 'shared.js'));
const { registerSessionAnchor, getOutputTsOffset, resetSessionAnchors, HLS_SEGMENT_DURATION } =
  shared;

// ─── 极简断言框架 ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ✅ ' + name);
  } else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ❌ ' + name + (detail ? ' — ' + detail : ''));
  }
}

// 辅助：用一组锚点计算 seg0..segN 的偏移数组
function timeline(anchors, n) {
  resetSessionAnchors();
  for (const [firstSeg, startOffset] of anchors) registerSessionAnchor(firstSeg, startOffset);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(getOutputTsOffset(i));
  return out;
}

console.log('\n=== Test A: 无 pause（正常录制，退化回 i*10）===');
{
  // startRecording 内部：resetSessionAnchors() + spawnFfmpeg 注册 (0,0)
  const off = timeline([[0, 0]], 4);
  assert('seg0 -> 0', off[0] === 0, 'got ' + off[0]);
  assert('seg1 -> 10', off[1] === 10, 'got ' + off[1]);
  assert('seg2 -> 20', off[2] === 20, 'got ' + off[2]);
  assert('seg3 -> 30', off[3] === 30, 'got ' + off[3]);
  assert('seg4 -> 40', off[4] === 40, 'got ' + off[4]);
}

console.log('\n=== Test B: pause@13s 截断 seg1(=3s)，resume 首片=seg2 offset=13（核心 Bug 回归）===');
{
  // 序列（完全复刻 recording 层逻辑）：
  //   startRecording: reset + spawn(0) 注册 (0,0)
  //   pause@13s:    recordedSecondsAtPause = 13
  //   resume:       startOffsetForNextSession = 13; spawn(2) 注册 (2,13)
  resetSessionAnchors();
  registerSessionAnchor(0, 0); // 首会话：seg0,seg1
  registerSessionAnchor(2, 13); // resume 续录会话：seg2 起点=13
  const off = [];
  for (let i = 0; i <= 5; i++) off.push(getOutputTsOffset(i));

  assert('seg0 -> 0', off[0] === 0, 'got ' + off[0]);
  assert('seg1 -> 10', off[1] === 10, 'got ' + off[1]);
  // ★ 关键：旧实现 seg2=20 导致 13→20 的 7s 空洞；修复后必须=13
  assert('★ seg2 -> 13（非 20，空洞消除）', off[2] === 13, 'got ' + off[2] + '，旧实现会得 20');
  assert('seg3 -> 23', off[3] === 23, 'got ' + off[3]);
  assert('seg4 -> 33', off[4] === 33, 'got ' + off[4]);
  assert('seg5 -> 43', off[5] === 43, 'got ' + off[5]);

  // 连续性校验：相邻分片起点间距 <= 10（无 >10s 空洞）
  let maxGap = 0;
  for (let i = 1; i < off.length; i++) maxGap = Math.max(maxGap, off[i] - off[i - 1]);
  assert('相邻分片起点间距均 <= 10（无空洞）', maxGap <= 10, 'maxGap=' + maxGap);
  assert('时间轴严格单调不减', off.every((v, i) => i === 0 || v >= off[i - 1]), JSON.stringify(off));

  // 直接证明旧公式会出错：若用旧公式 segIndex*10，seg2=20 ≠ 13 → 7s 空洞
  const oldFormulaSeg2 = 2 * HLS_SEGMENT_DURATION;
  assert('旧公式(2*10=20)确为 Bug 值，现实现已偏离', off[2] !== oldFormulaSeg2,
    'old=' + oldFormulaSeg2 + ' new=' + off[2]);
}

console.log('\n=== Test C: crash 续录（offset 仍 = getNextSegmentNumber()*10，等价旧行为）===');
{
  // crash 续录：startOffsetForNextSession = getNextSegmentNumber()*HLS_SEGMENT_DURATION
  // 已有 seg0,seg1 → getNextSegmentNumber()=2 → 锚点 (2, 2*10=20)
  // 因 firstSeg=startNumber，对该锚点：getOutputTsOffset(i) = 20 + (i-2)*10 = i*10，与旧公式逐片相等
  resetSessionAnchors();
  registerSessionAnchor(0, 0);
  registerSessionAnchor(2, 2 * HLS_SEGMENT_DURATION); // crash 续录锚点
  const off = [];
  for (let i = 0; i <= 4; i++) off.push(getOutputTsOffset(i));
  assert('crash 续录 seg2 -> 20', off[2] === 20, 'got ' + off[2]);
  assert('crash 续录 seq 与旧公式 i*10 完全一致',
    off.every((v, i) => v === i * HLS_SEGMENT_DURATION),
    JSON.stringify(off));
}

console.log('\n=== Test D: 多次 pause（锚点表选取「序号最大且 ≤i」的锚点）===');
{
  // 模拟：首会话(0,0)；pause@13 续录(2,13)；再 pause@45 续录(5,45)
  resetSessionAnchors();
  registerSessionAnchor(0, 0);
  registerSessionAnchor(2, 13);
  registerSessionAnchor(5, 45);
  // i=1: 仅 (0,0) <=1 → 0+10=10
  assert('seg1 -> 10', getOutputTsOffset(1) === 10, 'got ' + getOutputTsOffset(1));
  // i=4: (2,13) 是 <=4 中最大 → 13+(4-2)*10=33
  assert('seg4 -> 33（取锚点(2,13)）', getOutputTsOffset(4) === 33, 'got ' + getOutputTsOffset(4));
  // i=5: (5,45) <=5 且最大 → 45
  assert('seg5 -> 45', getOutputTsOffset(5) === 45, 'got ' + getOutputTsOffset(5));
  // i=6: (5,45) → 45+10=55
  assert('seg6 -> 55', getOutputTsOffset(6) === 55, 'got ' + getOutputTsOffset(6));
  // i=0: (0,0) -> 0
  assert('seg0 -> 0', getOutputTsOffset(0) === 0, 'got ' + getOutputTsOffset(0));
}

console.log('\n=== Test E: 边界 — 无锚点时回退 i*10 ===');
{
  resetSessionAnchors(); // 清空锚点表
  assert('无锚点 seg3 -> 30（回退 i*10）', getOutputTsOffset(3) === 30, 'got ' + getOutputTsOffset(3));
  assert('无锚点 seg0 -> 0', getOutputTsOffset(0) === 0, 'got ' + getOutputTsOffset(0));
}

console.log('\n=== Test F: 锚点覆盖语义（同 firstSeg 重复登记覆盖）===');
{
  resetSessionAnchors();
  registerSessionAnchor(2, 13);
  registerSessionAnchor(2, 99); // 重复登记，应覆盖
  assert('同 firstSeg 覆盖 -> 99', getOutputTsOffset(2) === 99, 'got ' + getOutputTsOffset(2));
  assert('覆盖后 seg3 -> 109', getOutputTsOffset(3) === 109, 'got ' + getOutputTsOffset(3));
}

console.log('\n=== Test G: 真实 bug 场景端到端时间轴（用户 1:19 实测 0:13 切走）===');
{
  // 用户实测：0:13 alt+tab 切走（pause），0:13 处 seg1 被截断成 3s（10-13）。
  // 修复后 resume 续录首片 seg2 起点=13，此后每片 +10 连续直到 ~1:19。
  // 验证：从 seg0 到 seg8（覆盖 ~1:19 = 79s，约 8 片）整条时间轴无 >10s 空洞。
  resetSessionAnchors();
  registerSessionAnchor(0, 0);
  registerSessionAnchor(2, 13); // pause@13s 续录
  const N = 8;
  const off = [];
  for (let i = 0; i <= N; i++) off.push(getOutputTsOffset(i));
  let maxGap = 0;
  for (let i = 1; i < off.length; i++) maxGap = Math.max(maxGap, off[i] - off[i - 1]);
  assert('0:13 断点处无 7s 空洞（seg2 起点=13 而非 20）', off[2] === 13, 'got ' + off[2]);
  assert('整条时间轴(0..79s)相邻间距均 <= 10', maxGap <= 10, 'maxGap=' + maxGap);
  console.log('     时间轴偏移: ' + off.join(', '));
}

// ─── 汇总 ─────────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────');
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) {
  console.log('FAILED CASES:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('ALL GREEN ✅');
  process.exit(0);
}
