/**
 * シートアクセスの共通基盤
 *
 * 最重要の性能要件: 1リクエスト内で各シートの読み込みは1回まで。
 * 開始時刻の一覧は最大18個の時刻を判定するため、時刻ごとにシートを読み直すと
 * 1リクエストで100回近いアクセスが発生し、Webhook のタイムアウトと
 * reply token の失効を招く。必ず loadContext() で一括読み込みし、
 * 以降はメモリ上のデータだけで判定すること。
 *
 * 参照: システム要件定義書 4.1 / 技術仕様書 3.1
 */

const SHEET = {
  予約: '予約',
  部屋マスタ: '部屋マスタ',
  部屋別予約可能時間: '部屋別予約可能時間',
  臨時ブロック: '臨時ブロック',
  営業時間: '営業時間',
  利用者マスタ: '利用者マスタ',
  操作履歴: '操作履歴',
  設定: '設定',
};

/** 「書式なしテキスト」を表す書式コード */
const TEXT_FORMAT = '@';

/**
 * 文字列として保持しなければならない列（システム要件3.2）。
 *
 * 列の書式が既定のままだと、"09:00" を書き込んだ時点でシートが時刻値に変換する。
 * 読み戻すと Date になり、スプレッドシートのタイムゾーン分ずれた時刻で判定が走る。
 * 例外は出ず「予約可能な部屋が0件」や「二重予約が通る」という形でしか現れない。
 *
 * さらに「本日の予約」シートの QUERY は日付を文字列として比較しているため、
 * 日付列が日付型になると、その日の予約があっても常に空表示になる。
 *
 * 列名はシート間で共通なので、名前だけで判定できる。
 */
const TEXT_COLUMNS = ['日付', '開始時刻', '終了時刻', '日時', '作成日時', '更新日時'];

function isTextColumn(headerName) {
  return TEXT_COLUMNS.indexOf(String(headerName).trim()) >= 0;
}

/** 設定シートの項目名と既定値。項目名は完全一致で探す（システム要件3.5）。 */
const CONFIG_SPEC = {
  '受付締切（分前）': { key: 'deadlineMinutes', def: 0, min: 0 },
  '予約可能日数': { key: 'bookableDays', def: 60, min: 1 },
  '時間の刻み（分）': { key: 'slotMinutes', def: 30, min: 1 },
  '最短予約時間（分）': { key: 'minMinutes', def: 30, min: 1 },
  '人数の初期値': { key: 'defaultHeadcount', def: 6, min: 1 },
  '管理者通知先メール': { key: 'adminMails', def: '', min: null },
};

// ---------------------------------------------------------------------------
// テーブル読み込み
// ---------------------------------------------------------------------------

/**
 * シートを1回だけ読み、ヘッダー名でアクセスできる形にして返す。
 *
 * 列の解決はヘッダー名で行い、列インデックスを直書きしない。
 * 管理者がシートに列を挿入する可能性があるため（直接編集を許可する設計）。
 */
function readTable(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('シートが見つかりません: ' + sheetName);
  }
  const values = sheet.getDataRange().getValues();
  if (values.length === 0) {
    return { sheet: sheet, headers: [], index: {}, rows: [] };
  }

  const headers = values[0].map(function (h) { return String(h).trim(); });
  const index = {};
  headers.forEach(function (h, i) { if (h !== '') index[h] = i; });

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    if (isBlankRow(raw)) continue;

    const obj = { _row: i + 1, _raw: raw };
    headers.forEach(function (h, c) { if (h !== '') obj[h] = raw[c]; });
    rows.push(obj);
  }
  return { sheet: sheet, headers: headers, index: index, rows: rows };
}

/**
 * 実質的に空の行か。
 *
 * false を空とみなす点が重要。チェックボックスを挿入したセルは値が false になり、
 * 単純な空文字判定では「データのある行」と誤認される。
 * その結果、未使用の数百行が読み込まれ、警告が大量に発生し、性能も落ちる。
 * 実データの行には必ず文字列か数値が入るため、false を空扱いしても取りこぼさない。
 */
function isBlankRow(raw) {
  return raw.every(function (v) {
    return v === '' || v === null || v === undefined || v === false;
  });
}

/** テーブルの1セルを書き換える。書き込みは必要最小限にとどめること。 */
function writeCell(table, row, headerName, value) {
  const col = table.index[headerName];
  if (col === undefined) return;
  const cell = table.sheet.getRange(row, col + 1);
  // 書式を先に固定してから値を入れる。逆順だと変換された後になり、手遅れになる。
  if (isTextColumn(headerName)) cell.setNumberFormat(TEXT_FORMAT);
  cell.setValue(value);
}

