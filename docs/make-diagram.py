#!/usr/bin/env python3
"""dsh-memory-dream のアーキテクチャ図を SVG / PNG で出力する。"""

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import matplotlib.font_manager as fm

# 日本語が出るフォントを探す（weight も確認）
def pick_font():
    for name in ["Yu Gothic UI", "Yu Gothic", "Meiryo", "MS Gothic",
                 "BIZ UDGothic", "Noto Sans JP", "Noto Sans CJK JP"]:
        try:
            path = fm.findfont(fm.FontProperties(family=name), fallback_to_default=False)
            if path and "DejaVu" not in path:
                return name
        except Exception:
            continue
    return None

JP_FONT = pick_font()
if JP_FONT:
    plt.rcParams["font.family"] = JP_FONT
    plt.rcParams["font.sans-serif"] = [JP_FONT]
plt.rcParams["svg.fonttype"] = "none"
plt.rcParams["axes.unicode_minus"] = False

BG = "#ffffff"
INK = "#1a202c"
MUTED = "#718096"
BLUE = "#4d6bfe"
BLUE_L = "#ebf0ff"
AMBER = "#b7791f"
AMBER_L = "#fefcbf"
GRAY_L = "#f7fafc"
GRAY_B = "#cbd5e0"

fig, ax = plt.subplots(figsize=(11.5, 9), dpi=100)
fig.patch.set_facecolor(BG)
ax.set_facecolor(BG)
ax.set_xlim(0, 11.5)
ax.set_ylim(0, 9)
ax.axis("off")


def box(x, y, w, h, title, sub, face=GRAY_L, edge=GRAY_B, title_color=INK, lw=1.4):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0.02,rounding_size=0.12",
        linewidth=lw, edgecolor=edge, facecolor=face, zorder=2,
    ))
    ty = y + h - 0.30 if sub else y + h / 2
    ax.text(x + w / 2, ty, title, ha="center", va="top" if sub else "center",
            fontsize=12.5, fontweight="bold", color=title_color, zorder=3)
    if sub:
        ax.text(x + w / 2, y + h - 0.66, sub, ha="center", va="top",
                fontsize=8.8, color=MUTED, zorder=3, linespacing=1.5)


def arrow(p1, p2, label="", color=MUTED, ls="-", lw=1.7, rad=0.0,
          lx=None, ly=None, fs=8.5, style="-|>"):
    ax.add_patch(FancyArrowPatch(
        p1, p2, arrowstyle=style, mutation_scale=13,
        linewidth=lw, color=color, linestyle=ls,
        connectionstyle=f"arc3,rad={rad}", zorder=1, shrinkA=3, shrinkB=3,
    ))
    if label:
        mx = lx if lx is not None else (p1[0] + p2[0]) / 2
        my = ly if ly is not None else (p1[1] + p2[1]) / 2
        ax.text(mx, my, label, ha="center", va="center", fontsize=fs,
                color=color, zorder=5,
                bbox=dict(boxstyle="round,pad=0.3", fc=BG, ec="none", alpha=0.97))


# タイトル
ax.text(0.5, 8.62, "dsh-memory-dream", fontsize=20, fontweight="bold", color=INK)
ax.text(0.5, 8.24, "Layered agent memory with a nightly correcting pass",
        fontsize=10.5, color=MUTED)

# --- 注入層 ---
box(0.5, 6.85, 4.7, 1.05, "MEMORY.md",
    "index only · hard character cap",
    face=BLUE_L, edge=BLUE, title_color=BLUE, lw=2.0)

box(6.1, 6.85, 4.9, 1.05, "prompt", "read on every turn",
    face="#2d3748", edge="#2d3748", title_color="#ffffff")
arrow((5.2, 7.37), (6.1, 7.37), color=BLUE, lw=2.4)

# --- 表現層 ---
box(0.5, 5.2, 4.7, 1.05, "wiki/", "one page per topic · detail lives here")

# --- ノート層 ---
box(0.5, 3.55, 4.7, 1.05, "notes/", "YYYY-MM-DD.md · raw day-to-day")

# --- トランスクリプト ---
box(0.5, 1.9, 4.7, 1.05, "transcripts", "~/.dsh/sessions/ · the session log")

# 左の縦の流れ（下から上へ）
arrow((2.85, 3.55), (2.85, 5.2), "memory_wiki", color=MUTED, lx=4.05, ly=4.38)
arrow((2.85, 1.9), (2.85, 3.55), "memory_note", color=MUTED, lx=4.05, ly=2.72)

# --- 夢の出力 ---
box(6.1, 5.2, 4.9, 1.05, "dreams/",
    "YYYY-MM-DD.md · historical record, never rewritten",
    face=AMBER_L, edge=AMBER, title_color=AMBER)

box(6.1, 3.55, 4.9, 1.05, "SYNTHESIS.md",
    "current guidance · rewritten freely",
    face=AMBER_L, edge=AMBER, title_color=AMBER)

# 夢 → 各層（左向き）
arrow((6.1, 4.08), (5.2, 4.08), "correct", color=AMBER, lx=5.65, ly=4.34)
arrow((6.1, 5.72), (5.2, 5.72), "promote one line", color=AMBER, lx=5.65, ly=5.46)

# 夢の縦の流れ（上から下）
arrow((8.55, 5.2), (8.55, 4.6), color=AMBER, lw=1.6)
arrow((8.55, 3.55), (8.55, 3.2), color=AMBER, lw=1.6)

# 夢の中心は矢印の下に置く（ラベルと重ならないように）
ax.text(8.55, 2.92, "dream", ha="center", va="center",
        fontsize=12, fontweight="bold", color=AMBER, zorder=4)
ax.text(8.55, 2.40, "verify what is written\nagainst the notes,\nthen correct it",
        ha="center", va="center", fontsize=8.6, color=MUTED, linespacing=1.6, zorder=4)

# 指針 → prompt（右端の縦線）
arrow((11.0, 4.08), (11.0, 6.85), color=AMBER, ls=":", lw=1.8)
ax.text(11.12, 5.5, "referenced", ha="center", va="center", fontsize=8.2,
        color=AMBER, rotation=90, zorder=5,
        bbox=dict(boxstyle="round,pad=0.22", fc=BG, ec="none", alpha=0.97))

# --- 注入スキャン ---
ax.add_patch(FancyBboxPatch(
    (0.5, 0.62), 10.5, 0.66,
    boxstyle="round,pad=0.02,rounding_size=0.1",
    linewidth=1.3, edgecolor=BLUE, facecolor=BLUE_L, zorder=2,
))
ax.text(0.78, 0.95, "injection scan", fontsize=9.5, fontweight="bold",
        color=BLUE, va="center", zorder=3)
ax.text(2.55, 0.95,
        "every read path is scanned entry by entry — a hit is replaced, not dropped",
        fontsize=8.8, color=MUTED, va="center", zorder=3)

plt.tight_layout(pad=0.3)
plt.savefig("docs/architecture.svg", format="svg", facecolor=BG,
            bbox_inches="tight", pad_inches=0.25)
plt.savefig("docs/architecture.png", format="png", dpi=160, facecolor=BG,
            bbox_inches="tight", pad_inches=0.25)
print("wrote docs/architecture.svg and .png")
