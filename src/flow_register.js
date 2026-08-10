/**
 * 初回登録と登録情報の更新
 *
 * 初回登録を予約フローから独立させているのは、予約名の自動生成が氏名を前提とするため。
 * 氏名を取る前に予約名を確定させることはできない（システム要件 2.2）。
 *
 * 参照: システム要件定義書 2.2 / 技術仕様書 5.5
 */

const MAX_NAME_LEN = 40;
const MAX_MAIL_LEN = 254;

// ---------------------------------------------------------------------------
// 初回登録
// ---------------------------------------------------------------------------

/**
 * 未登録のユーザーが操作したときに呼ぶ。
 * resume には元の操作の postback データを入れる。登録のために操作が失われてはならない。
 */
function startRegistration(userId, resumeData) {
  setPending(userId, { kind: 'reg_name', resume: resumeData || '' });
  return [textMsg(
    '会議室予約へようこそ。\n' +
    'はじめに、お名前を教えてください。\n\n' +
    '（会議室の空き状況を見た方に、予約者として表示されます）'
  )];
}

function handleRegisterName(ctx, userId, text, pending) {
  const name = normalizeName(text);
  if (!name) {
    return [textMsg('お名前を読み取れませんでした。もう一度入力してください。')];
  }
  setPending(userId, { kind: 'reg_mail', resume: pending.resume, name: name });
  return [textMsg(
    name + ' さんですね。\n' +
    '次に、メールアドレスを入力してください。\n\n' +
    '（予約内容とカレンダー登録用のファイルをお送りします）'
  )];
}

function handleRegisterMail(ctx, userId, text, pending) {
  const mail = normalizeMail(text);
  if (!mail) {
    return [textMsg('メールアドレスの形式が正しくないようです。もう一度入力してください。')];
  }

  saveUser(ctx, userId, pending.name, mail);
  clearPending(userId);

  const done = textMsg(
    '登録が完了しました。\n' +
    '　お名前　　　: ' + pending.name + '\n' +
    '　メールアドレス: ' + mail + '\n\n' +
    '登録内容は「予約の確認」画面からいつでも変更できます。'
  );

  // 登録のために中断された操作へ復帰させる
  if (pending.resume) {
    const p = parsePostback(pending.resume);
    return [done].concat(handleAction(ctx, userId, p));
  }
  return [done, menuPrompt('やりたいことを選んでください。')];
}

// ---------------------------------------------------------------------------
// 登録情報の更新
// ---------------------------------------------------------------------------

function profileStep(ctx, userId, user, p) {
  if (p.f === 'name') {
    setPending(userId, { kind: 'profile_name' });
    return [textMsg('新しいお名前を入力してください。\n（現在: ' + user.name + '）')];
  }
  if (p.f === 'mail') {
    setPending(userId, { kind: 'profile_mail' });
    return [textMsg('新しいメールアドレスを入力してください。\n（現在: ' + user.mail + '）')];
  }

  return [flexMsg('登録情報の変更', flexDetailBubble(
    '登録情報',
    [
      { label: 'お名前', value: user.name },
      { label: 'メール', value: user.mail },
    ],
    [
      { label: 'お名前を変更', data: buildPostback({ a: 'profile', f: 'name' }) },
      { label: 'メールアドレスを変更', data: buildPostback({ a: 'profile', f: 'mail' }) },
      { label: '予約の確認に戻る', data: buildPostback({ a: 'list' }) },
    ]
  ))];
}

function handleProfileName(ctx, userId, text) {
  const name = normalizeName(text);
  if (!name) {
    return [textMsg('お名前を読み取れませんでした。もう一度入力してください。')];
  }

  const result = updateUserName(ctx, userId, name);
  clearPending(userId);

  if (!result.ok) {
    return [textMsg(result.message)];
  }
  const suffix = result.updated > 0
    ? '\n\nこれからの予約 ' + result.updated + ' 件の予約者名も更新しました。'
    : '';
  return [textMsg('お名前を「' + name + '」に変更しました。' + suffix)];
}

function handleProfileMail(ctx, userId, text) {
  const mail = normalizeMail(text);
  if (!mail) {
    return [textMsg('メールアドレスの形式が正しくないようです。もう一度入力してください。')];
  }
  const user = ctx.users[userId];
  saveUser(ctx, userId, user ? user.name : '', mail);
  clearPending(userId);

  // 予約シートはメールアドレスを保持しないため、波及先はない
  return [textMsg('メールアドレスを「' + mail + '」に変更しました。')];
}

// ---------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------