/**
 * ヘッダー名で位置を解決して1行追記し、書き込んだ行番号を返す。列の並び順に依存しない。
 *
 * 書式の固定を「初期構築時に予備行へまとめてかける」方式にしてはならない。
 * 予備行を使い切った後に追加される行には書式が付かず、そこから静かに壊れ始める。
 * 書き込む行ごとに、値を入れる直前に固定する。
 *
 * 追記後に flush するのは、確定前に getLastRow() を呼ぶと追記前の行番号が返り、
 * 以後その行への書き込みが1行上の予約を書き換えてしまうため。
 */
function appendTableRow(table, obj) {
  const sheet = table.sheet;
  const row = sheet.getLastRow() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);

  const width = table.headers.length;
  const range = sheet.getRange(row, 1, 1, width);

  const current = range.getNumberFormats()[0];
  range.setNumberFormats([table.headers.map(function (h, i) {
    return isTextColumn(h) ? TEXT_FORMAT : current[i];
  })]);

  range.setValues([table.headers.map(function (h) {
    return obj[h] === undefined ? '' : obj[h];
  })]);

  SpreadsheetApp.flush();
  return row;
}

/** 警告列に内容を書く。既に同じ内容が入っていれば書かない（無駄な書き込みを避ける）。 */
function writeWarning(table, row, message) {
  const col = table.index['警告'];
  if (col === undefined) return;
  const cell = table.sheet.getRange(row, col + 1);
  if (String(cell.getValue()) === String(message)) return;
  cell.setValue(message);
}

function clearWarning(table, row) {
  writeWarning(table, row, '');
}

// ---------------------------------------------------------------------------
// 一括読み込み
// ---------------------------------------------------------------------------

/**
 * 1リクエストにつき1回だけ呼ぶ。以降の判定はこの戻り値だけで行う。
 * 時刻・日付はここで正規化し、不正な値は警告として記録する。
 */
function loadContext() {
  const seen = {};
  const ctx = {
    tables: {},
    warnings: [],
    // 同じ内容の警告を何度も積まない。1行ずつ警告を出す処理があるため、
    // 重複を許すと数百件に膨れてログが読めなくなる。
    warn: function (message) {
      if (seen[message]) { seen[message]++; return; }
      seen[message] = 1;
      this.warnings.push(message);
    },
    warnCounts: seen,
  };

  ctx.tables.設定 = readTable(SHEET.設定);
  ctx.config = readConfig(ctx.tables.設定, ctx);

  ctx.tables.営業時間 = readTable(SHEET.営業時間);
  ctx.businessHours = readBusinessHours(ctx.tables.営業時間, ctx);

  ctx.tables.部屋マスタ = readTable(SHEET.部屋マスタ);
  ctx.rooms = readRooms(ctx.tables.部屋マスタ, ctx);

  ctx.tables.部屋別予約可能時間 = readTable(SHEET.部屋別予約可能時間);
  ctx.roomHours = readRoomHours(ctx.tables.部屋別予約可能時間, ctx);

  ctx.tables.臨時ブロック = readTable(SHEET.臨時ブロック);
  ctx.blocks = readBlocks(ctx.tables.臨時ブロック, ctx);

  ctx.tables.予約 = readTable(SHEET.予約);
  ctx.reservations = readReservations(ctx.tables.予約, ctx);

  ctx.tables.利用者マスタ = readTable(SHEET.利用者マスタ);
  ctx.users = readUsers(ctx.tables.利用者マスタ);

  return ctx;
}

/** 予約シートだけを読み直す。ロックの内側で最新状態を取り直すために使う（技術仕様書4章）。 */
function reloadReservations(ctx) {
  ctx.tables.予約 = readTable(SHEET.予約);
  ctx.reservations = readReservations(ctx.tables.予約, ctx);
  return ctx.reservations;
}

// ---------------------------------------------------------------------------
// 各シートの解釈
// ---------------------------------------------------------------------------

/**
 * 設定値を読む。
 *
 * 「不正」の基準は項目ごとに異なる。共通のバリデータで一律に判定してはならない。
 * 受付締切の 0 は正当な値であり、これを不正として弾くと直前予約が全面的に拒否される。
 * 参照: 技術仕様書 10.1
 */
