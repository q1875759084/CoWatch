# recorder.ts 切片上传容错机制

> 记录上传容错模块的当前实现、已知问题和修复方向。

---

## 版本 1：当前实现（含已知问题）

### 1. 相关代码（简化）

**核心状态变量**
```ts
let pendingSegments: string[] = [];          // 上传失败待补传的本地文件路径
const activeUploads = new Set<Promise<void>>(); // 正在进行中的上传 Promise
const queuedFileNames = new Set<string>();   // 已入队文件名（去重用）
let pendingFlushTimerRef: ReturnType<typeof setInterval> | null = null;

const UPLOAD_MAX_RETRIES = 3; // pRetry 重试次数（共 1+3=4 次）
```

**uploadSegment —— 单次切片上传**
```ts
async function uploadSegment(filePath: string): Promise<void> {
  queuedFileNames.add(segmentName);

  const upload = pRetry(attemptFn, { retries: 3, factor: 2, minTimeout: 1000, maxTimeout: 8000 });

  const uploadPromise = upload
    .then(() => {
      segmentKeys.push(objectKey);
      fs.unlink(filePath, () => {}); // 成功后删除本地临时文件
    })
    .catch(() => {
      pendingSegments.push(filePath); // 4 次全败 → 入 pending，文件保留在临时目录
    })
    .finally(() => activeUploads.delete(uploadPromise));

  activeUploads.add(uploadPromise);
}
```

**flushPendingSegments —— 批量补传**
```ts
async function flushPendingSegments(): Promise<void> {
  if (pendingSegments.length === 0) return;
  console.log(`[recorder] 网络恢复，开始补传 ${pendingSegments.length} 个切片`);
  const toRetry = pendingSegments.splice(0); // 全部取出（无批次限制）
  for (const filePath of toRetry) {
    await uploadSegment(filePath);            // 串行执行（每个等完再下一个）
  }
}
```

**30s 定时器（录制进行中）**
```ts
// 每 30s 轮询，如有 pending 则触发补传
const pendingFlushTimer = setInterval(() => {
  if (pendingSegments.length > 0) void flushPendingSegments(); // void：不等待，不互斥
}, 30_000);
pendingFlushTimerRef = pendingFlushTimer;
```

**stop() 收尾阶段（用户点击停止后）**
```ts
async function stop(): Promise<void> {
  // 1. 停止所有定时器
  clearInterval(pendingFlushTimerRef);

  // 2. 等待 ffmpeg 退出（最多 15s）
  await waitForFfmpegExit();

  // 3. 扫描临时目录，补入 chokidar 未捕获的尾片
  const tsFiles = fs.readdirSync(sessionTmpDir).filter(f => f.endsWith('.ts'));
  for (const file of tsFiles) {
    if (!queuedFileNames.has(file)) await uploadSegment(path.join(sessionTmpDir, file));
  }

  // 4. 循环等待 + 补传（最多 UPLOAD_MAX_RETRIES + 1 = 4 轮）
  for (let round = 0; round < UPLOAD_MAX_RETRIES + 1; round++) {
    await Promise.allSettled(Array.from(activeUploads));
    if (pendingSegments.length === 0) break;
    await flushPendingSegments(); // 最后一轮：dispatch 了新 Promise 就返回，不等完
  }
  // ← for 退出时，最后一轮 dispatch 的 pRetry 仍在后台跑（BUG 1）

  // 5. 调用 finish 接口
  if (segmentKeys.length > 0) await callFinishApi();
  else console.warn('[recorder] 无可用切片，跳过 finish 接口');

  // 6. 删除临时目录（异步，非阻塞）
  fs.rm(sessionTmpDir, { recursive: true, force: true }, () => {
    console.log('[recorder] 临时目录已清理：', sessionTmpDir);
  });

  // 7. 重置状态
  pendingSegments = [];
  activeUploads.clear();
}
```

---

### 2. 服务器异常时的报错信息与时序

触发场景：后端接口 `POST /api/rooms/:roomId/recording/segment` 返回 404（接口未部署）

