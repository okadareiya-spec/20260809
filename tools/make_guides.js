/**
 * 利用ガイド（.docx）の生成
 *
 * ユーザー向けと管理者向けを別ファイルにする。1つにまとめると、
 * 全社員に配ったときに管理者向けの操作まで見えてしまう。
 *
 *   node tools/make_guides.js
 */

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageBreak, Header, Footer, PageNumber, VerticalAlign,
} = require('docx');

const OUT_DIR = path.join(__dirname, '..', 'docs');

// A4 縦。日本の社内配布はA4が前提。
const PAGE = { width: 11906, height: 16838 };
const MARGIN = 794;                      // 1.4cm。指定ページ数に収めるため詰めている
const CONTENT_W = PAGE.width - MARGIN * 2;   // 9638

// Windows に標準で入っているフォント。游ゴシックは環境によって無い場合がある。
const FONT = { ascii: 'Meiryo', eastAsia: 'Meiryo', hAnsi: 'Meiryo' };

const INK = '1F2933';
const MUTED = '5F6B7A';
const ACCENT = '1B5E20';
const WARN = 'B3261E';
const HEAD_BG = 'EEF2F5';
const WARN_BG = 'FDECEA';

// ---------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------

const thin = { style: BorderStyle.SINGLE, size: 1, color: 'C7CDD4' };
const cellBorders = { top: thin, bottom: thin, left: thin, right: thin };

function styles(baseSize) {
  return {
    default: { document: { run: { font: FONT, size: baseSize, color: INK } } },
    paragraphStyles: [
      {
        id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: baseSize + 8, bold: true, font: FONT, color: ACCENT },
        paragraph: { spacing: { before: 120, after: 60 }, outlineLevel: 0 },
      },
      {
        id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: baseSize + 2, bold: true, font: FONT, color: INK },
        paragraph: {
          spacing: { before: 110, after: 40 }, outlineLevel: 1,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 2 } },
        },
      },
    ],
  };
}

const numbering = {
  config: [
    {
      reference: 'steps',
      levels: [{
        level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 400, hanging: 300 } } },
      }],
    },
    {
      reference: 'steps2',
      levels: [{
        level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 400, hanging: 300 } } },
      }],
    },
    {
      reference: 'bullets',
      levels: [{
        level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 400, hanging: 300 } } },
      }],
    },
  ],
};

function p(text, opts) {
  const o = opts || {};
  return new Paragraph({
    spacing: { before: o.before === undefined ? 0 : o.before, after: o.after === undefined ? 40 : o.after, line: 228 },
    indent: o.indent ? { left: o.indent } : undefined,
    alignment: o.align,
    children: runs(text, o),
  });
}

/** 「**強調**」記法だけ解釈する。ガイドは強調の使いどころが多い。 */
function runs(text, o) {
  const opts = o || {};
  return String(text).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(function (chunk) {
    const bold = chunk.startsWith('**') && chunk.endsWith('**');
    return new TextRun({
      text: bold ? chunk.slice(2, -2) : chunk,
      bold: bold || opts.bold,
      size: opts.size,
      color: opts.color,
    });
  });
}

function li(text, ref, opts) {
  const o = opts || {};
  return new Paragraph({
    numbering: { reference: ref, level: 0 },
    spacing: { after: 30, line: 228 },
    children: runs(text, o),
  });
}

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
}

function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
}

function table(widths, rows, opts) {
  const o = opts || {};
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: widths,
    rows: rows.map(function (cells, r) {
      const header = r === 0 && o.header !== false;
      return new TableRow({
        tableHeader: header,
        children: cells.map(function (text, c) {
          return new TableCell({
            borders: cellBorders,
            width: { size: widths[c], type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            shading: header
              ? { fill: HEAD_BG, type: ShadingType.CLEAR }
              : (o.fill ? { fill: o.fill, type: ShadingType.CLEAR } : undefined),
            margins: { top: 30, bottom: 30, left: 90, right: 90 },
            children: [new Paragraph({
              spacing: { after: 0, line: 240 },
              children: runs(text, { bold: header, size: o.size }),
            })],
          });
        }),
      });
    }),
  });
}

