/**
 * 空き判定のテスト
 *
 * core_availability.js の関数は ctx だけを見る純粋関数なので、
 * 合成したデータで検証できる。シートには一切触れない。
 * エディタから testAvailability() を実行する。
 */

function testAvailability() {
  const t = newRunner();

  // 曜日が固定されたテスト日を用意する（火曜と土曜）
  const TUE = nextWeekdayDate('火');
  const SAT = nextWeekdayDate('土');

  // --- 基本 -----------------------------------------------------------------
  t.group('基本の割当');
  {
    const ctx = fakeCtx();
    const r = findAvailableRooms(ctx, { date: TUE, start: '10:00', end: '11:00', headcount: 6 });
    t.eq('6名で予約できる部屋がある', r.rooms.length > 0, true);
    t.eq('先頭は定員最小の6人部屋', r.rooms[0].id, 'R6A');
    t.eq('個人ブースは候補外', r.rooms.some(function (x) { return x.id === 'B1'; }), false);
    t.eq('無効な部屋は候補外', r.rooms.some(function (x) { return x.id === 'OFF'; }), false);
    t.eq('大会議室は末尾', r.rooms[r.rooms.length - 1].id, 'BIG');
    t.eq('おまかせは6人部屋A', pickAutoRoom(r.rooms).id, 'R6A');
  }

  // --- 境界の重複 -----------------------------------------------------------
  t.group('時間帯の境界');
  {
    const ctx = fakeCtx({
      reservations: [res('X1', 'R6A', TUE, '10:00', '11:00')],
    });
    const after = findAvailableRooms(ctx, { date: TUE, start: '11:00', end: '12:00', headcount: 6 });
    t.eq('直後の枠は同じ部屋で取れる（境界は重複としない）',
      after.rooms.some(function (x) { return x.id === 'R6A'; }), true);

    const overlap = findAvailableRooms(ctx, { date: TUE, start: '10:30', end: '11:30', headcount: 6 });
    t.eq('重なる枠は同じ部屋で取れない',
      overlap.rooms.some(function (x) { return x.id === 'R6A'; }), false);
    t.eq('他の部屋なら取れる',
      overlap.rooms.some(function (x) { return x.id === 'R6B'; }), true);
  }

  // --- 変更時の自己除外 ------------------------------------------------------
  t.group('変更時に自分自身を除外する');
  {
    const ctx = fakeCtx({
      reservations: [res('X1', 'R6A', TUE, '10:00', '11:00')],
    });
    const noExclude = findAvailableRooms(ctx, { date: TUE, start: '10:00', end: '12:00', headcount: 6 });
    t.eq('除外しないと自分と重複して延長できない',
      noExclude.rooms.some(function (x) { return x.id === 'R6A'; }), false);

    const excluded = findAvailableRooms(ctx, {
      date: TUE, start: '10:00', end: '12:00', headcount: 6, excludeId: 'X1',
    });
    t.eq('除外すれば延長できる',
      excluded.rooms.some(function (x) { return x.id === 'R6A'; }), true);
  }

  // --- 定例枠 ---------------------------------------------------------------
  t.group('定例枠（区間の隙間）');
  {
    // 大会議室の火曜を 09:00-10:00 と 12:00-18:00 の2区間にする → 10:00-12:00 が定例枠
    const rh = { BIG: {} };
    rh.BIG['火'] = [{ open: '09:00', close: '10:00' }, { open: '12:00', close: '18:00' }];
    const ctx = fakeCtx({ roomHours: rh });

    const inGap = findAvailableRooms(ctx, { date: TUE, start: '10:00', end: '12:00', headcount: 20 });
    t.eq('定例枠は予約できない', inGap.rooms.length, 0);

    const before = findAvailableRooms(ctx, { date: TUE, start: '09:00', end: '10:00', headcount: 20 });
    t.eq('定例枠の前は予約できる', before.rooms.length > 0, true);

    const across = findAvailableRooms(ctx, { date: TUE, start: '09:30', end: '12:30', headcount: 20 });
    t.eq('2区間にまたがる予約はできない', across.rooms.length, 0);

    // 他の部屋は影響を受けない
    const other = findAvailableRooms(ctx, { date: TUE, start: '10:00', end: '12:00', headcount: 6 });
    t.eq('設定のない部屋は営業時間に従う', other.rooms.length > 0, true);
  }

  t.group('終日予約不可（時刻を両方空欄にした行）');
  {
    const rh = { R6A: {} };
    rh.R6A['火'] = 'closed';
    const ctx = fakeCtx({ roomHours: rh });
    const r = findAvailableRooms(ctx, { date: TUE, start: '10:00', end: '11:00', headcount: 6 });
    t.eq('終日不可の部屋は候補外', r.rooms.some(function (x) { return x.id === 'R6A'; }), false);
    t.eq('他の部屋は取れる', r.rooms.some(function (x) { return x.id === 'R6B'; }), true);
  }

  // --- 臨時ブロック ---------------------------------------------------------
  t.group('臨時ブロック');
  {
    const all = fakeCtx({ blocks: [{ roomId: '', date: TUE, start: '00:00', end: '24:00' }] });
    t.eq('部屋ID空欄は全部屋に効く（祝日の設定）',
      findAvailableRooms(all, { date: TUE, start: '10:00', end: '11:00', headcount: 6 }).rooms.length, 0);

    const one = fakeCtx({ blocks: [{ roomId: 'R6A', date: TUE, start: '10:00', end: '12:00' }] });
    const r = findAvailableRooms(one, { date: TUE, start: '10:00', end: '11:00', headcount: 6 });
    t.eq('部屋を指定したブロックはその部屋だけ',
      r.rooms.some(function (x) { return x.id === 'R6A'; }), false);
    t.eq('他の部屋は取れる', r.rooms.some(function (x) { return x.id === 'R6B'; }), true);
  }

  // --- 定員 -----------------------------------------------------------------
  t.group('定員');
  {
    const ctx = fakeCtx();
    const big = findAvailableRooms(ctx, { date: TUE, start: '10:00', end: '11:00', headcount: 100 });
    t.eq('100名でも大会議室が割り当たる（定員なし）', big.rooms.length, 1);
    t.eq('割り当たるのは大会議室', big.rooms[0].id, 'BIG');

    const one = findAvailableRooms(ctx, { date: TUE, start: '10:00', end: '11:00', headcount: 1 });
    t.eq('1名のおまかせは個人ブース', pickAutoRoom(one.rooms).id, 'B1');

    const seven = findAvailableRooms(ctx, { date: TUE, start: '10:00', end: '11:00', headcount: 7 });
    t.eq('7名は6人部屋を飛ばして12人部屋', pickAutoRoom(seven.rooms).id, 'R12');
  }

  // --- 受付期間 -------------------------------------------------------------
  t.group('受付期間（締切0＝開始時刻が締切）');
  {
    const ctx = fakeCtx();
    const past = addDays(nowDateStr(), -1);
    const r1 = findAvailableRooms(ctx, { date: past, start: '10:00', end: '11:00', headcount: 6 });
    t.eq('過去の日付は予約できない', r1.reason, 'past_deadline');

    const far = addDays(nowDateStr(), 61);
    const r2 = findAvailableRooms(ctx, { date: far, start: '10:00', end: '11:00', headcount: 6 });
    t.eq('予約可能日数を超えると予約できない', r2.reason, 'too_far');

    const skip = findAvailableRooms(ctx, {
      date: past, start: '10:00', end: '11:00', headcount: 6, skipWindow: true,
    });
    t.eq('管理者操作（skipWindow）では締切を適用しない', skip.reason !== 'past_deadline', true);
  }

  // --- 営業時間 -------------------------------------------------------------
  t.group('営業時間');
  {
    const ctx = fakeCtx();
    t.eq('休業日は予約できない',
      findAvailableRooms(ctx, { date: SAT, start: '10:00', end: '11:00', headcount: 6 }).reason, 'closed_day');
    t.eq('営業開始前は予約できない',
      findAvailableRooms(ctx, { date: TUE, start: '08:00', end: '09:00', headcount: 6 }).reason, 'outside_hours');
    t.eq('営業終了をまたぐと予約できない',
      findAvailableRooms(ctx, { date: TUE, start: '17:30', end: '18:30', headcount: 6 }).reason, 'outside_hours');
    t.eq('営業終了ちょうどは予約できる',
      findAvailableRooms(ctx, { date: TUE, start: '17:30', end: '18:00', headcount: 6 }).rooms.length > 0, true);
  }

  // --- 空き状況照会 ---------------------------------------------------------
  t.group('空き状況の3状態');
  {
    const rh = { R6B: {} };
    rh.R6B['火'] = 'closed';
    const ctx = fakeCtx({
      roomHours: rh,
      reservations: [res('X1', 'R6A', TUE, '10:00', '11:00', '山田太郎', '定例会議')],
      blocks: [{ roomId: 'R12', date: TUE, start: '10:00', end: '11:00' }],
    });
    const st = getRoomStatuses(ctx, TUE, '10:00', '10:30');
    const by = {};
    st.forEach(function (s) { by[s.room.id] = s; });

    t.eq('予約済みの部屋', by['R6A'].status, '予約済み');
    t.eq('予約者名が出る', by['R6A'].userName, '山田太郎');
    t.eq('予約名が出る', by['R6A'].title, '定例会議');
    t.eq('定例枠は「予約不可」（予約済みではない）', by['R6B'].status, '予約不可');
    t.eq('定例枠に予約者名は出ない', by['R6B'].userName, '');
    t.eq('臨時ブロックも「予約不可」', by['R12'].status, '予約不可');
    t.eq('空いている部屋', by['BIG'].status, '空き');
    t.eq('無効な部屋は一覧に出ない', by['OFF'] === undefined, true);
  }

  // --- 選択肢の生成 ---------------------------------------------------------
  t.group('選択肢の生成');
  {
    const ctx = fakeCtx();
    const times = listStartTimes(ctx, TUE, 6);
    t.eq('開始時刻の候補は 09:00 から', times.times[0], '09:00');
    t.eq('候補の末尾は 17:30（30分確保できる最後）', times.times[times.times.length - 1], '17:30');
    t.eq('候補数は18件', times.times.length, 18);

    const durs = listDurations(ctx, TUE, '17:30', 6);
    t.eq('17:30 開始で選べるのは30分だけ', durs.length, 1);
    t.eq('その表示は「営業終了まで」', durs[0].label.indexOf('営業終了まで') === 0, true);

    const heads = listHeadcounts(ctx);
    t.eq('人数の選択肢は定員から生成される', heads.join(','), '1,6,12');
  }

  return t.report();
}

