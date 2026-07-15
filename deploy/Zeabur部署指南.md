# Zeabur 部署指南

比腾讯云更省事：不用买服务器、不用 SSH。流程：GitHub 私有仓库 → Zeabur 一键部署 → 配环境变量 → 拿到公网域名。全程约 10 分钟。

> 费用：Zeabur 跑常驻 Node 服务需要 Developer 套餐（约 $5/月起，按量计费，这个 Demo 的用量基本就是底价）。香港区域大陆访问通常没问题。

## 一、推送到 GitHub 私有仓库

⚠️ 仓库必须选 **Private（私有）**——里面有医院价目表数据。

1. 打开 https://github.com/new：
   - Repository name：`huamei-ai-consult`
   - 选 **Private**
   - 不要勾选 README/gitignore（本地已有）
2. 创建后，在项目根目录执行（本地 git 提交我已做好）：

```powershell
git remote add origin https://github.com/你的用户名/huamei-ai-consult.git
git branch -M main
git push -u origin main
```

首次 push 会弹 GitHub 登录窗口，登录即可。

## 二、Zeabur 创建服务

1. 打开 https://zeabur.com → **Sign in with GitHub**
2. **Create Project** → 区域选 **Hong Kong**（大陆访问友好）
3. 项目里 **Add Service → Git → GitHub**，首次需授权 Zeabur 访问你的仓库（可只授权这一个仓库）
4. 选择 `huamei-ai-consult` 仓库 → Zeabur 会自动识别为 Node.js 项目并开始构建（识别依据是仓库里的 package.json，`npm start` 启动）

## 三、配置环境变量

服务面板 → **Variables** → 添加：

| 变量名 | 值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | sk-你的key | 必填，否则是本地演示模式 |
| `DEEPSEEK_MODEL` | deepseek-chat | 换成你开通的模型ID |
| `ACCESS_CODE` | 自定口令 | 强烈建议设置，防接口被刷 |
| `CDN_BASE_URL` | 见下方说明 | 可选，图片走外部 CDN 加速 |

> 不用配 PORT，Zeabur 会自动注入，代码已适配。

添加后点 **Redeploy** 让变量生效。

## 四、开公网域名

服务面板 → **Networking** → **Generate Domain**，取个前缀（如 `huamei-demo`），得到：

```
https://huamei-demo.zeabur.app
```

打开即可用，把链接+访问口令发给同事就能演示（自带 HTTPS）。

## 五、日常更新

改完代码后：

```powershell
git add -A
git commit -m "更新说明"
git push
```

push 后 Zeabur **自动重新构建部署**，约 1 分钟生效。

## 常见问题

- **构建成功但访问 502**：看服务面板 Logs，通常是环境变量拼写错误。
- **图片不显示**：云端用的是仓库里的 `assets/` 精简图（20张）。新增配图时：在 `app/server.js` 的 IMAGE_CATALOG 加条目 → 把图从 `素材/` 复制到 `assets/` 同样的相对路径 → push。
- **想换回国内**：数据和代码都在 git 里，随时可以按 `deploy/部署指南.md` 切到腾讯云轻量，两边不冲突。

## 六、图片 CDN 加速（可选）

对话配图默认走服务端 `/assets/`，如果想进一步加速（走 jsDelivr 开源 CDN 的边缘节点），设置环境变量：

```
CDN_BASE_URL=https://cdn.jsdelivr.net/gh/KEVqwe/huamei-ai-consult@main
```

> ⚠️ jsDelivr 只能读取**公开仓库**。当前仓库已是公开状态，图片可正常访问。如果改为私有仓库，需换用其他 CDN 方案。

设置后图片 URL 会从 `/assets/医生介绍/...webp` 变为 `https://cdn.jsdelivr.net/gh/KEVqwe/huamei-ai-consult@main/assets/医生介绍/...webp`，浏览器直接从 jsDelivr 边缘节点加载，不经过服务端。

图片 URL 自带 `?v=<build>` 版本号，更新图片后只需改 `version.json` 的 `build` 字段 + push 即可刷新 CDN 缓存。

如果想预热 CDN（国内首访更快）：
```bash
bash scripts/warm-cdn.sh https://cdn.jsdelivr.net/gh/KEVqwe/huamei-ai-consult@main
```
