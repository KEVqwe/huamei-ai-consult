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

// ---------- 知识库加载 ----------
function loadKnowledge() {
  const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));
  const docs = files.map(f => ({
    name: f.replace(/\.md$/, ''),
    text: fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf8'),
  }));
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
const SYSTEM_PROMPT =
  fs.readFileSync(path.join(ROOT, 'prompts', 'system.md'), 'utf8') +
  '\n\n' +
  KB.docs.map(d => `<知识库文档 name="${d.name}">\n${d.text}\n</知识库文档>`).join('\n\n');

// ---------- 图片素材目录（关键词 → 素材图，自动配图发给客户） ----------
const IMAGE_CATALOG = [
  { file: '明星产品/瑞可丽中胚产品/组合 拷贝.jpg', tags: ['瑞可丽', '中胚', '胶原'], desc: '瑞可丽中胚产品系列' },
  { file: '明星产品/瑞可丽中胚产品/瑞可丽天鹅童颜/天鹅童颜.jpg', tags: ['天鹅童颜'], desc: '瑞可丽天鹅童颜' },
  { file: '明星产品/瑞可丽居家产品/组合(1).jpg', tags: ['居家', '面膜', '修复乳', '护肤品'], desc: '瑞可丽居家产品系列' },
  { file: '明星产品/明星产品价格表/明星产品政策-01.jpg', tags: ['明星产品'], desc: '明星产品价格表' },
  { file: '6月份政策/明星产品/明星产品-01.jpg', tags: ['买二送一', '海藻糖', '聚光尊', '月光瓶', '豆仙优', '舒敏适'], desc: '本月明星产品（买二送一）' },
  { file: '6月份政策/皮肤政策/奇迹水/奇迹水-01.jpg', tags: ['奇迹水', '黑眼圈', '鱼尾纹', '眼周'], desc: '奇迹水眼周年轻化方案' },
  { file: '6月份政策/皮肤政策/童颜水光/童颜水光-01.png', tags: ['童颜水光', '水光'], desc: '童颜水光' },
  { file: '6月份政策/皮肤政策/颈部抗衰方案/颈部抗衰-01.jpg', tags: ['颈纹', '颈部'], desc: '颈部抗衰方案' },
  { file: '6月份政策/皮肤政策/七色彩虹方产品说明/七色彩红方-01.jpg', tags: ['七色彩虹', '焕肤'], desc: '七色彩虹方焕肤' },
  { file: '6月份政策/皮肤政策/皮肤活动爆品区/皮肤爆品区-01.jpg', tags: ['爆品', '皮肤活动'], desc: '皮肤科活动爆品' },
  { file: '6月份政策/皮肤套餐/皮肤套餐-01.jpg', tags: ['皮肤套餐'], desc: '皮肤美容套餐' },
  { file: '6月份政策/微整政策/微整政策/微整-01.jpg', tags: ['微整', '玻尿酸', '肉毒', '瘦脸'], desc: '微整形本月政策' },
  { file: '6月份政策/微整政策/十二星品套餐/3.png', tags: ['十二星品'], desc: '十二星品套餐' },
  { file: '6月份政策/微整政策/微整星品/RUIKELI IPAD 案例0508ai-01.jpg', tags: ['案例', '效果'], desc: '真实案例参考' },
  { file: '6月份政策/外科政策/外科-01.jpg', tags: ['外科', '整形', '手术', '双眼皮', '隆鼻', '吸脂'], desc: '整形外科本月政策' },
  { file: '6月份政策/私密政策/私密-01.jpg', tags: ['私密', '菲蜜丽', '蕊丽'], desc: '私密项目本月政策' },
  { file: '6月份政策/老带新/老带新-01.jpg', tags: ['老带新', '推荐好友'], desc: '老带新双重礼' },
  { file: '6月份政策/政策（全院）/全院-01.jpg', tags: ['活动', '储值', '充值', '高定大师季', '新客'], desc: '本月高定大师季全院政策' },
  { file: '荟员升级权益/1.png', tags: ['会员', '荟员', 'vip'], desc: '荟员权益 V1雏菊粉卡' },
  { file: '荟员升级权益/3.png', tags: ['金卡'], desc: '荟员权益 V3玫瑰金卡' },
  // 医生介绍（问到医生或高关联项目时发）
  { file: '医生介绍/整形外科/佀同帅/【佀同帅个人介绍】长图修改.jpg', tags: ['佀同帅', '显微眼', '眼整形医生'], desc: '佀同帅院长（眼部整形）' },
  { file: '医生介绍/整形外科/陈小剑/陈小剑个人简介长图.jpg', tags: ['陈小剑', '5M精雕', '重睑修复'], desc: '陈小剑主任（眼部整形）' },
  { file: '医生介绍/整形外科/叶丽萍/叶丽萍个人总介绍.jpg', tags: ['叶丽萍', '海鸥线'], desc: '叶丽萍医生（鼻整形/面部提升）' },
  { file: '医生介绍/整形外科/李健/李健-个人总介绍.jpg', tags: ['李健', '脊状肋'], desc: '李健医生（鼻整形/隆胸/面部年轻化）' },
  { file: '医生介绍/整形外科/张朋/【张朋个人介绍】总介绍修改.jpg', tags: ['张朋', '体雕'], desc: '张朋院长（鼻整形/吸脂塑形）' },
  { file: '医生介绍/整形外科/谢卫国/谢卫国个人总介绍.jpg', tags: ['谢卫国', '动感隆胸'], desc: '谢卫国医生（隆胸/自体脂肪）' },
  { file: '医生介绍/整形外科/胡小清/胡小清个人总介绍.jpg', tags: ['胡小清', 'park法', '育唇'], desc: '胡小清医生（眼整形/唇部/私密）' },
  { file: '医生介绍/整形外科/李志海/李志海个人介绍.jpg', tags: ['李志海', '下颌角', '颧骨', '轮廓', '磨骨', '改脸型'], desc: '李志海院长（颌面轮廓）' },
  { file: '医生介绍/微整形医生团.jpg', tags: ['微整医生', '注射医生'], desc: '微整形医生团队' },
  { file: '医生介绍/毛发移植科/刘学新 主任/刘学新个人介绍.jpg', tags: ['刘学新', '植发', '毛发移植', '发际线', '种植'], desc: '刘学新主任（毛发移植）' },
  { file: '医生介绍/特邀专家/韩国医生专家团.jpg', tags: ['韩国专家', '特邀专家'], desc: '韩国医生专家团' },
];
function pickImages(text, max = 2) {
  const t = (text || '').toLowerCase();
  const hits = [];
  for (const img of IMAGE_CATALOG) {
    const n = img.tags.filter(k => t.includes(k.toLowerCase())).length;
    if (n > 0) hits.push({ img, n });
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
  { kw: ['双眼皮', '重睑', '眼袋', '开眼角', '眼综合', '提肌'], q: ['眼部', '重睑', '眼袋'], intro: '眼部是咱家外科的招牌哦～佀同帅院长和陈小剑主任都是专攻眼整形20年的专家，从埋线7800到显微精细综合都有' },
  { kw: ['隆鼻', '鼻综合', '鼻头', '鼻翼', '鼻基底'], q: ['鼻部', '隆鼻'], intro: '鼻部从假体隆鼻到自体肋骨鼻综合都能做，叶丽萍、李健几位医生的鼻整形口碑都很好' },
  { kw: ['隆胸', '丰胸', '假体', '乳房'], q: ['胸部', '曼托', '傲诺拉'], intro: '胸部有曼托、傲诺拉这些假体，也可以自体脂肪丰胸，谢卫国医生专攻隆胸30多年了' },
  { kw: ['吸脂', '抽脂', '减脂', '瘦身', '冷冻减脂', '酷塑'], q: ['吸脂', '冷冻减脂', '形体'], intro: '塑形分两条路线：手术吸脂或者无创的酷塑冷冻减脂，手术这块张朋院长的分层紧肤体雕很有名' },
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
  { kw: ['医生', '专家', '院长', '主任', '大夫', '医师'], q: ['医生团队', '佀同帅', '陈小剑'], intro: '咱家医生团队蛮强的：眼部有佀同帅、陈小剑两位专攻20年的专家，鼻子和面部提升有叶丽萍、李健（30年资历），轮廓找李志海院长，隆胸塑形有谢卫国、张朋' },
  { kw: ['植发', '发际线', '种头发', '毛发'], q: ['毛发移植', '刘学新'], intro: '毛发移植有刘学新主任带的专业医护团队，发际线、眉毛、鬓角都能种' },
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

// 返回 消息分段数组（模拟真人连发几条微信）
function demoReply(userText) {
  const t = (userText || '').toLowerCase();
  if (/(机器人|是真人|是人吗|ai|人工智能|智能客服)/.test(t)) {
    return ['哈哈我是华美的顾问小美呀😊 在院里做了五年多咨询啦', '您刚才想了解什么项目？我帮您详细看下～'];
  }
  if (/^(你好|您好|hi|hello|在吗|嗨)/.test(t.trim()) && t.length < 8) {
    return ['亲，在的哦～我是华美的美学顾问小美😊', '您最近是想改善皮肤，还是想了解什么项目呀？祛斑、抗衰、瘦脸、双眼皮这些都可以问我～'];
  }
  if (/(预约|面诊|地址|怎么去|电话|联系|挂号|到院)/.test(t)) {
    return [
      '好的呀～到院面诊是免费的，医生会根据您的情况定制方案😊',
      '方便留一下您的称呼和联系电话吗？想面诊的项目和大概时间也说一下，我这边帮您约～',
      '对了，新朋友到院面诊还能免费领基础水光/光子嫩肤/面膜/舒敏之星/私密SPA体验（5选1）哦🌸',
    ];
  }
  let best = null, bestHits = 0;
  for (const intent of INTENTS) {
    const hits = intent.kw.filter(k => t.includes(k.toLowerCase())).length;
    if (hits > bestHits) { bestHits = hits; best = intent; }
  }
  if (best) {
    const secs = searchSections(best.q, 1);
    const segs = [best.intro + '～'];
    if (secs.length) {
      segs.push('我把相关的价目发您看下👇\n\n' + trimSection(secs[0].text.replace(/^#{1,2}.*\n/, '')));
    }
    segs.push('这个月正好有"高定大师季"活动，新客任意消费还送AOPT超光子嫩肤1次😊 价格以到院面诊为准哈。\n\n方便说说您的具体情况吗？部位、困扰多久了、有没有做过类似项目～');
    return segs;
  }
  const words = t.replace(/[，。？！,.?!\s]+/g, ' ').split(' ').filter(w => w.length >= 2);
  const secs = searchSections(words, 1);
  if (secs.length) {
    return [
      '帮您查到了相关的信息👇\n\n' + trimSection(secs[0].text.replace(/^#{1,2}.*\n/, '')),
      '价格以到院面诊为准哈～您还想了解哪方面？',
    ];
  }
  return [
    '亲，这个我帮您确认下细节哈～',
    '您可以直接说关注的部位或项目（比如：祛斑、水光、双眼皮、瘦脸针、热玛吉、脱毛、会员权益、本月活动），我马上帮您查😊 或者约个免费面诊，医生当面给您看更准～',
  ];
}

// ---------- DeepSeek API 模式（OpenAI 兼容格式） ----------
async function deepseekReply(messages) {
  const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages.map(m => ({ role: m.role, content: m.content }))],
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ---------- Claude API 模式 ----------
async function claudeReply(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT,
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
          const raw = PROVIDER === 'deepseek' ? await deepseekReply(messages.slice(-20)) : await claudeReply(messages.slice(-20));
          segments = raw.split('|||').map(s => s.trim()).filter(Boolean);
        } else {
          segments = demoReply(lastUser);
        }
        // 按话题自动配图（像真人顾问随手发图）：匹配用户提问+第一条回复（提到医生名/项目名会带图；不匹配结尾的活动话术，避免每次都发政策图）
        for (const img of pickImages(lastUser + ' ' + (segments[0] || ''), 2)) {
          segments.push(`![${img.desc}](${img.url})`);
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
