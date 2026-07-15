#!/bin/bash
# CDN 预缓存：把 56 张图片提前推到上海边缘节点
# 用法: bash scripts/warm-cdn.sh <你的域名>
# 例:   bash scripts/warm-cdn.sh https://xxx.zeabur.app

HOST="${1:-http://localhost:3080}"
COUNT=0

echo "🔥 预缓存图片到 CDN 上海节点..."
echo "   目标: $HOST"
echo ""

# 从 server.js 提取所有图片路径
node -e "
const fs=require('fs'),http=require('http'),https=require('https');
const src=fs.readFileSync('app/server.js','utf8');
const re=/file:\s*['\"]([^'\"]+\.webp)['\"]/g;
let m;
const urls=[];
while(m=re.exec(src)) urls.push(m[1]);

console.log('共 '+urls.length+' 张图片\n');

const HOST='$HOST'.replace(/\/$/,'');
let done=0;
urls.forEach((path,i)=>{
  const url=HOST+'/assets/'+encodeURI(path);
  const mod=url.startsWith('https')?https:http;
  const req=mod.request(url,{method:'HEAD',headers:{'Cache-Control':'no-cache'}},res=>{
    done++;
    const status=res.status===200?'✓':'✗';
    if(i<5||i>=urls.length-3) console.log('  ['+status+'] '+(i+1)+'/'+urls.length+' '+path.split('/').pop());
    if(done===urls.length) console.log('\n✅ 预缓存完成: '+urls.length+' 张');
  });
  req.on('error',()=>{done++;});
  req.end();
});
"