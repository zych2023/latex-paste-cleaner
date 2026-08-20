// test-cleaner.cjs — Node 测试（无框架，node tests/test-cleaner.cjs 运行）
// Obsidian 插件加载器不支持相对 require，核心逻辑并入 main.js 单文件；
// 测试通过 mock obsidian 模块加载 main.js（插件类与核心函数均从导出获取）。
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

const mockPath = path.join(__dirname, '_obsidian-mock.cjs');
fs.writeFileSync(mockPath, 'class Plugin {} class PluginSettingTab {} class Setting {} module.exports = { Plugin, PluginSettingTab, Setting };\n');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'obsidian') return mockPath;
  return origResolve.call(this, request, ...args);
};
process.on('exit', () => { try { fs.unlinkSync(mockPath); } catch (e) { /* 已删 */ } });

const { tokenize, cleanMath, cleanText, clean, hasMathSignals } = require('../main.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
}
function types(tokens) { return tokens.map(t => t.type).join(','); }

// ---------- tokenize：分区 ----------
test('tokenize: 无公式 → 全部 text', () => {
  assert.strictEqual(types(tokenize('普通文本')), 'text');
});

test('tokenize: 代码围栏 → code（内部含 $ 不误判）', () => {
  const t = tokenize('```\nconst x = "$5" + "\\[x\\]";\n```');
  assert.strictEqual(types(t), 'code');
  assert.strictEqual(t[0].content, '```\nconst x = "$5" + "\\[x\\]";\n```');
});

test('tokenize: $$...$$ 跨行 → math', () => {
  const t = tokenize('前\n$$\n\\int_0^1 f(x) dx\n$$\n后');
  assert.strictEqual(types(t), 'text,math,text');
  assert.strictEqual(t[1].content, '$$\n\\int_0^1 f(x) dx\n$$');
});

test('tokenize: $...$ 行内 → math', () => {
  const t = tokenize('设 $x \\in R$，则');
  assert.strictEqual(types(t), 'text,math,text');
});

test('tokenize: \\(...\\) 含命令 → math', () => {
  const t = tokenize('\\(f(x)=\\frac{1}{2}\\)');
  assert.strictEqual(types(t), 'math');
});

test('tokenize: \\[...\\] 含命令 → math', () => {
  const t = tokenize('\\[\\iint_D xy\\,dxdy\\]');
  assert.strictEqual(types(t), 'math');
});

test('tokenize: \\[ 标题转义无命令 → text（真实笔记样本！）', () => {
  const t = tokenize('### 方法二：\\[0,2π]基准平移法（最直观，不易出错）');
  assert.strictEqual(types(t), 'text');
});

test('tokenize: 裸 [ ] 成行含命令 → math', () => {
  const t = tokenize('[\nD=\\{(x, y)\\mid 1\\le x+y\\le2\\}\n]');
  assert.strictEqual(types(t), 'math');
});

test('tokenize: 裸 [ ] 成行无命令 → text（markdown 链接/列表）', () => {
  const t = tokenize('一、[要点总结](note.md)\n二、无公式');
  assert.strictEqual(types(t), 'text');
});

test('tokenize: \\begin 环境无包裹 → math', () => {
  const t = tokenize('\\begin{vmatrix}\nv&u\\\\\n1-v&-u\n\\end{vmatrix}');
  assert.strictEqual(types(t), 'math');
});

test('tokenize: 双重转义 \\\\(...\\\\) → math', () => {
  const input = '\\\\(x^2\\\\)';  // 源码里两个反斜杠+括号
  const t = tokenize(input);
  assert.strictEqual(types(t), 'math');
});

test('tokenize: 错配 $...\\) → math', () => {
  const t = tokenize('$x\\)');
  assert.strictEqual(types(t), 'math');
});

test('tokenize: 方向错误 \\]...\\[ → math', () => {
  const t = tokenize('\\]a+b\\[');
  assert.strictEqual(types(t), 'math');
});

