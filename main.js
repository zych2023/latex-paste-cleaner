// main.js — Latex Paste Cleaner（单文件：核心引擎 + 插件入口）
// Obsidian 插件加载器不支持相对路径 require，故全部逻辑内联于此文件。
// 核心函数（tokenize/cleanMath/cleanText/clean/hasMathSignals）在文件末尾额外导出，
// 供 Node 测试（tests/test-cleaner.cjs 通过 mock obsidian 模块加载本文件）。
'use strict';
const { Plugin, PluginSettingTab, Setting } = require('obsidian');

// ============================================================================
// 核心引擎：公式边界识别与分区处理（纯函数，无 Obsidian 依赖）
// ============================================================================

// 交替模式顺序 = 优先级（同一位置先匹配的分支胜出）：
//   1. 代码围栏 ``` 与 ~~~（原样保护）
//   2. $$...$$（跨行）
//   3. 双重转义 \\[...\\]、\\\\(...\\\\)（先消费，防半截匹配；整体匹配，内容门控在
//      tokenize 分类做：\\( 圆括号双转义无合法文本用途 → 无条件 math；\\[ 方括号双转义
//      （markdown 转义合法）→ hasCmd 门控。注意不能用 tempered-dot 守卫拒绝整体消费，
//      否则对称 2bs 包裹 + 2bs 命令（MathJax 2 网页格式）会落回单转义分支产生 \$ 损坏）
//   4. \[...\]、\\(...\\)（弱信号：需内容含命令特征）
//   5. $...$（不跨行；$$ 分支已先行消费跨行块）
//   6. 错配/方向错误（半对分隔符）：$...\)、\(...$、\[...$$、$$...\]、\]...\[、\]...\)
//      （注意：\(...$ 与 \[...$$ 不以 $/\] 开头，落到 else 分支走 hasCmd 门控——
//      如 \(x$ 无命令特征时保守按 text，行为保留，非一律 math）
//   7. 裸 [ ... ] 独立成行（m 标志；需内容含命令特征）
// \begin{env}...\end{env} 不在此正则：主循环用 matchEnvEnd 手动深度配对（支持嵌套），见下
const BOUNDARY_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|\$\$[\s\S]*?\$\$|\\\\\[[\s\S]*?\\\\\]|\\\\\([\s\S]*?\\\\\)|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]*?\$|\$[^$\n]*?\\\)|\\\([^$\n]*?\$|\\\[[^$\n]*?\$\$|\$\$[\s\S]*?\\\]|\\\][\s\S]*?\\\[|\\\][^\n]*?\\\)|^\[([\s\S]*?)\][ \t]*$/gm;

// 弱信号边界的内容验证：含 "\后跟字母"（LaTeX 命令特征）
function hasCmd(s) {
  return /\\[A-Za-z]/.test(s);
}

