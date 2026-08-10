#!/usr/bin/env python3
"""
リッチメニューの画像を生成し、LINE に登録する。

LINE 公式アカウントマネージャーのリッチメニューは各領域に「テキスト送信」しか
設定できないが、Messaging API から登録すれば postback を割り当てられる。
これにより「今日」「明日」から1タップで予約フローに入れる。

日付は postback に焼き込まず 'today' / 'tomorrow' の相対指定で送る。
焼き込むとメニューを毎日作り直す羽目になる。解決は GAS 側の resolveRelativeDate。

使い方:
    python tools/make_richmenu.py            # 画像を作って登録し、既定に設定する
    python tools/make_richmenu.py --image    # 画像を作るだけ（登録しない）
    python tools/make_richmenu.py --clean    # 登録前に既存のリッチメニューを削除する
"""

import argparse
import json
import pathlib
import sys

import requests
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / "src" / ".env"
OUT_PATH = ROOT / "tools" / "richmenu.png"

# LINE のリッチメニュー画像の規定サイズ（大）
WIDTH, HEIGHT = 2500, 1686

FONT_BOLD = "C:/Windows/Fonts/meiryob.ttc"
FONT_REG = "C:/Windows/Fonts/meiryo.ttc"

BG = (255, 255, 255)
LINE_COLOR = (222, 226, 230)
TEXT = (33, 37, 41)
SUB = (134, 142, 150)
ACCENT = (27, 94, 32)        # 予約系（緑）
ACCENT_BG = (232, 245, 233)
INFO = (21, 101, 192)        # 参照系（青）

# 3列 × 2行
COLS, ROWS = 3, 2
CELL_W = WIDTH // COLS
CELL_H = HEIGHT // ROWS

CELLS = [
    # (見出し, 補足, postback データ, タップ時に会話に残す文言, 種別)
    ("今日", "すぐ予約する", "a=new&d=today", "今日の予約", "book"),
    ("明日", "すぐ予約する", "a=new&d=tomorrow", "明日の予約", "book"),
    ("日付を選ぶ", "先の予定を予約", "a=new", "日付を選んで予約", "book"),
    ("予約の確認", "変更・キャンセル", "a=list", "予約の確認", "info"),
    ("空き状況", "部屋を探す", "a=avail", "空き状況", "info"),
    ("使い方", "はじめての方へ", "a=help", "使い方", "info"),
]


# ---------------------------------------------------------------------------
# 画像
# ---------------------------------------------------------------------------

def cell_box(index):
    col, row = index % COLS, index // COLS
    x0 = col * CELL_W
    y0 = row * CELL_H
    # 端数を最後の列・行に寄せて、隙間ができないようにする
    x1 = WIDTH if col == COLS - 1 else x0 + CELL_W
    y1 = HEIGHT if row == ROWS - 1 else y0 + CELL_H
    return x0, y0, x1, y1


