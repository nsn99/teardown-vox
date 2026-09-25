#!/usr/bin/env node
/**
 * Заливка волн issues в GitHub.
 *
 * Идемпотентно: сопоставляет по заголовку, существующие обновляет,
 * новые создаёт. Метки и вехи создаются при необходимости.
 *
 *   node tools/issues/sync-issues.mjs --dry-run
 *   GH_TOKEN=<token> node tools/issues/sync-issues.mjs --repo owner/name
 *   GH_TOKEN=<token> node tools/issues/sync-issues.mjs --repo owner/name --close-done
 *
 * Токен берётся из GH_TOKEN или GITHUB_TOKEN. Репозиторий — из --repo,
 * GITHUB_REPOSITORY или origin в git.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.github.com';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dryRun = flag('dry-run');
const closeDone = flag('close-done');
const file = opt('file', join(here, 'waves.yaml'));

function detectRepo() {
  const explicit = opt('repo') ?? process.env.GITHUB_REPOSITORY;
  if (explicit) return explicit;
  try {
    const url = execSync('git remote get-url origin', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch {
    /* не git-репозиторий — не беда, для --dry-run не нужно */
  }
  return null;
}

const repo = detectRepo();
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;

const plan = parse(readFileSync(file, 'utf8'));
const issues = plan.issues ?? [];
const labels = plan.labels ?? [];
const milestones = plan.milestones ?? [];

// --------------------------------------------------------------------------

function summary() {
  const byMilestone = new Map();
  const byStatus = new Map();
  for (const it of issues) {
    const key = it.milestone ?? '(без вехи)';
    byMilestone.set(key, (byMilestone.get(key) ?? 0) + 1);
    const st = it.status ?? 'todo';
    byStatus.set(st, (byStatus.get(st) ?? 0) + 1);
  }
  console.log(`Файл:      ${file}`);
  console.log(`Репозиторий: ${repo ?? '(не определён)'}`);
  console.log(`Меток: ${labels.length}, вех: ${milestones.length}, issues: ${issues.length}`);
  console.log('');
  for (const m of milestones) {
    const n = byMilestone.get(m.title) ?? 0;
    const done = issues.filter((i) => i.milestone === m.title && i.status === 'done').length;
    const bar = n ? `${done}/${n}` : '—';
    console.log(`  ${m.title.padEnd(40)} ${bar}`);
  }
  console.log('');
  console.log(
    `  готово: ${byStatus.get('done') ?? 0}` +
      `, частично: ${byStatus.get('partial') ?? 0}` +
      `, не начато: ${byStatus.get('todo') ?? 0}`,
  );
}

function validate() {
  const titles = new Set();
  const milestoneTitles = new Set(milestones.map((m) => m.title));
  const labelNames = new Set(labels.map((l) => l.name));
  const problems = [];

  for (const it of issues) {
    if (!it.title) problems.push('issue без заголовка');
    if (titles.has(it.title)) problems.push(`дубликат заголовка: ${it.title}`);
    titles.add(it.title);
    if (it.milestone && !milestoneTitles.has(it.milestone)) {
      problems.push(`неизвестная веха у «${it.title}»: ${it.milestone}`);
    }
    for (const l of it.labels ?? []) {
      if (!labelNames.has(l)) problems.push(`неизвестная метка у «${it.title}»: ${l}`);
    }
    if (!['done', 'partial', 'todo', undefined].includes(it.status)) {
      problems.push(`неизвестный статус у «${it.title}»: ${it.status}`);
    }
    if (!it.body || !/\*\*Приёмка\*\*/.test(it.body)) {
      problems.push(`нет блока «Приёмка» у «${it.title}»`);
    }
  }
  return problems;
}

// --------------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${json?.message ?? text}`);
  }
  return json;
}

async function paged(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const chunk = await api(`${path}${sep}per_page=100&page=${page}`);
    if (!chunk || chunk.length === 0) break;
    out.push(...chunk);
    if (chunk.length < 100) break;
  }
  return out;
}

async function ensureLabels() {
  const existing = new Map((await paged(`/repos/${repo}/labels`)).map((l) => [l.name, l]));
  for (const l of labels) {
    if (existing.has(l.name)) {
      await api(`/repos/${repo}/labels/${encodeURIComponent(l.name)}`, {
        method: 'PATCH',
        body: { new_name: l.name, color: l.color, description: l.description ?? '' },
      });
      console.log(`  метка обновлена: ${l.name}`);
    } else {
      await api(`/repos/${repo}/labels`, {
        method: 'POST',
        body: { name: l.name, color: l.color, description: l.description ?? '' },
      });
      console.log(`  метка создана:   ${l.name}`);
    }
  }
}

async function ensureMilestones() {
  const existing = new Map(
    (await paged(`/repos/${repo}/milestones?state=all`)).map((m) => [m.title, m]),
  );
  const map = new Map();
  for (const m of milestones) {
    const found = existing.get(m.title);
    if (found) {
      map.set(m.title, found.number);
      console.log(`  веха есть:     ${m.title}`);
    } else {
      const created = await api(`/repos/${repo}/milestones`, {
        method: 'POST',
        body: { title: m.title, description: m.description ?? '' },
      });
      map.set(m.title, created.number);
      console.log(`  веха создана:  ${m.title}`);
    }
  }
  return map;
}