// 配对 \begin{...} 到配平的 \end{...}；返回结束位置（不含），未闭合返回 -1
function matchEnvEnd(text, start) {
  const ENV_RE = /\\begin\{[^{}]*\}|\\end\{[^{}]*\}/g;
  ENV_RE.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = ENV_RE.exec(text)) !== null) {
    depth += m[0].startsWith('\\begin') ? 1 : -1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

function tokenize(text) {
  const tokens = [];
  const re = new RegExp(BOUNDARY_RE.source, BOUNDARY_RE.flags);
  const BEGIN_RE = /\\begin\{[^{}]*\}/g;
  let last = 0;
  while (last < text.length) {
    re.lastIndex = last;
    const a = re.exec(text);
    BEGIN_RE.lastIndex = last;
    const b = BEGIN_RE.exec(text);
    const ai = a === null ? Infinity : a.index;
    const bi = b === null ? Infinity : b.index;
    if (ai === Infinity && bi === Infinity) break;
    if (ai <= bi) {
      if (ai > last) tokens.push({ type: 'text', content: text.slice(last, ai) });
      const s = a[0];
      if (s.startsWith('```') || s.startsWith('~~~')) {
        tokens.push({ type: 'code', content: s });
      } else if (s.startsWith('$$')) {
        tokens.push({ type: 'math', content: s });
      } else if (s.startsWith('[')) {
        // 裸 [ ] 块公式：内容验证；通过则补全 $$ 包裹（+ 修复），否则原文保留
        if (hasCmd(a[1])) {
          tokens.push({ type: 'math', content: '$$\n' + a[1].trim() + '\n$$' });
        } else {
          tokens.push({ type: 'text', content: s });
        }
      } else if (s.startsWith('$')) {
        // $...$ 分支：无命令特征且含 CJK 的配对（价格/文本场景）→ 非公式，保留原文
        const inner = s.slice(1, -1);
        if (!/\\/.test(inner) && /[\u4e00-\u9fff]/.test(inner)) {
          tokens.push({ type: 'text', content: s });
        } else {
          tokens.push({ type: 'math', content: s });
        }
      } else if (s.startsWith('\\\\')) {
        // 双重转义：\\( 圆括号双转义无合法文本用途 → 无条件 math（MathJax 2 网页格式）；
        // \\[ 方括号双转义（markdown 转义合法，如标题里的 \\[0,2π]）→ hasCmd 门控
        if (s[2] === '(' || hasCmd(s)) {
          tokens.push({ type: 'math', content: s });
        } else {
          tokens.push({ type: 'text', content: s });
        }
      } else if (s.startsWith('\\]')) {
        // 方向/混合错配（\] 开头）——直接视为公式，内容无需命令特征
        tokens.push({ type: 'math', content: s });
      } else {
        tokens.push(hasCmd(s) ? { type: 'math', content: s } : { type: 'text', content: s });
      }
      last = ai + s.length;
    } else {
      // \begin 起点：深度配对（嵌套安全）
      const end = matchEnvEnd(text, bi);
      if (end === -1) {
        // 未闭合：原样保留为 text（保守），跳过该起点（推进到下一边界，防死循环）
        const upto = ai === Infinity ? text.length : ai;
        tokens.push({ type: 'text', content: text.slice(last, upto) });
        last = upto;
      } else {
        if (bi > last) tokens.push({ type: 'text', content: text.slice(last, bi) });
        const body = text.slice(bi, end);
        tokens.push({ type: 'math', content: /^\$\s*\\begin/.test(body) ? body : '$$\n' + body.trim() + '\n$$' });
        last = end;
      }
    }
  }
  if (last < text.length) tokens.push({ type: 'text', content: text.slice(last) });
  // 合并相邻 text（$ 价格配对、未闭合 begin 等被判为 text 的边界区与前后文本合一）
  const merged = [];
  for (const t of tokens) {
    const p = merged[merged.length - 1];
    if (p && p.type === 'text' && t.type === 'text') p.content += t.content;
    else merged.push(t);
  }
  return merged;
}

// ---------- 触发检测 ----------
function hasMathSignals(text) {
  // 触发特征：\( \[ $$ \begin{ 及 "\后接 2+ 字母" 的命令词。
  // 命令词仅在紧跟 ASCII 字母/反斜杠/空白时排除（如路径 C:\Users\foo 路径 不触发）；
  // 行尾（如 C:\Users\foo 直达串尾）与全角标点（如 D:\Obb\zuoyecihua，见上文）后仍会触发——
  // 无害：触发后 tokenize 找不到公式区时只修 HTML 实体。
  return /\\\(|\\\[|\$\$|\\begin\{|\\[A-Za-z]{2,}(?![A-Za-z\\\s])/.test(text);
}

// ---------- 普通区：仅 HTML 实体修复 ----------
function cleanText(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ---------- 整篇清理 ----------
function clean(text, opts) {
  const fixEntities = !opts || opts.fixEntities !== false;
  const tokens = tokenize(text);
  let out = '';
  for (const t of tokens) {
    if (t.type === 'math') out += cleanMath(t.content);
    else if (t.type === 'text' && fixEntities) out += cleanText(t.content);
    else out += t.content; // code 原样；text 且 fixEntities=false 时原样
  }
  return out;
}

// ---------- 公式区内清理管线（移植 Templates/latex-clean.md，作用域限定公式区） ----------

// 命令名列表（用于双重转义降级）
const MATH_CMDS =
  'mathbb|mathbf|mathit|mathrm|mathcal|mathfrak|boldsymbol|pmb|text|widehat|widetilde|overline|underline|' +
  'overrightarrow|overleftarrow|hat|bar|vec|dot|ddot|tilde|boxed|operatorname|begin|end|left|right|' +
  'frac|sqrt|dfrac|tfrac|cfrac|binom|sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|log|ln|lg|exp|lim|' +
  'max|min|sup|inf|arg|deg|det|dim|gcd|lcm|mod|bmod|pmod|dots|cdots|vdots|ddots|ldots|over|under|' +
  'stackrel|overset|underset|quad|qquad|textstyle|displaystyle|scriptstyle|scriptscriptstyle|' +
  'sum|prod|int|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|sigma|omega|phi|rho|partial|' +
  'infty|times|div|pm|mp|cdot|leq|geq|neq|equiv|sim|approx|propto|subset|supset|subseteq|supseteq|' +
  'in|notin|forall|exists|cup|cap|emptyset|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|' +
  'nabla|Delta|Gamma|Omega|Sigma|Pi|Lambda';

function cleanMath(tex) {
  let c = tex;

  // 0. 命令碎片重组（HTML 渲染交错：\boldsymbol{ 被插入的公式 \(...\) 劈开，命令字符错位合并，
  //    如 \bol\(\mathrm{d}s\)ymbol{ 实际是 \boldsymbol{——插入公式的 ds 与命令缺失字符重叠）。
  //    必须在剥离/降级之前执行（原始形态才匹配）。垃圾可为 \(...\) \[...\] $...$ 之一或多个
  c = c.replace(/\\bol(?:\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$[^\n]*?\$)+ymbol\{/g, '\\boldsymbol{');
  c = c.replace(/\\bold(?:\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$[^\n]*?\$)+symbol\{/g, '\\boldsymbol{');

  // 1. 降级双重转义（必须最先）
  c = c.replace(/\\\\\(/g, '\\(');
  c = c.replace(/\\\\\)/g, '\\)');
  c = c.replace(/\\\\\[/g, '\\[');
  c = c.replace(/\\\\\]/g, '\\]');
  c = c.replace(/\\\\\{/g, '\\{');
  c = c.replace(/\\\\\}/g, '\\}');
  // 命令双重转义 \\mathbb → \mathbb（'\\\\\\\\(?:' 字面量 = 正则源码 \\\\ = 匹配 2 字面反斜杠）
  c = c.replace(new RegExp('\\\\\\\\(?:' + MATH_CMDS + ')\\b', 'g'), (mm) => '\\' + mm.slice(2));

  // 2. 外层多重包裹（顺序重要：$$ 包裹先于 $ 包裹，否则 $$\[...\]$$ 会被 $\[...\]$ 半截吃掉）
  c = c.replace(/\$\$\\\(([\s\S]*?)\\\)\$\$/g, (_, e) => `$$\n${e.trim()}\n$$`);
  c = c.replace(/\$\$\\\[([\s\S]*?)\\\]\$\$/g, (_, e) => `$$\n${e.trim()}\n$$`);
  c = c.replace(/\$\\\(([\s\S]*?)\\\)\$/g, (_, e) => `$${e.trim()}$`);
  c = c.replace(/\$\\\[([\s\S]*?)\\\]\$/g, (_, e) => `$$\n${e.trim()}\n$$`);

  // 3. \left\( \right\) 修复（必须在 2.5 剥离之前，否则 \left\( 的 \( 会被剥掉）
  c = c.replace(/\\left\\\(/g, '\\left(');
  c = c.replace(/\\right\\\)/g, '\\right)');
  c = c.replace(/\\left\\\[/g, '\\left[');
  c = c.replace(/\\right\\\]/g, '\\right]');
  c = c.replace(/\\left\s*\\\{/g, '\\left\\{');
  c = c.replace(/\\right\s*\\\}/g, '\\right\\}');

  // 2.5 剥离内部 \( \) \[ \] 定界符垃圾（网页复制层叠转义；HTML 手术提取的 annotation 源码
  // 也常带 MathJax 定界符包裹）。仅"干净裸包裹"（\(...\) 整体且内部无嵌套定界符，
  // 即 tokenize 的单转义 token）保留给阶段 6 转 $；其余含定界符的输入：
  //   收缩连续转义（\(\( → \(）→ 剥离 → 花括号平衡
  // 末尾错配 \)$ 的 \）由阶段 7 修复（补闭合），此处不剥离
  const trimmed = c.trim();
  const bareInlineInner = trimmed.replace(/^\\\(/, '').replace(/\\\)$/, '');
  const bareBlockInner = trimmed.replace(/^\\\[/, '').replace(/\\\]$/, '');
  const isCleanBare = (/^\\\([\s\S]*\\\)$/.test(trimmed) && !/\\\(|\\\)/.test(bareInlineInner)) ||
    (/^\\\[[\s\S]*\\\]$/.test(trimmed) && !/\\\[|\\\]/.test(bareBlockInner));
  const isReversed = /^\\\]/.test(trimmed); // 方向错配 \]...\[（阶段 7 修复，不剥离）
  if (!isCleanBare && !isReversed && /\\\(|\\\)|\\\[|\\\]/.test(c)) {
    // 保护 $ 开头输入中末尾的 \）——错配 $...\)（阶段 7 补闭合），不剥离
    if (/^\$/.test(trimmed)) c = c.replace(/\\\)(?=\$|$)/g, '__RP__');
    let guard = 0;
    while (/\\\(\\\(/.test(c) && guard < 20) { c = c.replace(/\\\(\\\(/g, '\\('); guard++; }
    guard = 0;
    while (/\\\)\\\)/.test(c) && guard < 20) { c = c.replace(/\\\)\\\)/g, '\\)'); guard++; }
    guard = 0;
    while (/\\\[\\\[/.test(c) && guard < 20) { c = c.replace(/\\\[\\\[/g, '\\['); guard++; }
    guard = 0;
    while (/\\\]\\\]/.test(c) && guard < 20) { c = c.replace(/\\\]\\\]/g, '\\]'); guard++; }
    c = c.replace(/\\\(/g, '').replace(/\\\)/g, '');
    c = c.replace(/\\\[/g, '[').replace(/\\\]/g, ']');
    c = c.replace(/__RP__/g, '\\)'); // 恢复末尾错配 \）

    // 花括号平衡修复：网页畸形输入剥除后可能出现 } 多于 {（如 3 个 \boldsymbol{ 却 4 个 }），
    // 从尾部删除多余的 } 使 { } 配平（LaTeX 命令块的闭括号总在末尾）
    let opens = (c.match(/\{/g) || []).length;
    let closes = (c.match(/\}/g) || []).length;
    while (closes > opens) {
      const i = c.lastIndexOf('}');
      if (i === -1) break;
      c = c.slice(0, i) + c.slice(i + 1);
      closes--;
    }
  }
  // 4. 命令内部嵌套分隔符
  c = c.replace(
    /\\(mathbf|mathit|mathrm|mathcal|mathfrak|mathbb|text|textbf|textit|texttt|textsf|textrm|textmd|textup|textnormal|boldsymbol|pmb|widehat|widetilde|overline|underline|overrightarrow|overleftarrow|hat|bar|vec|dot|ddot|mathop|operatorname|boxed|color|textcolor|fbox|mbox|emph|textsc|textsl)\s*\{\s*\\\(([\s\S]*?)\\\)\s*\}/g,
    (_, cmd, e) => `\\${cmd}{${e.trim()}}`
  );
  c = c.replace(
    /\\(mathbf|mathit|mathrm|mathcal|mathfrak|mathbb|text|textbf|textit|texttt|textsf|textrm|boldsymbol|pmb|widehat|widetilde|overline|underline|boxed)\s*\{\s*\\\[([\s\S]*?)\\\]\s*\}/g,
    (_, cmd, e) => `\\${cmd}{${e.trim()}}`
  );
  c = c.replace(
    /\\(mathbb|mathbf|mathit|mathrm|mathcal|mathfrak|boldsymbol|pmb|text|textbf|textit|texttt)\s*\\\(([\s\S]*?)\\\)/g,
    (_, cmd, e) => `\\${cmd}{${e.trim()}}`
  );

  // 5. 命令后花括号转义
  c = c.replace(
    /\\(mathbb|mathbf|mathit|mathrm|mathcal|mathfrak|boldsymbol|pmb|text|widehat|widetilde|overline|underline|overrightarrow|overleftarrow|hat|bar|vec|dot|ddot|boxed)\s*\\\{([^}]*?)\\\}/g,
    (_, cmd, e) => `\\${cmd}{${e.trim()}}`
  );
  c = c.replace(/\\mathbb\{\s*\\mathbb\{([^}]*?)\}\s*\}/g, (_, e) => `\\mathbb{${e.trim()}}`);
  // 嵌套命令收缩（\mathbf{\boldsymbol{x}} → \mathbf{x}）——循环至稳定，支持任意深度
  const NEST_CMD_RE = /\\(mathbf|mathit|mathrm|mathcal|mathfrak|boldsymbol)\{\s*\\(?:mathbf|mathit|mathrm|mathcal|mathfrak|boldsymbol)\{([^}]*?)\}\s*\}/g;
  for (let i = 0; i < 20; i++) {
    const next = c.replace(NEST_CMD_RE, (_, cmd, e) => `\\${cmd.trim()}{${e.trim()}}`);
    if (next === c) break;
    c = next;
  }

  // 6. 分隔符 → $ / $$
  c = c.replace(/\\\(([\s\S]*?)\\\)/g, (_, e) => `$${e.trim()}$`);
  c = c.replace(/\\\[([\s\S]*?)\\\]/g, (_, e) => `$$\n${e.trim()}\n$$`);

  // 7. 错配与方向错误
  c = c.replace(/\$([^$\n]*?)\\\)/g, (_, e) => `$${e}$`);
  c = c.replace(/\\\(([^$]*?)\$/g, (_, e) => `$${e}`);
  c = c.replace(/\$\$([\s\S]*?)\\\]/g, (_, e) => `$$\n${e.trim()}\n$$`);
  c = c.replace(/\\\[([\s\S]*?)\$\$/g, (_, e) => `$$\n${e.trim()}\n$$`);
  c = c.replace(/\\\]([\s\S]*?)\\\[/g, (_, e) => `$$\n${e.trim()}\n$$`);
  c = c.replace(/\\\]([^\n]*?)\\\)/g, (_, e) => `$${e.trim()}$`);

  // 8. HTML 实体（公式区内，含数学实体）
  c = c
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&times;/g, '\\times').replace(/&divide;/g, '\\div').replace(/&plusmn;/g, '\\pm')
    .replace(/&minus;/g, '-').replace(/&le;/g, '\\le').replace(/&ge;/g, '\\ge').replace(/&ne;/g, '\\ne')
    .replace(/&equiv;/g, '\\equiv').replace(/&sim;/g, '\\sim').replace(/&prop;/g, '\\propto')
    .replace(/&infin;/g, '\\infty').replace(/&rarr;/g, '\\rightarrow').replace(/&larr;/g, '\\leftarrow')
    .replace(/&rArr;/g, '\\Rightarrow').replace(/&lArr;/g, '\\Leftarrow').replace(/&hArr;/g, '\\Leftrightarrow')
    .replace(/&sum;/g, '\\sum').replace(/&prod;/g, '\\prod').replace(/&int;/g, '\\int')
    .replace(/&part;/g, '\\partial')
    .replace(/&alpha;/g, '\\alpha').replace(/&beta;/g, '\\beta').replace(/&gamma;/g, '\\gamma')
    .replace(/&delta;/g, '\\delta').replace(/&epsilon;/g, '\\epsilon').replace(/&theta;/g, '\\theta')
    .replace(/&lambda;/g, '\\lambda').replace(/&mu;/g, '\\mu').replace(/&pi;/g, '\\pi')
    .replace(/&sigma;/g, '\\sigma').replace(/&omega;/g, '\\omega').replace(/&phi;/g, '\\phi');

  // 9. begin/end 环境被 $ 包裹修复（(?<!\$)...(?!\$) 防 $$ 包裹时半截匹配）
  c = c.replace(/(?<!\$)\$\s*(\\begin\{([^}]*?)\}[\s\S]*?\\end\{\2\})\s*\$(?!\$)/g, (_, body) => `$$\n${body.trim()}\n$$`);
  c = c.replace(/\$\$\s*(\\begin\{)/g, (_, b) => `$$\n${b}`);
  c = c.replace(/(\\end\{[^}]*?\})\s*\$\$/g, (_, e) => `${e}\n$$`);

  // 10. 通用格式清理
  c = c.replace(
    /\\(mathbb|mathbf|mathit|mathrm|mathcal|mathfrak|boldsymbol|pmb|text|hat|bar|vec|dot|ddot|tilde)\s+\{/g,
    (_, cmd) => `\\${cmd}{`
  );
  c = c.replace(
    /\\(mathbb|mathbf|mathit|mathrm|mathcal|mathfrak|boldsymbol|pmb|text)\{\s+([^}]*?)\s+\}/g,
    (_, cmd, e) => `\\${cmd}{${e.trim()}}`
  );
  c = c.replace(/\\operatorname\s+([A-Za-z])/g, (_, ch) => `\\operatorname{${ch}}`);

  // 11. Unicode 数学符号 → LaTeX（仅公式区内！）
  c = c.replace(/≤/g, '\\le ').replace(/≥/g, '\\ge ').replace(/≠/g, '\\ne ')
    .replace(/×/g, '\\times ').replace(/÷/g, '\\div ').replace(/±/g, '\\pm ')
    .replace(/∞/g, '\\infty ').replace(/→/g, '\\rightarrow ').replace(/←/g, '\\leftarrow ')
    .replace(/⇒/g, '\\Rightarrow ').replace(/⇐/g, '\\Leftarrow ').replace(/⇔/g, '\\Leftrightarrow ')
    .replace(/∑/g, '\\sum ').replace(/∏/g, '\\prod ').replace(/∫/g, '\\int ')
    .replace(/∂/g, '\\partial ').replace(/√/g, '\\sqrt{}').replace(/∼/g, '\\sim ')
    .replace(/≈/g, '\\approx ').replace(/≡/g, '\\equiv ').replace(/∝/g, '\\propto ')
    .replace(/∈/g, '\\in ').replace(/∉/g, '\\notin ').replace(/⊂/g, '\\subset ')
    .replace(/⊃/g, '\\supset ').replace(/⊆/g, '\\subseteq ').replace(/⊇/g, '\\supseteq ')
    .replace(/∪/g, '\\cup ').replace(/∩/g, '\\cap ').replace(/∅/g, '\\emptyset ')
    .replace(/∀/g, '\\forall ').replace(/∃/g, '\\exists ').replace(/¬/g, '\\neg ')
    .replace(/∧/g, '\\land ').replace(/∨/g, '\\lor ')
    .replace(/⟨/g, '\\langle ').replace(/⟩/g, '\\rangle ')
    .replace(/α/g, '\\alpha ').replace(/β/g, '\\beta ').replace(/γ/g, '\\gamma ')
    .replace(/δ/g, '\\delta ').replace(/ε/g, '\\epsilon ').replace(/θ/g, '\\theta ')
    .replace(/λ/g, '\\lambda ').replace(/μ/g, '\\mu ').replace(/π/g, '\\pi ')
    .replace(/σ/g, '\\sigma ').replace(/ω/g, '\\omega ').replace(/φ/g, '\\phi ')
    .replace(/ρ/g, '\\rho ')
    .replace(/Δ/g, '\\Delta ').replace(/Γ/g, '\\Gamma ').replace(/Ω/g, '\\Omega ')
    .replace(/Σ/g, '\\Sigma ').replace(/Π/g, '\\Pi ').replace(/Λ/g, '\\Lambda ')
    .replace(/…/g, '\\dots ');

  // 11b. 折叠命令替换产生的双空格：\ge + 原文空格 → \ge 单空格
  c = c.replace(/(\\[A-Za-z]+\s)\s+/g, '$1');

  // 12. 收尾
  c = c.replace(/\$\$\n{3,}\$\$/g, '$$\n\n$$');
  c = c.replace(/[ \t]+$/gm, '');
  return c;
}

