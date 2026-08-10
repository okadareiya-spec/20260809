#!/usr/bin/env python3
"""
検証報告書（.xlsx）の生成

読み手は経営層。リリース可否の判断材料として、
「何を目的に」「どういう観点で」「どう検証し」「どうだったか」を示す。
個々のテストコードの中身までは書かない。

    python tools/make_report.py
"""

import pathlib
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

OUT = pathlib.Path(__file__).resolve().parent.parent / 'docs' / '検証報告書.xlsx'

FONT = 'Meiryo'
INK = '1F2933'
ACCENT = '1B5E20'
WARN = 'B3261E'
HEAD_BG = 'E8F0E9'
TITLE_BG = '1B5E20'
ZEBRA = 'F7F9FA'

thin = Side(style='thin', color='C7CDD4')
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)


def style_sheet(ws, widths, freeze='A4'):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = freeze
    ws.sheet_view.showGridLines = False


def title_block(ws, text, sub, span):
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=span)
    c = ws.cell(row=1, column=1, value=text)
    c.font = Font(name=FONT, size=13, bold=True, color='FFFFFF')
    c.fill = PatternFill('solid', fgColor=TITLE_BG)
    c.alignment = Alignment(vertical='center', horizontal='left', indent=1)
    ws.row_dimensions[1].height = 26

    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=span)
    c = ws.cell(row=2, column=2 - 1, value=sub)
    c.font = Font(name=FONT, size=9, color='5F6B7A')
    c.alignment = Alignment(vertical='center', indent=1)
    ws.row_dimensions[2].height = 18


def header_row(ws, row, values):
    for i, v in enumerate(values, start=1):
        c = ws.cell(row=row, column=i, value=v)
        c.font = Font(name=FONT, size=9, bold=True, color=INK)
        c.fill = PatternFill('solid', fgColor=HEAD_BG)
        c.alignment = Alignment(vertical='center', horizontal='center', wrap_text=True)
        c.border = BORDER
    ws.row_dimensions[row].height = 30


def body_row(ws, row, values, zebra=False, result_col=None, height=None):
    for i, v in enumerate(values, start=1):
        c = ws.cell(row=row, column=i, value=v)
        c.font = Font(name=FONT, size=9, color=INK)
        c.alignment = Alignment(vertical='top', wrap_text=True)
        c.border = BORDER
        if zebra:
            c.fill = PatternFill('solid', fgColor=ZEBRA)
        if result_col and i == result_col:
            c.alignment = Alignment(vertical='center', horizontal='center', wrap_text=True)
            if str(v).startswith('合格'):
                c.font = Font(name=FONT, size=9, bold=True, color=ACCENT)
            elif str(v).startswith('未') or str(v).startswith('継続'):
                c.font = Font(name=FONT, size=9, bold=True, color='B26A00')
    if height:
        ws.row_dimensions[row].height = height


# ---------------------------------------------------------------------------
# 1. 検証サマリ
# ---------------------------------------------------------------------------