function readConfig(table, ctx) {
  const found = {};
  const config = {};

  table.rows.forEach(function (row) {
    const name = String(row['項目'] || '').trim();
    const spec = CONFIG_SPEC[name];
    if (!spec) return;
    found[name] = true;

    if (spec.min === null) {           // 文字列項目
      config[spec.key] = String(row['値'] || '').trim();
      clearWarning(table, row._row);
      return;
    }

    const n = Number(row['値']);
    if (row['値'] === '' || row['値'] === null || !isFinite(n) || !Number.isInteger(n) || n < spec.min) {
      config[spec.key] = spec.def;
      writeWarning(table, row._row,
        '値が不正です（' + spec.min + ' 以上の整数）。既定値 ' + spec.def + ' で動作しています。');
      ctx.warn('設定「' + name + '」が不正値のため既定値で動作');
    } else {
      config[spec.key] = n;
      clearWarning(table, row._row);
    }
  });

  // 見つからなかった項目は既定値で動くが、管理者が気づけないため必ず知らせる
  const missing = Object.keys(CONFIG_SPEC).filter(function (n) { return !found[n]; });
  missing.forEach(function (n) {
    config[CONFIG_SPEC[n].key] = CONFIG_SPEC[n].def;
  });
  if (missing.length) {
    ctx.warn('設定シートに項目が見つかりません: ' + missing.join(' / '));
    if (table.rows.length) {
      writeWarning(table, table.rows[0]._row,
        '次の項目が見つかりません（項目名は完全一致で探します）: ' + missing.join(' / '));
    }
  }
  return config;
}

function readBusinessHours(table, ctx) {
  const byWeekday = {};
  table.rows.forEach(function (row) {
    const wd = String(row['曜日'] || '').trim();
    if (WEEKDAYS.indexOf(wd) < 0) {
      if (wd !== '') {
        writeWarning(table, row._row, '曜日は 月 火 水 木 金 土 日 の1文字で書いてください。');
        ctx.warn('営業時間シートの曜日表記が不正: ' + wd);
      }
      return;
    }
    const open = normalizeTime(row['開始時刻']);
    const close = normalizeTime(row['終了時刻']);
    const active = row['稼働日'] === true || String(row['稼働日']).toUpperCase() === 'TRUE';

    if (active && (open === null || close === null)) {
      writeWarning(table, row._row, '稼働日ですが営業時間が読み取れません。HH:mm 形式で入力してください。');
      ctx.warn('営業時間シート ' + wd + ' の時刻が不正');
      byWeekday[wd] = { active: false, open: null, close: null };
      return;
    }
    if (active && open >= close) {
      writeWarning(table, row._row, '終了時刻が開始時刻より前、または同じです。');
      byWeekday[wd] = { active: false, open: null, close: null };
      return;
    }
    clearWarning(table, row._row);
    byWeekday[wd] = { active: active, open: open, close: close };
  });
  return byWeekday;
}

function readRooms(table, ctx) {
  const rooms = [];
  const seenId = {};
  const seenOrder = {};

  table.rows.forEach(function (row) {
    const id = String(row['部屋ID'] || '').trim();
    if (id === '') {
      writeWarning(table, row._row, '部屋IDが空欄です。');
      ctx.warn('部屋マスタに部屋IDが空の行があります');
      return;
    }
    if (seenId[id]) {
      writeWarning(table, row._row, '部屋IDが重複しています: ' + id);
      ctx.warn('部屋IDの重複: ' + id);
      return;
    }
    seenId[id] = true;

    const capRaw = row['定員'];
    // 空欄は「制限なし」を意味する。無限大として扱い、おまかせ割当では常に最後に選ばれる。
    const capacity = (capRaw === '' || capRaw === null) ? Infinity : Number(capRaw);
    const order = Number(row['表示順']);

    if (capacity !== Infinity && (!isFinite(capacity) || capacity < 1)) {
      writeWarning(table, row._row, '定員は1以上の整数か、空欄（制限なし）にしてください。');
      return;
    }
    if (seenOrder[order]) {
      writeWarning(table, row._row,
        '表示順が他の行と重複しています。動作はしますが、並び順が意図どおりにならない場合があります。');
    }
    seenOrder[order] = true;

    const active = row['有効'] === true || String(row['有効']).toUpperCase() === 'TRUE';
    clearWarning(table, row._row);

    rooms.push({
      id: id,
      name: String(row['部屋名'] || '').trim(),
      capacity: capacity,
      order: isFinite(order) ? order : 9999,
      active: active,
      _row: row._row,
    });
  });
  return rooms;
}

