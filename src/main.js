/**
 * Webhook の受信
 *
 * GAS の doPost は HTTP ヘッダーを取得できないため、LINE の X-Line-Signature による
 * 署名検証は実行できない。代替として Webhook URL のクエリパラメータに秘密トークンを
 * 付け、e.parameter で受け取って検証する（技術仕様書 2.1）。
 *
 * これは署名検証より明確に弱い。URL が漏れると、任意の userId を騙った書き込みが
 * 可能になる。社内利用であり露出経路が限られることから受容した制約であって、
 * 安全だからではない（技術仕様書 2.2）。URL の取り扱いには注意すること。
 */

const PROP = PropertiesService.getScriptProperties();

// ---------------------------------------------------------------------------
// 設定の確認（エディタから実行する）
// ---------------------------------------------------------------------------

/**
 * デプロイ後に実行し、出力された URL を
 * LINE Developers コンソールの Webhook URL に設定する。
 */
function showWebhookUrl() {
  const token = PROP.getProperty('WEBHOOK_TOKEN');
  if (!token) {
    Logger.log('WEBHOOK_TOKEN が未設定です。showConfig() の案内に従って設定してください。');
    return;
  }

  const url = ScriptApp.getService().getUrl();
  const out = [];

  if (!url) {
    out.push('まだデプロイされていません。「デプロイ > 新しいデプロイ」を先に実行してください。');
  } else if (url.indexOf('/dev') >= 0) {
    // /dev はテスト用のデプロイ。常に Google のログインを要求するため、
    // 匿名でアクセスする LINE には必ず 401 を返す。アクセス設定では変えられない。
    out.push('【この URL は使えません】');
    out.push(url);
    out.push('');
    out.push('末尾が /dev のテスト用デプロイです。常にログインを要求するため、');
    out.push('LINE からは 401 になります。下の手順で本番用の URL を取得してください。');
  } else {
    out.push('Webhook URL に設定する値:');
    out.push(url + '?token=' + token);
  }

  out.push('');
  out.push('--- 本番用の URL を確実に取得する手順 ---');
  out.push('1. 「デプロイ > デプロイを管理」を開く');
  out.push('2. 「本実装 v1」など、種類が「ウェブアプリ」の行を選ぶ');
  out.push('   （「テスト用のデプロイ」は選ばない）');
  out.push('3. 表示された「ウェブアプリ」の URL をコピーする（末尾が /exec であること）');
  out.push('4. その末尾に、次の文字列をそのまま繋げる');
  out.push('   ?token=' + token);

  const msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * 必要な設定が揃っているかを確認する。値そのものは出力しない。
 *
 * 値を変更するときは、このコードに書かずに
 * エディタの「プロジェクトの設定 > スクリプト プロパティ」から編集すること。
 * コードに書くと、履歴とバージョンに残り続ける。
 */
function showConfig() {
  const items = [
    ['CHANNEL_ACCESS_TOKEN', 'LINE のチャネルアクセストークン'],
    ['WEBHOOK_TOKEN', 'Webhook URL に付ける秘密トークン'],
    [PROP_CALENDAR_ID, '共有カレンダーのID（setUpCalendar で設定）'],
  ];
  const lines = items.map(function (pair) {
    const v = PROP.getProperty(pair[0]);
    return (v ? '  OK   ' : '  未設定 ') + pair[0] + ' — ' + pair[1] +
      (v ? '（' + v.length + '文字）' : '');
  });
  lines.push('');
  lines.push('スプレッドシート: ' + SpreadsheetApp.getActiveSpreadsheet().getName());
  lines.push('実行アカウント: ' + Session.getEffectiveUser().getEmail());

  const msg = lines.join('\n');
  Logger.log(msg);
  return msg;
}

// ---------------------------------------------------------------------------
// 受信
// ---------------------------------------------------------------------------

/**
 * 疎通確認用。ブラウザでウェブアプリの URL を開いたときに応答する。
 *
 * ログイン画面が出る場合は、デプロイの「アクセスできるユーザー」が
 * 「全員」になっていない。LINE のサーバーは Google アカウントを持たない
 * 匿名アクセスとして届くため、その設定では 401 が返り Webhook が動かない。
 *
 * この応答に秘密情報を含めないこと。URL を知る誰でもアクセスできる。
 */
function doGet(e) {
  return ContentService.createTextOutput(
    '会議室予約 Bot は稼働しています。\n' +
    '応答時刻: ' + nowStampStr() + '\n' +
    'この画面が見えていれば、匿名アクセスが許可されています。'
  );
}

function doPost(e) {
  try {
    if (!e || !e.parameter || e.parameter.token !== PROP.getProperty('WEBHOOK_TOKEN')) {
      Logger.log('トークンが一致しません。リクエストを破棄しました。');
      return ok();
    }

    const body = JSON.parse((e.postData && e.postData.contents) || '{}');

    // events が配列であることを確かめる。壊れた本文や、LINE 以外からの
    // リクエストでは配列にならず、そのまま forEach すると例外になる。
    const events = Array.isArray(body.events) ? body.events : [];

    // LINE Developers の「検証」ボタンは events を空配列で送る。
    // ここで落ちると、実際には動いていても検証が失敗する。
    if (events.length === 0) return ok();

    // ctx は1リクエストにつき1回だけ読む（システム要件 4.1）
    let ctx = null;
    events.forEach(function (event) {
      try {
        // LINE は応答が遅いと同じイベントを再送する。ロックは同時実行を防ぐだけで、
        // 同一内容が2回届くことは防げない。1回の確定操作で2件成立するのをここで止める。
        if (isDuplicateEvent(event.webhookEventId)) {
          Logger.log('重複イベントのため無視しました: ' + event.webhookEventId);
          return;
        }
        if (!ctx) ctx = loadContext();

        const messages = handleLineEvent(ctx, event);
        replyMessages(event.replyToken, messages);

      } catch (err) {
        Logger.log('イベント処理で例外: ' + (err && err.stack ? err.stack : err));
        // 無言で終わらせない。ユーザーには次の行動を返す。
        try {
          replyMessages(event.replyToken, [
            quickReplyMsg(
              '処理中に問題が発生しました。お手数ですが、もう一度お試しください。',
              [
                { label: '予約する', data: buildPostback({ a: 'new' }) },
                { label: '予約の確認', data: buildPostback({ a: 'list' }) },
              ]
            ),
          ]);
        } catch (e2) {
          Logger.log('エラー応答も失敗: ' + e2);
        }
        notifyAdminError(ctx, 'webhook',
          'Webhook の処理で例外が発生しました。\n\n' + (err && err.stack ? err.stack : err));
      }
    });

  } catch (err) {
    // 例外が出ても LINE には 200 を返す。500 を返すと再送を招き、事態が悪化する。
    Logger.log('doPost で例外: ' + (err && err.stack ? err.stack : err));
  }
  return ok();
}

/** LINE には常に 200 を返す */
function ok() {
  return ContentService.createTextOutput('');
}