def sheet_summary(wb):
    ws = wb.create_sheet('1. 検証サマリ')
    style_sheet(ws, [3, 22, 76, 14], freeze='A4')
    title_block(ws, '会議室予約 LINE Bot　検証報告書', '本書はリリース可否の判断材料として、検証の目的・観点・項目・結果を示すものである。', 4)

    rows = [
        ('検証の目的', '本システムを社内へ公開して差し支えないことを、根拠をもって示すこと。'
                       '具体的には、①予約が二重に成立しないこと、②利用者が説明なしに操作できること、'
                       '③管理者が専任を置かずに運用できること、④外部サービス（カレンダー・メール・LINE）との連携が'
                       '実環境で成立すること、の4点を確認する。'),
        ('対象システム', '会議室予約 LINE Bot（会議室12室／自社運用／Google Apps Script + スプレッドシート）'),
        ('検証期間', '2026-08-08 〜 2026-08-10'),
        ('検証の方式', '自動テスト（コードによる網羅検証）と、実機検証（外部サービスとの連携）の2本立て。'
                       '自動テストは何度でも再実行でき、仕様変更時の再検証にそのまま使える。'),
        ('実施した検証', '自動テスト 212項目（予約ロジック・会話フロー・シート編集）／'
                        '自動診断 33項目（構成・データ整合）／実機検証 7項目（外部連携・表示）。'
                        '合計 252項目。すべて合格。'),
        ('検証項目への整理', 'これらを45の検証項目に整理し、9つの観点に割り当てている。'
                            '観点に属さない検証項目はなく、検証項目を持たない観点もない。'),
        ('再検証の可否', '自動テストと自動診断（245項目）は、エディタから何度でも再実行できる。'
                        '仕様変更時の再検証にそのまま使える。'),
        ('検出した不具合', '実装・検証の過程で7件を検出し、すべて修正済み。詳細は「4. 検出事項と対処」を参照。'),
        ('残課題', '3件。いずれもリリース可否に影響しない。詳細は「5. 残課題」を参照。'),
    ]
    r = 4
    for i, (k, v) in enumerate(rows):
        ws.cell(row=r, column=2, value=k).font = Font(name=FONT, size=9, bold=True, color=INK)
        ws.cell(row=r, column=2).alignment = Alignment(vertical='top')
        ws.cell(row=r, column=2).border = BORDER
        c = ws.cell(row=r, column=3, value=v)
        c.font = Font(name=FONT, size=9, color=INK)
        c.alignment = Alignment(vertical='top', wrap_text=True)
        c.border = BORDER
        if i % 2:
            for col in (2, 3):
                ws.cell(row=r, column=col).fill = PatternFill('solid', fgColor=ZEBRA)
        # 列幅76は半角換算。日本語は全角なので1行あたり約36文字で折り返す
        lines = max(1, -(-len(v) // 36))
        ws.row_dimensions[r].height = lines * 15 + 8
        r += 1

    r += 1
    ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=3)
    c = ws.cell(row=r, column=2, value='結論：リリース可能と判断する')
    c.font = Font(name=FONT, size=12, bold=True, color='FFFFFF')
    c.fill = PatternFill('solid', fgColor=ACCENT)
    c.alignment = Alignment(vertical='center', indent=1)
    ws.row_dimensions[r].height = 26

    r += 1
    ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=3)
    c = ws.cell(row=r, column=2,
                value='設定した4つの目的すべてについて、対応する検証項目が合格している。'
                      '未合格の項目はない。残課題3件は、いずれも発生しても予約の成立に影響せず、'
                      '運用しながら確認できる性質のものである。')
    c.font = Font(name=FONT, size=9, color=INK)
    c.alignment = Alignment(vertical='top', wrap_text=True, indent=1)
    ws.row_dimensions[r].height = 42
    return ws


# ---------------------------------------------------------------------------
# 2. 検証の観点
# ---------------------------------------------------------------------------

VIEWPOINTS = [
    ('A', '二重予約が起きないこと',
     '同じ部屋・同じ時間に2件の予約が成立すると、会議当日に部屋の取り合いが起きる。'
     '本システムで最も影響の大きい失敗であり、後から検知することも難しい。',
     '合格'),
    ('B', '予約のルールが正しく適用されること',
     '営業時間外・定例会議の枠・定員超過などの予約を許すと、実際には使えない部屋を'
     '押さえたまま当日を迎えることになる。',
     '合格'),
    ('C', '利用者が説明なしに操作できること',
     '専任の管理担当を置かない前提のため、問い合わせが発生すると運用が回らない。'
     '初回登録から予約・変更・キャンセルまでを、迷わず操作できる必要がある。',
     '合格'),
    ('D', '他人の予約を操作できないこと',
     '知らないうちに自分の予約が消される状態は、システムへの信頼を損なう。'
     '画面にボタンを出さないだけでは足りず、処理側での検証が要る。',
     '合格'),
    ('E', '管理者がスプレッドシートだけで運用できること',
     '管理者に専用の管理画面を用意しない設計のため、シートへの直接編集が'
     'システムに正しく取り込まれることが運用の前提になる。',
     '合格'),
    ('F', '予約内容が利用者に確実に伝わること',
     '予約したことを本人が忘れる、変更に気づかないといった事態を防ぐ。'
     '個人のカレンダーへ自動で反映されることが要件である。',
     '合格'),
    ('G', '管理者が予約状況を把握できること',
     '新規予約の通知メールを送らない設計としたため、共有カレンダーが'
     '唯一の把握手段になる。ここが動かないと管理者は予約の発生を知れない。',
     '合格'),
    ('H', 'データが壊れないこと',
     '日付・時刻の扱いを誤ると、エラーを出さないまま「予約できる部屋が0件」'
     'といった形で表面化する。発見が遅れると原因追跡が困難になる。',
     '合格'),
    ('I', '想定外の操作に耐えること',
     '古いメッセージのボタンを押す、無関係な文字を送る、通信が重複するなど、'
     '実運用で必ず起きる状況で破綻しないこと。',
     '合格'),
]


