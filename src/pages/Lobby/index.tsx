import { useRef, useEffect, useState, type MutableRefObject } from 'react';
import { useMemoizedFn } from 'ahooks';
import { useParams } from 'react-router-dom';
import { useUser } from '@/context/UserContext';
import { getAccessToken } from '@/utils/token';
import { useRoom } from '@/context/RoomContext';
import { useRoomWs } from '@/hooks/useRoomWs';
import { useSyncedState } from '@/hooks/useSyncedState';
import { getRoomInfoApi, getVideosApi, getTagsApi, renameVideoApi, deleteVideoApi, updateVideoLabelsApi } from '@/api/room';
import type { Tag, CursorMoveDownData, DrawStrokeData, RoomStateData, ChatMessageData } from '@/types/room';
import LoadingSpinner from '@/components/LoadingSpinner';
import CollapseSection from '@/components/CollapseSection';
import VideoPlayer, { type VideoPlayerHandle } from './VideoPlayer';
import ControlPanel from './ControlPanel';
import VideoUploader from './VideoUploader';
import VideoList from './VideoList';
import VideoTagBar from './VideoTagBar';
import PainterLayer, {
    type CursorState,
    type PainterLayerHandle,
    type StrokeRecord,
} from './PainterLayer';
import { DEFAULT_STYLE_ID } from './cursorStyles';
import NotePanel from './NotePanel';
import { CaretLeftOutlined, CaretRightOutlined } from '@ant-design/icons';
import styles from './index.module.scss';

/** 默认画笔颜色 */
const DEFAULT_DRAW_COLOR = '#ffffff';

/**
 * SYNC_PROGRESS 兜底纠偏阈值（秒）。
 *
 * SYNC_PROGRESS 是主控的实时进度广播，非主控收到后的处理原则：
 *   - 偏差在阈值内：不 seek，各自自然播放即可
 *   - 偏差超出阈值：说明发生了严重失步，才执行兜底 seek 纠偏
 *
 * 阈值设为 0.5s：精确对齐主控进度，网络延迟通常远小于此值。
 * 之前临时调到 3s 是为了掩盖"非主控根本没起播、一直在 seek"的问题，
 * 现在根本原因（sync 保护窗口吞掉 play 事件）已修复，恢复 0.5s。
 */
const SYNC_PROGRESS_THRESHOLD_SEC = 0.5;