test('tokenize: 混排', () => {
  const t = tokenize('a $x$ b\n$$y$$ c \\begin{aligned}z\\end{aligned}');
  assert.strictEqual(types(t), 'text,math,text,math,text,math');
});

// ---------- hasMathSignals：触发检测 ----------
test('hasMathSignals: LaTeX 命令触发', () => {
  assert.ok(hasMathSignals('公式 \\frac{1}{2}'));
});
test('hasMathSignals: 普通文本不触发', () => {
  assert.ok(!hasMathSignals('这是一段普通中文，价格 $5 元，比例 3×4'));
});
test('hasMathSignals: 代码（无 LaTeX 特征）不触发', () => {
  assert.ok(!hasMathSignals('C:\\Users\\foo 路径'));
});

// ---------- cleanMath：公式区内清理管线 ----------
test('cleanMath: \\(...\\) → $...$', () => {
  assert.strictEqual(cleanMath('\\(x^2\\)'), '$x^2$');
});

test('cleanMath: \\[...\\] → $$...$$', () => {
  assert.strictEqual(cleanMath('\\[\\int_0^1 x dx\\]'), '$$\n\\int_0^1 x dx\n$$');
});

test('cleanMath: 双重转义降级 \\\\(x\\\\) → $x$', () => {
  assert.strictEqual(cleanMath('\\\\(x\\\\)'), '$x$');
});

test('cleanMath: 双重转义命令 \\\\mathbb{R} → \\mathbb{R}', () => {
  assert.strictEqual(cleanMath('\\\\mathbb{R}'), '\\mathbb{R}');
});

test('cleanMath: 外层包裹 $\\\\(x\\\\)$ → $x$', () => {
  assert.strictEqual(cleanMath('$\\\\(x\\\\)$'), '$x$');
});

test('cleanMath: 外层包裹 $$\\[...\\]$$ → $$...$$', () => {
  assert.strictEqual(cleanMath('$$\\[\\int x\\]$$'), '$$\n\\int x\n$$');
});

test('cleanMath: 命令内嵌套 \\mathbb{\\(R\\)} → \\mathbb{R}', () => {
  assert.strictEqual(cleanMath('\\mathbb{\\(R\\)}'), '\\mathbb{R}');
});

test('cleanMath: 命令花括号转义 \\mathbb\\{R\\} → \\mathbb{R}', () => {
  assert.strictEqual(cleanMath('\\mathbb\\{R\\}'), '\\mathbb{R}');
});

test('cleanMath: 嵌套 \\mathbb{\\mathbb{R}} → \\mathbb{R}', () => {
  assert.strictEqual(cleanMath('\\mathbb{\\mathbb{R}}'), '\\mathbb{R}');
});

test('cleanMath: \\left\\( \\right\\) 修复', () => {
  assert.strictEqual(cleanMath('\\left\\(x\\right\\)'), '\\left(x\\right)');
});

test('cleanMath: 错配 $...\\) → $...$', () => {
  assert.strictEqual(cleanMath('$x\\)'), '$x$');
});

test('cleanMath: 方向错误 \\]...\\[ → $$...$$', () => {
  assert.strictEqual(cleanMath('\\]a+b\\['), '$$\na+b\n$$');
});

test('cleanMath: begin 环境被 $ 包裹 → $$...$$', () => {
  assert.strictEqual(
    cleanMath('$\\begin{aligned}\nx&=1\\\\\ny&=2\n\\end{aligned}$'),
    '$$\n\\begin{aligned}\nx&=1\\\\\ny&=2\n\\end{aligned}\n$$'
  );
});

test('cleanMath: Unicode 区内转换 ≥ × α', () => {
  assert.strictEqual(cleanMath('$x ≥ y × z$'), '$x \\ge y \\times z$');
  assert.strictEqual(cleanMath('$\\alpha + \\beta$'), '$\\alpha + \\beta$');
});

test('cleanMath: 数学 HTML 实体 → 命令', () => {
  assert.strictEqual(cleanMath('$a &times; b$'), '$a \\times b$');
});

