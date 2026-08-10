/**
 * イベントの振り分け
 *
 * ここが会話の唯一の入口。返すのはメッセージの配列で、送信は行わない。
 * 送信と分離してあるので、LINE を介さずに会話全体をテストできる。
 */

/**
 * リッチメニューのボタンが送るテキスト。
 *
 * LINE 公式アカウントマネージャーで作るリッチメニューは、
 * 各領域に「テキストを送信する」しか設定できない（postback は Messaging API 経由でしか作れない）。
 * そのため決め打ちのテキストを操作として解釈する。
 */
const MENU_KEYWORDS = {
  '予約する': { a: 'new' },
  '予約': { a: 'new' },
  '予約の確認': { a: 'list' },
  '予約確認': { a: 'list' },
  '空き状況': { a: 'avail' },
  '空き': { a: 'avail' },
};

function handleLineEvent(ctx, event) {
  const userId = event.source && event.source.userId;
  if (!userId) return [];

  if (event.type === 'follow') {
    // 友だち追加の時点で登録を始める。予約フローの途中で氏名を聞かずに済む。
    return startRegistration(userId, '');
  }

  if (event.type === 'postback') {
    const p = parsePostback(event.postback && event.postback.data);
    // datetimepicker の選択結果は params に入る。postback データ側には含まれない。
    const picked = event.postback && event.postback.params && event.postback.params.date;
    if (picked) p.d = dateToCompact(picked);
    return handleAction(ctx, userId, p);
  }

  if (event.type === 'message' && event.message && event.message.type === 'text') {
    return handleText(ctx, userId, event.message.text);
  }

  return [];
}

// ---------------------------------------------------------------------------
// postback / メニュー操作
// ---------------------------------------------------------------------------

function handleAction(ctx, userId, p) {
  // フローの途中でない操作は、リッチメニューからの開始とみなして入力待ちを捨てる（技術仕様書 7.2）
  if (!p.s) clearPending(userId);

  const registered = isRegistered(ctx, userId);

  // 離脱はどの状態からでも通す。登録ゲートより前に置くのは、
  // 初回登録の途中でも抜けられるようにするため。
  if (p.a === 'menu') {
    return [menuPrompt(registered
      ? '操作をやめました。はじめから選び直せます。'
      : '登録を中断しました。\n' +
        'ご利用にはお名前とメールアドレスの登録が必要です。\n' +
        '次に操作したときに、もう一度はじめからお伺いします。')];
  }

  // 使い方は登録前でも読めるようにする。参照するだけで情報にも触れない。
  // 読む前に登録を強いると、何のための登録なのか分からないまま入力させることになる。
  if (p.a === 'help') return showHelp(ctx, registered);

  const user = ctx.users[userId];
  if (!registered) {
    // 未登録なら先に登録させ、完了後に元の操作へ復帰させる。
    // 登録のために操作が失われてはならない（システム要件 2.2）。
    // 相対日付は解決せずに保存する。日をまたいで登録を終えた場合、
    // 焼き込んだ日付だと「今日」を押したのに昨日の予約になる。
    return startRegistration(userId, buildPostback(p));
  }

  resolveRelativeDate(p);

  switch (p.a) {
    case 'new': return bookingStep(ctx, userId, user, p);
    case 'list': return showReservationList(ctx, userId, user);
    case 'edit': return editStep(ctx, userId, user, p);
    case 'cancel': return cancelStep(ctx, userId, user, p);
    case 'avail': return availabilityStep(ctx, userId, p);
    case 'profile': return profileStep(ctx, userId, user, p);
    default:
      return [menuPrompt('やりたいことを選んでください。')];
  }
}

/**
 * リッチメニューの「今日」「明日」を実際の日付に置き換える。
 *
 * リッチメニューは一度登録すると内容が固定されるため、postback に日付を
 * 焼き込めない。毎日作り直す運用は現実的でないので、相対指定を受け取って
 * ここで解決する。
 */
function resolveRelativeDate(p) {
  if (p.d === 'today') p.d = dateToCompact(nowDateStr());
  else if (p.d === 'tomorrow') p.d = dateToCompact(addDays(nowDateStr(), 1));
}

// ---------------------------------------------------------------------------
// テキスト入力
// ---------------------------------------------------------------------------

