# 生图改为 Supabase Edge Function 代理

## 目标

前端不再直接请求第三方生图服务，而是统一改为：

- 浏览器 → Supabase Edge Function `image-generate`
- Edge Function → `PRIMARY_IMAGE_GEN_*` / `BACKUP_IMAGE_GEN_*` 对应的第三方服务

这样可以：

- 避免浏览器 CORS 问题
- 不再把第三方生图 API Key 暴露到前端
- 保留主备服务切换能力

## 前端改动

前端现在统一调用：

- [services/imageGenerationEdge.ts](services/imageGenerationEdge.ts)
- [services/imageGenerationQueue.ts](services/imageGenerationQueue.ts)

浏览器侧不再需要直接访问：

- `IMAGE_GEN_ENDPOINT`
- `PRIMARY_IMAGE_GEN_BASE_URL`
- `PRIMARY_IMAGE_GEN_API_KEY`
- `BACKUP_IMAGE_GEN_BASE_URL`
- `BACKUP_IMAGE_GEN_API_KEY`

## Edge Function 文件

新增函数：

- [supabase/functions/image-generate/index.ts](supabase/functions/image-generate/index.ts)

## 需要配置到 Supabase Edge Function Secrets 的变量

至少配置主服务：

- `PRIMARY_IMAGE_GEN_BASE_URL`
- `PRIMARY_IMAGE_GEN_API_KEY`
- `PRIMARY_IMAGE_GEN_MODEL`

如需备用服务，再配置：

- `BACKUP_IMAGE_GEN_BASE_URL`
- `BACKUP_IMAGE_GEN_API_KEY`
- `BACKUP_IMAGE_GEN_MODEL`

兼容旧变量：

- `IMAGE_GEN_ENDPOINT`
- `IMAGE_GEN_API_KEY`
- `IMAGE_GEN_MODEL`

## 本地开发

本地前端仍然只需要能访问 Supabase：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

生图第三方密钥不应再注入到 Vite 前端环境中。

## 部署步骤

1. 部署 Edge Function `image-generate`
2. 在 Supabase 项目中配置上述 secrets
3. 确认前端的 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` 正常
4. 重新部署前端

## 验证

成功后，浏览器网络请求应表现为：

- 请求到 Supabase Functions
- 不再直接请求第三方 `images/generations`

如果失败，优先检查：

- Supabase Edge Function 是否已部署
- Edge Function secrets 是否已配置
- 第三方接口本身是否可用
- 当前 Supabase URL / anon key 是否正确
