/**
 * 通知処理
 *
 * push API は一切使わない。ユーザーへの通知は reply とメールで完結させる。
 * これにより無料プランの通知上限が制約にならない（技術仕様書 8章）。
 *
 * 通知の失敗で予約を不成立にしてはならない。失敗はログに記録するに留める。
 */

/** UID に使うドメイン。実在する必要はないが、一度決めたら変えないこと。 */
const ICS_DOMAIN = 'meeting-room.line-bot';

/** 同種の例外通知を抑制する時間（秒）。例外がループするとメールのクォータを食い潰す。 */
const ALERT_INTERVAL_SEC = 3600;

// ---------------------------------------------------------------------------
// 予約者への通知
// ---------------------------------------------------------------------------

/**
 * 予約の作成・変更・キャンセルを予約者へメールで知らせる。finishWrite から呼ばれる。
 *
 * 管理者へは送らない。12室 × 1日16枠で理論上192件/日となり、業務に支障が出る。
 * 管理者は共有カレンダーで把握する（技術仕様書 8章）。
 */
function notifyReservation(ctx, action, reservation, before) {
  const mail = findUserMail(ctx, reservation.userId);
  if (!mail) {
    // 管理者が userId だけで代理予約した場合などに起きる。予約は成立させる。
    Logger.log('メールアドレスが未登録のため通知しません: ' + reservation.id);
    return;
  }

  // 作成は 0、それ以外は前回値 + 1。クライアントは SEQUENCE が前回より
  // 大きい通知だけを新しいと判断する。加算を怠ると更新もキャンセルも無視される。
  const sequence = (action === '作成') ? 0 : (Number(reservation.icsSequence) || 0) + 1;
  const ics = buildIcs(reservation, action, sequence, mail);

  MailApp.sendEmail({
    to: mail,
    subject: mailSubject(action),
    body: mailBody(action, reservation, before),
    attachments: [Utilities.newBlob(ics, icsMimeType(action), 'reservation.ics')],
  });

  // 送信できてから保存する。送る前に保存すると、送信に失敗した回の連番が
  // 相手に届かないまま消費される。
  if (sequence !== reservation.icsSequence && reservation._row) {
    writeCell(ctx.tables.予約, reservation._row, 'ics連番', sequence);
  }
  reservation.icsSequence = sequence;
}

/**
 * 利用者マスタからメールアドレスを引く。
 * 見つからない場合は一度だけ読み直す。同じリクエスト内で登録された直後は
 * loadContext 時点のデータに載っていないため。
 */
function findUserMail(ctx, userId) {
  if (!userId) return '';
  const hit = ctx.users[userId];
  if (hit && hit.mail) return hit.mail;

  ctx.tables.利用者マスタ = readTable(SHEET.利用者マスタ);
  ctx.users = readUsers(ctx.tables.利用者マスタ);
  const again = ctx.users[userId];
  return (again && again.mail) ? again.mail : '';
}

function mailSubject(action) {
  if (action === '作成') return '【会議室予約】予約を受け付けました';
  if (action === '変更') return '【会議室予約】予約内容を変更しました';
  return '【会議室予約】予約をキャンセルしました';
}

