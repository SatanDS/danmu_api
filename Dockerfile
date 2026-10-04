# 使用官方 Node.js 22 轻量版镜像作为基础镜像
FROM node:22-alpine

# 设置工作目录为项目根目录
WORKDIR /app

# 使用已提交的依赖锁定文件，确保服务器构建与本地验证使用相同版本
COPY package.json package-lock.json ./

# 安装项目依赖
RUN npm ci --omit=dev --no-audit --no-fund

# 复制所有源代码
COPY danmu_api/ ./danmu_api/
COPY config/.env.example ./config_example/.env.example

ENV NODE_ENV=production

# 暴露端口
EXPOSE 9321

# 启动命令
CMD ["node", "danmu_api/server.js"]
