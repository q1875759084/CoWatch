/**
 * 持久化模块：管理未上传切片的本地存储与补传。
 *
 * 职责：
 *   - stop 时将未上传切片从 tmpDir 移动到持久化目录
 *   - 写入 manifest.json 记录切片元数据
 *   - 启动时扫描持久化目录，展示待补传列表
 *   - 用户手动触发补传，完成后调 finish 入库
 */

import fs from 'fs';
import path from 'path';
import { app, net } from 'electron';

import { initUploader, doUpload, cleanupUploader } from '../upload';
import { parseSegmentIndex } from '../shared/segment-naming';
import type { PendingRecording } from '../../../../src/types/recorder';

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export interface ManifestSegment {
  index: number;
  fileName: string;
  objectKey: string;
  size: number;
}

export interface Manifest {
  sessionId: string;
  roomId: string;
  createdAt: string;
  totalSegments: number;
  uploadedCount: number;
  segments: ManifestSegment[];
  displayName: string;
  durationSeconds: number;
  apiOrigin: string;
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

function getPendingDir(): string {
  return path.join(app.getPath('userData'), 'pending-uploads');
}


// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 将未上传切片从 tmpDir 移动到持久化目录，写入 manifest。
 *
 * @returns 持久化目录路径，若没有待上传切片则返回 null
 */
export function persistRecording(
  sessionId: string,
  roomId: string,
  tmpDir: string,
  pendingFiles: string[],
  segmentKeys: string[],
  displayName: string,
  durationSeconds: number,
  apiOrigin: string,
  authToken: string,
): string | null {
  if (pendingFiles.length === 0) return null;

  const persistDir = path.join(getPendingDir(), sessionId);
  fs.mkdirSync(persistDir, { recursive: true });

  const segments: ManifestSegment[] = [];
  let totalSize = 0;

  for (const srcPath of pendingFiles) {
    const fileName = path.basename(srcPath);

    let stat: fs.Stats;
    try { stat = fs.statSync(srcPath); } catch {
      console.warn(`[persistence] 切片文件不存在，跳过持久化：${srcPath}`);
      continue;
    }

    const destPath = path.join(persistDir, fileName);
    try { fs.renameSync(srcPath, destPath); } catch {
      console.warn(`[persistence] 切片移动失败，跳过：${srcPath}`);
      continue;
    }

    segments.push({
      index: parseSegmentIndex(fileName),
      fileName,
      objectKey: `cowatch/${roomId}/recordings/${sessionId}/${fileName}`,
      size: stat.size,
    });
    totalSize += stat.size;
  }

  // 按 index 排序
  segments.sort((a, b) => a.index - b.index);

  const manifest: Manifest = {
    sessionId,
    roomId,
    createdAt: new Date().toISOString(),
    totalSegments: segments.length,
    uploadedCount: 0,
    segments,
    displayName,
    durationSeconds,
    apiOrigin,
  };

  fs.writeFileSync(path.join(persistDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[persistence] 持久化完成：${segments.length} 片，${(totalSize / 1024 / 1024).toFixed(1)}MB → ${persistDir}`);

  return persistDir;
}

/**
 * 扫描持久化目录，按 createdAt 倒序返回待补传录制列表。
 */
export function listPendingRecordings(): PendingRecording[] {
  const baseDir = getPendingDir();
  if (!fs.existsSync(baseDir)) return [];

  const entries: PendingRecording[] = [];

  for (const dirName of fs.readdirSync(baseDir)) {
    const dirPath = path.join(baseDir, dirName);
    // 跳过非目录条目（如意外产生的文件）
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const manifestPath = path.join(dirPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const m: Manifest = JSON.parse(raw);
      const totalSize = m.segments.reduce((sum, s) => sum + s.size, 0);

      entries.push({
        sessionId: m.sessionId,
        roomId: m.roomId,
        createdAt: m.createdAt,
        totalSegments: m.totalSegments,
        uploadedCount: m.uploadedCount,
        totalSize,
        displayName: m.displayName,
        durationSeconds: m.durationSeconds,
      });
    } catch (err) {
      console.error(`[persistence] 读取 manifest 失败：${manifestPath}`, (err as Error).message);
    }
  }

  entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return entries;
}

/**
 * 启动补传单条持久化录制。
 *
 * 流程：读取 manifest → initUploader → 逐片 doUpload → 全部完成 → finish → 清理。
 */
export async function resumeUpload(sessionId: string, authToken: string): Promise<void> {
  const persistDir = path.join(getPendingDir(), sessionId);
  const manifestPath = path.join(persistDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[persistence] manifest 不存在：${manifestPath}`);
  }

  const raw = fs.readFileSync(manifestPath, 'utf-8');
  const manifest: Manifest = JSON.parse(raw);

  console.log(`[persistence] 开始补传：${sessionId}，${manifest.totalSegments} 片`);

  // 初始化上传层（使用当前 token，而非 manifest 中的过期 token）
  initUploader(
    {
      roomId: manifest.roomId,
      sessionId: manifest.sessionId,
      authToken,
      apiOrigin: manifest.apiOrigin,
    },
    {
      onLog: (msg) => console.log(msg),
    },
  );

  // 逐片上传
  let uploaded = manifest.uploadedCount;
  for (const seg of manifest.segments) {
    const filePath = path.join(persistDir, seg.fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`[persistence] 切片文件不存在，跳过：${filePath}`);
      continue;
    }

    await doUpload(filePath);
    uploaded += 1;

    // 更新 manifest 中的进度
    manifest.uploadedCount = uploaded;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // push progress 到前端（通过现有 IPC 通道）
    pushProgressFromPersistence(manifest.totalSegments, uploaded);
  }

  // 全部上传完成 → 调 finish 入库
  const segmentKeys = manifest.segments.map((s) => s.objectKey);

  try {
    const response = await net.fetch(
      `${manifest.apiOrigin}/api/rooms/${manifest.roomId}/recording/finish`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          segmentKeys,
          displayName: manifest.displayName,
          durationSeconds: manifest.durationSeconds,
        }),
        duplex: 'half',
      } as RequestInit,
    );

    if (!response.ok) {
      console.error(`[persistence] finish 接口失败：HTTP ${response.status}`);
    } else {
      console.log('[persistence] finish 接口调用成功，视频已入库');
    }
  } catch (err) {
    console.error('[persistence] finish 接口异常：', (err as Error).message);
  }

  // 清理持久化目录和上传层
  cleanupUploader();
  fs.rmSync(persistDir, { recursive: true, force: true });
  console.log(`[persistence] 补传完成，已清理：${persistDir}`);
}

/**
 * 通知前端补传进度（复用手动广播方式，与 recorder/index.ts 的 pushProgress 保持一致）。
 */
function pushProgressFromPersistence(total: number, uploaded: number): void {
  // 通过 recorder:progress IPC 通道推送
  const { BrowserWindow } = require('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('recorder:progress', {
      uploaded,
      pending: total - uploaded,
    });
  }
}
