/**
 * 管理者によるシート直接編集の取り込み
 *
 * インストーラブルトリガーの onEdit を使う。関数名を onEdit にしてはならない。
 * その名前は簡易トリガーとしても起動し、1回の編集で2回走るうえ、
 * 簡易トリガー側は認可が要る操作（メール送信・カレンダー・外部通信）を実行できない。
 *
 * Apps Script 自身の書き込みは onEdit を発火させないため、無限ループは構造的に起きない。
 * 逆に言えば、Bot 経由の予約ではこの関数は走らない。採番・検証・カレンダー同期・通知は、
 * 両方の経路から呼ばれる共通処理でなければならない（技術仕様書 5.1）。
 *
 * 参照: 技術仕様書 6章 / システム要件定義書 3.6
 */

/** 触られても何もしない列。管理者が警告を手で消したときの再処理を避けるため。 */
const SILENT_COLUMNS = ['警告', '作成日時', '更新日時'];

/** 触られたら警告する列。消えると同期先や履歴との対応を見失う。 */
const PROTECTED_COLUMNS = ['予約ID', 'カレンダーイベントID'];

/** これが揃うまで採番・同期・通知を行わない。1セルずつ入力される途中で走らせないため。 */
const REQUIRED_COLUMNS = ['日付', '開始時刻', '終了時刻', '部屋ID'];

/** 予約の実体を変える列。ここが編集されたときだけ予約者へ通知する。 */
const SUBSTANCE_COLUMNS = ['日付', '開始時刻', '終了時刻', '部屋ID', '状態'];

// ---------------------------------------------------------------------------
// トリガーの設定
// ---------------------------------------------------------------------------

/**
 * 編集トリガーを登録する。エディタから1回実行する。
 * 既存の同名トリガーは消してから作る。重複登録すると1回の編集で複数回走り、
 * 通知が二重に飛び、カレンダーにも重複した操作が入る。
 */
function setUpEditTrigger() {
  const removed = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'onReservationEdit';
  });
  removed.forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('onReservationEdit')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();

  const msg = '編集トリガーを登録しました。' +
    (removed.length ? '（既存の ' + removed.length + ' 件を削除して作り直しました）' : '');
  Logger.log(msg);
  return msg;
}

// ---------------------------------------------------------------------------
// 受信
// ---------------------------------------------------------------------------

function onReservationEdit(e) {
  try {
    handleSheetEdit(e);
  } catch (err) {
    Logger.log('シート編集の取り込みで例外: ' + (err && err.stack ? err.stack : err));
    try {
      notifyAdminError(loadContext(), 'シート編集',
        'シートの編集を取り込めませんでした。\n\n' + (err && err.stack ? err.stack : err));
    } catch (e2) {
      Logger.log('例外通知も失敗: ' + e2);
    }
  }
}

/**
 * 編集を取り込む本体。テストから直接呼べるよう、結果を配列で返す。
 * @return [{row, status, warnings, action}]
 */