**日志输出（完整时序）：**
```
// ffmpeg 正常退出
[recorder] ffmpeg 正常退出，code=255
[recorder] 临时目录内容：index.m3u8, seg000.ts

// 步骤 3：扫描尾片，发现 seg000.ts 未入队，触发首次上传（1+3=4 次）
[recorder] 补传遗漏切片：seg000.ts（105468 bytes）
[recorder] 切片上传失败，第 1 次：seg000.ts，错误：上传失败 HTTP 404：seg000.ts
[recorder] 切片上传失败，第 2 次：...
[recorder] 切片上传失败，第 3 次：...
[recorder] 切片上传失败，第 4 次：...
[recorder] 切片上传失败（已用尽重试）：seg000.ts，加入 pending 队列

// 步骤 4：for 循环 Round 1~3，每轮打印"网络恢复"并触发 4 次上传
[recorder] 网络恢复，开始补传 1 个切片    // Round 1
... 4 次失败 ...
[recorder] 网络恢复，开始补传 1 个切片    // Round 2
... 4 次失败 ...
[recorder] 网络恢复，开始补传 1 个切片    // Round 3
... 4 次失败 ...
[recorder] 网络恢复，开始补传 1 个切片    // Round 4（最后一轮，dispatch 后 for 退出）

// 步骤 5~7：for 退出后立即继续（最后一轮的 pRetry 仍在后台）
[recorder] 无可用切片，跳过 finish 接口
[recorder] 录制结束，时长 00:00:06
[recorder] 临时目录已清理：/var/.../cowatch-rec/<sessionId>/  // fs.rm 回调

// 最后一轮的 pRetry 在目录删除后才运行（BUG 1 的体现）
[recorder] 切片上传失败，第 1 次：seg000.ts，错误：上传失败 HTTP 404：seg000.ts
[recorder] 切片上传失败，第 2 次：seg000.ts，错误：ENOENT: no such file or directory
[recorder] 切片上传失败，第 3 次：seg000.ts，错误：ENOENT: no such file or directory
[recorder] 切片上传失败，第 4 次：seg000.ts，错误：ENOENT: no such file or directory
[recorder] 切片上传失败（已用尽重试）：seg000.ts，加入 pending 队列  // 推进已清空的数组
```

---

### 3. 已知 Bug

**Bug 1：stop() for 循环最后一轮存在竞态 → ENOENT + 幽灵 pending**

`for` 循环最后一轮调用 `flushPendingSegments()`，其内部 `await uploadSegment(filePath)` 只是把 Promise 加入 `activeUploads` 就返回了（`uploadSegment` 是 fire-and-forget 设计）。`for` 循环退出时最后一批 pRetry 还在后台运行，`fs.rm` 和 `pendingSegments = []` 已先行执行。导致：
- pRetry 的 retry 读文件 → `ENOENT`
- pRetry 最终失败 → `.catch` 把路径 push 进已清空的 `pendingSegments`

**Bug 2：clearInterval 无法取消已入队的定时器回调 → 目录清理后触发补传**

`stop()` 开头的 `clearInterval(pendingFlushTimerRef)` 只阻止未来调度，无法撤销已在事件队列里排队的回调。该回调在 `stop()` 全部跑完后才执行，此时临时目录已删、`pendingSegments` 已清空，行为不可预期。

**Bug 3：stop() for 轮数复用了 UPLOAD_MAX_RETRIES，语义混乱**

`for (let round = 0; round < UPLOAD_MAX_RETRIES + 1; round++)` —— stop 阶段的兜底轮数和单次上传的 retry 次数是两个不同维度的概念，复用同一常量导致两者耦合。stop 时不应机械重复失败，1 轮兜底即可。

**Bug 4：flushPendingSegments 无互斥锁 → 服务器持续异常时产生并发雪崩**

30s 定时器用 `void flushPendingSegments()` 调用，不等上一次完成就可以触发下一次。服务器持续异常时（如本次测试的接口 404），随时间推移问题会不断放大：