// ---------------------------------------------------------------------------
// テスト用の道具
// ---------------------------------------------------------------------------

function fakeCtx(overrides) {
  const bh = {};
  ['月', '火', '水', '木', '金'].forEach(function (d) {
    bh[d] = { active: true, open: '09:00', close: '18:00' };
  });
  ['土', '日'].forEach(function (d) {
    bh[d] = { active: false, open: null, close: null };
  });

  const base = {
    config: {
      deadlineMinutes: 0, bookableDays: 60, slotMinutes: 30,
      minMinutes: 30, defaultHeadcount: 6, adminMails: '',
    },
    businessHours: bh,
    rooms: [
      { id: 'B1', name: '個人ブース1', capacity: 1, order: 1, active: true },
      { id: 'R6A', name: '6人部屋A', capacity: 6, order: 5, active: true },
      { id: 'R6B', name: '6人部屋B', capacity: 6, order: 6, active: true },
      { id: 'R12', name: '12人部屋', capacity: 12, order: 10, active: true },
      { id: 'BIG', name: '大会議室', capacity: Infinity, order: 12, active: true },
      { id: 'OFF', name: '廃止した部屋', capacity: 6, order: 99, active: false },
    ],
    roomHours: {},
    blocks: [],
    reservations: [],
    users: {},
    warnings: [],
  };
  Object.keys(overrides || {}).forEach(function (k) { base[k] = overrides[k]; });
  return base;
}

