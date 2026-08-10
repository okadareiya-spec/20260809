/**
 * 会議室予約 LINE Bot — スプレッドシート初期構築
 *
 * システム要件定義書 3章「データ要件」に基づき、シート構造と初期データを作る。
 * エディタから initSheets() を1回実行する。既存シートは作り直さないので、
 * 再実行しても入力済みのデータは消えない。
 */

// ---------------------------------------------------------------------------
// シート定義
// ---------------------------------------------------------------------------

// 文字列で保持する列の定義（TEXT_COLUMNS / TEXT_FORMAT）は lib_sheets.js にある。
// 書き込み経路と同じ定義を使うため、ここで別に持たないこと。

/** 管理者が行を追加できるよう、各シートに確保しておく予備行数 */
const SPARE_ROWS = 30;

const SHEET_DEFS = {
  予約: {
    headers: [
      '予約ID', '部屋ID', '部屋名', '日付', '開始時刻', '終了時刻', '人数', '予約名',
      '予約者userId', '予約者氏名', '備考', '状態', '登録元',
      '作成日時', '更新日時', 'カレンダーイベントID', 'ics連番', '警告',
    ],
    notes: {
      予約ID: 'システムが採番します。手で書き換えないでください。',
      部屋名: '部屋IDと重複して保持しています。部屋を付け替えるときは、部屋IDと部屋名の両方を書き換えてください。',
      日付: 'YYYY-MM-DD 形式の文字列です（例: 2026-08-10）。',
      開始時刻: 'HH:mm 形式の2桁ゼロ埋めです（例: 09:00）。9:00 と書くと判定が壊れます。',
      終了時刻: 'HH:mm 形式の2桁ゼロ埋めです（例: 18:00）。',
      状態: 'キャンセルは行を削除せず、この列を「キャンセル」に変更してください。',
      カレンダーイベントID: 'システムが書き込みます。消すと共有カレンダーとの同期が壊れます。',
      ics連番: 'システムが書き込みます。手で書き換えないでください。',
      警告: 'システムが検出した異常を書き込みます。内容を確認して対処してください。',
    },
    validations: {
      状態: ['確定', 'キャンセル'],
      登録元: ['ユーザー', '管理者'],
    },
  },

  部屋マスタ: {
    headers: ['部屋ID', '部屋名', '定員', '表示順', '有効', '警告'],
    notes: {
      部屋ID: '不変の識別子です。予約データがこの値を参照しているため、後から変更しないでください。',
      定員: '空欄は「制限なし」を意味します（大会議室が該当）。',
      表示順: '同じ定員の部屋が複数あるときの並び順です。一覧は定員の昇順が優先されます。',
      有効: '部屋を廃止するときは、行を削除せずこのチェックを外してください。',
    },
    checkboxCols: ['有効'],
    seed: [
      ['ROOM01', '個人ブース1', 1, 1, true, ''],
      ['ROOM02', '個人ブース2', 1, 2, true, ''],
      ['ROOM03', '個人ブース3', 1, 3, true, ''],
      ['ROOM04', '個人ブース4', 1, 4, true, ''],
      ['ROOM05', '6人部屋A', 6, 5, true, ''],
      ['ROOM06', '6人部屋B', 6, 6, true, ''],
      ['ROOM07', '6人部屋C', 6, 7, true, ''],
      ['ROOM08', '6人部屋D', 6, 8, true, ''],
      ['ROOM09', '6人部屋E', 6, 9, true, ''],
      ['ROOM10', '12人部屋A', 12, 10, true, ''],
      ['ROOM11', '12人部屋B', 12, 11, true, ''],
      ['ROOM12', '大会議室', '', 12, true, ''],
    ],
  },

  部屋別予約可能時間: {
    headers: ['部屋ID', '曜日', '開始時刻', '終了時刻', '警告'],
    notes: {
      部屋ID: '設定したい部屋のIDを入れます。',
      曜日: '月・火・水・木・金・土・日 の1文字で書きます。「月曜」や「Mon」は認識されません。',
      開始時刻: '【重要】このシートは「予約できる時間帯」を定義します。開始・終了の両方を空欄にすると、その曜日は終日予約不可になります。',
      終了時刻: '同じ部屋・同じ曜日に複数行を書けます。区間と区間の隙間が定例枠（予約不可）になります。',
    },
    validations: { 曜日: ['月', '火', '水', '木', '金', '土', '日'] },
  },

  臨時ブロック: {
    headers: ['部屋ID', '日付', '開始時刻', '終了時刻', '理由', '警告'],
    notes: {
      部屋ID: '空欄にすると全部屋が対象になります。祝日や全社休業日はこの使い方をします。',
      日付: 'YYYY-MM-DD 形式の文字列です。',
      開始時刻: '【重要】このシートは「予約できない時間帯」を定義します。開始・終了の両方を空欄にすると終日ブロックになります。予約可能時間シートとは空欄の意味が逆です。',
      理由: '管理者向けのメモです。動作には影響しません。',
    },
  },

  営業時間: {
    headers: ['曜日', '稼働日', '開始時刻', '終了時刻', '警告'],
    notes: {
      曜日: '月〜日の7行で固定です。行を増減しないでください。',
      稼働日: 'チェックを外すと、その曜日は全部屋が予約不可になります。',
      開始時刻: '祝日など「特定の日だけ休み」はこのシートでは設定できません。臨時ブロックを使ってください。',
    },
    checkboxCols: ['稼働日'],
    seed: [
      ['月', true, '09:00', '18:00', ''],
      ['火', true, '09:00', '18:00', ''],
      ['水', true, '09:00', '18:00', ''],
      ['木', true, '09:00', '18:00', ''],
      ['金', true, '09:00', '18:00', ''],
      ['土', false, '', '', ''],
      ['日', false, '', '', ''],
    ],
  },

  利用者マスタ: {
    headers: ['userId', '氏名', 'メールアドレス', '初回登録日時', '最終更新日時'],
    notes: {
      userId: 'LINE が発行する識別子です。システムが書き込みます。',
      メールアドレス: '予約通知メールの宛先です。ここが空だと通知が届きません。',
    },
  },

  操作履歴: {
    headers: ['日時', '実施者', '操作', '予約ID', '内容'],
    notes: { 日時: '参照専用です。システムが追記します。編集しないでください。' },
  },

  設定: {
    headers: ['項目', '値', '説明', '警告'],
    notes: {
      項目: '【重要】この文字列を1文字でも変えると、その設定は読み込まれず既定値で動作します。',
      値: 'ここを書き換えるとルールが変わります。次の予約から反映されます。',
    },
    seed: [
      ['受付締切（分前）', 0, '開始時刻の何分前まで予約・変更・キャンセルを受け付けるか。0 は「開始時刻まで受付」を意味し、締切なしではありません。', ''],
      ['予約可能日数', 60, '何日先まで予約できるか。', ''],
      ['時間の刻み（分）', 30, '予約時間の最小単位。', ''],
      ['最短予約時間（分）', 30, '1件の予約の最短の長さ。', ''],
      ['人数の初期値', 6, '人数選択で最初に強調される値。', ''],
      ['管理者通知先メール', 'okada_reiya@lion-cons.com', '例外発生時の通知先。複数ある場合はカンマで区切ります。', ''],
    ],
  },
};

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

function initSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const created = [];
  const skipped = [];

  buildIntroSheet(ss, created, skipped);

  Object.keys(SHEET_DEFS).forEach(function (name) {
    const def = SHEET_DEFS[name];
    if (ss.getSheetByName(name)) {
      skipped.push(name);
      return;
    }
    buildSheet(ss, name, def);
    created.push(name);
  });

  buildTodaySheet(ss, created, skipped);
  removeDefaultSheet(ss);
  reorderSheets(ss);

  const msg =
    '作成: ' + (created.length ? created.join(', ') : 'なし') + '\n' +
    '既存のためスキップ: ' + (skipped.length ? skipped.join(', ') : 'なし');
  Logger.log(msg);
  return msg;
}

function buildSheet(ss, name, def) {
  const sheet = ss.insertSheet(name);
  const headers = def.headers;

  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold')
    .setBackground('#efefef');
  sheet.setFrozenRows(1);

  // 日付・時刻を保持する列は、書式を文字列に固定する。
  // これをしないと "09:00" が時刻値へ自動変換され、文字列比較の前提が崩れる。
  // ただしこれは初期表示のためのもので、正しさの担保ではない。
  // 予備行を使い切った後の行には掛からないため、書き込み側でも行ごとに固定している。
  headers.forEach(function (h, i) {
    if (isTextColumn(h)) {
      sheet.getRange(2, i + 1, sheet.getMaxRows() - 1, 1).setNumberFormat(TEXT_FORMAT);
    }
  });

  Object.keys(def.notes || {}).forEach(function (col) {
    const i = headers.indexOf(col);
    if (i >= 0) sheet.getRange(1, i + 1).setNote(def.notes[col]);
  });

  Object.keys(def.validations || {}).forEach(function (col) {
    const i = headers.indexOf(col);
    if (i < 0) return;
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(def.validations[col], true)
      .setAllowInvalid(true)   // 管理者の入力は拒否しない（運用要件4.4）
      .build();
    sheet.getRange(2, i + 1, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
  });

  if (def.seed && def.seed.length) {
    sheet.getRange(2, 1, def.seed.length, headers.length).setValues(def.seed);
  }

  // チェックボックスは、データ行と少しの予備行にだけ入れる。
  // 列全体に入れると未使用行の値が false になり、getDataRange() が
  // 数百行を返してしまう（毎リクエストの読み込み量が増え、性能要件に反する）。
  const cbRows = (def.seed ? def.seed.length : 0) + SPARE_ROWS;
  (def.checkboxCols || []).forEach(function (col) {
    const i = headers.indexOf(col);
    if (i >= 0) sheet.getRange(2, i + 1, cbRows, 1).insertCheckboxes();
  });

  trimRows(sheet, (def.seed ? def.seed.length : 0) + SPARE_ROWS + 1);
  headers.forEach(function (_, i) { sheet.autoResizeColumn(i + 1); });
}

/** 使わない行を削除して、読み込み量を抑える */
function trimRows(sheet, keepRows) {
  const keep = Math.max(keepRows, 20);
  if (sheet.getMaxRows() > keep) {
    sheet.deleteRows(keep + 1, sheet.getMaxRows() - keep);
  }
}

/** 当日の予約を時系列で見るビュー。数式で作るので Bot が停止していても動く（システム要件3.4）。 */
function buildTodaySheet(ss, created, skipped) {
  const name = '本日の予約';
  if (ss.getSheetByName(name)) { skipped.push(name); return; }

  const sheet = ss.insertSheet(name);
  sheet.getRange('A1').setValue('本日の予約（自動表示・編集不可）')
    .setFontWeight('bold').setFontSize(12);
  sheet.getRange('A2').setValue(
    'このシートは数式で作られています。Bot が停止していても表示され続けます。値を直接編集しないでください。'
  ).setFontColor('#666666');

  sheet.getRange('A4').setFormula(
    '=IFERROR(QUERY(予約!A2:R, "select E,F,C,H,J,G where L = \'確定\' and D = \'"' +
    ' & TEXT(TODAY(),"yyyy-mm-dd") & "\' order by E", 0), "本日の予約はありません")'
  );
  sheet.getRange(3, 1, 1, 6)
    .setValues([['開始', '終了', '部屋', '予約名', '予約者', '人数']])
    .setFontWeight('bold').setBackground('#efefef');
  sheet.setFrozenRows(3);
  created.push(name);
}

function buildIntroSheet(ss, created, skipped) {
  const name = 'はじめに';
  if (ss.getSheetByName(name)) { skipped.push(name); return; }

  const sheet = ss.insertSheet(name, 0);
  const lines = [
    ['会議室予約システム — 管理者向けの運用ルール'],
    [''],
    ['このスプレッドシートが管理画面です。LINE 側に管理用の機能はありません。'],
    ['操作の頻度は低い想定なので、迷ったらこのシートを読み直してください。'],
    [''],
    ['■ やってはいけないこと'],
    ['予約の行を削除しないでください。キャンセルは「予約」シートの状態列を「キャンセル」に変えて行います。'],
    ['行を削除すると、操作履歴もユーザーへの通知も残らず、共有カレンダーにも予定が残り続けます。'],
    ['予約ID・カレンダーイベントID・ics連番の各列は、システムが管理しています。手で書き換えないでください。'],
    [''],
    ['■ 空欄の意味が、シートによって逆になります'],
    ['「部屋別予約可能時間」は 予約できる 時間帯を定義するシートです。時刻を空欄にすると、その曜日は終日 予約不可 になります。'],
    ['「臨時ブロック」は 予約できない 時間帯を定義するシートです。時刻を空欄にすると、終日 ブロック されます。'],
    ['結果はどちらも「予約できない」で同じですが、書き方が逆なので注意してください。'],
    [''],
    ['■ 定例枠の塞ぎ方'],
    ['毎週決まった時間に会議室を使う予定がある場合は、「部屋別予約可能時間」で時間帯を2つに分けて登録します。'],
    ['例) 大会議室を毎週火曜10:00-12:00に使う場合、火曜の行を 09:00-10:00 と 12:00-18:00 の2行に分けます。'],
    ['この2つの隙間が予約できない時間になります。「臨時ブロック」は使いません。'],
    [''],
    ['■ 祝日・全社休業日'],
    ['「営業時間」シートは曜日単位の設定なので、特定の日だけ休みにはできません。'],
    ['「臨時ブロック」に、部屋IDを空欄・日付を指定・時刻を両方空欄、の行を1行足してください。全部屋が終日ブロックされます。'],
    [''],
    ['■ 時刻の書き方'],
    ['時刻は必ず 2桁ゼロ埋め で書いてください（09:00 は正しく、9:00 は誤りです）。'],
    ['1桁で書くと判定が壊れ、エラーも出ないまま「予約できる部屋が0件」になります。'],
    [''],
    ['■ 警告列'],
    ['各シートの「警告」列に文字が入っていたら、システムが異常を検出しています。'],
    ['入力が拒否されることはありません。意図した例外なのか入力ミスなのかは、確認してご判断ください。'],
    [''],
    ['■ 誤操作からの復旧'],
    ['ファイル > 変更履歴 > 変更履歴を表示 から、以前の状態に戻せます。'],
  ];
  sheet.getRange(1, 1, lines.length, 1).setValues(lines);
  sheet.getRange('A1').setFontWeight('bold').setFontSize(14);
  ['A6', 'A11', 'A16', 'A21', 'A25', 'A28', 'A31'].forEach(function (a1) {
    sheet.getRange(a1).setFontWeight('bold');
  });
  sheet.setColumnWidth(1, 900);
  sheet.setHiddenGridlines(true);
  created.push(name);
}

/**
 * 既に作成済みのシートを、現在の方針に合わせて手直しする。
 *
 * 初期構築時にチェックボックスを列全体へ入れてしまうと、未使用行の値が false になり、
 * getDataRange() が数百行を返す。initSheets() は既存シートを作り直さないため、
 * その状態を後から直すための関数。何度実行しても安全。
 */
function repairSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const report = [];

  // スプレッドシート自身のタイムゾーン。appsscript.json の設定はスクリプト側のもので、
  // シート側とは別物である。ここがずれていると、シートが返す日付・時刻が時差分ずれ、
  // 「本日の予約」の TODAY() も別の日を指す。
  const tz = ss.getSpreadsheetTimeZone();
  if (tz !== TIMEZONE) {
    ss.setSpreadsheetTimeZone(TIMEZONE);
    report.push('タイムゾーン: ' + tz + ' → ' + TIMEZONE + ' に変更しました');
  } else {
    report.push('タイムゾーン: ' + tz + '（変更なし）');
  }

  Object.keys(SHEET_DEFS).forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;

    const before = sheet.getMaxRows();
    const lastData = findLastDataRow(sheet);
    const keep = Math.max(lastData + SPARE_ROWS, 20);

    // データ行より下に残っている値（チェックボックスの false を含む）を消す
    if (sheet.getMaxRows() > lastData) {
      sheet.getRange(lastData + 1, 1, sheet.getMaxRows() - lastData, sheet.getMaxColumns())
        .clearContent()
        .clearDataValidations();
    }
    trimRows(sheet, keep);

    // 予備行にチェックボックスを入れ直す（値は入らないので読み込み対象にならない）
    const def = SHEET_DEFS[name];
    (def.checkboxCols || []).forEach(function (col) {
      const i = def.headers.indexOf(col);
      if (i < 0) return;
      const rows = sheet.getMaxRows() - 1;
      if (rows > 0) sheet.getRange(2, i + 1, rows, 1).insertCheckboxes();
    });

    const converted = repairTextColumns(sheet);
    report.push(name + ': ' + before + '行 → ' + sheet.getMaxRows() + '行（データ ' + (lastData - 1) + '件）' +
      (converted ? ' / 日付・時刻 ' + converted + 'セルを文字列に戻しました' : ''));
  });

  const msg = report.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * 文字列で保持すべき列の書式を「書式なしテキスト」に直し、
 * 既に日付・時刻値として保存されてしまった値を文字列に書き戻す。
 *
 * 書式を直すだけでは足りない。既存の値は変換されたまま残り、
 * 読み戻したときに時差分ずれた時刻として解釈され続ける。
 *
 * @return 文字列に書き戻したセル数
 */
