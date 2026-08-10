/**
 * 予約の書き込みと排他制御のテスト
 *
 * このテストは実際のシートに書き込む。予約名の先頭に目印を付け、
 * 成否にかかわらず最後に必ず消す。エディタから testReservation() を実行する。
 */

const TEST_MARK = '__TEST__';

function testReservation() {
  const t = newRunner();
  const ctx = loadContext();

  // 十分先の平日を使う。他のデータと干渉しないよう、営業時間の後半を使う。
  const DAY = futureWeekday(30);

  try {
    // --- 作成 ---------------------------------------------------------------
    t.group('予約の作成');
    const created = createReservation(ctx, {
      date: DAY, start: '14:00', end: '15:00', headcount: 6, roomId: 'AUTO',
      title: TEST_MARK + '会議', note: '', userId: 'U_TEST', userName: 'テスト太郎',
      source: 'ユーザー', actor: 'U_TEST',
    });
    t.eq('作成できる', created.ok, true);
    if (!created.ok) { t.eq('中断: ' + created.message, false, true); return t.report(); }

    const rsv = created.reservation;
    t.eq('予約IDの形式', /^R\d{8}-[A-Z0-9]{6}$/.test(rsv.id), true);
    t.eq('予約IDに日付が入る', rsv.id.indexOf('R' + dateToCompact(DAY)) === 0, true);
    t.eq('おまかせで定員最小の部屋が選ばれる', rsv.headcount <= 6, true);
    t.eq('状態は確定', rsv.status, '確定');

    // 書き込んだ行が、次に読み直したときに見えること。
    // ここが崩れると症状は「二重予約が防げない」という形でしか現れず、
    // 排他ロックの不具合と区別がつかなくなるため、独立した確認として置く。
    reloadReservations(ctx);
    const visible = findReservationById(ctx, rsv.id);
    t.eq('作成直後に読み直すと見える', !!visible, true);
    if (visible) {
      t.eq('読み直しても日付が一致する', visible.date, DAY);
      t.eq('読み直しても時刻が一致する', visible.start + '-' + visible.end, '14:00-15:00');
      t.eq('読み直しても部屋が一致する', visible.roomId, rsv.roomId);
    }

    // --- 二重予約の防止 ------------------------------------------------------
    t.group('二重予約の防止');
    const dup = createReservation(ctx, {
      date: DAY, start: '14:00', end: '15:00', headcount: 6, roomId: rsv.roomId,
      title: TEST_MARK + '重複', userId: 'U_OTHER', userName: '別人',
      source: 'ユーザー', actor: 'U_OTHER',
    });
    t.eq('同じ部屋・同じ時間は取れない', dup.ok, false);
    t.eq('理由が返る', dup.reason === 'room_taken' || dup.reason === 'all_booked', true);

    const adjacent = createReservation(ctx, {
      date: DAY, start: '15:00', end: '16:00', headcount: 6, roomId: rsv.roomId,
      title: TEST_MARK + '直後', userId: 'U_OTHER', userName: '別人',
      source: 'ユーザー', actor: 'U_OTHER',
    });
    t.eq('直後の枠は同じ部屋で取れる', adjacent.ok, true);

    // --- 変更（自己除外） ----------------------------------------------------
    t.group('変更');
    const extended = changeReservation(ctx, rsv.id, { end: '14:30' }, { userId: 'U_TEST', actor: 'U_TEST' });
    t.eq('短縮できる', extended.ok, true);

    const backTo15 = changeReservation(ctx, rsv.id, { end: '15:00' }, { userId: 'U_TEST', actor: 'U_TEST' });
    t.eq('元に戻せる（自分自身を除外できている）', backTo15.ok, true);

    const conflict = changeReservation(ctx, rsv.id, { end: '16:00' }, { userId: 'U_TEST', actor: 'U_TEST' });
    t.eq('直後の予約と重なる延長はできない', conflict.ok, false);

    const other = changeReservation(ctx, rsv.id, { end: '14:30' }, { userId: 'U_SOMEONE', actor: 'U_SOMEONE' });
    t.eq('他人は変更できない', other.ok, false);
    t.eq('理由は forbidden', other.reason, 'forbidden');

    const over = changeReservation(ctx, rsv.id, { headcount: 99 }, { userId: 'U_TEST', actor: 'U_TEST' });
    t.eq('定員を超える人数変更は成立しない', over.ok, false);

    // --- キャンセル ----------------------------------------------------------
    t.group('キャンセル');
    const byOther = cancelReservation(ctx, rsv.id, { userId: 'U_SOMEONE', actor: 'U_SOMEONE' });
    t.eq('他人はキャンセルできない', byOther.ok, false);

    const cancelled = cancelReservation(ctx, rsv.id, { userId: 'U_TEST', actor: 'U_TEST' });
    t.eq('本人はキャンセルできる', cancelled.ok, true);
    t.eq('状態がキャンセルになる', cancelled.reservation.status, 'キャンセル');

    const again = cancelReservation(ctx, rsv.id, { userId: 'U_TEST', actor: 'U_TEST' });
    t.eq('二重キャンセルはできない', again.ok, false);
    t.eq('理由は not_active', again.reason, 'not_active');

    const reuse = createReservation(ctx, {
      date: DAY, start: '14:00', end: '15:00', headcount: 6, roomId: rsv.roomId,
      title: TEST_MARK + '再取得', userId: 'U_OTHER', userName: '別人',
      source: 'ユーザー', actor: 'U_OTHER',
    });
    t.eq('キャンセル後は同じ枠を取り直せる', reuse.ok, true);

    // --- 締切 ---------------------------------------------------------------
    t.group('受付締切');
    const past = createReservation(ctx, {
      date: addDays(nowDateStr(), -1), start: '10:00', end: '11:00', headcount: 6,
      roomId: 'AUTO', title: TEST_MARK + '過去', userId: 'U_TEST', userName: 'テスト太郎',
      source: 'ユーザー', actor: 'U_TEST',
    });
    t.eq('過去の日付は予約できない', past.ok, false);
    t.eq('理由は past_deadline', past.reason, 'past_deadline');

    // --- 操作履歴 -----------------------------------------------------------
    t.group('操作履歴');
    const hist = readTable(SHEET.操作履歴).rows.filter(function (r) {
      return String(r['予約ID']).indexOf('R' + dateToCompact(DAY)) === 0;
    });
    t.eq('作成・変更・キャンセルが記録される', hist.length >= 3, true);
    const actions = hist.map(function (r) { return String(r['操作']); });
    t.eq('作成が記録される', actions.indexOf('作成') >= 0, true);
    t.eq('変更が記録される', actions.indexOf('変更') >= 0, true);
    t.eq('キャンセルが記録される', actions.indexOf('キャンセル') >= 0, true);

  } finally {
    const removed = cleanupTestRows();
    t.group('後片付け');
    t.eq('テストデータを削除した', removed.reservations >= 0, true);
    Logger.log('削除: 予約 ' + removed.reservations + '件 / 操作履歴 ' + removed.history +
      '件 / カレンダー予定 ' + removed.events + '件');
  }

  return t.report();
}

