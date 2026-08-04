import { useState, useEffect, useRef, useCallback } from 'react';
import { ConfigProvider, theme, Card, Result, App, Spin } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/Button';
import RecordingPanel from './RecordingPanel';
import TranscodePanel from './TranscodePanel';
import type { AppSettings } from '@/types/settings';

const COLORS = {
  bgBase: '#0a0f1e',
  bgDeep: '#0d1117',
  bgSurface: '#161b22',
  border: '#30363d',
  textPrimary: '#e2e8f0',
  textSecondary: '#a0aec0',
  primary: '#63b3ed',
};

const NAV_ITEMS = [
  { key: 'recording', label: '录制设置' },
  { key: 'transcode', label: '转码设置' },
] as const;

function SettingsContent() {
  const [searchParams] = useSearchParams();
  const initialSection = searchParams.get('section') === 'transcode' ? 'transcode' : 'recording';
  const [activeKey, setActiveKey] = useState<'recording' | 'transcode'>(initialSection);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const recordingRef = useRef<{ handleSave: () => Promise<void> }>(null!);
  const transcodeRef = useRef<{ handleSave: () => Promise<void> }>(null!);
  const { message } = App.useApp();

  // 覆盖 HTML title（覆盖 public/index.html 的 <title>CoWatch</title>）
  useEffect(() => {
    document.title = '设置';
  }, []);

  // 窗口首次打开时一次性拉取整份设置（切 tab 不再触发）
  useEffect(() => {
    const bridge = window.electronBridge;
    if (!bridge?.settings) return;
    bridge.settings.get().then(setSettings);
  }, []);

  // 监听主进程 Tab 切换通知（单例窗口再次打开时通过 webContents.send 触发）
  useEffect(() => {
    const bridge = window.electronBridge;
    if (!bridge?.settings?.onSwitchTab) return;
    const unsub = bridge.settings.onSwitchTab((section) => setActiveKey(section));
    return unsub;
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const panelRef = activeKey === 'recording' ? recordingRef : transcodeRef;
      await panelRef.current.handleSave();
    } catch (err) {
      console.error('保存失败:', err);
    } finally {
      setSaving(false);
    }
  }, [activeKey]);

  const handleCancel = useCallback(() => {
    // 等价于右上角 X:触发 BrowserWindow 的 close 事件(main.ts 的 closed handler 会重置 settingsWin)
    window.close();
  }, []);

  if (!settings) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: COLORS.bgDeep }}>
        <Spin />
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: COLORS.bgDeep,
        color: COLORS.textPrimary,
        padding: '12px 12px 0 12px',
        boxSizing: 'border-box',
      }}
    >
      {/* 主体区域：左侧导航 + 右侧内容 */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* 左侧导航栏 */}
        <nav
          style={{
            width: 180,
            flexShrink: 0,
            background: COLORS.bgSurface,
            borderRadius: 4,
            paddingTop: 8,
            marginRight: 12,
            overflowY: 'auto',
          }}
        >
          {NAV_ITEMS.map((item) => {
            const active = item.key === activeKey;
            return (
              <div
                key={item.key}
                onClick={() => setActiveKey(item.key)}
                style={{
                  padding: '9px 14px',
                  cursor: 'pointer',
                  fontSize: 13,
                  color: active ? COLORS.primary : COLORS.textSecondary,
                  background: active ? 'rgba(99,179,237,0.15)' : 'transparent',
                  borderLeft: `3px solid ${active ? COLORS.primary : 'transparent'}`,
                  userSelect: 'none',
                  transition: 'background 0.15s',
                }}
              >
                {item.label}
              </div>
            );
          })}
        </nav>

        {/* 右侧参数区域 */}
        <main style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
          <Card
            title="常规"
            size="small"
            style={{ background: COLORS.bgSurface, borderColor: 'transparent', marginBottom: 12 }}
            styles={{
              header: { borderBottom: 'none', color: COLORS.textPrimary, padding: '8px 16px', minHeight: 36 },
              body: { color: COLORS.textPrimary },
            }}
          >
            {activeKey === 'recording'
              ? <RecordingPanel ref={recordingRef} values={settings.recording} />
              : <TranscodePanel ref={transcodeRef} values={settings.transcode} />}
          </Card>
        </main>
      </div>

      {/* 底部按钮栏 —— OBS 风格：全宽底栏，按钮靠右 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 8,
          padding: '12px 4px 12px 0',
          flexShrink: 0,
        }}
      >
        <Button variant="default" onClick={handleCancel}>
          取消
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          保存
        </Button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  if (!window.electronBridge) {
    return (
      <ConfigProvider
        theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: COLORS.primary } }}
      >
        <Result
          status="warning"
          title="设置页仅在 CoWatch 桌面端可用"
          subTitle="请通过应用菜单栏的“设置”入口打开此页面。"
        />
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider
      theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: COLORS.primary } }}
    >
      <App>
        <SettingsContent />
      </App>
    </ConfigProvider>
  );
}