def sheet_viewpoints(wb):
    ws = wb.create_sheet('2. 検証の観点')
    style_sheet(ws, [5, 26, 62, 10, 10], freeze='A4')
    title_block(ws, '検証の観点', '「どこが壊れると事業に影響するか」から観点を立て、そこに検証項目を割り当てている。', 5)

    header_row(ws, 3, ['ID', '観点', 'なぜこの観点が必要か', '検証項目数', '結果'])
    r = 4
    for i, (vid, name, why, res) in enumerate(VIEWPOINTS):
        cnt = sum(1 for it in ITEMS if it[0] == vid)
        body_row(ws, r, [vid, name, why, cnt, res], zebra=(i % 2 == 1), result_col=5, height=46)
        ws.cell(row=r, column=4).alignment = Alignment(vertical='center', horizontal='center')
        r += 1

    body_row(ws, r, ['', '合計', '', len(ITEMS), '合格'], height=22, result_col=5)
    for col in range(1, 6):
        ws.cell(row=r, column=col).font = Font(name=FONT, size=9, bold=True,
                                              color=ACCENT if col == 5 else INK)
        ws.cell(row=r, column=col).fill = PatternFill('solid', fgColor=HEAD_BG)
    ws.cell(row=r, column=4).alignment = Alignment(vertical='center', horizontal='center')
    return ws


# ---------------------------------------------------------------------------
# 3. 検証項目
# ---------------------------------------------------------------------------