_极端情况量化（录制 1 小时，每 10s 一个切片 = 360 个切片）：_
```
前 10s：seg000.ts 上传失败 → pending [seg000.ts]
前 20s：seg001.ts 上传失败 → pending [seg000.ts, seg001.ts]
...
30s 定时器触发：flushPendingSegments → 串行处理所有 pending
  此时 pending 已有 3 个切片 → 每个等 pRetry 跑完（最多 15s）才处理下一个
  单次 flush 耗时 = pending数 × 15s，且上一次未完成下一次已启动（void 调用）

1 小时后：pending 里有 360 个切片
单次 flush 需要 360 × 15s = 5400s = 90 分钟
每 30s 又启动一个新 flush 实例
```

_并发雪崩的连锁反应：_
- 多个 `flushPendingSegments` 实例并发跑（`splice(0)` 取出 pending 后，后续新失败继续 push 进来）
- `activeUploads` 里积累大量 Promise，内存持续增长
- 网络带宽被重试请求占满，影响正常录制
- 用户**对此毫不知情**——录制界面看起来完全正常，只是所有切片都没有真正上传

_优先级总览：_

| 优先级 | Bug | 影响 |
|--------|-----|------|
| 🔴 高 | Bug 4：flush 无互斥，多实例并发 | 雪崩式请求，带宽/内存耗尽 |
| 🔴 高 | Bug 1：竞态（for 最后一轮不等待） | ENOENT、临时目录提前删 |
| 🟡 中 | Bug 4（关联）：pending 无上限 | 内存无限增长 |
| 🟡 中 | Bug 4（关联）：flush 串行 + 全量 | 单次耗时过长 |
| ⚪ 低 | Bug 3：for 轮数语义混乱 | 无直接危害，但掩盖设计意图 |

---



### 4. 修复方向

#### 4-A. 竞态修复（独立，改动小，可先实施）

**Bug 1：for 循环后补 await，确保最后一轮 pRetry 落地**
```ts
// stop() 里
for (let round = 0; round < 1; round++) {  // 改为 1 轮（同时修复 Bug 3）
  await Promise.allSettled(Array.from(activeUploads));
  if (pendingSegments.length === 0) break;
  await flushPendingSegments();
}
await Promise.allSettled(Array.from(activeUploads));  // ★ 新增：等最后一批 pRetry 真正落地
// 之后再清理目录和重置状态
```

**Bug 2：增加 isStopped 标志，阻断 clearInterval 后仍在队列里的定时器回调**
```ts
let isStopped = false;

// stop() 开头
isStopped = true;

// flushPendingSegments 入口
if (isStopped || pendingSegments.length === 0) return;

// uploadSegment .catch 入口
if (isStopped) return;  // stop 后不再入队

// start() 重置
isStopped = false;
```

---

#### 4-B. 重构方案：双队列设计（最终确认版）

当前设计的根本问题：`flushPendingSegments` 无互斥、全量串行、无服务器异常感知，服务器持续故障时会产生雪崩，且用户对此毫不知情。

**核心思路：录制上传与补录完全解耦，各司其职。**

```
职责划分：

uploadSegment（录制上传）
  └─ 只管"上传 + retry（1+3=4次，保持原有重试力度）+ 失败入 pendingQueue"
  └─ 完全不感知补录队列的存在，不触发 triggerRetryQueue

triggerRetryQueue（补录队列）
  └─ 只由 start() 内 setInterval（30s）外部驱动
  └─ isRetryScheduled 互斥锁保证同一时刻只有一个实例在运行
  └─ 自己判断是否需要补录、是否应该终止
```

**驱动方式选择说明（setInterval + isRetryScheduled 外部互斥）：**

选择 `setInterval`（外部时钟）驱动，并将 `isRetryScheduled` 互斥判断**前置到 setInterval 回调内**，原因：