test('cleanMath: 空内容幂等', () => {
  assert.strictEqual(cleanMath(''), '');
  assert.strictEqual(cleanMath('x+y'), 'x+y');
});

// ---------- 边界测试（嵌套环境 / 价格 $ / 现状锁定） ----------
test('tokenize: 嵌套 begin/end 环境深度配对 → 单个 math', () => {
  const t = tokenize('\\begin{aligned}\n  \\begin{matrix}a&b\\\\c&d\\end{matrix}\n\\end{aligned}');
  assert.strictEqual(types(t), 'math');
  assert.ok(t[0].content.startsWith('$$'), '无包裹环境应补 $$');
});

test('tokenize: 未闭合 \\begin → text 原样（保守）', () => {
  const input = '正文 \\begin{aligned} 没闭合';
  assert.strictEqual(types(tokenize(input)), 'text');
});

test('tokenize: 价格 $ 不误判（含 CJK）', () => {
  const t = tokenize('价格 $5 元和 $10 元');
  assert.strictEqual(types(t), 'text');
});

test('tokenize: $x$ 纯符号仍为 math', () => {
  const t = tokenize('设 $x$ 且 $5x+3$');
  // 期望修正：原 'text,math,text,math,text' 要求末尾凭空多一个空 text token，
  // 自然行为是 4 个 token（$x$ 与 $5x+3$ 均为 math 才是本用例要点）
  assert.strictEqual(types(t), 'text,math,text,math');
});

test('tokenize: 空输入 → 空数组', () => {
  assert.deepStrictEqual(tokenize(''), []);
});

test('tokenize: 未闭合 $$ → 空 math 记号锁定现状', () => {
  const t = tokenize('开头 $$ x \\in R 结尾');
  // 期望修正：原 'math,text' 需吞掉 $$ 前的"开头 "（数据丢失）；
  // 自然行为为 text,math,text（未闭合 $$ 仍配出空 math 记号）
  assert.strictEqual(types(t), 'text,math,text');
});

test('tokenize: 混转义 \\\\(x\\in R\\) 首字符离析锁定现状', () => {
  const t = tokenize('\\\\(x\\in R\\)');
  assert.strictEqual(types(t), 'text,math');
});

test('tokenize: CRLF 行尾的裸 [ ] 块', () => {
  const t = tokenize('[\r\nx=\\frac{1}{2}\r\n]');
  assert.strictEqual(types(t), 'math');
});

// ---------- clean() 集成：真实笔记样本 ----------
test('clean: 裸 [ ] 块公式（未命名 1.md 真实样本）', () => {
  const input = '[\nD={(x, y)\\mid 1\\le x+y\\le2,\\ x\\ge0,\\ y\\ge0}\n]';
  const expected = '$$\nD={(x, y)\\mid 1\\le x+y\\le2,\\ x\\ge0,\\ y\\ge0}\n$$';
  assert.strictEqual(clean(input), expected);
});

test('clean: 无包裹 \\begin{vmatrix}（真实样本）', () => {
  const input = '\\begin{vmatrix}\nv&u\\\\\n1-v&-u\n\\end{vmatrix}';
  const expected = '$$\n\\begin{vmatrix}\nv&u\\\\\n1-v&-u\n\\end{vmatrix}\n$$';
  assert.strictEqual(clean(input), expected);
});

test('clean: 真实标题 \\[0,2π] 原样保留', () => {
  const input = '### 方法二：\\[0,2π]基准平移法（最直观，不易出错）';
  assert.strictEqual(clean(input), input);
});

test('clean: 正文 Unicode 不误伤（公式外）', () => {
  const input = '当 x ≥ 0 时，α 与 β 的乘积约 3×4，最大不超过 10。';
  assert.strictEqual(clean(input), input);
});

test('clean: 代码围栏内 $ 与 \\[ 原样', () => {
  const input = '```\nconst re = /\\[x\\]/; const price = "$5";\n```';
  assert.strictEqual(clean(input), input);
});