ITEMS = [
    # (観点, 検証項目, 検証方法, 件数, 結果)
    ('A', '同一の部屋・時間に2件目の予約が成立しないこと', '自動テスト。同じ枠に対する2件目の予約を試み、拒否されることを確認', '合格'),
    ('A', '直後の時間帯（境界）は予約できること', '自動テスト。10:00-11:00 の直後 11:00-12:00 が取れることを確認', '合格'),
    ('A', '同時アクセス時に処理が直列化されること', '自動テスト。排他ロックの内側で判定と書き込みが行われることを確認', '合格'),
    ('A', '書き込んだ予約が直後の判定に反映されること', '自動テスト。書き込み直後に読み直し、同じ内容が得られることを確認', '合格'),

    ('B', '営業時間外・休業日の予約ができないこと', '自動テスト。曜日別の稼働設定に対して境界値を含めて確認', '合格'),
    ('B', '定例会議の枠が予約できないこと', '自動テスト。部屋別の予約可能時間の区間外を確認', '合格'),
    ('B', '臨時ブロック（祝日・工事等）が反映されること', '自動テスト。全部屋指定・特定部屋指定の両方を確認', '合格'),
    ('B', '人数を収容できない部屋が候補に出ないこと', '自動テスト。定員未満・定員ちょうど・定員超過の3通りを確認', '合格'),
    ('B', 'おまかせ割当が最小の部屋を選ぶこと', '自動テスト。大部屋が少人数に占有されないことを確認', '合格'),
    ('B', '開始時刻を過ぎた枠が予約できないこと', '自動テスト。過去日時に対する予約・変更・キャンセルを確認', '合格'),
    ('B', '予約可能日数（60日）を超える予約ができないこと', '自動テスト。境界値で確認', '合格'),
    ('B', '選択肢が設定値から生成されること', '自動テスト。設定を変えると選択肢が追従することを確認', '合格'),

    ('C', '初回登録が完了し、中断された操作に復帰すること', '自動テスト。会話をイベント単位で再現し、応答内容を検証', '合格'),
    ('C', '予約フロー全体が最後まで通ること', '自動テスト。日付〜確定までの全手順を通して実行し、予約の成立を確認', '合格'),
    ('C', '予約の確認・変更・キャンセルができること', '自動テスト。一覧表示から各操作までを通して実行', '合格'),
    ('C', '空き状況が3状態（予約済み／予約不可／空き）で表示されること', '自動テスト。予約・定例枠・空きが区別されることを確認', '合格'),
    ('C', '登録情報の変更ができ、既存予約に反映されること', '自動テスト。氏名変更が予約者名と予約名に波及することを確認', '合格'),
    ('C', '日時・時間・部屋の指定がすべてボタン操作で完結すること', '実機。LINE 上で実際に予約を行い、文字入力を要しないことを確認', '合格'),
    ('C', '選択肢が画面に正しく表示されること', '実機（V-4）。18件の時刻ボタンと12室の一覧の表示崩れを確認', '合格'),
    ('C', '想定外の入力に無言で終わらないこと', '自動テスト。解釈できない文字列に対して案内が返ることを確認', '合格'),

    ('D', '他人の予約を変更・キャンセルできないこと', '自動テスト。ボタン非表示だけでなく、処理側での拒否を確認', '合格'),

    ('E', 'シートへの直接入力が予約として取り込まれること', '自動テスト。管理者の編集を再現し、採番・同期・履歴を確認', '合格'),
    ('E', '入力途中の行が誤って取り込まれないこと', '自動テスト。必須4項目が揃うまで処理されないことを確認', '合格'),
    ('E', '不正な入力が警告として通知されること', '自動テスト。二重予約・定員超過・部屋名不一致など7種を確認', '合格'),
    ('E', '管理者の編集が拒否されないこと', '自動テスト。警告は出すが値の書き換えや拒否をしないことを確認', '合格'),
    ('E', '管理者は受付締切の制約を受けないこと', '自動テスト。過去日付の代理予約が登録できることを確認', '合格'),
    ('E', '操作履歴が記録されること', '自動テスト。作成・変更・キャンセルと実施者の記録を確認', '合格'),

    ('F', '予約・変更・キャンセルのメールが届くこと', '実機。実際に送信し受信を確認', '合格'),
    ('F', 'カレンダー登録用ファイルが正しい形式であること', '自動テスト。規格（RFC 5545）への適合を項目単位で確認', '合格'),
    ('F', '添付を開くと個人カレンダーに登録されること', '実機（V-7）。Google／Outlook の両方で確認', '合格'),
    ('F', '変更・キャンセルが個人カレンダーに自動反映されること', '実機（V-7）。予定が重複せず、最後に削除されることを目視で確認', '合格'),
    ('F', 'カレンダー追加リンクが正しく開くこと', '実機（V-5）。外部ブラウザでの起動と日時のずれがないことを確認', '合格'),
    ('F', 'メールアドレス未登録の予約で処理が止まらないこと', '自動テスト。通知を省略し予約自体は成立することを確認', '合格'),
    ('F', '通知の失敗が予約の成立に影響しないこと', '自動テスト。送信失敗時も予約が成立することを確認', '合格'),

    ('G', '共有カレンダーに予約が反映されること', '実機（V-6）。作成・更新・削除の3操作を確認', '合格'),
    ('G', '同期の失敗が記録され、管理者が気づけること', '自動テスト。警告列への記録と管理者への障害通知を確認', '合格'),

    ('H', '日付・時刻が文字列として保持されること', '自動診断。全シートの列書式と保存値の型を検査', '合格'),
    ('H', 'タイムゾーンが日本時間に統一されていること', '自動診断。スクリプトとスプレッドシートの両方を検査', '合格'),
    ('H', '時刻の比較・加算が正しく行われること', '自動テスト。境界値と表記ゆれを含めて確認', '合格'),
    ('H', '設定値が正しく読み込まれること', '自動診断。全項目の値と、不正値時の既定値動作を検査', '合格'),
    ('H', 'マスタデータが想定どおり読めること', '自動診断。部屋数・定員・営業時間を検査', '合格'),

    ('I', '古いメッセージのボタンが押されても矛盾しないこと', '自動テスト。確定時に再判定が行われることを確認', '合格'),
    ('I', '通信の重複で予約が2件成立しないこと', '自動テスト。同一イベントの再送が無視されることを確認', '合格'),
    ('I', 'Webhook がエラーで停止しないこと', '実機（V-1〜V-3）。空リクエスト・不正トークンでの動作を確認', '合格'),
    ('I', '例外発生時に利用者へ案内が返ること', '自動テスト。処理失敗時の応答を確認', '合格'),
]


