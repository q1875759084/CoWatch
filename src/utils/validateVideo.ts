/**
 * 视频上传前端校验工具
 *
 * ══════════════════════════════════════════════════════════════
 * 1080p 60Hz H.264（libx264）各 CRF 档位参考码率（游戏录屏，高动态画面）
 * ──────────────────────────────────────────────────────────────
 *  原始录屏（N卡 NVENC 默认 CQP 18）  ≈ 30~80 Mbps  视频流
 *  CRF 23（high）                    ≈  8~14 Mbps  视频流
 *  CRF 26（balanced）                ≈  5~ 9 Mbps  视频流
 *  CRF 28（small）                   ≈  3~ 6 Mbps  视频流  ← basic 上传要求
 *  CRF 30（smaller）                 ≈  2~ 4 Mbps  视频流
 *  CRF 32（min）                     ≈  1~ 3 Mbps  视频流
 *
 * 说明：以上为视频流码率，加上 AAC 音频 128k ≈ +0.13 Mbps。
 * JS 通过「文件大小 / 时长」计算的是【总平均码率】（视频 + 音频 + 容器开销），
 * 因此实测值会略高于纯视频流码率约 0.1~0.2 Mbps，阈值已留足余量。
 * ══════════════════════════════════════════════════════════════
 *
 * 校验策略（按房间等级）：
 *
 *   vip:basic（默认）
 *     校验一：moov 索引位置 — moov box 必须在 mdat 之前（faststart 格式）
 *     校验二：平均码率 ≤ 8 Mbps（对应 CRF 28 压缩要求）
 *
 *   vip:pro
 *     跳过 moov 和码率校验（后端负责转码，会自动添加 faststart + 重新编码）
 *     只校验文件大小 ≤ 3 GB（防止单文件撑满磁盘/带宽）
 */

export interface VideoValidateResult {
  ok: boolean;
  /** 校验失败时的错误标题（用于弹窗 title） */
  errorTitle?: string;
  /** 校验失败时的错误详情（用于弹窗 content） */
  errorDetail?: string;
}

/**
 * basic 房间允许的最大平均码率，单位 Mbps。
 * 对应 CRF 28 压缩要求：视频流上限 6 Mbps + 音频 0.13 Mbps + 余量 ≈ 8 Mbps。
 */
const MAX_BITRATE_MBPS = 8;

/** pro 房间允许的最大文件大小：3 GB */
const MAX_FILE_SIZE_BYTES = 3 * 1024 * 1024 * 1024;

/**
 * 读取文件头部，扫描 MP4 box 顺序。
 * 返回 true 表示 moov 出现在 mdat 之前（faststart 格式），false 反之。
 */
function checkMoovBeforeMdat(buffer: ArrayBuffer): boolean {
  const view = new DataView(buffer);
  let offset = 0;

  while (offset + 8 <= buffer.byteLength) {
    // box size：前 4 字节，大端序
    let boxSize = view.getUint32(offset, false);
    // box type：接下来 4 字节，ASCII
    const typeBytes = new Uint8Array(buffer, offset + 4, 4);
    const boxType = String.fromCharCode(...typeBytes);

    if (boxType === 'moov') return true;
    if (boxType === 'mdat') return false;

    // size === 1 表示使用 64 位扩展 size（large box），跳过
    if (boxSize === 1) {
      if (offset + 16 > buffer.byteLength) break;
      // 高 32 位通常为 0，直接取低 32 位近似处理
      boxSize = view.getUint32(offset + 12, false);
    }

    // size === 0 表示此 box 延伸到文件末尾，无法继续遍历
    if (boxSize === 0 || boxSize < 8) break;

    offset += boxSize;
  }

  // 在读取范围内未找到 moov / mdat（文件头部截断），视为不合格
  return false;
}

/**
 * 通过临时 <video> 元素获取视频时长（秒）。
 * 依赖浏览器原生解析，moov 在前时可快速获取，不会下载完整文件。
 */
function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';

    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.src = '';
    };

    video.onloadedmetadata = () => {
      const duration = video.duration;
      cleanup();
      if (!isFinite(duration) || duration <= 0) {
        reject(new Error('无法读取视频时长'));
      } else {
        resolve(duration);
      }
    };

    video.onerror = () => {
      cleanup();
      reject(new Error('视频文件损坏或格式不支持'));
    };

    video.src = url;
  });
}

/**
 * 对选中文件执行校验。策略由房间等级决定：
 *
 *   vip:pro  — 后端负责转码，跳过 moov 和码率校验，只限制文件大小 ≤ 3 GB
 *   其他      — 顺序执行：moov 位置 → 平均码率 ≤ 8 Mbps
 *
 * @param file      用户选择的视频文件
 * @param planLevel 当前房间等级，来自 useRoomMeta().roomMeta?.planLevel
 */
export async function validateVideoFile(
  file: File,
  planLevel?: string,
): Promise<VideoValidateResult> {
  // ── pro 房间：后端转码，只校验文件大小 ────────────────────────────────────
  if (planLevel === 'vip:pro') {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      const sizGb = (file.size / 1024 / 1024 / 1024).toFixed(2);
      return {
        ok: false,
        errorTitle: '文件过大',
        errorDetail:
          `文件大小为 ${sizGb} GB，超出单次上传限制（3 GB）。\n\n` +
          `请将视频裁剪或拆分后再上传。`,
      };
    }
    return { ok: true };
  }

  // ── basic 及以下：校验一 — moov 索引位置 ─────────────────────────────────
  const HEAD_BYTES = 32 * 1024; // 只读前 32KB
  const slice = file.slice(0, HEAD_BYTES);
  let buffer: ArrayBuffer;
  try {
    buffer = await slice.arrayBuffer();
  } catch {
    return { ok: false, errorTitle: '文件读取失败', errorDetail: '无法读取文件，请重试' };
  }

  if (!checkMoovBeforeMdat(buffer)) {
    return {
      ok: false,
      errorTitle: '视频格式不符合要求',
      errorDetail:
        '检测到视频索引（moov）位于文件末尾，浏览器需要完整下载后才能播放，无法快速 seek。\n\n请使用压缩工具处理后再上传，压缩工具已自动添加 -movflags +faststart，可解决此问题。',
    };
  }

  // ── basic 及以下：校验二 — 平均码率 ──────────────────────────────────────
  let duration: number;
  try {
    duration = await getVideoDuration(file);
  } catch (err) {
    return { ok: false, errorTitle: '视频读取失败', errorDetail: (err as Error).message };
  }

  const bitrateMbps = (file.size * 8) / duration / 1_000_000;
  if (bitrateMbps > MAX_BITRATE_MBPS) {
    return {
      ok: false,
      errorTitle: '视频码率过高',
      errorDetail:
        `检测到视频平均码率约为 ${bitrateMbps.toFixed(1)} Mbps，超出限制（${MAX_BITRATE_MBPS} Mbps）。\n\n` +
        `高码率视频会显著增加 CDN 流量消耗，影响所有成员的观看体验。\n\n` +
        `请使用压缩工具将视频压缩至 CRF 30 或更低码率后再上传（推荐使用 CoWatch 提供的压缩脚本）。`,
    };
  }

  return { ok: true };
}