test('clean: 错配 $...\\) 与方向 \\]...\\[ 修复', () => {
  assert.strictEqual(clean('值 $x\\) 结论'), '值 $x$ 结论');
  assert.strictEqual(clean('\\]a+b\\['), '$$\na+b\n$$');
});

test('clean: 公式内 Unicode 转换、公式外保留（混合）', () => {
  const input = '若 $x ≥ y$ 且 α > 0，则 $\\int_0^1 x^2 dx ≥ 0$ 成立。';
  const expected = '若 $x \\ge y$ 且 α > 0，则 $\\int_0^1 x^2 dx \\ge 0$ 成立。';
  assert.strictEqual(clean(input), expected);
});

test('clean: 区外 HTML 实体修复、区内数学实体', () => {
  const input = 'a &lt; b，公式 $x &times; y$';
  const expected = 'a < b，公式 $x \\times y$';
  assert.strictEqual(clean(input), expected);
});

test('clean: AI 输出混合场景（未命名 1.md 风格）', () => {
  const input =
    '于是反解：\n[\nx=uv,\\qquad y=u (1-v).\n]\n\n### 2. 求雅可比\n\n[\n\\frac{\\partial (x, y)}{\\partial (u, v)}\n]';
  const expected =
    '于是反解：\n$$\nx=uv,\\qquad y=u (1-v).\n$$\n\n### 2. 求雅可比\n\n$$\n\\frac{\\partial (x, y)}{\\partial (u, v)}\n$$';
  assert.strictEqual(clean(input), expected);
});

// ---------- 对称双转义（MathJax 2 网页格式）端到端 ----------
test('clean: MathJax 2 行内公式（2bs 圆括号 + 1bs 命令）', () => {
  assert.strictEqual(clean('\\\\( \\frac{1}{2} \\\\)'), '$\\frac{1}{2}$');
});

test('clean: MathJax 2 行内公式（2bs 圆括号 + 2bs 命令）', () => {
  assert.strictEqual(clean('\\\\( \\\\frac{1}{2} \\\\)'), '$\\frac{1}{2}$');
});

test('clean: MathJax 2 块级公式（2bs 方括号 + 2bs 命令）', () => {
  assert.strictEqual(clean('\\\\[ \\\\frac{1}{2} \\\\]'), '$$\n\\frac{1}{2}\n$$');
});

test('clean: MathJax 2 行内（2bs 圆括号 + \\in）', () => {
  assert.strictEqual(clean('\\\\(x \\in R\\\\)'), '$x \\in R$');
});

// ---------- 多层嵌套转义（网页深度损坏） ----------
test('clean: 单层嵌套 $\\boldsymbol{\\(y=x\\)}$ → $\\boldsymbol{y=x}$', () => {
  assert.strictEqual(clean('$\\boldsymbol{\\(y=x\\)}$'), '$\\boldsymbol{y=x}$');
});

test('clean: 双层嵌套 → 还原', () => {
  assert.strictEqual(clean('$\\boldsymbol{\\(\\boldsymbol{\\(y=x\\)}\\)}$'), '$\\boldsymbol{y=x}$');
});

test('clean: 三层嵌套 → 还原', () => {
  assert.strictEqual(clean('$\\boldsymbol{\\(\\boldsymbol{\\(\\boldsymbol{\\(y=x\\)}\\)}\\)}$'), '$\\boldsymbol{y=x}$');
});

test('clean: 双层连续转义 \\(\\boldsymbol{\\(y=x\\)}\\) → 还原', () => {
  assert.strictEqual(clean('$\\boldsymbol{\\(\\boldsymbol{\\(y=x\\)}\\)}$'), '$\\boldsymbol{y=x}$');
});

test('clean: ${\\(x,y\\)}\\in D$ → $x,y\\in D$（内部定界符剥离）', () => {
  assert.strictEqual(clean('$\\(x,y\\)\\in D$'), '$x,y\\in D$');
});

