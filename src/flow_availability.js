/**
 * 空き状況照会（システム要件 2.6）
 *
 * 12室 × 18時間帯の全体表はスマートフォンで判読できないため、
 * 時刻で絞ってから部屋を縦に並べる。
 *
 * 各部屋は3状態で表す。2値（空き／埋まり）にしてはならない。
 * 定例枠や臨時ブロックの部屋が「予約者不明で埋まっている」と見え、
 * 存在しない予約者への交渉を試みることになる。
 */

const STATUS_STYLE = {
  '予約済み': { badge: '● 予約済み', color: '#C0392B' },
  '予約不可': { badge: '● 予約不可', color: '#7F8C8D' },
  '空き': { badge: '● 空き', color: '#1E8449' },
};

function availabilityStep(ctx, userId, p) {
  if (!p.d) return askDate(ctx, { a: 'avail' }, '空き状況を見たい日を選んでください。');
  if (!p.t) return askAvailabilityTime(ctx, p);
  return showRoomStatuses(ctx, p);
}

function askAvailabilityTime(ctx, p) {
  const date = compactToDate(p.d);
  const res = listAvailabilityTimes(ctx, date);

  if (res.times.length === 0) {
    const msg = res.reason === 'closed_day'
      ? date + '（' + weekdayOf(date) + '）は休業日です。'
      : '本日の営業時間は終了しました。翌日以降の日付を選んでください。';
    return [quickReplyMsg(msg, [
      { label: '別の日を見る', data: buildPostback({ a: 'avail' }) },
    ])];
  }

  const buttons = res.times.map(function (t) {
    return { label: t, data: buildPostback(withParams(p, { t: timeToCompact(t) })) };
  });
  return [flexButtonList(
    '時刻を選んでください',
    date + '（' + weekdayOf(date) + '）の空き状況',
    '見たい時刻を選ぶと、その時刻からの全部屋の状況を表示します。',
    buttons
  )];
}

function showRoomStatuses(ctx, p) {
  const date = compactToDate(p.d);
  const start = compactToTime(p.t);
  const end = addMinutes(start, ctx.config.minMinutes);

  const statuses = getRoomStatuses(ctx, date, start, end);

  const rows = statuses.map(function (s) {
    const style = STATUS_STYLE[s.status];
    let detail = '';
    if (s.status === '予約済み') {
      // 予約者と予約名を出すのは、ユーザーが直接交渉できるようにするため（G-U10）
      detail = s.title + '（' + (s.userName || '予約者不明') + '）';
    } else if (s.status === '予約不可') {
      detail = s.reason;
    } else {
      detail = '定員 ' + capacityLabel(s.room);
    }
    return { badge: style.badge, color: style.color, name: s.room.name, detail: detail };
  });

  const free = statuses.filter(function (s) { return s.status === '空き'; }).length;

  return [
    flexStatusList(
      date + ' ' + start + '〜' + end + ' の空き状況',
      date + '（' + weekdayOf(date) + '） ' + start + '〜' + end,
      '空き ' + free + ' 室 / 全 ' + statuses.length + ' 室',
      rows
    ),
    quickReplyMsg('この時間で予約しますか。', [
      { label: 'この時間で予約する', data: buildPostback({ a: 'new', d: p.d }) },
      { label: '別の時刻を見る', data: buildPostback({ a: 'avail', d: p.d }) },
      { label: '別の日を見る', data: buildPostback({ a: 'avail' }) },
    ]),
  ];
}
