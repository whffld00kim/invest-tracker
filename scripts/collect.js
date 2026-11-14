#!/usr/bin/env node
/**
 * 투자 트래커 자동 입력
 *
 * 평일 아침(10:37 KST)에 GitHub Actions가 이 스크립트를 돌린다.
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
 *   node scripts/collect.js --date 2026-08-07 --force   그 날짜에 지금 시세를 저장 (오늘이 아니면 --force 가 있어야 한다)
 *   node scripts/collect.js --force    거래일이 아니어도 강행
 *   node scripts/collect.js --only "미국채 30년"   지표 하나만 수집해 그날 기록에 덧붙인다
 *                                     (지표를 새로 붙인 날, 이미 저장된 다른 값을
 *                                      건드리지 않고 그 지표만 채워 넣을 때 쓴다)
 *   node scripts/collect.js --drop "나스닥,다우존스,S&P500" --date 2026-09-08
 *                                     그 날짜 기록에서 그 지표만 지운다 (앱·볼트에 "-"로 보인다).
 *                                     휴장일에 낡은 종가가 들어간 날을 고칠 때 쓴다.
 *                                     --date 는 쉼표로 여러 날짜도 된다. 수집은 하지 않는다
 *   node scripts/collect.js --set "S&P500=6792.62,다우존스=45960.11" --date 2025-12-19
 *                                     그 날짜의 값을 적어 준 숫자로 바로잡는다 (2026-11-14). 수집은 하지 않는다.
 *                                     재료가 바뀐 계산값(금 환산·금 할인률·삼성우비율)은 같이 다시 계산한다.
 *                                     그 날짜 기록이 없으면 멈춘다(--force 면 새로 만든다)
 *   node scripts/collect.js --print-meta   문서에 싣는 지표 목록(JSON)만 찍는다
 *
 * ⚠ 시장이 쉰 지표는 저장하지 않는다 (2026-09-08). 네이버는 휴장일에도 지난 종가를
 *   closePrice로 주므로, 그대로 받으면 미국 휴장일 다음날 미국 지수가 전날 값으로 또 들어간다
 *   (실제로 09-07 노동절 → 09-08 행에 09-04 종가). 응답의 localTradedAt으로 지표마다 가른다.
 *   빠진 지표는 앱·볼트에 "-"로 보인다. 아래 「신선도 판정」 참고
 *
 * ⚠ 기록 보호 (2026-11-14) — 지키려는 것은 3년치 기록 그 자체다.
 *   · 읽은 문서에 기록(payload)이 없거나 풀 수 없으면 "0일치"로 보지 않고 멈춘다. 그대로 쓰면 오늘 하루치로 전체를 덮는다
 *   · 쓰려는 날 수가 읽은 날 수보다 적으면 멈춘다
 *   · 읽은 뒤 문서가 바뀌지 않았을 때만 쓴다(currentDocument.updateTime). 바뀌었으면 다시 읽어 한 번 더
 */

const PROJECT = 'invest-tracker-f7e3f';
const SYNC_DOC = 'sync/0000';           // 앱이 받는 문서 (하나뿐이다)
const WEB_API_KEY = 'AIzaSyDnQ1txyDi0DJJPdW-kWU5QTf_5Ah6ldtU';

