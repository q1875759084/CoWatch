/**
 * 主进程设置持久化存储模块
 *
 * 录制/转码参数持久化到 JSON 文件（全局共享，所有房间共用一份）。
 * 文件位置：app.getPath('userData')/settings.json
 *
 * 读取时合并到 DEFAULT_SETTINGS（确保新增字段有默认值兜底）；
 * 写入用 fs.writeFileSync（设置文件很小，同步写入即可）。
 *
 * IPC 通道（ipcMain.handle）：
 *   settings:get  → 返回完整 AppSettings
 *   settings:set  → 接收 (section, values)，合并写回，返回更新后的 AppSettings
 */

import { app, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import type { AppSettings, SettingsSection, RecordingSettings, TranscodeSettings } from '../../src/types/settings';
import { DEFAULT_SETTINGS } from '../../src/types/settings';

/**
 * settings.json 文件路径。
 * 用函数形式而非顶层常量：app.getPath('userData') 需在 app ready 后才可用。
 */
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

/**
 * 读取设置：合并到 DEFAULT_SETTINGS，确保新字段有默认值。
 * 文件不存在或 JSON 解析失败时返回 DEFAULT_SETTINGS。
 */
export function getSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // 合并默认值，确保新字段有兜底
    return {
      recording: { ...DEFAULT_SETTINGS.recording, ...parsed.recording },
      transcode: { ...DEFAULT_SETTINGS.transcode, ...parsed.transcode },
    };
  } catch {
    // 文件不存在或 JSON 解析失败：返回默认值
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 更新设置：读取当前设置，合并 values 到对应 section，写回 JSON，返回更新后的完整 AppSettings。
 */
export function updateSettings(
  section: SettingsSection,
  values: Partial<RecordingSettings> | Partial<TranscodeSettings>,
): AppSettings {
  const current = getSettings();
  const updated: AppSettings = {
    ...current,
    [section]: { ...current[section], ...values },
  };
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

/**
 * 注册设置相关 IPC 处理器。
 */
export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', () => {
    return getSettings();
  });

  ipcMain.handle('settings:set', (_event, section: SettingsSection, values: Partial<RecordingSettings> | Partial<TranscodeSettings>) => {
    return updateSettings(section, values);
  });
}