function saveUser(ctx, userId, name, mail) {
  withLock(function () {
    ctx.tables.利用者マスタ = readTable(SHEET.利用者マスタ);
    ctx.users = readUsers(ctx.tables.利用者マスタ);

    const existing = ctx.users[userId];
    if (existing) {
      writeCell(ctx.tables.利用者マスタ, existing._row, '氏名', name);
      writeCell(ctx.tables.利用者マスタ, existing._row, 'メールアドレス', mail);
      writeCell(ctx.tables.利用者マスタ, existing._row, '最終更新日時', nowStampStr());
    } else {
      appendTableRow(ctx.tables.利用者マスタ, {
        userId: userId, 氏名: name, メールアドレス: mail,
        初回登録日時: nowStampStr(), 最終更新日時: nowStampStr(),
      });
    }
    return { ok: true };
  });

  ctx.tables.利用者マスタ = readTable(SHEET.利用者マスタ);
  ctx.users = readUsers(ctx.tables.利用者マスタ);
}

/**
 * 氏名の変更を、これからの予約へ波及させる（技術仕様書 5.5）。
 *
 * 対象は「終了時刻が現在時刻以降」かつ「状態が確定」の自分の予約だけ。
 * 終了済み・キャンセル済みは当時の記録として残す。
 *
 * 更新は行ごとの writeCell で行う。予約シートを一括で読み書きすると、
 * その間に他ユーザーが確定させた行をまるごと上書きして消してしまう。
 * 消えた予約は操作履歴にも残らず、原因を追えない。
 *
 * カレンダーの更新はロックの外で行う。対象件数だけ外部APIを呼ぶループになるため、
 * ロックの中に入れると混雑時に全ユーザーが待たされる。
 */
function updateUserName(ctx, userId, newName) {
  const before = ctx.users[userId];
  const oldName = before ? before.name : '';

  const result = withLock(function () {
    reloadReservations(ctx);
    ctx.tables.利用者マスタ = readTable(SHEET.利用者マスタ);
    ctx.users = readUsers(ctx.tables.利用者マスタ);

    const user = ctx.users[userId];
    if (user) {
      writeCell(ctx.tables.利用者マスタ, user._row, '氏名', newName);
      writeCell(ctx.tables.利用者マスタ, user._row, '最終更新日時', nowStampStr());
    }

    const nowAbs = nowAbsoluteMinutes();
    const targets = ctx.reservations.filter(function (r) {
      return r.userId === userId && r.status === '確定'
        && toAbsoluteMinutes(r.date, r.end) >= nowAbs;
    });

    targets.forEach(function (r) {
      writeCell(ctx.tables.予約, r._row, '予約者氏名', newName);
      // 予約名は氏名の第2のコピーである（未入力時に「〈氏名〉の予約」を自動生成するため）。
      // 旧氏名から生成された値のときだけ置き換える。手入力の予約名は変えない。
      if (isGeneratedTitle(r.title, oldName)) {
        const newTitle = defaultTitle(newName);
        writeCell(ctx.tables.予約, r._row, '予約名', newTitle);
        r.title = newTitle;
      }
      r.userName = newName;
      writeCell(ctx.tables.予約, r._row, '更新日時', nowStampStr());
    });

    return { ok: true, targets: targets };
  });

  if (!result.ok) return result;

  // 共有カレンダーのタイトルにも予約名と予約者名が入るため、追随させる
  result.targets.forEach(function (r) {
    try {
      syncCalendarForReservation(ctx, '変更', r);
    } catch (e) {
      Logger.log('氏名変更のカレンダー反映に失敗: ' + r.id + ' ' + e);
    }
  });

  ctx.tables.利用者マスタ = readTable(SHEET.利用者マスタ);
  ctx.users = readUsers(ctx.tables.利用者マスタ);

  return { ok: true, updated: result.targets.length };
}

// ---------------------------------------------------------------------------
// 入力検証
// ---------------------------------------------------------------------------

/**
 * 氏名は空にできない。全社員に表示され、予約名の自動生成元でもあるため、
 * 不正な値が入ると波及処理で既存の予約にまで伝播する。
 */
function normalizeName(text) {
  const s = String(text || '').replace(/[\r\n\t]/g, ' ').trim();
  if (s === '' || s.length > MAX_NAME_LEN) return null;
  return s;
}

function normalizeMail(text) {
  const s = String(text || '').trim();
  if (s === '' || s.length > MAX_MAIL_LEN) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

/** 全角数字を半角に直したうえで、1以上の整数だけを受け付ける（システム要件 2.8） */
function parseHeadcount(text) {
  const s = String(text || '').trim().replace(/[０-９]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  // 上限は設けない。大会議室が定員なしのため、どれだけ大きくても割り当てられる。
  return n >= 1 ? n : null;
}