/**
 * 部屋別予約可能時間。
 * 同じ部屋・同じ曜日に複数行を書ける。区間と区間の隙間が定例枠になる。
 * 開始・終了の両方または片方が空欄の行は、終日予約不可として扱う（安全側）。
 */
function readRoomHours(table, ctx) {
  const map = {};   // roomId → weekday → [{open, close}] / 'closed'

  table.rows.forEach(function (row) {
    const roomId = String(row['部屋ID'] || '').trim();
    const wd = String(row['曜日'] || '').trim();
    if (roomId === '' || WEEKDAYS.indexOf(wd) < 0) {
      if (roomId !== '' || wd !== '') {
        writeWarning(table, row._row, '部屋IDと曜日（月〜日の1文字）を正しく入力してください。');
      }
      return;
    }
    const open = normalizeTime(row['開始時刻']);
    const close = normalizeTime(row['終了時刻']);

    if (!map[roomId]) map[roomId] = {};
    if (!map[roomId][wd]) map[roomId][wd] = [];

    if (open === null || close === null) {
      if (open !== close) {   // 片方だけ空欄 = 不正。安全側に倒して終日不可とする
        writeWarning(table, row._row,
          '開始・終了の片方だけが空欄です。終日予約不可として扱います。');
        ctx.warn('部屋別予約可能時間に片側だけ空欄の行があります');
      } else {
        clearWarning(table, row._row);
      }
      map[roomId][wd] = 'closed';
      return;
    }
    if (open >= close) {
      writeWarning(table, row._row, '終了時刻が開始時刻より前、または同じです。');
      return;
    }
    clearWarning(table, row._row);
    if (map[roomId][wd] !== 'closed') {
      map[roomId][wd].push({ open: open, close: close });
    }
  });
  return map;
}

function readBlocks(table, ctx) {
  const blocks = [];
  table.rows.forEach(function (row) {
    const date = normalizeDate(row['日付']);
    if (date === null) {
      writeWarning(table, row._row, '日付を YYYY-MM-DD 形式で入力してください。');
      ctx.warn('臨時ブロックに日付が不正な行があります');
      return;
    }
    const open = normalizeTime(row['開始時刻']);
    const close = normalizeTime(row['終了時刻']);
    let start = open, end = close;

    if (open === null || close === null) {
      if (open !== close) {   // 片方だけ空欄 = 不正。安全側に倒して終日ブロック
        writeWarning(table, row._row,
          '開始・終了の片方だけが空欄です。終日ブロックとして扱います。');
        ctx.warn('臨時ブロックに片側だけ空欄の行があります');
      } else {
        clearWarning(table, row._row);
      }
      start = '00:00';
      end = '24:00';
    } else {
      clearWarning(table, row._row);
    }

    blocks.push({
      roomId: String(row['部屋ID'] || '').trim(),   // 空欄なら全部屋
      date: date,
      start: start,
      end: end,
      _row: row._row,
    });
  });
  return blocks;
}

function readReservations(table, ctx) {
  const list = [];
  table.rows.forEach(function (row) {
    const date = normalizeDate(row['日付']);
    const start = normalizeTime(row['開始時刻']);
    const end = normalizeTime(row['終了時刻']);

    if (date === null || start === null || end === null) {
      writeWarning(table, row._row, '日付・開始時刻・終了時刻を正しく入力してください（HH:mm の2桁ゼロ埋め）。');
      return;
    }
    list.push({
      id: String(row['予約ID'] || '').trim(),
      roomId: String(row['部屋ID'] || '').trim(),
      roomName: String(row['部屋名'] || '').trim(),
      date: date,
      start: start,
      end: end,
      headcount: Number(row['人数']) || 0,
      title: String(row['予約名'] || ''),
      userId: String(row['予約者userId'] || '').trim(),
      userName: String(row['予約者氏名'] || '').trim(),
      note: String(row['備考'] || ''),
      status: String(row['状態'] || '').trim(),
      source: String(row['登録元'] || '').trim(),
      calendarEventId: String(row['カレンダーイベントID'] || '').trim(),
      icsSequence: Number(row['ics連番']) || 0,
      _row: row._row,
    });
  });
  return list;
}

function readUsers(table) {
  const byId = {};
  table.rows.forEach(function (row) {
    const id = String(row['userId'] || '').trim();
    if (id === '') return;
    byId[id] = {
      userId: id,
      name: String(row['氏名'] || '').trim(),
      mail: String(row['メールアドレス'] || '').trim(),
      _row: row._row,
    };
  });
  return byId;
}
