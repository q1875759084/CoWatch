# Research: 压缩工具下载页 & 转码参数配置

## 背景

用户需要在上传视频前在本地完成转码压缩（3GB → ~1GB），工具以 `.bat` 脚本形式分发。
本次需求包含三个子问题：
1. 网站提供 .bat 下载入口（替代手动打包传文件）
2. H.265 vs H.264 选择（已关闭）
3. 转码参数配置表，与房间绑定

---

## 决策记录

### Q1：参数配置的位置与作用范围
- **Decision:** 在右侧控制面板的折叠配置区（Encode Settings），作用于当前房间，管理员随时可调整
- **Rationale:** 参数跟房间走，确保房间内所有成员下载同一套参数的 .bat；折叠区不影响主界面布局
- **Alternatives considered:** 创建房间时一次性选择（不够灵活）；全局配置（无法按房间差异化）

### Q2：暴露给用户的参数范围
- **Decision:** 一期只暴露 CRF；分辨率、帧率字段展示但置灰，作为二期占位
- **Rationale:** 降低用户认知负担；置灰字段传递"未来会有"的产品预期，避免用户以为功能不完整
- **Alternatives considered:** 只暴露 CRF 不展示其他字段（失去二期扩展的视觉预期）；完整暴露（一期过于复杂）

### Q3：.bat 下载入口位置
- **Decision:** Option B — 房间内控制面板参数配置区放"下载转码脚本"按钮，参数配好后直接下载
- **Rationale:** 流程最短，参数和下载在同一区域，用户无需跳转
- **Alternatives considered:** 独立工具页（与房间参数割裂）；两个都有（重复入口增加维护成本）

### Q4：.bat 生成方式
- **Decision:** 一期 Option C（静态预生成），后续迁移 Option A（后端动态生成）
- **Rationale:** 一期 CRF 只有三个档位（23/26/28），对应三个静态 .bat 文件，成本极低；后续参数增多时再做动态生成接口
- **Alternatives considered:** 直接做后端动态生成（一期过度设计）；前端 JS 拼接（绕过后端，参数校验缺失）

### Q5：CRF 交互形式
- **Decision:** Option B — 预设档位下拉框：高画质（CRF 23）/ 均衡（CRF 26）/ 小体积（CRF 28）
- **Rationale:** 隐藏技术细节，用语义标签替代数字；三个档位天然对应三个静态 .bat 文件，与 Q4 方案契合
- **Alternatives considered:** 数字滑块（对非技术用户无意义）；仅展示不可编辑（失去配置价值）

### [已关闭] H.265 vs H.264
- **Decision:** 只用 H.264，不考虑 H.265
- **Rationale:** 8人房间要求全员支持，单人支持概率约 0.9，8人全部支持概率约 0.9^8 ≈ 43%，风险过高。详见 `docs/决策记录.md`

---

## 一期实现范围

### 前端
- 右侧控制面板新增折叠区"编码设置"（仅管理员可操作）
- 下拉框：画质档位（高画质 / 均衡 / 小体积）
- 置灰字段：分辨率（1080p，不可编辑）、帧率（60fps，不可编辑）
- "下载转码脚本"按钮：根据当前选中档位下载对应静态 .bat 文件

### 后端
- `rooms` 表新增字段 `encode_preset`（枚举：`high` / `balanced` / `small`，默认 `balanced`）
- `GET /api/rooms/:roomId/bat?preset=balanced` — 返回对应静态 .bat 文件（`Content-Disposition: attachment`）
- `PATCH /api/rooms/:roomId/encode` — 管理员更新房间编码档位

### 静态 .bat 文件（三个）
- `compress_high.bat`：CRF 23
- `compress_balanced.bat`：CRF 26
- `compress_small.bat`：CRF 28
- 均包含 `-movflags +faststart`，输出文件名加 `_compressed` 后缀

---

## 二期扩展方向
- 后端动态生成 .bat（支持自定义 CRF 值、分辨率、帧率）
- 解锁分辨率和帧率字段
- 支持 Mac/Linux 用户（生成 .sh 脚本）
