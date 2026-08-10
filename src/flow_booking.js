/**
 * 予約フロー P1〜P8
 *
 * 手順の順序を入れ替えてはならない。人数（P2）を開始時刻（P3）より先に取るのは、
 * 「その時刻にその人数を収容できる部屋が空いているか」を判定するためである。
 * 人数が未確定では判定基準が決まらない（システム要件 2.3）。
 *
 * 選択肢は必ず設定値と部屋マスタから生成する。定数を直書きすると、
 * 管理者が設定を変えても選択肢が追従せず、UI と検証ロジックが食い違う。
 */

function bookingStep(ctx, userId, user, p) {
  if (p.s === 'num') return askHeadcountInput(ctx, userId, p);
  if (p.s === 'done') return confirmAndCreate(ctx, userId, user, p);
  if (p.s === 'review') return showBookingReview(ctx, userId, user, p, readValues(userId));
  if (p.s === 'note') return askNote(ctx, userId, p, { title: '' });
  if (p.s === 'title') return askTitle(ctx, userId, p);

  if (!p.d) return askDate(ctx, p, 'ご利用日を選んでください。');
  if (!p.n) return askHeadcount(ctx, p);
  if (!p.t) return askStartTime(ctx, p);
  if (!p.dur) return askDuration(ctx, p);
  if (!p.r) return askRoom(ctx, p);
  return askTitle(ctx, userId, p);
}

// ---------------------------------------------------------------------------
// P1 日付
// ---------------------------------------------------------------------------

/**
 * 「今日」「明日」を置くのは、当日利用の頻度が高く、
 * カレンダーを開いて選ぶ操作が手数として重いため（システム要件 2.3）。
 * カレンダーの選択範囲は本日〜設定値の日数後に制限し、範囲外を選べなくする。
 */
function askDate(ctx, p, prompt) {
  const today = nowDateStr();
  const max = addDays(today, ctx.config.bookableDays);
  const base = withParams(p, { d: null, n: null, t: null, dur: null, r: null, s: null });

  const items = [
    {
      label: '今日（' + today.slice(5).replace('-', '/') + '）',
      data: buildPostback(withParams(base, { d: dateToCompact(today) })),
    },
    {
      label: '明日（' + addDays(today, 1).slice(5).replace('-', '/') + '）',
      data: buildPostback(withParams(base, { d: dateToCompact(addDays(today, 1)) })),
    },
  ];

  const msg = quickReplyMsg(prompt, items);
  msg.quickReply.items.push(
    datePickerAction('カレンダーから選ぶ', buildPostback(base), today, max)
  );
  msg.quickReply.items.push({ type: 'action', action: postbackAction(escapeAction()) });
  return [msg];
}

// ---------------------------------------------------------------------------
// P2 人数
// ---------------------------------------------------------------------------

function askHeadcount(ctx, p) {
  const date = compactToDate(p.d);
  const items = listHeadcounts(ctx).map(function (n) {
    return {
      label: n === ctx.config.defaultHeadcount ? '★ ' + n + '名' : n + '名',
      data: buildPostback(withParams(p, { n: n })),
    };
  });
  items.push({ label: '人数を入力', data: buildPostback(withParams(p, { s: 'num' })) });
  items.push(escapeAction());

  return [quickReplyMsg(
    date + '（' + weekdayOf(date) + '）ですね。\n何名で利用しますか。',
    items
  )];
}

/** 人数の直接入力。予約フローと変更フローの両方から使う。 */
function askHeadcountInput(ctx, userId, p) {
  setPending(userId, { kind: 'num', data: buildPostback(withParams(p, { s: null })) });
  return [quickReplyMsg('人数を数字で入力してください。（例: 8）', [escapeAction()])];
}

// ---------------------------------------------------------------------------
// P3 開始時刻
// ---------------------------------------------------------------------------

function askStartTime(ctx, p) {
  const date = compactToDate(p.d);
  const n = Number(p.n);
  // 変更フローでは、自分自身の予約を判定から外す。
  // 外さないと、いま押さえている時刻が候補から消え、短縮ができなくなる。
  const res = listStartTimes(ctx, date, n, p.id || null);

  if (res.times.length === 0) {
    return [textMsg(noStartTimeMessage(ctx, date, n, res.reason)),
      quickReplyMsg('別の日を選びますか。', [
        { label: '日付を選び直す', data: buildPostback({ a: 'new' }) },
        { label: '空き状況を見る', data: buildPostback({ a: 'avail', d: p.d }) },
      ])];
  }

  const buttons = res.times.map(function (t) {
    return { label: t, data: buildPostback(withParams(p, { t: timeToCompact(t) })) };
  });
  return [flexButtonList(
    '開始時刻を選んでください',
    date + '（' + weekdayOf(date) + '）の開始時刻',
    n + '名で利用できる時刻だけを表示しています。',
    buttons
  )];
}

