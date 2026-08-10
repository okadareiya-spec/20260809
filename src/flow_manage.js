/**
 * 予約確認・変更・キャンセル
 *
 * 他人の予約に対しては、ボタンを出さないだけでは足りない。
 * postback を直接送られる経路があるため、処理側でも必ず userId の一致を検証する
 * （システム要件 2.5）。
 */

/**
 * 一覧に載せる予約の上限。カルーセルは12バブルまでで、末尾の1枚を案内に使う。
 *
 * 定数ではなく関数にしてあるのは、Apps Script が複数ファイルを1つのスクリプトとして
 * 順に評価するため。トップレベルで他ファイルの定数を参照すると、評価順によっては
 * まだ初期化されておらず ReferenceError になる。
 */
function maxListedReservations() {
  return MAX_BUBBLES - 1;
}

// ---------------------------------------------------------------------------
// 予約確認（システム要件 2.4）
// ---------------------------------------------------------------------------

function showReservationList(ctx, userId, user) {
  const nowAbs = nowAbsoluteMinutes();

  // 終了時刻で絞るのは、利用中の予約を一覧に残すため。
  // 「開始時刻が現在時刻以降」にすると、いま使っている部屋が一覧から消える。
  const mine = ctx.reservations.filter(function (r) {
    return r.userId === userId && r.status === '確定'
      && toAbsoluteMinutes(r.date, r.end) >= nowAbs;
  }).sort(function (a, b) {
    return toAbsoluteMinutes(a.date, a.start) - toAbsoluteMinutes(b.date, b.start);
  });

  const profileButton = {
    label: '登録情報の変更', data: buildPostback({ a: 'profile' }),
  };

  if (mine.length === 0) {
    // 0件でも登録情報の変更へ到達できること。初回登録の誤入力を直したい人は、
    // その瞬間まだ予約を持っていない（システム要件 2.2）。
    return [quickReplyMsg('これからの予約はありません。', [
      { label: '予約する', data: buildPostback({ a: 'new' }) },
      { label: '空き状況を見る', data: buildPostback({ a: 'avail' }) },
      profileButton,
    ])];
  }

  const limit = maxListedReservations();
  const bubbles = mine.slice(0, limit).map(function (r) {
    return flexDetailBubble(
      r.date + '（' + weekdayOf(r.date) + '） ' + r.start + '〜' + r.end,
      [
        { label: '部屋', value: r.roomName },
        { label: '人数', value: r.headcount + '名' },
        { label: '予約名', value: r.title },
        { label: '備考', value: r.note || '（なし）' },
      ],
      [
        // 開始時刻を過ぎた予約でもボタンは出す。押された時点で理由を返す方が、
        // 「なぜ操作できないのか」が分からない状態より親切である（運用要件 3.4）。
        { label: '変更', data: buildPostback({ a: 'edit', id: r.id }) },
        { label: 'キャンセル', data: buildPostback({ a: 'cancel', id: r.id }) },
      ]
    );
  });

  bubbles.push(flexDetailBubble(
    'そのほか',
    [{ label: '件数', value: mine.length + '件の予約があります' }],
    [
      { label: '予約する', data: buildPostback({ a: 'new' }) },
      profileButton,
    ],
    mine.length > limit
      ? '先の ' + limit + ' 件のみ表示しています。残りは時間が経つと表示されます。'
      : ''
  ));

  return [flexMsg('これからの予約 ' + mine.length + ' 件', bubbles)];
}

// ---------------------------------------------------------------------------
// 変更（システム要件 2.5）
// ---------------------------------------------------------------------------

