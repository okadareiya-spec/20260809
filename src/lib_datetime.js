/**
 * 日付・時刻ユーティリティ
 *
 * 本システムは日付を 'YYYY-MM-DD'、時刻を 'HH:mm'（2桁ゼロ埋め）の文字列で扱う。
 * この形式であれば時刻の大小比較を文字列比較で行えるが、
 * ゼロ埋めされていない値が1つ混ざるだけで比較が壊れる（"9:00" < "10:00" は偽）。
 * しかも例外は出ず「予約可能な部屋が0件」になるだけなので、
 * 外部から取り込んだ値は必ず normalizeTime / normalizeDate を通すこと。
 *
 * 参照: システム要件定義書 3.2 / 技術仕様書 3.2
 */

const TIMEZONE = 'Asia/Tokyo';
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// --- 現在時刻 -------------------------------------------------------------

function nowDateStr() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
}

function nowTimeStr() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'HH:mm');
}

function nowStampStr() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

// --- 正規化 ---------------------------------------------------------------

/**
 * 時刻を 'HH:mm' に正規化する。解釈できない場合は null を返す。
 * シートが時刻型で返してきた Date、'9:00'、'09:00:00' などを吸収する。
 */
function normalizeTime(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return Utilities.formatDate(value, TIMEZONE, 'HH:mm');
  }
  const m = String(value).trim().match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/);
  if (!m) return null;

  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;

  return pad2(h) + ':' + pad2(min);
}

/** 日付を 'YYYY-MM-DD' に正規化する。解釈できない場合は null を返す。 */
function normalizeDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return Utilities.formatDate(value, TIMEZONE, 'yyyy-MM-dd');
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;

  return y + '-' + pad2(mo) + '-' + pad2(d);
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// --- 変換 -----------------------------------------------------------------

/** 'HH:mm' → 0時からの経過分 */
function timeToMinutes(hhmm) {
  const t = normalizeTime(hhmm);
  if (t === null) return null;
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

/** 経過分 → 'HH:mm'。24時を超える値は渡さないこと（日跨ぎは仕様上不可）。 */
function minutesToTime(minutes) {
  return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
}

function addMinutes(hhmm, minutes) {
  return minutesToTime(timeToMinutes(hhmm) + minutes);
}

/** 'YYYY-MM-DD' → '月'〜'日' */
function weekdayOf(dateStr) {
  const d = normalizeDate(dateStr);
  if (d === null) return null;
  const parts = d.split('-');
  // 曜日だけが必要なので、ローカル時刻で構築して差し支えない
  const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return WEEKDAYS[dt.getDay()];
}

/** 日数を加算した日付を返す */
function addDays(dateStr, days) {
  const parts = normalizeDate(dateStr).split('-');
  const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  dt.setDate(dt.getDate() + days);
  return Utilities.formatDate(dt, TIMEZONE, 'yyyy-MM-dd');
}

/** 2つの日付の差（日数）。b - a */
function diffDays(aDateStr, bDateStr) {
  const a = normalizeDate(aDateStr).split('-');
  const b = normalizeDate(bDateStr).split('-');
  const da = new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2]));
  const db = new Date(Number(b[0]), Number(b[1]) - 1, Number(b[2]));
  return Math.round((db - da) / 86400000);
}

/**
 * 日付文字列と時刻文字列から Date を作る。カレンダー API と .ics の生成でのみ使う。
 *
 * 判定には使わないこと。本システムの時系列判定は文字列比較で行う（3.2）。
 * ここで生成した Date はスクリプトのタイムゾーンで解釈されるため、
 * appsscript.json の timeZone が Asia/Tokyo であることが前提になる。
 */
function toDate(dateStr, timeStr) {
  const d = normalizeDate(dateStr);
  const t = normalizeTime(timeStr);
  if (d === null || t === null) return null;
  const p = d.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]),
    Number(t.slice(0, 2)), Number(t.slice(3, 5)), 0);
}

/** 日付と時刻から、その瞬間を表す分単位の通し値を作る（比較用） */
function toAbsoluteMinutes(dateStr, timeStr) {
  return diffDays('1970-01-01', dateStr) * 1440 + timeToMinutes(timeStr);
}

/** 現在時刻の通し値 */
function nowAbsoluteMinutes() {
  return toAbsoluteMinutes(nowDateStr(), nowTimeStr());
}

// --- 判定 -----------------------------------------------------------------

/**
 * 2つの時間帯が重複するか。
 * 境界は重複としない。10:00-11:00 と 11:00-12:00 は連続して予約できる。
 * 参照: 技術仕様書 3.3
 */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** 時間帯 inner が 時間帯 outer に完全に収まるか */
function contains(outerStart, outerEnd, innerStart, innerEnd) {
  return outerStart <= innerStart && innerEnd <= outerEnd;
}

// --- postback との相互変換 -------------------------------------------------
// postback は区切り文字を持たない形式、シートは区切り文字を持つ形式を使う。
// 変換は必ずここを経由し、各所で個別に実装しないこと（システム要件2.7）。

/** 'YYYY-MM-DD' → 'yyyyMMdd' */
function dateToCompact(dateStr) {
  return normalizeDate(dateStr).replace(/-/g, '');
}

/** 'yyyyMMdd' → 'YYYY-MM-DD' */
function compactToDate(compact) {
  const s = String(compact).trim();
  if (!/^\d{8}$/.test(s)) return null;
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}

/** 'HH:mm' → 'HHmm' */
function timeToCompact(timeStr) {
  return normalizeTime(timeStr).replace(':', '');
}

/** 'HHmm' → 'HH:mm' */
function compactToTime(compact) {
  const s = String(compact).trim();
  if (!/^\d{4}$/.test(s)) return null;
  return normalizeTime(s.slice(0, 2) + ':' + s.slice(2, 4));
}
