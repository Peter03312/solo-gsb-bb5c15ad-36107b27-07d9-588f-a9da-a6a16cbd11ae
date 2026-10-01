"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRestorePlan = buildRestorePlan;
exports.applyRestore = applyRestore;
const util_1 = require("./util");
const validate_1 = require("./validate");
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * 校验快照结构并规范化为可执行的恢复计划。
 * 任一不合法即整体拒绝（422），逐条给出原因。
 */
function buildRestorePlan(snapshot) {
    const issues = [];
    const s = snapshot;
    if (!isObj(snapshot) || !isObj(s.document) || !Array.isArray(s.manuscripts) ||
        !Array.isArray(s.groups) || !Array.isArray(s.rawByMs)) {
        throw new util_1.HttpError(422, '该已发布版快照结构已损坏，缺少 document/manuscripts/groups/rawByMs，无法构成合法归组，已整体拒绝、未改动任何数据', {
            code: 'SNAPSHOT_NOT_RESTORABLE',
            issues: [{ code: 'SNAPSHOT_MALFORMED', message: '快照缺少必要的顶层结构' }],
        });
    }
    // ---- 抄本 ----
    const manuscripts = [];
    const msIds = new Set();
    const positions = new Set();
    let baseMsId = (0, util_1.isInt)(s.document.baseMsId) ? s.document.baseMsId : null;
    s.manuscripts.forEach((m, i) => {
        if (!isObj(m) || !(0, util_1.isInt)(m.id)) {
            issues.push({ code: 'SNAPSHOT_MALFORMED', message: `第 ${i + 1} 份抄本缺少整数 id` });
            return;
        }
        if (typeof m.name !== 'string' || !m.name) {
            issues.push({ code: 'SNAPSHOT_MALFORMED', message: `抄本 #${m.id} 名称缺失` });
        }
        if (!(0, util_1.isInt)(m.position) || m.position < 1) {
            issues.push({ code: 'SNAPSHOT_MALFORMED', message: `抄本「${m.name}」位置 position 非法` });
        }
        else if (positions.has(m.position)) {
            issues.push({ code: 'DUP_POSITION', message: `抄本位置 ${m.position} 重复，顺序无法恢复` });
        }
        else {
            positions.add(m.position);
        }
        if (msIds.has(m.id)) {
            issues.push({ code: 'DUP_MS_ID', message: `快照中抄本 id ${m.id} 重复` });
            return;
        }
        msIds.add(m.id);
        manuscripts.push({ id: m.id, name: String(m.name ?? ''), position: m.position });
    });
    if (baseMsId == null || !msIds.has(baseMsId)) {
        issues.push({
            code: 'BASE_NOT_IN_SNAPSHOT',
            message: `快照底本 id=${baseMsId ?? 'null'} 不在快照抄本集合中，无法恢复底本`,
        });
        baseMsId = null;
    }
    // ---- 原始行（rawByMs）----
    const lineContents = new Map();
    const snapLines = [];
    const snapLineIds = new Set();
    for (const raw of s.rawByMs) {
        if (!isObj(raw) || !(0, util_1.isInt)(raw.msId) || !Array.isArray(raw.lines)) {
            issues.push({ code: 'BAD_RAW_LINE', message: 'rawByMs 中存在结构损坏的抄本行集（缺 msId/lines）' });
            continue;
        }
        const msId = raw.msId;
        if (!msIds.has(msId)) {
            issues.push({ code: 'UNKNOWN_MS', message: `行文引用了快照中不存在的抄本 #${msId}`, msId });
            continue;
        }
        let expectNo = 1;
        for (const lv of raw.lines) {
            if (!isObj(lv) || !(0, util_1.isInt)(lv.lineId) || !(0, util_1.isInt)(lv.lineNo) || typeof lv.content !== 'string') {
                issues.push({
                    code: 'BAD_RAW_LINE',
                    message: `抄本 #${msId} 存在结构损坏的行（缺 lineId/lineNo/content）`,
                    msId,
                });
                continue;
            }
            if (snapLineIds.has(lv.lineId)) {
                issues.push({ code: 'DUP_LINE_ID', message: `快照中行 id ${lv.lineId} 跨抄本重复`, msId, lineNo: lv.lineNo });
            }
            else {
                snapLineIds.add(lv.lineId);
            }
            if (lv.lineNo !== expectNo) {
                issues.push({
                    code: 'LINE_NO_GAP',
                    message: `抄本 #${msId} 原始行号不连续：应为第 ${expectNo} 行，快照中为第 ${lv.lineNo} 行`,
                    msId,
                    lineNo: lv.lineNo,
                });
            }
            // 即便该行号有问题也按其值继续，避免一处缺号引发后续级联误报
            expectNo = lv.lineNo + 1;
            lineContents.set(`${msId}:${lv.lineNo}`, lv.content);
            snapLines.push({ id: lv.lineId, ms_id: msId, line_no: lv.lineNo, content: lv.content });
        }
    }
    // ---- 组与单元格 ----
    const groups = [];
    const ordSeen = new Set();
    s.groups.forEach((g, gi) => {
        const ord = (0, util_1.isInt)(g.ord) ? g.ord : gi + 1;
        if (!isObj(g) || !(0, util_1.isInt)(g.ord) || g.ord < 1) {
            issues.push({ code: 'BAD_GROUP', message: `第 ${gi + 1} 组缺少正整数 ord` });
            return;
        }
        if (ordSeen.has(g.ord)) {
            issues.push({ code: 'DUP_ORD', message: `快照中组序号 ${g.ord} 重复`, groupOrd: g.ord });
            return;
        }
        ordSeen.add(g.ord);
        if (!Array.isArray(g.cells)) {
            issues.push({ code: 'EMPTY_GROUP', message: `第 ${ord} 组的 cells 不是数组，无法归组`, groupOrd: ord });
            return;
        }
        if (g.cells.length === 0) {
            issues.push({ code: 'EMPTY_GROUP', message: `第 ${ord} 组没有任何片段 / 缺文标记，无法归组`, groupOrd: ord });
            return;
        }
        const cellMsSeen = new Set();
        const cells = [];
        for (const c0 of g.cells) {
            if (!isObj(c0) || !(0, util_1.isInt)(c0.msId)) {
                issues.push({ code: 'BAD_CELL', message: `第 ${ord} 组存在缺少 msId 的片段`, groupOrd: ord });
                continue;
            }
            const msId = c0.msId;
            if (!msIds.has(msId)) {
                issues.push({
                    code: 'UNKNOWN_MS',
                    message: `第 ${ord} 组引用了快照中不存在的抄本 #${msId}`,
                    groupOrd: ord,
                    msId,
                });
                continue;
            }
            if (cellMsSeen.has(msId)) {
                issues.push({
                    code: 'BAD_CELL',
                    message: `第 ${ord} 组中抄本 #${msId} 出现多个片段（每组每抄本至多一个）`,
                    groupOrd: ord,
                    msId,
                });
                continue;
            }
            cellMsSeen.add(msId);
            if (c0.missing === true) {
                cells.push({ msId, missing: true });
                continue;
            }
            if (!(0, util_1.isInt)(c0.lineNo) || !(0, util_1.isInt)(c0.startCp) || !(0, util_1.isInt)(c0.endCp)) {
                issues.push({
                    code: 'BAD_CELL',
                    message: `第 ${ord} 组抄本 #${msId} 的片段缺少 lineNo/startCp/endCp`,
                    groupOrd: ord,
                    msId,
                });
                continue;
            }
            const content = lineContents.get(`${msId}:${c0.lineNo}`);
            if (content == null) {
                issues.push({
                    code: 'BAD_CELL',
                    message: `第 ${ord} 组抄本 #${msId} 的片段引用了不存在的第 ${c0.lineNo} 行`,
                    groupOrd: ord,
                    msId,
                    lineNo: c0.lineNo,
                });
                continue;
            }
            // 快照读模型不直接带 lineId：以 (msId, lineNo) 解析到快照行 id
            const snapLine = snapLines.find((l) => l.ms_id === msId && l.line_no === c0.lineNo);
            const len = (0, util_1.charLen)(content);
            if (c0.startCp < 0 || c0.endCp <= c0.startCp) {
                issues.push({
                    code: 'BAD_CELL',
                    message: `第 ${ord} 组抄本 #${msId} 片段区间非法 [${c0.startCp}, ${c0.endCp})`,
                    groupOrd: ord,
                    msId,
                    lineNo: c0.lineNo,
                    startCp: c0.startCp,
                    endCp: c0.endCp,
                });
                continue;
            }
            if (c0.startCp >= len || c0.endCp > len) {
                issues.push({
                    code: 'BAD_CELL',
                    message: `第 ${ord} 组抄本 #${msId} 越界：第 ${c0.lineNo} 行共 ${len} 字，` +
                        `片段位于第 ${c0.startCp + 1}–${c0.endCp} 字，无法构成合法归组`,
                    groupOrd: ord,
                    msId,
                    lineNo: c0.lineNo,
                    startCp: c0.startCp,
                    endCp: c0.endCp,
                });
                continue;
            }
            // 文本一致性：快照中 cell.text 必须与行文区间一致（损坏检测的显式兜底）
            if (typeof c0.text === 'string') {
                const expectText = Array.from(content).slice(c0.startCp, c0.endCp).join('');
                if (c0.text !== expectText) {
                    issues.push({
                        code: 'CELL_TEXT_MISMATCH',
                        message: `第 ${ord} 组抄本 #${msId} 第 ${c0.lineNo} 行快照片段文字「${c0.text}」` +
                            `与行文区间文字「${expectText}」不一致，快照内部自相矛盾`,
                        groupOrd: ord,
                        msId,
                        lineNo: c0.lineNo,
                    });
                }
            }
            cells.push({ msId, missing: false, lineId: snapLine.id, lineNo: c0.lineNo, startCp: c0.startCp, endCp: c0.endCp });
        }
        groups.push({ ord, cells });
    });
    // 组序必须自 1 连续
    const ords = groups.map((g) => g.ord).sort((a, b) => a - b);
    if (ords.some((o, i) => o !== i + 1)) {
        issues.push({ code: 'DUP_ORD', message: '快照中组序号 ord 必须从 1 开始连续编号，不能有缺号' });
    }
    if (issues.length > 0) {
        throw new util_1.HttpError(422, `该已发布版快照无法构成合法归组：发现 ${issues.length} 处问题，已整体拒绝、未改动任何数据`, { code: 'SNAPSHOT_NOT_RESTORABLE', issues });
    }
    // ---- 复用与整批保存完全相同的归组规则（越界 / 行内重叠 / 每组每抄本至多一片 / 底本唯一）----
    const mssForValidate = manuscripts
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((m) => ({ id: m.id, doc_id: 0, name: m.name, position: m.position }));
    const groupDTOs = groups.map((g) => ({
        ord: g.ord,
        fragments: g.cells.map((c) => c.missing
            ? { msId: c.msId, missing: true }
            : { msId: c.msId, missing: false, lineId: c.lineId, startCp: c.startCp, endCp: c.endCp }),
    }));
    try {
        (0, validate_1.validateGroups)(groupDTOs, { baseMsId: baseMsId, manuscripts: mssForValidate, lines: snapLines });
    }
    catch (e) {
        if (e instanceof util_1.HttpError) {
            throw new util_1.HttpError(422, `该已发布版快照无法构成合法归组：${e.message}，已整体拒绝、未改动任何数据`, { code: 'SNAPSHOT_NOT_RESTORABLE', issues: Array.isArray(e.details) ? e.details : [] });
        }
        throw e;
    }
    return {
        baseMsId: baseMsId,
        manuscripts: manuscripts.sort((a, b) => a.position - b.position),
        lineContents,
        snapLines: snapLines.sort((a, b) => a.ms_id - b.ms_id || a.line_no - b.line_no),
        groups: groups.sort((a, b) => a.ord - b.ord),
        manuscriptCount: manuscripts.length,
        lineCount: snapLines.length,
        groupCount: groups.length,
    };
}
/**
 * 按恢复计划整体重建工作版数据（调用方须已持有文献行锁并核对 expectedVersion）。
 * 全部步骤在同一 SERIALIZABLE 事务内，任一失败整体回滚。
 */