- **职责解耦**：ffmpeg 10s 一片，30s 内最多 3 片并发失败进入 `pendingQueue`。若在 `uploadSegment` 失败时触发补录，职责会耦合；`setInterval` 让两者完全独立。
- **退避不被打断**：`isRetryScheduled` 放在 setInterval 入口拦截，`triggerRetryQueue` 内部可以安心做任意长度的指数退避（`await setTimeout(backoffMs)`），不会被外部时钟抢占，160s 上限无需人为压缩。
- **时序可推理**：setInterval 是外部时钟（30s 检查一次，没在跑就踢），`triggerRetryQueue` 是内部逻辑（退避 + 补传 + 健康状态更新），两套时钟职责不重叠，行为可以用简单时序图推演。
- **响应延迟可接受**：最大 30s 等到下次 setInterval 踢，切片已经失败了，多等 30s 无实质影响。
- 原 bug 的根源是 `flushPendingSegments` 无互斥，不是 `setInterval` 本身。

**状态变量（新增/替换）**
```ts
let pendingQueue: string[] = [];   // 替代 pendingSegments
let consecutiveFailRounds = 0;     // 补录整批全败的连续轮次（有任意一片成功即归零）
let isRetryScheduled = false;      // 互斥锁：防止 setInterval 并发触发多个补录实例
const MAX_FAIL_ROUNDS = 5;         // consecutiveFailRounds 上限，超过判定为网络持续不可用
const MAX_PENDING = 15;            // pendingQueue 容量上限 = MAX_FAIL_ROUNDS × 3片/轮
                                   // 语义：与 reround 条件覆盖同一时间窗口（≈2.5 分钟），双保险对称
const RETRY_BATCH = 5;             // 每次补录最多取 5 片
const RETRY_BASE_MS = 10_000;      // 补录退避基础时间（10s）
const UPLOAD_MAX_RETRIES = 1;      // doUpload 内 pRetry 重试次数（1+1=2 次）
                                   // 首次上传只处理瞬时抖动（1s 间隔），持续故障交补录流处理
                                   // 改为快速失败可将最坏阻塞时间从 ~15s 压缩到 ~3s
```

**两个终止条件的语义区分：**
- `consecutiveFailRounds >= MAX_FAIL_ROUNDS`：网络完全不可用（整批全败连续 5 轮，约 5 分钟）
- `pendingQueue.length >= MAX_PENDING`：网络可用但上传速度远低于录制速度（持续积压）

两者捕获不同故障模式，互为补充，任意一个触发均调用 `abortRecording`。

**uploadSegment（调整：失败入 pendingQueue，不触发补录）**
```ts
async function uploadSegment(filePath: string): Promise<void> {
  // pRetry 1 次（1+1=2 次）：首次上传只处理瞬时抖动，持续故障快速失败进 pendingQueue
  // 两路合计重试能力不减弱：补录流里 doUpload 同样 pRetry，且有指数退避兜底
  const upload = pRetry(attemptFn, { retries: UPLOAD_MAX_RETRIES, factor: 2, minTimeout: 1000, maxTimeout: 8000, randomize: true });
  const uploadPromise = upload
    .then(() => {
      segmentKeys.push(objectKey);
      uploadedCount = segmentKeys.length;
      fs.unlink(filePath, () => {});
      pushProgress();
    })
    .catch(() => {
      if (isUserStopped) return;  // stop 后不再入队（修复 Bug 2）
      if (pendingQueue.length >= MAX_PENDING) {
        // 积压超限：立即终止，不再继续入队
        void abortRecording('网络持续异常，切片积压过多');
        return;
      }
      pendingQueue.push(filePath);
      pushProgress();
    })
    .finally(() => activeUploads.delete(uploadPromise));
  activeUploads.add(uploadPromise);
}
```

**triggerRetryQueue（补录队列核心）**

注意：`isRetryScheduled` 的互斥判断**前置在 setInterval 回调里**（见下方定时器代码），`triggerRetryQueue` 内部不再重复判断，职责更单一。