// ============================================================================
// HTML 手术：只替换公式节点，其余 HTML 原样保留
// ============================================================================

// 从公式节点提取 LaTeX 源码：优先 MathJax/KaTeX 内嵌的 annotation
function extractTex(node) {
  const ann = node.querySelector
    ? node.querySelector('annotation[encoding="application/x-tex"]')
    : null;
  if (ann && ann.textContent.trim()) return ann.textContent.trim();
  const ann2 = node.querySelector ? node.querySelector('annotation') : null;
  if (ann2 && ann2.textContent.trim()) return ann2.textContent.trim();
  return null; // 提取不到 → 保守不动
}

// 判断块级/行内：MathJax 3 的 mjx-container 有 display 属性；MathML 的 math 有 display 属性；
// KaTeX 块级公式根节点有 katex-display 类
function isDisplayMath(node) {
  if (node.classList && node.classList.contains('katex-display')) return true;
  if (node.getAttribute && node.getAttribute('display') === 'true') return true;
  const math = node.querySelector ? node.querySelector('math') : null;
  return !!(math && math.getAttribute('display') === 'block');
}

// 手术：公式节点 → 纯文本 LaTeX，其余 HTML 不动
function surgeryHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = doc.querySelectorAll('math, mjx-container, .MathJax, .katex');
  nodes.forEach((node) => {
    const tex = extractTex(node);
    if (tex === null) return;
    const cleaned = cleanMath(tex);
    const display = isDisplayMath(node);
    const replacement = display ? '$$\n' + cleaned + '\n$$' : '$' + cleaned + '$';
    node.replaceWith(doc.createTextNode(replacement));
  });
  return doc.body.innerHTML;
}