const STATUS_NOTE = {
  done: '> **Статус:** реализовано и покрыто тестами.',
  partial: '> **Статус:** частично реализовано — см. список ниже.',
  todo: '',
};

function renderBody(it) {
  const note = STATUS_NOTE[it.status ?? 'todo'];
  const parts = [];
  if (note) parts.push(note, '');
  parts.push((it.body ?? '').trimEnd());
  parts.push('', '---', '_Задача заведена из `tools/issues/waves.yaml`. Правки — там._');
  return parts.join('\n');
}

async function syncIssues(milestoneMap) {
  const existing = new Map(
    (await paged(`/repos/${repo}/issues?state=all`))
      .filter((i) => !i.pull_request)
      .map((i) => [i.title, i]),
  );

  let created = 0;
  let updated = 0;
  for (const it of issues) {
    const payload = {
      title: it.title,
      body: renderBody(it),
      labels: it.labels ?? [],
      milestone: it.milestone ? (milestoneMap.get(it.milestone) ?? null) : null,
    };
    const found = existing.get(it.title);
    if (found) {
      const next = { ...payload };
      if (closeDone) next.state = it.status === 'done' ? 'closed' : 'open';
      await api(`/repos/${repo}/issues/${found.number}`, { method: 'PATCH', body: next });
      updated++;
      console.log(`  #${found.number} обновлена: ${it.title}`);
    } else {
      const res = await api(`/repos/${repo}/issues`, { method: 'POST', body: payload });
      created++;
      console.log(`  #${res.number} создана:   ${it.title}`);
      if (closeDone && it.status === 'done') {
        await api(`/repos/${repo}/issues/${res.number}`, {
          method: 'PATCH',
          body: { state: 'closed' },
        });
      }
    }
  }
  console.log(`\nСоздано: ${created}, обновлено: ${updated}.`);
}

// --------------------------------------------------------------------------

async function main() {
  const problems = validate();
  if (problems.length > 0) {
    console.error('Ошибки в waves.yaml:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  summary();

  if (dryRun) {
    console.log('\n--dry-run: ничего не создаётся.');
    return;
  }
  if (!repo) {
    console.error('\nНе определён репозиторий. Передай --repo owner/name.');
    process.exit(1);
  }
  if (!token) {
    console.error('\nНет токена. Задай GH_TOKEN или GITHUB_TOKEN.');
    process.exit(1);
  }

  console.log('\nМетки:');
  await ensureLabels();
  console.log('\nВехи:');
  const milestoneMap = await ensureMilestones();
  console.log('\nIssues:');
  await syncIssues(milestoneMap);
  if (closeDone) {
    console.log('\nВехи, у которых всё сделано:');
    await closeFinishedMilestones(milestoneMap);
  }
}

/**
 * Закрыть вехи, у которых не осталось незакрытых задач.
 *
 * GitHub сам этого не делает: веха на ста процентах остаётся открытой
 * навсегда, и список вех перестаёт отвечать на единственный вопрос, ради
 * которого в него смотрят, — что ещё не сделано.
 *
 * Закрываем только те, где в плане все задачи done: считать по проценту
 * на сайте нельзя, там может висеть issue, заведённая руками мимо плана.
 */
async function closeFinishedMilestones(milestoneMap) {
  for (const m of milestones) {
    const mine = issues.filter((i) => i.milestone === m.title);
    if (mine.length === 0 || mine.some((i) => i.status !== 'done')) continue;
    const number = milestoneMap.get(m.title);
    if (!number) continue;
    const current = await api(`/repos/${repo}/milestones/${number}`);
    if (current.state === 'closed') {
      console.log(`  уже закрыта:   ${m.title}`);
      continue;
    }
    // Спрашиваем сами issues, а не счётчик вехи: счётчик обновляется не
    // сразу, и сразу после закрытия задач он показывает вчерашнее число.
    // Один прогон закрывал бы задачи, а вехи — только следующий, и это
    // выглядело бы как «команда не работает».
    const open = (await paged(`/repos/${repo}/issues?milestone=${number}&state=open`)).filter(
      (i) => !i.pull_request,
    );
    if (open.length > 0) {
      // На вехе висит что-то, чего нет в плане, — закрывать нельзя:
      // веха с открытой задачей внутри врёт сильнее, чем открытая веха.
      console.log(
        `  не закрываю:   ${m.title} — открыто ${open.map((i) => `#${i.number}`).join(', ')}`,
      );
      continue;
    }
    await api(`/repos/${repo}/milestones/${number}`, {
      method: 'PATCH',
      body: { state: 'closed' },
    });
    const verified = await api(`/repos/${repo}/milestones/${number}`);
    if (verified?.state !== 'closed') throw new Error(`GitHub не подтвердил закрытие вехи ${number}`);
    console.log(`  закрыта:       ${m.title}`);
  }
}

main().catch((err) => {
  console.error(`\nОшибка: ${err.message}`);
  process.exit(1);
});