def draw_icon(d, kind, cx, cy, size, color):
    """テキストだけだと単調なので、簡単な図形を添える。絵文字はフォント依存が大きいので使わない。"""
    h = size // 2
    w = size * 5 // 8
    lw = max(6, size // 18)

    if kind in ("today", "tomorrow", "pick"):
        # カレンダー
        top = cy - h
        d.rounded_rectangle([cx - w, top, cx + w, cy + h], radius=size // 8, outline=color, width=lw)
        d.line([cx - w, top + size // 4, cx + w, top + size // 4], fill=color, width=lw)
        d.line([cx - w // 2, top - size // 8, cx - w // 2, top + size // 10], fill=color, width=lw)
        d.line([cx + w // 2, top - size // 8, cx + w // 2, top + size // 10], fill=color, width=lw)
        if kind == "pick":
            r = size // 14
            for i in range(3):
                for j in range(2):
                    px = cx - w // 2 + i * (w // 2)
                    py = top + size // 2 + j * (size // 4)
                    d.ellipse([px - r, py - r, px + r, py + r], fill=color)
        else:
            d.ellipse([cx - size // 10, cy + size // 12 - size // 10,
                       cx + size // 10, cy + size // 12 + size // 10], fill=color)

    elif kind == "list":
        for i in range(3):
            y = cy - h + size // 4 + i * (size // 3)
            r = max(5, size // 22)
            d.ellipse([cx - w, y - r, cx - w + 2 * r, y + r], fill=color)
            d.line([cx - w + size // 5, y, cx + w, y], fill=color, width=lw)

    elif kind == "grid":
        gap = size // 12
        cell = (2 * w - gap) // 2
        for i in range(2):
            for j in range(2):
                x = cx - w + i * (cell + gap)
                y = cy - h + j * (cell + gap)
                filled = (i + j) % 2 == 0
                if filled:
                    d.rounded_rectangle([x, y, x + cell, y + cell], radius=size // 14, fill=color)
                else:
                    d.rounded_rectangle([x, y, x + cell, y + cell], radius=size // 14,
                                        outline=color, width=lw)

    elif kind == "help":
        d.ellipse([cx - h, cy - h, cx + h, cy + h], outline=color, width=lw)
        f = ImageFont.truetype(FONT_BOLD, int(size * 0.72))
        d.text((cx, cy - size // 24), "?", font=f, fill=color, anchor="mm")


def centered(d, text, font, cx, y, fill):
    d.text((cx, y), text, font=font, fill=fill, anchor="ma")


def build_image():
    img = Image.new("RGB", (WIDTH, HEIGHT), BG)
    d = ImageDraw.Draw(img)

    f_main = ImageFont.truetype(FONT_BOLD, 108)
    f_sub = ImageFont.truetype(FONT_REG, 52)

    icons = ["today", "tomorrow", "pick", "list", "grid", "help"]

    for i, (title, sub, _data, _display, kind) in enumerate(CELLS):
        x0, y0, x1, y1 = cell_box(i)
        color = ACCENT if kind == "book" else INFO

        # 予約系の行は薄く色を敷いて、主たる導線であることを示す
        if kind == "book":
            d.rectangle([x0, y0, x1, y1], fill=ACCENT_BG)

        cx = (x0 + x1) // 2
        draw_icon(d, icons[i], cx, y0 + 250, 190, color)
        centered(d, title, f_main, cx, y0 + 420, TEXT)
        centered(d, sub, f_sub, cx, y0 + 570, SUB)

    # 区切り線は最後に引く。背景を塗ったあとでないと消える。
    for c in range(1, COLS):
        x = c * CELL_W
        d.line([x, 0, x, HEIGHT], fill=LINE_COLOR, width=4)
    d.line([0, CELL_H, WIDTH, CELL_H], fill=LINE_COLOR, width=4)

    return img


def build_menu_json():
    areas = []
    for i, (_title, _sub, data, display, _kind) in enumerate(CELLS):
        x0, y0, x1, y1 = cell_box(i)
        areas.append({
            "bounds": {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0},
            "action": {"type": "postback", "data": data, "displayText": display},
        })
    return {
        "size": {"width": WIDTH, "height": HEIGHT},
        "selected": True,
        "name": "会議室予約メニュー",
        "chatBarText": "メニュー",
        "areas": areas,
    }


# ---------------------------------------------------------------------------
# LINE への登録
# ---------------------------------------------------------------------------

def read_token():
    """.env からチャネルアクセストークンを読む。キー名の表記ゆれを吸収する。"""
    if not ENV_PATH.exists():
        sys.exit(f".env が見つかりません: {ENV_PATH}")

    for raw in ENV_PATH.read_text(encoding="utf-8-sig").splitlines():
        if "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        if "token" in key.strip().lower().replace(" ", ""):
            token = value.strip().strip("'\"")
            if token:
                return token
    sys.exit(".env にチャネルアクセストークンが見つかりません。")


def api(method, url, token, **kwargs):
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = f"Bearer {token}"
    res = requests.request(method, url, headers=headers, timeout=60, **kwargs)
    if res.status_code >= 300:
        sys.exit(f"{method} {url}\n  -> {res.status_code} {res.text}")
    return res


def register(token, png_bytes, clean):
    existing = api("GET", "https://api.line.me/v2/bot/richmenu/list", token).json()
    menus = existing.get("richmenus", [])
    if menus:
        print(f"既存のリッチメニュー: {len(menus)} 件")
        for m in menus:
            print(f"  - {m['richMenuId']}  {m.get('name', '')}")
        if clean:
            for m in menus:
                api("DELETE", f"https://api.line.me/v2/bot/richmenu/{m['richMenuId']}", token)
            print("  → 削除しました")
        else:
            print("  → 残したままにします（消すなら --clean）")

    created = api(
        "POST", "https://api.line.me/v2/bot/richmenu", token,
        headers={"Content-Type": "application/json"},
        data=json.dumps(build_menu_json()).encode("utf-8"),
    ).json()
    rid = created["richMenuId"]
    print(f"作成しました: {rid}")

    api("POST", f"https://api-data.line.me/v2/bot/richmenu/{rid}/content", token,
        headers={"Content-Type": "image/png"}, data=png_bytes)
    print("画像をアップロードしました")

    api("POST", f"https://api.line.me/v2/bot/user/all/richmenu/{rid}", token)
    print("全ユーザーの既定メニューに設定しました")
    return rid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", action="store_true", help="画像を作るだけで登録しない")
    ap.add_argument("--clean", action="store_true", help="既存のリッチメニューを削除してから登録する")
    args = ap.parse_args()

    img = build_image()
    img.save(OUT_PATH, "PNG", optimize=True)
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"画像を書き出しました: {OUT_PATH} ({size_kb:.0f} KB / 上限 1024 KB)")
    if size_kb > 1024:
        sys.exit("画像が 1MB を超えています。色数を減らすか JPEG にしてください。")

    if args.image:
        print("登録は行いません（--image）")
        return

    token = read_token()
    print(f"チャネルアクセストークンを読み込みました（{len(token)} 文字）")
    register(token, OUT_PATH.read_bytes(), args.clean)

    print("\n完了しました。LINE のトーク画面を開き直すとメニューが切り替わります。")
    print("切り替わらない場合は、トークルームを一度閉じるか、アプリを再起動してください。")


if __name__ == "__main__":
    main()
