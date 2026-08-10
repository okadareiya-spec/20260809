/**
 * LINE Messaging API とメッセージの組み立て
 *
 * push API は使わない。返信は必ず reply token 経由で行う（技術仕様書 8章）。
 * 選択肢の上限に注意すること。クイックリプライは13件、カルーセルは12バブルが上限で、
 * 超えた分は表示されないのではなくエラーになる。
 *
 * 参照: システム要件定義書 2.1 / 技術仕様書 8章
 */

const REPLY_URL = 'https://api.line.me/v2/bot/message/reply';

/** 1回の reply で送れるメッセージ数の上限 */
const MAX_REPLY_MESSAGES = 5;

/** クイックリプライの上限 */
const MAX_QUICK_REPLY = 13;

/** カルーセルのバブル数の上限 */
const MAX_BUBBLES = 12;

/** Flex のボタンラベルの上限 */
const MAX_LABEL = 20;

function replyMessages(replyToken, messages) {
  if (!replyToken || !messages || messages.length === 0) return;

  const payload = {
    replyToken: replyToken,
    messages: messages.slice(0, MAX_REPLY_MESSAGES),
  };
  const res = UrlFetchApp.fetch(REPLY_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + PROP.getProperty('CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    // reply token は1回きり・短時間のみ有効なので、失敗しても再送はしない
    Logger.log('reply 失敗 ' + code + ': ' + res.getContentText());
    Logger.log('送信しようとした内容: ' + JSON.stringify(payload).slice(0, 2000));
  }
}

// ---------------------------------------------------------------------------
// メッセージの組み立て
// ---------------------------------------------------------------------------

function textMsg(text) {
  return { type: 'text', text: String(text) };
}

/**
 * クイックリプライ付きのテキスト。items は [{label, data}]。
 * 13件を超える可能性がある選択肢には使わないこと（Flex を使う）。
 */
function quickReplyMsg(text, items) {
  // 選択肢を渡し忘れても落とさない。会話が止まるより、テキストだけでも返す方がよい。
  const list = items || [];
  return {
    type: 'text',
    text: String(text),
    quickReply: {
      items: list.slice(0, MAX_QUICK_REPLY).map(function (it) {
        return { type: 'action', action: postbackAction(it) };
      }),
    },
  };
}

function postbackAction(it) {
  const action = {
    type: 'postback',
    label: cut(it.label, MAX_LABEL),
    data: it.data,
  };
  // displayText を付けると、ユーザーの発言として何を選んだかが会話に残る
  if (it.displayText !== null) action.displayText = cut(it.displayText || it.label, 300);
  return action;
}

/**
 * 手順の途中から抜けるための選択肢。
 *
 * どの手順にも必ず1つ置くこと。リッチメニューを押せば実際には抜けられるが、
 * 画面上に手がかりがないと「この会話から出られない」と受け取られる。
 * 迷った利用者が管理者に問い合わせる状況を作らないための導線である。
 */
function escapeAction() {
  return { label: 'やめる', data: buildPostback({ a: 'menu' }) };
}

/**
 * 縦に伸ばせるボタン一覧。末尾に離脱の選択肢を必ず添える。
 * 開始時刻は営業時間9〜18時で18件になり、クイックリプライの13件に収まらない。
 */
function flexButtonList(altText, title, description, buttons) {
  const contents = [];
  if (description) {
    contents.push({ type: 'text', text: description, size: 'sm', color: '#777777', wrap: true });
  }
  buttons.concat([escapeAction()]).forEach(function (b) {
    contents.push({
      type: 'button',
      style: b.primary ? 'primary' : 'secondary',
      height: 'sm',
      margin: 'md',
      action: b.uri
        ? { type: 'uri', label: cut(b.label, MAX_LABEL), uri: b.uri }
        : postbackAction(b),
    });
  });

  return {
    type: 'flex',
    altText: cut(altText, 400),
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'text', text: title, weight: 'bold', size: 'md', wrap: true }],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'none', contents: contents },
    },
  };
}

/**
 * 明細と、その下のボタンを持つバブル。
 * rows は [{label, value, color}]、buttons は flexButtonList と同じ形式。
 */
function flexDetailBubble(title, rows, buttons, note) {
  const body = rows.map(function (r) {
    return {
      type: 'box', layout: 'baseline', spacing: 'sm',
      contents: [
        { type: 'text', text: r.label, size: 'sm', color: '#888888', flex: 2 },
        { type: 'text', text: String(r.value), size: 'sm', color: r.color || '#111111', flex: 5, wrap: true },
      ],
    };
  });
  if (note) {
    body.push({ type: 'text', text: note, size: 'xs', color: '#888888', wrap: true, margin: 'md' });
  }

  const bubble = {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical',
      contents: [{ type: 'text', text: title, weight: 'bold', size: 'md', wrap: true }],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
  };

  if (buttons && buttons.length) {
    bubble.footer = {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: buttons.map(function (b) {
        return {
          type: 'button',
          style: b.primary ? 'primary' : 'secondary',
          height: 'sm',
          action: b.uri
            ? { type: 'uri', label: cut(b.label, MAX_LABEL), uri: b.uri }
            : postbackAction(b),
        };
      }),
    };
  }
  return bubble;
}

function flexMsg(altText, bubbleOrBubbles) {
  const isList = Object.prototype.toString.call(bubbleOrBubbles) === '[object Array]';
  return {
    type: 'flex',
    altText: cut(altText, 400),
    contents: isList
      ? { type: 'carousel', contents: bubbleOrBubbles.slice(0, MAX_BUBBLES) }
      : bubbleOrBubbles,
  };
}

/** 状態を色付きで縦に並べる。空き状況照会で使う。 */
function flexStatusList(altText, title, description, rows) {
  const contents = [];
  if (description) {
    contents.push({ type: 'text', text: description, size: 'sm', color: '#777777', wrap: true, margin: 'none' });
  }
  rows.forEach(function (r) {
    contents.push({
      type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm',
      contents: [
        { type: 'text', text: r.badge, size: 'xs', color: r.color, flex: 3, weight: 'bold' },
        {
          type: 'box', layout: 'vertical', flex: 7, contents: [
            { type: 'text', text: r.name, size: 'sm', wrap: true },
            { type: 'text', text: r.detail || ' ', size: 'xs', color: '#888888', wrap: true },
          ],
        },
      ],
    });
  });

  return {
    type: 'flex',
    altText: cut(altText, 400),
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'text', text: title, weight: 'bold', size: 'md', wrap: true }],
      },
      body: { type: 'box', layout: 'vertical', contents: contents },
    },
  };
}

/** 日付選択のカレンダー。範囲外を選べないよう min / max を必ず指定する。 */
function datePickerAction(label, data, minDate, maxDate) {
  return {
    type: 'action',
    action: {
      type: 'datetimepicker',
      label: cut(label, MAX_LABEL),
      data: data,
      mode: 'date',
      initial: minDate,
      min: minDate,
      max: maxDate,
    },
  };
}

function cut(text, max) {
  const s = String(text === undefined || text === null ? '' : text);
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