/** 注意書き。枠で囲むと目に留まる。 */
function callout(title, lines, color) {
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [CONTENT_W],
    rows: [new TableRow({
      children: [new TableCell({
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: color },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: color },
          left: { style: BorderStyle.SINGLE, size: 12, color: color },
          right: { style: BorderStyle.SINGLE, size: 1, color: color },
        },
        width: { size: CONTENT_W, type: WidthType.DXA },
        shading: { fill: WARN_BG, type: ShadingType.CLEAR },
        margins: { top: 60, bottom: 60, left: 130, right: 110 },
        children: [
          new Paragraph({ spacing: { after: 40 }, children: runs(title, { bold: true, color: color }) }),
        ].concat(lines.map(function (t, i) {
          return new Paragraph({
            spacing: { after: i === lines.length - 1 ? 0 : 40, line: 260 },
            children: runs(t),
          });
        })),
      })],
    })],
  });
}

function spacer(h) {
  return new Paragraph({ spacing: { after: h || 80 }, children: [] });
}

function docHeader(text) {
  return new Header({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { after: 0 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C7CDD4', space: 4 } },
      children: [new TextRun({ text: text, size: 16, color: MUTED, font: FONT })],
    })],
  });
}

function docFooter() {
  return new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: '', size: 16, color: MUTED, font: FONT }),
      new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED, font: FONT }),
      new TextRun({ text: ' / ', size: 16, color: MUTED, font: FONT }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: MUTED, font: FONT })],
    })],
  });
}

function title(text, sub) {
  return [
    new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({ text: text, bold: true, size: 26, color: ACCENT, font: FONT })],
    }),
    new Paragraph({
      spacing: { after: 110 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: ACCENT, space: 4 } },
      children: [new TextRun({ text: sub, size: 18, color: MUTED, font: FONT })],
    }),
  ];
}

// ---------------------------------------------------------------------------
// ユーザー向け（1ページ）
// ---------------------------------------------------------------------------

