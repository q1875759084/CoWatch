import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { registerApi, loginApi } from '@/api/auth';
import { useUser } from '@/context/UserContext';
import styles from './index.module.scss';

type Tab = 'login' | 'register';

/**
 * 认证页：注册 / 登录切换
 *
 * 账号规则：6-20位，英文字母 + 数字 + 特殊字符
 * 密码规则：至少6位
 * 注册需要邀请码，邀请码类型决定注册后身份（会员/普通成员）
 * 注册成功后自动登录，直接进入 Dashboard
 */
export default function AuthPage() {
  const navigate = useNavigate();
  const { login } = useUser();

  const [tab, setTab] = useState<Tab>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reset = (nextTab: Tab) => {
    setTab(nextTab);
    setError('');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = tab === 'login'
        ? await loginApi(username, password)
        : await registerApi(username, password, inviteCode);

      login(result.accessToken, {
        userId: result.userInfo.userId,
        username: result.userInfo.username,
        nickname: result.userInfo.nickname,
        plans: result.userInfo.plans ?? [],
      });
      navigate('/', { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '请求失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <h1>CoWatch</h1>
          <p>游戏<span style={{ textDecoration: 'line-through', textDecorationStyle: 'double' }}>复盘</span>开庭平台</p>
        </div>

        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'login' ? styles.active : ''}`}
            onClick={() => reset('login')}
          >
            登录
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'register' ? styles.active : ''}`}
            onClick={() => reset('register')}
          >
            注册
          </button>
        </div>

        <form className={styles.form} onSubmit={(e) => { void handleSubmit(e); }}>
          <div className={styles.field}>
            <label htmlFor="username">账号</label>
            <input
              id="username"
              type="text"
              placeholder="6-20位，字母/数字/特殊字符"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="password">密码</label>
            <input
              id="password"
              type="password"
              placeholder="至少6位"
              autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {tab === 'register' && (
            <div className={styles.field}>
              <label htmlFor="inviteCode">邀请码</label>
              <input
                id="inviteCode"
                type="text"
                placeholder="请输入邀请码"
                autoComplete="off"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                required
              />
            </div>
          )}

          {tab === 'register' && (
            <p className={styles.hint}>注册后账号名即为默认昵称</p>
          )}

          {error && <p className={styles.error}>{error}</p>}

          <button type="submit" className={styles.submit} disabled={loading}>
            {loading ? '处理中…' : tab === 'login' ? '登录' : '注册并登录'}
          </button>
        </form>
      </div>
    </div>
  );
}
