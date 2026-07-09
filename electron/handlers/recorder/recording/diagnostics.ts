/**
 * T0 诊断日志落盘器（DiagnosticLogger）。
 *
 * 背景：
 *   CoWatch 录制卡顿根因排查中，浏览器录制那次终端日志被截断，缺 inferredCaptureFps，
 *   未能确认其 capture 侧是否也塌。本类把 [rec-probe] / [rec-watch] / [rec-audio] 摘要行
 *   **写入文件**（tmpDir/diag-<sessionId>.log），绕开终端截断，便于事后复盘与跨源对照。
 *
 * 设计约束（来自系统设计与 T0 任务书）：
 *   - 仅用 Node 内置 fs，无新依赖。
 *   - 以 append 模式打开日志文件，probe/watch/audio 均追加写入。
 *   - 所有写入用 try/catch 包住，失败静默，绝不抛错中断录制主流程。
 *   - close() 仅做 best-effort flush/close，任何异常都不影响录制。
 */

import fs from 'fs';
import path from 'path';

export class DiagnosticLogger {
  /** 落盘日志文件全路径：tmpDir/diag-<sessionId>.log */
  private readonly logPath: string;
  /** 以 append 模式打开的文件描述符（失败则为 null，后续 appendFileSync 仍可用） */
  private fd: number | null = null;
  /** 防止重复 close */
  private closed = false;

  /**
   * @param tmpDir    本次录制会话的临时目录（由上层传入，已确保可写）
   * @param sessionId 录制会话 ID（uuid），用于区分不同录制的日志文件
   */
  constructor(tmpDir: string, sessionId: string) {
    this.logPath = path.join(tmpDir, 'diag-' + sessionId + '.log');
    try {
      // 以 append 模式打开：'a' = 文件不存在则创建，存在则追加，每次写入自动定位到末尾
      this.fd = fs.openSync(this.logPath, 'a');
    } catch (_err) {
      // 打开失败不抛错；probe/watch/audio 仍会尝试 appendFileSync 直接写
      this.fd = null;
    }
  }

  /**
   * 记录一次进度探针（对应现有 [rec-probe] 日志行）。
   * 计算 inferredCaptureFps = (frame - dup) / elapsedWallClockSec，并把一行
   * `[rec-probe] elapsed=..s frame=.. fps=.. dup=.. drop=.. inferredCaptureFps=..`
   * 追加到日志文件（同时绕开终端截断）。
   *
   * @param elapsedWallClockSec 当前 ffmpeg 进程启动以来的墙钟秒数
   * @param frame                ffmpeg 报告的累计输出帧数
   * @param fps                  ffmpeg 报告的当前输出 fps
   * @param dup                  累计 dup 帧数
   * @param drop                 累计 drop 帧数
   */
  probe(
    elapsedWallClockSec: number,
    frame: number,
    fps: number,
    dup: number,
    drop: number,
  ): void {
    const captured = frame - dup;
    const inferredCaptureFps = elapsedWallClockSec > 0 ? captured / elapsedWallClockSec : 0;
    const line =
      `[rec-probe] elapsed=${elapsedWallClockSec.toFixed(1)}s frame=${frame} fps=${fps} ` +
      `dup=${dup} drop=${drop} inferredCaptureFps=${inferredCaptureFps.toFixed(1)}\n`;
    this.append(line);
  }

  /**
   * 记录一条窗口监听事件摘要（[rec-watch]）。
   * @param event 事件名（如 "窗口未找到" / "目标窗口消失" / "窗口恢复" / "total events=N"）
   * @param ts    mm:ss 格式时间戳（相对录制开始）
   */
  watch(event: string, ts: string): void {
    this.append(`[rec-watch] ${event} @${ts}\n`);
  }

  /**
   * 记录一条音频诊断摘要（[rec-audio]）。
   * @param info 摘要信息（如 "discontinuity" / "total discontinuities=N"）
   * @param ts   mm:ss 格式时间戳（相对录制开始）
   */
  audio(info: string, ts: string): void {
    this.append(`[rec-audio] ${info} @${ts}\n`);
  }

  /**
   * 关闭日志流（best-effort）。stop 时调用一次即可。
   * 任何异常都静默吞掉，绝不中断录制主流程。
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.fd !== null) {
        fs.closeSync(this.fd);
        this.fd = null;
      }
    } catch (_err) {
      // best-effort，绝不中断录制
    }
  }

  /**
   * 统一追加写入（私有）。所有调用方已保证 line 以 \n 结尾。
   * fs.appendFileSync 每次以 append 模式打开并立即落盘，崩溃时也能保住已写内容。
   */
  private append(line: string): void {
    try {
      fs.appendFileSync(this.logPath, line);
    } catch (_err) {
      // 写入失败静默，绝不抛错中断录制
    }
  }
}
