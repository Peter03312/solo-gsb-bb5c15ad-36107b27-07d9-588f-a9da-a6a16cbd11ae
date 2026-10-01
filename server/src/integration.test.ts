import * as assert from 'assert';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { createApp } from './app';
import { initSchema } from './db';

// 使用真实 PostgreSQL 语义（PGlite / WASM）端到端校验全部业务规则。
async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  await initSchema();
  const server = createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/api`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

let seq = 0;
async function call(
  base: string,
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function expectFail(r: { status: number; json: any }, status: number, phrase: string) {
  assert.strictEqual(r.status, status, `期望 ${status}，实际 ${r.status}: ${JSON.stringify(r.json)}`);
  assert.ok(
    JSON.stringify(r.json).includes(phrase),
    `错误信息应包含「${phrase}」，实际：${JSON.stringify(r.json)}`
  );
}

async function main() {
  const { base, close } = await startServer();
  try {
    // ---------- 建档 ----------
    let r = await call(base, 'POST', '/documents', {
      title: `集成测试文献 ${++seq}`,
      manuscripts: ['甲本', '乙本', '丙本'],
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    const docId = r.json.id;

    let view = (await call(base, 'GET', `/documents/${docId}`)).json;
    const v1 = view.document.version;
    assert.strictEqual(v1, 1);
    const [msA, msB, msC] = view.manuscripts;
    assert.strictEqual(msA.name, '甲本');
    assert.ok(msA.isBase, '第一份抄本应为默认底本');

    // ---------- 逐行录文 ----------
    // 甲本（底本）：
    //  行1 天命之謂性率性之謂道
    //  行2 修道之謂教
    // 乙本：
    //  行1 天命之謂姓率性之謂道
    //  行2 修道之謂教也
    // 丙本：
    //  行1 天命之謂性
    //  行2 修道之謂教
    await call(base, 'POST', `/manuscripts/${msA.id}/lines`, { expectedVersion: v1, content: '天命之謂性率性之謂道' });
    await call(base, 'POST', `/manuscripts/${msA.id}/lines`, { expectedVersion: 2, content: '修道之謂教' });
    await call(base, 'POST', `/manuscripts/${msB.id}/lines`, { expectedVersion: 3, content: '天命之謂姓率性之謂道' });
    await call(base, 'POST', `/manuscripts/${msB.id}/lines`, { expectedVersion: 4, content: '修道之謂教也' });
    await call(base, 'POST', `/manuscripts/${msC.id}/lines`, { expectedVersion: 5, content: '天命之謂性' });
    await call(base, 'POST', `/manuscripts/${msC.id}/lines`, { expectedVersion: 6, content: '修道之謂教' });
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    const v7 = view.document.version;
    assert.strictEqual(v7, 7);

    const lines = (msId: number) => view.rawByMs.find((x: any) => x.msId === msId).lines;
    const a1 = lines(msA.id)[0].lineId;
    const a2 = lines(msA.id)[1].lineId;
    const b1 = lines(msB.id)[0].lineId;
    const b2 = lines(msB.id)[1].lineId;
    const c1 = lines(msC.id)[0].lineId;
    const c2 = lines(msC.id)[1].lineId;

    // ---------- 归组：合法整批 ----------
    const goodGroups = [
      // 组1 天命之謂性 / 天命之謂姓（异文）/ 天命之謂性
      { ord: 1, fragments: [
        { msId: msA.id, lineId: a1, startCp: 0, endCp: 5 },
        { msId: msB.id, lineId: b1, startCp: 0, endCp: 5 },
        { msId: msC.id, lineId: c1, startCp: 0, endCp: 5 },
      ]},
      // 组2 率性之謂道 / 率性之謂道 / 缺文
      { ord: 2, fragments: [
        { msId: msA.id, lineId: a1, startCp: 5, endCp: 10 },
        { msId: msB.id, lineId: b1, startCp: 5, endCp: 10 },
        { msId: msC.id, missing: true },
      ]},
      // 组3 修道之謂教（三者同文；丙本行2）
      { ord: 3, fragments: [
        { msId: msA.id, lineId: a2, startCp: 0, endCp: 5 },
        { msId: msB.id, lineId: b2, startCp: 0, endCp: 5 },
        { msId: msC.id, lineId: c2, startCp: 0, endCp: 5 },
      ]},
    ];
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: v7, groups: goodGroups });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.groupCount, 3);
    assert.strictEqual(view.stats.brokenCount, 0);
    assert.strictEqual(view.groups[0].variant, true, '性/姓应为异文');
    assert.strictEqual(view.groups[0].baseText, '天命之謂性');
    assert.strictEqual(view.groups[1].hasMissing, true, '丙本缺文');
    assert.strictEqual(view.groups[2].variant, false);

    // 未归组文字仍可见：乙本行2「也」无覆盖
    const b2view = view.rawByMs.find((x: any) => x.msId === msB.id).lines[1];
    assert.strictEqual(b2view.covered.length, 1);
    assert.strictEqual(b2view.covered[0].endCp, 5);

    // ---------- 错误：越界片段（须指出位置，不保存） ----------
    const badRange = JSON.parse(JSON.stringify(goodGroups));
    badRange[1].fragments[1] = { msId: msB.id, lineId: b1, startCp: 5, endCp: 99 };
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: badRange });
    await expectFail(r, 400, '越界');
    assert.ok(r.json.details.some((d: any) => d.code === 'OUT_OF_RANGE' && d.lineNo === 1));

    // ---------- 错误：同一抄本重叠归组 ----------
    const overlap = JSON.parse(JSON.stringify(goodGroups));
    overlap[0].fragments[1] = { msId: msB.id, lineId: b1, startCp: 0, endCp: 6 }; // 与组2 [5,10) 重叠
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: overlap });
    await expectFail(r, 400, '重叠归组');
    assert.ok(r.json.details.some((d: any) => d.code === 'OVERLAP'));

    // ---------- 错误：缺少底本片段 ----------
    const noBase = JSON.parse(JSON.stringify(goodGroups));
    noBase[0].fragments = noBase[0].fragments.filter((f: any) => f.msId !== msA.id);
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: noBase });
    await expectFail(r, 400, '缺少底本片段');
    assert.ok(r.json.details.some((d: any) => d.code === 'NO_BASE'));

    // ---------- 错误：底本片段被标缺文 ----------
    const baseMissing = JSON.parse(JSON.stringify(goodGroups));
    baseMissing[0].fragments[0] = { msId: msA.id, missing: true };
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: baseMissing });
    await expectFail(r, 400, '底本片段被标为缺文');

    // ---------- 错误：同组同抄本两个片段 ----------
    const dupMs = JSON.parse(JSON.stringify(goodGroups));
    dupMs[0].fragments.push({ msId: msB.id, lineId: b1, startCp: 8, endCp: 9 });
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: dupMs });
    await expectFail(r, 400, '出现多个片段');

    // ---------- 错误：不能部分保存 —— 校验失败后已保存数据保持 3 组完好 ----------
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.groupCount, 3);
    assert.strictEqual(view.stats.brokenCount, 0);

    // ---------- 乐观锁：过期版本拒绝 ----------
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: v7, groups: goodGroups });
    await expectFail(r, 409, '版本已过期');
    r = await call(base, 'POST', `/manuscripts/${msA.id}/lines`, { expectedVersion: 1, content: '过期请求' });
    await expectFail(r, 409, '版本已过期');

    // ---------- 改原文：只使受影响组待修复 ----------
    // 乙本行1「天命之謂姓率性之謂道」把「姓」改为「性」（[4,5)），与组1相交
    r = await call(base, 'PUT', `/lines/${b1}`, { expectedVersion: view.document.version, startCp: 4, endCp: 5, replacement: '性' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.brokenCount, 1, '仅组1受影响');
    assert.strictEqual(view.groups[0].broken, true);
    assert.strictEqual(view.groups[1].broken, false);
    assert.strictEqual(view.groups[2].broken, false);
    const curVer = view.document.version;

    // 待修复期间不得发布
    r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: curVer });
    await expectFail(r, 409, '待修复');

    // ---------- 修复组1（异文消失） ----------
    const g1id = view.groups[0].id;
    r = await call(base, 'PUT', `/documents/${docId}/groups/${g1id}/repair`, {
      expectedVersion: curVer,
      group: { ord: 1, fragments: [
        { msId: msA.id, lineId: a1, startCp: 0, endCp: 5 },
        { msId: msB.id, lineId: b1, startCp: 0, endCp: 5 },
        { msId: msC.id, lineId: c1, startCp: 0, endCp: 5 },
      ]},
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.brokenCount, 0);
    assert.strictEqual(view.groups[0].variant, false, '改字后甲乙一致，不再是异文');

    // 修复时与其他组重叠 → 拒绝
    r = await call(base, 'PUT', `/documents/${docId}/groups/${g1id}/repair`, {
      expectedVersion: view.document.version,
      group: { ord: 1, fragments: [
        { msId: msA.id, lineId: a1, startCp: 0, endCp: 6 }, // 与组2 [5,10) 重叠
        { msId: msB.id, lineId: b1, startCp: 0, endCp: 5 },
        { msId: msC.id, lineId: c1, startCp: 0, endCp: 5 },
      ]},
    });
    await expectFail(r, 400, '重叠归组');
    // 失败的修复不得改动既有状态
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.brokenCount, 0);

    // ---------- 插入导致后方片段平移（不受影响、不待修复） ----------
    // 乙本行2「修道之謂教也」：在开头插入「曰」[0,0)。组3片段 [0,5) 与插入点端点相接（不相交）→ 平移到 [1,6)
    r = await call(base, 'PUT', `/lines/${b2}`, { expectedVersion: view.document.version, startCp: 0, endCp: 0, replacement: '曰' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.brokenCount, 0, '端点相接的插入不应使组待修复');
    const b2cell = view.groups[2].cells.find((c: any) => c.msId === msB.id);
    assert.strictEqual(b2cell.text, '修道之謂教', '平移后截取文字不变');
    assert.strictEqual(b2cell.startCp, 1);
    assert.strictEqual(b2cell.endCp, 6);

    // ---------- 缩短导致越界 → 待修复，且修复前不得发布 ----------
    // 把甲本行1删到只剩 3 字：组1 [0,5)、组2 [5,10) 都失效
    r = await call(base, 'PUT', `/lines/${a1}`, { expectedVersion: view.document.version, startCp: 3, endCp: 10, replacement: '' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.brokenCount, 2);
    r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: view.document.version });
    await expectFail(r, 409, '不得发布');

    // 恢复原文（重新追加），再修复两组
    r = await call(base, 'PUT', `/lines/${a1}`, { expectedVersion: view.document.version, startCp: 3, endCp: 3, replacement: '之謂性率性之謂道' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    // 追加后区间仍保持原样且重新有效？[0,5) 现在合法、[5,10) 合法 —— 但组仍被标 broken（只增不减）
    assert.strictEqual(view.stats.brokenCount, 2);
    for (const g of view.groups.filter((x: any) => x.broken)) {
      const cells = g.cells;
      const rebuild: any[] = [];
      for (const ms of view.manuscripts) {
        const cell = cells.find((c: any) => c.msId === ms.id);
        if (cell.missing) rebuild.push({ msId: ms.id, missing: true });
        else if (cell.startCp != null) {
          // 重新定位行 id（按行号）
          const ln = view.rawByMs.find((x: any) => x.msId === ms.id).lines.find((l: any) => l.lineNo === cell.lineNo);
          rebuild.push({ msId: ms.id, lineId: ln.lineId, startCp: cell.startCp, endCp: cell.endCp });
        }
      }
      const rr = await call(base, 'PUT', `/documents/${docId}/groups/${g.id}/repair`, {
        expectedVersion: view.document.version,
        group: { ord: g.ord, fragments: rebuild },
      });
      assert.strictEqual(rr.status, 200, JSON.stringify(rr.json));
      view = (await call(base, 'GET', `/documents/${docId}`)).json;
    }
    assert.strictEqual(view.stats.brokenCount, 0);

    // ---------- 发布 ----------
    r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: view.document.version });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.editionNo, 1);
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.document.publishedVer, 1);

    // 旧版可读（快照）
    const ed = (await call(base, 'GET', `/documents/${docId}/editions/1`)).json;
    assert.strictEqual(ed.view.document.title, view.document.title);
    assert.strictEqual(ed.view.groups.length, 3);
    const eds = (await call(base, 'GET', `/documents/${docId}/editions`)).json;
    assert.strictEqual(eds.editions.length, 1);

    // 发布后继续改原文 → 出现待修复，但旧版仍可读、且不允许发新版
    r = await call(base, 'PUT', `/lines/${a2}`, { expectedVersion: view.document.version, startCp: 0, endCp: 1, replacement: '脩' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.ok(view.stats.brokenCount >= 1);
    r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: view.document.version });
    await expectFail(r, 409, '不得发布');
    const oldEd = await call(base, 'GET', `/documents/${docId}/editions/1`);
    assert.strictEqual(oldEd.status, 200, '旧发布版必须仍可阅读');

    // ---------- 倒置检测：另建一文献 ----------
    r = await call(base, 'POST', '/documents', { title: `倒置测试 ${++seq}`, manuscripts: ['底', 'W'] });
    assert.strictEqual(r.status, 201);
    const d2 = r.json.id;
    let v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
    let ver = v2doc.document.version;
    const base2 = v2doc.manuscripts[0];
    const wit2 = v2doc.manuscripts[1];
    // 底：行1 AB；W：行1 BA
    await call(base, 'POST', `/manuscripts/${base2.id}/lines`, { expectedVersion: ver++, content: 'AB' });
    await call(base, 'POST', `/manuscripts/${wit2.id}/lines`, { expectedVersion: ver++, content: 'BA' });
    v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
    const bl = v2doc.rawByMs.find((x: any) => x.msId === base2.id).lines[0].lineId;
    const wl = v2doc.rawByMs.find((x: any) => x.msId === wit2.id).lines[0].lineId;
    // 组1: 底 A / W 第2字；组2: 底 B / W 第1字 → W 中顺序倒置
    r = await call(base, 'PUT', `/documents/${d2}/groups`, {
      expectedVersion: ver,
      groups: [
        { ord: 1, fragments: [
          { msId: base2.id, lineId: bl, startCp: 0, endCp: 1 },
          { msId: wit2.id, lineId: wl, startCp: 1, endCp: 2 },
        ]},
        { ord: 2, fragments: [
          { msId: base2.id, lineId: bl, startCp: 1, endCp: 2 },
          { msId: wit2.id, lineId: wl, startCp: 0, endCp: 1 },
        ]},
      ],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
    assert.ok(v2doc.groups[0].inverted && v2doc.groups[1].inverted, '两组都应标倒置');

    // ---------- 切底本：不含新底本片段的组待修复 ----------
    // 给 d2 加第三个抄本 C 并切为底本（其行无任何片段）
    r = await call(base, 'POST', `/documents/${d2}/manuscripts`, { expectedVersion: v2doc.document.version, name: 'C' });
    assert.strictEqual(r.status, 201);
    v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
    const cId3 = v2doc.manuscripts.find((m: any) => m.name === 'C').id;
    r = await call(base, 'PUT', `/documents/${d2}/base`, { expectedVersion: v2doc.document.version, msId: cId3 });
    assert.strictEqual(r.status, 200);
    v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
    assert.strictEqual(v2doc.stats.brokenCount, 2, '切换底本后原两组均缺新底本片段');

    // ---------- 版本对照：已发布校勘版 vs 当前工作版 ----------
    // 新建独立文献，避免受上面修复/改字流程干扰
    r = await call(base, 'POST', '/documents', { title: `版本对照测试 ${++seq}`, manuscripts: ['底甲', '乙', '丙'] });
    assert.strictEqual(r.status, 201);
    const d3 = r.json.id;
    let d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    let d3ver = d3v.document.version;
    const dmA = d3v.manuscripts[0]; // 底甲（默认底本）
    const dmB = d3v.manuscripts[1];
    const dmC = d3v.manuscripts[2];
    await call(base, 'POST', `/manuscripts/${dmA.id}/lines`, { expectedVersion: d3ver++, content: '天命之謂性' });
    await call(base, 'POST', `/manuscripts/${dmB.id}/lines`, { expectedVersion: d3ver++, content: '天命之謂姓' });
    await call(base, 'POST', `/manuscripts/${dmC.id}/lines`, { expectedVersion: d3ver++, content: '天命之謂性' });
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    const da1 = d3v.rawByMs.find((x: any) => x.msId === dmA.id).lines[0].lineId;
    const db1 = d3v.rawByMs.find((x: any) => x.msId === dmB.id).lines[0].lineId;
    const dc1 = d3v.rawByMs.find((x: any) => x.msId === dmC.id).lines[0].lineId;

    const groupsV1 = [
      { ord: 1, fragments: [
        { msId: dmA.id, lineId: da1, startCp: 0, endCp: 5 },
        { msId: dmB.id, lineId: db1, startCp: 0, endCp: 5 },
        { msId: dmC.id, lineId: dc1, startCp: 0, endCp: 5 },
      ]},
    ];
    r = await call(base, 'PUT', `/documents/${d3}/groups`, { expectedVersion: d3v.document.version, groups: groupsV1 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const prePublishVersion = (await call(base, 'GET', `/documents/${d3}`)).json.document.version;
    r = await call(base, 'POST', `/documents/${d3}/publish`, { expectedVersion: prePublishVersion });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.editionNo, 1);
    // 发布即定稿：快照版本号 = bump 后的工作版版本号（两侧均显示“版本号”）
    const v1version = (await call(base, 'GET', `/documents/${d3}`)).json.document.version;
    assert.strictEqual(v1version, prePublishVersion + 1);
    assert.strictEqual((await call(base, 'GET', `/documents/${d3}/editions/1`)).json.view.document.version, v1version);

    // 发布后：新增第 2 行（甲「率性之謂道」、乙同文、丙缺文），改乙第 1 行 姓→性，整批重存（组 ID 全部更换）
    await call(base, 'POST', `/manuscripts/${dmA.id}/lines`, { expectedVersion: v1version, content: '率性之謂道' });
    await call(base, 'POST', `/manuscripts/${dmB.id}/lines`, { expectedVersion: v1version + 1, content: '率性之謂道' });
    // 新增抄本丁（不录文）
    await call(base, 'POST', `/documents/${d3}/manuscripts`, { expectedVersion: v1version + 2, name: '丁' });
    r = await call(base, 'PUT', `/lines/${db1}`, {
      expectedVersion: v1version + 3, startCp: 4, endCp: 5, replacement: '性',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    const da2 = d3v.rawByMs.find((x: any) => x.msId === dmA.id).lines[1].lineId;
    const db2 = d3v.rawByMs.find((x: any) => x.msId === dmB.id).lines[1].lineId;
    const groupsV2 = [
      { ord: 1, fragments: [
        { msId: dmA.id, lineId: da1, startCp: 0, endCp: 5 },
        { msId: dmB.id, lineId: db1, startCp: 0, endCp: 5 },
        { msId: dmC.id, lineId: dc1, startCp: 0, endCp: 5 },
      ]},
      { ord: 2, fragments: [
        { msId: dmA.id, lineId: da2, startCp: 0, endCp: 5 },
        { msId: dmB.id, lineId: db2, startCp: 0, endCp: 5 },
        { msId: dmC.id, missing: true },
      ]},
    ];
    r = await call(base, 'PUT', `/documents/${d3}/groups`, { expectedVersion: d3v.document.version, groups: groupsV2 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const v2version = (await call(base, 'GET', `/documents/${d3}`)).json.document.version;

    let diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
    // 两侧底本与版本号
    assert.strictEqual(diff.sides.old.kind, 'edition');
    assert.strictEqual(diff.sides.old.editionNo, 1);
    assert.strictEqual(diff.sides.old.version, v1version, '旧侧版本号应为快照定稿时的版本号');
    assert.strictEqual(diff.sides.old.baseMsName, '底甲');
    assert.strictEqual(diff.sides.new.kind, 'working');
    assert.strictEqual(diff.sides.new.version, v2version);
    assert.strictEqual(diff.baseSame, true);
    // 行文：甲新增行2、乙行1改字 + 新增行2
    const a1Diff = diff.textChanges.find((t: any) => t.msId === dmA.id && t.lineNo === 1);
    assert.ok(!a1Diff, '甲行1未改动，不应出现');
    const a2Diff = diff.textChanges.find((t: any) => t.msId === dmA.id && t.lineNo === 2);
    assert.strictEqual(a2Diff.status, 'added');
    const b1Diff = diff.textChanges.find((t: any) => t.msId === dmB.id && t.lineNo === 1);
    assert.strictEqual(b1Diff.status, 'changed');
    assert.ok(b1Diff.segments.some((s: any) => s.op === 'removed' && s.text === '姓'), '应有删除「姓」');
    assert.ok(b1Diff.segments.some((s: any) => s.op === 'added' && s.text === '性'), '应有新增「性」');
    // 新增抄本丁
    assert.ok(diff.manuscripts.find((m: any) => m.name === '丁' && !m.inOld && m.inNew), '丁应为新增抄本');
    // 组配对：不得凭 ID——两组底本位置 [行1,0,5) 相同且唯一 → 配对；[行2,0,5) 仅新侧 → 新未配对
    assert.strictEqual(diff.groupDiff.counts.paired, 1);
    assert.strictEqual(diff.groupDiff.counts.unpairedOld, 0);
    assert.strictEqual(diff.groupDiff.counts.unpairedNew, 1);
    assert.strictEqual(diff.groupDiff.unpairedNew[0].reason, 'not-matched');
    assert.ok(diff.groupDiff.unpairedNew[0].cells.some((c: any) => c.msId === dmC.id && c.state === 'missing'),
      '未配对新组应显式呈现丙的缺文标记');
    const paired1 = diff.groupDiff.paired[0];
    assert.strictEqual(paired1.status, 'changed');
    assert.strictEqual(paired1.ordChanged, false);
    // 整批重存更换了组 ID，但仍能配对（不凭 ID）
    assert.notStrictEqual(paired1.oldGroupId, paired1.newGroupId);
    const bChange = paired1.cellChanges.find((c: any) => c.msId === dmB.id);
    assert.ok(bChange, '乙本片段应有变化条目');
    assert.strictEqual(bChange.textChanged, true, '姓→性为确定文字改动（两侧均完好）');
    assert.strictEqual(bChange.oldText, '天命之謂姓');
    assert.strictEqual(bChange.newText, '天命之謂性');
    assert.ok(
      !paired1.cellChanges.some((c: any) => c.msId === dmA.id),
      '甲本无变化，不应出现在变化条目里'
    );

    // 对照是只读：再次取工作版版本号不变
    assert.strictEqual((await call(base, 'GET', `/documents/${d3}`)).json.document.version, v2version,
      '对照不得修改工作版');

    // 旧版不存在 → 404，错误信息明确
    r = await call(base, 'GET', `/documents/${d3}/editions/99/diff`);
    await expectFail(r, 404, '不存在');

    // 刷新即反映最新工作版：再做一次改动后重新对照，行文变化应包含新改动
    r = await call(base, 'PUT', `/lines/${da2}`, {
      expectedVersion: v2version, startCp: 0, endCp: 1, replacement: '脩',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
    // 甲第 2 行在旧版整行不存在 → 始终为“新增行”，改字后新增文本应是最新的「脩性之謂道」
    const a2AfterEdit = diff.textChanges.find((t: any) => t.msId === dmA.id && t.lineNo === 2);
    assert.strictEqual(a2AfterEdit.status, 'added');
    assert.ok(a2AfterEdit.newText.includes('脩') && !a2AfterEdit.newText.includes('修'),
      '刷新后新增行内容应反映最新工作版改字');
    // 乙第 2 行同为新增行，内容未受影响
    const b2AfterEdit = diff.textChanges.find((t: any) => t.msId === dmB.id && t.lineNo === 2);
    assert.strictEqual(b2AfterEdit.newText, '率性之謂道');
    // 改字与组2底本片段 [0,5) 相交 → 组2待修复；片段仍在行内：字面文字确定，但须显式标待修复
    let npAfterEdit = diff.groupDiff.unpairedNew.find((g: any) => g.ord === 2);
    assert.ok(npAfterEdit.broken, '相交改动后组2应为待修复并显式标识');
    const baseCellInRange = npAfterEdit.cells.find((c: any) => c.isBase);
    assert.strictEqual(baseCellInRange.broken, true);
    assert.strictEqual(baseCellInRange.outOfBounds, false, '行内片段不算越界');
    assert.strictEqual(baseCellInRange.text, '脩性之謂道', '行内待修复片段的字面文字仍为确定文字');

    // 真正缩短甲第 2 行至 3 字 → 组2底本片段 [0,5) 越界：现存部分不作确定文字
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    r = await call(base, 'PUT', `/lines/${da2}`, {
      expectedVersion: d3v.document.version, startCp: 3, endCp: 5, replacement: '',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
    npAfterEdit = diff.groupDiff.unpairedNew.find((g: any) => g.ord === 2);
    const baseCellOob = npAfterEdit.cells.find((c: any) => c.isBase);
    assert.ok(baseCellOob.broken && baseCellOob.outOfBounds, '缩短越界须显式标识');
    assert.strictEqual(baseCellOob.text, null, '越界片段不得作为确定文字');
    assert.strictEqual(baseCellOob.visibleText, '脩性之', '越界前可见部分仅供参考');
    assert.strictEqual(baseCellOob.oobEnd, 3);

    // 恢复甲第 2 行原文，供后续修复
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    r = await call(base, 'PUT', `/lines/${da2}`, {
      expectedVersion: d3v.document.version, startCp: 3, endCp: 3, replacement: '之謂道',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));

    // ---------- 底本不同：组不配对，旧组与新组分别列出 ----------
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    // 先修复组2，使切底本场景干净
    const g2id = d3v.groups.find((g: any) => g.ord === 2).id;
    r = await call(base, 'PUT', `/documents/${d3}/groups/${g2id}/repair`, {
      expectedVersion: d3v.document.version,
      group: { ord: 2, fragments: [
        { msId: dmA.id, lineId: da2, startCp: 0, endCp: 5 },
        { msId: dmB.id, lineId: db2, startCp: 0, endCp: 5 },
        { msId: dmC.id, missing: true },
      ]},
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    // 切换底本到丙：两组均无丙的真实片段 → 全部待修复
    r = await call(base, 'PUT', `/documents/${d3}/base`, { expectedVersion: d3v.document.version, msId: dmC.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
    assert.strictEqual(diff.baseSame, false, '两侧底本不同');
    assert.strictEqual(diff.groupDiff.counts.paired, 0, '底本不同不得配对');
    assert.strictEqual(diff.groupDiff.unpairedOld.length, 1, '旧版 1 组整组列出');
    assert.strictEqual(diff.groupDiff.unpairedNew.length, 2, '工作版 2 组整组列出');
    assert.ok(diff.groupDiff.unpairedNew.every((g: any) => g.reason === 'base-differs'),
      '底本不同原因须显式标注');
    const nbG1 = diff.groupDiff.unpairedNew.find((g: any) => g.ord === 1);
    const nbG2 = diff.groupDiff.unpairedNew.find((g: any) => g.ord === 2);
    assert.strictEqual(nbG1.broken, false, '组1含新底本丙的真实片段，不需待修复');
    assert.strictEqual(nbG2.broken, true, '组2新底本丙仅标缺文，须带待修复标识');
    assert.ok(diff.groupDiff.unpairedOld[0].cells.some((c: any) => c.isBase && c.text === '天命之謂性'),
      '旧组底本文字仍应确定呈现');

    // ---------- 补配：底本文字 → 目标抄本空闲区间候选 ----------
    // 甲（底）；乙（目标，尚无任何片段）；丁（另一无片段抄本）
    r = await call(base, 'POST', '/documents', { title: `补配测试 ${++seq}`, manuscripts: ['甲', '乙', '丁'] });
    assert.strictEqual(r.status, 201);
    const dS = r.json.id;
    let sView = (await call(base, 'GET', `/documents/${dS}`)).json;
    let sVer = sView.document.version;
    const [sA, sB, sD] = sView.manuscripts;
    // 甲（底本）行1（14 字，底本片段各占不重叠区间）：
    //  g1 天命 [0,2)  g2 丙丁 [2,4)  g3 丁戊 [4,6)  g4 戊己 [6,8)
    //  g5 庚辛 [8,10)  g6 壬癸 [10,12)  g7 子 [12,13)  g8 寅 [13,14)
    await call(base, 'POST', `/manuscripts/${sA.id}/lines`, {
      expectedVersion: sVer++, content: '天命丙丁丁戊戊己庚辛壬癸子丑寅',
    });
    // 乙（目标，行1；按码点偏移；字符 = 天命丙丁戊己丁戊己X壬癸寅子𠀀，X=占字占位使偏移固定）：
    //  天命[0,2) g1；丙丁[2,4) 与 丁戊[3,5) 候选互相重叠（冲突）；
    //  戊己[4,6) 与 [7,9) 两处空闲（multiple）；庚辛 无（none）；壬癸[10,12) 唯一；
    //  [8,9) 为 g7 已存在片段（占字「庚」，文字与 g7 无关，仅用于占区间→g7 排除、g8 命中处被占）；
    //  寅[13,14) 被 g7 片段? 否——g8 寅出现在 [12,13)，与 g7[8,9) 不冲突 → 直接改 g7 底本为寅使占用；
    //  末位𠀀为代理对（1 码点）
    await call(base, 'POST', `/manuscripts/${sB.id}/lines`, {
      expectedVersion: sVer++, content: '天命丙丁戊己丁戊己庚壬癸寅子𠀀',
    });
    // 丁：行1 只有「天命」
    await call(base, 'POST', `/manuscripts/${sD.id}/lines`, { expectedVersion: sVer++, content: '天命' });
    sView = (await call(base, 'GET', `/documents/${dS}`)).json;
    const sa1 = sView.rawByMs.find((x: any) => x.msId === sA.id).lines[0].lineId;
    const sb1 = sView.rawByMs.find((x: any) => x.msId === sB.id).lines[0].lineId;

    const sGroups = [
      { ord: 1, fragments: [{ msId: sA.id, lineId: sa1, startCp: 0, endCp: 2 }] },  // 天命
      { ord: 2, fragments: [{ msId: sA.id, lineId: sa1, startCp: 2, endCp: 4 }] },  // 丙丁
      { ord: 3, fragments: [{ msId: sA.id, lineId: sa1, startCp: 4, endCp: 6 }] },  // 丁戊
      { ord: 4, fragments: [{ msId: sA.id, lineId: sa1, startCp: 6, endCp: 8 }] },  // 戊己
      { ord: 5, fragments: [{ msId: sA.id, lineId: sa1, startCp: 8, endCp: 10 }] }, // 庚辛（无）
      { ord: 6, fragments: [{ msId: sA.id, lineId: sa1, startCp: 10, endCp: 12 }] },// 壬癸
      { ord: 7, fragments: [
        { msId: sA.id, lineId: sa1, startCp: 13, endCp: 14 },                        // 寅
        { msId: sB.id, lineId: sb1, startCp: 12, endCp: 13 },                        // 寅（乙已有片段→排除、占住目标寅）
      ]},
    ];
    r = await call(base, 'PUT', `/documents/${dS}/groups`, { expectedVersion: sView.document.version, groups: sGroups });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    sView = (await call(base, 'GET', `/documents/${dS}`)).json;
    const gById = new Map<number, any>(sView.groups.map((g: any) => [g.ord, g] as [number, any]));
    const verAfterGroups = sView.document.version;

    // 制造一个待修复组（改甲行使 g1 底本片段越界）：先补一个 g8 只在甲，再删短甲行后恢复组——
    // 直接改字相交即可令某组 broken：改甲行第 0 字相交 g1
    r = await call(base, 'PUT', `/lines/${sa1}`, {
      expectedVersion: sView.document.version, startCp: 0, endCp: 1, replacement: 'X',
    });
    assert.strictEqual(r.status, 200);
    sView = (await call(base, 'GET', `/documents/${dS}`)).json;
    assert.strictEqual(sView.groups.find((g: any) => g.ord === 1).broken, true, 'g1 应为待修复');
    // 恢复甲行文字（组仍 broken，只增不减）
    r = await call(base, 'PUT', `/lines/${sa1}`, {
      expectedVersion: sView.document.version, startCp: 0, endCp: 1, replacement: '天',
    });
    assert.strictEqual(r.status, 200);
    sView = (await call(base, 'GET', `/documents/${dS}`)).json;
    assert.strictEqual(sView.groups.find((g: any) => g.ord === 1).broken, true);

    // 对乙预览：g1 待修复排除；g7 乙已有片段排除；其余 g2..g6 纳入（5 组）
    let prev: any = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sB.id}`)).json;
    assert.strictEqual(prev.version, sView.document.version, '预览携带当前版本号');
    assert.strictEqual(prev.eligibleGroupCount, 5);
    assert.strictEqual(prev.excludedGroupCount, 2, 'g1 待修复 + g7 已有片段');
    const pByOrd = new Map<number, any>(prev.groups.map((g: any) => [g.ord, g] as [number, any]));
    // g2 丙丁：候选 [2,4) 唯一，但与 g3 丁戊候选 [3,5) 重叠 → conflict，不可直接采纳
    const pg2 = pByOrd.get(2);
    assert.strictEqual(pg2.status, 'conflict');
    assert.strictEqual(pg2.adoptable, false);
    assert.strictEqual(pg2.candidates.length, 1);
    assert.deepStrictEqual(pg2.candidates[0].conflictsWithGroupIds, [gById.get(3).id]);
    // g3 丁戊本身两处（multiple），其中 [3,5) 与 g2 冲突、[6,8) 与 g4 冲突，均显式标出
    const pg3 = pByOrd.get(3);
    assert.strictEqual(pg3.status, 'multiple');
    assert.deepStrictEqual(pg3.candidates.map((x: any) => [x.startCp, x.endCp]), [[3, 5], [6, 8]]);
    assert.deepStrictEqual(pg3.candidates[0].conflictsWithGroupIds, [gById.get(2).id, gById.get(4).id]);
    // g4 戊己：[4,6) 与 [7,9) 两处空闲 → multiple
    const pg4 = pByOrd.get(4);
    assert.strictEqual(pg4.status, 'multiple');
    assert.strictEqual(pg4.adoptable, false);
    assert.strictEqual(pg4.candidates.length, 2);
    assert.deepStrictEqual(pg4.candidates.map((x: any) => [x.startCp, x.endCp]), [[4, 6], [7, 9]]);
    // g5 庚辛：无候选
    assert.strictEqual(pByOrd.get(5).status, 'none');
    assert.strictEqual(pByOrd.get(5).candidates.length, 0);
    // g6 壬癸：[10,12) 唯一无冲突 → unique 可直接采纳
    const pg6 = pByOrd.get(6);
    assert.strictEqual(pg6.status, 'unique');
    assert.strictEqual(pg6.adoptable, true);
    assert.strictEqual(pg6.candidates[0].lineNo, 1);
    assert.strictEqual(pg6.candidates[0].startCp, 10);
    assert.strictEqual(pg6.candidates[0].endCp, 12);

    // 预览只读：版本不变
    assert.strictEqual((await call(base, 'GET', `/documents/${dS}`)).json.document.version, sView.document.version);

    // 目标抄本 = 底本：所有完好组都已有底本片段，纳入 0 组
    const prevBase = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sA.id}`)).json;
    assert.strictEqual(prevBase.eligibleGroupCount, 0);
    // 缺 targetMsId → 400；非本文献抄本 → 400
    await expectFail(await call(base, 'GET', `/documents/${dS}/supplement/preview`), 400, 'targetMsId');

    // 对丁预览：g2..g7 均无同文（丁行只有「天命」），全部 none
    const prevD = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sD.id}`)).json;
    assert.strictEqual(prevD.eligibleGroupCount, 6);
    assert.ok(prevD.groups.every((g: any) => g.status === 'none'), '丁行无其余底本文字');

    // 码点安全：乙行末「𠀀」为代理对；修复 g1 时把底本片段指向甲第 2 行的「天命」之外的𠀀，
    // 验证候选按码点计 1。甲第 2 行仅含该扩展 B 区字。
    await call(base, 'POST', `/manuscripts/${sA.id}/lines`, { expectedVersion: sView.document.version, content: '𠀀' });
    sView = (await call(base, 'GET', `/documents/${dS}`)).json;
    const sa2 = sView.rawByMs.find((x: any) => x.msId === sA.id).lines.find((l: any) => l.lineNo === 2).lineId;
    r = await call(base, 'PUT', `/documents/${dS}/groups/${gById.get(1).id}/repair`, {
      expectedVersion: sView.document.version,
      group: { ord: 1, fragments: [{ msId: sA.id, lineId: sa2, startCp: 0, endCp: 1 }] },
    });
    assert.strictEqual(r.status, 200, `把 g1 修复为底本「𠀀」: ${JSON.stringify(r.json)}`);
    prev = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sB.id}`)).json;
    const pg1 = prev.groups.find((g: any) => g.ord === 1);
    assert.ok(pg1, 'g1 修复后应纳入补配');
    assert.strictEqual(pg1.status, 'unique');
    assert.strictEqual(pg1.candidates[0].startCp, 14, '𠀀 按码点为第 15 字（偏移 14）');
    assert.strictEqual(pg1.candidates[0].endCp, 15);
    assert.strictEqual(pg1.candidates[0].text, '𠀀');
    const verBeforeCommit = (await call(base, 'GET', `/documents/${dS}`)).json.document.version;

    // 冲突组各选一处（g2 丙丁 [2,4) + g3 丁戊 [3,5)，预览已标 conflict）：
    // 提交时在当前版重核为候选互相重叠 → 409 SELECTION_OVERLAP，整批拒绝、不写入、不推进
    r = await call(base, 'POST', `/documents/${dS}/supplement`, {
      expectedVersion: verBeforeCommit,
      targetMsId: sB.id,
      selections: [
        { groupId: gById.get(2).id, msId: sB.id, lineId: sb1, startCp: 2, endCp: 4 },
        { groupId: gById.get(3).id, msId: sB.id, lineId: sb1, startCp: 3, endCp: 5 },
      ],
    });
    await expectFail(r, 409, '候选失效');
    assert.ok(r.json.details.issues.some((i: any) => i.code === 'SELECTION_OVERLAP'));
    assert.strictEqual((await call(base, 'GET', `/documents/${dS}`)).json.document.version, verBeforeCommit,
      '重叠整批拒绝不推进');

    // 提交：g1(𠀀) + g2(丙丁) + g4 第二处(戊己 [7,9)) + g6(壬癸)；
    // 跳过冲突对的 g3、多候选 g4 第一处、无候选 g5、已有片段 g7
    r = await call(base, 'POST', `/documents/${dS}/supplement`, {
      expectedVersion: verBeforeCommit,
      targetMsId: sB.id,
      selections: [
        { groupId: gById.get(1).id, msId: sB.id, lineId: sb1, startCp: 14, endCp: 15 },
        { groupId: gById.get(2).id, msId: sB.id, lineId: sb1, startCp: 2, endCp: 4 },
        { groupId: gById.get(4).id, msId: sB.id, lineId: sb1, startCp: 7, endCp: 9 },
        { groupId: gById.get(6).id, msId: sB.id, lineId: sb1, startCp: 10, endCp: 12 },
      ],
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.applied, 4);
    assert.strictEqual(r.json.version, verBeforeCommit + 1, '整批只推进一次版本');

    // 写入后读模型：相应组在乙有同文片段，未选组保持不变
    sView = (await call(base, 'GET', `/documents/${dS}`)).json;
    for (const ord of [1, 2, 4, 6]) {
      const cell = sView.groups.find((g: any) => g.ord === ord).cells.find((c: any) => c.msId === sB.id);
      assert.ok(cell && !cell.missing && cell.startCp != null, `g${ord} 应已有乙片段`);
    }
    const g3cell = sView.groups.find((g: any) => g.ord === 3).cells.find((c: any) => c.msId === sB.id);
    assert.ok(!g3cell || (!g3cell.missing && g3cell.startCp == null), '未选的 g3 不应被写入');
    assert.strictEqual(sView.stats.brokenCount, 0, '补配不改变待修复状态，且现已无待修复');

    // 重新预览：已补配的 g1/g2/g4/g6 与 g7 排除，仅余 g3、g5；
    //  g3「丁戊」[3,5) 与新写入的 g2 片段 [2,4) 重叠 → 不再是候选 → none
    prev = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sB.id}`)).json;
    assert.strictEqual(prev.eligibleGroupCount, 2);
    assert.strictEqual(prev.groups.find((g: any) => g.ord === 3).status, 'none',
      '冲突对方被采纳后，g3 候选因占用现存片段而消失');
    assert.strictEqual(prev.groups.find((g: any) => g.ord === 5).status, 'none');

    // 过期版本提交 → 409，不写入、不推进
    const verNow = (await call(base, 'GET', `/documents/${dS}`)).json.document.version;
    r = await call(base, 'POST', `/documents/${dS}/supplement`, {
      expectedVersion: verBeforeCommit,
      targetMsId: sD.id,
      selections: [{ groupId: gById.get(1).id, msId: sD.id, lineId: sa2, startCp: 0, endCp: 1 }],
    });
    await expectFail(r, 409, '版本已过期');
    assert.strictEqual((await call(base, 'GET', `/documents/${dS}`)).json.document.version, verNow, '409 不推进版本');

    // 候选失效：对丁提交 g1（丁行无「𠀀」）→ 409 整批拒绝、不推进、原因 TEXT_MISMATCH/越界
    r = await call(base, 'POST', `/documents/${dS}/supplement`, {
      expectedVersion: verNow,
      targetMsId: sD.id,
      selections: [
        { groupId: gById.get(1).id, msId: sD.id, lineId: sa2, startCp: 0, endCp: 1 }, // 行属于甲，不属于丁
      ],
    });
    await expectFail(r, 409, '候选失效');
    assert.ok(r.json.details.issues.some((i: any) => i.code === 'BAD_LINE'));
    assert.strictEqual(r.json.details.code, 'SUPPLEMENT_STALE');
    assert.strictEqual((await call(base, 'GET', `/documents/${dS}`)).json.document.version, verNow);

    // 候选失效：对乙再次提交 g6（乙已有该片段）→ ALREADY_HAS_FRAGMENT
    r = await call(base, 'POST', `/documents/${dS}/supplement`, {
      expectedVersion: verNow,
      targetMsId: sB.id,
      selections: [{ groupId: gById.get(6).id, msId: sB.id, lineId: sb1, startCp: 10, endCp: 12 }],
    });
    await expectFail(r, 409, '候选失效');
    assert.ok(r.json.details.issues.some((i: any) => i.code === 'ALREADY_HAS_FRAGMENT'));

    // 请求体非法：区间非法 / 同一组两个候选 → 400（不写库、不推进）
    r = await call(base, 'POST', `/documents/${dS}/supplement`, {
      expectedVersion: verNow,
      targetMsId: sB.id,
      selections: [{ groupId: gById.get(3).id, msId: sB.id, lineId: sb1, startCp: 0, endCp: 0 }],
    });
    await expectFail(r, 400, '区间非法');
    r = await call(base, 'POST', `/documents/${dS}/supplement`, {
      expectedVersion: verNow,
      targetMsId: sD.id,
      selections: [
        { groupId: gById.get(6).id, msId: sD.id, lineId: sb1, startCp: 0, endCp: 1 },
        { groupId: gById.get(6).id, msId: sD.id, lineId: sb1, startCp: 1, endCp: 2 },
      ],
    });
    await expectFail(r, 400, '同一组');
    // 空 selections → 400
    await expectFail(
      await call(base, 'POST', `/documents/${dS}/supplement`, { expectedVersion: verNow, targetMsId: sD.id, selections: [] }),
      400, 'selections'
    );

    // 已被占用区间 / 文字不符：新增甲第 3 行「子寅」，整批重存当前全部组 + g8(底本子) + g9(底本寅)。
    //  g9「寅」在乙行唯一出现处 [12,13) 被 g7 片段占用 → 无候选、提交 OCCUPIED；
    //  g8「子」在乙行无出现 → 无候选；提交空闲 [13,14)（寅≠子）→ TEXT_MISMATCH。
    await call(base, 'POST', `/manuscripts/${sA.id}/lines`, { expectedVersion: verNow, content: '子寅' });
    sView = (await call(base, 'GET', `/documents/${dS}`)).json;
    const saExtra = sView.rawByMs.find((x: any) => x.msId === sA.id).lines.find((l: any) => l.lineNo === 3).lineId;
    const verAfterExtraLine = sView.document.version;
    const rebuilt = sView.groups.map((g: any) => ({
      ord: g.ord,
      fragments: g.cells
        .filter((c: any) => c.missing || c.startCp != null)
        .map((c: any) => {
          if (c.missing) return { msId: c.msId, missing: true };
          const ln = sView.rawByMs.find((x: any) => x.msId === c.msId)
            .lines.find((l: any) => l.lineNo === c.lineNo);
          return { msId: c.msId, lineId: ln.lineId, startCp: c.startCp, endCp: c.endCp };
        }),
    }));
    rebuilt.push({ ord: rebuilt.length + 1, fragments: [{ msId: sA.id, lineId: saExtra, startCp: 0, endCp: 1 }] }); // g8 子
    rebuilt.push({ ord: rebuilt.length + 1, fragments: [{ msId: sA.id, lineId: saExtra, startCp: 1, endCp: 2 }] }); // g9 寅
    r = await call(base, 'PUT', `/documents/${dS}/groups`, { expectedVersion: verAfterExtraLine, groups: rebuilt });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    sView = (await call(base, 'GET', `/documents/${dS}`)).json;
    const verAfterG8 = sView.document.version;
    const g8id = sView.groups.find((g: any) => g.ord === 8).id;
    const g9id = sView.groups.find((g: any) => g.ord === 9).id;
    const gnewPrev = (await call(base, 'GET', `/documents/${dS}/supplement/preview?targetMsId=${sB.id}`)).json;
    assert.strictEqual(gnewPrev.groups.find((g: any) => g.groupId === g8id).status, 'unique',
      '乙行「子」[13,14) 空闲唯一');
    assert.strictEqual(gnewPrev.groups.find((g: any) => g.groupId === g9id).status, 'none',
      '乙行「寅」唯一出现处 [12,13) 已被 g7 片段占用，g9 无空闲候选');
    // g9 强行提交被占区间 → OCCUPIED
    r = await call(base, 'POST', `/documents/${dS}/supplement`, {
      expectedVersion: verAfterG8,
      targetMsId: sB.id,
      selections: [{ groupId: g9id, msId: sB.id, lineId: sb1, startCp: 12, endCp: 13 }],
    });
    await expectFail(r, 409, '候选失效');
    assert.ok(r.json.details.issues.some((i: any) => i.code === 'OCCUPIED'));
    // g8 唯一空闲候选直接采纳成功（此时 [13,14) 仍空闲）
    r = await call(base, 'POST', `/documents/${dS}/supplement`, {
      expectedVersion: verAfterG8,
      targetMsId: sB.id,
      selections: [{ groupId: g8id, msId: sB.id, lineId: sb1, startCp: 13, endCp: 14 }],
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.applied, 1);
    const verAfterG8Apply = r.json.version;
    // 文字不符：g9 底本「寅」提交 [13,14)，该位置现已是 g8「子」→ TEXT_MISMATCH（同时也 OCCUPIED）
    r = await call(base, 'POST', `/documents/${dS}/supplement`, {
      expectedVersion: verAfterG8Apply,
      targetMsId: sB.id,
      selections: [{ groupId: g9id, msId: sB.id, lineId: sb1, startCp: 13, endCp: 14 }],
    });
    await expectFail(r, 409, '候选失效');
    assert.ok(r.json.details.issues.some((i: any) => i.code === 'TEXT_MISMATCH' || i.code === 'OCCUPIED'));
    assert.strictEqual((await call(base, 'GET', `/documents/${dS}`)).json.document.version, verAfterG8Apply,
      '失败不推进版本');

    // 不存在文献的预览 → 404
    await expectFail(await call(base, 'GET', `/documents/999999/supplement/preview?targetMsId=1`), 404, '不存在');

    // ---------- 行界调整：拆分原始行（不改变字序） ----------
    r = await call(base, 'POST', '/documents', { title: `行界拆分测试 ${++seq}`, manuscripts: ['甲', '乙', '丙'] });
    assert.strictEqual(r.status, 201);
    const dR = r.json.id;
    let rView = (await call(base, 'GET', `/documents/${dR}`)).json;
    let rVer = rView.document.version;
    const [rA, rB, rC] = rView.manuscripts;
    assert.ok(rA.isBase);
    await call(base, 'POST', `/manuscripts/${rA.id}/lines`, { expectedVersion: rVer++, content: '天命之謂性率性之謂道' });
    await call(base, 'POST', `/manuscripts/${rA.id}/lines`, { expectedVersion: rVer++, content: '修道之謂教' });
    await call(base, 'POST', `/manuscripts/${rA.id}/lines`, { expectedVersion: rVer++, content: '君子之道' });
    await call(base, 'POST', `/manuscripts/${rB.id}/lines`, { expectedVersion: rVer++, content: '天命之謂姓率性之謂道' });
    await call(base, 'POST', `/manuscripts/${rB.id}/lines`, { expectedVersion: rVer++, content: '修道之謂教也' });
    await call(base, 'POST', `/manuscripts/${rC.id}/lines`, { expectedVersion: rVer++, content: '子𠀀丑' });
    rView = (await call(base, 'GET', `/documents/${dR}`)).json;
    const rLines = (msId: number) => rView.rawByMs.find((x: any) => x.msId === msId).lines;
    const ra = (no: number) => rLines(rA.id).find((l: any) => l.lineNo === no).lineId;
    const rb = (no: number) => rLines(rB.id).find((l: any) => l.lineNo === no).lineId;
    const rc = (no: number) => rLines(rC.id).find((l: any) => l.lineNo === no).lineId;
    r = await call(base, 'PUT', `/documents/${dR}/groups`, {
      expectedVersion: rView.document.version,
      groups: [
        { ord: 1, fragments: [
          { msId: rA.id, lineId: ra(1), startCp: 0, endCp: 5 },
          { msId: rB.id, lineId: rb(1), startCp: 0, endCp: 5 },
        ]},
        { ord: 2, fragments: [
          { msId: rA.id, lineId: ra(1), startCp: 5, endCp: 10 },
          { msId: rB.id, lineId: rb(1), startCp: 5, endCp: 10 },
        ]},
        { ord: 3, fragments: [
          { msId: rA.id, lineId: ra(2), startCp: 0, endCp: 5 },
          { msId: rB.id, lineId: rb(2), startCp: 0, endCp: 5 },
          { msId: rC.id, missing: true },
        ]},
      ],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));

    // 预览拆分 甲行1 @5：不跨任何片段（端点相接不算跨）
    rView = (await call(base, 'GET', `/documents/${dR}`)).json;
    let rVerBefore = rView.document.version;
    let rPrev = (await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${ra(1)}&splitCp=5`)).json;
    assert.strictEqual(rPrev.version, rVerBefore, '预览携带当前文献版本号');
    assert.strictEqual(rPrev.op, 'split');
    assert.strictEqual(rPrev.msId, rA.id);
    assert.strictEqual(rPrev.splitCp, 5);
    assert.deepStrictEqual(rPrev.basis, { lineId: ra(1), lineNo: 1, content: '天命之謂性率性之謂道', lengthCp: 10 });
    assert.deepStrictEqual(
      rPrev.lines.map((l: any) => [l.lineNo, l.oldLineNo, l.content, l.origin]),
      [
        [1, 1, '天命之謂性', 'split-left'],
        [2, 1, '率性之謂道', 'split-right'],
        [3, 2, '修道之謂教', 'shifted'],
        [4, 3, '君子之道', 'shifted'],
      ]
    );
    assert.strictEqual(rPrev.lines[1].lineId, null, '拆分出的新行预览时暂无 id');
    const spf1 = rPrev.fragments.find((f: any) => f.groupOrd === 1);
    assert.strictEqual(spf1.status, 'unchanged');
    assert.deepStrictEqual([spf1.newLineId, spf1.newLineNo, spf1.newStartCp, spf1.newEndCp], [ra(1), 1, 0, 5]);
    const spf2 = rPrev.fragments.find((f: any) => f.groupOrd === 2);
    assert.strictEqual(spf2.status, 'moved');
    assert.strictEqual(spf2.newLineId, null);
    assert.deepStrictEqual([spf2.newLineNo, spf2.newStartCp, spf2.newEndCp], [2, 0, 5]);
    assert.strictEqual(rPrev.brokenGroups.length, 0, '拆分点未跨片段，无新增待修复');
    // 预览只读：版本不变
    assert.strictEqual((await call(base, 'GET', `/documents/${dR}`)).json.document.version, rVerBefore);

    // 提交拆分：成功仅推进一次版本；未跨点片段随文字迁移并重算区间
    r = await call(base, 'POST', `/documents/${dR}/reline`, {
      expectedVersion: rVerBefore, op: 'split', lineId: ra(1), splitCp: 5, basis: rPrev.basis,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.version, rVerBefore + 1, '成功仅推进一次版本');
    const newRightLineId = r.json.result.lines.find((l: any) => l.origin === 'split-right').lineId;
    assert.ok(Number.isInteger(newRightLineId), '提交响应回填拆分新行 id');
    assert.strictEqual(r.json.result.fragments.find((f: any) => f.groupOrd === 2).newLineId, newRightLineId);
    rView = (await call(base, 'GET', `/documents/${dR}`)).json;
    assert.strictEqual(rView.document.version, rVerBefore + 1);
    assert.deepStrictEqual(rLines(rA.id).map((l: any) => [l.lineNo, l.content]), [
      [1, '天命之謂性'], [2, '率性之謂道'], [3, '修道之謂教'], [4, '君子之道'],
    ]);
    assert.strictEqual(rView.stats.brokenCount, 0, '未跨拆分点，无待修复');
    const rg2base = rView.groups.find((g: any) => g.ord === 2).cells.find((c: any) => c.msId === rA.id);
    assert.deepStrictEqual([rg2base.lineNo, rg2base.startCp, rg2base.endCp, rg2base.text], [2, 0, 5, '率性之謂道']);
    const rg3c = rView.groups.find((g: any) => g.ord === 3).cells.find((c: any) => c.msId === rC.id);
    assert.strictEqual(rg3c.missing, true, '缺文标记不变');

    // 非法码点位置 → 400 明确拒绝
    for (const bad of [0, 10, 11, -1]) {
      r = await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rb(1)}&splitCp=${bad}`);
      await expectFail(r, 400, '拆分点非法');
    }
    r = await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rb(1)}`);
    await expectFail(r, 400, 'splitCp');
    r = await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rb(1)}&splitCp=1.5`);
    await expectFail(r, 400, 'splitCp');
    // 行不存在 → 404；不属于本文献的行 → 400；op 非法 → 400；文献不存在 → 404
    await expectFail(await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=999999&splitCp=1`), 404, '不存在');
    await expectFail(await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${a1}&splitCp=1`), 400, '不属于本文献');
    await expectFail(await call(base, 'GET', `/documents/${dR}/reline/preview?op=x&lineId=${rb(1)}&splitCp=1`), 400, 'op');
    await expectFail(await call(base, 'GET', `/documents/999999/reline/preview?op=split&lineId=1&splitCp=1`), 404, '不存在');

    // 扩展 B 区生僻字按码点拆分：丙行1「子𠀀丑」共 3 码点（𠀀 为代理对）
    rView = (await call(base, 'GET', `/documents/${dR}`)).json;
    rVerBefore = rView.document.version;
    rPrev = (await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rc(1)}&splitCp=2`)).json;
    assert.strictEqual(rPrev.basis.lengthCp, 3, '𠀀 按 1 码点计');
    assert.strictEqual(rPrev.lines[0].content, '子𠀀');
    assert.strictEqual(rPrev.lines[1].content, '丑');
    r = await call(base, 'POST', `/documents/${dR}/reline`, {
      expectedVersion: rVerBefore, op: 'split', lineId: rc(1), splitCp: 2, basis: rPrev.basis,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    rView = (await call(base, 'GET', `/documents/${dR}`)).json;
    assert.deepStrictEqual(rLines(rC.id).map((l: any) => [l.lineNo, l.content]), [[1, '子𠀀'], [2, '丑']]);
    // 拆分后「丑」仅 1 字，无法再行内拆分 → 400
    await expectFail(await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rc(2)}&splitCp=1`), 400, '无法在行内拆分');

    // 提交缺 basis → 400；版本过期 → 409 不推进；basis 不符（预览所依据的行已变化）→ 409 不推进
    rView = (await call(base, 'GET', `/documents/${dR}`)).json;
    rVerBefore = rView.document.version;
    r = await call(base, 'POST', `/documents/${dR}/reline`, { expectedVersion: rVerBefore, op: 'split', lineId: rb(1), splitCp: 4 });
    await expectFail(r, 400, 'basis');
    r = await call(base, 'POST', `/documents/${dR}/reline`, {
      expectedVersion: rVerBefore - 1, op: 'split', lineId: rb(1), splitCp: 4,
      basis: { lineId: rb(1), lineNo: 1, content: '天命之謂姓率性之謂道', lengthCp: 10 },
    });
    await expectFail(r, 409, '版本已过期');
    rPrev = (await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${rb(1)}&splitCp=4`)).json;
    r = await call(base, 'POST', `/documents/${dR}/reline`, {
      expectedVersion: rVerBefore, op: 'split', lineId: rb(1), splitCp: 4,
      basis: { ...rPrev.basis, content: '天命之謂性率性之謂道' },
    });
    await expectFail(r, 409, '已变化');
    assert.strictEqual(r.json.details.code, 'RELINE_STALE');
    assert.strictEqual((await call(base, 'GET', `/documents/${dR}`)).json.document.version, rVerBefore, '拒绝不推进版本');

    // 跨拆分点：乙行1「天命之謂姓率性之謂道」@4 → 组1 乙片段 [0,5) 跨点 → 待修复；组2 乙 [5,10) 迁新行
    assert.strictEqual(rPrev.fragments.find((f: any) => f.groupOrd === 1).status, 'broken');
    assert.deepStrictEqual(
      (({ newLineId, newLineNo, newStartCp, newEndCp }: any) => [newLineId, newLineNo, newStartCp, newEndCp])(
        rPrev.fragments.find((f: any) => f.groupOrd === 1)
      ),
      [rb(1), 1, 0, 5],
      '跨点片段保留原行原区间以便追溯'
    );
    const xpf2 = rPrev.fragments.find((f: any) => f.groupOrd === 2);
    assert.strictEqual(xpf2.status, 'moved');
    assert.deepStrictEqual([xpf2.newLineNo, xpf2.newStartCp, xpf2.newEndCp], [2, 1, 6]);
    assert.strictEqual(rPrev.brokenGroups.length, 1);
    assert.strictEqual(rPrev.brokenGroups[0].newlyBroken, true);
    assert.strictEqual(rPrev.brokenGroups[0].ord, 1);
    r = await call(base, 'POST', `/documents/${dR}/reline`, {
      expectedVersion: rVerBefore, op: 'split', lineId: rb(1), splitCp: 4, basis: rPrev.basis,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.version, rVerBefore + 1);
    rView = (await call(base, 'GET', `/documents/${dR}`)).json;
    assert.deepStrictEqual(rLines(rB.id).map((l: any) => [l.lineNo, l.content]), [
      [1, '天命之謂'], [2, '姓率性之謂道'], [3, '修道之謂教也'],
    ]);
    assert.strictEqual(rView.stats.brokenCount, 1);
    const xg1 = rView.groups.find((g: any) => g.ord === 1);
    assert.strictEqual(xg1.broken, true);
    const xg1b = xg1.cells.find((c: any) => c.msId === rB.id);
    assert.strictEqual(xg1b.broken, true);
    assert.deepStrictEqual([xg1b.lineNo, xg1b.startCp, xg1b.endCp], [1, 0, 5]);
    assert.strictEqual(xg1b.oobEnd, 4, '右端越界：可追溯定位');
    assert.strictEqual(xg1b.text, '天命之謂', '只呈现越界前可见部分，不得把另一行文字当作其确定文字');
    const xg2b = rView.groups.find((g: any) => g.ord === 2).cells.find((c: any) => c.msId === rB.id);
    assert.deepStrictEqual([xg2b.lineNo, xg2b.startCp, xg2b.endCp, xg2b.text, xg2b.broken], [2, 1, 6, '率性之謂道', false]);
    // 原文视图一致：跨点片段在左行的覆盖区间被截到行长并标待修复
    const b1cov = rLines(rB.id).find((l: any) => l.lineNo === 1).covered;
    assert.deepStrictEqual(b1cov.map((c: any) => [c.startCp, c.endCp, c.broken]), [[0, 4, true]]);
    const b2cov = rLines(rB.id).find((l: any) => l.lineNo === 2).covered;
    assert.deepStrictEqual(b2cov.map((c: any) => [c.startCp, c.endCp, c.broken]), [[1, 6, false]]);
    // 发布门禁一致：有待修复不得发布
    r = await call(base, 'POST', `/documents/${dR}/publish`, { expectedVersion: rView.document.version });
    await expectFail(r, 409, '待修复');

    // 修复组1（乙改为缺文占位）后门禁放行，发布第 1 版
    r = await call(base, 'PUT', `/documents/${dR}/groups/${xg1.id}/repair`, {
      expectedVersion: rView.document.version,
      group: { ord: 1, fragments: [
        { msId: rA.id, lineId: ra(1), startCp: 0, endCp: 5 },
        { msId: rB.id, missing: true },
      ]},
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    rView = (await call(base, 'GET', `/documents/${dR}`)).json;
    assert.strictEqual(rView.stats.brokenCount, 0);
    r = await call(base, 'POST', `/documents/${dR}/publish`, { expectedVersion: rView.document.version });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.editionNo, 1);
    rView = (await call(base, 'GET', `/documents/${dR}`)).json;
    const rEd1Version = rView.document.version;

    // 发布后再拆分（甲行4「君子之道」无片段）：已发布快照保持原样，版本对照仍可用
    rPrev = (await call(base, 'GET', `/documents/${dR}/reline/preview?op=split&lineId=${ra(4)}&splitCp=2`)).json;
    r = await call(base, 'POST', `/documents/${dR}/reline`, {
      expectedVersion: rPrev.version, op: 'split', lineId: ra(4), splitCp: 2, basis: rPrev.basis,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    rView = (await call(base, 'GET', `/documents/${dR}`)).json;
    assert.deepStrictEqual(rLines(rA.id).map((l: any) => l.content), ['天命之謂性', '率性之謂道', '修道之謂教', '君子', '之道']);
    assert.strictEqual(rView.stats.brokenCount, 0);
    const rEd1 = (await call(base, 'GET', `/documents/${dR}/editions/1`)).json;
    assert.strictEqual(rEd1.view.document.version, rEd1Version, '快照版本号固化');
    assert.deepStrictEqual(
      rEd1.view.rawByMs.find((x: any) => x.msId === rA.id).lines.map((l: any) => l.content),
      ['天命之謂性', '率性之謂道', '修道之謂教', '君子之道'],
      '已发布快照保持原样'
    );
    const rDiff = (await call(base, 'GET', `/documents/${dR}/editions/1/diff`)).json;
    assert.ok(rDiff.textChanges.some((t: any) => t.msId === rA.id), '拆分后版本对照可见行文变化');

    // ---------- 行界调整：合并相邻两行 ----------
    r = await call(base, 'POST', '/documents', { title: `行界合并测试 ${++seq}`, manuscripts: ['甲', '乙'] });
    assert.strictEqual(r.status, 201);
    const dM = r.json.id;
    let mView = (await call(base, 'GET', `/documents/${dM}`)).json;
    let mVer = mView.document.version;
    const [mA, mB] = mView.manuscripts;
    await call(base, 'POST', `/manuscripts/${mA.id}/lines`, { expectedVersion: mVer++, content: '天命之謂性' });
    await call(base, 'POST', `/manuscripts/${mA.id}/lines`, { expectedVersion: mVer++, content: '率性之謂道' });
    await call(base, 'POST', `/manuscripts/${mA.id}/lines`, { expectedVersion: mVer++, content: '修道之謂教' });
    await call(base, 'POST', `/manuscripts/${mB.id}/lines`, { expectedVersion: mVer++, content: '天命之謂姓' });
    await call(base, 'POST', `/manuscripts/${mB.id}/lines`, { expectedVersion: mVer++, content: '率性之謂道' });
    mView = (await call(base, 'GET', `/documents/${dM}`)).json;
    const mLines = (msId: number) => mView.rawByMs.find((x: any) => x.msId === msId).lines;
    const ma = (no: number) => mLines(mA.id).find((l: any) => l.lineNo === no).lineId;
    const mb = (no: number) => mLines(mB.id).find((l: any) => l.lineNo === no).lineId;
    r = await call(base, 'PUT', `/documents/${dM}/groups`, {
      expectedVersion: mView.document.version,
      groups: [
        { ord: 1, fragments: [
          { msId: mA.id, lineId: ma(1), startCp: 0, endCp: 5 },
          { msId: mB.id, lineId: mb(1), startCp: 0, endCp: 5 },
        ]},
        { ord: 2, fragments: [
          { msId: mA.id, lineId: ma(2), startCp: 0, endCp: 5 },
          { msId: mB.id, lineId: mb(2), startCp: 0, endCp: 5 },
        ]},
        { ord: 3, fragments: [
          { msId: mA.id, lineId: ma(3), startCp: 0, endCp: 5 },
          { msId: mB.id, missing: true },
        ]},
      ],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    // 发布第 1 版（供快照不可变校验）
    mView = (await call(base, 'GET', `/documents/${dM}`)).json;
    r = await call(base, 'POST', `/documents/${dM}/publish`, { expectedVersion: mView.document.version });
    assert.strictEqual(r.status, 201);
    mView = (await call(base, 'GET', `/documents/${dM}`)).json;
    const mEd1Version = mView.document.version;
    // 使组2 待修复：改甲行2 首字（与组2 底本片段相交）
    r = await call(base, 'PUT', `/lines/${ma(2)}`, { expectedVersion: mView.document.version, startCp: 0, endCp: 1, replacement: '帥' });
    assert.strictEqual(r.status, 200);
    mView = (await call(base, 'GET', `/documents/${dM}`)).json;
    assert.strictEqual(mView.groups.find((g: any) => g.ord === 2).broken, true);

    // 非相邻行 / 不同抄本 / 自身 / 不存在 / 他文献行 → 明确拒绝
    await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=${ma(3)}`), 400, '不相邻');
    await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(2)}&rightLineId=${ma(1)}`), 400, '不相邻');
    await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=${mb(1)}`), 400, '同一抄本');
    await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=${ma(1)}`), 400, '自身');
    await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=999999`), 404, '不存在');
    await expectFail(await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=${ra(1)}`), 400, '不属于本文献');

    // 预览合并 甲行1+行2：右行片段迁至左行；原已待修复组列入预览但不自动转完好
    mView = (await call(base, 'GET', `/documents/${dM}`)).json;
    let mVerBefore = mView.document.version;
    let mPrev = (await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${ma(1)}&rightLineId=${ma(2)}`)).json;
    assert.strictEqual(mPrev.version, mVerBefore);
    assert.strictEqual(mPrev.op, 'merge');
    assert.deepStrictEqual(mPrev.basis, {
      leftLineId: ma(1), leftLineNo: 1, leftContent: '天命之謂性', leftLengthCp: 5,
      rightLineId: ma(2), rightLineNo: 2, rightContent: '帥性之謂道', rightLengthCp: 5,
    });
    assert.deepStrictEqual(mPrev.lines.map((l: any) => [l.lineNo, l.oldLineNo, l.content, l.origin]), [
      [1, 1, '天命之謂性帥性之謂道', 'merged'],
      [2, 3, '修道之謂教', 'shifted'],
    ]);
    const mf1 = mPrev.fragments.find((f: any) => f.groupOrd === 1);
    assert.strictEqual(mf1.status, 'unchanged');
    const mf2 = mPrev.fragments.find((f: any) => f.groupOrd === 2);
    assert.strictEqual(mf2.status, 'moved');
    assert.deepStrictEqual([mf2.newLineId, mf2.newLineNo, mf2.newStartCp, mf2.newEndCp], [ma(1), 1, 5, 10]);
    assert.strictEqual(mf2.groupAlreadyBroken, true);
    assert.strictEqual(mPrev.brokenGroups.length, 1);
    assert.strictEqual(mPrev.brokenGroups[0].newlyBroken, false, '原已待修复组列入预览但不自动转完好');
    // 预览只读
    assert.strictEqual((await call(base, 'GET', `/documents/${dM}`)).json.document.version, mVerBefore);

    // 提交合并：成功仅推进一次版本
    r = await call(base, 'POST', `/documents/${dM}/reline`, {
      expectedVersion: mVerBefore, op: 'merge', leftLineId: ma(1), rightLineId: ma(2), basis: mPrev.basis,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.version, mVerBefore + 1, '成功仅推进一次版本');
    mView = (await call(base, 'GET', `/documents/${dM}`)).json;
    assert.deepStrictEqual(mLines(mA.id).map((l: any) => [l.lineNo, l.content]), [
      [1, '天命之謂性帥性之謂道'], [2, '修道之謂教'],
    ]);
    const mg2 = mView.groups.find((g: any) => g.ord === 2);
    assert.strictEqual(mg2.broken, true, '原已待修复组合并后不得自动转完好');
    const mg2a = mg2.cells.find((c: any) => c.msId === mA.id);
    assert.deepStrictEqual([mg2a.lineNo, mg2a.startCp, mg2a.endCp, mg2a.text], [1, 5, 10, '帥性之謂道']);
    // 缺文标记不变；组3 底本片段行号顺移
    const mg3 = mView.groups.find((g: any) => g.ord === 3);
    assert.strictEqual(mg3.cells.find((c: any) => c.msId === mB.id).missing, true);
    assert.strictEqual(mg3.cells.find((c: any) => c.msId === mA.id).lineNo, 2);
    // 发布门禁一致：仍待修复 → 不得发布
    r = await call(base, 'POST', `/documents/${dM}/publish`, { expectedVersion: mView.document.version });
    await expectFail(r, 409, '待修复');

    // 过期版本 → 409 不推进；basis 不符 → 409 RELINE_STALE 不推进
    mView = (await call(base, 'GET', `/documents/${dM}`)).json;
    mVerBefore = mView.document.version;
    r = await call(base, 'POST', `/documents/${dM}/reline`, {
      expectedVersion: mVerBefore - 1, op: 'merge', leftLineId: mb(1), rightLineId: mb(2), basis: mPrev.basis,
    });
    await expectFail(r, 409, '版本已过期');
    mPrev = (await call(base, 'GET', `/documents/${dM}/reline/preview?op=merge&leftLineId=${mb(1)}&rightLineId=${mb(2)}`)).json;
    r = await call(base, 'POST', `/documents/${dM}/reline`, {
      expectedVersion: mVerBefore, op: 'merge', leftLineId: mb(1), rightLineId: mb(2),
      basis: { ...mPrev.basis, leftContent: '天命之謂性' },
    });
    await expectFail(r, 409, '已变化');
    assert.strictEqual(r.json.details.code, 'RELINE_STALE');
    assert.strictEqual((await call(base, 'GET', `/documents/${dM}`)).json.document.version, mVerBefore, '拒绝不推进版本');

    // 乙行1+行2 合并：右行片段迁至左行，完好组保持完好
    r = await call(base, 'POST', `/documents/${dM}/reline`, {
      expectedVersion: mVerBefore, op: 'merge', leftLineId: mb(1), rightLineId: mb(2), basis: mPrev.basis,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    mView = (await call(base, 'GET', `/documents/${dM}`)).json;
    assert.deepStrictEqual(mLines(mB.id).map((l: any) => [l.lineNo, l.content]), [[1, '天命之謂姓率性之謂道']]);
    const mg1b = mView.groups.find((g: any) => g.ord === 1).cells.find((c: any) => c.msId === mB.id);
    assert.deepStrictEqual([mg1b.lineNo, mg1b.startCp, mg1b.endCp, mg1b.text], [1, 0, 5, '天命之謂姓']);
    const mg2b = mView.groups.find((g: any) => g.ord === 2).cells.find((c: any) => c.msId === mB.id);
    assert.deepStrictEqual([mg2b.lineNo, mg2b.startCp, mg2b.endCp, mg2b.text], [1, 5, 10, '率性之謂道']);

    // 修复组2 → 发布门禁放行；已发布快照保持原样
    r = await call(base, 'PUT', `/documents/${dM}/groups/${mg2.id}/repair`, {
      expectedVersion: mView.document.version,
      group: { ord: 2, fragments: [
        { msId: mA.id, lineId: ma(1), startCp: 5, endCp: 10 },
        { msId: mB.id, lineId: mb(1), startCp: 5, endCp: 10 },
      ]},
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    mView = (await call(base, 'GET', `/documents/${dM}`)).json;
    assert.strictEqual(mView.stats.brokenCount, 0);
    r = await call(base, 'POST', `/documents/${dM}/publish`, { expectedVersion: mView.document.version });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.editionNo, 2);
    const mEd1 = (await call(base, 'GET', `/documents/${dM}/editions/1`)).json;
    assert.strictEqual(mEd1.view.document.version, mEd1Version, '快照版本号固化');
    assert.deepStrictEqual(
      mEd1.view.rawByMs.find((x: any) => x.msId === mA.id).lines.map((l: any) => l.content),
      ['天命之謂性', '率性之謂道', '修道之謂教'],
      '已发布快照保持原样'
    );
    assert.strictEqual(mEd1.view.stats.brokenCount, 0);

    console.log('✅ 全部集成测试通过');
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
