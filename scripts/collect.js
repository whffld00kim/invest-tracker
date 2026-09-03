#!/usr/bin/env node
/**
 * 투자 트래커 자동 입력
 *
 * 평일 아침(기본 10:30 KST)에 GitHub Actions가 이 스크립트를 돌린다.
 * 손으로 네이버 화면을 보며 옮겨 적던 값을 그대로 받아와 Firestore에 넣는다.
 *
 * 값의 출처는 네이버 증권이 자기 화면에 쓰는 API 그대로다. 그래서 앱에 쌓인
 * 3년치 기록과 같은 기준의 숫자가 들어간다 (다른 사이트를 쓰면 국제 금이
 * 현물이냐 선물이냐, 구리가 현물이냐 선물이냐에 따라 계열이 어긋난다).
 *
 * 미국 지수는 한국 아침 시간엔 이미 장이 끝나 있어 closePrice가 곧 종가다.
 *
 *   node scripts/collect.js            실제 저장
 *   node scripts/collect.js --dry      수집만 하고 화면 출력
 *   node scripts/collect.js --date 2026-08-07   특정 날짜로 저장
 *   node scripts/collect.js --force    거래일이 아니어도 강행
 *   node scripts/collect.js --only "미국채 30년"   지표 하나만 수집해 그날 기록에 덧붙인다
 *                                     (지표를 새로 붙인 날, 이미 저장된 다른 값을
 *                                      건드리지 않고 그 지표만 채워 넣을 때 쓴다)
 */

const PROJECT = 'invest-tracker-f7e3f';
const SYNC_DOC = 'sync/0000';           // 앱 설정(⚙ 동기화)의 동기화 키
const WEB_API_KEY = 'AIzaSyDnQ1txyDi0DJJPdW-kWU5QTf_5Ah6ldtU';