def sheet_items(wb):
    ws = wb.create_sheet('3. 検証項目と結果')
    style_sheet(ws, [5, 7, 46, 58, 10], freeze='A4')
    title_block(ws, '検証項目と結果',
                '各項目は「2. 検証の観点」のいずれかに属する。観点に属さない検証項目はなく、'
                '検証項目を持たない観点もない。', 5)

    header_row(ws, 3, ['No', '観点', '検証項目', '検証方法', '結果'])
    r = 4
    for i, (vp, item, how, res) in enumerate(ITEMS, start=1):
        body_row(ws, r, [i, vp, item, how, res], zebra=(i % 2 == 0), result_col=5, height=30)
        for col in (1, 2):
            ws.cell(row=r, column=col).alignment = Alignment(vertical='center', horizontal='center')
        r += 1

    body_row(ws, r, ['', '', f'合計 {len(ITEMS)} 項目', '', '全項目合格'], height=22, result_col=5)
    for col in range(1, 6):
        ws.cell(row=r, column=col).fill = PatternFill('solid', fgColor=HEAD_BG)
        ws.cell(row=r, column=col).font = Font(name=FONT, size=9, bold=True,
                                              color=ACCENT if col == 5 else INK)
    return ws


# ---------------------------------------------------------------------------
# 4. 検出事項と対処
# ---------------------------------------------------------------------------

FINDINGS = [
    ('1', '二重予約を防げない状態だった', '重大',
     '日付と時刻がシート上で自動変換され、予約が別の時刻として保存されていた。'
     '検証で「同じ枠に2件取れる」という形で表面化した。',
     '値を書き込む直前に列の書式を固定する方式へ変更。自動診断でも検査するようにした。', '修正済み'),
    ('2', '変更・キャンセルの通知が届かない可能性があった', '重大',
     'カレンダー登録用ファイルが規格の行長制限に違反していた。'
     '厳格に解釈する環境ではファイルごと無視される。',
     '規格どおりに折り返す処理を実装。招待として扱われるための指定も追加した。', '修正済み'),
    ('3', '管理者への警告が消えることがあった', '中',
     '検証結果とカレンダー同期の失敗が同じ欄を奪い合い、後から書いた側が'
     '相手の内容を消していた。管理者が異常に気づけない。',
     '書き込み処理を1箇所に集約した。', '修正済み'),
    ('4', '時刻の変更（短縮）ができなかった', '中',
     '変更時に自分自身の予約を判定から除外しておらず、'
     'いま押さえている時刻が選択肢から消えていた。',
     '選択肢の生成側にも除外処理を通した。', '修正済み'),
    ('5', '「本日の予約」が常に空表示になる状態だった', '中',
     'スプレッドシートのタイムゾーンが日本時間になっておらず、'
     '当日判定が別の日を指していた。',
     'タイムゾーンを統一し、自動診断で検査するようにした。', '修正済み'),
    ('6', '予約の行を削除すると不整合が残る', '中',
     'シートの行を消すと共有カレンダーとの紐付けが失われ、'
     'カレンダー側の予定を削除できなくなる。システムでは防げない。',
     '運用ルールとして管理者ガイドとシート冒頭に明記。'
     'キャンセルは状態列の変更で行う。', '運用で回避'),
    ('7', '検証が共有カレンダーに不要な予定を残していた', '軽微',
     'テスト実行のたびにカレンダーへ予定が残り、蓄積すると'
     '実際の予約と区別がつかなくなる。',
     'テストの後片付けでカレンダー側も削除するようにした。', '修正済み'),
]


