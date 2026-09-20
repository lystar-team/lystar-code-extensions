import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { jevBudget } from '../typesafe-core.mjs';

const execFileAsync = promisify(execFile);
const PACKAGE_RULES_PATH = fileURLToPath(new URL('../../rules/anti-ai-slop.rules.json', import.meta.url));
export const RULES_PATH = PACKAGE_RULES_PATH;

function configuredRulesPath() {
  return process.env.TYPESAFE_ANTI_SLOP_RULES_PATH || PACKAGE_RULES_PATH;
}
const CHANGE_LIMIT = 14000;
const CANDIDATE_LIMIT = 2600;
const REQUEST_LIMIT = 4000;
const EVIDENCE_LIMIT = 1800;
const MAX_FILES = 20;
// 单个文件最多检查的片段数。这是覆盖范围与公平性的上限，按片段计量，不是请求预算；
// 超出部分由下面的请求预算分批承担。
const MAX_HUNKS_PER_FILE = 12;
// 会话内保留的项目事实条数，超出时从头部丢弃并记录偏移。
const MAX_EVIDENCE_STORE = 20;
const MAX_EVIDENCE_ITEMS = 6;
// 初筛门槛按 2026-09-20 会话日志的 31 条候选标定：0.55 到 0.75 区间全部为待取证或误报，
// 阈值提到 0.75 可去除约 80% 噪音，同时保留唯一一次定位到真实问题的 0.78 候选。
const ROUTE_THRESHOLD = 0.75;
const REVIEW_THRESHOLD = 0.75;
const MAX_AUTOMATIC_REVIEW_TURNS = 2;
const SOURCE = new Set(['.vue', '.svelte', '.html', '.htm', '.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs', '.py', '.java', '.kt', '.go', '.rs', '.php', '.rb', '.cs', '.json']);
const clip = (value, max = CHANGE_LIMIT) => value.length > max ? value.slice(0, max) + '\n[截断：余下内容未检查]' : value;
const clipTail = (value, max) => value.length > max ? `[前文省略]\n${value.slice(-max)}` : value;

function assertStringArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.some(item => typeof item !== 'string')) throw new Error(`${label} 必须是${allowEmpty ? '' : '非空'}字符串数组`);
}

export function loadRules(path = configuredRulesPath()) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (config.version !== 1 || !Array.isArray(config.rules)) throw new Error('规则文件需要 version: 1 和 rules 数组');
  const ids = new Set();
  for (const rule of config.rules) {
    if (!rule.id || ids.has(rule.id)) throw new Error('规则 ID 缺失或重复');
    ids.add(rule.id);
    if (typeof rule.enabled !== 'boolean' || rule.action !== 'review') throw new Error(`${rule.id}：当前仅支持 review；阻断须经过单独评测和确认`);
    for (const field of ['title', 'scope', 'violation']) {
      if (typeof rule[field] !== 'string' || !rule[field].trim()) throw new Error(`${rule.id}：缺少 ${field}`);
    }
    assertStringArray(rule.exceptions, `${rule.id}：exceptions`, { allowEmpty: true });
    assertStringArray(rule.requiredEvidence, `${rule.id}：requiredEvidence`);
    for (const field of ['bad', 'good']) {
      if (typeof rule[field]?.context !== 'string' || typeof rule[field]?.artifact !== 'string') throw new Error(`${rule.id}：缺少 ${field} 正反例`);
    }
    if (!(typeof rule.threshold === 'number' && rule.threshold > 0.5 && rule.threshold <= 1)) throw new Error(`${rule.id}：threshold 须大于 0.5 且不超过 1`);
    if (rule.appliesTo !== undefined) {
      assertStringArray(rule.appliesTo, `${rule.id}：appliesTo`);
      if (rule.appliesTo.some(extension => !/^\.[a-z0-9]+$/i.test(extension))) throw new Error(`${rule.id}：appliesTo 只接受 .ext 形式的文件扩展名`);
    }
  }
  return config.rules.filter(rule => rule.enabled);
}