const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const NAVER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  Referer: 'https://m.stock.naver.com/',
};

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const DATE_ARG = (() => {
  const i = args.indexOf('--date');
  return i >= 0 ? args[i + 1] : null;
})();
// 예약(cron) 실행 전용. 오늘 기록이 이미 있으면 저장하지 않는다.
//   GitHub 예약 실행이 매일 몇 시간씩 밀리고, 그 사이 PC(invest-notify.js)가
//   workflow_dispatch로 먼저 값을 넣는다. 밀린 예약 실행이 뒤늦게 도착해 그 값을
//   오후 시세로 덮어쓰던 것을 막는다 (2026-09-01~03 사흘 연속 실제로 덮어썼다).
//   수동 실행·--only 는 이 플래그를 안 받으므로 종전대로 덮어쓴다(의도된 재실행).
const SKIP_IF_RECORDED = args.includes('--skip-if-recorded');
// 쉼표로 여러 개도 된다: --only "미국채 30년,국채10년"
const ONLY = (() => {
  const i = args.indexOf('--only');
  if (i < 0) return null;
  const names = (args[i + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
  return names.length ? names : null;
})();

// ── 유틸 ────────────────────────────────────────────────────────────────
const num = s => {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

function kstToday() {
  // sv-SE 로캘이 YYYY-MM-DD 형태를 준다
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

async function getJson(url, headers = NAVER_HEADERS) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// ── 수집 대상 ───────────────────────────────────────────────────────────
// 이름은 앱에 저장된 지표명과 한 글자도 다르면 안 된다 ('국채 3년'의 공백까지).
const API = 'https://api.stock.naver.com';
const MOBILE = 'https://m.stock.naver.com/api';
const POLL = 'https://polling.finance.naver.com/api/realtime';

const naverIndex = code => async () => num((await getJson(`${MOBILE}/index/${code}/basic`)).closePrice);
const naverStock = code => async () => num((await getJson(`${MOBILE}/stock/${code}/basic`)).closePrice);
const worldIndex = code => async () => num((await getJson(`${POLL}/worldstock/index/${code}`)).datas[0].closePrice);
const bond = code => async () => num((await getJson(`${API}/marketindex/bond/${encodeURIComponent(code)}`)).closePrice);
const marketIndex = (cat, code) => async () => {
  const d = await getJson(`${API}/marketindex/${cat}/${code}`);
  return num(d.closePrice ?? d.exchangeInfo?.closePrice);
};

const SOURCES = [
  ['국채 3년',    bond('KR3YT=RR')],
  ['국채10년',    bond('KR10YT=RR')],
  ['미국채 2년',  bond('US2YT=RR')],
  ['미국채 10년', bond('US10YT=RR')],
  ['미국채 30년', bond('US30YT=RR')],
  ['원달러환율',  marketIndex('exchange', 'FX_USDKRW')],
  ['달러인덱스',  marketIndex('exchange', '.DXY')],
  ['코스피지수',  naverIndex('KOSPI')],
  ['코스닥지수',  naverIndex('KOSDAQ')],
  ['나스닥',      worldIndex('.IXIC')],
  ['다우존스',    worldIndex('.DJI')],
  ['S&P500',      worldIndex('.INX')],
  ['국제 금',     marketIndex('metals', 'GCcv1')],      // COMEX 금 선물, USD/트로이온스
  ['국내 금',     marketIndex('metals', 'M04020000')],  // KRX 금시장, 원/g
  ['구리',        marketIndex('metals', 'CMCU0')],      // LME 현물, USD/MT
  ['원유',        marketIndex('energy', 'CLcv1')],      // WTI, USD/배럴
  ['비트코인',    async () => (await getJson('https://api.upbit.com/v1/ticker?markets=KRW-BTC', {}))[0].trade_price],
  ['삼성전자',    naverStock('005930')],
  ['삼성전자우',  naverStock('005935')],
  ['에이피알',    naverStock('278470')],
];

// 앱이 입력 화면에서 자동으로 채우는 값들. 같은 식을 그대로 쓴다.
function addDerived(v) {
  if (v['국제 금'] != null && v['원달러환율'] != null) {
    v['금 환산'] = Math.round(v['국제 금'] * v['원달러환율'] / 31.1035);
    if (v['국내 금'] != null && v['금 환산']) {
      v['금 할인률'] = parseFloat((((v['금 환산'] - v['국내 금']) / v['금 환산']) * 100).toFixed(2));
    }
  }
  if (v['삼성전자'] && v['삼성전자우'] != null) {
    v['삼성우비율'] = parseFloat((v['삼성전자우'] / v['삼성전자']).toFixed(4));
  }
}

// ── 거래일 판정 ─────────────────────────────────────────────────────────
// 주말은 cron이 걸러주지만 공휴일은 못 거른다. 코스피가 오늘 거래된 적이
// 있는지로 판단한다 — 휴장일이면 localTradedAt이 지난 거래일에 멈춰 있다.
async function isTradingDay(today) {
  const d = await getJson(`${MOBILE}/index/KOSPI/basic`);
  const traded = (d.localTradedAt || '').slice(0, 10);
  return { ok: traded === today, traded };
}

// ── Firestore ───────────────────────────────────────────────────────────
// 서비스 계정이 있으면 그걸로(보안 규칙을 우회한다), 없으면 공개 웹 키로 붙는다.
async function accessToken() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  // 키 파일을 그대로 시크릿에 넣으면 BOM이 앞에 붙어 오는 일이 잦다 (Windows에서
  // 흔하다). 눈에 안 보이는 한 글자 때문에 JSON.parse가 깨지므로 미리 걷어낸다.
  const sa = JSON.parse(raw.replace(/^﻿/, '').trim());
  const crypto = await import('node:crypto');

  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claim = b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${claim}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('토큰 발급 실패: ' + JSON.stringify(j));
  return j.access_token;
}

function fsUrl(token, extra = '') {
  const sep = extra.includes('?') ? '&' : '?';
  return token ? `${FS}/${SYNC_DOC}${extra}` : `${FS}/${SYNC_DOC}${extra}${sep}key=${WEB_API_KEY}`;
}

async function readPayload(token) {
  const res = await fetch(fsUrl(token), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Firestore 읽기 실패 ${res.status}: ${await res.text()}`);
  const doc = await res.json();
  const s = doc.fields?.payload?.stringValue;
  return s ? JSON.parse(s) : {};
}

// Firestore 쓰기는 가끔 429(RESOURCE_EXHAUSTED, "maximum bandwidth for writes")로 튕긴다.
// 2026-08-25에 이것 하나로 그날 기록이 통째로 빠졌다 — 수집도 읽기도 다 됐는데
// 마지막 쓰기 한 번이 실패해 손으로 재실행해야 했다. 구글 안내대로 지수 백오프로 다시 건다.
// 401·403·400 같은 영구 오류는 몇 번을 보내도 같으므로 재시도하지 않고 바로 올린다.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS = [3000, 6000, 12000];   // 마지막 시도까지 최대 21초

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function writePayload(token, data) {
  const mask = 'updateMask.fieldPaths=payload&updateMask.fieldPaths=updatedAt';
  const body = JSON.stringify({
    fields: {
      payload: { stringValue: JSON.stringify(data) },
      updatedAt: { integerValue: String(Date.now()) },
    },
  });

  for (let i = 0; ; i++) {
    let res = null, netErr = null;
    try {
      res = await fetch(fsUrl(token, `?${mask}`), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      netErr = e;   // 타임아웃·연결 끊김. 다시 걸어볼 값어치가 있다
    }
    if (res && res.ok) {
      if (i) console.log(`쓰기 성공 (재시도 ${i}회째)`);
      return;
    }

    const detail = res ? `${res.status}: ${await res.text()}` : netErr.message;
    const again = res ? RETRY_STATUS.has(res.status) : true;
    if (!again || i >= RETRY_DELAYS.length) throw new Error(`Firestore 쓰기 실패 ${detail}`);

    console.error(`쓰기 실패 ${detail}
  ${RETRY_DELAYS[i] / 1000}초 뒤 다시 시도합니다 (${i + 1}/${RETRY_DELAYS.length})`);
    await sleep(RETRY_DELAYS[i]);
  }
}

// ── 실행 ────────────────────────────────────────────────────────────────
(async () => {
  const today = DATE_ARG || kstToday();

  if (!FORCE) {
    const { ok, traded } = await isTradingDay(today);
    if (!ok) {
      console.log(`휴장일로 보입니다 (오늘 ${today}, 코스피 마지막 거래일 ${traded}). 기록하지 않고 종료합니다.`);
      return;
    }
  }

  const targets = ONLY ? SOURCES.filter(([n]) => ONLY.includes(n)) : SOURCES;
  if (ONLY) {
    const unknown = ONLY.filter(n => !SOURCES.some(([s]) => s === n));
    if (unknown.length) {
      console.error(`--only 에 없는 지표명: ${unknown.join(', ')}`);
      console.error(`쓸 수 있는 이름: ${SOURCES.map(([n]) => n).join(', ')}`);
      process.exitCode = 1;   // exit()은 윈도우에서 libuv assertion을 낸다
      return;
    }
    console.log(`--only ${ONLY.join(', ')} — 이 지표만 수집합니다 (나머지는 그대로 둡니다)`);
  }

  const values = {};
  const failed = [];
  await Promise.all(targets.map(async ([name, fn]) => {
    try {
      const v = await fn();
      if (v == null) throw new Error('값이 비어 있음');
      values[name] = v;
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
    }
  }));

  addDerived(values);

  const ordered = {};
  for (const [name] of targets) if (values[name] != null) ordered[name] = values[name];
  for (const k of ['금 환산', '금 할인률', '삼성우비율']) if (values[k] != null) ordered[k] = values[k];

  console.log(`[${today}] 수집 ${Object.keys(ordered).length}개`);
  for (const [k, v] of Object.entries(ordered)) console.log(`  ${k.padEnd(12)} ${v}`);
  if (failed.length) console.log('\n실패:\n  ' + failed.join('\n  '));

  // 절반 넘게 실패했으면 반쪽짜리 기록을 남기지 않는다
  if (failed.length > targets.length / 2) {
    console.error('\n수집 실패가 너무 많습니다. 저장하지 않고 종료합니다.');
    process.exit(1);
  }

  // 자격증명 확인은 --dry에서도 한다. 그래야 점검 실행이 시크릿까지 검사한다.
  const token = await accessToken();
  console.log(`\n인증: ${token ? '서비스 계정' : '공개 웹 키'}`);

  const data = await readPayload(token);
  console.log(`클라우드 읽기 OK — 기존 ${Object.keys(data).length}일치`);

  const before = data[today];
  // 오늘 기록이 있고, 방금 모은 지표가 전부 거기 이미 들어 있으면 예약 실행은 물러난다.
  // "전부"를 따지는 이유: 아침 실행이 일부 지표를 놓친 채 저장됐다면 빈칸은 채워야 한다.
  if (SKIP_IF_RECORDED && before && Object.keys(ordered).every(k => before[k] != null)) {
    console.log(`오늘(${today}) 기록이 이미 있습니다 (${Object.keys(before).length}개). 예약 실행이라 덮어쓰지 않고 종료합니다.`);
    return;
  }

  if (DRY) { console.log('--dry 이므로 저장하지 않았습니다.'); return; }

  data[today] = { ...(before || {}), ...ordered };  // 손으로 넣은 값이 있으면 살려둔다
  await writePayload(token, data);

  console.log(`저장 완료 — 전체 ${Object.keys(data).length}일치, ${today} ${before ? '갱신' : '추가'}`);
  if (failed.length) process.exitCode = 1;   // 저장은 했지만 로그에 실패가 남게
})().catch(e => {
  console.error('오류:', e.message);
  process.exit(1);
});
