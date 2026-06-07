import type { VideoItem } from '@/types/room';
import styles from './VideoList.module.scss';

interface VideoListProps {
  videos: VideoItem[];
  activeVideoUrl: string | null;
  onPlay: (videoUrl: string, videoId: string) => void;
}

export default function VideoList({ videos, activeVideoUrl, onPlay }: VideoListProps) {
  if (videos.length === 0) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyIcon}>📂</span>
        <p>暂无视频，请上传录屏文件</p>
      </div>
    );
  }

  return (
    <div className={styles.list}>
      <h3 className={styles.title}>视频列表 <span className={styles.count}>{videos.length}</span></h3>
      <ul className={styles.items}>
        {videos.map((v, idx) => {
          const isActive = v.videoUrl === activeVideoUrl;
          return (
            <li key={v.id} className={`${styles.item} ${isActive ? styles.active : ''}`}>
              <div className={styles.itemLeft}>
                <span className={styles.index}>{idx + 1}</span>
                <div className={styles.itemInfo}>
                  <span className={styles.fileName}>{v.fileName}</span>
                  <span className={styles.uploadTime}>
                    {new Date(v.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>
              <button
                className={`${styles.playBtn} ${isActive ? styles.playBtnActive : ''}`}
                onClick={() => onPlay(v.videoUrl, v.id)}
              >
                {isActive ? '▶ 播放中' : '▶ 播放'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
