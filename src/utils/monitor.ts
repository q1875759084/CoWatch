import { init } from '@cmjndy/monitor';
import type { MonitorEnv } from '@cmjndy/monitor';

// __DEPLOY_ENV__ 由 webpack.common.js DefinePlugin 注入
declare const __DEPLOY_ENV__: string;

const ENV_MAP: Record<string, MonitorEnv> = {
  dev:        'development',
  test:       'staging',
  production: 'production',
};

const REPORT_URL_MAP: Record<string, string> = {
  test:       '/monitor/collect',
  production: '/monitor/collect',
};

/**
 * 监控 SDK 薄封装
 * 按当前部署环境组装初始化参数，不在此处实现采集逻辑。
 */
export function initMonitor(): void {
  const deployEnv = __DEPLOY_ENV__;

  init({
    appKey: 'cowatch',
    env: ENV_MAP[deployEnv] ?? 'development',
    reportUrl: REPORT_URL_MAP[deployEnv] ?? '',
    debug: deployEnv === 'dev',
  });
}