const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const NAVER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  Referer: 'https://m.stock.naver.com/',
};

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const argOf = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const DATE_ARG = args.includes('--date') ? (argOf('--date') ?? '') : null;
// 예약(cron) 실행 전용. 오늘 기록이 이미 있으면 저장하지 않는다.
//   GitHub 예약 실행이 매일 몇 시간씩 밀리고, 그 사이 PC(invest-notify.js)가
//   workflow_dispatch로 먼저 값을 넣는다. 밀린 예약 실행이 뒤늦게 도착해 그 값을
//   오후 시세로 덮어쓰던 것을 막는다 (2026-09-01~03 사흘 연속 실제로 덮어썼다).
//   수동 실행·--only 는 이 플래그를 안 받으므로 종전대로 덮어쓴다(의도된 재실행).
const SKIP_IF_RECORDED = args.includes('--skip-if-recorded');
// 쉼표로 여러 개도 된다: --only "미국채 30년,국채10년"
const listArg = flag => {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const names = (args[i + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
  return names.length ? names : null;
};
const ONLY = listArg('--only');
const DROP = listArg('--drop');
const SET_ARG = args.includes('--set') ? (argOf('--set') ?? '') : null;

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
const API = 'https://api.stock.naver.com';
const MOBILE = 'https://m.stock.naver.com/api';
const POLL = 'https://polling.finance.naver.com/api/realtime';

// 각 함수는 { v: 값, at: 거래소 현지시각(localTradedAt) } 을 돌려준다. at은 신선도 판정에 쓴다
const pick = d => ({ v: num(d.closePrice), at: d.localTradedAt });
const naverIndex = code => async () => pick(await getJson(`${MOBILE}/index/${code}/basic`));
const naverStock = code => async () => pick(await getJson(`${MOBILE}/stock/${code}/basic`));
const worldIndex = code => async () => pick((await getJson(`${POLL}/worldstock/index/${code}`)).datas[0]);
const bond = code => async () => pick(await getJson(`${API}/marketindex/bond/${encodeURIComponent(code)}`));
const marketIndex = (cat, code) => async () => {
  const d = await getJson(`${API}/marketindex/${cat}/${code}`);
  return pick(d.closePrice != null ? d : (d.exchangeInfo ?? d));   // 환율은 exchangeInfo 안에 있다
};
const upbit = market => async () => {
  const t = (await getJson(`https://api.upbit.com/v1/ticker?markets=${market}`, {}))[0];
  const ymd = String(t.trade_date_kst || '');
  return { v: t.trade_price, at: ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}` : '' };
};

// ── 지표 정의 — 이름·묶음·순서·표기의 원본 (2026-11-14) ──────────────────
// 여기 한 곳만 고치면 된다. 이 목록을 문서의 indicators 칸에 실어 보내고, 앱(index.html)과 볼트 동기화(sync-invest.js)가
// 그 칸을 읽어 순서·묶음·표기를 따른다. 그전엔 지표 하나를 더할 때 다섯 곳(여기·앱 기본 목록·ADDED_LATER·sync-invest GROUPS·POINT_DIFF)을
// 손봐야 했고, 앱 목록은 기기마다 따로였다.
// 이름은 저장된 기록의 지표명과 한 글자도 다르면 안 된다 ('국채 3년'의 공백까지).
//   zone·get  수집하는 지표: 시장(신선도 판정 기준 — 아래 isFresh)과 수집 함수
//     kr     한국 시장 — 현지 날짜가 오늘이어야 한다
//     world  해외 시장 — 현지 날짜가 오늘의 직전 평일 이상이어야 한다
//     always 24시간 시장 — 항상 받는다
//   derived   수집하지 않고 그날 값으로 계산해 저장하는 값 (addDerived)
//   ratio     저장하지 않는 값 — 앱·볼트가 두 지표로 그때그때 계산한다 [분자, 분모]
//   point     금리처럼 이미 %인 값: 변화를 %p 로 적고, 그 소수 자릿수
//   digits    기록 자릿수 그대로 보일 고정 자릿수 · nochg  표에서 변화 줄을 달지 않는다(계산값) · calc  계산식 설명
const INDICATORS = [
  { name: '국채 3년',    group: '금리', unit: '%', point: 3, zone: 'kr',    get: bond('KR3YT=RR') },
  { name: '국채10년',    group: '금리', unit: '%', point: 3, zone: 'kr',    get: bond('KR10YT=RR') },
  { name: '미국채 2년',  group: '금리', unit: '%', point: 3, zone: 'world', get: bond('US2YT=RR') },
  { name: '미국채 10년', group: '금리', unit: '%', point: 3, zone: 'world', get: bond('US10YT=RR') },
  { name: '미국채 30년', group: '금리', unit: '%', point: 3, zone: 'world', get: bond('US30YT=RR') },
  { name: '원달러환율',  group: '환율', unit: '원', zone: 'kr',    get: marketIndex('exchange', 'FX_USDKRW') },   // 하나은행 고시
  { name: '달러인덱스',  group: '환율',             zone: 'world', get: marketIndex('exchange', '.DXY') },
  { name: '코스피지수',  group: '주가지수', zone: 'kr',    get: naverIndex('KOSPI') },
  { name: '코스닥지수',  group: '주가지수', zone: 'kr',    get: naverIndex('KOSDAQ') },
  { name: '나스닥',      group: '주가지수', zone: 'world', get: worldIndex('.IXIC') },
  { name: '다우존스',    group: '주가지수', zone: 'world', get: worldIndex('.DJI') },
  { name: 'S&P500',      group: '주가지수', zone: 'world', get: worldIndex('.INX') },
  { name: '국제 금',     group: '원자재', unit: 'USD/oz', zone: 'world', get: marketIndex('metals', 'GCcv1') },      // COMEX 금 선물, USD/트로이온스
  { name: '금 환산',     group: '원자재', unit: '원/g', nochg: true, derived: true, calc: '국제 금 × 환율 ÷ 31.1035' },
  { name: '금 할인률',   group: '원자재', unit: '%', point: 2, digits: 2, nochg: true, derived: true, calc: '(금 환산 − 국내 금) ÷ 금 환산 × 100' },
  { name: '국내 금',     group: '원자재', unit: '원/g', zone: 'kr', get: marketIndex('metals', 'M04020000') },         // KRX 금시장, 원/g
  { name: '구리',        group: '원자재', unit: 'USD/MT', zone: 'world', get: marketIndex('metals', 'CMCU0') },        // LME 현물, USD/MT
  { name: '원유',        group: '원자재', unit: 'USD/배럴', zone: 'world', get: marketIndex('energy', 'CLcv1') },      // WTI, USD/배럴
  { name: '비트코인',    group: '가상자산/주식', unit: '원', zone: 'always', get: upbit('KRW-BTC') },
  { name: '삼성전자',    group: '가상자산/주식', unit: '원', zone: 'kr', get: naverStock('005930') },
  { name: '삼성전자우',  group: '가상자산/주식', unit: '원', zone: 'kr', get: naverStock('005935') },
  { name: '삼성우비율',  group: '가상자산/주식', digits: 4, nochg: true, derived: true, calc: '삼성전자우 ÷ 삼성전자' },
  { name: 'SK하이닉스',  group: '가상자산/주식', unit: '원', zone: 'kr', get: naverStock('000660') },   // 2026-11-14 추가
  { name: '에이피알',    group: '가상자산/주식', unit: '원', zone: 'kr', get: naverStock('278470') },
  { name: '에이피알/삼성전자', group: '가상자산/주식', digits: 4, nochg: true, ratio: ['에이피알', '삼성전자'], calc: '에이피알 ÷ 삼성전자' },
  { name: '에이피알/하이닉스', group: '가상자산/주식', digits: 4, nochg: true, ratio: ['에이피알', 'SK하이닉스'], calc: '에이피알 ÷ SK하이닉스' },
];
// [이름, 시장, 수집 함수]
const SOURCES = INDICATORS.filter(i => i.get).map(i => [i.name, i.zone, i.get]);
const DERIVED = INDICATORS.filter(i => i.derived).map(i => i.name);
// 문서의 indicators 칸에 싣는 글자 (수집 함수·시장 같은 안쪽 칸은 뺀다)
function metaJson() {
  return JSON.stringify(INDICATORS.map(i => {
    const o = { name: i.name, group: i.group };
    for (const k of ['unit', 'point', 'digits', 'nochg', 'ratio', 'calc', 'hidden']) if (i[k] !== undefined) o[k] = i[k];
    return o;
  }));
}

// ── 신선도 판정 ─────────────────────────────────────────────────────────
// 지표마다 시장이 다르다. 미국 휴장일에도 코스피는 열려 있으니 그날을 통째로 건너뛸 수 없고,
// 그렇다고 네이버 closePrice를 그대로 받으면 지난 종가가 오늘 값으로 들어간다.
// 응답의 localTradedAt(거래소 현지시각, 오프셋 포함)의 날짜로 지표별로 가른다 —
// 휴장일 달력을 손으로 관리할 필요가 없다. 2026-09-07 노동절 실측:
//   나스닥·다우·S&P500 → 09-04 (낡음)  /  미국채·달러인덱스·금·원유·구리 → 09-07 (전자·OTC 호가는 움직였다)
// 즉 같은 휴장일에도 지표마다 갈리므로 "미국 휴장일이면 미국 것 전부 비움"으로 뭉뚱그리면 안 된다.
// 채권·달러인덱스·금·원유·구리가 미국 휴장일에 통과하는 것은 맞는 동작이다 — 국채는 24시간 글로벌
// OTC(도쿄·런던에서 거래), 외환은 24/5, Globex·LME는 미국 휴일과 무관하다. 지난 종가의 복사본이 아니다.
function prevWeekday(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
function isFresh(zone, at, today) {
  if (zone === 'always') return true;
  const local = String(at || '').slice(0, 10);
  // 시각을 안 주면 판정할 수 없다. 받아 버리면 휴장일에 지난 종가가 조용히 들어가므로(09-08 이전 문제)
  // 실패로 센다 — 다른 값은 저장되고 종료코드 1로 로그에 남는다 (2026-10-20 클라우드 점검 #4)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(local)) throw new Error('거래 시각(localTradedAt)이 없음 — API 변경?');
  return zone === 'kr' ? local === today : local >= prevWeekday(today);
}

// 앱이 입력 화면에서 자동으로 채우던 값들. 같은 식을 그대로 쓴다.
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
// 계산값의 재료. --set 으로 재료를 바꾸면 그 계산값을 다시 낸다
const DERIVED_FROM = {
  '금 환산': ['국제 금', '원달러환율'],
  '금 할인률': ['국제 금', '원달러환율', '국내 금'],
  '삼성우비율': ['삼성전자', '삼성전자우'],
};

// ── 거래일 판정 ─────────────────────────────────────────────────────────
// 주말은 cron이 걸러주지만 공휴일은 못 거른다. 코스피가 오늘 거래된 적이
// 있는지로 판단한다 — 휴장일이면 localTradedAt이 지난 거래일에 멈춰 있다.
async function isTradingDay(today) {
  const d = await getJson(`${MOBILE}/index/KOSPI/basic`);
  const traded = (d.localTradedAt || '').slice(0, 10);
  // 시각이 없으면 "휴장"이 아니라 "판정 불가"다. 휴장으로 치면 응답 형식이 바뀐 날부터
  // 매일 조용히 건너뛰고 Actions는 초록으로 남는다 (2026-10-20 클라우드 점검 #4)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(traded)) {
    throw new Error('코스피 응답에 localTradedAt이 없습니다 (API 변경?) — 거래일 판정 불가');
  }
  return { ok: traded === today, traded };
}

// ── Firestore ───────────────────────────────────────────────────────────
// 서비스 계정이 있으면 그걸로(보안 규칙을 우회한다), 없으면 공개 웹 키로 붙는다.
async function accessToken() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    // Actions에서 시크릿이 비면 --dry 점검이 공개 웹 키로 조용히 "성공"한다 — 거기선 오류로 (10/20 점검)
    if (process.env.GITHUB_ACTIONS === 'true') throw new Error('FIREBASE_SERVICE_ACCOUNT 시크릿이 비어 있습니다');
    return null;
  }
  // 키 파일을 그대로 시크릿에 넣으면 BOM이 앞에 붙어 오는 일이 잦다 (Windows에서
  // 흔하다). 눈에 안 보이는 한 글자 때문에 JSON.parse가 깨지므로 미리 걷어낸다.
  // 파싱 오류 문구엔 입력 일부가 찍힐 수 있다 — 공개 저장소의 Actions 로그는 공개라 고정 문구로 바꾼다
  let sa;
  try { sa = JSON.parse(raw.replace(/^﻿/, '').trim()); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT 시크릿이 올바른 JSON이 아닙니다'); }
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

// 문서를 읽는다 → { data, days, updateTime }
// 기록(payload)이 없거나 풀 수 없으면 "0일치"로 돌려주지 않고 멈춘다 (2026-11-14 — 그전엔 {} 로 보고 오늘 하루치만 써서
// 전체를 덮을 수 있었다. 볼트 동기화 sync-invest.js 는 같은 경우에 원래부터 멈췄다)
async function readDoc(token) {
  const res = await fetch(fsUrl(token), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Firestore 읽기 실패 ${res.status}: ${await res.text()}`);
  const doc = await res.json();
  const s = doc.fields?.payload?.stringValue;
  if (typeof s !== 'string' || !s.trim()) throw new Error('읽은 문서에 기록(payload)이 없습니다 — 덮어쓰지 않고 멈춥니다');
  let data;
  try { data = JSON.parse(s); } catch { throw new Error('읽은 문서의 기록(payload)을 풀 수 없습니다 — 덮어쓰지 않고 멈춥니다'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('읽은 문서의 기록(payload) 모양이 다릅니다 — 덮어쓰지 않고 멈춥니다');
  return { data, days: Object.keys(data).length, updateTime: doc.updateTime || '' };
}

// Firestore 쓰기는 가끔 429(RESOURCE_EXHAUSTED, "maximum bandwidth for writes")로 튕긴다.
// 2026-08-25에 이것 하나로 그날 기록이 통째로 빠졌다 — 수집도 읽기도 다 됐는데
// 마지막 쓰기 한 번이 실패해 손으로 재실행해야 했다. 구글 안내대로 지수 백오프로 다시 건다.
// 401·403·400 같은 영구 오류는 몇 번을 보내도 같으므로 재시도하지 않고 바로 올린다.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS = [3000, 6000, 12000];   // 마지막 시도까지 최대 21초

const sleep = ms => new Promise(r => setTimeout(r, ms));

// prev = readDoc 이 돌려준 것. 읽은 뒤 문서가 바뀌지 않았을 때만 쓴다 — 바뀌었으면 e.conflict 를 달아 던진다
async function writeDoc(token, data, prev) {
  const days = Object.keys(data).length;
  if (days < prev.days) throw new Error(`쓰려는 기록(${days}일)이 읽은 기록(${prev.days}일)보다 적습니다 — 멈춥니다`);
  const mask = ['payload', 'updatedAt', 'indicators'].map(f => `updateMask.fieldPaths=${f}`).join('&');
  const pre = prev.updateTime ? `&currentDocument.updateTime=${encodeURIComponent(prev.updateTime)}` : '';
  const body = JSON.stringify({
    fields: {
      payload: { stringValue: JSON.stringify(data) },
      updatedAt: { integerValue: String(Date.now()) },
      indicators: { stringValue: metaJson() },
    },
  });

  for (let i = 0; ; i++) {
    let res = null, netErr = null;
    try {
      res = await fetch(fsUrl(token, `?${mask}${pre}`), {
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

    const text = res ? await res.text() : '';
    const detail = res ? `${res.status}: ${text}` : netErr.message;
    // 조건부 쓰기 거절 = 읽은 뒤 누가 문서를 고쳤다 (또는 앞선 시도가 실은 들어갔다). 다시 읽고 다시 얹는다
    if (res && (res.status === 409 || res.status === 412 || (res.status === 400 && /FAILED_PRECONDITION/.test(text)))) {
      const e = new Error(`그사이 문서가 바뀌었습니다 (${res.status})`); e.conflict = true; throw e;
    }
    const again = res ? RETRY_STATUS.has(res.status) : true;
    if (!again || i >= RETRY_DELAYS.length) throw new Error(`Firestore 쓰기 실패 ${detail}`);

    console.error(`쓰기 실패 ${detail}
  ${RETRY_DELAYS[i] / 1000}초 뒤 다시 시도합니다 (${i + 1}/${RETRY_DELAYS.length})`);
    await sleep(RETRY_DELAYS[i]);
  }
}

// 읽고 → 고치고 → 쓴다. mutate(data) 는 data 를 그 자리에서 고치고 바뀐 것이 있으면 true 를 돌려준다.
// 쓰는 사이 문서가 바뀌었으면 다시 읽어 같은 고침을 다시 얹는다(세 번까지)
async function update(token, mutate) {
  for (let attempt = 1; ; attempt++) {
    const prev = await readDoc(token);
    if (attempt === 1) console.log(`클라우드 읽기 OK — 기존 ${prev.days}일치`);
    const changed = mutate(prev.data);
    if (!changed) return { written: false, days: prev.days };
    if (DRY) { console.log('--dry 이므로 저장하지 않았습니다.'); return { written: false, dry: true, days: prev.days }; }
    try {
      await writeDoc(token, prev.data, prev);
      return { written: true, days: Object.keys(prev.data).length };
    } catch (e) {
      if (!e.conflict || attempt >= 3) throw e;
      console.log(`${e.message} — 다시 읽어 한 번 더 씁니다 (${attempt}/2)`);
    }
  }
}

// ── 실행 ────────────────────────────────────────────────────────────────
// --date 검증: 형식·실존 날짜·오늘 이하. "2026-10-2" 같은 키가 생기면 앱 정렬과 PC 동기화가 그 키를 만난다
// (2026-10-20 클라우드 점검 #7). --drop 은 쉼표로 여러 날짜를 받으므로 하나씩 본다
function badDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '형식은 YYYY-MM-DD';
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return '없는 날짜';
  if (s > kstToday()) return '미래 날짜';
  return null;
}
const fail = msg => { console.error(msg); process.exitCode = 1; };

(async () => {
  if (args.includes('--print-meta')) { console.log(metaJson()); return; }

  if (DATE_ARG != null) {
    const bad = DATE_ARG.split(',').map(s => s.trim()).map(s => [s, badDate(s)]).filter(([, why]) => why);
    if (!DATE_ARG.trim() || bad.length) {
      return fail(`--date 값이 잘못됐습니다: ${bad.map(([s, why]) => `${s || '(빈 값)'} (${why})`).join(', ') || '(빈 값)'}`);
    }
    if (!DROP && DATE_ARG.includes(',')) return fail('--date 에 여러 날짜를 쓸 수 있는 건 --drop 일 때뿐입니다');
  }
  const today = DATE_ARG || kstToday();

  // --set: 수집 없이 그 날짜의 값을 적어 준 숫자로 바로잡는다 (2026-11-14).
  // 손으로 넣던 때의 오타처럼 지난 값을 고칠 길이 없었다 — --only 는 지금 시세를 넣고 --drop 은 비우기만 한다
  if (SET_ARG != null) {
    if (DROP || ONLY) return fail('--set 은 --only·--drop 과 같이 쓸 수 없습니다');
    if (DATE_ARG == null) return fail('--set 에는 --date YYYY-MM-DD 가 있어야 합니다 (고칠 날짜)');
    const pairs = SET_ARG.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const i = s.lastIndexOf('=');
      return i < 0 ? [s, NaN, ''] : [s.slice(0, i).trim(), Number(s.slice(i + 1).trim()), s.slice(i + 1).trim()];
    });
    if (!pairs.length) return fail('--set 값이 비었습니다. 예: --set "S&P500=6792.62,구리=9908.49"');
    const stored = new Set([...SOURCES.map(([n]) => n), ...DERIVED]);
    const wrong = pairs.filter(([n, v, raw]) => !stored.has(n) || raw === '' || !Number.isFinite(v) || (SOURCES.some(([s]) => s === n) && !(v > 0)));
    if (wrong.length) {
      console.error(`--set 에 쓸 수 없는 값: ${wrong.map(([n, , raw]) => `${n}=${raw}`).join(', ')}`);
      return fail(`쓸 수 있는 이름: ${[...stored].join(', ')} (수집하는 지표는 0보다 큰 숫자)`);
    }
    const token = await accessToken();
    let missing = false;
    const r = await update(token, data => {
      if (!data[today]) {
        if (!FORCE) { missing = true; return false; }
        data[today] = {};
      }
      const day = data[today], touched = new Set();
      let n = 0;
      for (const [name, v] of pairs) {
        if (day[name] === v) { console.log(`${today} ${name}: 이미 ${v}`); continue; }
        console.log(`${today} ${name}: ${day[name] === undefined ? '(없음)' : day[name]} → ${v}`);
        day[name] = v; touched.add(name); n++;
      }
      // 재료가 바뀐 계산값을 다시 낸다 (직접 적어 준 계산값은 그대로 둔다)
      const calc = { ...day }; addDerived(calc);
      for (const [k, from] of Object.entries(DERIVED_FROM)) {
        if (pairs.some(([name]) => name === k) || !from.some(f => touched.has(f)) || calc[k] === undefined || calc[k] === day[k]) continue;
        console.log(`${today} ${k}: ${day[k] === undefined ? '(없음)' : day[k]} → ${calc[k]} (다시 계산)`);
        day[k] = calc[k]; n++;
      }
      return n > 0;
    });
    if (missing) return fail(`${today} 기록이 없습니다 — 새로 만들려면 --force 를 같이 주세요`);
    if (r.written) console.log(`저장 완료 — ${today} 값을 바로잡았습니다 (전체 ${r.days}일치)`);
    else if (!r.dry) console.log('바꿀 것이 없습니다.');
    return;
  }

  // --drop: 수집 없이 그 날짜의 그 지표만 지운다. 저장이 기존 키를 살리는 병합이라
  // 한번 들어간 낡은 값은 다시 수집해도 안 사라지므로 지우는 길이 따로 필요하다.
  if (DROP) {
    const dates = today.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = DROP.filter(n => !SOURCES.some(([s]) => s === n) && !DERIVED.includes(n));
    if (unknown.length) return fail(`--drop 에 없는 지표명: ${unknown.join(', ')}`);
    const token = await accessToken();
    let n = 0;
    const r = await update(token, data => {
      n = 0;
      for (const d of dates) {
        if (!data[d]) { console.log(`${d}: 기록 없음`); continue; }
        const hit = DROP.filter(k => k in data[d]);
        for (const k of hit) delete data[d][k];
        n += hit.length;
        console.log(`${d}: ${hit.length ? hit.join(', ') + ' 지움' : '지울 값 없음'}`);
      }
      return n > 0;
    });
    if (r.written) console.log(`저장 완료 — ${n}개 값을 비웠습니다 (앱·볼트에 "-")`);
    return;
  }

  if (!FORCE) {
    // 오늘이 아닌 날짜에는 "지금 시세"를 넣게 된다 — 일부러 그러는 것이 아니면 막는다.
    // (그전엔 거래일 판정에 걸려 「휴장일로 보입니다 (오늘 …)」라는 엉뚱한 문구로 멈췄다)
    if (today !== kstToday()) {
      return fail(`--date ${today} 는 오늘이 아닙니다. 지금 시세를 그 날짜에 넣으려면 --force 를 같이 주세요. 지난 값을 바로잡는 것이면 --set "지표=값" 을 쓰세요.`);
    }
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
      return fail(`쓸 수 있는 이름: ${SOURCES.map(([n]) => n).join(', ')}`);   // exit()은 윈도우에서 libuv assertion을 낸다
    }
    console.log(`--only ${ONLY.join(', ')} — 이 지표만 수집합니다 (나머지는 그대로 둡니다)`);
  }

  // 다른 날짜로 저장할 때는 지금 시세를 과거 날짜에 넣는 것이라 신선도 기준이 없다
  const checkFresh = today === kstToday();
  if (!checkFresh) console.log(`--date ${today}: 오늘이 아니므로 휴장 판정을 하지 않습니다`);

  const values = {};
  const failed = [];
  const stale = [];   // 시장이 쉬어 낡은 값. 실패가 아니므로 따로 센다 (종료코드·중단 판정에 안 들어간다)
  await Promise.all(targets.map(async ([name, zone, fn]) => {
    try {
      const { v, at } = await fn();
      if (v == null) throw new Error('값이 비어 있음');
      // 시세가 0 이하로 오면 저장하지 않는다 — 앱은 0 을 빈칸처럼 다루지만 볼트·알림엔 0 이 그대로 나갔다 (2026-11-14)
      if (!(v > 0)) throw new Error(`값이 0 이하 (${v})`);
      if (checkFresh && !isFresh(zone, at, today)) {
        stale.push(`${name}: 현지 마지막 거래 ${String(at).slice(0, 10)}`);
        return;
      }
      values[name] = v;
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
    }
  }));

  addDerived(values);

  const ordered = {};
  for (const [name] of targets) if (values[name] != null) ordered[name] = values[name];
  for (const k of DERIVED) if (values[k] != null) ordered[k] = values[k];

  console.log(`[${today}] 수집 ${Object.keys(ordered).length}개`);
  for (const [k, v] of Object.entries(ordered)) console.log(`  ${k.padEnd(12)} ${v}`);
  if (stale.length) console.log('\n휴장 — 낡은 값이라 비움 (앱·볼트에 "-"):\n  ' + stale.join('\n  '));
  if (failed.length) console.log('\n실패:\n  ' + failed.join('\n  '));

  // 절반 넘게 실패했으면 반쪽짜리 기록을 남기지 않는다
  if (failed.length > targets.length / 2) {
    console.error('\n수집 실패가 너무 많습니다. 저장하지 않고 종료합니다.');
    process.exit(1);
  }

  // 자격증명 확인은 --dry에서도 한다. 그래야 점검 실행이 시크릿까지 검사한다.
  const token = await accessToken();
  console.log(`\n인증: ${token ? '서비스 계정' : '공개 웹 키'}`);

  // 모은 값이 하나도 없으면(예: 미국 휴장일에 --only 나스닥) 빈 기록 {} 을 만들지 않는다 (10/20 점검 #7)
  if (!Object.keys(ordered).length) {
    await readDoc(token);   // 읽기까지는 해 본다(--dry 점검이 자격증명·문서를 확인하도록)
    console.log('저장할 값이 없습니다. 종료합니다.');
    if (failed.length) process.exitCode = 1;
    return;
  }

  let had = false, skipped = false;
  const r = await update(token, data => {
    const before = data[today];
    had = !!before; skipped = false;
    let next = { ...(before || {}), ...ordered };  // 손으로 넣은 값이 있으면 살려둔다
    // 예약 실행은 오늘 기록이 있으면 **빈칸만** 채운다. 아침(10:37) 값은 건드리지 않는다.
    // 전엔 "전부 있나"만 보고, 하나라도 빠졌으면 모은 값 전체로 덮어 아침 값이 몇 시간 뒤 오후 시세로
    // 바뀌었다 (2026-10-20 클라우드 점검 #1 — 지표 하나를 뺀 스텁 재현에서 23개가 전부 바뀜)
    if (SKIP_IF_RECORDED && before) {
      const fill = Object.fromEntries(Object.entries(ordered).filter(([k]) => before[k] == null));
      if (!Object.keys(fill).length) {
        console.log(`오늘(${today}) 기록이 이미 있습니다 (${Object.keys(before).length}개). 예약 실행이라 덮어쓰지 않고 종료합니다.`);
        skipped = true;
        return false;
      }
      console.log(`예약 실행: 오늘 기록의 빈칸만 채웁니다 — ${Object.keys(fill).join(', ')}`);
      next = { ...before, ...fill };
    }
    data[today] = next;
    return true;
  });

  if (r.written) console.log(`저장 완료 — 전체 ${r.days}일치, ${today} ${had ? '갱신' : '추가'}`);
  if (failed.length && !skipped) process.exitCode = 1;   // 저장은 했지만 로그에 실패가 남게
})().catch(e => {
  console.error('오류:', e.message);
  process.exit(1);
});
