/**
 * 予約の書き込みと排他制御
 *
 * ここが本仕様で最も壊れやすい箇所である。
 * 空き判定と書き込みの両方を、必ずロックの内側で行うこと。
 * 判定だけをロックして書き込みを外に出すと排他が成立せず、二重予約が発生する。
 *
 * 参照: 技術仕様書 4章 / 5章
 */

const LOCK_WAIT_MS = 10000;

// ---------------------------------------------------------------------------
// 排他制御
// ---------------------------------------------------------------------------

/**
 * スクリプト単位の排他ロックを取り、その内側で fn を実行する。
 * ロックを取れなかった場合は busy を返す。呼び出し側は混雑を伝えて再試行を促す。
 */
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return { ok: false, reason: 'busy', message: '混み合っています。もう一度お試しください。' };
  }
  try {
    return fn();
  } finally {
    // 保留中の書き込みを確定させてからロックを手放す。
    // Apps Script はシートへの書き込みをまとめて遅延実行するため、
    // これを怠ると、次にロックを取った処理が書き込み前の内容を読む。
    // ロックを持っていても古い内容で判定することになり、排他が成立しない。
    try {
      SpreadsheetApp.flush();
    } catch (e) {
      Logger.log('flush に失敗: ' + e);
    }
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 予約IDの採番（技術仕様書 5.2）
// ---------------------------------------------------------------------------

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 紛らわしい I O 0 1 を除く

/**
 * 予約IDを採番する。形式は R + yyyyMMdd + '-' + 6桁。
 *
 * ランダム成分を含めるのは、書き込み経路が2つ（Bot と onEdit）あり、
 * onEdit 側はロックを取らないため。連番方式では同時採番で重複しうる。
 * また「最終行のIDを +1」する実装は、管理者がシートを並べ替えた瞬間に破綻する。
 * 先頭に日付を置くのは、管理者がIDを見て日付を判別できるようにするため。
 */
function generateReservationId(existingIds, dateStr) {
  const prefix = 'R' + dateToCompact(dateStr) + '-';
  for (let attempt = 0; attempt < 20; attempt++) {
    let suffix = '';
    for (let i = 0; i < 6; i++) {
      suffix += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
    }
    const id = prefix + suffix;
    if (existingIds.indexOf(id) < 0) return id;
  }
  throw new Error('予約IDを採番できませんでした');
}

// ---------------------------------------------------------------------------
// 予約の作成
// ---------------------------------------------------------------------------

/**
 * @param params.date/start/end/headcount
 * @param params.roomId    部屋ID、または 'AUTO'（おまかせ）
 * @param params.title     予約名。空なら「〈氏名〉の予約」を自動生成
 * @param params.note      備考
 * @param params.userId    LINE userId
 * @param params.userName  予約者氏名
 * @param params.source    'ユーザー' | '管理者'
 * @param params.skipWindow 受付締切を適用しない（管理者操作）
 */
function createReservation(ctx, params) {
  const result = withLock(function () {
    // ロックの内側で読み直す。待っている間に他のリクエストが書き込んでいる可能性がある。
    reloadReservations(ctx);

    const avail = findAvailableRooms(ctx, {
      date: params.date, start: params.start, end: params.end,
      headcount: params.headcount, skipWindow: params.skipWindow,
    });
    if (avail.rooms.length === 0) {
      return { ok: false, reason: avail.reason, message: avail.message };
    }

    let room;
    if (params.roomId === 'AUTO' || !params.roomId) {
      room = pickAutoRoom(avail.rooms);
    } else {
      room = avail.rooms.filter(function (r) { return r.id === params.roomId; })[0];
      if (!room) {
        return {
          ok: false, reason: 'room_taken',
          message: 'その部屋は空いていません。別の部屋を選んでください。',
        };
      }
    }

    const ids = ctx.reservations.map(function (r) { return r.id; });
    const id = generateReservationId(ids, params.date);
    const title = params.title || defaultTitle(params.userName);

    const row = {
      予約ID: id,
      部屋ID: room.id,
      部屋名: room.name,
      日付: params.date,
      開始時刻: params.start,
      終了時刻: params.end,
      人数: params.headcount,
      予約名: title,
      予約者userId: params.userId || '',
      予約者氏名: params.userName || '',
      備考: params.note || '',
      状態: '確定',
      登録元: params.source || 'ユーザー',
      作成日時: nowStampStr(),
      更新日時: nowStampStr(),
      カレンダーイベントID: '',
      ics連番: 0,
      警告: '',
    };
    const writtenRow = appendTableRow(ctx.tables.予約, row);

    return {
      ok: true,
      reservation: {
        id: id, roomId: room.id, roomName: room.name,
        date: params.date, start: params.start, end: params.end,
        headcount: params.headcount, title: title,
        userId: params.userId || '', userName: params.userName || '',
        note: params.note || '', status: '確定',
        source: row.登録元, calendarEventId: '', icsSequence: 0,
        _row: writtenRow,
      },
    };
  });

  if (!result.ok) return result;

  // ロックの外で行う。外部APIの応答時間をロック保持時間に含めないため。
  finishWrite(ctx, '作成', result.reservation, null, params.actor);
  return result;
}

// ---------------------------------------------------------------------------
// 予約の変更
// ---------------------------------------------------------------------------

/**
 * @param changes  { date, start, end, headcount, roomId, title, note } の一部
 */
function changeReservation(ctx, reservationId, changes, options) {
  const opt = options || {};

  const result = withLock(function () {
    reloadReservations(ctx);
    const before = findReservationById(ctx, reservationId);
    if (!before) return { ok: false, reason: 'not_found', message: 'その予約は見つかりませんでした。' };
    if (before.status !== '確定') {
      return { ok: false, reason: 'not_active', message: 'その予約は既にキャンセルされています。' };
    }
    if (opt.userId && before.userId !== opt.userId) {
      return { ok: false, reason: 'forbidden', message: '他の方の予約は変更できません。' };
    }

    const after = {
      date: changes.date || before.date,
      start: changes.start || before.start,
      end: changes.end || before.end,
      headcount: changes.headcount || before.headcount,
      roomId: changes.roomId || before.roomId,
    };

    // 受付締切は、変更前と変更後の両方の開始日時に対して判定する。
    // どちらか一方でも締切を過ぎていれば受け付けない。
    if (!opt.skipWindow) {
      const wBefore = checkBookingWindow(ctx, before.date, before.start);
      if (!wBefore.ok) {
        return { ok: false, reason: wBefore.reason, message: '変更前の' + wBefore.message };
      }
      const wAfter = checkBookingWindow(ctx, after.date, after.start);
      if (!wAfter.ok) {
        return { ok: false, reason: wAfter.reason, message: '変更後の' + wAfter.message };
      }
    }

    // 空き判定から自分自身を除外する。除外を忘れると延長が永久にできなくなる。
    const avail = findAvailableRooms(ctx, {
      date: after.date, start: after.start, end: after.end,
      headcount: after.headcount, excludeId: reservationId, skipWindow: true,
    });
    if (avail.rooms.length === 0) {
      return { ok: false, reason: avail.reason, message: avail.message };
    }

    let room;
    if (after.roomId === 'AUTO') {
      room = pickAutoRoom(avail.rooms);
    } else {
      room = avail.rooms.filter(function (r) { return r.id === after.roomId; })[0];
      if (!room) {
        // 人数を増やした結果、いまの部屋に収容できなくなった場合もここに来る
        const current = ctx.rooms.filter(function (r) { return r.id === after.roomId; })[0];
        if (current && current.capacity < after.headcount) {
          return {
            ok: false, reason: 'over_capacity',
            message: current.name + 'の定員は' + current.capacity + '名です。部屋を選び直してください。',
          };
        }
        return { ok: false, reason: 'room_taken', message: 'その部屋は空いていません。' };
      }
    }

    const table = ctx.tables.予約;
    const updates = {
      部屋ID: room.id,
      部屋名: room.name,
      日付: after.date,
      開始時刻: after.start,
      終了時刻: after.end,
      人数: after.headcount,
      更新日時: nowStampStr(),
    };
    if (changes.title !== undefined) updates['予約名'] = changes.title;
    if (changes.note !== undefined) updates['備考'] = changes.note;

    Object.keys(updates).forEach(function (col) {
      writeCell(table, before._row, col, updates[col]);
    });

    const updated = {};
    Object.keys(before).forEach(function (k) { updated[k] = before[k]; });
    updated.roomId = room.id; updated.roomName = room.name;
    updated.date = after.date; updated.start = after.start; updated.end = after.end;
    updated.headcount = after.headcount;
    if (changes.title !== undefined) updated.title = changes.title;
    if (changes.note !== undefined) updated.note = changes.note;

    return { ok: true, reservation: updated, before: before };
  });

  if (!result.ok) return result;
  finishWrite(ctx, '変更', result.reservation, result.before, opt.actor);
  return result;
}

// ---------------------------------------------------------------------------
// 予約のキャンセル
// ---------------------------------------------------------------------------

function cancelReservation(ctx, reservationId, options) {
  const opt = options || {};

  const result = withLock(function () {
    reloadReservations(ctx);
    const target = findReservationById(ctx, reservationId);
    if (!target) return { ok: false, reason: 'not_found', message: 'その予約は見つかりませんでした。' };
    if (target.status !== '確定') {
      return { ok: false, reason: 'not_active', message: 'その予約は既にキャンセルされています。' };
    }
    if (opt.userId && target.userId !== opt.userId) {
      return { ok: false, reason: 'forbidden', message: '他の方の予約はキャンセルできません。' };
    }

    // キャンセルにも受付締切を適用する。
    // 空き判定は呼ばれない経路なので、ここで明示的に判定する必要がある。
    if (!opt.skipWindow) {
      const w = checkBookingWindow(ctx, target.date, target.start);
      if (!w.ok) return { ok: false, reason: w.reason, message: w.message };
    }

    const table = ctx.tables.予約;
    writeCell(table, target._row, '状態', 'キャンセル');
    writeCell(table, target._row, '更新日時', nowStampStr());

    const cancelled = {};
    Object.keys(target).forEach(function (k) { cancelled[k] = target[k]; });
    cancelled.status = 'キャンセル';

    return { ok: true, reservation: cancelled, before: target };
  });

  if (!result.ok) return result;
  finishWrite(ctx, 'キャンセル', result.reservation, result.before, opt.actor);
  return result;
}

// ---------------------------------------------------------------------------
// 書き込み後の共通処理（技術仕様書 5.1 / 5.3）
// ---------------------------------------------------------------------------

/**
 * 予約を書き込んだ後に必ず通る処理。
 *
 * Bot 経路と onEdit 経路の両方から呼ばれる共通処理とすること。
 * Apps Script による書き込みは onEdit を発火させないため、
 * onEdit 側にだけ実装すると、ユーザー経由の予約で履歴もカレンダーも通知も走らない。
 *
 * カレンダー同期と通知はロックの外で行う。失敗しても予約は成立させる。
 */
function finishWrite(ctx, action, reservation, before, actor, options) {
  const opt = options || {};

  try {
    logOperation(ctx, action, reservation, before, actor, opt.description);
  } catch (e) {
    Logger.log('操作履歴の記録に失敗: ' + e);
    notifyAdminError(ctx, '操作履歴', '予約 ' + reservation.id + ' の操作履歴を記録できませんでした。\n' + e);
  }

  // 同期の失敗は予約の成立に影響させない。イベントIDが空欄の行が
  // 「未同期」を意味するので、警告列と併せて管理者が気づける状態にする。
  const warnings = (opt.warnings || []).slice();
  try {
    syncCalendarForReservation(ctx, action, reservation);
  } catch (e) {
    Logger.log('カレンダー同期に失敗: ' + e);
    warnings.push('カレンダー同期に失敗しました: ' + e);
    notifyAdminError(ctx, 'カレンダー同期',
      '予約 ' + reservation.id + ' を共有カレンダーへ反映できませんでした。\n' +
      'この予約はカレンダーに載っていません。\n' + e);
  }

  // 警告列へ書くのはここだけにする。呼び出し側と finishWrite の両方が書くと、
  // あとから書いた側が相手の警告を消す。呼び出し側の警告は options.warnings で渡す。
  if (reservation._row) {
    if (warnings.length) {
      writeWarning(ctx.tables.予約, reservation._row, warnings.join(' / '));
    } else {
      clearWarning(ctx.tables.予約, reservation._row);
    }
  }

  // 通知の失敗も予約の成立に影響させない。送信上限に達した場合もここに来る。
  // シート直接編集では、備考の誤字を直しただけで通知が飛ばないよう、
  // 呼び出し側が notify:false を指定できるようにしてある（技術仕様書 6.3）。
  if (opt.notify === false) return;
  try {
    notifyReservation(ctx, action, reservation, before);
  } catch (e) {
    Logger.log('通知に失敗: ' + e);
    notifyAdminError(ctx, '通知',
      '予約 ' + reservation.id + ' の通知メールを送信できませんでした。\n' +
      '送信上限に達している可能性があります。\n' + e);
  }
}

function logOperation(ctx, action, reservation, before, actor, description) {
  const table = ctx.tables.操作履歴 || readTable(SHEET.操作履歴);
  ctx.tables.操作履歴 = table;

  appendTableRow(table, {
    日時: nowStampStr(),
    実施者: actor || reservation.userId || '',
    操作: action,
    予約ID: reservation.id,
    // シート直接編集では旧値を取得できない場合があるため、呼び出し側が文面を渡せる
    内容: description || describeChange(action, reservation, before),
  });
}

function describeChange(action, after, before) {
  if (action !== '変更' || !before) {
    return after.date + ' ' + after.start + '-' + after.end + ' / ' + after.roomName +
      ' / ' + after.headcount + '名 / ' + after.title;
  }
  const diffs = [];
  [['日付', 'date'], ['開始', 'start'], ['終了', 'end'],
   ['部屋', 'roomName'], ['人数', 'headcount'], ['予約名', 'title'], ['備考', 'note']]
    .forEach(function (pair) {
      const label = pair[0], key = pair[1];
      if (String(before[key]) !== String(after[key])) {
        diffs.push(label + ': ' + before[key] + ' → ' + after[key]);
      }
    });
  return diffs.length ? diffs.join(' / ') : '変更なし';
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

function findReservationById(ctx, id) {
  for (let i = 0; i < ctx.reservations.length; i++) {
    if (ctx.reservations[i].id === id) return ctx.reservations[i];
  }
  return null;
}

/** 予約名が未入力のときの自動生成。氏名の第2のコピーになる点に注意（氏名変更時は追随が必要）。 */
function defaultTitle(userName) {
  return (userName || '名称未設定') + 'の予約';
}

/** ある予約名が、指定した氏名から自動生成された値かどうか */
function isGeneratedTitle(title, userName) {
  return title === defaultTitle(userName);
}
