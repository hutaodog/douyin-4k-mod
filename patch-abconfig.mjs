/**
 * patch-abconfig.mjs —— 直接改抖音客户端缓存在本地 SQLite 里的 AB 配置
 *
 * 目标文件：%APPDATA%\douyin\douyin_app_config   （表 app_config，键 abconfig）
 * 这就是"不在抖音安装目录里"的那部分：服务端下发的 AB 参数 / 播放器开关都在这里。
 *
 * 用法（必须先完全退出抖音）：
 *   node --experimental-sqlite patch-abconfig.mjs show         # 看当前值
 *   node --experimental-sqlite patch-abconfig.mjs apply        # 打补丁（自动备份）
 *   node --experimental-sqlite patch-abconfig.mjs revert       # 还原备份
 *
 * 打的补丁（只改这几个开关，不动别的）：
 *   allAbParams.auto_clarity_reselect   = 0     关掉"自动重选清晰度"
 *   allAbParams.switch_clarity_timing   = 0     关掉"择机切清晰度"
 *   allAbParams.smooth_switch_clarity   = 0     关掉"平滑切清晰度"
 *   allAbParams.use_h266_client         = 0     不用 H.266 客户端
 *   allAbParams.fix_h266_list           = 0     不往 H.266 列表修
 *   backendAbTest.*.degradeBitrateFactors = [0, 0]   低于目标码率也不再降档
 *   allAbParams.abr_config.algoArg.maxDownSwitchLevel = 0   ABR 不允许降档
 *   allAbParams.abr_config.algoArg.rebufferDegrade     = 0
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DIR = (process.env.APPDATA || '') + '\\douyin';
const DB = path.join(DIR, 'douyin_app_config');
const BAK = DB + '.dypc4k.bak';

const cmd = (process.argv[2] || 'show').toLowerCase();
if (!fs.existsSync(DB)) { console.error('找不到 ' + DB); process.exit(1); }

function readAb(db) {
  const row = db.prepare("SELECT value FROM app_config WHERE key='abconfig'").get();
  if (!row) throw new Error('app_config 里没有 abconfig');
  return JSON.parse(String(row.value));
}
function writeAb(db, obj) {
  db.prepare("UPDATE app_config SET value=? WHERE key='abconfig'").run(JSON.stringify(obj));
}

function show(obj) {
  const a = (obj.csrInitData && obj.csrInitData.allAbParams) || {};
  const b = (obj.csrInitData && obj.csrInitData.backendAbTest) || {};
  const pick = (o, ks) => ks.map(k => `${k}=${JSON.stringify(o[k])}`).join('  ');
  console.log('allAbParams:');
  console.log('  ' + pick(a, ['auto_clarity_reselect', 'switch_clarity_timing', 'smooth_switch_clarity',
    'use_h266_client', 'fix_h266_list', 'has_over_gear', 'exposure_defination', 'bitrateCombine']));
  console.log('  abr.algoArg: ' + JSON.stringify((a.abr_config || {}).algoArg || {}).slice(0, 300));
  console.log('backendAbTest.douyinPC.vod_live_joint_config: ' + JSON.stringify((b.douyinPC || {}).vod_live_joint_config || {}));
  console.log('backendAbTest.vodLiveJointConfig: ' + JSON.stringify(b.vodLiveJointConfig || {}));
}

const db = new DatabaseSync(DB, { readOnly: cmd === 'show' });

if (cmd === 'show') {
  show(readAb(db));
  db.close();
  process.exit(0);
}

if (cmd === 'revert') {
  db.close();
  if (!fs.existsSync(BAK)) { console.error('没有备份文件: ' + BAK); process.exit(1); }
  fs.copyFileSync(BAK, DB);
  console.log('[+] 已从备份还原: ' + BAK);
  process.exit(0);
}

if (cmd === 'apply') {
  if (!fs.existsSync(BAK)) {
    fs.copyFileSync(DB, BAK);
    console.log('[*] 已备份原始库 -> ' + BAK);
  } else {
    console.log('[*] 备份已存在，沿用: ' + BAK);
  }
  const obj = readAb(db);
  const a = (obj.csrInitData = obj.csrInitData || {}).allAbParams = obj.csrInitData.allAbParams || {};
  const b = obj.csrInitData.backendAbTest = obj.csrInitData.backendAbTest || {};

  const before = {};
  for (const k of ['auto_clarity_reselect', 'switch_clarity_timing', 'smooth_switch_clarity', 'use_h266_client', 'fix_h266_list']) {
    before[k] = a[k];
    a[k] = 0;
  }
  // ABR：禁止降档
  if (a.abr_config && a.abr_config.algoArg) {
    before.abrMaxDown = a.abr_config.algoArg.maxDownSwitchLevel;
    before.abrRebufferDegrade = a.abr_config.algoArg.rebufferDegrade;
    a.abr_config.algoArg.maxDownSwitchLevel = 0;
    a.abr_config.algoArg.rebufferDegrade = 0;
    a.abr_config.algoArg.safeRebufferDegrade = 0;
  }
  // 降档码率阈值：0 表示永远不触发
  const jc = [b.douyinPC && b.douyinPC.vod_live_joint_config, b.vodLiveJointConfig];
  for (const c of jc) {
    if (c && Array.isArray(c.degradeBitrateFactors)) {
      before.degradeFactors = c.degradeBitrateFactors.slice();
      c.degradeBitrateFactors = [0, 0];
    }
  }

  writeAb(db, obj);
  db.close();
  console.log('[+] 已写入补丁');
  console.log('    改前: ' + JSON.stringify(before));
  console.log('    改后: auto_clarity_reselect=0 switch_clarity_timing=0 smooth_switch_clarity=0 use_h266_client=0 degradeBitrateFactors=[0,0]');
  process.exit(0);
}

console.error('未知命令: ' + cmd);
process.exit(1);
