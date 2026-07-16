// 批量规范化 assets 目录与标签（一次性迁移脚本）
//  1. 移除"光电中心"（不需要该图）
//  2. 文件名 = 标签名，目录按 医生/科室、产品/系列、会员卡 归类
//  3. 医生标签统一为「全名+医生」
//  4. 毛发移植科 与 韩国专家 分属不同目录
// 用法: node scripts/normalize-assets.js [--apply]   (不加 --apply 只预览)
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

const src = fs.readFileSync(path.join(ROOT, 'app', 'server.js'), 'utf8');
const CATALOG = eval(src.match(/const IMAGE_CATALOG = (\[[\s\S]*?\n\]);/)[1]);

// 旧标签(tags[1]) → 新标签
const RENAME = {
  // 整形外科
  '佀医生':'佀同帅医生','陈医生':'陈小剑医生','叶医生':'叶丽萍医生','李健医生':'李健医生',
  '张医生':'张朋医生','谢医生':'谢卫国医生','胡医生':'胡小清医生','李志海医生':'李志海医生','弓医生':'弓辉辉医生',
  // 注射美容科
  '彭医生':'彭光群医生','李帅华医生':'李帅华医生','聂医生':'聂婕医生','赵医生':'赵伟医生',
  '安医生':'安丰鹏医生','成医生':'成建璋医生','魏医生':'魏开轩医生',
  // 皮肤美容科
  '曹医生':'曹小曼医生','常医生':'常春医生','陈靓靓医生':'陈靓靓医生','谭医生':'谭书敏医生',
  '唐医生':'唐清丽医生','田医生':'田艳艳医生','王医生':'王倩医生','吴医生':'吴丽果医生',
  '杨医生':'杨立群医生','张琳琳医生':'张琳琳医生',
  // 口腔美容科
  '张群医生':'张群医生','黄医生':'黄嵩医生',
  // 毛发移植科 / 韩国专家（分开）
  '刘医生':'刘学新医生',
  '李英大医生':'李英大医生','李庭勋医生':'李庭勋医生','许再荣医生':'许再荣医生',
  // 产品（顺带把含糊的标签改清晰）
  '天鹅童颜':'天鹅童颜','小金瓶':'小金瓶','小银瓶':'小银瓶','殊敏适':'殊敏适',
  '粉色美白套':'粉色美白套','绿色祛痘套':'绿色祛痘套','聚光尊':'聚光尊','蓝色修复套':'蓝色修复套',
  '豆仙优':'豆仙优','瑞可丽':'瑞可丽中胚系列',
  '修复乳':'修复乳','凝胶':'凝胶','喷雾':'喷雾','洁面':'洁面慕斯','精华液':'精华液',
  '敷料':'透明质酸敷料','面膜':'胶原面膜','居家':'瑞可丽居家系列',
  // 会员卡
  '荟员V1粉卡':'荟员V1粉卡','荟员V2银卡':'荟员V2银卡','荟员V3金卡':'荟员V3金卡',
  '荟员V4钻卡':'荟员V4钻卡','荟员V5黑卡':'荟员V5黑卡',
};
const DROP = new Set(['光电中心']);   // 不再需要的图

// 依据原路径决定新目录
function newDir(oldFile) {
  if (oldFile.includes('医生介绍/整形外科')) return '医生/整形外科';
  if (oldFile.includes('医生介绍/注射美容科')) return '医生/注射美容科';
  if (oldFile.includes('医生介绍/皮肤美容科')) return '医生/皮肤美容科';
  if (oldFile.includes('医生介绍/口腔美容科')) return '医生/口腔美容科';
  if (oldFile.includes('医生介绍/毛发移植科')) return '医生/毛发移植科';
  if (oldFile.includes('医生介绍/特邀专家')) return '医生/韩国专家';
  if (oldFile.includes('瑞可丽中胚产品')) return '产品/瑞可丽中胚';
  if (oldFile.includes('瑞可丽居家产品')) return '产品/瑞可丽居家';
  if (oldFile.startsWith('荟员升级权益')) return '会员卡';
  return '其他';
}
// 分类前缀（tags[0]），保持本地模式可用
function category(dir) {
  if (dir.startsWith('医生')) return '医生';
  if (dir.startsWith('产品')) return '产品';
  if (dir.startsWith('会员卡')) return '会员';
  return '其他';
}

const plan = [], dropped = [], problems = [];
const seen = new Set();
for (const c of CATALOG) {
  const oldKey = c.tags[1];
  if (DROP.has(oldKey)) { dropped.push(c); continue; }
  const newKey = RENAME[oldKey];
  if (!newKey) { problems.push('无重命名规则: ' + oldKey); continue; }
  if (seen.has(newKey)) { problems.push('新标签重复: ' + newKey); continue; }
  seen.add(newKey);
  const dir = newDir(c.file);
  const newFile = dir + '/' + newKey + '.webp';
  // 旧文件在 assets 里的实际位置
  const oldPath = path.join(ROOT, 'assets', c.file);
  if (!fs.existsSync(oldPath)) { problems.push('源文件缺失: ' + c.file); continue; }
  // 其余辅助词（去掉分类前缀和旧key，保留姓名/部位等搜索词）
  const aux = c.tags.filter((t, i) => i !== 0 && i !== 1);
  plan.push({ oldKey, newKey, oldFile: c.file, newFile, dir, cat: category(dir), desc: c.desc, aux });
}

console.log('迁移计划：' + plan.length + ' 张，移除 ' + dropped.length + ' 张' + (problems.length ? '，问题 ' + problems.length + ' 个' : ''));
dropped.forEach(d => console.log('  [移除] ' + d.desc + '  (' + d.file + ')'));
problems.forEach(p => console.log('  [!] ' + p));
console.log('');
let lastDir = '';
plan.forEach(p => {
  if (p.dir !== lastDir) { console.log('  ── ' + p.dir + ' ──'); lastDir = p.dir; }
  const mark = p.oldKey === p.newKey ? '   ' : ' * ';
  console.log(mark + (p.oldKey + '').padEnd(12) + ' → ' + (p.newKey + '').padEnd(12) + '  ' + p.newFile);
});

if (!APPLY) { console.log('\n(预览模式。加 --apply 执行)'); process.exit(0); }

// ---- 执行：复制到新路径 ----
const TMP = path.join(ROOT, '.assets_new');
fs.rmSync(TMP, { recursive: true, force: true });
for (const p of plan) {
  const dst = path.join(TMP, p.newFile);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'assets', p.oldFile), dst);
}
// 用新目录替换旧 assets
fs.rmSync(path.join(ROOT, 'assets'), { recursive: true, force: true });
fs.renameSync(TMP, path.join(ROOT, 'assets'));

// ---- 生成新的 IMAGE_CATALOG 代码 ----
const q = s => JSON.stringify(s);
let code = 'const IMAGE_CATALOG = [\n';
lastDir = '';
for (const p of plan) {
  if (p.dir !== lastDir) { code += `  // —— ${p.dir} ——\n`; lastDir = p.dir; }
  const tags = [p.cat, p.newKey, ...p.aux];
  code += `  { file: ${q(p.newFile)}, src: ${q(p.oldFile)}, tags: [${tags.map(q).join(', ')}], desc: ${q(p.desc)} },\n`;
}
code += '];';
fs.writeFileSync(path.join(ROOT, '.catalog.new.js'), code);
console.log('\n已完成文件迁移；新 IMAGE_CATALOG 已写入 .catalog.new.js');