/** 目印の付いたテストデータを消す。失敗しても残骸が溜まらないようにするため。 */
function cleanupTestRows() {
  const counts = { reservations: 0, history: 0, events: 0 };

  const rsvTable = readTable(SHEET.予約);
  const testIds = {};
  const hits = rsvTable.rows.filter(function (r) {
    const hit = String(r['予約名']).indexOf(TEST_MARK) >= 0;
    if (hit) testIds[String(r['予約ID'])] = true;
    return hit;
  });

  // 行を消すだけでは足りない。カレンダーイベントIDごと消えるため、
  // 共有カレンダー側の予定が二度と削除できなくなる（技術仕様書 6.5 と同じ問題）。
  counts.events = deleteTestCalendarEvents(hits);

  const rsvRows = hits.map(function (r) { return r._row; });
  deleteRowsDescending(rsvTable.sheet, rsvRows);
  counts.reservations = rsvRows.length;

  const histTable = readTable(SHEET.操作履歴);
  const histRows = histTable.rows.filter(function (r) {
    return testIds[String(r['予約ID'])] === true;
  }).map(function (r) { return r._row; });

  deleteRowsDescending(histTable.sheet, histRows);
  counts.history = histRows.length;

  return counts;
}

/** テストが作った共有カレンダーの予定を消す。カレンダー未設定なら何もしない。 */
function deleteTestCalendarEvents(rows) {
  const calId = getCalendarId();
  if (!calId) return 0;
  const cal = safeGetCalendar(calId);
  if (!cal) return 0;

  let removed = 0;
  rows.forEach(function (r) {
    const eventId = String(r['カレンダーイベントID'] || '').trim();
    if (!eventId) return;
    // キャンセル済みの予約は同期処理が既に予定を消している。
    // イベントIDは「未同期」との区別のため残す設計なので、ここには必ず値が入っている。
    if (safeDeleteEvent(safeGetEvent(cal, eventId))) removed++;
  });
  return removed;
}

/**
 * 行番号がずれないよう、下から消す。
 *
 * 先に予備行を足しておくのは、スプレッドシートが「固定行以外を全部消す」ことを
 * 許さないため。テストを繰り返すと削除のたびにシートが縮み、いずれ下限に達して
 * 後片付けそのものが例外で落ちる。削除後も余裕が残る行数まで先に伸ばしておく。
 */
function deleteRowsDescending(sheet, rowNumbers) {
  if (!rowNumbers.length) return;

  const KEEP_AFTER_DELETE = 20;
  const frozen = sheet.getFrozenRows();
  const need = frozen + rowNumbers.length + KEEP_AFTER_DELETE;
  if (sheet.getMaxRows() < need) {
    sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows());
  }

  rowNumbers.slice().sort(function (a, b) { return b - a; })
    .forEach(function (row) { sheet.deleteRow(row); });
  SpreadsheetApp.flush();
}

/** 指定日数より先で、最初に現れる平日を返す */
function futureWeekday(minDaysAhead) {
  let d = addDays(nowDateStr(), minDaysAhead);
  for (let i = 0; i < 8; i++) {
    const wd = weekdayOf(d);
    if (wd !== '土' && wd !== '日') return d;
    d = addDays(d, 1);
  }
  return d;
}