function readOptionalSource(path) {
  try {
    if (!SOURCE.has(extname(path).toLowerCase())) return undefined;
    if (statSync(path).size > 200000) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function resolveGitRoot(cwd) {
  try { return (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim() || undefined; }
  catch { return undefined; }
}

async function listGitChangedPaths(root) {
  const output = await runGit(root, ['-c', 'status.renames=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return [...new Set(output.split('\0').filter(Boolean).map(record => record.slice(3)).filter(Boolean))];
}

async function readHeadSource(root, relativePath) {
  try { return await runGit(root, ['show', `HEAD:${relativePath}`]); }
  catch { return ''; }
}

export async function captureWorkspaceBaseline(cwd) {
  const root = await resolveGitRoot(cwd);
  if (!root) return { root: undefined, initial: new Map() };
  const initial = new Map();
  try {
    for (const relativePath of await listGitChangedPaths(root)) {
      const absolutePath = resolve(root, relativePath);
      const content = readOptionalSource(absolutePath);
      if (content !== undefined) initial.set(absolutePath, content);
    }
  } catch {
    return { root, initial };
  }
  return { root, initial };
}

async function collectGitChanges(snapshot) {
  if (!snapshot?.root) return [];
  const changes = [];
  let paths;
  try { paths = await listGitChangedPaths(snapshot.root); }
  catch { return changes; }
  for (const relativePath of paths) {
    const absolutePath = resolve(snapshot.root, relativePath);
    if (!SOURCE.has(extname(absolutePath).toLowerCase())) continue;
    const after = readOptionalSource(absolutePath);
    if (after === undefined) continue;
    const before = snapshot.initial.has(absolutePath) ? snapshot.initial.get(absolutePath) : await readHeadSource(snapshot.root, relativePath);
    if (before !== after) changes.push({ path: absolutePath, before, after, source: 'git' });
  }
  return changes;
}

export async function collectFinalChanges(snapshot, tracked) {
  const merged = new Map((await collectGitChanges(snapshot)).map(change => [change.path, change]));
  for (const [path, before] of tracked) {
    const after = readOptionalSource(path);
    if (after === undefined || before === after) continue;
    merged.set(path, { path, before, after, source: merged.has(path) ? 'git+tool' : 'tool' });
  }
  return [...merged.values()];
}

function patienceAnchors(beforeLines, afterLines) {
  const beforeCount = new Map(); const afterCount = new Map(); const afterPosition = new Map();
  beforeLines.forEach(line => beforeCount.set(line, (beforeCount.get(line) || 0) + 1));
  afterLines.forEach((line, index) => { afterCount.set(line, (afterCount.get(line) || 0) + 1); afterPosition.set(line, index); });
  const pairs = [];
  beforeLines.forEach((line, oldIndex) => {
    if (beforeCount.get(line) === 1 && afterCount.get(line) === 1) pairs.push({ oldIndex, newIndex: afterPosition.get(line) });
  });
  const tails = []; const previous = Array(pairs.length).fill(-1);
  for (let index = 0; index < pairs.length; index++) {
    let low = 0; let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (pairs[tails[middle]].newIndex < pairs[index].newIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const anchors = [];
  let cursor = tails.at(-1);
  while (cursor !== undefined && cursor >= 0) { anchors.push(pairs[cursor]); cursor = previous[cursor]; }
  return anchors.reverse();
}

export function diffHunks(before, after, contextLines = 3) {
  if (before === after) return { hunks: [], limited: false };
  const beforeLines = before.split('\n'); const afterLines = after.split('\n');
  const anchors = [{ oldIndex: -1, newIndex: -1 }, ...patienceAnchors(beforeLines, afterLines), { oldIndex: beforeLines.length, newIndex: afterLines.length }];
  const gaps = [];
  for (let index = 1; index < anchors.length; index++) {
    const previous = anchors[index - 1]; const next = anchors[index];
    const oldStart = previous.oldIndex + 1; const oldEnd = next.oldIndex - 1;
    const newStart = previous.newIndex + 1; const newEnd = next.newIndex - 1;
    if (oldStart > oldEnd && newStart > newEnd) continue;
    if (newStart > newEnd) continue;
    gaps.push({ oldStart, oldEnd, newStart, newEnd });
  }
  const merged = [];
  for (const gap of gaps) {
    const previous = merged.at(-1);
    if (previous && gap.newStart <= previous.newEnd + contextLines * 2 + 1) {
      previous.oldEnd = gap.oldEnd; previous.newEnd = gap.newEnd;
    } else merged.push({ ...gap });
  }
  const limited = merged.length > MAX_HUNKS_PER_FILE;
  const hunks = merged.slice(0, MAX_HUNKS_PER_FILE).map(gap => {
    const contextStart = Math.max(0, gap.newStart - contextLines);
    const contextEnd = Math.min(afterLines.length - 1, gap.newEnd + contextLines);
    return {
      startLine: contextStart + 1,
      endLine: contextEnd + 1,
      changedStartLine: gap.newStart + 1,
      changedEndLine: gap.newEnd + 1,
      before: clip(beforeLines.slice(Math.max(0, gap.oldStart), Math.max(gap.oldStart, gap.oldEnd + 1)).join('\n'), 1200),
      after: clip(afterLines.slice(contextStart, contextEnd + 1).join('\n'), CANDIDATE_LIMIT),
      changedAfter: clip(afterLines.slice(gap.newStart, gap.newEnd + 1).join('\n'), 1800),
    };
  });
  return { hunks, limited };
}

function probability(response, key) {
  const answer = response?.answers?.[key];
  if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error(`Jev 缺少有效回答：${key}`);
  return answer.noul;
}

const ROUTE_CRITERIA = {
  true: '候选片段与规则存在合理关联，需要核对。',
  false: '候选片段与规则明显无关。',
};

// 规则范围与违规定义只在 state 里声明一次，问题里只引用规则编号，
// 避免每个修改片段都把全部规则文本重复发送一遍。
function routeRuleCatalog(rules) {
  return rules.map((rule, index) => ({
    key: `r${index}`,
    title: rule.title,
    scope: rule.scope,
    violation: rule.violation,
  }));
}

function routeQuestion(rule, ruleIndex, hunkRef) {
  return {
    type: 'noul',
    instructions: `本次修改${hunkRef}是否可能落入 state.rules 中 r${ruleIndex}（${rule.title}）的适用范围？范围与违规定义见 state.rules。这是召回优先的语义筛选，不要求当前证据足以判违规。`,
    criteria: ROUTE_CRITERIA,
  };
}

function routeQuestions(entries) {
  return Object.fromEntries(entries.map(({ rule, index }) => [`r${index}`, routeQuestion(rule, index, '')]));
}

// 规则可用 appliesTo 声明适用的文件扩展名；未声明时对所有文件生效。索引保留
// 在全量规则数组中的位置，所以答案键在两个路径下含义一致。
function indexedRulesForPath(rules, path) {
  const extension = extname(path).toLowerCase();
  return rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => !rule.appliesTo || rule.appliesTo.includes(extension));
}

// 每个片段的体量只估算一次，再按预算贪心装箱，准备开销与片段数成线性。
function routePlan(rules, items, request, maxBytes) {
  const base = JSON.stringify({ user_request: clipTail(request || '', REQUEST_LIMIT), rules: routeRuleCatalog(rules), changes: [] }).length;
  const batches = [];
  let current = [];
  let bytes = base;
  for (const item of items) {
    const entry = { key: `h${current.length}`, path: item.change.path, extension: extname(item.change.path).toLowerCase(), change: item.hunk };
    let cost = JSON.stringify(entry).length;
    for (const { rule, index } of indexedRulesForPath(rules, item.change.path)) {
      cost += JSON.stringify(routeQuestion(rule, index, ` h${current.length} `)).length + 16;
    }
    if (current.length > 0 && bytes + cost > maxBytes) {
      batches.push(current);
      current = [];
      bytes = base;
    }
    current.push(item);
    bytes += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function semanticRoute(change, hunk, rules, request, ask, signal) {
  const entries = indexedRulesForPath(rules, change.path);
  const state = {
    path: change.path,
    extension: extname(change.path).toLowerCase(),
    user_request: clipTail(request || '', REQUEST_LIMIT),
    rules: routeRuleCatalog(rules),
    change: hunk,
  };
  const response = await ask(state, routeQuestions(entries), { signal });
  return entries.map(({ rule, index }) => ({ rule, applicability: probability(response, `r${index}`), hunk })).filter(item => item.applicability >= ROUTE_THRESHOLD);
}

async function semanticRouteBatch(items, rules, request, ask, signal) {
  const state = {
    user_request: clipTail(request || '', REQUEST_LIMIT),
    rules: routeRuleCatalog(rules),
    changes: items.map((item, index) => ({
      key: `h${index}`,
      path: item.change.path,
      extension: extname(item.change.path).toLowerCase(),
      change: item.hunk,
    })),
  };
  const questions = {};
  const applicableByItem = items.map(item => indexedRulesForPath(rules, item.change.path));
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    for (const { rule, index } of applicableByItem[itemIndex]) {
      questions[`h${itemIndex}_r${index}`] = routeQuestion(rule, index, ` h${itemIndex} `);
    }
  }
  const response = await ask(state, questions, { signal });
  return items.map((item, itemIndex) => applicableByItem[itemIndex].map(({ rule, index }) => ({
    rule,
    applicability: probability(response, `h${itemIndex}_r${index}`),
    hunk: item.hunk,
    path: item.change.path,
  })).filter(result => result.applicability >= ROUTE_THRESHOLD));
}

function judgmentQuestions(rule, prefix = '') {
  return {
    [`${prefix}violation`]: {
      type: 'noul',
      instructions: `结合 state.user_request、state.project_evidence 和 state.change，本次修改是否引入规则“${rule.title}”定义的违规？定义：${rule.violation}。例外：${rule.exceptions.join('；')}。只依据给定项目事实，不用通用偏好补全缺失信息。`,
      criteria: { true: { description: rule.violation, example: rule.bad }, false: { description: '没有违规、符合例外或项目事实支持当前实现', example: rule.good } },
    },
    [`${prefix}evidence_sufficient`]: {
      type: 'noul',
      instructions: `给定证据是否足以对规则“${rule.title}”作出结论？需要的证据：${rule.requiredEvidence.join('；')}。state.project_evidence 是当前 LC 按取证请求通过项目工具取得的事实；带路径的需求原文、源码、组件接口、DESIGN.md 条款和页面观察应按其明确内容作为证据，除非彼此矛盾。只检查 required_evidence 是否覆盖，不额外要求规则未列出的材料；仍需猜测时回答否。`,
      criteria: { true: '用户要求、修改片段和项目工具证据已经覆盖 required_evidence，可以支持结论。', false: 'required_evidence 中仍有决定性项目事实缺失或相互矛盾。' },
    },
  };
}

function judgmentCandidateBody(candidate, projectEvidence) {
  return {
    rule: {
      id: candidate.rule.id,
      title: candidate.rule.title,
      scope: candidate.rule.scope,
      required_evidence: candidate.rule.requiredEvidence,
    },
    change: candidate.hunk,
    project_evidence: projectEvidence.slice(-MAX_EVIDENCE_ITEMS).map(item => ({ tool: item.tool, path: item.path, command: item.command, content: clip(item.content || '', EVIDENCE_LIMIT) })),
  };
}

function judgedCandidate(candidate, response, prefix = '') {
  const score = probability(response, `${prefix}violation`);
  const sufficient = probability(response, `${prefix}evidence_sufficient`);
  const status = score < candidate.rule.threshold ? 'clear' : sufficient >= REVIEW_THRESHOLD ? 'review' : 'uncertain';
  return { ...candidate, score, sufficient, status, stage: 'judged' };
}

export async function judgeWithEvidence(candidate, request, projectEvidence, ask, signal) {
  const state = {
    path: candidate.path,
    user_request: clipTail(request || '', REQUEST_LIMIT),
    ...judgmentCandidateBody(candidate, projectEvidence),
  };
  const response = await ask(state, judgmentQuestions(candidate.rule), { signal });
  return judgedCandidate(candidate, response);
}

async function judgeBatch(items, request, ask, signal) {
  const state = {
    user_request: clipTail(request || '', REQUEST_LIMIT),
    candidates: items.map((item, index) => ({ key: `c${index}`, path: item.candidate.path, ...judgmentCandidateBody(item.candidate, item.freshEvidence) })),
  };
  const questions = {};
  for (let index = 0; index < items.length; index += 1) {
    Object.assign(questions, judgmentQuestions(items[index].candidate.rule, `c${index}_`));
  }
  const response = await ask(state, questions, { signal });
  return items.map((item, index) => judgedCandidate(item.candidate, response, `c${index}_`));
}

// 每个待复核候选的体量只估算一次，再按预算贪心装箱。
function judgmentPlan(items, request, maxBytes) {
  const base = JSON.stringify({ user_request: clipTail(request || '', REQUEST_LIMIT), candidates: [] }).length;
  const batches = [];
  let current = [];
  let bytes = base;
  for (const item of items) {
    const entry = { key: `c${current.length}`, path: item.candidate.path, ...judgmentCandidateBody(item.candidate, item.freshEvidence) };
    const cost = JSON.stringify(entry).length + JSON.stringify(judgmentQuestions(item.candidate.rule, `c${current.length}_`)).length + 16;
    if (current.length > 0 && bytes + cost > maxBytes) {
      batches.push(current);
      current = [];
      bytes = base;
    }
    current.push(item);
    bytes += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function candidateKey(candidate) {
  return JSON.stringify([candidate.path, candidate.rule.id, candidate.hunk.changedStartLine, candidate.hunk.changedEndLine, candidate.hunk.changedAfter]);
}

function routeKey(change, hunk) {
  return `route:${JSON.stringify([change.path, hunk.changedStartLine, hunk.changedEndLine, hunk.changedAfter])}`;
}

// 跨轮次审计状态：路由结果按片段缓存，候选取证进度按候选缓存，证据由状态自己持有。
export function createAuditState() {
  return { routes: new Map(), candidates: new Map(), evidence: [], dropped: 0 };
}

function auditCandidate(audit, candidate) {
  const key = candidateKey(candidate);
  let entry = audit.candidates.get(key);
  if (!entry) {
    entry = { stage: 'awaiting_evidence', evidenceStart: audit.evidence.length, evidenceSignature: '', result: undefined };
    audit.candidates.set(key, entry);
  }
  return entry;
}

// awaiting_evidence → ready → judged；证据签名未变的已判结果直接复用。
function candidateProgress(entry, audit) {
  const fresh = audit.evidence.slice(Math.max(0, entry.evidenceStart - audit.dropped));
  const signature = JSON.stringify(fresh);
  if (entry.result && entry.evidenceSignature === signature) return { status: 'judged', result: entry.result };
  if (fresh.length === 0) return { status: 'awaiting_evidence' };
  return { status: 'ready', fresh, signature };
}

export async function inspectChanges(changes, rules, request, audit, ask, signal) {
  const { requestChars, requestsPerRound } = jevBudget();
  const routed = []; const errors = []; let routeCalls = 0; let judgmentCalls = 0; let limited = false;
  const rulesById = new Map(rules.map(rule => [rule.id, rule]));
  const pendingRoutes = [];
  for (const change of changes) {
    const segmented = diffHunks(change.before, change.after);
    limited ||= segmented.limited;
    for (const hunk of segmented.hunks) {
      const key = routeKey(change, hunk);
      const cached = audit.routes.get(key);
      if (cached) {
        routed.push(...cached.map(item => ({ rule: rulesById.get(item.ruleId), applicability: item.applicability, hunk, path: change.path })).filter(item => item.rule));
        continue;
      }
      pendingRoutes.push({ change, hunk, key });
    }
  }
  if (pendingRoutes.length > 0) {
    const batches = pendingRoutes.length === 1
      ? [pendingRoutes]
      : routePlan(rules, pendingRoutes, request, requestChars);
    for (const batch of batches) {
      if (routeCalls >= requestsPerRound) {
        limited = true;
        break;
      }
      try {
        const selectedGroups = batch.length === 1
          ? [await semanticRoute(batch[0].change, batch[0].hunk, rules, request, ask, signal)]
          : await semanticRouteBatch(batch, rules, request, ask, signal);
        routeCalls++;
        for (let index = 0; index < batch.length; index++) {
          const pending = batch[index];
          const selected = selectedGroups[index] || [];
          audit.routes.set(pending.key, selected.map(item => ({ ruleId: item.rule.id, applicability: item.applicability })));
          routed.push(...selected.map(item => ({ ...item, path: pending.change.path })));
        }
      } catch (error) {
        errors.push(`语义初筛：${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  }
  const needsEvidence = candidate => ({ ...candidate, status: 'uncertain', stage: 'needs_evidence', requiredEvidence: candidate.rule.requiredEvidence });
  const findings = new Array(routed.length);
  const pendingJudgments = [];
  for (let index = 0; index < routed.length; index += 1) {
    const candidate = routed[index];
    const entry = auditCandidate(audit, candidate);
    const progress = candidateProgress(entry, audit);
    if (progress.status === 'judged') {
      findings[index] = progress.result;
      continue;
    }
    if (progress.status === 'awaiting_evidence') {
      entry.stage = 'awaiting_evidence';
      findings[index] = needsEvidence(candidate);
      continue;
    }
    pendingJudgments.push({ index, candidate, entry, evidenceSignature: progress.signature, freshEvidence: progress.fresh });
  }
  if (pendingJudgments.length > 0) {
    const batches = pendingJudgments.length === 1 ? [pendingJudgments] : judgmentPlan(pendingJudgments, request, requestChars);
    const runnable = batches.slice(0, Math.max(0, requestsPerRound - routeCalls));
    if (runnable.length < batches.length) {
      limited = true;
      for (const batch of batches.slice(runnable.length)) {
        for (const item of batch) findings[item.index] = needsEvidence(item.candidate);
      }
    }
    for (const batch of runnable) {
      try {
        const judged = batch.length === 1
          ? [await judgeWithEvidence(batch[0].candidate, request, batch[0].freshEvidence, ask, signal)]
          : await judgeBatch(batch, request, ask, signal);
        judgmentCalls += 1;
        for (let position = 0; position < batch.length; position += 1) {
          const item = batch[position];
          item.entry.stage = 'judged';
          item.entry.result = judged[position];
          item.entry.evidenceSignature = item.evidenceSignature;
          findings[item.index] = judged[position];
        }
      } catch (error) {
        for (const item of batch) {
          errors.push(`${item.candidate.path}:${item.candidate.hunk.changedStartLine}-${item.candidate.hunk.changedEndLine} [${item.candidate.rule.id}]：${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
    }
  }
  return { findings: findings.filter(Boolean), errors, routeCalls, judgmentCalls, limited, checkedFiles: changes.length };
}

export function formatReport(result, phase, notes = []) {
  const lines = [`anti-ai-slop｜${phase}｜内部复核，不授权扩大修改范围。`];
  for (const finding of result.findings.filter(item => item.status !== 'clear')) {
    const location = `${finding.path}:${finding.hunk.changedStartLine}-${finding.hunk.changedEndLine}`;
    if (finding.stage === 'needs_evidence') {
      lines.push(`- 待取证 [${finding.rule.id}] ${finding.rule.title} @ ${location}；语义适用概率 ${finding.applicability.toFixed(2)}`);
      lines.push(`  请只读取这些事实：${finding.requiredEvidence.join('；')}`);
    } else {
      lines.push(`- ${finding.status === 'review' ? '确认候选' : '证据仍不足'} [${finding.rule.id}] ${finding.rule.title} @ ${location}`);
      lines.push(`  概率：违规 ${finding.score.toFixed(2)}，证据 ${finding.sufficient.toFixed(2)}`);
    }
    lines.push(`  修改片段：${clip(finding.hunk.changedAfter, 500)}`);
  }
  for (const error of result.errors) lines.push(`- 未检查：${error}`);
  if (result.limited) lines.push('- 未检查：达到本轮分块或调用上限');
  lines.push(...notes.map(note => `未验证范围：${note}`));
  lines.push('处理要求：先读取列出的项目事实；事实明确时修正或保留。证据仍不足就停止，不自动修改，也不向用户展开概率报告。');
  return lines.join('\n');
}

export function needsAttention(result) {
  return result.limited || result.errors.length > 0 || result.findings.some(finding => finding.status !== 'clear');
}

export function proposedContent(before, input, tool) {
  if (tool === 'write') return typeof input.content === 'string' ? input.content : null;
  const edits = Array.isArray(input.edits) ? input.edits : [{ oldText: input.oldText, newText: input.newText }];
  const matches = [];
  for (const edit of edits) {
    if (typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string') return null;
    const start = before.indexOf(edit.oldText);
    if (start < 0 || before.indexOf(edit.oldText, start + 1) >= 0) return null;
    matches.push({ start, end: start + edit.oldText.length, text: edit.newText });
  }
  matches.sort((a, b) => a.start - b.start);
  if (matches.some((match, index) => index > 0 && match.start < matches[index - 1].end)) return null;
  let result = before;
  for (const match of matches.reverse()) result = result.slice(0, match.start) + match.text + result.slice(match.end);
  return result;
}

export function registerAntiSlop(pi, ask, { rulesPath = RULES_PATH } = {}) {
  let request = '';
  let tracked = new Map();
  let pendingTrack = new Map();
  let audit = createAuditState();
  let workspaceBaseline;
  let baselinePromise;
  let lastReport = '';
  let automaticReviewTurns = 0;
  const reset = () => { request = ''; tracked = new Map(); pendingTrack = new Map(); audit = createAuditState(); workspaceBaseline = undefined; baselinePromise = undefined; lastReport = ''; automaticReviewTurns = 0; };
  const enabled = () => process.env.TYPESAFE_ANTI_SLOP_DISABLE !== '1';
  const publish = (text, triggerTurn) => pi.sendMessage({ customType: 'anti-ai-slop', content: text, display: false }, { triggerTurn, deliverAs: 'followUp' });
  const ensureBaseline = cwd => baselinePromise ??= captureWorkspaceBaseline(cwd).then(value => workspaceBaseline = value);

  pi.on('session_start', reset);
  pi.on('input', event => { if (event.source !== 'extension') reset(); });
  pi.on('before_agent_start', async (event, ctx) => {
    if (!enabled()) return;
    if (!request) request = clipTail(event.prompt || '', REQUEST_LIMIT);
    await ensureBaseline(ctx.cwd);
    try {
      loadRules(rulesPath);
      const policy = `anti-ai-slop 在任务稳定后审计最终改动：先按 diff 分块，用 Jev 语义筛选可能适用的规则；收到“待取证”内部消息时，只读取其中列出的项目事实，再由扩展复核。不得凭通用偏好修改代码，证据不足必须停止。规则见 ${rulesPath}。`;
      return { systemPrompt: `${event.systemPrompt || ''}\n\n${policy}` };
    } catch (error) {
      return { systemPrompt: `${event.systemPrompt || ''}\n\nanti-ai-slop 未启用：规则加载失败：${error.message}` };
    }
  });
  pi.on('tool_call', (event, ctx) => {
    if (!enabled() || !['write', 'edit'].includes(event.toolName) || typeof event.input.path !== 'string') return;
    const path = resolve(ctx.cwd, event.input.path);
    if (!SOURCE.has(extname(path).toLowerCase())) return;
    const before = readOptionalSource(path);
    if (before === undefined || proposedContent(before, event.input, event.toolName) === null) return;
    pendingTrack.set(event.toolCallId, { path, before });
  });
  pi.on('tool_result', event => {
    if (!enabled()) return;
    const pending = pendingTrack.get(event.toolCallId);
    pendingTrack.delete(event.toolCallId);
    if (pending && !event.isError && !tracked.has(pending.path)) tracked.set(pending.path, pending.before);
    const readOnlyEvidence = ['read', 'grep', 'find', 'ls', 'mcp'].includes(event.toolName) ||
      /browser/i.test(event.toolName) ||
      (event.toolName === 'bash' && typeof event.input.command === 'string' && /^(?:rg|grep|find|ls|git\s+(?:diff|status|show)|agent-browser|lystar-browser)\b/.test(event.input.command.trim()));
    if (readOnlyEvidence && !event.isError) {
      const text = event.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (text) {
        audit.evidence.push({ tool: event.toolName, path: event.input.path, command: event.input.command, content: clip(text, EVIDENCE_LIMIT) });
        // 头部丢弃时记录偏移，已登记的 evidenceStart 下标仍然指向正确的证据。
        while (audit.evidence.length > MAX_EVIDENCE_STORE) {
          audit.evidence.shift();
          audit.dropped += 1;
        }
      }
    }
  });

  async function runAudit(ctx, explicitPaths) {
    await ensureBaseline(ctx.cwd);
    let changes = await collectFinalChanges(workspaceBaseline, tracked);
    if (explicitPaths) {
      const selected = new Set(explicitPaths.map(path => resolve(ctx.cwd, path)));
      const known = new Map(changes.map(change => [change.path, change]));
      for (const path of selected) {
        if (known.has(path)) continue;
        const after = readOptionalSource(path);
        if (after === undefined) continue;
        const before = tracked.get(path) ?? workspaceBaseline?.initial.get(path) ?? (workspaceBaseline?.root && path.startsWith(`${workspaceBaseline.root}/`) ? await readHeadSource(workspaceBaseline.root, relative(workspaceBaseline.root, path)) : '');
        if (before !== after) known.set(path, { path, before, after, source: 'manual' });
      }
      changes = [...known.values()].filter(change => selected.has(change.path));
    }
    const rules = loadRules(rulesPath);
    return inspectChanges(changes, rules, request, audit, ask, ctx.signal);
  }

  pi.on('agent_settled', async (_event, ctx) => {
    if (!enabled()) return;
    try {
      const result = await runAudit(ctx);
      if (!needsAttention(result)) return;
      const report = formatReport(result, result.findings.some(item => item.stage === 'needs_evidence') ? '业务取证请求' : '证据复核结果', ['浏览器运行态、远程文件和未进入 Git/标准工具基线的改动不在本轮证明范围']);
      if (report === lastReport) return;
      lastReport = report;
      const shouldTrigger = result.findings.some(item => item.stage === 'needs_evidence' || item.status === 'review') && automaticReviewTurns < MAX_AUTOMATIC_REVIEW_TURNS;
      if (shouldTrigger) automaticReviewTurns++;
      publish(report, shouldTrigger);
    } catch (error) {
      publish(`anti-ai-slop 未检查：${error instanceof Error ? error.message : String(error)}`, false);
    }
  });

  pi.registerCommand('slop-check', {
    description: '审计最终改动；可传 JSON 路径数组限制文件',
    handler: async (args, ctx) => {
      if (!enabled()) { if (ctx.hasUI) ctx.ui.notify('anti-ai-slop 已禁用', 'info'); return; }
      try {
        const values = args.trim() ? JSON.parse(args) : undefined;
        if (values !== undefined && (!Array.isArray(values) || !values.length || values.length > MAX_FILES || values.some(value => typeof value !== 'string'))) throw new Error('参数须为 1—20 个文件路径的 JSON 数组');
        const result = await runAudit(ctx, values);
        if (!needsAttention(result)) { if (ctx.hasUI) ctx.ui.notify('anti-ai-slop：未发现需要复核的候选问题', 'info'); return; }
        if (ctx.hasUI) ctx.ui.notify('anti-ai-slop：已提交业务取证或复核任务', 'warning');
        publish(formatReport(result, '手动审计'), true);
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`anti-ai-slop 未检查：${error instanceof Error ? error.message : String(error)}`, 'warning');
      }
    },
  });
}