function res(id, roomId, date, start, end, userName, title) {
  return {
    id: id, roomId: roomId, roomName: roomId, date: date, start: start, end: end,
    headcount: 1, title: title || '', userId: 'U1', userName: userName || '',
    note: '', status: '確定', source: 'ユーザー',
    calendarEventId: '', icsSequence: 0, _row: 2,
  };
}

/** 今日以降で、指定した曜日に最初に該当する日付を返す（テストの再現性のため） */
function nextWeekdayDate(weekday) {
  let d = addDays(nowDateStr(), 1);
  for (let i = 0; i < 8; i++) {
    if (weekdayOf(d) === weekday) return d;
    d = addDays(d, 1);
  }
  return d;
}

function newRunner() {
  const lines = [];
  let pass = 0;
  const failed = [];

  return {
    group: function (name) { lines.push(''); lines.push('=== ' + name + ' ==='); },
    eq: function (label, actual, expected) {
      if (actual === expected) {
        pass++;
        lines.push('  OK   ' + label);
      } else {
        failed.push(label);
        lines.push('  NG   ' + label + ' — 結果 ' + fmt(actual) + ' / 期待 ' + fmt(expected));
      }
    },
    report: function () {
      lines.push('');
      lines.push(failed.length === 0
        ? '★ ' + pass + ' 件すべて通過しました。'
        : '★ ' + failed.length + ' 件が失敗（成功 ' + pass + ' 件）: ' + failed.join(' / '));
      const text = lines.join('\n');
      Logger.log(text);
      return text;
    },
  };
}

function fmt(v) {
  if (v === Infinity) return '∞';
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  return String(v);
}
