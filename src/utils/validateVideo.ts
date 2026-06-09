/**
 * 视频上传前端校验工具
 *
 * ══════════════════════════════════════════════════════════════
 * 1080p 60Hz H.264（libx264）各 CRF 档位参考码率（游戏录屏，高动态画面）
 * ──────────────────────────────────────────────────────────────
 *  原始录屏（N卡 NVENC 默认 CQP 18）  ≈ 30~80 Mbps  视频流
 *  CRF 23（high）                    ≈  8~14 Mbps  视频流
 *  CRF 26（balanced）                ≈  5~ 9 Mbps  视频流
 *  CRF 28（small）                   ≈  3~ 6 Mbps  视频流  ← 当前上传要求
 *  CRF 30（smaller）                 ≈  2~ 4 Mbps  视频流
 *  CRF 32（min）                     ≈  1~ 3 Mbps  视频流
 *
 * 说明：以上为视频流码率，加上 AAC 音频 128k ≈ +0.13 Mbps。
 * JS 通过「文件大小 / 时长」计算的是【总平均码率】（视频 + 音频 + 容器开销），
 * 因此实测值会略高于纯视频流码率约 0.1~0.2 Mbps，阈值已留足余量。
 * ══════════════════════════════════════════════════════════════
 *
 * 校验一：moov 索引位置
 *   经过 `-movflags +faststart` 处理的 MP4，moov box 出现在 mdat 之前。
 *   只读文件头部 32KB，扫描 box 顺序，若先遇到 mdat 则拒绝。
 *
 * 校验二：平均码率
 *   通过临时 <video> 元素获取时长，结合文件大小计算平均码率。
 *   当前阈值：8 Mbps（对应 CRF 28 上限 6 Mbps + 音频 + 余量）
 *
 * TODO: 后续根据房间等级（或用户会员等级）动态调整 MAX_BITRATE_MBPS：
 *   - 普通房间：8 Mbps（对应 CRF 28）
 *   - 高级房间：14 Mbps（对应 CRF 23）
 *   届时将 MAX_BITRATE_MBPS 改为从房间/用户配置中读取。
 */

export interface VideoValidateResult {
  ok: boolean;
  /** 校验失败时的错误标题（用于弹窗 title） */
  errorTitle?: string;
  /** 校验失败时的错误详情（用于弹窗 content） */
  errorDetail?: string;
}

/**
 * 允许的最大平均码率，单位 Mbps。
 * 对应 CRF 28 压缩要求：视频流上限 6 Mbps + 音频 0.13 Mbps + 余量 ≈ 8 Mbps。
 */
const MAX_BITRATE_MBPS = 8;

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
 * 对选中文件执行完整校验，顺序：moov 位置 → 码率。
 * @param file 用户选择的视频文件
 */
export async function validateVideoFile(file: File): Promise<VideoValidateResult> {
  // ── 校验一：moov 索引位置 ──────────────────────────────────────────────────
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

  // ── 校验二：平均码率 ───────────────────────────────────────────────────────
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
        `请使用压缩工具将视频压缩至 CRF 28 或更低码率后再上传（推荐使用 CoWatch 提供的压缩脚本）。`,
    };
  }

  return { ok: true };
}
