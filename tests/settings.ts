/**
 * 设置解析：按任务分模型 + 模型列表缓存。
 *
 * 最容易错的两处：
 * 1. 「留空」的语义 —— key 留空是「不动」，任务级模型留空是「清掉回落默认」，
 *    两者相反。搞混的话要么清不掉，要么改个别的字段把 key 顺手抹了。
 * 2. 缓存跟错 baseUrl —— 换了端点还端上旧列表，用户会选到一个不存在的模型。
 *
 *   npx tsx tests/settings.ts
 */
import fs from 'node:fs';
import { open } from '../src/core/store.js';
import {
  loadConfig, configFor, saveConfig, publicConfig, clearKey,
  saveModelCache, loadModelCache,
} from '../src/core/settings.js';

const DB = '/tmp/te-settings-test.db';
fs.rmSync(DB, { force: true });
const db = open(DB);

let failed = 0;
const t = (name: string, ok: boolean, got = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !got ? '' : `  (${got})`}`);
};

console.log('\n按任务分模型');

saveConfig(db, { baseUrl: 'https://x.test/v1', apiKey: 'k1', model: 'default/model' });
t('没有任务级配置时回落默认', configFor(db, 'review').model === 'default/model');
t('card 同样回落', configFor(db, 'card').model === 'default/model');

saveConfig(db, { modelReview: 'cheap/grader' });
t('批改用批改模型', configFor(db, 'review').model === 'cheap/grader');
t('卡片不受影响，仍用默认', configFor(db, 'card').model === 'default/model');
t('baseUrl 和 key 永远共用', configFor(db, 'review').apiKey === 'k1');

saveConfig(db, { modelCard: 'fancy/carder' });
t('卡片用卡片模型', configFor(db, 'card').model === 'fancy/carder');

// 任务级模型：空字符串 = 清掉，回落默认（和 key 的语义相反）
saveConfig(db, { modelReview: '' });
t('留空清掉任务级配置', configFor(db, 'review').model === 'default/model');
t('清一个不影响另一个', configFor(db, 'card').model === 'fancy/carder');

// key 的语义必须保持：空串 = 不动
saveConfig(db, { apiKey: '', model: 'default/model' });
t('key 留空是「不动」不是「清空」', loadConfig(db).apiKey === 'k1');
clearKey(db);
t('清 key 走专门的入口', loadConfig(db).apiKey === '');

const pub = publicConfig(db);
t('界面能看到任务级模型', pub.modelCard === 'fancy/carder' && pub.modelReview === '');

console.log('\n模型列表缓存');

const MODELS = [
  { id: 'a/one', name: 'One', structured: true },
  { id: 'b/two', name: 'Two', structured: false },
];
t('还没拉取过 → 没有缓存', loadModelCache(db, 'https://x.test/v1') === null);
saveModelCache(db, 'https://x.test/v1', MODELS);
const hit = loadModelCache(db, 'https://x.test/v1');
t('存了就取得到', hit !== null && hit.models.length === 2);
t('带时间戳', !!hit?.cachedAt);
t('换了端点 → 旧缓存作废', loadModelCache(db, 'https://other.test/v1') === null);

db.close();
fs.rmSync(DB, { force: true });
console.log(failed ? `\n  ${failed} 项未通过\n` : '\n  全部通过\n');
process.exit(failed ? 1 : 0);
