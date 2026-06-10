# ==================== 第一阶段：构建 ====================
FROM node:20-alpine AS builder

WORKDIR /app

# 先复制依赖文件，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm install

# 声明构建参数：由 docker build --build-arg 传入
# DEPLOY_ENV 用于区分 test / production，注入给 webpack DefinePlugin
ARG DEPLOY_ENV
ENV DEPLOY_ENV=$DEPLOY_ENV

# 复制源码并构建
COPY . .
RUN npm run build

# ==================== 第二阶段：运行 ====================
# 只保留 Nginx + dist，丢弃 node_modules 和 Node.js
FROM nginx:alpine

# 复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html

# 复制 Nginx 配置模板（含 ${MONITOR_BACKEND_URL} 占位符）
# 启动时由 nginx 官方镜像内置的 envsubst 脚本自动展开
COPY nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 80

# nginx:alpine 官方镜像内置 /docker-entrypoint.d/20-envsubst-on-templates.sh
# 启动时自动将 /etc/nginx/templates/*.template 经 envsubst 处理后输出到 /etc/nginx/conf.d/
# 无需自定义 CMD，默认行为即可
