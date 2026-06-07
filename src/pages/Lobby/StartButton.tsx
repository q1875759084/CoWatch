import styles from './StartButton.module.scss';

interface StartButtonProps {
  disabled: boolean;
  onStart: () => void;
}

export default function StartButton({ disabled, onStart }: StartButtonProps) {
  return (
    <div className={styles.wrapper}>
      <button
        className={styles.btn}
        disabled={disabled}
        onClick={onStart}
        title={disabled ? '请先上传录屏文件' : '开始复盘'}
      >
        🎮 开始复盘
      </button>
      {disabled && (
        <p className={styles.hint}>请先上传录屏文件</p>
      )}
    </div>
  );
}
