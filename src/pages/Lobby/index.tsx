import { useRef, useEffect, useState, type MutableRefObject } from 'react';
import { useMemoizedFn } from 'ahooks';
import { useParams } from 'react-router-dom';
import { useUser } from '@/context/UserContext';
import { getAccessToken } from '@/utils/token';
import { useRoom } from '@/context/RoomContext';
import { useRoomWs } from '@/hooks/useRoomWs';
import { getRoomInfoApi, getVideosApi, getTagsApi } from '@/api/room';
import type { Tag } from '@/types/room';
import LoadingSpinner from '@/components/LoadingSpinner';
import VideoPlayer, { type VideoPlayerHandle } from './VideoPlayer';
import ControlPanel from './ControlPanel';
import VideoUploader from './VideoUploader';
import VideoList from './VideoList';
import VideoTagBar from './VideoTagBar';
import styles from './index.module.scss';

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
  const [activeObjectKey, setActiveObjectKey] = useState<string | null>(null);

  /**
   * 暂存 ROOM_STATE 下发的播放初始化参数。
   * ROOM_STATE（WS）和 HTTP 初始化是并行的异步路径，VideoPlayer 挂载时机不确定；
   * 用 ref 暂存，在 VideoPlayer 挂载时（callback ref 触发）立即消费。
   */
  const pendingInitRef = useRef<{ isPlaying: boolean; currentTime: number } | null>(null);
  /**
   * 暂存 ROOM_STATE 下发的 activeObjectKey。
   * WS 和 HTTP 是并行路径：若 ROOM_STATE 先到而视频列表未加载，
   * 此时 videosRef 为空，无法匹配 videoId 拉取 tags。
   * 在 HTTP 完成、videosRef 有数据后，消费此暂存值补发 fetchTags。
   */
  const pendingActiveObjectKeyRef = useRef<string | null>(null);
  const videoRef = useRef<VideoPlayerHandle>(null);
  /** 始终保持最新的 videos 列表，供 useMemoizedFn 回调内查询 videoId */
  const videosRef = useRef(roomState?.videos ?? []);

  // ── Tag 状态 ───────────────────────────────────────────────────────────────
  const [tags, setTags] = useState<Tag[]>([]);
  const [duration, setDuration] = useState(0);
  /**
   * 当前激活视频的 id（用于 tag 归属，与 activeVideoUrl 对应）。
   * 同时作为"是否已完成本地初始化"的标志：
   *   - 空字符串 → 初始状态，ROOM_STATE 下发时会通过 handleRoomState 初始化
   *   - 非空 → 已由本地点击或远端广播设置
   */
  const [activeVideoId, setActiveVideoId] = useState<string>('');

  /**
   * 最近一次收到 VIDEO_ADDED 的文件名。
   * 传给 VideoUploader 作为 lastVideoAddedName prop，
   * VideoUploader 内部对比 pendingFileName 判断是否为本次上传完成。
   */
  const [lastVideoAddedName, setLastVideoAddedName] = useState<string | undefined>(undefined);

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

  // 每次 roomState.videos 变化时同步 ref，供 useMemoizedFn 回调内读取
  videosRef.current = roomState?.videos ?? [];

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
        uploaderId: v.uploaderId,
        createdAt: v.createdAt,
      }));
      videosRef.current = videos;
      initRoom({
        roomId: info.roomId,
        roomName: info.roomName,
        activeVideoUrl: info.videoUrl,
        videos,
        members: info.members,
        controlMode: info.controlMode,
        controllerId: info.controllerId,
      });
      // 消费 WS 比 HTTP 先到时暂存的 activeObjectKey：
      // ROOM_STATE 到来时视频列表还未就绪，无法匹配 videoId；
      // 现在 videosRef 已有数据，补发 fetchTags。
      const pendingKey = pendingActiveObjectKeyRef.current;
      if (pendingKey) {
        pendingActiveObjectKeyRef.current = null;
        const matched = videos.find((v) => v.objectKey === pendingKey);
        if (matched) {
          setActiveVideoId(matched.id);
          fetchTags(matched.id);
        }
      }
    });
  }, [roomId]);

  // ── 拉取 tag 列表工具函数 ───────────────────────────────────────────────────
  const fetchTags = useMemoizedFn((videoId: string) => {
    if (!roomId || !videoId) return;
    getTagsApi(roomId, videoId).then(setTags).catch((err) => {
      console.warn('[Tag] 拉取 tag 列表失败:', err);
    });
  });

  /**
   * 收到 ROOM_STATE：保存播放初始化参数，等 VideoPlayer 就绪后执行。
   * 同时初始化当前激活视频的 tag 列表：
   *   - 服务端已在 ROOM_STATE 里附带 tags → 直接 setTags，无需 HTTP 拉取
   *   - 服务端未附带（旧数据兜底）→ 不拉取，等用户切换视频时再拉
   */
  const handleRoomState = useMemoizedFn((
    isPlaying: boolean,
    currentTime: number,
    roomTags?: Tag[],
    _videoUrl?: string | null,
    activeObjectKey?: string | null,
  ) => {
    if (videoRef.current) {
      videoRef.current.initPlayback(isPlaying, currentTime);
    } else {
      pendingInitRef.current = { isPlaying, currentTime };
    }
    // 用 activeObjectKey（稳定标识）匹配视频列表，找到 videoId 后拉取 tags。
    // 不用 videoUrl 匹配：videos 列表里的 videoUrl 均为 null（播放时按需签名），永远匹配不到。
    // 后端 ROOM_STATE 的 tags 字段始终为空数组，tags 由 fetchTags 按需拉取。
    if (activeObjectKey) {
      setActiveObjectKey(activeObjectKey);
      const matched = videosRef.current.find((v) => v.objectKey === activeObjectKey);
      if (matched) {
        setActiveVideoId(matched.id);
        fetchTags(matched.id);
      } else {
        // 视频列表尚未通过 HTTP 加载（WS 比 HTTP 先到），暂存 objectKey，
        // 等 HTTP 完成后在 initRoom 流程里消费。
        pendingActiveObjectKeyRef.current = activeObjectKey;
      }
    }
    if (roomTags?.length) {
      setTags(roomTags);
    }
  });

  /**
   * 收到 SYNC_PROGRESS：仅在严重失步时才兜底 seek，正常播放不干预。
   */
  const handleSyncProgress = useMemoizedFn((currentTime: number) => {
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
   * 主控本地点击（handlePlayVideo）已经主动处理了 tag 拉取，
   * 且在发送 SWITCH_VIDEO 前已设置 activeObjectKey/activeVideoId，
   * 因此主控收到自己的广播时，objectKey 和当前状态一致，不会重复触发。
   *
   * 非主控则通过此回调完成状态同步。
   */
  const handleSwitchVideo = useMemoizedFn((objectKey: string, videoId: string | undefined) => {
    if (objectKey === activeObjectKey) return; // 主控自身广播，忽略
    setActiveObjectKey(objectKey);
    setTags([]);
    setDuration(0);
    if (videoId) {
      setActiveVideoId(videoId);
      fetchTags(videoId);
    } else {
      // 兜底：后端未下发 videoId 时，从视频列表里用 objectKey 查找
      const matched = videosRef.current.find((v) => v.objectKey === objectKey);
      if (matched) {
        setActiveVideoId(matched.id);
        fetchTags(matched.id);
      }
    }
  });

  const { sendMessage } = useRoomWs({
    roomId: roomId!,
    token: getAccessToken() ?? '',
    onRoomState: handleRoomState,
    onSyncProgress: handleSyncProgress,
    onSyncState: handleSyncState,
    onTagAdded: handleTagAdded,
    onTagDeleted: handleTagDeleted,
    onSwitchVideo: handleSwitchVideo,
    onVideoAdded: (addedFileName) => setLastVideoAddedName(addedFileName),
  });

  /**
   * 本地点击"播放"：向后端发送 SWITCH_VIDEO（携带 objectKey）。
   * 后端签名后广播带 videoUrl 的 SWITCH_VIDEO 下行消息，
   * useRoomWs 收到后调用 setActiveVideoUrl 更新播放 URL。
   * 本地优先设置 activeObjectKey （列表立即高亮）， activeVideoId（tag 归属）。
   */
  const handlePlayVideo = useMemoizedFn((objectKey: string, videoId: string) => {
    setActiveObjectKey(objectKey);
    setActiveVideoId(videoId);
    setTags([]);
    setDuration(0);
    sendMessage('SWITCH_VIDEO', { objectKey, videoId });
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
          {/* 播放器区域 */}
          <div className={styles.playerArea}>
            <div className={styles.playerRatio}>
              {roomState.activeVideoUrl ? (
                <VideoPlayer
                  ref={setVideoRef}
                  src={roomState.activeVideoUrl}
                  disabled={!isController}
                  onProgressChange={(currentTime) => {
                    sendMessage('SYNC_PROGRESS', { currentTime });
                  }}
                  onPlayStateChange={(isPlaying, currentTime) => {
                    sendMessage('SYNC_STATE', { isPlaying, currentTime });
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
          </div>

          {/* Tag 时间轴区域（有激活视频时显示） */}
          {roomState.activeVideoUrl && (
            <VideoTagBar
              tags={tags}
              duration={duration}
              isController={isController}
              activeVideoId={activeVideoId}
              onAdd={handleTagAdd}
              onDelete={handleTagDelete}
              onSeek={handleTagSeek}
            />
          )}

          {/* 上传区（仅管理员可见） */}
          {isAdmin && (
            <div className={styles.uploaderSection}>
              <VideoUploader
                roomId={roomId!}
                lastVideoAddedName={lastVideoAddedName}
              />
            </div>
          )}
          {/* 视频列表 */}
          <div className={styles.videoListSection}>
            <VideoList
              videos={roomState.videos}
              activeObjectKey={activeObjectKey}
              isController={isController}
              onPlay={handlePlayVideo}
            />
          </div>
        </main>

        {/* 右侧控制面板 */}
        <aside className={styles.panel}>
          <ControlPanel
            roomId={roomState.roomId}
            roomName={roomState.roomName}
            members={roomState.members}
            controllerId={roomState.controllerId}
            isAdmin={isAdmin}
            currentUserId={userInfo?.userId ?? ''}
            onTransferControl={(targetUserId) => {
              sendMessage('TRANSFER_CONTROL', { targetUserId });
            }}
          />
        </aside>
      </div>
    </div>
  );
}