/** 時刻が表示されないだけでは理由が伝わらない。必ず理由を書く（システム要件 2.3）。 */
function noStartTimeMessage(ctx, date, n, reason) {
  if (reason === 'closed_day') {
    return date + '（' + weekdayOf(date) + '）は休業日のため、予約できません。';
  }
  const bh = ctx.businessHours[weekdayOf(date)];
  if (date === nowDateStr() && bh && bh.active && nowTimeStr() >= bh.close) {
    return '本日の営業時間（' + bh.open + '〜' + bh.close + '）は終了しました。\n' +
      '翌日以降の日付を選んでください。';
  }
  return date + '（' + weekdayOf(date) + '）は、' + n + '名で利用できる時間が残っていません。\n' +
    '人数を減らすか、別の日を選んでください。';
}

// ---------------------------------------------------------------------------
// P4 利用時間
// ---------------------------------------------------------------------------

function askDuration(ctx, p) {
  const date = compactToDate(p.d);
  const start = compactToTime(p.t);
  const list = listDurations(ctx, date, start, Number(p.n), p.id || null);

  if (list.length === 0) {
    return [textMsg('その時刻から確保できる時間がありません。開始時刻を選び直してください。'),
      quickReplyMsg('開始時刻に戻ります。', [
        { label: '開始時刻を選び直す', data: buildPostback(withParams(p, { t: null })) },
      ])];
  }

  const buttons = list.map(function (d) {
    return {
      label: d.label,
      data: buildPostback(withParams(p, { dur: d.minutes })),
      displayText: d.label + '（' + start + '〜' + d.end + '）',
    };
  });
  return [flexButtonList(
    '利用時間を選んでください',
    start + ' から、どのくらい使いますか',
    '選べない長さは表示していません。',
    buttons
  )];
}

// ---------------------------------------------------------------------------
// P5 部屋
// ---------------------------------------------------------------------------

function askRoom(ctx, p) {
  const req = bookingRequest(ctx, p);
  const avail = findAvailableRooms(ctx, {
    date: req.date, start: req.start, end: req.end, headcount: req.headcount,
    excludeId: p.id || null,
  });

  if (avail.rooms.length === 0) {
    return [textMsg(avail.message),
      quickReplyMsg('別の時間を探しますか。', [
        { label: '開始時刻を選び直す', data: buildPostback(withParams(p, { t: null, dur: null })) },
        { label: '空き状況を見る', data: buildPostback({ a: 'avail', d: p.d, t: p.t }) },
      ])];
  }

  const nextStep = p.a === 'edit' ? {} : { s: 'title' };
  const buttons = [{
    label: 'おまかせ（' + avail.rooms[0].name + '）',
    primary: true,
    data: buildPostback(withParams(p, withParams(nextStep, { r: 'AUTO' }))),
  }];
  avail.rooms.forEach(function (room) {
    buttons.push({
      label: room.name + '（定員' + capacityLabel(room) + '）',
      data: buildPostback(withParams(p, withParams(nextStep, { r: room.id }))),
    });
  });

  return [flexButtonList(
    '部屋を選んでください',
    req.date + ' ' + req.start + '〜' + req.end,
    req.headcount + '名で利用できる空室です。おまかせを選ぶと、収容できる最小の部屋が割り当てられます。',
    buttons
  )];
}

function capacityLabel(room) {
  return room.capacity === Infinity ? 'なし' : room.capacity + '名';
}

// ---------------------------------------------------------------------------
// P6 予約名 / P7 備考
// ---------------------------------------------------------------------------

function askTitle(ctx, userId, p) {
  setPending(userId, { kind: 'title', data: buildPostback(p), values: {} });
  return [quickReplyMsg(
    '予約名を入力してください。\n（会議室の空き状況を見た方にも表示されます）',
    [{ label: '入力せずに進む', data: buildPostback(withParams(p, { s: 'note' })) },
     escapeAction()]
  )];
}

function askNote(ctx, userId, p, values) {
  setPending(userId, { kind: 'note', data: buildPostback(p), values: values });
  return [quickReplyMsg(
    '備考があれば入力してください。',
    [{ label: '入力せずに進む', data: buildPostback(withParams(p, { s: 'review' })) },
     escapeAction()]
  )];
}

/** 入力待ちの間に確定した予約名・備考を取り出す。期限切れなら null。 */
function readValues(userId) {
  const pending = getPending(userId);
  return pending && pending.values ? pending.values : null;
}

// ---------------------------------------------------------------------------
// P8 確認 → 確定
// ---------------------------------------------------------------------------

