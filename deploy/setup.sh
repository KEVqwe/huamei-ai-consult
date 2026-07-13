#!/usr/bin/env bash
# 腾讯云轻量服务器一键部署脚本（Ubuntu 22.04 / Debian 系）
# 前提：huamei-ai.zip 已上传到 /opt/
# 用法：以 root 执行  bash /opt/setup.sh
set -e

APP_DIR=/opt/huamei-ai
ZIP=/opt/huamei-ai.zip

echo "==> 1/5 安装 Node.js 20 与 unzip"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y unzip >/dev/null

echo "==> 2/5 解压应用到 $APP_DIR"
mkdir -p "$APP_DIR"
unzip -o -q "$ZIP" -d "$APP_DIR"

echo "==> 3/5 写环境变量 /etc/huamei-ai.env（首次生成，已存在则跳过）"
if [ ! -f /etc/huamei-ai.env ]; then
cat >/etc/huamei-ai.env <<'EOF'
PORT=3080
# ↓↓↓ 部署后必改：填你的 DeepSeek Key 和模型ID ↓↓↓
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-chat
# 访问口令（告诉演示对象；留空=不设口令，公网强烈建议设置）
ACCESS_CODE=huamei2026
EOF
fi

echo "==> 4/5 注册 systemd 服务（开机自启、崩溃自动拉起）"
cat >/etc/systemd/system/huamei-ai.service <<EOF
[Unit]
Description=Huamei AI Consult Demo
After=network.target

[Service]
EnvironmentFile=/etc/huamei-ai.env
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/app/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now huamei-ai
sleep 1
systemctl --no-pager status huamei-ai | head -5

echo ""
echo "==> 5/5 完成！"
echo "  · 修改密钥:   nano /etc/huamei-ai.env   改完执行 systemctl restart huamei-ai"
echo "  · 查看日志:   journalctl -u huamei-ai -f"
echo "  · 访问地址:   http://服务器公网IP:3080  （记得在轻量控制台防火墙放行 TCP 3080）"