function buildUserGuide() {
  const S = 18;   // 9pt

  const children = [].concat(
    title('会議室予約の使い方', 'LINE から会議室を予約できます。この1枚で全部わかります。'),

    h2('1. はじめて使うとき'),
    p('LINE で会議室予約アカウントを友だち追加し、リッチメニューのどれかを押してください。**お名前とメールアドレスを1回だけ**聞かれます。', { size: S }),
    p('メールアドレスは、予約内容とカレンダー登録用のファイルを送るために使います。**次回からは聞かれません。**', { size: S, after: 100 }),

    h2('2. 予約する'),
    p('画面下のメニューから選びます。**「今日」「明日」を押すと、その日の予約に直行します。**', { size: S }),
    table([1700, 7938], [
      ['押すボタン', 'できること'],
      ['今日 / 明日', 'その日の予約をすぐ始める'],
      ['日付を選ぶ', 'カレンダーから日を選んで予約する（60日先まで）'],
    ], { size: S }),
    spacer(60),
    p('あとは表示されるボタンを順に押すだけです。**日付・時刻・部屋はすべてボタンで選べます。**', { size: S }),
    p('人数 → 開始時刻 → 利用時間 → 部屋 → 予約名 → 備考 → 確定する', { size: S, bold: true, indent: 300, after: 60 }),
    p('**空いていない選択肢は最初から表示されません。** 選べる時刻・部屋だけが並びます。予約名と備考は「入力せずに進む」で飛ばせます。', { size: S }),
    p('部屋で**「おまかせ」**を選ぶと、人数を収容できる一番小さい部屋が自動で割り当てられます。', { size: S, after: 100 }),

    h2('3. 自分のカレンダーに登録する'),
    p('予約が確定すると**メールが届きます。添付ファイルを開くと、ご自身のカレンダーに予定が入ります。**', { size: S }),
    p('この方法なら、あとで予約を変更・キャンセルしたときにも**カレンダーが自動で更新されます。**', { size: S }),
    p('LINE の「Google カレンダーに追加」「Outlook に追加」ボタンでも登録できますが、**こちらは自動更新されません。**押したあと、開いた画面で保存の操作が必要です。', { size: S, after: 100 }),

    h2('4. 確認・変更・キャンセル'),
    p('メニューの**「予約の確認」**から、これからの予約が一覧で表示されます。各予約に「変更」「キャンセル」のボタンが付いています。', { size: S }),
    p('変更できるのは**日時・部屋・人数・予約名・備考**です。キャンセルは確認画面で「キャンセルする」を押すと確定します。', { size: S }),
    p('お名前やメールアドレスを直したいときは、この画面の末尾にある**「登録情報の変更」**を使ってください。', { size: S, after: 100 }),

    h2('5. 覚えておくこと'),
    table([2600, 7038], [
      ['他の方の予約', '変更・キャンセルはできません。ご本人に直接ご相談ください'],
      ['開始時刻を過ぎた予約', '変更・キャンセルできません。管理者にご連絡ください'],
      ['予約できる範囲', '本日から60日先まで'],
      ['空き状況を見たいとき', 'メニューの「空き状況」から、時刻ごとに全部屋の状態を確認できます'],
      ['操作に迷ったら', 'メニューの「使い方」を押してください'],
    ], { header: false, size: S })
  );

  return new Document({
    styles: styles(S), numbering: numbering,
    sections: [{
      properties: { page: { size: PAGE, margin: { top: MARGIN, right: MARGIN, bottom: 850, left: MARGIN } } },
      children: children,
    }],
  });
}

// ---------------------------------------------------------------------------
// 管理者向け（3ページ）
// ---------------------------------------------------------------------------

