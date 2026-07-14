/**
 * 上海华美 AI 咨询智能体 Demo 服务
 * - DEEPSEEK_API_KEY → DeepSeek API（OpenAI兼容）
 * - ANTHROPIC_API_KEY → Claude API
 * - 都没有 → 本地检索演示模式
 * 特性：真人顾问式多条消息分段回复、按话题自动配图（素材库图片）、端口占用自动顺延
 * 零依赖：Node 18+ 原生 http + fetch
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const KNOWLEDGE_DIR = path.join(ROOT, '..', 'knowledge');
// 图片解析顺序：assets/（网页压缩版，优先）→ 素材/（原图，本地兜底）
const ASSET_BASES = [path.join(ROOT, '..', 'assets'), path.join(ROOT, '..', '素材')];
const PUBLIC_DIR = path.join(ROOT, 'public');
function resolveAsset(rel) {
  for (const base of ASSET_BASES) {
    const fp = path.join(base, path.normalize(rel));
    if (fp.startsWith(base) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return fp;
  }
  return null;
}
const BASE_PORT = Number(process.env.PORT || 3080);

// ---------- 模型 Provider 配置（优先级：DeepSeek > Claude > 本地） ----------
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const PROVIDER = DEEPSEEK_API_KEY ? 'deepseek' : API_KEY ? 'claude' : 'local';
// 访问口令（公网部署时设置，防止接口被刷；不设置则不校验）
const ACCESS_CODE = process.env.ACCESS_CODE || '';

// ---------- 知识库加载（含元信息解析） ----------
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  m[1].split('\n').forEach(line => {
    const kv = line.match(/^(\S+?):\s*(.+)/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  });
  return { meta, body: text.slice(m[0].length) };
}

function loadKnowledge() {
  const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));
  const docs = files.map(f => {
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    return {
      name: f.replace(/\.md$/, ''),
      text: body,                     // 不含元信息头的正文
      meta,                           // { 科室, 类型, 关键词 }
      _keywords: (meta['关键词'] || '').split(/[,，]/).map(k => k.trim().toLowerCase()).filter(Boolean),
    };
  });
  // 分节（用于本地模式搜索）
  const sections = [];
  for (const d of docs) {
    const parts = d.text.split(/\n(?=## )/);
    for (const p of parts) {
      const title = (p.match(/^#{1,2}\s*(.+)/) || [,''])[1].trim();
      sections.push({ doc: d.name, title, text: p.trim() });
    }
  }
  return { docs, sections };
}

const KB = loadKnowledge();

// 基础系统提示词（人设+规则，不含知识库）
const SYSTEM_BASE = fs.readFileSync(path.join(ROOT, 'prompts', 'system.md'), 'utf8');

// ---------- RAG 检索：根据用户问题匹配最相关的知识库文档 ----------
function retrieveDocs(userMessage, limit = 4) {
  const t = (userMessage || '').toLowerCase();
  const scored = KB.docs.map(doc => {
    let score = 0;
    // 关键词命中加分（每个命中 +3）
    for (const kw of doc._keywords) {
      if (t.includes(kw)) score += 3;
    }
    // 文档名命中加分
    if (t.includes(doc.name.toLowerCase())) score += 5;
    // 正文关键词命中（采样前500字）
    const bodySample = doc.text.slice(0, 500).toLowerCase();
    for (const kw of doc._keywords) {
      if (bodySample.includes(kw)) score += 0.5;
    }
    return { doc, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // 至少返回目录索引（始终包含）
  const result = [];
  const hasDir = scored.find(s => s.doc.name === '项目与科室目录');
  if (hasDir && hasDir.score < 1) hasDir.score = 1; // 确保目录始终有最低分
  for (const s of scored) {
    if (s.score > 0 && result.length < limit) result.push(s.doc);
  }
  // 如果没匹配到任何文档，至少给目录+医生+政策
  if (result.length === 0) {
    result.push(
      ...KB.docs.filter(d => ['项目与科室目录', '医生团队', '当月政策与活动'].includes(d.name))
    );
  }
  return result.slice(0, limit);
}

// 动态构建系统提示词（仅注入检索到的相关文档，节省token）
function buildSystemPrompt(userMessage) {
  const relevant = retrieveDocs(userMessage);
  const kbBlock = relevant.map(d =>
    `<知识库文档 name="${d.name}" 科室="${d.meta['科室'] || ''}" 类型="${d.meta['类型'] || ''}">\n${d.text}\n</知识库文档>`
  ).join('\n\n');
  return SYSTEM_BASE + '\n\n' + kbBlock;
}

// ---------- 图片素材目录（仅医生+产品，价格由AI文字回复） ----------
const IMAGE_CATALOG = [
  // —— 瑞可丽中胚层治疗产品 ——
  { file: '明星产品/瑞可丽中胚产品/组合.jpg', tags: ['产品', '瑞可丽', '中胚', '胶原'], desc: '瑞可丽中胚产品系列' },
  { file: '明星产品/瑞可丽中胚产品/瑞可丽天鹅童颜/天鹅童颜.jpg', tags: ['产品', '天鹅童颜', '抗衰'], desc: '瑞可丽天鹅童颜' },
  { file: '明星产品/瑞可丽中胚产品/瑞可丽小金瓶/瑞可丽 小金瓶.jpg', tags: ['产品', '小金瓶', '瑞可丽', '抗衰'], desc: '瑞可丽小金瓶（高端抗衰）' },
  { file: '明星产品/瑞可丽中胚产品/瑞可丽小银瓶/小银瓶.jpg', tags: ['产品', '小银瓶', '瑞可丽', '补水'], desc: '瑞可丽小银瓶（补水抗衰）' },
  { file: '明星产品/瑞可丽中胚产品/瑞可丽聚光尊/聚光尊.jpg', tags: ['产品', '聚光尊', '瑞可丽', '美白', '去暗黄'], desc: '瑞可丽聚光尊（去暗黄提亮）' },
  { file: '明星产品/瑞可丽中胚产品/瑞可丽豆仙优/豆仙优.jpg', tags: ['产品', '豆仙优', '瑞可丽', '祛痘', '控油'], desc: '瑞可丽豆仙优（控油祛痘）' },
  { file: '明星产品/瑞可丽中胚产品/瑞可丽殊敏适/殊敏适.jpg', tags: ['产品', '殊敏适', '舒敏适', '瑞可丽', '修复', '敏感'], desc: '瑞可丽殊敏适（舒缓修复）' },
  { file: '明星产品/瑞可丽中胚产品/瑞可丽粉色美白套/粉色美白.jpg', tags: ['产品', '粉色美白套', '瑞可丽', '美白'], desc: '瑞可丽粉色美白套' },
  { file: '明星产品/瑞可丽中胚产品/瑞可丽蓝色修复套/蓝色修复.jpg', tags: ['产品', '蓝色修复套', '瑞可丽', '修复'], desc: '瑞可丽蓝色修复套（术后修复）' },
  { file: '明星产品/瑞可丽中胚产品/瑞可丽绿色祛痘套/绿色祛痘套.jpg', tags: ['产品', '绿色祛痘套', '瑞可丽', '祛痘'], desc: '瑞可丽绿色祛痘套' },
  // —— 瑞可丽居家养护产品 ——
  { file: '明星产品/瑞可丽居家产品/组合.jpg', tags: ['产品', '居家', '面膜', '修复乳', '护肤品'], desc: '瑞可丽居家产品系列' },
  { file: '明星产品/瑞可丽居家产品/瑞可丽修复乳/修复乳.jpg', tags: ['产品', '修复乳', '瑞可丽', '居家'], desc: '瑞可丽修复乳' },
  { file: '明星产品/瑞可丽居家产品/瑞可丽凝胶/凝胶.jpg', tags: ['产品', '凝胶', '瑞可丽', '居家'], desc: '瑞可丽凝胶' },
  { file: '明星产品/瑞可丽居家产品/瑞可丽喷雾/喷雾.jpg', tags: ['产品', '喷雾', '瑞可丽', '居家'], desc: '瑞可丽喷雾' },
  { file: '明星产品/瑞可丽居家产品/瑞可丽洁面慕斯/洁面慕斯.jpg', tags: ['产品', '洁面', '瑞可丽', '居家'], desc: '瑞可丽洁面慕斯' },
  { file: '明星产品/瑞可丽居家产品/瑞可丽精华液/精华液.jpg', tags: ['产品', '精华液', '瑞可丽', '居家'], desc: '瑞可丽精华液' },
  { file: '明星产品/瑞可丽居家产品/瑞可丽透明质酸敷料/敷贴面膜.jpg', tags: ['产品', '敷料', '瑞可丽', '修复', '械字号'], desc: '瑞可丽透明质酸敷料（械字号）' },
  { file: '明星产品/瑞可丽居家产品/瑞可丽面膜/面膜.jpg', tags: ['产品', '面膜', '瑞可丽', '居家', '胶原'], desc: '瑞可丽胶原面膜' },
  // —— 会员卡 ——
  { file: '荟员升级权益/1.png', tags: ['会员', '荟员', 'vip', '雏菊粉卡', 'V1'], desc: '荟员权益 V1雏菊粉卡' },
  { file: '荟员升级权益/2.png', tags: ['会员', '荟员', '银卡', '茉莉银卡', 'V2'], desc: '荟员权益 V2茉莉银卡' },
  { file: '荟员升级权益/3.png', tags: ['会员', '金卡', '荟员', '玫瑰金卡', 'V3'], desc: '荟员权益 V3玫瑰金卡' },
  { file: '荟员升级权益/4.png', tags: ['会员', '荟员', '钻卡', '山茶钻卡', 'V4'], desc: '荟员权益 V4山茶钻卡' },
  { file: '荟员升级权益/5.png', tags: ['会员', '荟员', '黑卡', '铃兰黑卡', 'V5'], desc: '荟员权益 V5铃兰黑卡' },
  // —— 整形外科9位 ——
  { file: '医生介绍/整形外科/佀同帅/【佀同帅个人介绍】长图修改.jpg', tags: ['医生', '佀医生', '佀同帅', '眼部', '显微眼', '重睑'], desc: '佀医生（眼部整形）' },
  { file: '医生介绍/整形外科/陈小剑/陈小剑个人简介长图.jpg', tags: ['医生', '陈医生', '陈小剑', '眼部', '重睑修复', '眼袋'], desc: '陈医生（眼部整形）' },
  { file: '医生介绍/整形外科/叶丽萍/叶丽萍个人总介绍.jpg', tags: ['医生', '叶医生', '叶丽萍', '鼻部', '隆鼻', '面部提升'], desc: '叶医生（鼻整形/面部提升）' },
  { file: '医生介绍/整形外科/李健/李健-个人总介绍.jpg', tags: ['医生', '李健医生', '李健', '鼻部', '隆鼻', '隆胸', '面部提升'], desc: '李健医生（鼻整形/隆胸/面部年轻化）' },
  { file: '医生介绍/整形外科/张朋/【张朋个人介绍】总介绍修改.jpg', tags: ['医生', '张医生', '张朋', '鼻部', '吸脂', '体雕'], desc: '张医生（鼻整形/吸脂塑形）' },
  { file: '医生介绍/整形外科/谢卫国/谢卫国个人总介绍.jpg', tags: ['医生', '谢医生', '谢卫国', '隆胸', '自体脂肪'], desc: '谢医生（隆胸/自体脂肪）' },
  { file: '医生介绍/整形外科/胡小清/胡小清个人总介绍.jpg', tags: ['医生', '胡医生', '胡小清', '眼部', '唇部', '私密'], desc: '胡医生（眼整形/唇部/私密）' },
  { file: '医生介绍/整形外科/李志海/李志海个人介绍.jpg', tags: ['医生', '李志海医生', '李志海', '颌面', '下颌角', '颧骨', '轮廓'], desc: '李志海医生（颌面轮廓）' },
  { file: '医生介绍/整形外科/弓辉辉/弓辉辉长图介绍.jpg', tags: ['医生', '弓医生', '弓辉辉', '整形外科'], desc: '弓医生（整形外科）' },
  // —— 微整形医生团队 ——
  { file: '医生介绍/微整形医生团.jpg', tags: ['医生', '微整医生', '注射医生'], desc: '微整形医生团队' },
  // —— 注射美容科7位 ——
  { file: '医生介绍/注射美容科/彭光群/fe870f1fb438456ea50b294dcc21d915.png', tags: ['医生', '彭医生', '彭光群', '微整', '注射'], desc: '彭医生（微整注射院长）' },
  { file: '医生介绍/注射美容科/李帅华/7763af354451d77683cffc07ffeab74e.jpg', tags: ['医生', '李帅华医生', '李帅华', '微整', '注射'], desc: '李帅华医生（微整技术院长）' },
  { file: '医生介绍/注射美容科/聂婕/027625f9671d47ed9db38a9aac4272b0.png', tags: ['医生', '聂医生', '聂婕', '微整', '注射'], desc: '聂医生（微整技术院长）' },
  { file: '医生介绍/注射美容科/赵伟/8aec4289bba3432492bc5db9a5c0f750.png', tags: ['医生', '赵医生', '赵伟', '微整', '注射'], desc: '赵医生（微整技术院长）' },
  { file: '医生介绍/注射美容科/安丰鹏/fd9f10c0cde4479597183b09e8b868a8.png', tags: ['医生', '安医生', '安丰鹏', '微整', '注射'], desc: '安医生（微整注射主任）' },
  { file: '医生介绍/注射美容科/成建璋/ae12ba5a6a704926860628e736b86c1c.png', tags: ['医生', '成医生', '成建璋', '微整', '注射'], desc: '成医生（微整注射主任）' },
  { file: '医生介绍/注射美容科/魏开轩/3fcf10ff416a46e6942e15a573b01e9c.png', tags: ['医生', '魏医生', '魏开轩', '微整', '注射'], desc: '魏医生（微整注射主任）' },
  // —— 皮肤美容科10位 ——
  { file: '医生介绍/皮肤美容科/曹小曼/f0d07450118a44eba2fa5f7e2d034df7.png', tags: ['医生', '曹医生', '曹小曼', '皮肤', '光电'], desc: '曹医生（皮肤美容）' },
  { file: '医生介绍/皮肤美容科/常春/53823046608f4f5881754f4623ff547e.png', tags: ['医生', '常医生', '常春', '皮肤', '光电'], desc: '常医生（皮肤美容）' },
  { file: '医生介绍/皮肤美容科/陈靓靓/手卡 - 陈靓靓.png', tags: ['医生', '陈靓靓医生', '陈靓靓', '皮肤', '光电'], desc: '陈靓靓医生（皮肤美容）' },
  { file: '医生介绍/皮肤美容科/谭书敏/4abe46782d5c409cacecf8f176ad21a3.jpg', tags: ['医生', '谭医生', '谭书敏', '皮肤', '光电'], desc: '谭医生（皮肤美容）' },
  { file: '医生介绍/皮肤美容科/唐清丽/2e805516cfd24e4a953741a9e1556875.png', tags: ['医生', '唐医生', '唐清丽', '皮肤', '光电'], desc: '唐医生（皮肤美容）' },
  { file: '医生介绍/皮肤美容科/田艳艳/7af4658c481c41f38cd2d557418c8dab.jpg', tags: ['医生', '田医生', '田艳艳', '皮肤', '光电'], desc: '田医生（皮肤美容）' },
  { file: '医生介绍/皮肤美容科/王倩/8e624ce837f14ef799b9c8cd3e2ae2b1.png', tags: ['医生', '王医生', '王倩', '皮肤', '光电'], desc: '王医生（皮肤美容）' },
  { file: '医生介绍/皮肤美容科/吴丽果/d283e5ae404c4db88a76c7c43ea068fd.png', tags: ['医生', '吴医生', '吴丽果', '皮肤', '光电'], desc: '吴医生（皮肤美容）' },
  { file: '医生介绍/皮肤美容科/杨立群/手卡-杨立群.png', tags: ['医生', '杨医生', '杨立群', '皮肤', '光电'], desc: '杨医生（皮肤美容）' },
  { file: '医生介绍/皮肤美容科/张琳琳/80aedf0291fb435c821ce1efa9527b50.png', tags: ['医生', '张琳琳医生', '张琳琳', '皮肤', '光电'], desc: '张琳琳医生（大光电美肤中心）' },
  // —— 口腔美容科2位 ——
  { file: '医生介绍/口腔美容科/张群/f286dd2d0ff2475fa421dc8985099a29.jpg', tags: ['医生', '张群医生', '张群', '口腔', '种植', '正畸'], desc: '张群医生（口腔种植/正畸）' },
  { file: '医生介绍/口腔美容科/黄嵩/c084798b96744e7db3fd1f59fbb3ae45.jpg', tags: ['医生', '黄医生', '黄嵩', '口腔', '种植'], desc: '黄嵩医生（口腔种植/正畸）' },
  // —— 毛发移植科1位 ——
  { file: '医生介绍/毛发移植科/刘学新/刘学新个人介绍.jpg', tags: ['医生', '刘医生', '刘学新', '植发', '毛发移植', '发际线'], desc: '刘医生（毛发移植）' },
  // —— 特邀专家（韩国） ——
  { file: '医生介绍/特邀专家/韩国医生专家团.jpg', tags: ['医生', '韩国专家', '特邀专家'], desc: '韩国医生专家团' },
  { file: '医生介绍/特邀专家/李英大/李英大个人介绍.jpg', tags: ['医生', '李英大医生', '李英大', '韩国专家', '特邀'], desc: '李英大医生（韩国特邀专家）' },
  { file: '医生介绍/特邀专家/李庭勋/李庭勋介绍.jpg', tags: ['医生', '李庭勋医生', '李庭勋', '韩国专家', '特邀'], desc: '李庭勋医生（韩国特邀专家）' },
  { file: '医生介绍/特邀专家/许再荣/许再荣介绍2.jpg', tags: ['医生', '许再荣医生', '许再荣', '韩国专家', '特邀'], desc: '许再荣医生（韩国特邀专家）' },
];
// 动态构建完整系统提示词 = 人设 + RAG检索知识库 + 可用图片清单
// 展示给 LLM 的标签用 tags[1]（具体标签），跳过 tags[0]（内部分类前缀）
const IMAGE_LIST = '\n\n# 可用图片清单\n' +
  IMAGE_CATALOG.map(c => `- [[图:${c.tags[1]}]] ${c.desc}`).join('\n');

function buildFullSystemPrompt(userMessage) {
  return buildSystemPrompt(userMessage) + IMAGE_LIST;
}

function imageSegment(entry) {
  return `![${entry.desc}](/assets/${encodeURI(entry.file.replace(/\\/g, '/'))})`;
}

// 智能拆分：优先 |||，否则按换行拆（表格行保持在一起）
function smartSplit(raw) {
  if (!raw || !raw.trim()) return [];
  // 模型正确用了 ||| 分隔符
  if (raw.includes('|||')) {
    return raw.split('|||').map(s => s.trim()).filter(Boolean);
  }
  // 兜底：按换行拆分
  const lines = raw.split('\n');
  const segs = [];
  let buf = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (buf.length) { segs.push(buf.join('\n')); buf = []; } continue; }
    // 表格行（|...|）合并在一起
    if (/^\|.*\|$/.test(t)) {
      buf.push(t);
    } else {
      if (buf.length) { segs.push(buf.join('\n')); buf = []; }
      segs.push(t);
    }
  }
  if (buf.length) segs.push(buf.join('\n'));
  return segs.length ? segs : [raw];
}

// 解析大模型回复中的 [[图:标签]] 标记，替换为独立的图片消息（一轮最多2张）
function expandImageMarkers(segments) {
  const out = [];
  let count = 0;
  // 宽松匹配：允许 [[ 图:标签 ]] / [[图：标签]] / [[ 图 : 标签 ]] 等变体
  const RE = /\[\[\s*图\s*[:：]\s*([^\]]+?)\s*\]\]/g;
  for (let seg of segments) {
    const labels = [];
    seg = seg.replace(RE, (_, label) => { labels.push(label.trim()); return ''; }).trim();
    if (seg) out.push(seg);
    for (const label of labels) {
      if (count >= 2) break;
      // 精确匹配标签 → 模糊匹配（标签含关键词 / 描述含关键词）
      let e = IMAGE_CATALOG.find(c => c.tags.includes(label));
      if (!e) {
        e = IMAGE_CATALOG.find(c =>
          c.tags.some(t => label.includes(t) || t.includes(label)) ||
          c.desc.includes(label)
        );
      }
      if (e) { out.push(imageSegment(e)); count++; }
    }
  }
  return out;
}

function pickImages(text, max = 2) {
  const t = (text || '').toLowerCase();
  // 纯分类标签（仅用于分类，不作为匹配依据）
  const CATEGORY_TAGS = new Set(['产品', '医生', '会员']);
  const hits = [];
  for (const img of IMAGE_CATALOG) {
    const matched = img.tags.filter(k => t.includes(k.toLowerCase()));
    // 必须命中至少1个非分类标签才考虑
    const specific = matched.filter(k => !CATEGORY_TAGS.has(k));
    if (specific.length > 0) {
      hits.push({ img, n: matched.length });
    }
  }
  hits.sort((a, b) => b.n - a.n);
  return hits.slice(0, max).map(h => ({ ...h.img, url: '/assets/' + encodeURI(h.img.file.replace(/\\/g, '/')) }));
}

// ---------- 本地检索模式 ----------
const INTENTS = [
  { kw: ['祛斑', '色斑', '雀斑', '黄褐斑', '斑点', '晒斑', '色素'], q: ['调Q', '祛斑', '皮秒', '脉冲光'], intro: '斑点问题咱家做得特别多哦～主要用皮秒/超皮秒、调Q激光和光子来做，不同类型的斑方案不一样' },
  { kw: ['痘', '粉刺', '闭口', '痘印', '痘坑'], q: ['祛痘', '清痘', '光动力', '点阵'], intro: '痘痘要分阶段处理的：还在爆的时候以光动力+清痘为主，痘印痘坑就用光子和点阵激光' },
  { kw: ['水光', '补水', '干燥', '嗨体', '熊猫针', '艾维岚'], q: ['水光', '嗨体'], intro: '补水嫩肤首选水光～咱家从399的基础型到胶原水光都有' },
  { kw: ['热玛吉'], q: ['热玛吉'], intro: '热玛吉是抗衰紧致的经典项目了，咱家是官方认证机构' },
  { kw: ['超声炮', '超声理疗'], q: ['超声'], intro: '超声炮主打中下面部+下颌线的紧致提升，和热玛吉是互补的' },
  { kw: ['热拉提'], q: ['热拉提'], intro: '热拉提性价比很高，怕疼预算又有限的姐妹很多选它' },
  { kw: ['抗衰', '紧致', '松弛', '下垂', '轮廓', '提拉', '拉皮'], q: ['抗衰', '热玛吉', '超声', '面部提升'], intro: '面部抗衰要看松弛程度和预算哦：轻中度首选光电类（热玛吉/超声炮/热拉提），中重度可以考虑线雕或拉皮' },
  { kw: ['瘦脸', '肉毒', 'botox', '除皱针', '瘦腿', '瘦肩'], q: ['肉毒', '保妥适', '衡力', '吉适', '乐提葆'], intro: '瘦脸/除皱用肉毒素，咱家有国产衡力、进口保妥适、吉适、韩国乐提葆四种可以选' },
  { kw: ['玻尿酸', '填充', '丰唇', '泪沟', '苹果肌填', '下巴'], q: ['玻尿酸', '胶原蛋白'], intro: '填充类玻尿酸和胶原蛋白的品牌档位都挺全的' },
  { kw: ['线雕', '埋线', 'ppdo', '悦升'], q: ['埋线', '悦升', 'PPDO', '童颜线'], intro: '线雕提升有PPDO、悦升线、童颜线、强生鱼骨线好几种线材' },
  { kw: ['脱毛', '腋毛', '唇毛', '比基尼'], q: ['脱毛'], intro: '冰点脱毛按部位算的，现在单次直接5折' },
  { kw: ['双眼皮', '重睑', '眼袋', '开眼角', '眼综合', '提肌'], q: ['眼部', '重睑', '眼袋'], intro: '眼部是咱家外科的招牌哦～佀医生和陈医生都是专攻眼整形20年的专家，从埋线7800到显微精细综合都有' },
  { kw: ['隆鼻', '鼻综合', '鼻头', '鼻翼', '鼻基底'], q: ['鼻部', '隆鼻'], intro: '鼻部从假体隆鼻到自体肋骨鼻综合都能做，叶医生、李健医生几位鼻整形口碑都很好' },
  { kw: ['隆胸', '丰胸', '假体', '乳房'], q: ['胸部', '曼托', '傲诺拉'], intro: '胸部有曼托、傲诺拉这些假体，也可以自体脂肪丰胸，谢医生专攻隆胸30多年了' },
  { kw: ['吸脂', '抽脂', '减脂', '瘦身', '冷冻减脂', '酷塑'], q: ['吸脂', '冷冻减脂', '形体'], intro: '塑形分两条路线：手术吸脂或者无创的酷塑冷冻减脂，手术这块张医生的分层紧肤体雕很有名' },
  { kw: ['脂肪填充', '自体脂肪', '丰臀'], q: ['自体脂肪', '科尔曼'], intro: '自体脂肪填充用的是科尔曼ARC金标准，第二次7折、第三次5折' },
  { kw: ['私密', '紧致术', '菲蜜丽', '蕊丽', '产后修复'], q: ['私密', '菲蜜丽', '阴道'], intro: '私密中心（Laqueen）从光电紧致到注射、手术都有，都是女医生接诊' },
  { kw: ['纹眉', '雾眉', '洗眉', '漂唇', '纹发', '半永久'], q: ['纹洗'], intro: '半永久纹绣（眉/唇/眼线/纹发）都在皮肤科做' },
  { kw: ['痣', '皮赘', '疣', '胎记', '老年斑', '汗管瘤'], q: ['病症'], intro: '祛痣祛疣这类按颗或面积算，很快的' },
  { kw: ['会员', '荟员', 'vip', '储值', '充值'], q: ['荟员', '充值'], intro: '咱家荟员一共5级（V1雏菊粉卡~V5铃兰黑卡），储值就有赠送金额和专属礼遇' },
  { kw: ['活动', '优惠', '政策', '折扣', '新客', '促销', '6月'], q: ['政策', '新客', '活动'], intro: '这个月是"高定大师季"（6.1-6.30），新客礼和限量卡项都挺划算的' },
  { kw: ['老带新', '推荐', '返'], q: ['老带新'], intro: '老带新有双重礼哦：爆款项目权益+返10%储值金' },
  { kw: ['明星产品', '瑞可丽', '海藻糖', '聚光尊', '月光瓶'], q: ['明星产品'], intro: '咱家明星产品这个月买二送一' },
  { kw: ['光子', 'opt', 'm22', 'ipl', 'dpl', '嫩肤'], q: ['脉冲光'], intro: '光子嫩肤全面部599起，M22可以祛斑退红祛痘嫩肤四选一' },
  { kw: ['美白', '暗沉', '暗黄', '提亮'], q: ['美白', '焕肤', '聚光尊', 'NIR'], intro: '美白提亮可以从光子、焕肤和微针美塑套组入手' },
  { kw: ['毛孔', '黑头'], q: ['毛孔', '微针', '点阵'], intro: '毛孔粗大一般用微针美塑、点阵激光和光子联合改善' },
  { kw: ['敏感', '泛红', '红血丝', '修复'], q: ['舒敏', '修护', '脉冲光'], intro: '敏感肌咱们有舒敏之星、瑞可丽蓝色修复套这些温和方案' },
  { kw: ['医生', '专家', '院长', '主任', '大夫', '医师'], q: ['医生团队', '佀医生', '陈医生'], intro: '咱家医生团队蛮强的：眼部有佀医生、陈医生两位专攻20年的专家，鼻部和面部提升有叶医生、李健医生（30年资历），轮廓找李志海医生，隆胸塑形有谢医生、张医生' },
  { kw: ['植发', '发际线', '种头发', '毛发'], q: ['毛发移植', '刘医生'], intro: '毛发移植有刘医生带的专业医护团队，发际线、眉毛、鬓角都能种' },
  { kw: ['种植牙', '种牙', '牙齿', '口腔', '正畸', '矫正', '贴面', '美白牙齿', '蛀牙', '拔牙', '隐适美', '牙冠', '烤瓷牙', '全瓷牙', '洁牙', '洗牙'], q: ['口腔', '种植', '正畸'], intro: '口腔美容是咱家特色科室哦～张医生和黄医生领衔，种植、正畸、贴面、美白都能做' },
];

function searchSections(queries, limit = 2) {
  const scored = [];
  for (const s of KB.sections) {
    let score = 0;
    for (const q of queries) {
      if (s.title.includes(q)) score += 5;
      const m = s.text.split(q).length - 1;
      score += Math.min(m, 4);
    }
    if (score > 0) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.s);
}

function trimSection(text, maxLines = 18) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + '\n（还有更多没列全，您到院还能看完整价目～）';
}

// 把长句按中文句末标点拆成短消息段（模拟真人一句一句发）
function splitShort(text) {
  return text.split(/(?<=[：。！？～])/g).map(s => s.trim()).filter(s => s.length > 0);
}

// 招呼语随机池（每个元素是一条短消息数组）
const GREET_POOL = [
  ['在的～', '我是华美顾问小美', '您想了解什么项目呀？'],
  ['在的呢', '我是小美，在华美做了五年多咨询', '有什么可以帮您的？'],
  ['嗯嗯在的～', '您想咨询哪方面呢？'],
  ['在的', '有什么可以帮您的？'],
];

// 返回 消息分段数组（模拟真人连发几条微信，每条≤20字）
function demoReply(userText) {
  const t = (userText || '').toLowerCase();
  const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

  if (/(机器人|是真人|是人吗|ai|人工智能|智能客服)/.test(t)) {
    return [
      '哈哈我是华美的顾问小美呀',
      '在院里做了五年多咨询啦',
      '您想了解什么项目？',
      '我帮您详细看下～',
    ];
  }
  if (/^(你好|您好|hi|hello|在吗|嗨)/.test(t.trim()) && t.length < 8) {
    return rand(GREET_POOL);
  }
  if (/(预约|面诊|地址|怎么去|电话|联系|挂号|到院)/.test(t)) {
    return [
      '好的呀，到院面诊免费的～',
      '医生会根据您情况定制方案',
      '方便留一下称呼和电话吗？',
    ];
  }
  let best = null, bestHits = 0;
  for (const intent of INTENTS) {
    const hits = intent.kw.filter(k => t.includes(k.toLowerCase())).length;
    if (hits > bestHits) { bestHits = hits; best = intent; }
  }
  if (best) {
    const secs = searchSections(best.q, 1);
    const segs = splitShort(best.intro);
    if (secs.length) {
      segs.push('发您看下价目表👇');
      segs.push(trimSection(secs[0].text.replace(/^#{1,2}.*\n/, '')));
    }
    // 只补充一句，不连发推销
    segs.push(
      '价格以到院面诊为准哈',
      '方便说说您的情况吗？',
    );
    return segs;
  }
  const words = t.replace(/[，。？！,.?!\s]+/g, ' ').split(' ').filter(w => w.length >= 2);
  const secs = searchSections(words, 1);
  if (secs.length) {
    return [
      '帮您查了下',
      trimSection(secs[0].text.replace(/^#{1,2}.*\n/, '')),
      '价格以到院面诊为准哈',
      '您还想了解哪方面？',
    ];
  }
  return [
    '亲，这个我帮您确认下细节哈～',
    '您可以直接说关注的部位或项目',
    '比如祛斑、水光、双眼皮这些',
    '我马上帮您查',
    '也可以约免费面诊，医生当面看更准',
  ];
}

// ---------- DeepSeek API 模式（OpenAI 兼容格式） ----------
async function deepseekReply(messages, systemPrompt) {
  const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'system', content: systemPrompt }, ...messages.map(m => ({ role: m.role, content: m.content }))],
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ---------- Claude API 模式 ----------
async function claudeReply(messages, systemPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024, system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// ---------- HTTP 服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.gif': 'image/gif',
};

function serveFile(req, res, fp, cacheSeconds = 0) {
  const headers = {
    'content-type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
    'content-length': fs.statSync(fp).size,
  };
  if (cacheSeconds > 0) headers['cache-control'] = `public, max-age=${cacheSeconds}`;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'access_code_required' }));
    }
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      try {
        const { messages } = JSON.parse(body || '{}');
        if (!Array.isArray(messages) || !messages.length) throw new Error('messages required');
        const lastUser = messages[messages.length - 1].content || '';
        let segments;
        if (PROVIDER === 'deepseek' || PROVIDER === 'claude') {
          const sysPrompt = buildFullSystemPrompt(lastUser);
          const raw = PROVIDER === 'deepseek'
            ? await deepseekReply(messages.slice(-20), sysPrompt)
            : await claudeReply(messages.slice(-20), sysPrompt);
          // 大模型自主决定发图：解析 [[图:标签]] 标记
          segments = expandImageMarkers(smartSplit(raw));
        } else {
          segments = demoReply(lastUser);
          // 本地模式：按话题关键词自动配图（匹配用户提问+第一条回复）
          for (const img of pickImages(lastUser + ' ' + (segments[0] || ''), 2)) {
            segments.push(`![${img.desc}](${img.url})`);
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ segments, reply: segments.join('\n\n'), mode: PROVIDER }));
      } catch (e) {
        console.error('[chat error]', e.message);
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      mode: PROVIDER,
      model: PROVIDER === 'deepseek' ? DEEPSEEK_MODEL : PROVIDER === 'claude' ? MODEL : null,
      kbDocs: KB.docs.map(d => d.name), kbSections: KB.sections.length, images: IMAGE_CATALOG.length,
      needsCode: !!ACCESS_CODE,
    }));
    return;
  }

  // 素材图片（assets压缩版优先，素材原图兜底；缓存7天）
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/assets/')) {
    const rel = decodeURIComponent(url.pathname.slice('/assets/'.length));
    const fp = resolveAsset(rel);
    if (fp) return serveFile(req, res, fp, 604800);
    res.writeHead(404); return res.end('Not Found');
  }

  // 静态文件
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = path.join(PUBLIC_DIR, path.normalize(file).replace(/^([.][.][\\/])+/, ''));
  if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return serveFile(req, res, fp);
  res.writeHead(404); res.end('Not Found');
});

// 端口被占用时自动顺延（最多尝试10个端口）
function listen(port, attempt = 0) {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && attempt < 10) {
      console.log(`端口 ${port} 被占用，改试 ${port + 1} …`);
      listen(port + 1, attempt + 1);
    } else { throw e; }
  });
  server.listen(port, () => {
    console.log(`[华美AI咨询Demo] http://localhost:${port}`);
    const modeDesc = {
      deepseek: `DeepSeek API (${DEEPSEEK_MODEL})`,
      claude: `Claude API (${MODEL})`,
      local: '本地检索演示模式（设置 DEEPSEEK_API_KEY 或 ANTHROPIC_API_KEY 后自动切换为大模型对话）',
    };
    console.log(`模式: ${modeDesc[PROVIDER]}`);
    console.log(`知识库: ${KB.docs.length} 个文档 / ${KB.sections.length} 个分节 / 配图素材 ${IMAGE_CATALOG.length} 张`);
  });
}
listen(BASE_PORT);