```ts
async function triggerRetryQueue(): Promise<void> {
  // isUserStopped 兜底（abortRecording 触发后退避期间 stop 可能介入）
  if (isUserStopped) return;
  // 无需补传：队列为空且没有连续失败记录
  if (pendingQueue.length === 0 && consecutiveFailRounds === 0) return;

  // 终止条件判断（优先于退避逻辑）
  if (consecutiveFailRounds >= MAX_FAIL_ROUNDS || pendingQueue.length >= MAX_PENDING) {
    void abortRecording('网络持续异常，上传已中止');
    return;
  }

  isRetryScheduled = true;

  // 指数退避 + 随机抖动（只在有连续失败时才退避，首次 consecutiveFailRounds=0 时立即执行）
  const jitter = Math.random() * 2000;
  const backoffMs = consecutiveFailRounds === 0
    ? 0
    : Math.min(RETRY_BASE_MS * Math.pow(2, consecutiveFailRounds - 1), 160_000) + jitter;

  await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));

  if (isUserStopped) { isRetryScheduled = false; return; }

  // 取一批补传
  const batch = pendingQueue.splice(0, RETRY_BATCH);
  let anySuccess = false;

  // 串行处理，避免同一批内并发
  for (const filePath of batch) {
    // 直接调用底层上传（doUpload），不走 fire-and-forget 包装
    // 这里需要知道结果，所以单独 try/catch
    try {
      await doUpload(filePath);  // 成功：会自动 push segmentKeys、unlink、pushProgress
      anySuccess = true;
    } catch {
      // 重新入队，等下轮补传
      if (!isUserStopped) pendingQueue.push(filePath);
    }
  }

  // 更新健康状态
  if (anySuccess) {
    consecutiveFailRounds = 0;  // 有成功：网络可用只是不稳定，重置计数
  } else {
    consecutiveFailRounds++;    // 整批全败：计入连续失败轮次
  }

  isRetryScheduled = false;
  // 注意：不在此处递归调用自己，由 setInterval 驱动下一轮
}
```

**`doUpload` — 底层上传函数（可 await + 会 reject）**

由于 `triggerRetryQueue` 需要知道补传是否成功，需要将上传逻辑拆出一个"会 reject"的底层函数，供两处调用：
1. `uploadSegment`（fire-and-forget 包装，供 chokidar 回调用）
2. `triggerRetryQueue`（直接 await，需要感知结果）

```ts
/**
 * 底层上传实现：pRetry 包装，成功时更新 segmentKeys 并删除临时文件，失败时 reject。
 * 供 uploadSegment（fire-and-forget）和 triggerRetryQueue（可 await）共同调用。
 */
async function doUpload(filePath: string): Promise<void> {
  const segmentName = path.basename(filePath);
  const objectKey = `cowatch/${currentRoomId}/recordings/${sessionId}/${segmentName}`;

  await pRetry(
    async () => {
      const buffer = fs.readFileSync(filePath);
      const response = await net.fetch(`${apiOrigin}/api/rooms/${currentRoomId}/recording/segment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'video/MP2T',
          'X-Object-Key': objectKey,
          ...(currentAuthToken ? { Authorization: `Bearer ${currentAuthToken}` } : {}),
        },
        body: buffer,
        duplex: 'half',
      } as RequestInit);
      if (!response.ok) throw new Error(`上传失败 HTTP ${response.status}：${segmentName}`);
    },
    {
      retries: UPLOAD_MAX_RETRIES,
      factor: 2, minTimeout: 1000, maxTimeout: 8000, randomize: true,
      onFailedAttempt: (ctx) => {
        console.warn(`[recorder] 切片上传失败，第 ${ctx.attemptNumber} 次：${segmentName}，错误：${ctx.error.message}`);
      },
    },
  );

  // 上传成功
  segmentKeys.push(objectKey);
  uploadedCount = segmentKeys.length;
  queuedFileNames.add(segmentName);
  fs.unlink(filePath, (err) => {
    if (err) console.warn('[recorder] 删除临时文件失败：', filePath, err.message);
  });
  pushProgress();
}

/**
 * fire-and-forget 包装：供 chokidar add 事件回调使用。
 * 失败时入 pendingQueue（由 triggerRetryQueue 补传）。
 */
