import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

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
const MAX_HUNKS_PER_FILE = 12;
const MAX_ROUTE_CALLS = 20;
const MAX_JUDGMENT_CALLS = 12;
const MAX_EVIDENCE_ITEMS = 6;
const ROUTE_THRESHOLD = 0.55;
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

function routeQuestions(rules) {
  return Object.fromEntries(rules.map((rule, index) => [`r${index}`, {
    type: 'noul',
    instructions: `本次修改是否可能落入规则“${rule.title}”的适用范围，值得进一步核对项目事实？范围：${rule.scope}。违规定义：${rule.violation}。这是召回优先的语义筛选，不要求当前证据足以判违规。`,
    criteria: { true: '候选片段与规则存在合理关联，需要核对。', false: '候选片段与规则明显无关。' },
  }]));
}

export async function semanticRoute(change, hunk, rules, request, ask, signal) {
  const state = {
    path: change.path,
    extension: extname(change.path).toLowerCase(),
    user_request: clipTail(request || '', REQUEST_LIMIT),
    change: hunk,
  };
  const response = await ask(state, routeQuestions(rules), { signal });
  return rules.map((rule, index) => ({ rule, applicability: probability(response, `r${index}`), hunk })).filter(item => item.applicability >= ROUTE_THRESHOLD);
}

function judgmentQuestions(rule) {
  return {
    violation: {
      type: 'noul',
      instructions: `结合 state.user_request、state.project_evidence 和 state.change，本次修改是否引入规则“${rule.title}”定义的违规？定义：${rule.violation}。例外：${rule.exceptions.join('；')}。只依据给定项目事实，不用通用偏好补全缺失信息。`,
      criteria: { true: { description: rule.violation, example: rule.bad }, false: { description: '没有违规、符合例外或项目事实支持当前实现', example: rule.good } },
    },
    evidence_sufficient: {
      type: 'noul',
      instructions: `给定证据是否足以对规则“${rule.title}”作出结论？需要的证据：${rule.requiredEvidence.join('；')}。state.project_evidence 是当前 LC 按取证请求通过项目工具取得的事实；带路径的需求原文、源码、组件接口、DESIGN.md 条款和页面观察应按其明确内容作为证据，除非彼此矛盾。只检查 required_evidence 是否覆盖，不额外要求规则未列出的材料；仍需猜测时回答否。`,
      criteria: { true: '用户要求、修改片段和项目工具证据已经覆盖 required_evidence，可以支持结论。', false: 'required_evidence 中仍有决定性项目事实缺失或相互矛盾。' },
    },
  };
}

export async function judgeWithEvidence(candidate, request, projectEvidence, ask, signal) {
  const state = {
    path: candidate.path,
    user_request: clipTail(request || '', REQUEST_LIMIT),
    rule: {
      id: candidate.rule.id,
      title: candidate.rule.title,
      scope: candidate.rule.scope,
      required_evidence: candidate.rule.requiredEvidence,
    },
    change: candidate.hunk,
    project_evidence: projectEvidence.slice(-MAX_EVIDENCE_ITEMS).map(item => ({ tool: item.tool, path: item.path, command: item.command, content: clip(item.content || '', EVIDENCE_LIMIT) })),
  };
  const response = await ask(state, judgmentQuestions(candidate.rule), { signal });
  const score = probability(response, 'violation');
  const sufficient = probability(response, 'evidence_sufficient');
  const status = score < candidate.rule.threshold ? 'clear' : sufficient >= REVIEW_THRESHOLD ? 'review' : 'uncertain';
  return { ...candidate, score, sufficient, status, stage: 'judged' };
}

function candidateKey(candidate) {
  return JSON.stringify([candidate.path, candidate.rule.id, candidate.hunk.changedStartLine, candidate.hunk.changedEndLine, candidate.hunk.changedAfter]);
}

function routeKey(change, hunk) {
  return `route:${JSON.stringify([change.path, hunk.changedStartLine, hunk.changedEndLine, hunk.changedAfter])}`;
}

export async function inspectChanges(changes, rules, request, evidence, rounds, ask, signal) {
  const routed = []; const errors = []; let routeCalls = 0; let limited = false;
  const rulesById = new Map(rules.map(rule => [rule.id, rule]));
  for (const change of changes) {
    const segmented = diffHunks(change.before, change.after);
    limited ||= segmented.limited;
    for (const hunk of segmented.hunks) {
      const key = routeKey(change, hunk);
      const cached = rounds.get(key);
      if (cached?.kind === 'route') {
        routed.push(...cached.selected.map(item => ({ rule: rulesById.get(item.ruleId), applicability: item.applicability, hunk, path: change.path })).filter(item => item.rule));
        continue;
      }
      if (routeCalls >= MAX_ROUTE_CALLS) { limited = true; break; }
      try {
        const selected = await semanticRoute(change, hunk, rules, request, ask, signal);
        routeCalls++;
        rounds.set(key, { kind: 'route', selected: selected.map(item => ({ ruleId: item.rule.id, applicability: item.applicability })) });
        routed.push(...selected.map(item => ({ ...item, path: change.path })));
      } catch (error) {
        errors.push(`${change.path}:${hunk.changedStartLine}-${hunk.changedEndLine}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const findings = []; let judgmentCalls = 0;
  for (const candidate of routed) {
    const key = candidateKey(candidate);
    const existing = rounds.get(key);
    if (!existing) {
      rounds.set(key, { evidenceStart: evidence.length });
      findings.push({ ...candidate, status: 'uncertain', stage: 'needs_evidence', requiredEvidence: candidate.rule.requiredEvidence });
      continue;
    }
    const freshEvidence = evidence.slice(existing.evidenceStart);
    const evidenceSignature = JSON.stringify(freshEvidence);
    if (existing.result && existing.evidenceSignature === evidenceSignature) {
      findings.push(existing.result);
      continue;
    }
    if (!freshEvidence.length || judgmentCalls >= MAX_JUDGMENT_CALLS) {
      if (judgmentCalls >= MAX_JUDGMENT_CALLS) limited = true;
      findings.push({ ...candidate, status: 'uncertain', stage: 'needs_evidence', requiredEvidence: candidate.rule.requiredEvidence });
      continue;
    }
    try {
      const judged = await judgeWithEvidence(candidate, request, freshEvidence, ask, signal);
      existing.result = judged;
      existing.evidenceSignature = evidenceSignature;
      findings.push(judged);
      judgmentCalls++;
    } catch (error) {
      errors.push(`${candidate.path}:${candidate.hunk.changedStartLine}-${candidate.hunk.changedEndLine} [${candidate.rule.id}]：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { findings, errors, routeCalls, judgmentCalls, limited, checkedFiles: changes.length };
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
  let evidence = [];
  let tracked = new Map();
  let pendingTrack = new Map();
  let rounds = new Map();
  let workspaceBaseline;
  let baselinePromise;
  let lastReport = '';
  let automaticReviewTurns = 0;
  const reset = () => { request = ''; evidence = []; tracked = new Map(); pendingTrack = new Map(); rounds = new Map(); workspaceBaseline = undefined; baselinePromise = undefined; lastReport = ''; automaticReviewTurns = 0; };
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
        evidence.push({ tool: event.toolName, path: event.input.path, command: event.input.command, content: clip(text, EVIDENCE_LIMIT) });
        if (evidence.length > 20) evidence.shift();
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
    return inspectChanges(changes, rules, request, evidence, rounds, ask, ctx.signal);
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
