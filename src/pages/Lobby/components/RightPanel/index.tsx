import { useState } from 'react';
import { CaretLeftOutlined, CaretRightOutlined } from '@ant-design/icons';
import ControlPanel from '../../ControlPanel';
import type { CursorSettingsProps } from '../../ControlPanel';
import type { Member } from '@/types/room';
import styles from './index.module.scss';

interface RightPanelProps {
    members: Member[];
    controllerId: string | null;
    currentUserId: string;
    isAdmin: boolean;
    onTransferControl: (targetUserId: string) => void;
    isController: boolean;
    followMode: boolean;
    onFollowModeToggle: () => void;
    onForceSync: () => void;
    cursorSettings: CursorSettingsProps;
}

export default function RightPanel({
    members,
    controllerId,
    currentUserId,
    isAdmin,
    onTransferControl,
    isController,
    followMode,
    onFollowModeToggle,
    onForceSync,
    cursorSettings,
}: RightPanelProps) {
    const [collapsed, setCollapsed] = useState(false);

    return (
        <aside className={`${styles.panel} ${collapsed ? styles.panelCollapsed : ''}`}>
            {/* 折叠/展开按钮：始终可见，贴在面板左侧边缘 */}
            <button
                type="button"
                className={styles.panelToggleBtn}
                onClick={() => setCollapsed((v) => !v)}
                title={collapsed ? '展开面板' : '收起面板'}
            >
                {collapsed ? <CaretLeftOutlined /> : <CaretRightOutlined />}
            </button>
            <div className={`${styles.panelContent} ${collapsed ? styles.panelContentHidden : ''}`}>
                <ControlPanel
                    members={members}
                    controllerId={controllerId}
                    currentUserId={currentUserId}
                    isAdmin={isAdmin}
                    onTransferControl={onTransferControl}
                    isController={isController}
                    followMode={followMode}
                    onFollowModeToggle={onFollowModeToggle}
                    onForceSync={onForceSync}
                    cursorSettings={cursorSettings}
                />
            </div>
        </aside>
    );
}