function handleText(ctx, userId, rawText) {
  const text = String(rawText || '').trim();

  // メニュー操作の判定を、入力待ちの判定より先に行う。
  // 逆にすると、予約名の入力待ちのときにメニューを押した「予約する」が
  // 予約名として保存されてしまう。
  const menu = MENU_KEYWORDS[text];
  if (menu) {
    clearPending(userId);
    // 定義そのものを渡さない。後続の処理が書き換えると、次の利用者に影響する。
    return handleAction(ctx, userId, withParams(menu, {}));
  }

  const pending = getPending(userId);
  if (!pending) {
    // 無言で無視しないこと（システム要件 2.8）
    return [menuPrompt('メニューから操作を選んでください。')];
  }

  switch (pending.kind) {
    case 'reg_name': return handleRegisterName(ctx, userId, text, pending);
    case 'reg_mail': return handleRegisterMail(ctx, userId, text, pending);
    case 'profile_name': return handleProfileName(ctx, userId, text);
    case 'profile_mail': return handleProfileMail(ctx, userId, text);
    case 'num': return handleHeadcountInput(ctx, userId, text, pending);
    case 'title': return handleTitleInput(ctx, userId, text, pending);
    case 'note': return handleNoteInput(ctx, userId, text, pending);
    case 'edit_title': return handleEditTitleInput(ctx, userId, text, pending);
    case 'edit_note': return handleEditNoteInput(ctx, userId, text, pending);
    case 'review':
      // 確認画面を出したあとのテキストは、押し間違いか独り言。確認画面を出し直す。
      return handleAction(ctx, userId, withParams(parsePostback(pending.data), { s: 'review' }));
    default:
      return [menuPrompt('メニューから操作を選んでください。')];
  }
}

function handleHeadcountInput(ctx, userId, text, pending) {
  const n = parseHeadcount(text);
  if (n === null) {
    return [textMsg('人数は1以上の数字で入力してください。（例: 8）')];
  }
  clearPending(userId);
  const p = withParams(parsePostback(pending.data), { n: n, s: null });
  return handleAction(ctx, userId, p);
}

function handleTitleInput(ctx, userId, text, pending) {
  const p = parsePostback(pending.data);
  return askNote(ctx, userId, p, { title: cut(text, 100) });
}

function handleNoteInput(ctx, userId, text, pending) {
  const p = parsePostback(pending.data);
  const values = { title: (pending.values || {}).title || '', note: cut(text, 300) };
  const user = ctx.users[userId];
  return showBookingReview(ctx, userId, user, p, values);
}

function handleEditTitleInput(ctx, userId, text, pending) {
  const p = parsePostback(pending.data);
  return askEditNote(ctx, userId, p, { title: cut(text, 100) });
}

function handleEditNoteInput(ctx, userId, text, pending) {
  const p = parsePostback(pending.data);
  setPending(userId, {
    kind: 'edit_note',
    data: pending.data,
    values: { title: (pending.values || {}).title || '', note: cut(text, 300) },
  });
  return applyEditText(ctx, userId, p);
}

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

function isRegistered(ctx, userId) {
  const u = ctx.users[userId];
  return !!(u && u.name && u.mail);
}

/**
 * 使い方の案内。リッチメニューの「使い方」から開く。
 * 説明なしで使えることを目指しているが（G-U3）、迷ったときの逃げ道は用意しておく。
 *
 * 登録情報の変更をここに置くのは、「予約の確認」画面の末尾だけだと
 * 導線が見つけにくいため。変更できることを知らないと、誤入力に気づいた
 * 利用者が管理者へ問い合わせることになる（運用要件5.5）。
 */
function showHelp(ctx, registered) {
  const rows = [
    { label: '予約する', value: '「今日」「明日」を押すとその日の予約に進みます。別の日は「日付を選ぶ」から。' },
    { label: '選ぶ順番', value: '日付 → 人数 → 開始時刻 → 利用時間 → 部屋 の順です。空いていない選択肢は最初から表示されません。' },
    { label: 'おまかせ', value: '部屋の選択で「おまかせ」を選ぶと、人数を収容できる一番小さい部屋が割り当てられます。' },
    { label: '途中でやめる', value: 'どの画面にも「やめる」があります。押すとメニューに戻り、別の操作に移れます。' },
    { label: '変更', value: '「予約の確認」から、日時・部屋・人数・予約名を変えられます。ご自身の予約だけです。' },
    { label: 'カレンダー', value: '予約するとメールが届きます。添付ファイルを開くと、ご自身のカレンダーに登録されます。変更やキャンセルも自動で反映されます。' },
    { label: '登録情報', value: 'お名前とメールアドレスは、下の「登録情報の変更」からいつでも直せます。' },
    { label: '他の方の予約', value: '変更・キャンセルはできません。予約者ご本人か、管理者にご相談ください。' },
  ];

  const buttons = [{ label: '予約する', primary: true, data: buildPostback({ a: 'new' }) }];
  if (registered) {
    buttons.push({ label: '登録情報の変更', data: buildPostback({ a: 'profile' }) });
  }
  buttons.push({ label: '空き状況を見る', data: buildPostback({ a: 'avail' }) });

  const note = '予約できるのは ' + ctx.config.bookableDays + ' 日先までです。' +
    '開始時刻を過ぎた予約は変更・キャンセルできません。' +
    (registered ? '' : '\n\nはじめてご利用の場合、最初にお名前とメールアドレスの登録をお願いします。');

  return [flexMsg('使い方', flexDetailBubble('会議室予約の使い方', rows, buttons, note))];
}

function menuPrompt(text) {
  return quickReplyMsg(text, [
    { label: '予約する', data: buildPostback({ a: 'new' }) },
    { label: '予約の確認', data: buildPostback({ a: 'list' }) },
    { label: '空き状況', data: buildPostback({ a: 'avail' }) },
  ]);
}
