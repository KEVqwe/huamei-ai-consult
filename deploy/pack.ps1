# 打包部署zip：只带 app/ + knowledge/ + IMAGE_CATALOG 用到的素材图（约20张，几十MB以内）
# 用法：在项目根目录执行  powershell -ExecutionPolicy Bypass -File deploy\pack.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$staging = Join-Path $env:TEMP "huamei-ai-pack"
$zip = Join-Path $root "deploy\huamei-ai.zip"

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force $staging | Out-Null

# 1. 代码与知识库
Copy-Item (Join-Path $root 'app') (Join-Path $staging 'app') -Recurse
Copy-Item (Join-Path $root 'knowledge') (Join-Path $staging 'knowledge') -Recurse

# 2. 从 server.js 解析 IMAGE_CATALOG 引用的素材文件，按原目录结构拷贝
$serverJs = Get-Content (Join-Path $root 'app\server.js') -Raw -Encoding utf8
$matches2 = [regex]::Matches($serverJs, "file:\s*'([^']+)'")
$count = 0
foreach ($m in $matches2) {
    $rel = $m.Groups[1].Value
    $src = Join-Path (Join-Path $root '素材') $rel
    if (Test-Path $src) {
        $dst = Join-Path (Join-Path $staging '素材') $rel
        New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
        Copy-Item $src $dst
        $count++
    } else {
        Write-Warning "素材缺失: $rel"
    }
}

# 3. 压缩
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip
Remove-Item $staging -Recurse -Force

$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "打包完成: $zip （$size MB，含素材图 $count 张）"
Write-Host "下一步: scp deploy\huamei-ai.zip deploy\setup.sh root@服务器IP:/opt/"
