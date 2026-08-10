/**
 * 書き込み反映の診断
 *
 * testReservation で「同じ部屋・同じ時間が二重に取れる」現象が出た場合、
 * 原因の候補は2つある。どちらかを特定するための関数。
 *
 *   候補A: 追記した行が、直後の読み直しでまだ見えない（書き込みの確定待ち）
 *   候補B: 行は見えているが、日付・時刻の値が解釈できず readReservations が捨てている
 *
 * 候補Aなら flush 前後で件数が変わる。候補Bなら生の値の型が文字列になっていない。
 * エディタから diagnoseWrite() を実行し、ログを確認する。
 */

const DIAG_MARK = '__DIAG__';

function diagnoseWrite() {
  const out = [];
  const table = readTable(SHEET.予約);
  const day = futureWeekday(45);

  function countMarked() {
    return readTable(SHEET.予約).rows.filter(function (r) {
      return String(r['予約名']).indexOf(DIAG_MARK) >= 0;
    }).length;
  }

  try {
    out.push('=== 1. 追記直後に読み直して見えるか ===');
    out.push('開始時の getLastRow: ' + table.sheet.getLastRow());

    for (let i = 1; i <= 3; i++) {
      const row = {
        予約ID: 'D' + dateToCompact(day) + '-' + i,
        部屋ID: 'ROOM05', 部屋名: '6人部屋A', 日付: day,
        開始時刻: '14:00', 終了時刻: '15:00', 人数: 6,
        予約名: DIAG_MARK + i, 予約者userId: 'U_DIAG', 予約者氏名: '診断',
        備考: '', 状態: '確定', 登録元: 'ユーザー',
        作成日時: nowStampStr(), 更新日時: nowStampStr(),
        カレンダーイベントID: '', ics連番: 0, 警告: '',
      };
      // 本番と同じ書き込み経路を使う。ここを生の appendRow に置き換えると、
      // 書式が固定されず、日付・時刻が変換されて保存される。
      const written = appendTableRow(table, row);
      out.push(i + '件目: 行' + written + ' に書き込み / 読み直して見えた件数 ' +
        countMarked() + '（期待 ' + i + '）');
    }

    out.push('');
    out.push('=== 2. 保存された生の値と型 ===');
    // 文字列でなく Date で保存されていると、列の書式が「書式なしテキスト」に
    // なっていないことを意味する（システム要件3.2に反する）
    readTable(SHEET.予約).rows
      .filter(function (r) { return String(r['予約名']).indexOf(DIAG_MARK) >= 0; })
      .forEach(function (r) {
        out.push(
          '  行' + r._row + ' ' + r['予約ID'] +
          ' / 日付=' + describeValue(r['日付']) +
          ' 開始=' + describeValue(r['開始時刻']) +
          ' 終了=' + describeValue(r['終了時刻']) +
          ' 部屋ID=' + describeValue(r['部屋ID']) +
          ' 状態=' + describeValue(r['状態'])
        );
      });

    out.push('');
    out.push('=== 3. readReservations が解釈できたか ===');
    const ctx = loadContext();
    const parsed = ctx.reservations.filter(function (r) { return r.userId === 'U_DIAG'; });
    out.push('解釈できた件数: ' + parsed.length + '（期待 3）');
    parsed.forEach(function (r) {
      out.push('  ' + r.id + ' ' + r.date + ' ' + r.start + '-' + r.end +
        ' / ' + r.roomId + ' / ' + r.status);
    });

    out.push('');
    out.push('=== 4. 空き判定が重複を検出できるか ===');
    const avail = findAvailableRooms(ctx, {
      date: day, start: '14:00', end: '15:00', headcount: 6,
    });
    const ids = avail.rooms.map(function (r) { return r.id; });
    out.push('この時間に空いている部屋: ' + (ids.length ? ids.join(', ') : 'なし'));
    out.push(ids.indexOf('ROOM05') >= 0
      ? '  NG   ROOM05 が空きと判定されています。重複を検出できていません。'
      : '  OK   ROOM05 は埋まっていると判定されています。');

  } finally {
    const removed = cleanupDiagRows();
    out.push('');
    out.push('後片付け: ' + removed + ' 行を削除しました。');
  }

  const report = out.join('\n');
  Logger.log(report);
  return report;
}

function describeValue(v) {
  const type = (v instanceof Date) ? 'Date' : typeof v;
  return JSON.stringify(String(v)) + '(' + type + ')';
}

function cleanupDiagRows() {
  const table = readTable(SHEET.予約);
  const rows = table.rows.filter(function (r) {
    return String(r['予約名']).indexOf(DIAG_MARK) >= 0;
  }).map(function (r) { return r._row; });

  rows.slice().sort(function (a, b) { return b - a; })
    .forEach(function (row) { table.sheet.deleteRow(row); });
  SpreadsheetApp.flush();
  return rows.length;
}
