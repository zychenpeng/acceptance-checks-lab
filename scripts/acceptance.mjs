import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_SHA: workflowSha, PR_NUMBER: pr, PR_HEAD: sha, RUNNER_TEMP: temp } = process.env;
const checkName = 'Acceptance / Exact multiplier suite';
const test = 'tests/unit/lib/calculator/multipliers.test.ts';
const subject = 'src/lib/calculator/multipliers.ts';
const detailsUrl = `https://github.com/${repo}/actions/runs/${run}`;

if (!/^\d+$/.test(pr) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid PR or head.');

function api(method, path, body) {
  const env = { ...process.env };
  delete env.BUZZER_FIXTURE;
  const args = ['api', '--method', method, `repos/${repo}/${path}`];
  if (body) args.push('--input', '-');
  const reply = spawnSync('gh', args, { env, input: body && JSON.stringify(body), encoding: 'utf8' });
  if (reply.error || reply.status !== 0) throw new Error(`GitHub ${method} ${path} failed: ${reply.stderr || reply.error?.message}`);
  return JSON.parse(reply.stdout);
}

function requireCurrentHead() {
  const request = api('GET', `pulls/${pr}`);
  if (request.state !== 'open' || request.head.sha !== sha || request.head.repo?.full_name !== repo || request.base.ref !== 'main') {
    throw new Error('The PR is not an open same-repository request for the expected head and base.');
  }
}

function runVitest() {
  const room = mkdtempSync(join(temp, 'private-vitest-'));
  const output = join(room, 'results.json');
  try {
    symlinkSync(resolve('node_modules'), join(room, 'node_modules'), 'dir');
    const fixture = JSON.parse(Buffer.from(process.env.BUZZER_FIXTURE || '', 'base64').toString('utf8'));
    for (const relative of [test, subject]) {
      const body = Buffer.from(fixture[relative], 'base64');
      const file = join(room, relative);
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, body, { mode: 0o600 });
    }
    const config = join(room, 'vitest.config.mjs');
    writeFileSync(config, `export default { root: ${JSON.stringify(room)}, resolve: { alias: { '@': ${JSON.stringify(join(room, 'src'))} } }, test: { environment: 'node' } };\n`);
    const env = { ...process.env };
    delete env.BUZZER_FIXTURE;
    delete env.GH_TOKEN;
    const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', test, '--config', config, '--reporter=json', `--outputFile=${output}`], { env, encoding: 'utf8' });
    const report = JSON.parse(readFileSync(output, 'utf8'));
    const total = report.numTotalTests;
    const passed = report.numPassedTests;
    return { total, passed, ok: result.status === 0 && report.success === true && passed === 10 && total === 10 };
  } catch {
    return { total: 0, passed: 0, ok: false };
  } finally {
    rmSync(room, { recursive: true, force: true });
  }
}

requireCurrentHead();
const candidate = api('GET', `contents/candidate.json?ref=${sha}`);
const candidateData = Buffer.from(candidate.content, 'base64');
const candidateDigest = createHash('sha256').update(candidateData).digest('hex');
const check = api('POST', 'check-runs', { name: checkName, head_sha: sha, status: 'in_progress', details_url: detailsUrl });
const tested = runVitest();
requireCurrentHead();
const receipt = { pr: Number(pr), head: sha, candidateDigest, workflowSha, run, rule: 'exact calculator multiplier unit suite', ...tested };
const summary = `Current PR head: \`${sha}\`\n\nOriginal Vitest suite: **${tested.passed}/${tested.total}** passed.\n\nFixture input SHA-256: \`${candidateDigest}\``;
api('PATCH', `check-runs/${check.id}`, {
  status: 'completed', conclusion: tested.ok ? 'success' : 'failure',
  output: { title: tested.ok ? 'Acceptance passed' : 'Acceptance failed', summary },
});
writeFileSync(join(temp, 'acceptance-result.json'), JSON.stringify(receipt, null, 2) + '\n');
appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
if (!tested.ok) process.exitCode = 1;
