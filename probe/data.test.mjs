// 策展数据完整性校验——评测工具的公信力压在这些文件上，一个脏条目会静默坏掉
// 页面或聚合。这些测试在 CI 里把数据当契约守住：结构、类型、来源链接、唯一性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));
const isHttp = (s) => typeof s === 'string' && /^https?:\/\//.test(s);

test('data/gateways.json: shape, types, unique ids', () => {
  const gws = readJson('data/gateways.json');
  assert.ok(Array.isArray(gws) && gws.length > 0, 'gateways 应为非空数组');
  const ids = new Set();
  for (const g of gws) {
    assert.ok(g.id && typeof g.id === 'string', `网关缺 id: ${JSON.stringify(g).slice(0,60)}`);
    assert.ok(!ids.has(g.id), `网关 id 重复: ${g.id}`); ids.add(g.id);
    assert.ok(g.name, `${g.id} 缺 name`);
    assert.ok(isHttp(g.baseUrl), `${g.id} baseUrl 应为 http(s): ${g.baseUrl}`);
    assert.ok(g.authEnv && typeof g.authEnv === 'string', `${g.id} 缺 authEnv`);
    assert.ok(Array.isArray(g.probeModels), `${g.id} probeModels 应为数组`);
  }
});

test('data/models.json: shape, non-negative prices, sourced benchmarks', () => {
  const doc = readJson('data/models.json');
  assert.ok(doc.unit && doc.asOf, '缺 unit/asOf');
  assert.ok(Array.isArray(doc.models) && doc.models.length > 0, 'models 非空数组');
  const ids = new Set();
  for (const m of doc.models) {
    assert.ok(m.id && m.name, `模型缺 id/name: ${JSON.stringify(m).slice(0,60)}`);
    assert.ok(!ids.has(m.id), `模型 id 重复: ${m.id}`); ids.add(m.id);
    assert.equal(typeof m.input, 'number', `${m.id} input 价应为数字`);
    assert.equal(typeof m.output, 'number', `${m.id} output 价应为数字`);
    assert.ok(m.input >= 0 && m.output >= 0, `${m.id} 价格不应为负`);
    assert.ok(m.source, `${m.id} 缺 source（每条数据要可溯源）`);
    if (m.bench && m.bench !== null) {
      const scoreKeys = ['mmluPro', 'gpqa', 'swe', 'aime'];
      const hasScore = scoreKeys.some((k) => typeof m.bench[k] === 'number');
      assert.ok(hasScore, `${m.id} bench 无任何数值分数`);
      assert.ok(m.bench.src, `${m.id} bench 缺 src（不臆造：分数必须挂来源）`);
      assert.ok(isHttp(m.bench.srcUrl), `${m.id} bench.srcUrl 应为 http(s) 链接`);
      assert.ok(m.bench.asOf, `${m.id} bench 缺 asOf 采集日期`);
      for (const k of scoreKeys) {
        if (m.bench[k] != null) assert.ok(m.bench[k] >= 0 && m.bench[k] <= 100, `${m.id}.${k} 分数应在 0-100`);
      }
    }
  }
  // benchCols 引用的 key 要和模型分数 key 一致
  for (const c of doc.benchCols ?? []) assert.ok(c.key && c.label, 'benchCols 条目缺 key/label');
  for (const h of doc.benchHubs ?? []) assert.ok(isHttp(h.url) && h.label, 'benchHubs 条目缺合法 url/label');
});

test('data/annotations/*.json: shape, allowed enums, evidence is null-or-link', () => {
  const VERIFY = new Set(['pass', 'fail', 'pending', 'baseline', 'none']);
  const STATUS = new Set(['good', 'warn', 'bad', 'unknown']);
  const dir = new URL('data/annotations/', root);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const a = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(a.id, `${f} 缺 id`);
    assert.ok(a.channel && VERIFY.has(a.channel.verify), `${f} channel.verify 非法: ${a.channel?.verify}`);
    for (const key of ['promptRetention', 'training']) {
      const p = a[key];
      assert.ok(p && STATUS.has(p.status), `${f} ${key}.status 非法: ${p?.status}`);
      assert.ok(p.evidence === null || isHttp(p.evidence), `${f} ${key}.evidence 应为 null 或 http 链接`);
    }
  }
});

test('referential integrity: every annotation id maps to a real gateway', () => {
  // aggregate 靠 annoById[gateway.id] 匹配——id 打错的标注会变成永不显示的死数据。
  const gwIds = new Set(readJson('data/gateways.json').map((g) => g.id));
  const dir = new URL('data/annotations/', root);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const a = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(gwIds.has(a.id), `标注 ${f} 的 id「${a.id}」不对应任何网关（孤儿标注/拼写错误）`);
  }
});
