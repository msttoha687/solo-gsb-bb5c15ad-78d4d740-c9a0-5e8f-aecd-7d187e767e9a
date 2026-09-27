FROM node:20-alpine

WORKDIR /app

# 仅拷贝依赖清单与锁文件，优先利用层缓存；npm ci 按锁文件精确安装，构建可复现
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝应用源码
COPY server.js ./
COPY src ./src
COPY public ./public
COPY samples ./samples
# 容器内健康检查探针（无第三方依赖的 Node 脚本）
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    SEED_ON_START=true

# 剧情数据持久化卷
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "server.js"]