function handleSheetEdit(e) {
  if (!e || !e.range) return [];
  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET.予約) return [];

  const ctx = loadContext();
  const table = ctx.tables.予約;

  const firstCol = e.range.getColumn();
  const editedCols = [];
  for (let c = firstCol; c < firstCol + e.range.getNumColumns(); c++) {
    const name = table.headers[c - 1];
    if (name) editedCols.push(name);
  }

  // 警告・作成日時・更新日時だけの編集なら何もしない
  if (editedCols.length && editedCols.every(function (c) { return SILENT_COLUMNS.indexOf(c) >= 0; })) {
    return [];
  }

  const firstRow = Math.max(e.range.getRow(), 2);   // ヘッダー行は対象外
  const lastRow = e.range.getRow() + e.range.getNumRows() - 1;

  const results = [];
  for (let row = firstRow; row <= lastRow; row++) {
    results.push(processEditedRow(ctx, row, editedCols, e));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 1行の処理（技術仕様書 6.2 の手順3以降）
// ---------------------------------------------------------------------------

function processEditedRow(ctx, row, editedCols, e) {
  const table = ctx.tables.予約;
  const raw = table.sheet.getRange(row, 1, 1, table.headers.length).getValues()[0];
  if (isBlankRow(raw)) return { row: row, status: 'blank', warnings: [] };

  const cell = {};
  table.headers.forEach(function (h, i) { if (h) cell[h] = raw[i]; });

  const warnings = [];
  const touched = editedCols.filter(function (c) { return PROTECTED_COLUMNS.indexOf(c) >= 0; });
  if (touched.length) {
    // ここで打ち切らない。まさに検知すべき入力ミスなので、警告を残して処理は続ける。
    warnings.push('システムが管理する列（' + touched.join('・') +
      '）が変更されました。予約IDは操作履歴との対応に、カレンダーイベントIDは共有カレンダーとの同期に使われます。');
  }

  // --- 手順3: 行の完成判定 -------------------------------------------------
  // これを省くと、1セル目を入れた時点で共有カレンダーにゴミ予定が作られ、
  // 日時が未確定のまま利用者へ通知メールが飛ぶ。どちらも取り消せない副作用である。
  const missing = REQUIRED_COLUMNS.filter(function (c) {
    return String(cell[c] === undefined ? '' : cell[c]).trim() === '';
  });
  if (missing.length) {
    warnings.push('入力途中です（' + missing.join('・') + ' が未入力）。' +
      'この4つが揃うまで、予約IDの採番・カレンダー同期・通知は行いません。');
    writeWarning(table, row, warnings.join(' / '));
    return { row: row, status: 'incomplete', warnings: warnings };
  }

  const date = normalizeDate(cell['日付']);
  const start = normalizeTime(cell['開始時刻']);
  const end = normalizeTime(cell['終了時刻']);
  if (date === null || start === null || end === null) {
    warnings.push('日付は YYYY-MM-DD、時刻は HH:mm（2桁ゼロ埋め）で入力してください。' +
      'この形式でないと、空き判定に反映されません。');
    writeWarning(table, row, warnings.join(' / '));
    return { row: row, status: 'invalid_format', warnings: warnings };
  }

  normalizeRowValues(table, row, cell, date, start, end);

  // --- 手順4: 採番 ---------------------------------------------------------
  const wasNew = String(cell['予約ID'] || '').trim() === '';
  const locked = withLock(function () {
    reloadReservations(ctx);
    let id = String(cell['予約ID'] || '').trim();

    if (!id) {
      // 管理者にID採番を求めてはならない（システム要件 3.6）
      id = generateReservationId(ctx.reservations.map(function (r) { return r.id; }), date);
      writeCell(table, row, '予約ID', id);
      if (String(cell['登録元'] || '').trim() === '') writeCell(table, row, '登録元', '管理者');
      if (String(cell['状態'] || '').trim() === '') writeCell(table, row, '状態', '確定');
      if (String(cell['作成日時'] || '').trim() === '') writeCell(table, row, '作成日時', nowStampStr());
      cell['予約ID'] = id;
      cell['登録元'] = cell['登録元'] || '管理者';
      cell['状態'] = cell['状態'] || '確定';
    }
    writeCell(table, row, '更新日時', nowStampStr());
    return { ok: true, id: id };
  });

  if (!locked.ok) {
    writeWarning(table, row, '混み合っていたため取り込めませんでした。もう一度セルを編集してください。');
    return { row: row, status: 'busy', warnings: ['busy'] };
  }

  const reservation = {
    id: locked.id,
    roomId: String(cell['部屋ID'] || '').trim(),
    roomName: String(cell['部屋名'] || '').trim(),
    date: date, start: start, end: end,
    headcount: Number(cell['人数']) || 0,
    title: String(cell['予約名'] || ''),
    userId: String(cell['予約者userId'] || '').trim(),
    userName: String(cell['予約者氏名'] || '').trim(),
    note: String(cell['備考'] || ''),
    status: String(cell['状態'] || '').trim() || '確定',
    source: String(cell['登録元'] || '').trim(),
    calendarEventId: String(cell['カレンダーイベントID'] || '').trim(),
    icsSequence: Number(cell['ics連番']) || 0,
    _row: row,
  };

  // --- 手順5: 検証 ---------------------------------------------------------
  // 編集の拒否も値の書き換えも行わない。管理者の判断を上書きしないこと。
  validateAdminRow(ctx, reservation).forEach(function (w) { warnings.push(w); });

  // --- 手順6〜8: 同期・通知・履歴 -------------------------------------------
  // 警告はここでは書かず finishWrite に渡す。カレンダー同期の失敗も同じ列に書くため、
  // 両方が書くと片方が消える。書き手を1つにまとめておく。
  const action = wasNew ? '作成' : (reservation.status === 'キャンセル' ? 'キャンセル' : '変更');

  // 備考の誤字を1文字直しただけで .ics の更新通知が飛ぶと、
  // 利用者のカレンダーに不要な更新が入り、送信上限も消費する（技術仕様書 6.3）。
  const notify = wasNew || editedCols.some(function (c) { return SUBSTANCE_COLUMNS.indexOf(c) >= 0; });

  finishWrite(ctx, action, reservation, null, adminActor(e), {
    notify: notify,
    warnings: warnings,
    description: describeAdminEdit(action, reservation, editedCols, e),
  });

  return {
    row: row, status: 'applied', warnings: warnings,
    action: action, notified: notify, id: reservation.id,
  };
}

// ---------------------------------------------------------------------------
// 検証（システム要件 3.6）
// ---------------------------------------------------------------------------

function validateAdminRow(ctx, r) {
  const out = [];

  if (r.start >= r.end) {
    out.push('終了時刻が開始時刻より前、または同じです。');
    return out;   // 以降の判定が意味を持たない
  }

  const room = ctx.rooms.filter(function (x) { return x.id === r.roomId; })[0];
  if (!room) {
    out.push('部屋ID「' + r.roomId + '」が部屋マスタにありません。');
    return out;
  }
  // 予約シートは部屋名を重複保持している。IDだけ直すと古い部屋名が表示され続ける。
  if (r.roomName !== room.name) {
    out.push('部屋名が部屋マスタと一致しません（マスタ: ' + room.name + ' / この行: ' +
      (r.roomName || '空欄') + '）。部屋を付け替えるときは部屋IDと部屋名の両方を書き換えてください。');
  }
  if (!room.active) {
    out.push(room.name + 'は無効（有効のチェックが外れている）です。');
  }
  if (r.headcount > 0 && room.capacity < r.headcount) {
    out.push(room.name + 'の定員は' + (room.capacity === Infinity ? 'なし' : room.capacity + '名') +
      'ですが、' + r.headcount + '名で登録されています。');
  }

  // キャンセル済みの行は、重なっていても問題にならない
  if (r.status === 'キャンセル') return out;

  const wd = weekdayOf(r.date);
  const bh = ctx.businessHours[wd];
  if (!bh || !bh.active) {
    out.push(r.date + '（' + wd + '）は休業日です。');
  } else if (!contains(bh.open, bh.close, r.start, r.end)) {
    out.push('営業時間（' + bh.open + '〜' + bh.close + '）の外です。');
  }
  if (!isRoomOpen(ctx, room, r.date, wd, r.start, r.end)) {
    out.push(room.name + 'の予約可能時間の外です（定例枠と重なっています）。');
  }
  if (isBlocked(ctx, room, r.date, r.start, r.end)) {
    out.push('臨時ブロックと重なっています。');
  }

  const conflict = ctx.reservations.filter(function (x) {
    return x.id !== r.id && x.status === '確定' && x.roomId === r.roomId && x.date === r.date
      && overlaps(r.start, r.end, x.start, x.end);
  })[0];
  if (conflict) {
    out.push('同じ部屋・同じ時間帯に別の予約があります（' + conflict.id + ' ' +
      conflict.start + '〜' + conflict.end + ' / ' + (conflict.userName || '予約者不明') + '）。');
  }

  return out;
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/**
 * 日付・時刻を正規化した文字列に書き戻す。
 *
 * 「値を書き換えない」という原則の例外だが、意味は一切変えていない。
 * 9:00 を 09:00 に、シートが勝手に変換した日付型を文字列に戻すだけである。
 *
 * 直さないと2つの形で壊れる。1桁の時刻は文字列比較の前提を崩して
 * 「予約できる部屋が0件」になり、日付型は「本日の予約」の QUERY が
 * 文字列比較のため常に空表示になる。どちらも例外が出ないため、
 * 管理者からは原因の分からない不具合にしか見えない。
 */
function normalizeRowValues(table, row, cell, date, start, end) {
  [['日付', date], ['開始時刻', start], ['終了時刻', end]].forEach(function (pair) {
    const name = pair[0];
    const normalized = pair[1];
    if (String(cell[name]) === normalized) return;
    writeCell(table, row, name, normalized);   // 書式の固定も writeCell が行う
    cell[name] = normalized;
  });
}

function adminActor(e) {
  try {
    return (e && e.user && e.user.getEmail && e.user.getEmail()) || '管理者';
  } catch (err) {
    return '管理者';
  }
}

/**
 * 差分の記録は best-effort とする。
 * onEdit のイベントから旧値を取れるのは単一セルの編集時だけで、
 * 貼り付けや行単位の編集では取得できない（技術仕様書 6.4）。
 */
function describeAdminEdit(action, r, editedCols, e) {
  const summary = r.date + ' ' + r.start + '-' + r.end + ' / ' + r.roomName +
    ' / ' + r.headcount + '名 / ' + r.title;

  if (action === '作成') return 'シートに直接追加: ' + summary;

  const single = editedCols.length === 1 && e && e.oldValue !== undefined;
  if (single) {
    const col = editedCols[0];
    return 'シートを直接編集: ' + col + ': ' + e.oldValue + ' → ' + (r[adminFieldOf(col)] !== undefined
      ? r[adminFieldOf(col)] : '');
  }
  return 'シートを直接編集: ' + editedCols.join('・') + '（旧値取得不可） → ' + summary;
}

function adminFieldOf(columnName) {
  const map = {
    '日付': 'date', '開始時刻': 'start', '終了時刻': 'end',
    '部屋ID': 'roomId', '部屋名': 'roomName', '人数': 'headcount',
    '予約名': 'title', '備考': 'note', '状態': 'status',
  };
  return map[columnName] || 'id';
}