// ============================================================================
// 插件主体
// ============================================================================

const DEFAULT_SETTINGS = {
  language: 'zh',           // 'zh' = 中文；'en' = English
  enableIntercept: true,   // 启用粘贴拦截
  pasteMode: 'html',       // 'html' = HTML 手术保格式；'plain' = 纯文本清理
  fixEntities: true,       // 普通区修 HTML 实体
};

// ---------- 界面文案（i18n） ----------
const I18N = {
  zh: {
    settingsTitle: 'Latex Paste Cleaner 设置',
    language: '语言',
    languageDesc: '选择界面语言（设置项与命令名会随之切换）',
    enableIntercept: '启用粘贴拦截',
    enableInterceptDesc: '粘贴内容含 LaTeX 公式特征时自动清理。关闭后仅保留"清理当前笔记"命令。',
    pasteMode: '粘贴模式',
    pasteModeDesc: 'HTML 手术：保留正文格式（粗体/列表等），公式替换为干净 LaTeX（推荐）。纯文本：全部以纯文本插入。',
    pasteModeHtml: 'HTML 手术（保格式）',
    pasteModePlain: '纯文本清理',
    fixEntities: '普通文本区修复 HTML 实体',
    fixEntitiesDesc: '公式以外的部分把 &lt; 等 HTML 实体还原为 <。公式区内总是修复。',
    cmdCleanNote: '清理当前笔记的 LaTeX 公式',
  },
  en: {
    settingsTitle: 'Latex Paste Cleaner Settings',
    language: 'Language',
    languageDesc: 'Choose the interface language (settings and command name switch accordingly)',
    enableIntercept: 'Enable paste interception',
    enableInterceptDesc: 'Automatically clean pasted content when it contains LaTeX math signals. Disable to keep only the manual command.',
    pasteMode: 'Paste mode',
    pasteModeDesc: 'HTML surgery: preserve text formatting (bold/lists), replace formulas with clean LaTeX (recommended). Plain text: insert everything as plain text.',
    pasteModeHtml: 'HTML surgery (preserve formatting)',
    pasteModePlain: 'Plain text cleanup',
    fixEntities: 'Fix HTML entities in text regions',
    fixEntitiesDesc: 'Restore &lt; → < etc. outside math regions. Math regions are always fixed.',
    cmdCleanNote: "Clean up current note's LaTeX",
  },
};