function showBookingReview(ctx, userId, user, p, values) {
  if (!values) return expiredInputMessage(ctx, userId, p);

  // 期限を延ばすため、確認画面の表示でも入れ直す
  setPending(userId, { kind: 'review', data: buildPostback(p), values: values });

  const req = bookingRequest(ctx, p);
  const roomName = p.r === 'AUTO' ? 'おまかせ' : roomNameOf(ctx, p.r);

  return [flexMsg('この内容で予約しますか', flexDetailBubble(
    'この内容で予約しますか',
    [
      { label: '日付', value: req.date + '（' + weekdayOf(req.date) + '）' },
      { label: '時間', value: req.start + ' 〜 ' + req.end },
      { label: '部屋', value: roomName },
      { label: '人数', value: req.headcount + '名' },
      { label: '予約名', value: values.title || '（' + defaultTitle(user.name) + '）' },
      { label: '備考', value: values.note || '（なし）' },
    ],
    [
      { label: '確定する', primary: true, data: buildPostback(withParams(p, { s: 'done' })) },
      { label: '最初から選び直す', data: buildPostback({ a: 'new' }) },
      escapeAction(),
    ]
  ))];
}

function confirmAndCreate(ctx, userId, user, p) {
  const values = readValues(userId);
  if (!values) return expiredInputMessage(ctx, userId, p);

  const req = bookingRequest(ctx, p);
  // postback の内容は信用せず、この時点の空き状況・締切・設定値で再判定する。
  // 数日前のメッセージのボタンが押されても矛盾しないようにするための唯一の防御線。
  const result = createReservation(ctx, {
    date: req.date, start: req.start, end: req.end,
    headcount: req.headcount, roomId: p.r,
    title: values.title || '', note: values.note || '',
    userId: userId, userName: user.name,
    source: 'ユーザー', actor: userId,
  });

  clearPending(userId);

  if (!result.ok) return bookingFailureMessages(ctx, p, result);
  return bookingSuccessMessages(result.reservation);
}

function bookingSuccessMessages(r) {
  return [
    flexMsg('予約が確定しました', flexDetailBubble(
      '予約が確定しました',
      [
        { label: '日付', value: r.date + '（' + weekdayOf(r.date) + '）' },
        { label: '時間', value: r.start + ' 〜 ' + r.end },
        { label: '部屋', value: r.roomName },
        { label: '人数', value: r.headcount + '名' },
        { label: '予約名', value: r.title },
        { label: '予約ID', value: r.id },
      ],
      [
        { label: 'Google カレンダーに追加', uri: googleCalendarLink(r) },
        { label: 'Outlook に追加', uri: outlookCalendarLink(r) },
      ],
      // 「追加しました」と誤解させないこと。タップ後に保存操作が要る（システム要件 2.3）。
      'ボタンを押すと予定の作成画面が開きます。保存の操作はご自身で行ってください。\n' +
      'この方法で追加した予定は、予約を変更しても自動では更新されません。' +
      '自動で更新したい場合は、メールに添付したファイルをお使いください。'
    )),
    textMsg('予約内容をメールでもお送りしました。添付ファイルを開くと、カレンダーに登録できます。'),
  ];
}

/** 失敗の理由ごとに、次にとるべき行動をセットで返す（システム要件 2.8 / 2.9） */
function bookingFailureMessages(ctx, p, result) {
  const back = { label: '開始時刻を選び直す', data: buildPostback(withParams(p, { t: null, dur: null, r: null, s: null })) };
  const restart = { label: '最初からやり直す', data: buildPostback({ a: 'new' }) };
  const avail = { label: '空き状況を見る', data: buildPostback({ a: 'avail', d: p.d }) };

  if (result.reason === 'room_taken' || result.reason === 'all_booked') {
    return [quickReplyMsg(
      'その枠は、ちょうど他の方に取られてしまいました。\n別の時間を選んでください。',
      [back, avail]
    )];
  }
  if (result.reason === 'past_deadline' || result.reason === 'too_far') {
    return [quickReplyMsg(result.message, [restart])];
  }
  if (result.reason === 'busy') {
    return [quickReplyMsg(result.message, [
      { label: 'もう一度確定する', data: buildPostback(withParams(p, { s: 'done' })) },
    ])];
  }
  return [quickReplyMsg(result.message || '予約できませんでした。', [restart, avail])];
}

function expiredInputMessage(ctx, userId, p) {
  clearPending(userId);
  return [quickReplyMsg(
    '入力の保持期限が切れました。予約名からもう一度お願いします。',
    [{ label: '続きから入力する', data: buildPostback(withParams(p, { s: 'title' })) },
     { label: '最初からやり直す', data: buildPostback({ a: 'new' }) },
     escapeAction()]
  )];
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/** postback の圧縮形式を、シートの形式へ戻す。変換は必ずここを通す。 */
function bookingRequest(ctx, p) {
  const date = compactToDate(p.d);
  const start = compactToTime(p.t);
  const bh = ctx.businessHours[weekdayOf(date)];
  // 「営業終了まで」は、選んだ開始時刻からその日の営業終了時刻まで。「終日」ではない。
  const end = (p.dur === 'end') ? bh.close : addMinutes(start, Number(p.dur));
  return { date: date, start: start, end: end, headcount: Number(p.n) };
}

function roomNameOf(ctx, roomId) {
  const hit = ctx.rooms.filter(function (r) { return r.id === roomId; })[0];
  return hit ? hit.name : roomId;
}
