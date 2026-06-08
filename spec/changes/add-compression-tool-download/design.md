# 压缩工具下载页 & 转码参数配置 技术设计

## 1. 功能概述

为解决游戏录屏文件体积过大（半小时约 3GB）导致的上传慢、CDN 流量高、seek 卡顿等问题，引入本地转码流程：

- 用户在上传前使用 `.bat` 脚本本地转码（3GB → ~1GB，Fast Start）
- 转码参数（画质档位）由用户在控制面板自行选择，仅影响下载的脚本内容
- `.bat` 脚本在房间内一键下载，无需登录或权限校验

---

## 2. 涉及模块

| 模块 | 路径 | 变更说明 |
|------|------|----------|
| 前端 - 控制面板 | `src/pages/WatchRoom/ControlPanel.tsx` | 新增折叠区"编码设置" |
| 前端 - 样式 | `src/pages/WatchRoom/ControlPanel.module.scss` | 新增折叠区样式 |
| 前端 - API | `src/api/room.ts` | 新增 `downloadBatApi` |
| 后端 - 路由 | `CoWatch-backend/src/routes/index.ts` | 注册新路由 |
| 后端 - 控制器 | `CoWatch-backend/src/controllers/bat/index.ts` | 新增 `downloadBat` 控制器 |
| 后端 - 静态资源 | `CoWatch-backend/src/assets/bat/` | 存放三个预生成 .bat 文件 |

> **不涉及**：数据库变更、WebSocket 事件、Context 状态、权限校验。

---

## 3. UI 设计

### 3.1 控制面板编码设置折叠区

位于右侧控制面板底部，折叠收起，所有成员均可展开。

```
ControlPanel
└── EncodeSettingsSection（折叠区，默认收起）
    ├── [折叠按钮] 编码设置 ▼
    ├── 画质档位（下拉框，所有人可切换，本地状态）
    │     ├── 高画质（CRF 23）
    │     ├── 均衡（CRF 26，默认）
    │     └── 小体积（CRF 28）
    ├── 分辨率（只读，1080p，置灰，二期开放）
    ├── 帧率（只读，60fps，置灰，二期开放）
    └── [下载转码脚本] 按钮
```

#### 交互细节

- 画质档位选择为**纯本地状态**（`useState`），不同步到后端，不广播给其他成员。每人各自选择适合自己的档位后下载对应 .bat，互不影响。
- When 任意成员点击「下载转码脚本」，the system shall 调用 `GET /api/bat?preset=<当前选中档位>`，浏览器自动触发文件下载。
- 折叠按钮点击切换展开/收起，状态仅本地维护。
- 分辨率和帧率字段展示但置灰，附 tooltip "二期开放"。

---

## 4. 接口设计

### 4.1 下载转码脚本
- **方法**：GET
- **路径**：`/api/bat`
- **权限**：无需鉴权（非敏感资源，静态文件）
- **Query 参数**：`preset=high|balanced|small`（缺省时默认 `balanced`）
- **响应**：`.bat` 文件流

```
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="compress_balanced.bat"
```

后端按 `preset` 参数选择对应静态文件返回，无需查数据库。

---

## 5. 静态 .bat 文件

存放于 `CoWatch-backend/src/assets/bat/`，三个文件随后端一起部署。

### 文件清单

| 文件名 | 档位 | CRF | 预估输出大小（30min） |
|--------|------|-----|---------------------|
| `compress_high.bat` | 高画质 | 23 | ~1.5 GB |
| `compress_balanced.bat` | 均衡 | 26 | ~1 GB |
| `compress_small.bat` | 小体积 | 28 | ~700 MB |

### 共同参数

```
-c:v libx264          H.264 编码（浏览器兼容性最佳）
-preset fast          速度优先，减少转码等待时间
-c:a aac              音频编码
-b:a 128k             音频码率（足够复盘听音）
-movflags +faststart  moov 前置，解决浏览器 seek 卡顿问题
```

输出文件名规则：原文件名 + `_compressed`，与原文件同目录。

---

## 6. 关键决策

| 决策点 | 结论 | 理由 |
|--------|------|------|
| .bat 生成方式 | 静态文件按参数返回 | 三个固定档位，无需动态生成 |
| 档位是否落库 | 否，纯本地状态 | 非敏感配置，各人自选，无多端同步价值 |
| 权限校验 | 无 | 非敏感资源，恶意修改无实际危害 |
| WS 广播 | 无 | 档位不需要多端同步 |
| 参数范围 | CRF 可选，分辨率/帧率置灰占位 | 降低认知负担，传递二期扩展预期 |
| 编码格式 | H.264 only | 8人全支持 H.265 的概率 ≈ 43%，风险过高 |

---

## 7. 二期扩展方向

- 动态生成脚本（支持自定义 CRF、分辨率、帧率，后端模板渲染）
- 解锁分辨率和帧率字段
- 支持 Mac/Linux 用户（生成 `.sh` 脚本，`Accept` 头区分或独立端点）
- 如有需要，将档位落库并同步给房间成员
