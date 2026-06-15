import { Spin } from 'antd';

interface LoadingSpinnerProps {
  text?: string;
  fullPage?: boolean;
}

export default function LoadingSpinner({ text = '加载中...', fullPage = false }: LoadingSpinnerProps) {
  if (fullPage) {
    return <Spin tip={text} size="large" fullscreen />;
  }
  return <Spin tip={text} size="large" />;
}
