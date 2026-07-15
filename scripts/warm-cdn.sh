#!/bin/bash
# CDN 预缓存：把所有图片提前推到 CDN 边缘节点
#
# ⚠️ 重要：CDN 是"就近拉取"缓存，脚本暖的是【运行这台机器就近的边缘节点】。
#    要暖【上海节点】，必须从上海/国内的机器上跑本脚本（海外机器跑=暖海外节点，对国内用户无效）。
#
# ⚠️ 必须在 Zeabur 部署完新版本之后再跑（否则暖的是旧图/旧缓存）。
#
# 用法: bash scripts/warm-cdn.sh <你的线上域名>
# 例:   bash scripts/warm-cdn.sh https://xxx.zeabur.app

HOST="${1:-http://localhost:3080}"

echo "🔥 预缓存图片到 CDN 边缘节点（就近节点）"
echo "   目标: $HOST"
echo "   提示: 想暖上海节点，请确认你正从上海/国内网络运行本脚本"
echo ""

node -e "
const fs=require('fs'),http=require('http'),https=require('https');
const src=fs.readFileSync('app/server.js','utf8');
const ver=JSON.parse(fs.readFileSync('version.json','utf8'));
const VBUILD=ver.build||0;            // 与 server.js 的 ASSET_VER=v=build 对齐
const re=/file:\s*['\"]([^'\"]+\.webp)['\"]/g;
let m; const paths=[];
while(m=re.exec(src)) paths.push(m[1]);
console.log('共 '+paths.length+' 张图片，版本 v='+VBUILD+'\n');

const HOST='$HOST'.replace(/\/$/,'');
let done=0, ok=0, fail=0;

// GET 完整下载才能填充边缘 body 缓存；不带 no-cache，让 CDN 正常缓存
function warm(path){
  return new Promise(res=>{
    const url=HOST+'/assets/'+encodeURI(path)+'?v='+VBUILD;
    const mod=url.startsWith('https')?https:http;
    const req=mod.get(url,r=>{
      let n=0;
      r.on('data',c=>n+=c.length);           // 必须消费完整 body
      r.on('end',()=>{
        done++;
        const hit=(r.headers['x-zeabur-cache']||r.headers['cf-cache-status']||r.headers['x-cache']||'').toString();
        if(r.statusCode===200){ok++;} else {fail++; console.log('  ✗ '+r.statusCode+' '+path);}
        res();
      });
    });
    req.on('error',e=>{done++;fail++;console.log('  ✗ '+e.code+' '+path);res();});
    req.setTimeout(20000,()=>{req.destroy();});
  });
}

// 限并发 8，避免打爆
(async()=>{
  const CONC=8;
  for(let i=0;i<paths.length;i+=CONC){
    await Promise.all(paths.slice(i,i+CONC).map(warm));
    process.stdout.write('\r  进度 '+done+'/'+paths.length);
  }
  console.log('\n\n✅ 预缓存完成：成功 '+ok+' 张，失败 '+fail+' 张');
  console.log('   建议隔几分钟再跑一次（第二次应全部命中缓存，速度飞快=已暖热）');
})();
"