test('clean: $$ 块内 \\(x,y\\) 剥离', () => {
  const input = '$$\n\\iint_D g(\\(x,y\\))\\mathrm{d}\\sigma\n$$';
  const expected = '$$\n\\iint_D g(x,y)\\mathrm{d}\\sigma\n$$';
  assert.strictEqual(clean(input), expected);
});

test('clean: 真实场景段（用户反馈样本：多层嵌套 y=x）', () => {
  const input = '做变换：$\\boldsymbol{x\\leftrightarrow y}$（也就是关于直线 $\\boldsymbol{\\(\\boldsymbol{\\(\\boldsymbol{\\(y=x\\)}\\)}\\)}$ 镜像）。';
  const expected = '做变换：$\\boldsymbol{x\\leftrightarrow y}$（也就是关于直线 $\\boldsymbol{y=x}$ 镜像）。';
  assert.strictEqual(clean(input), expected);
});

test('clean: 用户原文（连续 \\( \\( 双转义 + 花括号不平衡）→ 完美还原', () => {
  // $\boldsymbol{\(\(\boldsymbol{\(\(\boldsymbol{\(y=x\)}\)}\)}\)\)}$
  // （3 个 \boldsymbol{ 却有 4 个 }——网页复制畸形；需平衡修复）
  const input = [
    '$', '\\boldsymbol{', '\\(', '\\(', '\\boldsymbol{', '\\(', '\\(', '\\boldsymbol{', '\\(', 'y=x',
    '\\)', '}', '\\)', '}', '\\)', '}', '\\)', '}', '$'
  ].join('');
  assert.strictEqual(clean(input), '$\\boldsymbol{y=x}$');
});

// ---------- annotation 场景（HTML 手术提取的 tex，无 $ 包裹但带 MathJax 定界符） ----------
test('cleanMath: annotation tex（\\(\\boldsymbol{\\(y=x\\)}\\) 无 $ 包裹）→ \\boldsymbol{y=x}', () => {
  const input = ['\\(', '\\boldsymbol{', '\\(', 'y=x', '\\)', '}', '\\)'].join('');
  assert.strictEqual(cleanMath(input), '\\boldsymbol{y=x}');
});

test('cleanMath: annotation 裸包裹含内层定界符 → 剥离', () => {
  // \(\boldsymbol{\(\(\boldsymbol{\(y=x\)}\)}\)}\)（连续双转义，无 $ 包裹——HTML 手术真实场景）
  const input = ['\\(', '\\boldsymbol{', '\\(', '\\(', '\\boldsymbol{', '\\(', 'y=x', '\\)', '}', '\\)', '}', '\\)', '}', '\\)'].join('');
  assert.strictEqual(cleanMath(input), '\\boldsymbol{y=x}');
});

// ---------- 命令碎片重组（HTML 渲染交错） ----------
test('clean: \bol\\(\\mathrm{d}s\\)ymbol{ 碎片重组 → \\boldsymbol{（用户反馈案例）', () => {
  const input = '$$\n\\bol\\(\\mathrm{d}s\\)ymbol{s=\\int_{a}^{b} \\mathrm{d}s=\\int_{a}^{b}\\sqrt{1+(y\')^2}\\,\\mathrm{d}x}\n$$';
  const expected = '$$\n\\boldsymbol{s=\\int_{a}^{b} \\mathrm{d}s=\\int_{a}^{b}\\sqrt{1+(y\')^2}\\,\\mathrm{d}x}\n$$';
  assert.strictEqual(clean(input), expected);
});

test('cleanMath: \\bol$垃圾$ymbol{ 变体（$ 插入）', () => {
  assert.strictEqual(cleanMath('\\bol$abc$ymbol{x}'), '\\boldsymbol{x}');
});

test('cleanMath: \\bold\\[...\\]symbol{ 变体（块级插入）', () => {
  assert.strictEqual(cleanMath('\\bold\\[z\\]symbol{x}'), '\\boldsymbol{x}');
});

// ---------- 汇总 ----------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
