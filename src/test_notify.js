/**
 * 通知とカレンダー連携のテスト
 *
 * testNotify() は外部へ何も送らない。文字列の組み立てだけを検証する。
 * 実際の送信とカレンダー操作は verifyNotifyLive() で確認する（12.1 V-6 / V-7）。
 */

function testNotify() {
  const t = newRunner();
  const r = sampleReservation();

  // --- .ics の骨格 ---------------------------------------------------------
  t.group('.ics の生成');
  const ics = buildIcs(r, '作成', 0, 'user@example.com');

  t.eq('UID は予約IDから作られる', ics.indexOf('UID:' + r.id + '@') >= 0, true);
  t.eq('METHOD は REQUEST', ics.indexOf('METHOD:REQUEST') >= 0, true);
  t.eq('STATUS は CONFIRMED', ics.indexOf('STATUS:CONFIRMED') >= 0, true);
  t.eq('SEQUENCE は 0', ics.indexOf('SEQUENCE:0') >= 0, true);
  t.eq('行区切りは CRLF', ics.indexOf('\r\n') >= 0, true);
  t.eq('LF だけの行がない', /[^\r]\n/.test(ics), false);

  // 14:00 JST は 05:00 UTC。ここがずれると予定が9時間ずれて登録される。
  t.eq('DTSTART は UTC に変換される', ics.indexOf('DTSTART:20260923T050000Z') >= 0, true);
  t.eq('DTEND は UTC に変換される', ics.indexOf('DTEND:20260923T060000Z') >= 0, true);

  // --- 変更・キャンセル -----------------------------------------------------
  t.group('.ics の種別');
  const changed = buildIcs(r, '変更', 1, 'user@example.com');
  t.eq('変更は REQUEST のまま', changed.indexOf('METHOD:REQUEST') >= 0, true);
  t.eq('変更で SEQUENCE が加算される', changed.indexOf('SEQUENCE:1') >= 0, true);

  const cancelled = buildIcs(r, 'キャンセル', 2, 'user@example.com');
  t.eq('キャンセルは CANCEL', cancelled.indexOf('METHOD:CANCEL') >= 0, true);
  t.eq('キャンセルは CANCELLED', cancelled.indexOf('STATUS:CANCELLED') >= 0, true);
  t.eq('キャンセルでも UID は同じ', cancelled.indexOf('UID:' + r.id + '@') >= 0, true);

  t.eq('MIME タイプは text/calendar', icsMimeType('作成').indexOf('text/calendar') === 0, true);
  t.eq('MIME に method が入る', icsMimeType('キャンセル').indexOf('method=CANCEL') > 0, true);

  // --- 招待として扱われるための指定 -------------------------------------------
  t.group('招待の指定');
  // RSVP=FALSE だと Gmail は招待カードを出さず、ただの添付ファイルとして扱う
  t.eq('RSVP=TRUE', ics.indexOf('RSVP=TRUE') > 0, true);
  t.eq('PARTSTAT が入る', ics.indexOf('PARTSTAT=NEEDS-ACTION') > 0, true);
  t.eq('ROLE が入る', ics.indexOf('ROLE=REQ-PARTICIPANT') > 0, true);
  t.eq('出席者は宛先と一致する', ics.indexOf('mailto:user@example.com') > 0, true);
  t.eq('TRANSP は OPAQUE', ics.indexOf('TRANSP:OPAQUE') > 0, true);
  // PRODID を読んで挙動を変えるクライアントがあるため、非ASCIIを入れない
  t.eq('PRODID は ASCII のみ', /PRODID:[\x20-\x7E]+\r\n/.test(ics), true);

  // --- 行の折り返し（RFC 5545 3.1）--------------------------------------------
  t.group('行の折り返し');
  const long = sampleReservation();
  long.note = 'これは折り返しの確認のための備考です。' + 'あいうえおかきくけこ'.repeat(10);
  const folded = buildIcs(long, '作成', 0, 'user@example.com');

  const over = folded.split('\r\n').filter(function (l) { return octetLength(l) > 75; });
  // 折り返さない長い行は、厳格なパーサーではファイルごと拒否される
  t.eq('75オクテットを超える行がない', over.length, 0);
  t.eq('継続行は空白で始まる', /\r\n [^\r\n]/.test(folded), true);
  // 日本語は1文字3オクテット。文字境界を無視して折ると文字が壊れる
  t.eq('折り返しを戻すと内容が復元できる',
    folded.replace(/\r\n /g, '').indexOf('予約ID: ' + long.id) > 0, true);
  t.eq('折り返しても文字が壊れない',
    folded.replace(/\r\n /g, '').indexOf('あいうえおかきくけこあいうえおかきくけこ') > 0, true);

  // --- エスケープ -----------------------------------------------------------
  t.group('エスケープ');
  t.eq('カンマ', icsEscape('a,b'), 'a\\,b');
  t.eq('セミコロン', icsEscape('a;b'), 'a\\;b');
  t.eq('バックスラッシュ', icsEscape('a\\b'), 'a\\\\b');
  t.eq('改行', icsEscape('a\nb'), 'a\\nb');
  // 予約名にカンマが入っても行が壊れないこと
  t.eq('予約名のカンマが行を壊さない', ics.indexOf('SUMMARY:定例\\, 会議\\; テスト') >= 0, true);
  // 説明の改行は、物理的な改行ではなく \n にエスケープされていること
  t.eq('説明の改行がエスケープされる', /DESCRIPTION:[^\r\n]*\\n/.test(ics), true);

  // --- カレンダー追加リンク --------------------------------------------------
  t.group('カレンダー追加リンク');
  const g = googleCalendarLink(r);
  t.eq('Google: ctz が付く', g.indexOf('ctz=Asia%2FTokyo') > 0, true);
  t.eq('Google: dates の形式', g.indexOf('dates=20260923T140000%2F20260923T150000') > 0, true);
  t.eq('Google: 外部ブラウザ指定', g.indexOf('openExternalBrowser=1') > 0, true);
  t.eq('Google: 日本語がエンコードされる', /[^\x00-\x7F]/.test(g), false);

  const o = outlookCalendarLink(r);
  t.eq('Outlook: 開始日時がオフセット付き', o.indexOf(encodeURIComponent('2026-09-23T14:00:00+09:00')) > 0, true);
  t.eq('Outlook: 終了日時がオフセット付き', o.indexOf(encodeURIComponent('2026-09-23T15:00:00+09:00')) > 0, true);
  t.eq('Outlook: 外部ブラウザ指定', o.indexOf('openExternalBrowser=1') > 0, true);
  t.eq('Outlook: 日本語がエンコードされる', /[^\x00-\x7F]/.test(o), false);

  // --- カレンダー予定の内容 --------------------------------------------------
  t.group('カレンダー予定の内容');
  // 部屋ごとにカレンダーを分けないため、タイトルだけで部屋を判別できる必要がある
  t.eq('タイトルに部屋名が入る', calendarTitle(r).indexOf(r.roomName) > 0, true);
  t.eq('説明に予約IDが入る', calendarDescription(r).indexOf(r.id) >= 0, true);
  t.eq('説明に予約者が入る', calendarDescription(r).indexOf(r.userName) >= 0, true);

  // --- メール本文 -----------------------------------------------------------
  t.group('メール本文');
  const before = sampleReservation();
  before.start = '10:00'; before.end = '11:00';
  const body = mailBody('変更', r, before);
  t.eq('変更内容が本文に入る', body.indexOf('10:00 → 14:00') > 0, true);
  t.eq('予約IDが本文に入る', body.indexOf(r.id) > 0, true);
  t.eq('件名が種別で変わる', mailSubject('作成') !== mailSubject('キャンセル'), true);

  return t.report();
}