function repairTextColumns(sheet) {
  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getMaxRows();
  if (lastCol < 1 || lastRow < 2) return 0;

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  let fixed = 0;

  headers.forEach(function (h, i) {
    const name = String(h).trim();
    if (!isTextColumn(name)) return;

    const range = sheet.getRange(2, i + 1, lastRow - 1, 1);
    range.setNumberFormat(TEXT_FORMAT);

    const values = range.getValues();
    let changed = false;
    for (let r = 0; r < values.length; r++) {
      const v = values[r][0];
      if (!(v instanceof Date)) continue;
      const s = textValueOf(name, v);
      if (s === null) continue;
      values[r][0] = s;
      changed = true;
      fixed++;
    }
    if (changed) range.setValues(values);
  });
  return fixed;
}

/** 日付・時刻値を、その列が期待する文字列表現に直す */
function textValueOf(headerName, dateValue) {
  if (headerName === '日付') return normalizeDate(dateValue);
  if (headerName === '開始時刻' || headerName === '終了時刻') return normalizeTime(dateValue);
  return Utilities.formatDate(dateValue, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

/** 1列目に値がある最後の行を返す。見つからなければヘッダー行(1)を返す。 */
function findLastDataRow(sheet) {
  const values = sheet.getRange(1, 1, sheet.getMaxRows(), 1).getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]).trim() !== '') return i + 1;
  }
  return 1;
}

function removeDefaultSheet(ss) {
  ['シート1', 'Sheet1'].forEach(function (name) {
    const s = ss.getSheetByName(name);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });
}

function reorderSheets(ss) {
  const order = [
    'はじめに', '本日の予約', '予約', '部屋マスタ', '部屋別予約可能時間',
    '臨時ブロック', '営業時間', '設定', '利用者マスタ', '操作履歴',
  ];
  order.forEach(function (name, i) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(i + 1);
  });
}