function mailBody(action, r, before) {
  const lines = [];

  if (action === 'キャンセル') {
    lines.push('以下の予約をキャンセルしました。');
  } else if (action === '変更') {
    lines.push('以下のとおり予約内容を変更しました。');
  } else {
    lines.push('以下のとおり予約を受け付けました。');
  }
  lines.push('');
  lines.push('　日付　　: ' + r.date + '（' + weekdayOf(r.date) + '）');
  lines.push('　時間　　: ' + r.start + ' 〜 ' + r.end);
  lines.push('　部屋　　: ' + r.roomName);
  lines.push('　人数　　: ' + r.headcount + '名');
  lines.push('　予約名　: ' + r.title);
  if (r.note) lines.push('　備考　　: ' + r.note);
  lines.push('　予約ID　: ' + r.id);

  if (action === '変更' && before) {
    const diff = describeChange('変更', r, before);
    if (diff && diff !== '変更なし') {
      lines.push('');
      lines.push('【変更内容】');
      lines.push('　' + diff);
    }
  }

  lines.push('');
  if (action === 'キャンセル') {
    lines.push('添付ファイルを開くと、ご自身のカレンダーからも予定が削除されます。');
  } else {
    lines.push('添付ファイルを開くと、ご自身のカレンダーに予定が登録されます。');
    lines.push('（変更・キャンセルの際は、その都度メールが届き、予定が自動で更新されます）');
  }
  lines.push('');
  lines.push('予約の確認・変更・キャンセルは LINE から行えます。');
  lines.push('このメールは自動送信です。返信しないでください。');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// .ics の生成（技術仕様書 8.1）
// ---------------------------------------------------------------------------

/**
 * iCalendar 形式の文字列を組み立てる。
 *
 * 日時は UTC に変換して末尾に Z を付ける。TZID を使う場合は VTIMEZONE の
 * 定義が必要になり、省くと解釈しないクライアントがある。日本には夏時間がないため、
 * UTC への変換は常に一意に定まる。
 *
 * UID は予約IDから作り、絶対に変えないこと。UID が変わると、
 * メールクライアントは別の予定として扱い、元の予定が残ったまま重複する。
 */
function buildIcs(reservation, action, sequence, attendeeMail) {
  const cancel = (action === 'キャンセル');
  const start = toDate(reservation.date, reservation.start);
  const end = toDate(reservation.date, reservation.end);
  const organizer = Session.getEffectiveUser().getEmail();

  const lines = [
    'BEGIN:VCALENDAR',
    // 非ASCIIを避ける。PRODID を読んで挙動を変えるクライアントがあるため。
    'PRODID:-//Meeting Room Reservation//LINE Bot//JA',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:' + (cancel ? 'CANCEL' : 'REQUEST'),
    'BEGIN:VEVENT',
    'UID:' + reservation.id + '@' + ICS_DOMAIN,
    'SEQUENCE:' + sequence,
    'DTSTAMP:' + utcStamp(new Date()),
    'DTSTART:' + utcStamp(start),
    'DTEND:' + utcStamp(end),
    'SUMMARY:' + icsEscape(calendarTitle(reservation)),
    'LOCATION:' + icsEscape(reservation.roomName),
    'DESCRIPTION:' + icsEscape(icsDescription(reservation)),
    'ORGANIZER;CN="' + icsQuoted(CALENDAR_NAME) + '":mailto:' + organizer,
    // RSVP=TRUE にしないと、Gmail は招待カードを出さず、ただの添付ファイルとして扱う。
    // 出欠の返信自体は誰も処理しないが、カレンダーへ取り込ませるにはこの指定が要る。
    'ATTENDEE;CN="' + icsQuoted(reservation.userName || '') + '"' +
      ';ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:' + attendeeMail,
    'STATUS:' + (cancel ? 'CANCELLED' : 'CONFIRMED'),
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // iCalendar の行区切りは CRLF と定められている
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

/**
 * 予約者本人のカレンダーに入る説明文。
 * 共有カレンダー向けの説明（calendarDescription）とは読み手が違う。
 * あちらは管理者が見る前提で「ここで編集しても反映されない」と書いてあるが、
 * 本人の予定にそれを入れても意味が通らない。
 */
function icsDescription(r) {
  return [
    '部屋: ' + r.roomName,
    '人数: ' + r.headcount + '名',
    '予約ID: ' + r.id,
    r.note ? '備考: ' + r.note : '',
    '',
    '変更・キャンセルは LINE から行ってください。この予定は自動で更新されます。',
  ].filter(function (line) { return line !== ''; }).join('\n');
}

/**
 * 1行を75オクテットで折り返す（RFC 5545 3.1）。
 *
 * 折り返さない長い行は、厳格なパーサーではファイルごと拒否される。
 * 日本語は1文字3オクテットなので、文字数ではなくオクテット数で数えること。
 * また、マルチバイト文字の途中で折ると文字が壊れるため、文字境界でのみ折る。
 * 継続行は先頭に空白1つを置く決まりなので、その分を引いた長さで区切る。
 */
function foldIcsLine(line) {
  const LIMIT = 74;   // 継続行の先頭の空白1オクテットぶんを残す
  const parts = [];
  let current = '';
  let bytes = 0;

  for (let i = 0; i < line.length; i++) {
    let ch = line.charAt(i);
    const code = line.charCodeAt(i);
    // サロゲートペア（絵文字など）は2つで1文字。分割すると壊れる。
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < line.length) {
      ch += line.charAt(i + 1);
      i++;
    }
    const size = utf8Size(ch);
    if (bytes + size > LIMIT) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);

  return parts.join('\r\n ');
}

function utf8Size(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c < 0x10000) return 3;
  return 4;
}

/** パラメータ値を二重引用符で囲むため、内側の引用符を落とす */
function icsQuoted(text) {
  return String(text).replace(/"/g, '');
}

/** 添付の MIME タイプ。application/octet-stream で送るとカレンダーへの取り込みが働かない。 */
function icsMimeType(action) {
  return 'text/calendar; charset=UTF-8; method=' + (action === 'キャンセル' ? 'CANCEL' : 'REQUEST');
}

function utcStamp(date) {
  return Utilities.formatDate(date, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
}

/** iCalendar のテキスト値では , ; \ と改行をエスケープする */
function icsEscape(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// ---------------------------------------------------------------------------
// 管理者への例外通知
// ---------------------------------------------------------------------------

/**
 * 障害を管理者へ知らせる。同種の通知は ALERT_INTERVAL_SEC に1通までとする。
 *
 * 抑制がないと、例外がループしたときにメールのクォータを使い切り、
 * 正常な予約通知まで届かなくなる。
 */
function notifyAdminError(ctx, kind, message) {
  try {
    const to = ctx && ctx.config ? ctx.config.adminMails : '';
    if (!to) return;

    const cache = CacheService.getScriptCache();
    const key = 'alert:' + kind;
    if (cache.get(key)) {
      Logger.log('例外通知を抑制しました（同種が送信済み）: ' + kind);
      return;
    }
    cache.put(key, '1', ALERT_INTERVAL_SEC);

    MailApp.sendEmail({
      to: to,
      subject: '【会議室予約】障害を検出しました（' + kind + '）',
      body: [
        '会議室予約システムで障害を検出しました。',
        '',
        message,
        '',
        '発生時刻: ' + nowStampStr(),
        '',
        '同じ種類の通知は ' + Math.round(ALERT_INTERVAL_SEC / 60) + ' 分に1通までに抑えています。',
        '詳細は Apps Script の実行ログを確認してください。',
      ].join('\n'),
    });
  } catch (e) {
    // 通知処理自体の失敗で呼び出し元を壊さない
    Logger.log('管理者への例外通知に失敗: ' + e);
  }
}
