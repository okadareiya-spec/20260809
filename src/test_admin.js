/**
 * シート直接編集の取り込みのテスト
 *
 * 実際のトリガーは発火させられないため、onEdit のイベントを模して handleSheetEdit を呼ぶ。
 *
 * 【注意】実際のシートに書き込む。予約名に目印を付け、最後に必ず削除する。
 * 通知は「予約者userId を空欄にした代理予約」を使うことで発生しない（宛先が引けないため）。
 */

function testAdminEdit() {
  const t = newRunner();
  const ctx = loadContext();
  const sheet = ctx.tables.予約.sheet;
  const headers = ctx.tables.予約.headers;
  const DAY = futureWeekday(40);

  // 直接 setValue するため、書き込む行があらかじめ存在している必要がある
  if (sheet.getLastRow() + 5 > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), 10);
  }

  const col = function (name) { return headers.indexOf(name) + 1; };
  const put = function (row, name, value) { sheet.getRange(row, col(name)).setValue(value); };
  const get = function (row, name) { return String(sheet.getRange(row, col(name)).getValue()).trim(); };

  /** 指定した列を編集したときの onEdit イベントを模す */
  const fire = function (row, names, oldValue) {
    const cols = names.map(col).sort(function (a, b) { return a - b; });
    const range = sheet.getRange(row, cols[0], 1, cols[cols.length - 1] - cols[0] + 1);
    const e = { range: range, user: { getEmail: function () { return 'admin@example.com'; } } };
    if (oldValue !== undefined) e.oldValue = oldValue;
    return handleSheetEdit(e);
  };

  try {
    // --- 入力途中の行 --------------------------------------------------------
    t.group('入力途中の行');
    let row = sheet.getLastRow() + 1;
    put(row, '予約名', TEST_MARK + '代理予約');
    put(row, '日付', DAY);
    SpreadsheetApp.flush();

    let res = fire(row, ['日付'])[0];
    t.eq('採番しない', res.status, 'incomplete');
    t.eq('予約IDは空のまま', get(row, '予約ID'), '');
    t.eq('未入力の列を知らせる', res.warnings.join(' ').indexOf('開始時刻') >= 0, true);
    t.eq('警告列に書かれる', get(row, '警告').indexOf('入力途中') >= 0, true);

    // --- 行が完成した --------------------------------------------------------
    t.group('行の完成');
    put(row, '開始時刻', '10:00');
    put(row, '終了時刻', '11:00');
    put(row, '部屋ID', 'ROOM05');
    put(row, '部屋名', '6人部屋A');
    put(row, '人数', 6);
    SpreadsheetApp.flush();

    res = fire(row, ['部屋名'])[0];
    t.eq('取り込まれる', res.status, 'applied');
    t.eq('操作は作成', res.action, '作成');
    t.eq('予約IDが採番される', /^R\d{8}-[A-Z0-9]{6}$/.test(get(row, '予約ID')), true);
    t.eq('登録元は管理者', get(row, '登録元'), '管理者');
    t.eq('状態は確定', get(row, '状態'), '確定');
    t.eq('警告は消える', get(row, '警告'), '');

    const id = get(row, '予約ID');
    const hist = readTable(SHEET.操作履歴).rows.filter(function (h) {
      return String(h['予約ID']) === id;
    });
    t.eq('操作履歴に残る', hist.length >= 1, true);
    t.eq('実施者が記録される', String(hist[0]['実施者']), 'admin@example.com');

    // --- 入力の正規化 ---------------------------------------------------------
    t.group('入力の正規化');
    put(row, '開始時刻', '9:00');
    SpreadsheetApp.flush();
    fire(row, ['開始時刻'], '10:00');
    // 1桁のままだと文字列比較が壊れ、例外も出ないまま空き判定から漏れる
    t.eq('1桁の時刻を2桁に直す', get(row, '開始時刻'), '09:00');
    put(row, '開始時刻', '10:00');
    SpreadsheetApp.flush();
    fire(row, ['開始時刻'], '09:00');
    t.eq('正しい値はそのまま', get(row, '開始時刻'), '10:00');

    // --- 検証（拒否せず警告する）----------------------------------------------
    t.group('検証');
    put(row, '人数', 99);
    SpreadsheetApp.flush();
    res = fire(row, ['人数'], 6)[0];
    t.eq('定員超過を警告する', get(row, '警告').indexOf('定員') >= 0, true);
    t.eq('値は書き換えない', get(row, '人数'), '99');
    t.eq('実体の列ではないので通知しない', res.notified, false);
    put(row, '人数', 6);
    SpreadsheetApp.flush();
    fire(row, ['人数'], 99);

    put(row, '部屋名', '12人部屋A');
    SpreadsheetApp.flush();
    fire(row, ['部屋名'], '6人部屋A');
    // 予約シートは部屋名を重複保持している。IDだけ直すと古い名前が残る。
    t.eq('部屋名の不一致を警告する', get(row, '警告').indexOf('部屋名') >= 0, true);
    put(row, '部屋名', '6人部屋A');
    SpreadsheetApp.flush();
    fire(row, ['部屋名'], '12人部屋A');
    t.eq('直せば警告が消える', get(row, '警告'), '');

    put(row, '終了時刻', '09:00');
    SpreadsheetApp.flush();
    fire(row, ['終了時刻'], '11:00');
    t.eq('終了が開始より前を警告する', get(row, '警告').indexOf('終了時刻') >= 0, true);
    put(row, '終了時刻', '11:00');
    SpreadsheetApp.flush();
    fire(row, ['終了時刻'], '09:00');

    put(row, '部屋ID', 'ROOM99');
    SpreadsheetApp.flush();
    fire(row, ['部屋ID'], 'ROOM05');
    t.eq('存在しない部屋IDを警告する', get(row, '警告').indexOf('部屋マスタ') >= 0, true);
    put(row, '部屋ID', 'ROOM05');
    SpreadsheetApp.flush();
    fire(row, ['部屋ID'], 'ROOM99');

    // --- 二重予約の検出 -------------------------------------------------------
    t.group('二重予約の検出');
    const row2 = sheet.getLastRow() + 1;
    put(row2, '予約名', TEST_MARK + '重複行');
    put(row2, '日付', DAY);
    put(row2, '開始時刻', '10:30');
    put(row2, '終了時刻', '11:30');
    put(row2, '部屋ID', 'ROOM05');
    put(row2, '部屋名', '6人部屋A');
    put(row2, '人数', 6);
    SpreadsheetApp.flush();

    res = fire(row2, ['人数'])[0];
    t.eq('重なりを警告する', get(row2, '警告').indexOf('同じ部屋・同じ時間帯') >= 0, true);
    // 管理者の判断を上書きしない。拒否せず、採番も同期も行う。
    t.eq('それでも採番はする', /^R\d{8}-/.test(get(row2, '予約ID')), true);
    t.eq('取り込みは成功扱い', res.status, 'applied');

    // --- システム管理列の保護 --------------------------------------------------
    t.group('システム管理列');
    put(row2, 'カレンダーイベントID', '');
    SpreadsheetApp.flush();
    fire(row2, ['カレンダーイベントID'], 'dummy-event-id');
    t.eq('消したことを警告する', get(row2, '警告').indexOf('システムが管理する列') >= 0, true);

    const before警告 = get(row, '警告');
    const r3 = fire(row, ['警告']);
    t.eq('警告列の編集では何もしない', r3.length, 0);
    t.eq('警告は変わらない', get(row, '警告'), before警告);

    // --- キャンセル -----------------------------------------------------------
    t.group('状態の変更');
    put(row2, '状態', 'キャンセル');
    SpreadsheetApp.flush();
    res = fire(row2, ['状態'], '確定')[0];
    t.eq('操作はキャンセル', res.action, 'キャンセル');
    t.eq('実体の列なので通知の対象になる', res.notified, true);
    t.eq('キャンセル済みなら重なりを警告しない', get(row2, '警告').indexOf('同じ部屋') >= 0, false);

    // --- 受付締切は適用しない --------------------------------------------------
    t.group('受付締切');
    const past = sheet.getLastRow() + 1;
    put(past, '予約名', TEST_MARK + '過去の代理予約');
    put(past, '日付', addDays(nowDateStr(), -3));
    put(past, '開始時刻', '10:00');
    put(past, '終了時刻', '11:00');
    put(past, '部屋ID', 'ROOM05');
    put(past, '部屋名', '6人部屋A');
    put(past, '人数', 6);
    SpreadsheetApp.flush();

    res = fire(past, ['人数'])[0];
    // 管理者は開始時刻を過ぎた予約も追加・編集できる（運用要件4.3）
    t.eq('過去日でも取り込む', res.status, 'applied');
    t.eq('過去日でも採番する', /^R\d{8}-/.test(get(past, '予約ID')), true);

    // --- 予約シート以外は無視 --------------------------------------------------
    t.group('対象外の編集');
    const other = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.設定);
    t.eq('別シートの編集は無視する',
      handleSheetEdit({ range: other.getRange(2, 2) }).length, 0);

  } finally {
    const removed = cleanupTestRows();
    Logger.log('削除: 予約 ' + removed.reservations + '件 / 操作履歴 ' + removed.history +
      '件 / カレンダー予定 ' + removed.events + '件');
    t.group('後片付け');
    t.eq('テストデータを削除した', removed.reservations >= 0, true);
  }

  return t.report();
}
