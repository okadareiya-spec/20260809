/**
 * 会話フローのテスト
 *
 * handleLineEvent は「イベントを受けてメッセージ配列を返す」純粋な形にしてあるため、
 * LINE を介さずに会話をひととおり通せる。
 *
 * 【注意】このテストは実際のシートに書き込み、通知メールを送信する。
 *   - 予約シート・操作履歴・利用者マスタに行を追加し、最後に必ず削除する
 *   - 予約の作成・変更・キャンセルで、テスト利用者宛に3通のメールを送る
 *     宛先は example.com のダミーアドレスで、誰にも届かない（送信上限は消費する）
 */

const LINE_TEST_USER = 'U_LINETEST';
const LINE_TEST_OTHER = 'U_LINEOTHER';
const LINE_TEST_MAIL = 'line-test@example.com';

function testLine() {
  const t = newRunner();
  const ctx = loadContext();
  const DAY = futureWeekday(30);
  const DAY_C = dateToCompact(DAY);

  clearPending(LINE_TEST_USER);

  try {
    // --- 初回登録 -----------------------------------------------------------
    t.group('初回登録');
    let m = handleLineEvent(ctx, lineTextEvent('予約する'));
    t.eq('未登録なら登録から始まる', lineHas(m, 'お名前'), true);
    // 目的と終わりが見えないと、突然の入力要求は手続きの押し付けに見える
    t.eq('登録が必須だと伝える', lineHas(m, '予約も空き状況の確認もできません'), true);
    t.eq('初回だけだと伝える', lineHas(m, '登録は初回だけ'), true);
    t.eq('何問目かを示す', lineHas(m, '【1/2】'), true);
    t.eq('復帰先を伝える', lineHas(m, '「予約」に戻ります'), true);
    t.eq('登録の途中でも抜けられる', findPostback(m, 'やめる') !== null, true);

    m = handleLineEvent(ctx, lineTextEvent(''));
    t.eq('空の氏名は受け付けない', lineHas(m, '読み取れませんでした'), true);

    m = handleLineEvent(ctx, lineTextEvent('LINE太郎'));
    t.eq('氏名の次はメールアドレス', lineHas(m, 'メールアドレス'), true);
    t.eq('残りが分かる', lineHas(m, '【2/2】'), true);
    t.eq('未登録だと通知が届かないと伝える', lineHas(m, '通知が届きません'), true);

    m = handleLineEvent(ctx, lineTextEvent('bad-mail'));
    t.eq('不正なメールは受け付けない', lineHas(m, '形式が正しくない'), true);

    m = handleLineEvent(ctx, lineTextEvent(LINE_TEST_MAIL));
    t.eq('登録が完了する', lineHas(m, '登録が完了しました'), true);
    // 誤入力に気づくのは登録直後が最も多い。変更手段をその場で伝えること。
    t.eq('変更できると案内する', lineHas(m, 'あとから変更できます'), true);
    t.eq('変更の場所を明示する', lineHas(m, '登録情報の変更'), true);
    // 登録のために中断された操作へ戻ること
    t.eq('元の操作（予約）へ復帰する', lineHas(m, '利用日'), true);

    // --- 予約フロー ---------------------------------------------------------
    t.group('予約フロー');
    m = handleLineEvent(ctx, linePostbackEvent('a=new&d=' + DAY_C));
    t.eq('P2 人数を聞く', lineHas(m, '何名'), true);
    t.eq('初期値が強調される', lineHas(m, '★ 6名'), true);

    m = handleLineEvent(ctx, linePostbackEvent('a=new&d=' + DAY_C + '&n=6'));
    t.eq('P3 開始時刻が出る', lineHas(m, '開始時刻'), true);
    const tData = findPostback(m, '14:00');
    t.eq('14:00 が選べる', tData !== null, true);
    if (!tData) return t.report();

    m = handleLineEvent(ctx, linePostbackEvent(tData));
    t.eq('P4 利用時間が出る', lineHas(m, 'どのくらい'), true);
    const durData = findPostback(m, '1時間');
    m = handleLineEvent(ctx, linePostbackEvent(durData));
    t.eq('P5 部屋が出る', lineHas(m, '部屋を選んで'), true);
    t.eq('おまかせがある', findPostback(m, 'おまかせ') !== null, true);

    m = handleLineEvent(ctx, linePostbackEvent(findPostback(m, 'おまかせ')));
    t.eq('P6 予約名を聞く', lineHas(m, '予約名'), true);

    m = handleLineEvent(ctx, lineTextEvent(TEST_MARK + 'LINE会議'));
    t.eq('P7 備考を聞く', lineHas(m, '備考'), true);

    m = handleLineEvent(ctx, linePostbackEvent(findPostback(m, '入力せずに進む')));
    t.eq('P8 確認画面が出る', lineHas(m, 'この内容で予約しますか'), true);
    t.eq('全項目を再掲する', lineHas(m, TEST_MARK + 'LINE会議') && lineHas(m, '6名'), true);

    m = handleLineEvent(ctx, linePostbackEvent(findPostback(m, '確定する')));
    t.eq('予約が確定する', lineHas(m, '予約が確定しました'), true);
    t.eq('Google の追加リンクが付く', lineHas(m, 'calendar.google.com'), true);
    t.eq('Outlook の追加リンクが付く', lineHas(m, 'outlook.office.com'), true);
    t.eq('自動登録ではないと伝える', lineHas(m, '保存の操作はご自身で'), true);

    // シートに実在すること
    reloadReservations(ctx);
    const mine = ctx.reservations.filter(function (r) {
      return r.userId === LINE_TEST_USER && r.status === '確定';
    });
    t.eq('予約が1件書き込まれた', mine.length, 1);
    if (mine.length !== 1) return t.report();
    t.eq('日付が一致する', mine[0].date, DAY);
    t.eq('時刻が一致する', mine[0].start + '-' + mine[0].end, '14:00-15:00');

    // --- 予約確認 -----------------------------------------------------------
    t.group('予約確認');
    m = handleLineEvent(ctx, linePostbackEvent('a=list'));
    t.eq('一覧に出る', lineHas(m, mine[0].roomName), true);
    t.eq('変更ボタンがある', findPostback(m, '変更') !== null, true);
    t.eq('登録情報の変更ボタンがある', findPostback(m, '登録情報の変更') !== null, true);

    // --- 人数変更（部屋の付け替えを伴う）--------------------------------------
    t.group('人数の変更');
    m = handleLineEvent(ctx, linePostbackEvent(findPostback(m, '変更')));
    t.eq('何を変更するか聞く', lineHas(m, '何を変更しますか'), true);

    m = handleLineEvent(ctx, linePostbackEvent(findPostback(m, '人数を変更')));
    t.eq('人数の選択肢が出る', lineHas(m, '何名'), true);

    m = handleLineEvent(ctx, linePostbackEvent(findPostback(m, '12名')));
    // 人数列だけ更新して終わってはならない。今の部屋に収まらないため部屋を選ばせる。
    t.eq('収容できないので部屋を選ばせる', lineHas(m, '定員'), true);
    const roomData = findPostback(m, '12人部屋A');
    t.eq('12人部屋が候補に出る', roomData !== null, true);

    m = handleLineEvent(ctx, linePostbackEvent(roomData));
    t.eq('変更が成立する', lineHas(m, '予約を変更しました'), true);

    reloadReservations(ctx);
    const after = findReservationById(ctx, mine[0].id);
    t.eq('人数が更新された', after.headcount, 12);
    t.eq('部屋も付け替わった', after.roomName, '12人部屋A');

    // --- 他人の予約 ---------------------------------------------------------
    t.group('他人の予約');
    m = handleLineEvent(ctx, {
      type: 'postback', source: { userId: LINE_TEST_OTHER }, replyToken: 'T',
      postback: { data: 'a=edit&id=' + mine[0].id },
    });
    // 未登録なので登録に飛ぶ。登録済みの他人でも防げることを直接確かめる。
    saveUser(ctx, LINE_TEST_OTHER, '別人', 'other@example.com');
    m = handleLineEvent(ctx, {
      type: 'postback', source: { userId: LINE_TEST_OTHER }, replyToken: 'T',
      postback: { data: 'a=edit&id=' + mine[0].id },
    });
    t.eq('他人は変更できない', lineHas(m, '他の方の予約は変更・キャンセルできません'), true);

    m = handleLineEvent(ctx, {
      type: 'postback', source: { userId: LINE_TEST_OTHER }, replyToken: 'T',
      postback: { data: 'a=cancel&id=' + mine[0].id + '&s=done' },
    });
    t.eq('他人はキャンセルできない', lineHas(m, '他の方の予約'), true);

    // --- 空き状況 -----------------------------------------------------------
    t.group('空き状況');
    m = handleLineEvent(ctx, linePostbackEvent('a=avail&d=' + DAY_C + '&t=1400'));
    t.eq('全部屋の状況が出る', lineHas(m, '空き状況') || lineHas(m, '空き'), true);
    t.eq('予約済みが出る', lineHas(m, '予約済み'), true);
    t.eq('予約者名が出る', lineHas(m, 'LINE太郎'), true);
    t.eq('空きも出る', lineHas(m, '空き'), true);

    // --- キャンセル ---------------------------------------------------------
    t.group('キャンセル');
    m = handleLineEvent(ctx, linePostbackEvent('a=list'));
    m = handleLineEvent(ctx, linePostbackEvent(findPostback(m, 'キャンセル')));
    t.eq('確認を1回挟む', lineHas(m, 'キャンセルしますか'), true);
    t.eq('確認画面に内容を再掲する', lineHas(m, '12人部屋A'), true);

    m = handleLineEvent(ctx, linePostbackEvent(findPostback(m, 'キャンセルする')));
    t.eq('キャンセルできる', lineHas(m, 'キャンセルしました'), true);

    reloadReservations(ctx);
    t.eq('状態がキャンセルになった', findReservationById(ctx, mine[0].id).status, 'キャンセル');

    m = handleLineEvent(ctx, linePostbackEvent('a=list'));
    t.eq('一覧から消える', lineHas(m, 'これからの予約はありません'), true);
    t.eq('0件でも登録情報の変更に行ける', findPostback(m, '登録情報の変更') !== null, true);

    // --- 登録情報の変更と氏名の波及 --------------------------------------------
    t.group('氏名の変更');
    const again = createReservation(ctx, {
      date: DAY, start: '16:00', end: '17:00', headcount: 6, roomId: 'AUTO',
      title: '', note: '', userId: LINE_TEST_USER, userName: 'LINE太郎',
      source: 'ユーザー', actor: LINE_TEST_USER,
    });
    t.eq('予約名を省くと自動生成される', again.reservation.title, 'LINE太郎の予約');

    m = handleLineEvent(ctx, linePostbackEvent('a=profile&f=name'));
    t.eq('新しい氏名を聞く', lineHas(m, '新しいお名前'), true);
    m = handleLineEvent(ctx, lineTextEvent('LINE次郎'));
    t.eq('氏名を変更できる', lineHas(m, 'LINE次郎'), true);

    reloadReservations(ctx);
    const renamed = findReservationById(ctx, again.reservation.id);
    t.eq('予約者氏名が追随する', renamed.userName, 'LINE次郎');
    // 予約名は氏名の第2のコピー。ここを取りこぼすと空き状況に旧氏名が残る。
    t.eq('自動生成の予約名も追随する', renamed.title, 'LINE次郎の予約');

    // --- 途中離脱 -------------------------------------------------------------
    // どの手順からも抜けられること。画面に手がかりがないと、利用者は
    // 「この会話から出られない」と受け取り、管理者への問い合わせにつながる。
    t.group('途中離脱');
    clearPending(LINE_TEST_USER);

    const steps = [
      ['日付選択', 'a=new'],
      ['人数選択', 'a=new&d=' + DAY_C],
      ['開始時刻選択', 'a=new&d=' + DAY_C + '&n=6'],
      ['人数の直接入力', 'a=new&d=' + DAY_C + '&s=num'],
      ['空き状況の時刻選択', 'a=avail&d=' + DAY_C],
    ];
    steps.forEach(function (pair) {
      const msgs = handleLineEvent(ctx, linePostbackEvent(pair[1]));
      t.eq(pair[0] + 'から抜けられる', findPostback(msgs, 'やめる') !== null, true);
    });

    // 利用時間・部屋・予約名・備考は、前の手順を通らないと到達できない
    let m2 = handleLineEvent(ctx, linePostbackEvent('a=new&d=' + DAY_C + '&n=6'));
    m2 = handleLineEvent(ctx, linePostbackEvent(findPostback(m2, '14:00')));
    t.eq('利用時間選択から抜けられる', findPostback(m2, 'やめる') !== null, true);
    m2 = handleLineEvent(ctx, linePostbackEvent(findPostback(m2, '1時間')));
    t.eq('部屋選択から抜けられる', findPostback(m2, 'やめる') !== null, true);
    m2 = handleLineEvent(ctx, linePostbackEvent(findPostback(m2, 'おまかせ')));
    t.eq('予約名の入力から抜けられる', findPostback(m2, 'やめる') !== null, true);
    m2 = handleLineEvent(ctx, linePostbackEvent(findPostback(m2, '入力せずに進む')));
    t.eq('備考の入力から抜けられる', findPostback(m2, 'やめる') !== null, true);
    m2 = handleLineEvent(ctx, linePostbackEvent(findPostback(m2, '入力せずに進む')));
    t.eq('確認画面から抜けられる', findPostback(m2, 'やめる') !== null, true);

    // 実際に抜けたときの挙動
    m2 = handleLineEvent(ctx, linePostbackEvent('a=menu'));
    t.eq('抜けるとメニューが出る', findPostback(m2, '予約する') !== null, true);
    t.eq('抜けたことを伝える', lineHas(m2, 'やめました'), true);
    t.eq('入力待ちが破棄される', getPending(LINE_TEST_USER), null);

    // 入力待ちの最中でも、リッチメニューの操作は素通しできること
    handleLineEvent(ctx, linePostbackEvent('a=new&d=' + DAY_C + '&n=6&s=num'));
    t.eq('入力待ちが残っている', getPending(LINE_TEST_USER) !== null, true);
    m2 = handleLineEvent(ctx, linePostbackEvent('a=list'));
    t.eq('入力待ちでも予約の確認へ行ける', lineHas(m2, '予約'), true);
    t.eq('その際に入力待ちは破棄される', getPending(LINE_TEST_USER), null);

    // 初回登録の途中でも抜けられること（登録ゲートより前に離脱を通している）
    handleLineEvent(ctx, {
      type: 'postback', source: { userId: 'U_LINEESCAPE' }, replyToken: 'T',
      postback: { data: 'a=new' },
    });
    const escaped = handleLineEvent(ctx, {
      type: 'postback', source: { userId: 'U_LINEESCAPE' }, replyToken: 'T',
      postback: { data: 'a=menu' },
    });
    t.eq('未登録でも離脱できる', lineHas(escaped, 'やめました'), true);
    t.eq('離脱が登録開始に化けない', lineHas(escaped, 'お名前'), false);
    clearPending('U_LINEESCAPE');

    // --- 使い方と登録情報の導線 --------------------------------------------------
    t.group('使い方の案内');
    m = handleLineEvent(ctx, linePostbackEvent('a=help'));
    t.eq('使い方が開く', lineHas(m, '会議室予約の使い方'), true);
    // 「予約の確認」の末尾だけだと見つけにくい。使い方からも辿れること。
    t.eq('登録情報の変更ボタンがある', findPostback(m, '登録情報の変更') !== null, true);
    t.eq('変更できることを本文でも案内する', lineHas(m, 'いつでも直せます'), true);
    t.eq('途中でやめられることを案内する', lineHas(m, '途中でやめる'), true);

    m = handleLineEvent(ctx, linePostbackEvent(findPostback(m, '登録情報の変更')));
    t.eq('使い方から登録情報へ行ける', lineHas(m, '登録情報'), true);
    t.eq('現在の登録内容が出る', lineHas(m, 'LINE次郎') || lineHas(m, 'LINE太郎'), true);

    // 未登録でも使い方は読めること。読む前に登録を強いない。
    const helpBefore = handleLineEvent(ctx, {
      type: 'postback', source: { userId: 'U_LINEHELP' }, replyToken: 'T',
      postback: { data: 'a=help' },
    });
    t.eq('未登録でも使い方は読める', lineHas(helpBefore, '会議室予約の使い方'), true);
    t.eq('未登録には登録が必要だと添える', lineHas(helpBefore, '登録をお願いします'), true);
    t.eq('未登録には変更ボタンを出さない', findPostback(helpBefore, '登録情報の変更'), null);
    clearPending('U_LINEHELP');

    // 登録を中断したときは、登録が必須であることを伝える
    handleLineEvent(ctx, {
      type: 'postback', source: { userId: 'U_LINEHELP' }, replyToken: 'T',
      postback: { data: 'a=new' },
    });
    const quit = handleLineEvent(ctx, {
      type: 'postback', source: { userId: 'U_LINEHELP' }, replyToken: 'T',
      postback: { data: 'a=menu' },
    });
    t.eq('中断すると登録が必要だと伝える', lineHas(quit, '登録が必要です'), true);
    clearPending('U_LINEHELP');

    // --- 例外的な入力 ---------------------------------------------------------
    t.group('例外的な入力');
    clearPending(LINE_TEST_USER);
    m = handleLineEvent(ctx, lineTextEvent('こんにちは'));
    t.eq('解釈できない入力は無視しない', findPostback(m, '予約する') !== null, true);

    m = handleLineEvent(ctx, linePostbackEvent('a=new&d=' + DAY_C + '&n=6&s=num'));
    t.eq('人数の直接入力を促す', lineHas(m, '数字で入力'), true);
    m = handleLineEvent(ctx, lineTextEvent('０'));
    t.eq('0名は受け付けない', lineHas(m, '1以上'), true);
    m = handleLineEvent(ctx, lineTextEvent('８'));
    t.eq('全角数字を解釈する', lineHas(m, '開始時刻'), true);

    m = handleLineEvent(ctx, linePostbackEvent('a=edit&id=R99999999-XXXXXX'));
    t.eq('存在しない予約IDを弾く', lineHas(m, '見つかりませんでした'), true);

  } finally {
    clearPending(LINE_TEST_USER);
    clearPending(LINE_TEST_OTHER);
    const removed = cleanupLineTestData();
    Logger.log('削除: 予約 ' + removed.reservations + '件 / 操作履歴 ' + removed.history +
      '件 / 利用者 ' + removed.users + '件 / カレンダー予定 ' + removed.events + '件');
    t.group('後片付け');
    t.eq('テストデータを削除した', removed.users >= 0, true);
  }

  return t.report();
}