function buildAdminGuide() {
  const S = 18;

  const page1 = [].concat(
    title('会議室予約システム 管理者ガイド', 'このスプレッドシートが管理画面です。LINE 側に管理機能はありません。'),

    h2('1. システムの構成'),
    table([2000, 7638], [
      ['要素', '役割'],
      ['LINE Bot', '社員が予約・確認・変更・キャンセルを行う窓口'],
      ['スプレッドシート', '**すべてのデータの正本。ここが管理画面です**'],
      ['共有カレンダー', '全予約の状況を俯瞰する。**Bot からの一方向で書き込まれます**'],
      ['メール', '予約者への通知。カレンダー登録用のファイルを添付します'],
    ], { size: S }),
    spacer(60),

    h2('2. シートの構成'),
    table([2300, 7338], [
      ['シート', '内容'],
      ['はじめに', '運用ルールの要約'],
      ['本日の予約', '当日の予約を時系列で表示（数式による自動表示・編集不可）'],
      ['予約', '**すべての予約。正本です**'],
      ['部屋マスタ', '部屋の一覧・定員・表示順・有効/無効'],
      ['部屋別予約可能時間', '曜日ごとに予約**できる**時間帯。定例枠はここで塞ぐ'],
      ['臨時ブロック', '日付を指定して予約**できない**時間帯を作る'],
      ['営業時間', '曜日ごとの稼働時間'],
      ['設定', '締切・予約可能日数・時間の刻みなど'],
      ['利用者マスタ', '登録済みの社員。氏名とメールアドレス'],
      ['操作履歴', '誰がいつ何をしたかの記録（参照専用）'],
    ], { size: S }),
    spacer(60),

    h2('3. 管理者の仕事'),
    li('**予約状況の把握** — 共有カレンダー、または「本日の予約」シートを見る', 'bullets', { size: S }),
    li('**代理予約** — 予約シートに直接1行書く（予約IDは自動で入ります）', 'bullets', { size: S }),
    li('**強制キャンセル** — 予約シートの「状態」列を「キャンセル」に変える', 'bullets', { size: S }),
    li('**部屋・営業時間の変更** — 各マスタシートを編集する', 'bullets', { size: S }),
    li('**定例会議の枠を塞ぐ** — 「部屋別予約可能時間」で時間帯を分割する（7章）', 'bullets', { size: S }),
    li('**祝日・全社休業** — 「臨時ブロック」に1行足す（8章）', 'bullets', { size: S }),
    li('**異常の確認** — 各シートの「警告」列を見る（6章）', 'bullets', { size: S }),
    spacer(40),
    callout('管理者への通知はありません', [
      '**新規予約が入っても管理者にメールは届きません。** 1日に190件を超えうるため、意図的に送らない設計です。予約状況は**共有カレンダー**で把握してください。システム障害のときだけ「管理者通知先メール」宛に届きます（同種は1時間に1通まで）。',
    ], ACCENT)
  );

  const page2 = [].concat(
    [new Paragraph({ pageBreakBefore: true, spacing: { after: 0 }, children: [] })],
    h1('日常の運用'),

    h2('4. 代理予約を追加する'),
    p('予約シートの最終行の下に、**日付・開始時刻・終了時刻・部屋ID の4つが揃うまで**入力します。揃った時点で予約として取り込まれ、**予約IDが自動で採番され**、登録元が「管理者」、状態が「確定」になり、共有カレンダーにも反映されます。**予約IDを手で入れないでください。**', { size: S }),
    p('部屋名・人数・予約名・予約者氏名も入れておくと、社員が空き状況を見たときに誰の予約か分かります。**予約者userId が空欄の行には、メール通知は送られません。**', { size: S }),
    p('日付は YYYY-MM-DD、時刻は HH:mm 形式です。9:00 のように1桁で入力しても、システムが 09:00 に直します。**管理者の編集には受付締切が適用されないため、過去の日付でも登録できます。**', { size: S }),

    h2('5. 予約をキャンセルする'),
    p('**行は削除せず、「状態」列を「キャンセル」に変えてください。** それだけで共有カレンダーからも予定が消え、予約者にメールで通知されます。', { size: S }),

    h2('6. 警告列の見方'),
    p('異常を検出すると、その行の「警告」列に内容が書かれます。**入力が拒否されることはありません。** 意図した例外か入力ミスかは、内容を見てご判断ください。', { size: S }),
    table([3300, 6338], [
      ['警告の内容', '意味'],
      ['同じ部屋・同じ時間帯に別の予約があります', 'ダブルブッキングになっています'],
      ['営業時間の外です / 予約可能時間の外です', '定例枠や営業時間と重なっています'],
      ['部屋名が部屋マスタと一致しません', '部屋IDだけ直して部屋名を直し忘れています'],
      ['定員は◯名ですが、◯名で登録されています', '定員を超えています'],
      ['入力途中です', '必須の4項目が未入力。まだ予約になっていません'],
      ['システムが管理する列が変更されました', '予約IDかカレンダーイベントIDが書き換わりました'],
      ['カレンダー同期に失敗しました', '共有カレンダーに反映できていません'],
    ], { size: S }),
    spacer(60),

    callout('やってはいけないこと', [
      '**予約の行を削除しない。** 消すとカレンダーとの紐付けも失われ、共有カレンダー側の予定を二度と削除できません。シートは「空き」・カレンダーは「予約済み」という不整合が残り、回復手段はありません。やむを得ず削除したときは、共有カレンダーからも手動で予定を消してください。',
      '**予約ID・カレンダーイベントID・ics連番を書き換えない。** 履歴との対応や同期先を見失います。',
      '**部屋IDを変更しない。** 既存の予約が参照しています。廃止するときは行を消さず「有効」のチェックを外します。',
      '**部屋を付け替えるときは部屋IDと部屋名の両方を直す。** 予約シートは部屋名も保持しているため、IDだけ直すと古い名前が残ります。',
    ], WARN)
  );

  const page3 = [].concat(
    [new Paragraph({ pageBreakBefore: true, spacing: { after: 0 }, children: [] })],
    h1('設定の変更と困ったとき'),

    h2('7. 定例会議で枠を塞ぐ'),
    p('「部屋別予約可能時間」は、予約**できる**時間帯を定義するシートです。**区間と区間の隙間が、予約できない時間になります。** 例）大会議室を毎週火曜 10:00-12:00 の定例で使う場合、火曜の行を2つに分けます。', { size: S }),
    table([2400, 1600, 2400, 3238], [
      ['部屋ID', '曜日', '開始時刻', '終了時刻'],
      ['ROOM12', '火', '09:00', '10:00'],
      ['ROOM12', '火', '12:00', '18:00'],
    ], { size: S }),
    spacer(50),
    p('この隙間が予約不可になります。**時刻を両方空欄にすると、その曜日は終日予約不可**です。', { size: S }),

    h2('8. 祝日・全社休業日'),
    p('「営業時間」は曜日単位の設定なので、特定の日だけ休みにはできません。**「臨時ブロック」に、部屋IDを空欄・日付を指定・時刻を両方空欄**にした行を1つ足すと、全部屋が終日ブロックされます。', { size: S }),
    p('**2つのシートは空欄の意味が逆です。** 前者の空欄は終日**予約不可**、後者の空欄は終日**ブロック**。結果は同じでも書き方が逆です。', { size: S }),

    h2('9. 設定シート'),
    table([2400, 1100, 6138], [
      ['項目', '既定値', '意味'],
      ['受付締切（分前）', '0', '**「締切なし」ではありません。**開始時刻を過ぎた枠は操作できません'],
      ['予約可能日数', '60', '何日先まで予約できるか'],
      ['時間の刻み（分）', '30', '選択肢が並ぶ単位'],
      ['最短予約時間（分）', '30', '1件の予約の最短の長さ'],
      ['人数の初期値', '6', '人数選択で強調される値'],
      ['管理者通知先メール', '—', '障害通知の宛先。カンマ区切りで複数可'],
    ], { size: S }),
    spacer(50),
    p('**項目名を1文字でも変えると既定値で動作します。**「値」列だけを編集し、次の予約から反映されます。', { size: S }),

    h2('10. 困ったとき'),
    table([3400, 6238], [
      ['症状', '確認するところ'],
      ['予約できる時間が0件になる', '営業時間・定例枠・臨時ブロックの設定'],
      ['「本日の予約」が空のまま', '予約シートの日付列が文字列として保存されているか'],
      ['共有カレンダーに載らない', '予約シートの警告列'],
      ['予約者にメールが届かない', '利用者マスタにメールアドレスが登録されているか'],
      ['シート編集が反映されない', '必須の4項目が揃っているか。警告列の内容'],
      ['誤って消した / 直したい', 'ファイル > 変更履歴 > 変更履歴を表示 から復元'],
    ], { size: S })
  );

  return new Document({
    styles: styles(S), numbering: numbering,
    sections: [{
      properties: { page: { size: PAGE, margin: { top: MARGIN, right: MARGIN, bottom: 750, left: MARGIN } } },
      headers: { default: docHeader('会議室予約システム 管理者ガイド') },
      footers: { default: docFooter() },
      children: [].concat(page1, page2, page3),
    }],
  });
}

// ---------------------------------------------------------------------------

function write(doc, name) {
  const out = path.join(OUT_DIR, name);
  return Packer.toBuffer(doc).then(function (buf) {
    fs.writeFileSync(out, buf);
    console.log('書き出しました: ' + out + ' (' + Math.round(buf.length / 1024) + ' KB)');
  });
}

write(buildUserGuide(), '利用ガイド_ユーザー向け.docx')
  .then(function () { return write(buildAdminGuide(), '利用ガイド_管理者向け.docx'); })
  .catch(function (e) { console.error(e); process.exit(1); });