/** 文字列のUTF-8オクテット数。行の折り返しは文字数ではなくオクテット数で決まる。 */
function octetLength(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let ch = text.charAt(i);
    const code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      ch += text.charAt(i + 1);
      i++;
    }
    n += utf8Size(ch);
  }
  return n;
}

/** 2026-09-23（水）14:00-15:00。エスケープの確認のため、予約名に記号を入れてある。 */
function sampleReservation() {
  return {
    id: 'R20260923-TST001',
    roomId: 'ROOM05',
    roomName: '6人部屋A',
    date: '2026-09-23',
    start: '14:00',
    end: '15:00',
    headcount: 6,
    title: '定例, 会議; テスト',
    userId: 'U_SAMPLE',
    userName: 'テスト太郎',
    note: '',
    status: '確定',
    calendarEventId: '',
    icsSequence: 0,
  };
}

// ---------------------------------------------------------------------------
// 実機検証（12.1 V-6 / V-7）
// ---------------------------------------------------------------------------

/**
 * 実際にカレンダーへ書き込み、実際にメールを送る。
 *
 * 【注意】この関数は外部に作用する。
 *   - 共有カレンダーに予定を作成し、更新し、最後に削除する
 *   - 設定シートの「管理者通知先メール」宛に3通のメールを送る
 *
 * .ics の更新・キャンセルがクライアントで正しく反映されるかは、
 * 静的な検証では確認できない。届いた3通を順に開いて、
 * 予定が1件だけ残り、最後に消えることを目視で確認すること。
 */
