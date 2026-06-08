# 压缩工具下载页 & 转码参数配置 实现任务

## 开发顺序说明

> 后端先行：准备静态 .bat 文件 → 实现下载接口；前端后行：UI 组件 → 下载 API 调用。
> 改动范围小，无数据库变更，无 WebSocket 改动。

---

## 任务清单

### 一、后端（CoWatch-backend/）

#### 1. 静态 .bat 文件
- [ ] 创建目录 `src/assets/bat/`
- [ ] 创建 `src/assets/bat/compress_high.bat`（CRF 23）
- [ ] 创建 `src/assets/bat/compress_balanced.bat`（CRF 26）
- [ ] 创建 `src/assets/bat/compress_small.bat`（CRF 28）
- [ ] 三个文件内容结构与 `Desktop/test/compress_video.bat` 一致，仅 `-crf` 值不同

#### 2. 控制器
- [ ] 创建 `src/controllers/bat/index.ts`，实现 `downloadBat` 控制器：
  - 读取 `preset` query 参数，缺省时默认 `balanced`
  - 校验枚举值（`high` / `balanced` / `small`），非法值返回 400
  - 按 `preset` 拼接 .bat 文件路径（`src/assets/bat/compress_{preset}.bat`）
  - 设置响应头 `Content-Disposition: attachment; filename="compress_{preset}.bat"`
  - `res.sendFile()` 返回文件

#### 3. 路由注册
- [ ] `src/routes/index.ts`：注册 `GET /api/bat` → `downloadBat`（无需鉴权中间件）

---

### 二、前端（CoWatch/src/）

#### 1. API 层
- [ ] `src/api/room.ts`：新增 `downloadBatApi(preset: 'high' | 'balanced' | 'small')`
  - `GET /api/bat?preset=xxx`，`responseType: 'blob'`
  - 拿到 Blob 后创建 `<a>` 元素，`URL.createObjectURL`，设置 `download` 属性为 `compress_{preset}.bat`，模拟点击触发浏览器下载，完成后 `URL.revokeObjectURL`

#### 2. UI 组件 - 编码设置折叠区
- [ ] `src/pages/WatchRoom/ControlPanel.tsx`：新增 `EncodeSettingsSection` 区域
  - 本地 `useState` 管理折叠状态（默认收起）和当前选中档位（默认 `balanced`）
  - 折叠按钮：点击切换展开/收起
  - 画质档位 `<select>`：
    - 选项：高画质（CRF 23）/ 均衡（CRF 26）/ 小体积（CRF 28）
    - `onChange` 更新本地档位状态，无需调接口
  - 分辨率只读行：`1080p`，`disabled` 样式，附 tooltip `二期开放`
  - 帧率只读行：`60fps`，`disabled` 样式，附 tooltip `二期开放`
  - 「下载转码脚本」按钮：点击调用 `downloadBatApi(currentPreset)`
- [ ] `src/pages/WatchRoom/ControlPanel.module.scss`：新增折叠区、置灰字段、下载按钮样式

---

### 三、验证

- [ ] 点击「下载转码脚本」→ 浏览器触发下载，文件名为 `compress_{preset}.bat`
- [ ] 切换档位后下载 → 打开 .bat 文件确认 `-crf` 值与档位一致
- [ ] 缺省或非法 `preset` 参数 → 后端返回默认 `balanced` 或 400
- [ ] 折叠/展开交互正常，不影响面板其他区域

---

完成所有任务后将 `- [ ]` 改为 `- [x]`