async function applyRestore(client, docId, editionNo, plan) {
    const keepMsIds = new Set(plan.manuscripts.map((m) => m.id));
    // 1) 删除全部组（级联删除 fragments），再清空全部行
    await client.query('DELETE FROM grp WHERE doc_id=$1', [docId]);
    await client.query('DELETE FROM lines WHERE ms_id IN (SELECT id FROM manuscripts WHERE doc_id=$1)', [docId]);
    // 2) 抄本名称 / 位置复位（id 沿用快照中的稳定 id；快照之外新增的抄本删除）
    for (const m of plan.manuscripts) {
        await client.query(`INSERT INTO manuscripts (id, doc_id, name, position) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, position=EXCLUDED.position`, [m.id, docId, m.name, m.position]);
    }
    await client.query('DELETE FROM manuscripts WHERE doc_id=$1 AND id <> ALL($2::bigint[])', [
        docId,
        [...keepMsIds],
    ]);
    // 显式插入 id 后把序列推到 MAX(id) 之上，避免后续“新增抄本”撞主键
    await client.query(`SELECT setval(pg_get_serial_sequence('manuscripts','id'),
                    COALESCE((SELECT MAX(id) FROM manuscripts), 1),
                    (SELECT MAX(id) IS NOT NULL FROM manuscripts))`);
    // 3) 底本复位；标题与 published_ver 不在恢复范围，保持原样
    await client.query('UPDATE documents SET base_ms_id=$1 WHERE id=$2', [plan.baseMsId, docId]);
    // 4) 按快照逐抄本重建原始行（全部取得当前有效新行 id；snapLines 已按 ms_id,line_no 排好序）
    const newLineId = new Map(); // (msId,lineNo) → 新行 id
    for (const sl of plan.snapLines) {
        const { rows } = await client.query('INSERT INTO lines (ms_id, line_no, content) VALUES ($1,$2,$3) RETURNING id', [sl.ms_id, sl.line_no, sl.content]);
        newLineId.set(`${sl.ms_id}:${sl.line_no}`, rows[0].id);
    }
    // 5) 重建对应组（全部完好）、片段与缺文标记（组取得当前有效新 id）
    for (const g of plan.groups) {
        const { rows } = await client.query('INSERT INTO grp (doc_id, ord, broken) VALUES ($1,$2,FALSE) RETURNING id', [docId, g.ord]);
        const gid = rows[0].id;
        for (const c of g.cells) {
            if (c.missing) {
                await client.query('INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing) VALUES ($1,$2,$3,NULL,NULL,NULL,TRUE)', [gid, docId, c.msId]);
            }
            else {
                const lid = newLineId.get(`${c.msId}:${c.lineNo}`);
                await client.query('INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing) VALUES ($1,$2,$3,$4,$5,$6,FALSE)', [gid, docId, c.msId, lid, c.startCp, c.endCp]);
            }
        }
    }
    // 6) 版本号只前进一次
    await client.query('UPDATE documents SET version = version + 1 WHERE id=$1', [docId]);
    const { rows } = await client.query('SELECT version, base_ms_id FROM documents WHERE id=$1', [docId]);
    return {
        editionNo,
        version: rows[0].version,
        baseMsId: rows[0].base_ms_id,
        manuscriptCount: plan.manuscriptCount,
        lineCount: plan.lineCount,
        groupCount: plan.groupCount,
    };
}
