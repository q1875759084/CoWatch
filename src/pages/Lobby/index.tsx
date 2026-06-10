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
 * SYNC_PROGRESS 进度同步阈值（秒）。
 *
 * 收到 SYNC_PROGRESS 时，若本地进度与远端偏差在此范围内，浏览器自然追上，无需 seek。
 * 只有偏差超过阈值（真正失步）时才执行 seek，避免频繁 seek 打断缓冲。
 * 游戏复盘场景对同步精度要求高，设为 0.5s。
 */
const SEEK_THRESHOLD_SEC = 0.5;

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { userInfo } = useUser();
  const { roomState, initRoom, setActiveVideoUrl } = useRoom();

  /**
   * 暂存 ROOM_STATE 下发的播放初始化参数。
   * ROOM_STATE（WS）和 HTTP 初始化是并行的异步路径，VideoPlayer 挂载时机不确定；
   * 用 ref 暂存，在 VideoPlayer 挂载时（callback ref 触发）立即消费。
   */
  const pendingInitRef = useRef<{ isPlaying: boolean; currentTime: number } | null>(null);
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
      const videos = videosData.videos.map((v) => ({
        id: v.id,
        videoUrl: v.videoUrl,
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
    videoUrl?: string | null,
  ) => {
    if (videoRef.current) {
      videoRef.current.initPlayback(isPlaying, currentTime);
    } else {
      pendingInitRef.current = { isPlaying, currentTime };
    }
    // 初始化 activeVideoId，防止 activeVideoUrl 变化的 useEffect 触发多余 tag 请求
    if (videoUrl) {
      const matched = videosRef.current.find((v) => v.videoUrl === videoUrl);
      if (matched) setActiveVideoId(matched.id);
    }
    if (roomTags) {
      setTags(roomTags);
    }
  });

  /**
   * 收到 SYNC_PROGRESS：偏差超过阈值才 seek，避免频繁 seek 打断缓冲。
   */
  const handleSyncProgress = useMemoizedFn((currentTime: number) => {
    const handle = videoRef.current;
    if (!handle) return;
    if (Math.abs(handle.getCurrentTime() - currentTime) >= SEEK_THRESHOLD_SEC) {
      handle.syncSeek(currentTime);
    }
  });

  /**
   * 收到 SYNC_STATE（播放/暂停 + 时间）：全员同步执行。
   */
  const handleSyncState = useMemoizedFn((isPlaying: boolean, currentTime: number) => {
    if (isPlaying) {
      videoRef.current?.syncSeekAndPlay(currentTime);
    } else {
      videoRef.current?.syncSeekAndPause(currentTime);
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

  const { sendMessage } = useRoomWs({
    roomId: roomId!,
    token: getAccessToken() ?? '',
    onRoomState: handleRoomState,
    onSyncProgress: handleSyncProgress,
    onSyncState: handleSyncState,
    onTagAdded: handleTagAdded,
    onTagDeleted: handleTagDeleted,
  });

  /**
   * 本地点击"播放"：广播 SWITCH_VIDEO，更新本地激活视频，立即拉取 tags。
   */
  const handlePlayVideo = useMemoizedFn((videoUrl: string, videoId: string) => {
    setActiveVideoUrl(videoUrl);
    setActiveVideoId(videoId);
    setTags([]);
    setDuration(0);
    sendMessage('SWITCH_VIDEO', { videoUrl, videoId });
    fetchTags(videoId);
  });

  /**
   * 监听远端 SWITCH_VIDEO 广播（通过 activeVideoUrl 变化感知）。
   * 当 activeVideoUrl 变更且与当前 activeVideoId 不匹配时，说明是远端触发的切换，
   * 需要重新拉取对应视频的 tags。
   *
   * 注意：本地点击 handlePlayVideo 已经主动调用 fetchTags，
   * 且 setActiveVideoId 先于 activeVideoUrl 变化，所以 video.id === activeVideoId 成立，
   * effect 会跳过，不会重复请求。
   *
   * 初始进房间时 ROOM_STATE 已经带来了 tags（handleRoomState 处理），
   * 但 activeVideoId 为空，video.id !== '' 成立，会触发一次拉取。
   * 为避免这次多余请求，ROOM_STATE 处理时同步设置 activeVideoId。
   */
  const activeVideoUrl = roomState?.activeVideoUrl;
  useEffect(() => {
    if (!roomId || !activeVideoUrl || !roomState) return;

    // 通知 SW 将视频的 origin 加入白名单（COS / CDN 域名与页面域名不同，SW 需动态感知）
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      try {
        const videoOrigin = new URL(activeVideoUrl).origin;
        if (videoOrigin !== window.location.origin) {
          navigator.serviceWorker.controller.postMessage({
            type: 'ADD_VIDEO_ORIGIN',
            origin: videoOrigin,
          });
        }
      } catch {
        // URL 解析失败（如相对路径）时跳过，同域视频无需通知
      }
    }

    const video = roomState.videos.find((v) => v.videoUrl === activeVideoUrl);
    if (!video || video.id === activeVideoId) return;
    // 远端切换了视频，同步 activeVideoId 并拉取 tags
    setActiveVideoId(video.id);
    setTags([]);
    setDuration(0);
    fetchTags(video.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVideoUrl]);

  // ── Tag 操作（发送 WS 消息） ─────────────────────────────────────────────────

  const handleTagAdd = useMemoizedFn((_videoId: string, time: number, label: string) => {
    const id = crypto.randomUUID();
    sendMessage('TAG_ADD', { id, videoId: activeVideoId, time, label });
  });

  const handleTagDelete = useMemoizedFn((id: string) => {
    sendMessage('TAG_DELETE', { id });
  });

  const handleTagSeek = useMemoizedFn((time: number) => {
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
              <VideoUploader roomId={roomId!} />
            </div>
          )}
          {/* 视频列表 */}
          <div className={styles.videoListSection}>
            <VideoList
              videos={roomState.videos}
              activeVideoUrl={roomState.activeVideoUrl}
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