export default function RoomPage() {
    const { roomId } = useParams<{ roomId: string }>();
    const { userInfo } = useUser();
    const { roomState, initRoom, setActiveVideoUrl } = useRoom();
    /**
     * 当前激活视频的 objectKey（与签名 URL 无关的稳定标识）
     * 用于 VideoList 高亮当前播放项，以及切换视频时发送 SWITCH_VIDEO WS 消息
     */
    const [activeObjectKey, activeObjectKeyRef, setActiveObjectKey] = useSyncedState<string | null>(null);

    /**
     * 暂存 ROOM_STATE 下发的播放初始化参数。
     * ROOM_STATE（WS）和 HTTP 初始化是并行的异步路径，VideoPlayer 挂载时机不确定；
     * 用 ref 暂存，在 VideoPlayer 挂载时（callback ref 触发）立即消费。
     */
    const pendingInitRef = useRef<{ isPlaying: boolean; currentTime: number } | null>(null);
    const videoRef = useRef<VideoPlayerHandle>(null);

    // ── 右侧面板折叠状态 ──────────────────────────────────────────────────────
    const [panelCollapsed, setPanelCollapsed] = useState(false);

    // ── Tag 状态 ───────────────────────────────────────────────────────────────
    const [tags, setTags] = useState<Tag[]>([]);
    const [duration, setDuration] = useState(0);
    /**
     * 当前激活视频的 id（用于 tag 归属，与 activeVideoUrl 对应）。
     * 同时作为"是否已完成本地初始化"的标志：
     *   - 空字符串 → 初始状态，ROOM_STATE 下发时会通过 handleRoomState 初始化
     *   - 非空 → 已由本地点击或远端广播设置
     */
    const [activeVideoId, activeVideoIdRef, setActiveVideoId] = useSyncedState<string>('');

    /**
     * 最近一次收到 VIDEO_ADDED 的 videoId（uuid，每次唯一）。
     * 传给 VideoUploader 作为 lastVideoAddedId prop，以此触发状态重置。
     * undefined 为初始值（不触发）；空字符串表示后端写入异常。
     */
    const [lastVideoAddedId, setLastVideoAddedId] = useState<string | undefined>(undefined);

    // ── 鼠标共享状态 ────────────────────────────────────────────────────────────
    /** 是否开启鼠标共享（是否发送自己的位置） */
    const [cursorEnabled, setCursorEnabled] = useState(false);
    /** 当前选中的光标样式 ID */
    const [selectedStyleId, setSelectedStyleId] = useState(DEFAULT_STYLE_ID);
    /**
     * 是否已激活虚拟光标样式（用户主动点击了某个样式，隐藏系统光标，本地渲染 canvas 虚拟光标）。
     * 独立于 cursorEnabled（WS 广播）和 drawingMode（绘制）。
     */
    const [cursorStyleActive, setCursorStyleActive] = useState(false);
    /**
     * 是否处于绘制模式。独立于鼠标共享（cursorEnabled），两者互不依赖。
     * - false（默认）：视频播放器可正常操作
     * - true：在视频区按住左键拖动发送笔迹 WS，同时拦截 click 防止触发播放
     */
    const [drawingMode, setDrawingMode] = useState(false);
    /** 当前画笔颜色 */
    const [drawColor, setDrawColor] = useState(DEFAULT_DRAW_COLOR);
    /** 共享笔记内容（由 WS 同步） */
    const [noteContent, setNoteContent] = useState('');
    /** 房间聊天消息列表（由 WS 广播维护，不落库） */
    const [chatMessages, setChatMessages] = useState<ChatMessageData[]>([]);
    /** 节流发送 NOTE_UPDATE 的定时器 ref */
    const noteThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /**
     * 所有光标的状态 Map（含自己 + 远端）。
     * key：userId（自己用 userInfo.userId）。
     * 直接操作 Map 引用（不 setState）+ 调 painterRef.redraw() 触发 canvas 重绘，
     * 避免每帧 mousemove 都触发 React re-render。
     */
    const cursorsRef = useRef<Map<string, CursorState>>(new Map());
  /** PainterLayer 命令式句柄，用于主动触发重绘 */
  const painterRef = useRef<PainterLayerHandle>(null);
  /**
   * 暂存 ROOM_STATE 下发的历史笔迹。
   * WS 比 PainterLayer 挂载早到，painterRef.current 此时为 null，
   * 先存入此 ref，等 PainterLayer callback ref 触发时再消费。
   */
  const pendingStrokesRef = useRef<Array<{ color: string; points: Array<{ x: number; y: number }> }> | null>(null);

    /** 节流版 sendMessage，避免每帧都创建新函数；用 ref 包装避免闭包捕获旧引用 */
    const sendMessageRef = useRef<ReturnType<typeof useRoomWs>['sendMessage'] | null>(null);

    /**
     * Callback ref：VideoPlayer 每次挂载时触发，消费暂存的初始化参数。
     * 比 useEffect([activeVideoUrl]) 更可靠，因为它直接响应组件挂载事件。
     */
    const setVideoRef = useMemoizedFn((handle: VideoPlayerHandle | null) => {
        (videoRef as MutableRefObject<VideoPlayerHandle | null>).current = handle;
        if (handle && pendingInitRef.current) {
            const { isPlaying, currentTime } = pendingInitRef.current;
            pendingInitRef.current = null;
            // rAF 确保 video 元素完成首次渲染后再操作
            requestAnimationFrame(() => {
                handle.initPlayback(isPlaying, currentTime);
            });
        }
    });


    // 初始化房间状态 + 视频列表
    useEffect(() => {
        if (!roomId) return;
        Promise.all([
            getRoomInfoApi(roomId),
            getVideosApi(roomId),
        ]).then(([info, videosData]) => {
            // listVideos 返回 objectKey，播放 URL 由 WS ROOM_STATE / SWITCH_VIDEO 下发
            const videos = videosData.videos.map((v) => ({
                id: v.id,
                objectKey: v.objectKey,
                videoUrl: null as string | null,
                fileName: v.fileName,
                displayName: v.displayName ?? null,
                uploaderId: v.uploaderId,
                createdAt: v.createdAt,
                labels: v.labels ?? [],
            }));
            initRoom({
                roomId: info.roomId,
                roomName: info.roomName,
                // activeVideoUrl 不由 HTTP 初始化（接口不返回播放 URL），完全由 WS 管理
                videos,
                members: info.members,
                controlMode: info.controlMode,
                controllerId: info.controllerId,
            });
        });
    }, [roomId]);

    // ── 拉取 tag 列表工具函数 ───────────────────────────────────────────────────
    const fetchTags = useMemoizedFn((videoId: string) => {
        if (!roomId || !videoId) return;
        getTagsApi(roomId, videoId).then(setTags).catch((err) => {
            console.warn('[Tag] 拉取 tag 列表失败:', err);
        });
    });

    // ── 复盘模式（跟随复盘开关） ────────────────────────────────────────────────
    /**
     * 非主控专属状态：是否追随主控的播放操作。
     *   true（默认）：响应 SYNC_STATE / SYNC_PROGRESS / SWITCH_VIDEO
     *   false：自由查看模式，静默忽略上述消息
     */
    const [followMode, followModeRef, setFollowMode] = useSyncedState(true);
    /**
     * 非主控切换跟随开关：
     *   false → true：发送 FORCE_SYNC，单播回当前完整状态，立即对齐
     *   true → false：仅更新本地开关，进入自由模式
     */
    const handleFollowModeToggle = useMemoizedFn(() => {
        const next = !followModeRef.current;
        setFollowMode(next);
        if (next) {
            // 开启跟随：发送 FORCE_SYNC 让后端单播回当前状态
            sendMessageRef.current?.('FORCE_SYNC', {});
        } else {
            // 切到自由模式：重置所有鼠标相关状态
            // 自由模式本意是脱离共享，不应继续影响他人画布/光标
            setCursorEnabled(false);
            setCursorStyleActive(false);
            setSelectedStyleId(DEFAULT_STYLE_ID);
            setDrawingMode(false);
            // 清空自己的光标 Map 条目并重绘（不再广播，本地也不显示）
            const uid = userInfo?.userId ?? '__self__';
            cursorsRef.current.delete(uid);
            painterRef.current?.redraw();
        }
    });
    /** 主控一键拉回：发送 FORCE_SYNC，后端广播完整状态给所有非主控 */
    const handleForceSync = useMemoizedFn(() => {
        sendMessageRef.current?.('FORCE_SYNC', {});
    });

    /**
     * 收到 CONTROL_CHANGED：控制权发生转移。
     * 若自己从主控变为非主控，重置 followMode 为 false（自由模式）。
     * 理由：转移控制权是管理员的主动行为，原主控无需立即跟随新主控，
     * 应默认进入自由状态，由用户自行决定是否开启跟随。
     */
    const handleControlChanged = useMemoizedFn((newControllerId: string) => {
        const myUserId = userInfo?.userId;
        if (!myUserId) return;

        if (newControllerId === myUserId) {
            // 自己成为新主控：将当前正在播放的视频同步给后端，更新 room.video_url。
            // 场景：自己处于自由模式播放了与旧主控不同的视频，
            // 若不同步，其他成员点击跟随时帎端会单播回旧的 room.video_url。
            const currentObjectKey = activeObjectKeyRef.current;
            const currentVideoId = activeVideoIdRef.current;
            if (currentObjectKey && currentVideoId) {
                sendMessageRef.current?.('SWITCH_VIDEO', { objectKey: currentObjectKey, videoId: currentVideoId });
            }
        } else {
            // 自己从主控变为非主控：重置为自由模式，由用户自行决定是否开启跟随。
            // 即使之前不是主控，决置为 false 也没有副作用（followMode 对主控无意义）。
            setFollowMode(false);
        }
    });

    /**
     * 收到 ROOM_STATE：保存播放初始化参数，等 VideoPlayer 就绪后执行。
     * activeVideoId 由后端直接下发，无需前端在本地视频列表中做 objectKey→videoId 匹配。
     */
    const handleRoomState = useMemoizedFn((d: RoomStateData) => {
        const { isPlaying, currentTime, activeObjectKey, activeVideoId, strokes, noteContent, forceSynced } = d;

        if (videoRef.current) {
            videoRef.current.initPlayback(isPlaying ?? false, currentTime ?? 0);
        } else {
            pendingInitRef.current = { isPlaying: isPlaying ?? false, currentTime: currentTime ?? 0 };
        }
        if (activeObjectKey) {
            setActiveObjectKey(activeObjectKey);
        }
        // 后端直接下发 activeVideoId，无需查本地 videosRef，与 HTTP 是否完成无关
        if (activeVideoId) {
            setActiveVideoId(activeVideoId);
            fetchTags(activeVideoId);
        }
        // 恢复历史笔迹：如果 PainterLayer 已挂载则直接应用，否则暂存到 ref 等待挂载
        if (strokes?.length) {
            if (painterRef.current) {
                painterRef.current.clearStrokes();
                strokes.forEach((s: { color: string; points: Array<{ x: number; y: number }> }) => painterRef.current?.addStroke(s));
            } else {
                pendingStrokesRef.current = strokes;
            }
        }
        // 初始化共享笔记
        if (noteContent !== undefined) {
            setNoteContent(noteContent);
        }
        // 初始化聊天历史消息（新成员加入时由服务端下发最近 50 条）
        if (d.chatMessages?.length) {
            setChatMessages(d.chatMessages);
        }
        // 主控一键拉回触发的强制同步：重置 followMode 开关为 true
        if (forceSynced) {
            setFollowMode(true);
        }
    });

    /**
     * 收到 SYNC_PROGRESS：仅在严重失步时才兜底 seek，正常播放不干预。
     * 自由模式（followMode=false）时静默忽略。
     */
    const handleSyncProgress = useMemoizedFn((currentTime: number) => {
        if (!followModeRef.current) return;
        const handle = videoRef.current;
        if (!handle) return;
        if (Math.abs(handle.getCurrentTime() - currentTime) >= SYNC_PROGRESS_THRESHOLD_SEC) {
            handle.syncSeek(currentTime);
        }
    });

    /**
     * 收到 SYNC_STATE（播放/暂停 + 时间）：全员同步执行。
     *
     * SYNC_STATE 触发时机：主控按下播放键、暂停键、或 Tag 跳转。
     * 这类操作需要精确的状态对齐，阈值设 0.5s：
     *   - isPlaying=true 且偏差 < 0.5s → 只 play，不 seek（缓冲区完整，避免打断）
     *   - isPlaying=true 且偏差 >= 0.5s → seek + play（追上主控进度）
     *   - isPlaying=false → 始终 seek + pause（暂停必须精确对帧）
     */
    const SYNC_STATE_SEEK_THRESHOLD_SEC = 0.5;
    /**
     * 收到 SYNC_STATE：seq 由后端分配，直接传给 VideoPlayer。
     * VideoPlayer 内部用 seq 大小判断异步回调（onSeeked）是否过期。
     */
    const handleSyncState = useMemoizedFn((isPlaying: boolean, currentTime: number, seq: number) => {
        if (!followModeRef.current) return;
        const handle = videoRef.current;
        if (!handle) return;
        if (isPlaying) {
            const diff = Math.abs(handle.getCurrentTime() - currentTime);
            if (diff < SYNC_STATE_SEEK_THRESHOLD_SEC) {
                handle.syncPlay(seq);
            } else {
                handle.syncSeekAndPlay(currentTime, seq);
            }
        } else {
            handle.syncSeekAndPause(currentTime, seq);
        }
    });

    const handleTagAdded = useMemoizedFn((tag: Tag) => {
        setTags((prev) => {
            if (prev.some((t) => t.id === tag.id)) return prev;
            return [...prev, tag].sort((a, b) => a.time - b.time);
        });
    });

    const handleTagDeleted = useMemoizedFn((id: string) => {
        setTags((prev) => prev.filter((t) => t.id !== id));
    });

    /**
     * 收到远端 SWITCH_VIDEO 广播：同步 activeObjectKey / activeVideoId 并拉取 tags。
     *
     * 职责分支：
     *   1. 主控自身广播（objectKey 与当前一致）：仅更新 videoUrl（后端签名），跳过元数据
     *   2. 非主控 · 跟随模式：更新所有状态，完整同步
     *   3. 非主控 · 自由模式：忽略，不响应
     */
    const handleSwitchVideo = useMemoizedFn((objectKey: string, videoId: string | undefined, videoUrl: string) => {
        // 场景 1：主控收到自己发出的广播（objectKey 与当前一致）
        // 仅需更新签名后的 videoUrl，元数据（activeObjectKey/tags 等）已在本地点击时处理
        if (objectKey === activeObjectKeyRef.current) {
            setActiveVideoUrl(videoUrl);
            return;
        }
        // 场景 3：非主控处于自由模式，静默忽略
        if (!followModeRef.current) return;
        // 场景 2：非主控跟随模式，完整同步
        setActiveVideoUrl(videoUrl);
        setActiveObjectKey(objectKey);
        setTags([]);
        setDuration(0);
        if (videoId) {
            setActiveVideoId(videoId);
            fetchTags(videoId);
        }
    });

    // ── 鼠标共享 handlers ────────────────────────────────────────────────────────

    const handleCursorToggle = useMemoizedFn(() => {
        setCursorEnabled((prev) => {
            const next = !prev;
            // 关闭时清空所有光标并重绘
            if (!next) {
                cursorsRef.current.clear();
                painterRef.current?.redraw();
            }
            return next;
        });
    });

    /**
     * 点击光标样式时切换激活状态：
     *   - 点击当前未激活时 → 激活，同时更换样式
     *   - 点击已激活的样式 → 反选，取消虚拟光标（恢复系统默认光标）
     * 即：首次点任意样式 = 切换样式 + 开起虚拟光标；再点同一个 = 关闭虚拟光标。
     */
    const handleCursorStyleSelect = useMemoizedFn((styleId: string) => {
        if (styleId === 'default') {
            // 点击「默认」项：关闭虚拟光标，恢复系统光标
            setCursorStyleActive(false);
            setSelectedStyleId('default');
            const uid = userInfo?.userId ?? '__self__';
            cursorsRef.current.delete(uid);
            painterRef.current?.redraw();
        } else {
            // 点击自定义样式：激活虚拟光标 + 切换样式
            setSelectedStyleId(styleId);
            setCursorStyleActive(true);
        }
    });

    const handleDrawingModeToggle = useMemoizedFn(() => {
        setDrawingMode((prev) => !prev);
    });

    /**
     * 本地绘制完一笔（mouseup）后回调：通过 WS 广播给其他成员。
     * userId 由服务端用连接时鉴权的 userId 覆盖，上行不需要传。
     */
    const handleStrokeComplete = useMemoizedFn((stroke: StrokeRecord) => {
        sendMessageRef.current?.('DRAW_STROKE', {
            color: stroke.color,
            points: stroke.points,
        });
    });

    /**
     * 用户点击「清空画布」时回调：本地清空 + WS 广播。
     * userId 由服务端用连接时鉴权的 userId 覆盖，上行不需要传。
     */
    const handleClearStrokes = useMemoizedFn(() => {
        painterRef.current?.clearStrokes();
        sendMessageRef.current?.('DRAW_CLEAR', {});
    });

    /**
     * 收到远端 DRAW_STROKE：将笔迹添加到 PainterLayer。
     */
    const handleDrawStroke = useMemoizedFn((data: DrawStrokeData) => {
        painterRef.current?.addStroke({ color: data.color, points: data.points });
    });

    /**
     * 收到远端 DRAW_CLEAR：清空画布。
     */
    const handleDrawClear = useMemoizedFn(() => {
        painterRef.current?.clearStrokes();
    });

    /**
     * 收到远端 DRAW_CLEAR_COLOR：清除指定颜色笔迹。
     */
    const handleDrawClearColor = useMemoizedFn((color: string) => {
        painterRef.current?.clearStrokesByColor(color);
    });

    /**
     * 用户点击「清除此色」：本地过滤 + WS 广播。
     */
    const handleClearStrokesByColor = useMemoizedFn((color: string) => {
        painterRef.current?.clearStrokesByColor(color);
        sendMessageRef.current?.('DRAW_CLEAR_COLOR', { color });
    });

    /**
     * 收到远端 CURSOR_MOVE 广播：更新 cursors Map，触发 canvas 重绘。
     * 不走 setState，避免 React re-render 影响帧率。
     */
    const handleCursorMove = useMemoizedFn((data: CursorMoveDownData) => {
        cursorsRef.current.set(data.userId, {
            userId: data.userId,
            x: data.x,
            y: data.y,
            styleId: data.styleId,
        });
        painterRef.current?.redraw();
    });

    /** 收到远端 CURSOR_HIDE 广播（或本地鼠标离开区域）：立即从 Map 移除并重绘。 */
    const handleCursorHide = useMemoizedFn((userId: string) => {
        cursorsRef.current.delete(userId);
        painterRef.current?.redraw();
    });

    /**
     * PainterLayer 回调：鼠标在 .main 内移动。
     * 更新自己的光标位置（立即可见），并节流发送给他人。
     * useMemoizedFn 始终读取最新的 cursorEnabled/selectedStyleId，无需依赖数组。
     */
    const handleSelfCursorMove = useMemoizedFn((x: number, y: number) => {
        const uid = userInfo?.userId;
        if (!uid) return;

        // 更新自己的光标（不走 setState，直接写 ref，避免 re-render）
        const existing = cursorsRef.current.get(uid);
        if (existing) {
            cursorsRef.current.set(uid, { ...existing, x, y });
        } else if (cursorStyleActive) {
            // enter 时没有已有条目（首次进入或淡出动画已 delete），在真实坐标处插入
            cursorsRef.current.set(uid, {
                userId: uid,
                x,
                y,
                styleId: selectedStyleId,
            });
        }
        painterRef.current?.redraw();

        // 节流发送给他人
        if (cursorEnabled) {
            sendMessageRef.current?.('CURSOR_MOVE', { x, y, styleId: selectedStyleId });
        }
    });

    /**
     * PainterLayer 回调：鼠标离开 .main。
     * 淡出自己的光标，并通知他人隐藏。
     */
    const handleSelfCursorLeave = useMemoizedFn(() => {
        const uid = userInfo?.userId ?? '__self__';
        handleCursorHide(uid);
        if (cursorEnabled) {
            sendMessageRef.current?.('CURSOR_HIDE', {});
        }
    });

    // 当 selectedStyleId 变化时，同步更新自己的光标 styleId
    useEffect(() => {
        const uid = userInfo?.userId;
        if (!uid) return;
        const existing = cursorsRef.current.get(uid);
        if (existing) {
            cursorsRef.current.set(uid, { ...existing, styleId: selectedStyleId });
            painterRef.current?.redraw();
        }
    }, [selectedStyleId, userInfo?.userId]);

    const { sendMessage } = useRoomWs({
        roomId: roomId!,
        token: getAccessToken() ?? '',
        onRoomState: handleRoomState,
        onSyncProgress: handleSyncProgress,
        onSyncState: handleSyncState,
        onTagAdded: handleTagAdded,
        onTagDeleted: handleTagDeleted,
        onSwitchVideo: handleSwitchVideo,
        onControlChanged: handleControlChanged,
        onVideoAdded: (videoId) => setLastVideoAddedId(videoId),
onVideoDeleted: (deletedVideoId) => {
    // 删除的是当前激活视频：重置播放器和相关状态
    if (deletedVideoId === activeVideoId) {
        setActiveObjectKey(null);
        setActiveVideoId('');
        setTags([]);
        setDuration(0);
        setActiveVideoUrl('');
    }
},
        onCursorMove: handleCursorMove,
        onCursorHide: handleCursorHide,
        onDrawStroke: handleDrawStroke,
        onDrawClear: handleDrawClear,
        onDrawClearColor: handleDrawClearColor,
        onNoteUpdate: (content) => setNoteContent(content),
        onChatMessage: (msg) => setChatMessages((prev) => [...prev, msg]),
    });

    // 将最新 sendMessage 同步到 ref，供节流函数闭包读取
    sendMessageRef.current = sendMessage;

    /**
     * 主控在笔记输入时触发：本地立即更新 noteContent，
     * 然后节流 1000ms 广播给其他成员。
     */
    const handleNoteChange = useMemoizedFn((content: string) => {
        setNoteContent(content);
        if (noteThrottleRef.current) clearTimeout(noteThrottleRef.current);
        noteThrottleRef.current = setTimeout(() => {
            sendMessageRef.current?.('NOTE_UPDATE', { content });
        }, 1000);
    });

    /**
     * 居民发送聊天消息：通过 WS 向后端发送 CHAT_MESSAGE，
     * 后端补充 userId/nickname/timestamp 后广播给所有成员（含自身）。
     */
    const handleSendChat = useMemoizedFn((content: string) => {
        sendMessageRef.current?.('CHAT_MESSAGE', { content });
    });

    /**
     * 本地点击"播放"：向后端发送 SWITCH_VIDEO（携带 objectKey）。
     * 后端签名后广播带 videoUrl 的 SWITCH_VIDEO 下行消息，
     * useRoomWs 收到后调用 setActiveVideoUrl 更新播放 URL。
     * 本地优先设置 activeObjectKey （列表立即高亮）， activeVideoId（tag 归属）。
     */
    const handleDeleteVideo = useMemoizedFn(async (videoId: string) => {
        if (!roomId) return;
        try {
            await deleteVideoApi(roomId, videoId);
            // HTTP 成功后，后端广播 VIDEO_DELETED，useRoomWs 自动调用 removeVideo 更新 Context
        } catch (err) {
            console.error('[delete] 视频删除失败:', err);
        }
    });

    const handleUpdateLabels = useMemoizedFn(async (videoId: string, labels: string[]) => {
        if (!roomId) return;
        try {
            await updateVideoLabelsApi(roomId, videoId, labels);
            // HTTP 成功后，后端广播 VIDEO_LABELS_UPDATED，useRoomWs 自动调用 updateVideoLabels 更新 Context
        } catch (err) {
            console.error('[labels] 视频 label 更新失败:', err);
        }
    });

    const handleRenameVideo = useMemoizedFn(async (videoId: string, displayName: string) => {
        if (!roomId) return;
        try {
            await renameVideoApi(roomId, videoId, displayName);
            // HTTP 成功后，后端会广播 VIDEO_RENAMED，useRoomWs 自动调用 renameVideo 更新 Context
            // 改名者自身也会收到广播，无需本地额外更新
        } catch (err) {
            console.error('[rename] 视频改名失败:', err);
        }
    });

    const handlePlayVideo = useMemoizedFn((objectKey: string, videoId: string) => {
        setActiveObjectKey(objectKey);
        setActiveVideoId(videoId);
        setTags([]);
        setDuration(0);
        if (!followModeRef.current && !isController) {
            // 自由模式下非主控切换视频：本地拼接 m3u8 路径，不广播 WS
            const localUrl = `/api/rooms/${roomId}/videos/${videoId}/m3u8`;
            setActiveVideoUrl(localUrl);
        } else {
            // 主控（或非主控追随模式下点播放）：发 WS 让后端广播并返回签名 URL
            sendMessage('SWITCH_VIDEO', { objectKey, videoId });
        }
        fetchTags(videoId);
    });

    // ── Tag 操作（发送 WS 消息） ─────────────────────────────────────────────────

    const handleTagAdd = useMemoizedFn((_videoId: string, time: number, label: string) => {
        const id = crypto.randomUUID();
        sendMessage('TAG_ADD', { id, videoId: activeVideoId, time, label });
    });

    const handleTagDelete = useMemoizedFn((id: string) => {
        sendMessage('TAG_DELETE', { id });
    });

    const handleTagSeek = useMemoizedFn((time: number) => {
        // 主控本地即时 seek+pause，不依赖 WS 回环。
        // seq 传 0：主控本地调用只影响自己的视频状态，不参与非主控的 seq 过期判断。
        // 非主控收到的 seq 来自后端（TAG_SEEK → 后端分配 nextSeq 广播 SYNC_STATE），
        // 与这里的 0 完全独立。
        videoRef.current?.syncSeekAndPause(time, 0);
        sendMessage('TAG_SEEK', { time });
    });

    if (!roomState) {
        return <LoadingSpinner fullPage text="加载房间..." />;
    }

    const isAdmin = roomState.members.find((m) => m.userId === userInfo?.userId)?.isAdmin ?? false;
    const isController = roomState.controllerId === userInfo?.userId;

    return (
        <div className={styles.page}>
            <div className={styles.content}>
                {/* 左侧主内容区 */}
                <main className={styles.main}>
                    {/* 视频列表 */}
                     <CollapseSection
                        title="视频列表"
                        collapsible
                        defaultOpen={false}
                    >
                        <VideoList
                            videos={roomState.videos}
                            activeObjectKey={activeObjectKey}
                            isController={isController}
                            canPlayInFreeMode={!isController && !followMode}
                            onPlay={handlePlayVideo}
                            currentUserId={userInfo?.userId ?? ''}
                            isAdmin={isAdmin}
                            onRename={handleRenameVideo}
                            onDelete={handleDeleteVideo}
                            onUpdateLabels={handleUpdateLabels}
                        />
                    </CollapseSection>
                    {/* 上传区（全员可见可操作） */}
                    <CollapseSection title="上传视频" collapsible defaultOpen={false}>
                        <VideoUploader
                            roomId={roomId!}
                            lastVideoAddedId={lastVideoAddedId}
                        />
                    </CollapseSection>
                    {/*
           * .playerRatio 是 16:9 固定比例容器，是所有客户端视觉内容完全一致的区域。
           * PainterLayer 锚定在此容器内：
           * - 坐标比例 = 相对 .playerRatio 宽高，不受窗口高度/折叠区域影响
           * - 出了视频区鼠标自动恢复默认样式，tag区/上传区不受影响
           */}
                    <div className={styles.playerRatio}>
            {/* 自由模式下非主控不渲染画布：避免显示其他人的笔迹/鼠标（与当前自选视频无关） */}
            {(isController || followMode) && (
              <PainterLayer
                ref={(handle) => {
                  (painterRef as MutableRefObject<PainterLayerHandle | null>).current = handle;
                  if (handle && pendingStrokesRef.current) {
                    const pending = pendingStrokesRef.current;
                    pendingStrokesRef.current = null;
                    handle.clearStrokes();
                    pending.forEach((s) => handle.addStroke(s));
                  }
                }}
                cursorStyleActive={cursorStyleActive}
                enabled={cursorEnabled}
                drawingMode={drawingMode}
                cursors={cursorsRef.current}
                drawColor={drawColor}
                onCursorMove={handleSelfCursorMove}
                // 不需要在 mouseenter 时做任何事：光标由 handleSelfCursorMove 在首次 mousemove 时插入
                onCursorEnter={() => { /* no-op */ }}
                onCursorLeave={handleSelfCursorLeave}
                onStrokeComplete={handleStrokeComplete}
              />
            )}
                        {roomState.activeVideoUrl ? (
                            <VideoPlayer
                                ref={setVideoRef}
                                src={roomState.activeVideoUrl}
                                disabled={
                                    // 非主控跟随模式：禁用（观看）
                                    // 主控绘制模式：禁用（防止绘制点击穿透触发播放/暂停）
                                    // 其余情况（主控正常模式 / 非主控自由模式）均可操作
                                    (!isController && followMode) || (isController && drawingMode)
                                }
                                onProgressChange={(currentTime) => {
                                    // 只有主控才广播进度（非主控自由模式操作不对外同步）
                                    if (isController) sendMessage('SYNC_PROGRESS', { currentTime });
                                }}
                                onPlayStateChange={(isPlaying, currentTime) => {
                                    // 只有主控才广播播放状态
                                    if (isController) sendMessage('SYNC_STATE', { isPlaying, currentTime });
                                }}
                                onDurationChange={setDuration}
                            />
                        ) : (
                            <div className={styles.noVideo}>
                                <span className={styles.noVideoIcon}>🎬</span>
                                <p>从下方选择或上传视频开始复盘</p>
                            </div>
                        )}
                    </div>

                    {/* 时间标记（有激活视频时显示） */}
                    {roomState.activeVideoUrl && (
                        <CollapseSection
                            title="时间标记"
                            collapsible
                        >
                            <VideoTagBar
                                tags={tags}
                                duration={duration}
                                isController={isController}
                                activeVideoId={activeVideoId}
                                onAdd={handleTagAdd}
                                onDelete={handleTagDelete}
                                onSeek={handleTagSeek}
                            />
                        </CollapseSection>
                    )}

                </main>

                {/* 右侧控制面板 */}
                <aside className={`${styles.panel} ${panelCollapsed ? styles.panelCollapsed : ''}`}>
                    {/* 折叠/展开按钮：始终可见，贴在面板左侧边缘 */}
                    <button
                        type="button"
                        className={styles.panelToggleBtn}
                        onClick={() => setPanelCollapsed((v) => !v)}
                        title={panelCollapsed ? '展开面板' : '收起面板'}
                    >
                        {panelCollapsed ? <CaretLeftOutlined /> : <CaretRightOutlined />}
                    </button>
                    <div className={`${styles.panelContent} ${panelCollapsed ? styles.panelContentHidden : ''}`}>
                    <ControlPanel
                        roomId={roomState.roomId}
                        roomName={roomState.roomName}
                        members={roomState.members}
                        controllerId={roomState.controllerId}
                        currentUserId={userInfo?.userId ?? ''}
                        isAdmin={isAdmin}
                        onTransferControl={(targetUserId) => {
                            sendMessage('TRANSFER_CONTROL', { targetUserId });
                        }}
                        isController={isController}
                        followMode={followMode}
                        onFollowModeToggle={handleFollowModeToggle}
                        onForceSync={handleForceSync}
                        cursorSettings={{
                            disabled: !isController && !followMode,
                            cursorEnabled,
                            selectedStyleId,
                            cursorStyleActive,
                            drawingMode,
                            drawColor,
                            onCursorToggle: handleCursorToggle,
                            onCursorStyleSelect: handleCursorStyleSelect,
                            onDrawingModeToggle: handleDrawingModeToggle,
                            onDrawColorChange: setDrawColor,
                            onClearStrokes: handleClearStrokes,
                            onClearStrokesByColor: handleClearStrokesByColor,
                        }}
                    />
                    </div>
                </aside>
            </div>

            {/* 共享笔记 + 聊天浮层：绝对定位在 .page 右上角， bar 下方 12px，右侧 20px */}
            <NotePanel
                content={noteContent}
                isController={isController}
                roomId={roomState.roomId}
                onChange={handleNoteChange}
                messages={chatMessages}
                currentUserId={userInfo?.userId ?? ''}
                onSendChat={handleSendChat}
            />
        </div>
    );
}