async function uploadSegment(filePath: string): Promise<void> {
  const segmentName = path.basename(filePath);
  queuedFileNames.add(segmentName);  // 提前标记，防止 stop() 扫描重复入队

  const uploadPromise = doUpload(filePath)
    .catch(() => {
      if (isUserStopped) return;
      if (pendingQueue.length >= MAX_PENDING) {
        void abortRecording('网络持续异常，切片积压过多');
        return;
      }
      console.error(`[recorder] 切片上传失败（已用尽重试）：${segmentName}，加入 pending 队列`);
      pendingQueue.push(filePath);
      pushProgress();
    })
    .finally(() => activeUploads.delete(uploadPromise));

  activeUploads.add(uploadPromise);
}
```

**定时器（start() 里替换 flushPendingSegments 定时器）**

`isRetryScheduled` 互斥判断**前置在 setInterval 回调里**，是整个方案的关键：
- 上一轮 `triggerRetryQueue` 还在退避或补传中（`isRetryScheduled=true`）→ 本次跳过，不打断退避
- 上一轮已完成（`isRetryScheduled=false`）→ 踢一下，启动新一轮

```ts
// 原来（有雪崩风险）
const pendingFlushTimer = setInterval(() => {
  if (pendingSegments.length > 0) void flushPendingSegments();
}, 30_000);

