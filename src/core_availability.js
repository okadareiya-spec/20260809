/**
 * 空き判定
 *
 * 本ファイルの関数は、すべて loadContext() の戻り値（ctx）だけを見て判定する純粋関数とする。
 * シートに触らないので、テストでは合成した ctx を渡して検証できる。
 *
 * 参照: 技術仕様書 3.4 / 3.5 / 3.6、運用要件定義書 5.2 / 5.4
 */

// ---------------------------------------------------------------------------
// 受付締切の判定（技術仕様書 3.6）
// ---------------------------------------------------------------------------

/**
 * 受付期間内かを判定する。
 *
 * 空き判定の内部に閉じ込めてはならない。空き判定は新規・変更でしか呼ばれず、
 * キャンセルの経路では呼ばれないため、独立した関数として全経路から呼ぶ必要がある。
 *
 * 受付締切の既定値は 0 だが、これは「締切なし」ではなく「開始時刻が締切」を意味する。
 * 0 だからといってこの判定を省くと、古い操作から過去の枠に予約が入る。
 * 設定値を式に代入するだけで、締切の有無に関わらず同じ処理が機能する。
 */
function checkBookingWindow(ctx, dateStr, startTime) {
  const today = nowDateStr();
  const daysAhead = diffDays(today, dateStr);

  if (daysAhead > ctx.config.bookableDays) {
    return {
      ok: false,
      reason: 'too_far',
      message: '予約できるのは' + ctx.config.bookableDays + '日先までです。',
    };
  }

  const requested = toAbsoluteMinutes(dateStr, startTime);
  const limit = nowAbsoluteMinutes() + ctx.config.deadlineMinutes;

  if (requested < limit) {
    return {
      ok: false,
      reason: 'past_deadline',
      message: ctx.config.deadlineMinutes > 0
        ? '開始時刻の' + ctx.config.deadlineMinutes + '分前を過ぎているため、操作できません。'
        : '開始時刻を過ぎているため、操作できません。',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 予約可能な部屋を求める（技術仕様書 3.4）
// ---------------------------------------------------------------------------

/**
 * @param req.date        'YYYY-MM-DD'
 * @param req.start       'HH:mm'
 * @param req.end         'HH:mm'
 * @param req.headcount   利用人数
 * @param req.excludeId   変更時に判定から外す予約ID（省略可）
 * @param req.skipWindow  受付期間の判定を飛ばす（管理者操作・空き状況照会で使う）
 * @return { rooms: [room], reason: null | string, message: string }
 */
function findAvailableRooms(ctx, req) {
  // --- 手順0: 受付期間 ---
  if (!req.skipWindow) {
    const w = checkBookingWindow(ctx, req.date, req.start);
    if (!w.ok) return { rooms: [], reason: w.reason, message: w.message };
  }

  // --- 手順1: 営業時間 ---
  const wd = weekdayOf(req.date);
  const bh = ctx.businessHours[wd];
  if (!bh || !bh.active) {
    return { rooms: [], reason: 'closed_day', message: 'その日は休業日です。' };
  }
  if (!contains(bh.open, bh.close, req.start, req.end)) {
    return {
      rooms: [], reason: 'outside_hours',
      message: 'その日の利用可能な時間は ' + bh.open + '〜' + bh.close + ' です。',
    };
  }

  // --- 手順2: 部屋の絞り込み（有効かつ人数を収容できる） ---
  // 定員が空欄の部屋は Infinity として扱うため、人数によらず常に候補に含まれる。
  const candidates = ctx.rooms.filter(function (r) {
    return r.active && r.capacity >= req.headcount;
  });
  if (candidates.length === 0) {
    return { rooms: [], reason: 'no_capacity', message: 'その人数を収容できる部屋がありません。' };
  }

  // --- 手順3: 各部屋の判定 ---
  const available = candidates.filter(function (room) {
    return isRoomOpen(ctx, room, req.date, wd, req.start, req.end)
      && !isBlocked(ctx, room, req.date, req.start, req.end)
      && !hasConflict(ctx, room, req.date, req.start, req.end, req.excludeId);
  });

  if (available.length === 0) {
    return { rooms: [], reason: 'all_booked', message: 'その時間に空いている部屋がありません。' };
  }

  // --- 手順4: 並べ替え ---
  return { rooms: sortRooms(available), reason: null, message: '' };
}

/**
 * 部屋別予約可能時間の判定。
 * 行が存在する場合、要求時間帯がいずれか1つの区間に完全に収まること。
 * 複数区間にまたがる場合は不可（間の定例枠を踏むため）。
 * 行が存在しない場合は営業帯に従う（手順1で確認済み）。
 */
function isRoomOpen(ctx, room, dateStr, weekday, start, end) {
  const perRoom = ctx.roomHours[room.id];
  if (!perRoom) return true;

  const spans = perRoom[weekday];
  if (spans === undefined) return true;      // その曜日の指定なし → 営業時間に従う
  if (spans === 'closed') return false;      // 終日予約不可

  return spans.some(function (s) { return contains(s.open, s.close, start, end); });
}

/** 臨時ブロックと重複するか。部屋IDが空欄のブロックは全部屋に適用する。 */
function isBlocked(ctx, room, dateStr, start, end) {
  return ctx.blocks.some(function (b) {
    if (b.date !== dateStr) return false;
    if (b.roomId !== '' && b.roomId !== room.id) return false;
    return overlaps(start, end, b.start, b.end);
  });
}

/**
 * 既存の確定予約と重複するか。
 *
 * excludeId が指定されている場合、その予約は判定対象から外す。
 * 除外を忘れると、10:00-11:00 の予約を 10:00-12:00 に延長する変更が
 * 常に「重複」と判定され、その予約は永久に変更できなくなる。
 */
function hasConflict(ctx, room, dateStr, start, end, excludeId) {
  return ctx.reservations.some(function (r) {
    if (r.status !== '確定') return false;
    if (r.roomId !== room.id) return false;
    if (r.date !== dateStr) return false;
    if (excludeId && r.id === excludeId) return false;
    return overlaps(start, end, r.start, r.end);
  });
}

/**
 * 定員の昇順 → 表示順の昇順 → 部屋IDの昇順。
 *
 * 定員が空欄（Infinity）の部屋は常に末尾に来る。
 * 空欄を 0 や空文字として扱うと大会議室が先頭に来て、
 * おまかせ割当で常に最初に選ばれてしまう。
 */
function sortRooms(rooms) {
  return rooms.slice().sort(function (a, b) {
    if (a.capacity !== b.capacity) return a.capacity - b.capacity;
    if (a.order !== b.order) return a.order - b.order;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
}

/**
 * おまかせ割当。並べ替え済みの先頭＝人数を収容できる最小の部屋を返す。
 * 個人ブース → 6人部屋 → 12人部屋 → 大会議室 の順に埋まるため、
 * 大きい部屋が少人数に占有されて後続の大人数予約が入らなくなる事態を防げる。
 */
function pickAutoRoom(rooms) {
  return rooms.length ? rooms[0] : null;
}

// ---------------------------------------------------------------------------
// 空き状況照会（技術仕様書 3.5）
// ---------------------------------------------------------------------------

/**
 * 有効な全部屋について、状態と付随情報を返す。
 *
 * 「予約可能な部屋の補集合＝予約済み」と実装してはならない。
 * 定例枠や臨時ブロックの部屋が「予約者不明で埋まっている」と表示され、
 * ユーザーが存在しない予約者への交渉を試みることになる。
 * 判定の順序は 予約済み → 予約不可 → 空き とする。
 *
 * @return [{ room, status: '予約済み'|'予約不可'|'空き', userName, title, reason }]
 */
function getRoomStatuses(ctx, dateStr, start, end) {
  const wd = weekdayOf(dateStr);
  const bh = ctx.businessHours[wd];
  const dayClosed = !bh || !bh.active;

  return sortRooms(ctx.rooms.filter(function (r) { return r.active; }))
    .map(function (room) {
      const booked = findConflictingReservation(ctx, room, dateStr, start, end);
      if (booked) {
        return {
          room: room, status: '予約済み',
          userName: booked.userName, title: booked.title, reason: '',
        };
      }
      if (dayClosed) {
        return { room: room, status: '予約不可', userName: '', title: '', reason: '休業日' };
      }
      if (!contains(bh.open, bh.close, start, end)) {
        return { room: room, status: '予約不可', userName: '', title: '', reason: '営業時間外' };
      }
      if (!isRoomOpen(ctx, room, dateStr, wd, start, end)) {
        return { room: room, status: '予約不可', userName: '', title: '', reason: '定例' };
      }
      if (isBlocked(ctx, room, dateStr, start, end)) {
        return { room: room, status: '予約不可', userName: '', title: '', reason: '使用不可' };
      }
      return { room: room, status: '空き', userName: '', title: '', reason: '' };
    });
}

function findConflictingReservation(ctx, room, dateStr, start, end) {
  for (let i = 0; i < ctx.reservations.length; i++) {
    const r = ctx.reservations[i];
    if (r.status !== '確定') continue;
    if (r.roomId !== room.id) continue;
    if (r.date !== dateStr) continue;
    if (overlaps(start, end, r.start, r.end)) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 選択肢の生成（システム要件 2.1 / 2.3）
// ---------------------------------------------------------------------------

/**
 * 開始時刻の候補を返す。
 *
 * 表示条件は3つ。
 *   1. その日の営業時間内
 *   2. 指定人数を収容できる部屋が、最短予約時間だけ空いている
 *   3. 受付締切を過ぎていない
 *
 * 人数を開始時刻より先に取得するのは、2番目の条件のためである。
 * 人数が未確定では「空いている部屋があるか」を判定できない。
 *
 * 刻みの起点はその日の営業開始時刻とする（00:00 起点にすると、
 * 営業開始が 09:15 のような設定で候補がずれる）。
 */
function listStartTimes(ctx, dateStr, headcount, excludeId) {
  const wd = weekdayOf(dateStr);
  const bh = ctx.businessHours[wd];
  if (!bh || !bh.active) return { times: [], reason: 'closed_day' };

  const step = ctx.config.slotMinutes;
  const min = ctx.config.minMinutes;
  const openMin = timeToMinutes(bh.open);
  const closeMin = timeToMinutes(bh.close);

  const times = [];
  for (let t = openMin; t + min <= closeMin; t += step) {
    const start = minutesToTime(t);
    const end = minutesToTime(t + min);
    const res = findAvailableRooms(ctx, {
      date: dateStr, start: start, end: end, headcount: headcount, excludeId: excludeId,
    });
    if (res.rooms.length > 0) times.push(start);
  }
  return { times: times, reason: times.length ? null : 'no_slot' };
}

/**
 * 利用時間の候補を返す。選択済みの開始時刻から確保できない長さは含めない。
 * 末尾の「営業終了まで」は、開始時刻からその日の営業終了時刻までを指す。
 */
function listDurations(ctx, dateStr, startTime, headcount, excludeId) {
  const wd = weekdayOf(dateStr);
  const bh = ctx.businessHours[wd];
  if (!bh || !bh.active) return [];

  const step = ctx.config.slotMinutes;
  const min = ctx.config.minMinutes;
  const startMin = timeToMinutes(startTime);
  const closeMin = timeToMinutes(bh.close);

  const list = [];
  for (let d = min; startMin + d <= closeMin; d += step) {
    const end = minutesToTime(startMin + d);
    const res = findAvailableRooms(ctx, {
      date: dateStr, start: startTime, end: end, headcount: headcount, excludeId: excludeId,
    });
    if (res.rooms.length === 0) break;   // これ以上延ばしても空かない
    list.push({ minutes: d, label: durationLabel(d), end: end });
  }
  // 末尾を「営業終了まで」に読み替える
  if (list.length && list[list.length - 1].end === bh.close) {
    list[list.length - 1].label = '営業終了まで（' + bh.close + '）';
  }
  return list;
}

function durationLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return m + '分';
  return h + '時間' + (m ? m + '分' : '');
}

/**
 * 空き状況照会で選べる開始時刻。
 *
 * 予約フローの listStartTimes と違い、空き部屋の有無では絞らない。
 * 「全室満室」も見たい情報だからである。ただし受付締切は同じく適用する。
 * 除外しないと、「空き」と表示された枠が実際には予約できない食い違いが生じる。
 */
function listAvailabilityTimes(ctx, dateStr) {
  const bh = ctx.businessHours[weekdayOf(dateStr)];
  if (!bh || !bh.active) return { times: [], reason: 'closed_day' };

  const times = [];
  const closeMin = timeToMinutes(bh.close);
  for (let t = timeToMinutes(bh.open); t + ctx.config.minMinutes <= closeMin; t += ctx.config.slotMinutes) {
    const start = minutesToTime(t);
    if (!checkBookingWindow(ctx, dateStr, start).ok) continue;
    times.push(start);
  }
  return { times: times, reason: times.length ? null : 'past_deadline' };
}

/** 人数の選択肢。部屋マスタの定員から生成する（定数を直書きしない）。 */
function listHeadcounts(ctx) {
  const caps = {};
  ctx.rooms.forEach(function (r) {
    if (r.active && r.capacity !== Infinity) caps[r.capacity] = true;
  });
  const list = Object.keys(caps).map(Number).sort(function (a, b) { return a - b; });
  if (list.indexOf(ctx.config.defaultHeadcount) < 0) {
    list.push(ctx.config.defaultHeadcount);
    list.sort(function (a, b) { return a - b; });
  }
  return list;
}