function editStep(ctx, userId, user, p) {
  const found = loadOwnReservation(ctx, userId, p.id);
  if (found.error) return found.error;
  const r = found.reservation;

  if (!p.f) return askEditField(r);
  if (p.s === 'num') return askHeadcountInput(ctx, userId, p);

  const q = fillFromReservation(p, r);

  if (q.f === 'text') {
    if (q.s === 'apply') return applyEditText(ctx, userId, q);
    if (q.s === 'note') return askEditNote(ctx, userId, q, { title: '' });
    return askEditTitle(ctx, userId, q);
  }

  if (q.f === 'datetime') {
    if (!q.d) return askDate(ctx, withParams(q, { n: null }), '新しいご利用日を選んでください。');
    if (!q.t) return askStartTime(ctx, q);
    if (!q.dur) return askDuration(ctx, q);
    if (!q.r) return askRoom(ctx, q);
    return applyEdit(ctx, userId, q, editedSlot(ctx, q));
  }

  if (q.f === 'room') {
    if (!q.r) return askRoom(ctx, withParams(q, { r: null }));
    return applyEdit(ctx, userId, q, { roomId: q.r });
  }

  if (q.f === 'num') {
    if (!q.n) return askHeadcount(ctx, withParams(q, { n: null }));
    // 人数列だけを更新してはならない。今の部屋に収まらなくなる場合がある。
    const room = ctx.rooms.filter(function (x) { return x.id === r.roomId; })[0];
    if (room && room.capacity < Number(q.n)) {
      if (!q.r || q.r === r.roomId) {
        return [textMsg(
          room.name + 'の定員は' + capacityLabel(room) + 'です。' +
          Number(q.n) + '名で使える部屋を選び直してください。'
        )].concat(askRoom(ctx, withParams(q, { r: null })));
      }
      return applyEdit(ctx, userId, q, { headcount: Number(q.n), roomId: q.r });
    }
    return applyEdit(ctx, userId, q, { headcount: Number(q.n) });
  }

  return askEditField(r);
}

function askEditField(r) {
  return [flexMsg('何を変更しますか', flexDetailBubble(
    '何を変更しますか',
    [
      { label: '日時', value: r.date + ' ' + r.start + '〜' + r.end },
      { label: '部屋', value: r.roomName },
      { label: '人数', value: r.headcount + '名' },
      { label: '予約名', value: r.title },
    ],
    [
      { label: '日時を変更', data: buildPostback({ a: 'edit', id: r.id, f: 'datetime' }) },
      { label: '部屋を変更', data: buildPostback({ a: 'edit', id: r.id, f: 'room' }) },
      { label: '人数を変更', data: buildPostback({ a: 'edit', id: r.id, f: 'num' }) },
      { label: '予約名・備考を変更', data: buildPostback({ a: 'edit', id: r.id, f: 'text' }) },
      { label: '予約の確認に戻る', data: buildPostback({ a: 'list' }) },
    ]
  ))];
}

function askEditTitle(ctx, userId, p) {
  setPending(userId, { kind: 'edit_title', data: buildPostback(p), values: {} });
  return [quickReplyMsg('新しい予約名を入力してください。', [
    { label: '予約名は変えない', data: buildPostback(withParams(p, { s: 'note' })) },
    escapeAction(),
  ])];
}

function askEditNote(ctx, userId, p, values) {
  setPending(userId, { kind: 'edit_note', data: buildPostback(p), values: values });
  return [quickReplyMsg('新しい備考を入力してください。', [
    { label: '備考は変えない', data: buildPostback(withParams(p, { s: 'apply' })) },
    escapeAction(),
  ])];
}

function applyEditText(ctx, userId, p) {
  const values = readValues(userId) || {};
  clearPending(userId);

  const changes = {};
  if (values.title) changes.title = values.title;
  if (values.note !== undefined && values.note !== '') changes.note = values.note;

  if (Object.keys(changes).length === 0) {
    return [textMsg('変更する内容がありませんでした。')].concat(showReservationList(ctx, userId, ctx.users[userId]));
  }
  return applyEdit(ctx, userId, p, changes);
}

/** 変更後の日時。「営業終了まで」の解釈は予約フローと共通にする。 */
function editedSlot(ctx, p) {
  const req = bookingRequest(ctx, p);
  return { date: req.date, start: req.start, end: req.end, roomId: p.r };
}

function applyEdit(ctx, userId, p, changes) {
  const result = changeReservation(ctx, p.id, changes, { userId: userId, actor: userId });
  if (!result.ok) return editFailureMessages(ctx, p, result);

  const r = result.reservation;
  return [flexMsg('予約を変更しました', flexDetailBubble(
    '予約を変更しました',
    [
      { label: '日付', value: r.date + '（' + weekdayOf(r.date) + '）' },
      { label: '時間', value: r.start + ' 〜 ' + r.end },
      { label: '部屋', value: r.roomName },
      { label: '人数', value: r.headcount + '名' },
      { label: '予約名', value: r.title },
      { label: '予約ID', value: r.id },
    ],
    [{ label: '予約の確認に戻る', data: buildPostback({ a: 'list' }) }],
    '変更内容をメールでもお送りしました。添付ファイルを開くと、カレンダーの予定も更新されます。'
  ))];
}

