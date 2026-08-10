/**
 * postback データの組み立てと、テキスト入力待ち状態の保持
 *
 * 会話の状態は原則 postback データに載せて持ち回る（システム要件 2.7）。
 * サーバー側に持つのはテキスト入力待ちだけで、それも CacheService に限る。
 *
 * PropertiesService を使ってはならない。ウェブアプリはオーナーとして実行されるため、
 * ユーザープロパティは全 LINE ユーザーで共有され、AさんとBさんの入力待ちが混ざる。
 * スクリプトプロパティは有効期限を持たないため、放置された状態が永久に残り、
 * 数日後の無関係なテキストが予約名として流れ込む（技術仕様書 7.1）。
 */

/** postback データの上限。超えると LINE 側で切り詰められ、壊れた値が届く。 */
const POSTBACK_LIMIT = 300;

/** テキスト入力待ちの有効期限（秒）。30分で十分（技術仕様書 7.2）。 */
const PENDING_TTL_SEC = 1800;

/** 処理済みイベントの記録期間（秒）。CacheService の上限は6時間。 */
const EVENT_TTL_SEC = 21600;

// ---------------------------------------------------------------------------
// postback データ
// ---------------------------------------------------------------------------

function parsePostback(data) {
  const out = {};
  String(data || '').split('&').forEach(function (pair) {
    if (!pair) return;
    const i = pair.indexOf('=');
    if (i < 0) return;
    out[pair.slice(0, i)] = pair.slice(i + 1);
  });
  return out;
}

function buildPostback(obj) {
  const data = Object.keys(obj)
    .filter(function (k) {
      return obj[k] !== undefined && obj[k] !== null && obj[k] !== '';
    })
    .map(function (k) { return k + '=' + obj[k]; })
    .join('&');

  if (data.length > POSTBACK_LIMIT) {
    // 設計上ここには来ない。来た場合、値が黙って壊れるので必ず記録する。
    Logger.log('postback データが上限を超えました(' + data.length + '文字): ' + data);
  }
  return data;
}

/** 現在の値を引き継ぎ、一部だけ差し替えた新しいオブジェクトを返す */
function withParams(base, changes) {
  const out = {};
  Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
  Object.keys(changes || {}).forEach(function (k) {
    if (changes[k] === null) delete out[k]; else out[k] = changes[k];
  });
  return out;
}

// ---------------------------------------------------------------------------
// テキスト入力待ち
// ---------------------------------------------------------------------------

function pendingKey(userId) { return 'pending_' + userId; }

function setPending(userId, state) {
  CacheService.getScriptCache().put(pendingKey(userId), JSON.stringify(state), PENDING_TTL_SEC);
}

function getPending(userId) {
  const raw = CacheService.getScriptCache().get(pendingKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function clearPending(userId) {
  CacheService.getScriptCache().remove(pendingKey(userId));
}

// ---------------------------------------------------------------------------
// イベントの重複実行の抑止（技術仕様書 2.3）
// ---------------------------------------------------------------------------

/**
 * LINE は応答が遅いと同じイベントを再送する。
 * ロックは同時実行を防ぐだけで、同一内容の正当なリクエストが2回届くことは防げない。
 * 1回の「確定する」で2件の予約が成立するのを、ここで止める。
 */
function isDuplicateEvent(eventId) {
  if (!eventId) return false;
  const cache = CacheService.getScriptCache();
  const key = 'evt_' + eventId;
  if (cache.get(key)) return true;
  cache.put(key, '1', EVENT_TTL_SEC);
  return false;
}