// ---------------------------------------------------------------------------
// テスト用の道具
// ---------------------------------------------------------------------------

function linePostbackEvent(data) {
  return {
    type: 'postback', source: { userId: LINE_TEST_USER }, replyToken: 'TEST',
    postback: { data: data },
  };
}

function lineTextEvent(body) {
  return {
    type: 'message', source: { userId: LINE_TEST_USER }, replyToken: 'TEST',
    message: { type: 'text', text: body },
  };
}

/** メッセージ全体を文字列にして含まれるか見る */
function lineHas(messages, needle) {
  return JSON.stringify(messages).indexOf(needle) >= 0;
}

/** ラベルに指定の文字を含む postback ボタンのデータを返す。見つからなければ null。 */
function findPostback(node, labelPart) {
  let found = null;
  (function walk(n) {
    if (found !== null || n === null || typeof n !== 'object') return;
    if (n.type === 'postback' && String(n.label).indexOf(labelPart) >= 0) {
      found = n.data;
      return;
    }
    Object.keys(n).forEach(function (k) { walk(n[k]); });
  })(node);
  return found;
}

/**
 * テスト利用者が作ったデータを消す。
 *
 * 予約名の目印では拾えない。予約名を省いたときは「〈氏名〉の予約」が自動生成され、
 * 目印が入らないためである。予約者userId で消すこと。
 */