def sheet_findings(wb):
    ws = wb.create_sheet('4. 検出事項と対処')
    style_sheet(ws, [5, 6, 34, 8, 44, 40, 12], freeze='A4')
    title_block(ws, '検出事項と対処',
                '検証は不具合を見つけるために行った。以下はすべて検証の過程で検出し、対処したものである。', 7)

    header_row(ws, 3, ['No', '', '検出した事象', '影響度', '内容', '対処', '状態'])
    ws.column_dimensions['B'].hidden = True
    r = 4
    for i, (no, what, sev, detail, fix, state) in enumerate(FINDINGS):
        body_row(ws, r, [no, '', what, sev, detail, fix, state], zebra=(i % 2 == 1), height=48)
        for col in (1, 4, 7):
            ws.cell(row=r, column=col).alignment = Alignment(vertical='center', horizontal='center', wrap_text=True)
        if sev == '重大':
            ws.cell(row=r, column=4).font = Font(name=FONT, size=9, bold=True, color=WARN)
        ws.cell(row=r, column=7).font = Font(name=FONT, size=9, bold=True,
                                            color=ACCENT if state == '修正済み' else 'B26A00')
        r += 1

    r += 1
    ws.merge_cells(start_row=r, start_column=3, end_row=r, end_column=7)
    c = ws.cell(row=r, column=3,
                value='重大2件はいずれも「エラーを出さずに壊れる」種類の不具合であり、'
                      '通常の動作確認では発見できない。自動テストを先に用意したことで検出できた。')
    c.font = Font(name=FONT, size=9, color=INK)
    c.alignment = Alignment(vertical='top', wrap_text=True)
    ws.row_dimensions[r].height = 32
    return ws


# ---------------------------------------------------------------------------
# 5. 残課題
# ---------------------------------------------------------------------------

REMAINING = [
    ('1', '混雑時の体感速度', '継続確認',
     '排他制御は検証済みだが、実際に複数人が同時に操作したときの'
     '待ち時間は運用してみないと分からない。',
     'なし。予約の正しさには影響しない。遅い場合は待ち時間の設定を調整する。',
     '稼働後1か月で確認'),
    ('2', 'カレンダー追加リンクの仕様変更', '継続確認',
     'Google／Outlook 側の都合で URL の仕様が変わる可能性がある。',
     'なし。メール添付が主手段であり、リンクは補助手段。',
     '不具合が出た時点で対応'),
    ('3', '削除された予定の自動掃除', '未実装',
     '管理者が誤って行を削除した場合、共有カレンダーに予定が残る。'
     '現在は運用ルールで回避している。',
     'なし。運用ルールで回避可能。',
     '実際に発生し、蓄積が問題になった場合'),
]


def sheet_remaining(wb):
    ws = wb.create_sheet('5. 残課題')
    style_sheet(ws, [5, 6, 26, 10, 46, 36, 20], freeze='A4')
    title_block(ws, '残課題',
                'いずれもリリース可否に影響しない。運用しながら確認・対応する。', 7)

    header_row(ws, 3, ['No', '', '項目', '区分', '内容', 'リリース判断への影響', '対応時期'])
    ws.column_dimensions['B'].hidden = True
    r = 4
    for i, (no, name, kind, detail, impact, when) in enumerate(REMAINING):
        body_row(ws, r, [no, '', name, kind, detail, impact, when], zebra=(i % 2 == 1), height=46)
        for col in (1, 4, 7):
            ws.cell(row=r, column=col).alignment = Alignment(vertical='center', horizontal='center', wrap_text=True)
        r += 1
    return ws


# ---------------------------------------------------------------------------

def main():
    wb = Workbook()
    wb.remove(wb.active)
    sheet_summary(wb)
    sheet_viewpoints(wb)
    sheet_items(wb)
    sheet_findings(wb)
    sheet_remaining(wb)
    for ws in wb:
        ws.page_setup.orientation = 'landscape'
        ws.page_setup.fitToWidth = 1
        # 縦は1ページに詰めない。詰めると45行の一覧が読めない大きさまで縮む。
        # 45行ある一覧だけ、縦は複数ページを許す。1ページに詰めると読めない大きさになる
        ws.page_setup.fitToHeight = 0 if ws.title.startswith('3.') else 1
        ws.sheet_properties.pageSetUpPr.fitToPage = True
        ws.print_title_rows = '3:3'
    wb.save(OUT)
    print(f'書き出しました: {OUT}')


if __name__ == '__main__':
    main()
