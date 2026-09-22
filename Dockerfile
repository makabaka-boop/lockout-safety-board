# ---- 构建阶段：装全依赖、构建前端静态资源 ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# ---- 运行阶段：仅保留运行所需依赖 + 源码 + 构建产物 ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=builder /app/dist ./dist
EXPOSE 8080
CMD ["node", "server/start.js"]

# ---- Web 阶段：nginx + 构建好的前端静态资源（反代上游由 compose 注入配置）----
FROM nginx:1.27-alpine AS web
COPY --from=builder /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
