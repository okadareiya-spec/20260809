#!/usr/bin/env python3
"""
チャット履歴を全量テキストに書き出す。

Claude Code の履歴は JSONL で保存されている。1回の会話が複数ファイルに
分かれることがある（文脈の圧縮が入ると新しいファイルに続く）ため、
指定したファイルを時系列に連結して1本のテキストにする。

開発初期のやりとりには、チャネルアクセストークンなどの認証情報がそのまま
含まれている。テキストにすると配布が容易になるため、既定で伏せ字にする。
本当に原文が必要な場合のみ --raw を付ける。

    python tools/export_transcript.py <出力先.txt> <入力.jsonl> [...]
    python tools/export_transcript.py --raw <出力先.txt> <入力.jsonl> [...]
"""

import json
import pathlib
import re
import sys

SEP = '=' * 78
SUB = '-' * 78

# 会話の本筋ではないもの。全量とはいえ、これらは読み手の邪魔にしかならない。
SKIP_TYPES = {'mode', 'custom-title', 'last-prompt', 'queue-operation'}

# 伏せ字にする対象。値の長さは残す（何が入っていたか追える）が、値そのものは消す。
SECRET_PATTERNS = [
    # キー名つきで書かれているもの
    (re.compile(r"((?:chanel\s*Acsess\s*Token|channel\s*access\s*token|CHANNEL_ACCESS_TOKEN"
                r"|channel\s*secret|Channel\s*secret|WEBHOOK_TOKEN)\s*[=:]\s*['\"]?)"
                r"([^\s'\"]{16,})", re.I), 'keyed'),
    # Webhook URL のトークン
    (re.compile(r"([?&]token=)([A-Za-z0-9_\-]{12,})"), 'keyed'),
    # 単独で現れる長い英数字列（トークンやデプロイIDの実体）
    (re.compile(r"(?<![A-Za-z0-9+/])([A-Za-z0-9+/]{60,}={0,2})(?![A-Za-z0-9+/])"), 'bare'),
]

REDACTED = 0


def redact(text):
    """認証情報を伏せ字にする。テキスト化すると配布が容易になるため既定で行う。"""
    global REDACTED

    def mask_keyed(m):
        global REDACTED
        REDACTED += 1
        return m.group(1) + f'〈伏せ字: {len(m.group(2))}文字〉'

    def mask_bare(m):
        global REDACTED
        REDACTED += 1
        return f'〈伏せ字: {len(m.group(1))}文字の英数字列〉'

    for pattern, kind in SECRET_PATTERNS:
        text = pattern.sub(mask_keyed if kind == 'keyed' else mask_bare, text)
    return text


def as_text(value):
    if value is None:
        return ''
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2)


def render_block(block, out):
    """メッセージ内の1ブロックを整形する"""
    if not isinstance(block, dict):
        out.append(as_text(block))
        return

    kind = block.get('type')

    if kind == 'text':
        out.append(block.get('text', ''))

    elif kind == 'thinking':
        out.append('［思考］')
        out.append(block.get('thinking', ''))

    elif kind == 'tool_use':
        out.append(f"［ツール実行］{block.get('name', '?')}")
        out.append(as_text(block.get('input')))

    elif kind == 'tool_result':
        out.append('［ツール結果］' + ('（エラー）' if block.get('is_error') else ''))
        content = block.get('content')
        if isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get('type') == 'text':
                    out.append(c.get('text', ''))
                elif isinstance(c, dict) and c.get('type') == 'image':
                    out.append('（画像は省略）')
                else:
                    out.append(as_text(c))
        else:
            out.append(as_text(content))

    elif kind == 'image':
        out.append('（画像は省略）')

    else:
        out.append(f'［{kind}］')
        out.append(as_text(block))


def render_entry(entry, out):
    kind = entry.get('type')
    stamp = entry.get('timestamp', '')
    message = entry.get('message')

    if kind in ('user', 'assistant') and isinstance(message, dict):
        who = 'ユーザー' if kind == 'user' else 'アシスタント'
        if entry.get('isCompactSummary'):
            who += '（文脈の圧縮による引き継ぎ）'
        out.append('')
        out.append(SEP)
        out.append(f'{who}   {stamp}')
        out.append(SEP)

        content = message.get('content')
        if isinstance(content, list):
            for i, block in enumerate(content):
                if i:
                    out.append('')
                render_block(block, out)
        else:
            out.append(as_text(content))

    elif kind == 'system':
        text = as_text(entry.get('content')).strip()
        if text:
            out.append('')
            out.append(SUB)
            out.append(f'［システム］{stamp}')
            out.append(text)

    elif kind == 'attachment':
        # 添付は本文と重複することが多いので、種別だけ残す
        att = entry.get('attachment') or {}
        label = att.get('type') or '不明'
        out.append(f'［添付: {label}］')


def main():
    args = sys.argv[1:]
    raw = '--raw' in args
    if raw:
        args.remove('--raw')
    if len(args) < 2:
        sys.exit(__doc__)

    out_path = pathlib.Path(args[0])
    sources = [pathlib.Path(p) for p in args[1:]]

    out = []
    out.append(SEP)
    out.append('会議室予約 LINE Bot 開発チャット履歴（全量）')
    out.append(SEP)
    out.append('')
    out.append('元データ:')
    counts = []
    for src in sources:
        out.append(f'  {src.name}')

    out.append('')
    out.append('【取り扱い注意】本ファイルには開発中のやりとりがそのまま含まれる。')
    out.append('スプレッドシートの内容やメールアドレスが含まれるため、')
    out.append('リポジトリにコミットしないこと。')
    out.append('')
    out.append('認証情報（チャネルアクセストークン・チャネルシークレット・Webhook トークン）は'
               if not raw else '【警告】--raw で出力したため、認証情報が伏せ字にされていない。')
    out.append('伏せ字にしてある。原文は元の JSONL に残っている。'
               if not raw else 'このファイルは第三者に渡さないこと。')
    out.append('')

    total = 0
    for src in sources:
        if not src.exists():
            sys.exit(f'ファイルが見つかりません: {src}')
        lines = src.read_text(encoding='utf-8').splitlines()
        kept = 0
        out.append('')
        out.append(SEP)
        out.append(f'■ {src.name}（{len(lines)} 件）')
        out.append(SEP)
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get('type') in SKIP_TYPES:
                continue
            render_entry(entry, out)
            kept += 1
        counts.append((src.name, len(lines), kept))
        total += kept

    text = '\n'.join(out) + '\n'
    if not raw:
        text = redact(text)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding='utf-8')

    print(f'書き出しました: {out_path}')
    print('  伏せ字にした認証情報: ' + (f'{REDACTED} 箇所' if not raw else 'なし【--raw】'))
    print(f'  {out_path.stat().st_size / 1024 / 1024:.1f} MB / {len(text.splitlines()):,} 行')
    for name, raw_n, kept in counts:
        print(f'  {name[:12]}…  {raw_n:5d} 件中 {kept:5d} 件を出力')


if __name__ == '__main__':
    main()