// ---------- 设置标签页 ----------
class PasteCleanerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const t = I18N[this.plugin.settings.language] || I18N.zh;
    containerEl.empty();
    containerEl.createEl('h2', { text: t.settingsTitle });

    // 语言选择（第一个选项）
    new Setting(containerEl)
      .setName(t.language)
      .setDesc(t.languageDesc)
      .addDropdown((d) => d
        .addOption('zh', '中文')
        .addOption('en', 'English')
        .setValue(this.plugin.settings.language)
        .onChange(async (v) => {
          this.plugin.settings.language = v;
          await this.plugin.saveData(this.plugin.settings);
          // 命令名随语言切换：重注册命令
          const cmdId = 'latex-paste-cleaner:clean-current-note';
          try { this.app.commands.removeCommand(cmdId); } catch (e) { /* 未注册时忽略 */ }
          this.plugin.registerCommand();
          this.display();
        }));

    new Setting(containerEl)
      .setName(t.enableIntercept)
      .setDesc(t.enableInterceptDesc)
      .addToggle((tog) => tog.setValue(this.plugin.settings.enableIntercept).onChange(async (v) => {
        this.plugin.settings.enableIntercept = v;
        await this.plugin.saveData(this.plugin.settings);
      }));

    new Setting(containerEl)
      .setName(t.pasteMode)
      .setDesc(t.pasteModeDesc)
      .addDropdown((d) => d
        .addOption('html', t.pasteModeHtml)
        .addOption('plain', t.pasteModePlain)
        .setValue(this.plugin.settings.pasteMode)
        .onChange(async (v) => {
          this.plugin.settings.pasteMode = v;
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName(t.fixEntities)
      .setDesc(t.fixEntitiesDesc)
      .addToggle((tog) => tog.setValue(this.plugin.settings.fixEntities).onChange(async (v) => {
        this.plugin.settings.fixEntities = v;
        await this.plugin.saveData(this.plugin.settings);
      }));
  }
}

class LatexPasteCleanerPlugin extends Plugin {
  // 兜底命令：清理当前笔记（选中区域优先，否则整篇）。命令名随语言切换，
  // 语言变更时由设置页 removeCommand 后重新调用本方法
  registerCommand() {
    const t = I18N[this.settings.language] || I18N.zh;
    this.addCommand({
      id: 'clean-current-note',
      name: t.cmdCleanNote,
      editorCallback: (editor) => {
        const sel = editor.getSelection();
        if (sel) {
          editor.replaceSelection(clean(sel, this.settings));
        } else {
          editor.setValue(clean(editor.getValue(), this.settings));
        }
      },
    });
  }

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerCommand();

    // 粘贴拦截：有公式特征才干预（HTML 手术保格式；纯文本兜底）
    this.registerEvent(this.app.workspace.on('editor-paste', (evt, editor) => {
      if (!this.settings.enableIntercept) return;
      const plain = evt.clipboardData.getData('text/plain');
      const html = evt.clipboardData.getData('text/html');
      const text = plain || html;
      if (!hasMathSignals(text)) return; // 无公式特征：完全放行
      if (this.settings.pasteMode === 'html' && html) {
        // HTML 手术：改写剪贴板后放行，Obsidian 默认转换保格式
        try {
          evt.clipboardData.setData('text/html', surgeryHtml(html));
          if (plain) evt.clipboardData.setData('text/plain', clean(plain, this.settings));
        } catch (err) {
          console.warn('Latex Paste Cleaner: HTML 手术失败，回退纯文本', err);
          evt.preventDefault();
          editor.replaceSelection(clean(text, this.settings));
        }
        return;
      }
      // 纯文本路径
      evt.preventDefault();
      editor.replaceSelection(clean(text, this.settings));
    }));

    this.addSettingTab(new PasteCleanerSettingTab(this.app, this));

    console.log('Latex Paste Cleaner loaded');
  }

  onunload() {}
}

module.exports = LatexPasteCleanerPlugin;
// 额外导出核心函数供 Node 测试（Obsidian 忽略附加属性）
module.exports.tokenize = tokenize;
module.exports.cleanMath = cleanMath;
module.exports.cleanText = cleanText;
module.exports.clean = clean;
module.exports.hasMathSignals = hasMathSignals;