function editFailureMessages(ctx, p, result) {
  const items = [
    { label: '変更をやり直す', data: buildPostback({ a: 'edit', id: p.id }) },
    { label: '予約の確認に戻る', data: buildPostback({ a: 'list' }) },
  ];
  if (result.reason === 'room_taken' || result.reason === 'all_booked') {
    return [quickReplyMsg(
      'その枠は、ちょうど他の方に取られてしまいました。\n別の時間を選んでください。', items)];
  }
  return [quickReplyMsg(result.message || '変更できませんでした。', items)];
}

// ---------------------------------------------------------------------------
// キャンセル（システム要件 2.5）
// ---------------------------------------------------------------------------

function cancelStep(ctx, userId, user, p) {
  const found = loadOwnReservation(ctx, userId, p.id);
  if (found.error) return found.error;
  const r = found.reservation;

  // 誤操作を防ぐため確認を1回挟む。確認画面には予約内容を再掲する。
  if (p.s !== 'done') {
    return [flexMsg('この予約をキャンセルしますか', flexDetailBubble(
      'この予約をキャンセルしますか',
      [
        { label: '日付', value: r.date + '（' + weekdayOf(r.date) + '）' },
        { label: '時間', value: r.start + ' 〜 ' + r.end },
        { label: '部屋', value: r.roomName },
        { label: '予約名', value: r.title },
      ],
      [
        { label: 'キャンセルする', primary: true, data: buildPostback({ a: 'cancel', id: r.id, s: 'done' }) },
        { label: 'やめる', data: buildPostback({ a: 'list' }) },
      ]
    ))];
  }

  const result = cancelReservation(ctx, p.id, { userId: userId, actor: userId });
  if (!result.ok) {
    return [quickReplyMsg(result.message || 'キャンセルできませんでした。', [
      { label: '予約の確認に戻る', data: buildPostback({ a: 'list' }) },
    ])];
  }

  return [quickReplyMsg(
    '予約をキャンセルしました。\n' +
    r.date + '（' + weekdayOf(r.date) + '） ' + r.start + '〜' + r.end + ' / ' + r.roomName + '\n\n' +
    'キャンセルのお知らせをメールでもお送りしました。添付ファイルを開くと、カレンダーの予定も削除されます。',
    [
      { label: '予約の確認に戻る', data: buildPostback({ a: 'list' }) },
      { label: '予約する', data: buildPostback({ a: 'new' }) },
    ]
  )];
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

function loadOwnReservation(ctx, userId, id) {
  const r = findReservationById(ctx, id);
  if (!r) {
    return { error: [quickReplyMsg('その予約は見つかりませんでした。', [
      { label: '予約の確認に戻る', data: buildPostback({ a: 'list' }) },
    ])] };
  }
  // ボタンを出さないだけでは、postback を直接送られた場合に防げない
  if (r.userId !== userId) {
    return { error: [textMsg('他の方の予約は変更・キャンセルできません。\n予約者ご本人か、管理者にご相談ください。')] };
  }
  if (r.status !== '確定') {
    return { error: [quickReplyMsg('その予約は既にキャンセルされています。', [
      { label: '予約の確認に戻る', data: buildPostback({ a: 'list' }) },
    ])] };
  }
  return { reservation: r };
}

/** 変更フローで省略した手順の値を、現在の予約から補う */
function fillFromReservation(p, r) {
  const q = withParams(p, {});
  if (q.f === 'datetime') {
    // 人数は現在値を引き継ぎ、P2 は省略する（システム要件 2.5）
    if (!q.n) q.n = r.headcount;
  } else {
    if (!q.d) q.d = dateToCompact(r.date);
    if (!q.t) q.t = timeToCompact(r.start);
    if (!q.dur) q.dur = timeToMinutes(r.end) - timeToMinutes(r.start);
    if (q.f !== 'num' && !q.n) q.n = r.headcount;
  }
  return q;
}
