# 腾讯云 COS 配置与文件上传链路

## Bucket 信息

| 字段 | 值 |
|---|---|
| Bucket | `co-watch-1308112859` |
| Region | `ap-chengdu` |
| 默认域名 | `https://co-watch-1308112859.cos.ap-chengdu.myqcloud.com` |
| 访问权限 | 公有读私有写 |
| 数据冗余 | 单 AZ 存储 |

---

## CORS 规则

**配置路径：** COS 控制台 → 存储桶 → 安全管理 → 跨域访问 CORS

| 字段 | 值 | 说明 |
|---|---|---|
| Origin | `http://localhost:3001` | 本地前端地址；上线后追加生产域名 |
| Methods | `GET, PUT, HEAD` | PUT 用于上传，GET/HEAD 用于视频播放 |
| Allow-Headers | `*` | |
| Expose-Headers | `ETag, Content-Length, x-cos-request-id` | COS 控制台默认值，保留 |
| Max-Age | `600` | |
| Vary: Origin | ✅ 勾选 | 多 Origin 场景区分缓存 |

> **为什么后端地址（3002）不需要加 CORS Origin：**
> 后端代理上传时，请求从 Node.js 服务器发出，不经过浏览器，不受 CORS 限制。
> CORS 只约束浏览器发出的跨域请求，只需配置前端地址。

---

## 环境变量（后端 `.env`）

```env
COS_REGION=ap-chengdu
COS_BUCKET=co-watch-1308112859
COS_SECRET_ID=<腾讯云 API 密钥 SecretId>
COS_SECRET_KEY=<腾讯云 API 密钥 SecretKey>
# COS_BASE_URL=  # 接入 CDN 后填入 CDN 域名，留空则使用 COS 默认域名
```

**密钥创建路径：** 腾讯云控制台 → 访问管理 → API 密钥管理 → 新建密钥

---

## 文件上传完整链路

### COS 模式（后端代理中转）

所有用户统一走后端代理，后端负责 ffmpeg HLS 切片后再上传到 COS。

```
① GET /api/rooms/:roomId/upload-url
    后端返回：{ uploadUrl: "/api/rooms/:roomId/upload-proxy?objectKey=...&fileType=...&fileName=...", mode: "proxy" }

② POST /api/rooms/:roomId/upload-proxy（浏览器 → 后端）
    uploadGuard 中间件预检：Sec-Fetch 请求头 + 每日流量限制（5GB）
    后端先落临时文件，触发 ffmpeg -c copy HLS 切片
    切片完成后上传 .ts 片段到 COS，广播 VIDEO_ADDED
```

### 本地开发模式（不配置 COS 变量时）

```
① GET /api/rooms/:roomId/upload-url
    isOssEnabled() = false，返回：{ uploadUrl: "/api/rooms/:roomId/upload?...", mode: "local" }

② PUT /api/rooms/:roomId/upload
    文件流写入本地 uploads/:roomId/ 目录，触发本地 HLS 切片
```

---

## 从阿里云 OSS 迁移到腾讯云 COS

**改动范围极小，只动了两个文件：**

| 文件 | 改动 |
|---|---|
| `src/services/ossService.ts` | 全部重写：`ali-oss` → `cos-nodejs-sdk-v5`，对外函数签名不变 |
| `.env` / `.env.example` | `OSS_*` 变量 → `COS_*` 变量 |
| `package.json` | 新增 `cos-nodejs-sdk-v5` 依赖 |
| Controller / 路由 / 前端 | **零改动** |

**`ossService.ts` 对外接口（迁移前后完全一致）：**

```ts
isOssEnabled(): boolean
getUploadUrl(objectKey, mimeType, expireSeconds?): Promise<string>
proxyUploadToOss(objectKey, stream, mimeType): Promise<string>
getVideoUrl(objectKey): string
```

**COS_BASE_URL 说明：**
- 留空时自动拼接 COS 默认域名：`https://{bucket}.cos.{region}.myqcloud.com/{key}`
- 接入 CDN 后填入 CDN 域名，所有 videoUrl 自动切换为 CDN 链接，无需改代码

---

## 待办

- [ ] 接入腾讯云 CDN，将 `COS_BASE_URL` 设置为 CDN 域名