function verifyNotifyLive() {
  const out = [];
  const ctx = loadContext();

  // 宛先を Bot の実行アカウントにすると、主催者と出席者が同一人物になる。
  // Google はこれを「自分が作った予定」と見なし、招待として扱わない。
  // 別のアドレスで試すには、スクリプトプロパティに VERIFY_MAIL_TO を設定する。
  const to = PropertiesService.getScriptProperties().getProperty('VERIFY_MAIL_TO')
    || ctx.config.adminMails;
  const r = sampleReservation();
  // 実機検証どうしが衝突しないよう、毎回別の予約IDを使う（UID が同じだと前回の予定を上書きする）
  r.id = 'R' + dateToCompact(nowDateStr()) + '-' + Utilities.formatDate(new Date(), TIMEZONE, 'HHmmss');
  r.date = futureWeekday(7);

  out.push('検証用の予約ID: ' + r.id + '（' + r.date + ' ' + r.start + '-' + r.end + '）');

  // --- カレンダー ----------------------------------------------------------
  out.push('');
  out.push('=== 共有カレンダー ===');
  const calId = getCalendarId();
  if (!calId) {
    out.push('  未設定です。setUpCalendar() を先に実行してください。');
  } else {
    out.push('  カレンダーID: ' + calId);
    try {
      syncCalendarForReservation(ctx, '作成', r);
      out.push(r.calendarEventId ? '  OK   予定を作成しました: ' + r.calendarEventId
        : '  NG   イベントIDを取得できませんでした');

      r.end = '16:00';
      syncCalendarForReservation(ctx, '変更', r);
      out.push('  OK   予定を 14:00-16:00 に更新しました');

      syncCalendarForReservation(ctx, 'キャンセル', r);
      out.push('  OK   予定を削除しました');
      out.push('  ※ カレンダーを開き、この予定が残っていないことを確認してください');
    } catch (e) {
      out.push('  NG   ' + e);
    }
  }

  // --- メール --------------------------------------------------------------
  out.push('');
  out.push('=== メール（.ics 添付）===');
  if (!to) {
    out.push('  設定シートの「管理者通知先メール」が空です。');
  } else {
    out.push('  宛先: ' + to);
    out.push('  残り送信可能数: ' + MailApp.getRemainingDailyQuota() + ' 通');

    const organizer = Session.getEffectiveUser().getEmail();
    if (to === organizer) {
      out.push('');
      out.push('  【注意】宛先が Bot の実行アカウント（' + organizer + '）と同じです。');
      out.push('  主催者と出席者が同一人物になるため、Gmail は招待として扱いません。');
      out.push('  カレンダーへの取り込みを確認するには、別のアドレスで試してください。');
      out.push('  「プロジェクトの設定 > スクリプト プロパティ」に');
      out.push('  VERIFY_MAIL_TO = 別のメールアドレス を追加して再実行します。');
      out.push('');
    }
    r.end = '15:00';
    try {
      [['作成', 0], ['変更', 1], ['キャンセル', 2]].forEach(function (pair) {
        const action = pair[0], seq = pair[1];
        MailApp.sendEmail({
          to: to,
          subject: '[検証] ' + mailSubject(action),
          body: mailBody(action, r, null),
          attachments: [Utilities.newBlob(buildIcs(r, action, seq, to), icsMimeType(action), 'reservation.ics')],
        });
        out.push('  OK   ' + action + '（SEQUENCE ' + seq + '）を送信しました');
      });
      out.push('  ※ 3通を順に開き、予定が1件だけ登録され、最後に消えることを確認してください');
      out.push('  ※ Outlook と Google カレンダーの両方で確認すること（挙動差があります）');
    } catch (e) {
      out.push('  NG   ' + e);
    }
  }

  const report = out.join('\n');
  Logger.log(report);
  return report;
}