// 改为（互斥判断前置，退避不被打断，无雪崩风险）
const retryTimer = setInterval(() => {
  if (isRetryScheduled) return;  // ★ 上一轮还在跑（可能正在退避），跳过本次
  void triggerRetryQueue();
}, 30_000);
retryTimerRef = retryTimer;  // 统一在 stop() 开头 clearInterval
```

**abortRecording（服务器异常时主动终止）**
```ts
async function abortRecording(reason: string): Promise<void> {
  if (isUserStopped) return;  // 防重入（stop() 已在走，不要抢占）
  console.error(`[recorder] 录制异常终止：${reason}`);
  isUserStopped = true;

  // 停止 ffmpeg（平台差异与 stop() 一致）
  if (ffmpegProcess) {
    if (process.platform === 'win32') {
      ffmpegProcess.stdin?.write('q');
      ffmpegProcess.stdin?.end();
    } else {
      ffmpegProcess.kill('SIGTERM');
    }
  }

  // 等待正在进行的上传落地（已发出的请求不浪费）
  await Promise.allSettled(Array.from(activeUploads));

  // 用已成功的切片调 finish（保留已上传部分，不浪费）
  if (segmentKeys.length > 0) await callFinishApi();

  // 通知渲染进程弹窗报错
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('recorder:error', {
      reason,
      savedSeconds: segmentKeys.length * HLS_SEGMENT_DURATION,
    });
  }

  cleanup();
}
```

**stop() — 用户主动停止（完整修复版）**

用户主动停止与 `abortRecording` 异常终止的区别：
- 不弹错误弹窗
- 给 pendingQueue 一次最终补传机会（不退避，直接执行）
- 最终补传失败时静默跳过（仅记录日志），不阻断 finish 接口调用

```ts
async function stop(): Promise<void> {
  if (!ffmpegProcess) return;

  isUserStopped = true;  // ★ 提前设置，阻断已入队的定时器回调（修复 Bug 2）

  // 清理所有定时器
  if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
  if (timeoutTimer !== null) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  if (retryTimerRef !== null) { clearInterval(retryTimerRef); retryTimerRef = null; }

  const durationSeconds = Math.floor((Date.now() - recordStartTime) / 1000);
  const sessionTmpDir = tmpDir;

  // 停止 ffmpeg（等待退出，15s 超时强杀）
  await waitForFfmpegExit();
  ffmpegProcess = null;

  // 停止文件监听
  if (watcher) { await watcher.close(); watcher = null; }

  // 扫描临时目录，补入 chokidar 未捕获的尾片（同原有逻辑）
  try {
    const tsFiles = fs.readdirSync(sessionTmpDir).filter(f => f.endsWith('.ts'));
    for (const file of tsFiles) {
      if (!queuedFileNames.has(file)) {
        await uploadSegment(path.join(sessionTmpDir, file));
      }
    }
  } catch (err) {
    console.warn('[recorder] 扫描临时目录失败：', (err as Error).message);
  }

  // ① 等待 chokidar 和尾片扫描触发的所有 uploadSegment 落地
  await Promise.allSettled(Array.from(activeUploads));  // ★ 修复 Bug 1

  // ② 给 pendingQueue 一次最终补传机会（不退避）
  if (pendingQueue.length > 0) {
    const remaining = pendingQueue.splice(0);
    await Promise.allSettled(
      remaining.map((f) =>
        doUpload(f).catch(() => {
          console.warn('[recorder] 停止阶段补传失败，放弃切片：', path.basename(f));
        }),
      ),
    );
  }

  // ③ 等待②中触发的上传全部落地（doUpload 直接 await，无需再等 activeUploads）
  // （doUpload 在 triggerRetryQueue 里是直接 await，不走 activeUploads，此处无需额外等待）

  // 调用 finish 接口
  if (segmentKeys.length > 0) await callFinishApi();
  else console.warn('[recorder] 无可用切片，跳过 finish 接口');

  cleanup(sessionTmpDir, durationSeconds);
}
```

**cleanup() — 统一清理函数**

`stop()` 和 `abortRecording()` 共用，避免重复代码和遗漏：
```ts
function cleanup(sessionTmpDir: string, durationSeconds: number): void {
  // 清理临时目录
  fs.rm(sessionTmpDir, { recursive: true, force: true }, (err) => {
    if (err) console.warn('[recorder] 临时目录清理失败：', err.message);
    else console.log('[recorder] 临时目录已清理：', sessionTmpDir);
  });

  // 重置所有模块级状态
  sessionId = '';
  tmpDir = '';
  segmentKeys = [];
  pendingQueue = [];
  uploadedCount = 0;
  currentRoomId = '';
  currentAuthToken = '';
  crashRestartCount = 0;
  consecutiveFailRounds = 0;
  isRetryScheduled = false;
  activeUploads.clear();
  queuedFileNames.clear();

  console.log(`[recorder] 录制结束，时长 ${formatDuration(durationSeconds)}`);
}
```

---

#### 4-C. 实施说明

**跳过 Phase 1，直接实施 Phase 2（本方案）**，理由：
- Phase 1 的所有修复点（Bug 1/2/3）均被本方案完整覆盖
- Phase 1 先做再重构会导致返工，两次改动引入错误的风险更高
- 代码目前仍在开发阶段，无需过渡版本

**前端配合改动**（同步实施）：
- `src/components/Recorder/index.tsx` 新增 `recorder:error` 事件监听，弹窗展示异常终止原因和已保存时长
- `electron/preload.ts` 补充 `onError` / `offError` 方法暴露

---

### 5. 设计备忘：两层容错的分工

**层 1 — `doUpload` 内的 pRetry（1+3=4 次，约 1s~8s 指数退避）**

针对**瞬时抖动**：网络闪断百毫秒、服务器偶发 5xx。失败偶然，等几秒后大概率成功。
作用：过滤噪音，减少无意义的 pendingQueue 积压。

**层 2 — 补录队列 `triggerRetryQueue`（setInterval 30s 驱动，指数退避，最多 5 轮）**

针对**持续性故障**：服务器重启（15~30s）、网络大范围中断、接口未部署。
pRetry 全败后入 `pendingQueue`，每 30s 由 `triggerRetryQueue` 取批补传，指数退避。
终止条件（任意一个触发）：
1. `consecutiveFailRounds >= MAX_FAIL_ROUNDS`（5 轮全败，约 2.5 分钟）→ 网络持续不可用
2. `pendingQueue.length >= MAX_PENDING`（积压 30 片）→ 上传速度持续低于录制速度

**两层是互补关系，不是冗余**：

| | pRetry（层 1） | 补录队列（层 2） |
|---|---|---|
| 针对场景 | 瞬时抖动（秒级） | 持续故障（分钟级） |
| 触发时机 | 每次 `uploadSegment`（chokidar add 事件） | `setInterval` 每 30s 外部驱动 |
| 失败结果 | 入 `pendingQueue` | `consecutiveFailRounds++`，达上限终止 |
| 用户感知 | 无（进度条 pending 值增加） | 弹窗报错，展示已保存时长 |
| 互斥机制 | `activeUploads` Set 追踪 | `isRetryScheduled` 锁 |

---

## 版本 2：修复实现

> 待实施（按 §4-B 最终确认方案）
