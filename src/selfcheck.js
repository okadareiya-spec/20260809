/**
 * 自己診断
 *
 * シート構造と、共通基盤（lib_sheets / lib_datetime）の読み込み結果を検証する。
 * エディタから selfCheck() を実行し、ログの内容を確認する。
 * 実装を進める前に、ここが全て OK になっていること。
 */

function selfCheck() {
  const out = [];
  const fail = [];

  function ok(label, detail) { out.push('  OK   ' + label + (detail ? ' — ' + detail : '')); }
  function ng(label, detail) { out.push('  NG   ' + label + (detail ? ' — ' + detail : '')); fail.push(label); }

  out.push('=== 1. シートの存在 ===');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const expected = [
    'はじめに', '本日の予約', '予約', '部屋マスタ', '部屋別予約可能時間',
    '臨時ブロック', '営業時間', '設定', '利用者マスタ', '操作履歴',
  ];
  const actual = ss.getSheets().map(function (s) { return s.getName(); });
  expected.forEach(function (name) {
    if (actual.indexOf(name) >= 0) ok(name); else ng(name, '見つかりません');
  });
  const extra = actual.filter(function (n) { return expected.indexOf(n) < 0; });
  if (extra.length) out.push('  情報 想定外のシート: ' + extra.join(', '));

  out.push('');
  out.push('=== 2. タイムゾーン ===');
  // シート自身のタイムゾーンは appsscript.json の設定とは別物である。
  // ずれていると、シートが返す日付・時刻が時差分ずれ、TODAY() も別の日を指す。
  const ssTz = ss.getSpreadsheetTimeZone();
  if (ssTz === TIMEZONE) {
    ok('スプレッドシート', ssTz);
  } else {
    ng('スプレッドシート', ssTz + ' になっています（期待値 ' + TIMEZONE +
      '）。repairSheets() を実行してください');
  }

  out.push('');
  out.push('=== 3. 日付・時刻が文字列として保持されているか ===');
  // ここが Date 型になっていると、文字列比較による時系列判定が壊れる。
  // さらに「本日の予約」の QUERY は日付を文字列比較しているため、常に空表示になる。
  expected.forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet || name === 'はじめに' || name === '本日の予約') return;
    const lastCol = sheet.getLastColumn();
    if (lastCol < 1) return;

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const formats = sheet.getRange(2, 1, 1, lastCol).getNumberFormats()[0];
    const bad = [];
    headers.forEach(function (h, i) {
      if (isTextColumn(h) && formats[i] !== TEXT_FORMAT) bad.push(String(h).trim());
    });
    if (bad.length) {
      ng(name + ' の列書式', bad.join(' / ') + ' が「書式なしテキスト」ではありません。repairSheets() を実行してください');
    } else {
      ok(name + ' の列書式');
    }
  });

  // 実際に保存されている値の型も見る。書式が正しくても、書式を直す前に
  // 書き込まれた値は変換されたまま残るため、両方を確認する必要がある。
  const bh = ss.getSheetByName('営業時間');
  if (bh) {
    const raw = bh.getRange(2, 3).getValue();   // 月曜の開始時刻
    if (raw instanceof Date) {
      ng('営業時間 開始時刻の値', '時刻型で保存されています。repairSheets() を実行してください');
    } else if (String(raw) === '09:00') {
      ok('営業時間 開始時刻の値', '"09:00" として保持されています');
    } else {
      ng('営業時間 開始時刻の値', '想定と異なります: "' + String(raw) + '"（期待値 "09:00"）');
    }
  }

  out.push('');
  out.push('=== 4. 設定値の読み込み ===');
  let ctx;
  try {
    ctx = loadContext();
    ok('loadContext()', '例外なく完了');
  } catch (e) {
    ng('loadContext()', e.message);
    Logger.log(out.join('\n'));
    return out.join('\n');
  }

  const c = ctx.config;
  const expectCfg = {
    deadlineMinutes: 0, bookableDays: 60, slotMinutes: 30, minMinutes: 30, defaultHeadcount: 6,
  };
  Object.keys(expectCfg).forEach(function (k) {
    if (c[k] === expectCfg[k]) ok(k, String(c[k]));
    else ng(k, '読み取り値 ' + c[k] + '（期待値 ' + expectCfg[k] + '）');
  });
  // 受付締切 0 が「不正値」として弾かれていないことの確認
  if (c.deadlineMinutes === 0) ok('受付締切 0 の受理', '0 が正当な値として読めています');
  if (c.adminMails) ok('管理者通知先メール', c.adminMails); else ng('管理者通知先メール', '空です');

  out.push('');
  out.push('=== 5. 部屋マスタ ===');
  const active = ctx.rooms.filter(function (r) { return r.active; });
  if (active.length === 12) ok('有効な部屋数', '12室');
  else ng('有効な部屋数', active.length + '室（期待値 12）');

  const unlimited = ctx.rooms.filter(function (r) { return r.capacity === Infinity; });
  if (unlimited.length === 1) ok('定員なしの部屋', unlimited[0].name + '（制限なしとして読めています）');
  else ng('定員なしの部屋', unlimited.length + '件（期待値 1）');

  // おまかせ割当の並び順: 定員の昇順 → 表示順 → 部屋ID
  const sorted = active.slice().sort(function (a, b) {
    if (a.capacity !== b.capacity) return a.capacity - b.capacity;
    if (a.order !== b.order) return a.order - b.order;
    return a.id < b.id ? -1 : 1;
  });
  out.push('  情報 割当順: ' + sorted.map(function (r) {
    return r.name + '(' + (r.capacity === Infinity ? '∞' : r.capacity) + ')';
  }).join(' → '));
  if (sorted[sorted.length - 1].capacity === Infinity) {
    ok('大会議室の位置', '常に最後に選ばれます');
  } else {
    ng('大会議室の位置', '末尾になっていません');
  }

  out.push('');
  out.push('=== 6. 営業時間 ===');
  const mon = ctx.businessHours['月'];
  const sun = ctx.businessHours['日'];
  if (mon && mon.active && mon.open === '09:00' && mon.close === '18:00') ok('月曜', '09:00-18:00 稼働');
  else ng('月曜', JSON.stringify(mon));
  if (sun && !sun.active) ok('日曜', '非稼働');
  else ng('日曜', JSON.stringify(sun));

  out.push('');
  out.push('=== 7. 日付・時刻ユーティリティ ===');
  const cases = [
    ['normalizeTime("9:00")', normalizeTime('9:00'), '09:00'],
    ['normalizeTime("09:00")', normalizeTime('09:00'), '09:00'],
    ['normalizeTime("25:00")', normalizeTime('25:00'), null],
    ['文字列比較 "09:00" < "10:00"', '09:00' < '10:00', true],
    ['overlaps(10:00-11:00, 11:00-12:00)', overlaps('10:00', '11:00', '11:00', '12:00'), false],
    ['overlaps(10:00-12:00, 11:00-13:00)', overlaps('10:00', '12:00', '11:00', '13:00'), true],
    ['contains(09:00-18:00, 10:00-11:00)', contains('09:00', '18:00', '10:00', '11:00'), true],
    ['addMinutes("17:30", 30)', addMinutes('17:30', 30), '18:00'],
    ['weekdayOf("2026-08-09")', weekdayOf('2026-08-09'), '日'],
    ['compactToDate("20260810")', compactToDate('20260810'), '2026-08-10'],
    ['compactToTime("0900")', compactToTime('0900'), '09:00'],
  ];
  cases.forEach(function (t) {
    if (t[1] === t[2]) ok(t[0], String(t[1]));
    else ng(t[0], '結果 ' + String(t[1]) + '（期待値 ' + String(t[2]) + '）');
  });

  out.push('');
  out.push('=== 8. 読み込み行数（性能に直結） ===');
  ['設定', '営業時間', '部屋マスタ', '部屋別予約可能時間', '臨時ブロック', '予約', '利用者マスタ'].forEach(function (n) {
    const t = ctx.tables[n];
    if (!t) return;
    const rows = t.rows.length;
    const maxRows = t.sheet.getMaxRows();
    if (maxRows > 200) ng(n, 'シートが ' + maxRows + ' 行あります。repairSheets() を実行してください');
    else ok(n, '読み込み ' + rows + ' 行 / シート ' + maxRows + ' 行');
  });

  out.push('');
  out.push('=== 9. 収集された警告 ===');
  if (ctx.warnings.length === 0) {
    ok('警告', 'なし');
  } else {
    ctx.warnings.forEach(function (w) {
      const n = ctx.warnCounts[w];
      out.push('  警告 ' + w + (n > 1 ? '（同種 ' + n + ' 件）' : ''));
    });
  }

  out.push('');
  out.push(fail.length === 0
    ? '★ すべて通過しました。実装を進められます。'
    : '★ ' + fail.length + ' 件が失敗しています: ' + fail.join(' / '));

  const report = out.join('\n');
  Logger.log(report);
  return report;
}
