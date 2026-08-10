/**
 * 共有カレンダーへの同期と、カレンダー追加リンクの生成
 *
 * 同期は Bot からカレンダーへの一方向のみ。カレンダー側の変更は取り込まない。
 * 呼び出しは必ずロックの外側から行う（技術仕様書 5.4）。
 * 外部APIの応答時間をロック保持時間に含めると、混雑時に全ユーザーが直列化する。
 *
 * 参照: 技術仕様書 5.4 / 8.2
 */

const PROP_CALENDAR_ID = 'CALENDAR_ID';
const CALENDAR_NAME = '会議室予約';

// ---------------------------------------------------------------------------
// カレンダーの準備
// ---------------------------------------------------------------------------

/**
 * 共有カレンダーを用意し、そのIDをスクリプトプロパティに保存する。
 * エディタから1回だけ実行する。2回目以降は既存の設定を報告するだけで、作り直さない。
 *
 * 設定シートではなくスクリプトプロパティに置くのは、管理者が誤って書き換えると
 * 全予約の同期先が変わり、既存のイベントIDが全て無効になるため。
 */
function setUpCalendar() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty(PROP_CALENDAR_ID);

  if (existing) {
    const cal = safeGetCalendar(existing);
    const msg = cal
      ? '設定済みです: ' + cal.getName() + '（' + existing + '）'
      : '設定されているカレンダーが見つかりません: ' + existing +
        '\nスクリプトプロパティ ' + PROP_CALENDAR_ID + ' を削除してから再実行してください。';
    Logger.log(msg);
    return msg;
  }

  const cal = CalendarApp.createCalendar(CALENDAR_NAME, {
    summary: '会議室の予約状況（Bot が自動で書き込みます。直接編集しても予約には反映されません）',
    timeZone: TIMEZONE,
  });
  props.setProperty(PROP_CALENDAR_ID, cal.getId());

  const msg =
    'カレンダーを作成しました: ' + cal.getName() + '\n' +
    'カレンダーID: ' + cal.getId() + '\n' +
    '（スクリプトプロパティ ' + PROP_CALENDAR_ID + ' に保存しました）\n\n' +
    '社員に見せるには、Google カレンダーの設定から、このカレンダーを共有してください。\n' +
    'カレンダー側で予定を直接編集しても、予約シートには反映されません。参照専用として扱ってください。';
  Logger.log(msg);
  return msg;
}

function getCalendarId() {
  return PropertiesService.getScriptProperties().getProperty(PROP_CALENDAR_ID) || '';
}

/** 存在しないIDを渡すと例外を投げる実装差があるため、包んで null を返す */
function safeGetCalendar(id) {
  try {
    return CalendarApp.getCalendarById(id);
  } catch (e) {
    return null;
  }
}

function safeGetEvent(cal, eventId) {
  try {
    return cal.getEventById(eventId);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 同期
// ---------------------------------------------------------------------------

/**
 * 予約1件をカレンダーへ反映する。finishWrite から呼ばれる（技術仕様書 5.1）。
 *
 * 例外は呼び出し元が捕捉し、予約シートの警告列に記録する。
 * 同期の失敗で予約を不成立にしてはならない。
 */
function syncCalendarForReservation(ctx, action, reservation) {
  const calId = getCalendarId();
  if (!calId) {
    Logger.log('共有カレンダーが未設定のため同期しません。setUpCalendar() を実行してください。');
    return;
  }
  const cal = safeGetCalendar(calId);
  if (!cal) throw new Error('共有カレンダーが見つかりません: ' + calId);

  if (action === 'キャンセル') {
    // 未同期の予約をキャンセルした場合は何もしない。削除すべき予定が存在しない。
    if (!reservation.calendarEventId) return;
    const ev = safeGetEvent(cal, reservation.calendarEventId);
    if (ev) ev.deleteEvent();
    // イベントIDは空欄に戻さない。空欄は「未同期」を意味し、
    // 戻すとキャンセル済みの予約が変更操作で再作成されてしまう（技術仕様書 5.4）。
    return;
  }

  const start = toDate(reservation.date, reservation.start);
  const end = toDate(reservation.date, reservation.end);
  const title = calendarTitle(reservation);
  const description = calendarDescription(reservation);

  const ev = reservation.calendarEventId ? safeGetEvent(cal, reservation.calendarEventId) : null;

  if (!ev) {
    // イベントIDが空欄、または予定が見つからない場合は作り直して同期を回復させる。
    // 「何もしない」にすると、一度失敗した予約が永久にカレンダーへ載らない。
    const created = cal.createEvent(title, start, end, {
      location: reservation.roomName,
      description: description,
    });
    saveCalendarEventId(ctx, reservation, created.getId());
    return;
  }

  ev.setTitle(title);
  ev.setTime(start, end);
  ev.setLocation(reservation.roomName);
  ev.setDescription(description);
}

/** 部屋ごとにカレンダーを分けないため、タイトルだけで部屋を判別できる必要がある（運用要件 T-19） */
function calendarTitle(r) {
  return r.title + '（' + r.roomName + '）';
}

function calendarDescription(r) {
  return [
    '予約者: ' + (r.userName || '（未登録）'),
    '人数: ' + r.headcount + '名',
    '予約ID: ' + r.id,
    r.note ? '備考: ' + r.note : '',
    '',
    'このカレンダーは自動で書き込まれます。ここで編集しても予約には反映されません。',
  ].filter(function (line) { return line !== ''; }).join('\n');
}

function saveCalendarEventId(ctx, reservation, eventId) {
  reservation.calendarEventId = eventId;
  if (!reservation._row) return;
  writeCell(ctx.tables.予約, reservation._row, 'カレンダーイベントID', eventId);
}

// ---------------------------------------------------------------------------
// カレンダー追加リンク（技術仕様書 8.2）
// ---------------------------------------------------------------------------

/**
 * Google カレンダーの予定作成画面を開くURL。
 *
 * ctz=Asia/Tokyo を必ず付ける。省くと dates が UTC として解釈され、9時間ずれて登録される。
 * openExternalBrowser=1 は、LINE のアプリ内ブラウザではなく外部ブラウザで開かせるため。
 * アプリ内ブラウザではカレンダーアプリへ引き渡されず、保存操作が煩雑になる。
 */
function googleCalendarLink(r) {
  const stamp = function (t) { return dateToCompact(r.date) + 'T' + timeToCompact(t) + '00'; };
  const params = {
    action: 'TEMPLATE',
    text: calendarTitle(r),
    dates: stamp(r.start) + '/' + stamp(r.end),
    ctz: TIMEZONE,
    location: r.roomName,
    details: linkDetails(r),
  };
  return 'https://calendar.google.com/calendar/render?' + buildQuery(params) +
    '&openExternalBrowser=1';
}

/**
 * Outlook の予定作成画面を開くURL。
 * 日時はオフセット付きの ISO 8601 で渡す。Google とは書式が異なるため共通化しない。
 */
function outlookCalendarLink(r) {
  const iso = function (t) { return r.date + 'T' + normalizeTime(t) + ':00+09:00'; };
  const params = {
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: calendarTitle(r),
    startdt: iso(r.start),
    enddt: iso(r.end),
    location: r.roomName,
    body: linkDetails(r),
  };
  return 'https://outlook.office.com/calendar/0/deeplink/compose?' + buildQuery(params) +
    '&openExternalBrowser=1';
}

function linkDetails(r) {
  return '人数: ' + r.headcount + '名 / 予約ID: ' + r.id;
}

/** 値は必ず URL エンコードする。予約名と備考は日本語で、記号も含まれうる。 */
function buildQuery(params) {
  return Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
}
