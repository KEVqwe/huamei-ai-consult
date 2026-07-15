// 重做超长医生海报：从素材原图按 720px 宽重编码（可读且尺寸安全，避免被压成细条）
// 只处理比例 >4:1 的超长图，正常图不动。用法: node scripts/rebuild-tall-images.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const sharp = require(path.join(ROOT, 'node_modules', 'sharp'));

const TARGET_WIDTH = 720;   // 可读宽度
const QUALITY = 78;
const RATIO_THRESHOLD = 4;  // 高:宽 超过4:1 才算超长图
const MAX_AREA = 16000000;  // iOS安全面积上限(<16.7MP)

const src = fs.readFileSync(path.join(ROOT, 'app', 'server.js'), 'utf8');
const webpFiles = [...src.matchAll(/file:\s*["']([^"']+\.webp)["']/g)].map(m => m[1]).filter(f => f.startsWith('医生介绍'));

function findOriginal(relWebp) {
  const base = relWebp.replace(/\.webp$/i, '');
  for (const ext of ['.jpg', '.jpeg', '.png', '.JPG', '.PNG']) {
    const p = path.join(ROOT, '素材', base + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

(async () => {
  let done = 0, skip = 0;
  for (const rel of webpFiles) {
    const orig = findOriginal(rel);
    if (!orig) { console.log('  ✗ 无原图:', rel); continue; }
    const meta = await sharp(orig).metadata();
    const ratio = meta.height / meta.width;
    if (ratio <= RATIO_THRESHOLD) { skip++; continue; }  // 非超长图，跳过

    // 720宽，高按比例；若面积超限则收窄宽度保面积安全
    let w = TARGET_WIDTH;
    let h = Math.round(w * ratio);
    if (w * h > MAX_AREA) { w = Math.floor(Math.sqrt(MAX_AREA / ratio)); h = Math.round(w * ratio); }

    const dst = path.join(ROOT, 'assets', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    await sharp(orig).resize(w, h, { fit: 'fill' }).webp({ quality: QUALITY }).toFile(dst);
    const kb = Math.round(fs.statSync(dst).size / 1024);
    console.log(`  ✓ ${w}x${h} ${kb}KB  ${rel.split('/').pop()}`);
    done++;
  }
  console.log(`\n完成：重做 ${done} 张，跳过 ${skip} 张正常图`);
})();