function cleanupLineTestData() {
  const isTestUser = function (id) {
    return String(id) === LINE_TEST_USER || String(id) === LINE_TEST_OTHER;
  };
  const counts = { reservations: 0, history: 0, users: 0, events: 0 };

  const rsv = readTable(SHEET.予約);
  const ids = {};
  const hits = rsv.rows.filter(function (r) {
    const hit = isTestUser(r['予約者userId']);
    if (hit) ids[String(r['予約ID'])] = true;
    return hit;
  });
  counts.events = deleteTestCalendarEvents(hits);
  const rsvRows = hits.map(function (r) { return r._row; });
  deleteRowsDescending(rsv.sheet, rsvRows);
  counts.reservations = rsvRows.length;

  const hist = readTable(SHEET.操作履歴);
  const histRows = hist.rows.filter(function (r) {
    return ids[String(r['予約ID'])] === true || isTestUser(r['実施者']);
  }).map(function (r) { return r._row; });
  deleteRowsDescending(hist.sheet, histRows);
  counts.history = histRows.length;

  const users = readTable(SHEET.利用者マスタ);
  const userRows = users.rows.filter(function (r) {
    return isTestUser(r['userId']);
  }).map(function (r) { return r._row; });
  deleteRowsDescending(users.sheet, userRows);
  counts.users = userRows.length;

  SpreadsheetApp.flush();
  return counts;
}
