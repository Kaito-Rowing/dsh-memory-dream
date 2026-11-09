#!/usr/bin/env python3
"""Architecture diagram for dsh-memory-dream, matching the 0.2 implementation."""

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import matplotlib.font_manager as fm

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

JP = pick_font()
if JP:
    plt.rcParams["font.family"] = JP
    plt.rcParams["font.sans-serif"] = [JP]
plt.rcParams["svg.fonttype"] = "none"
plt.rcParams["axes.unicode_minus"] = False

BG = "#ffffff"
INK = "#1a202c"
MUTED = "#718096"
BLUE = "#4d6bfe"
BLUE_L = "#ebf0ff"
AMBER = "#b7791f"
AMBER_L = "#fefcbf"
GREEN = "#276749"
GREEN_L = "#f0fff4"
GRAY_L = "#f7fafc"
GRAY_B = "#cbd5e0"

fig, ax = plt.subplots(figsize=(12.4, 9.6), dpi=100)
fig.patch.set_facecolor(BG)
ax.set_facecolor(BG)
ax.set_xlim(0, 12.4)
ax.set_ylim(0, 9.6)
ax.axis("off")


def box(x, y, w, h, title, sub, face=GRAY_L, edge=GRAY_B, title_color=INK, lw=1.4, fs=12.5):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0.02,rounding_size=0.12",
        linewidth=lw, edgecolor=edge, facecolor=face, zorder=2,
    ))
    ty = y + h - 0.30 if sub else y + h / 2
    ax.text(x + w / 2, ty, title, ha="center", va="top" if sub else "center",
            fontsize=fs, fontweight="bold", color=title_color, zorder=3)
    if sub:
        ax.text(x + w / 2, y + h - 0.66, sub, ha="center", va="top",
                fontsize=8.6, color=MUTED, zorder=3, linespacing=1.5)


def arrow(p1, p2, label="", color=MUTED, ls="-", lw=1.7, rad=0.0,
          lx=None, ly=None, fs=8.5):
    ax.add_patch(FancyArrowPatch(
        p1, p2, arrowstyle="-|>", mutation_scale=13,
        linewidth=lw, color=color, linestyle=ls,
        connectionstyle=f"arc3,rad={rad}", zorder=1, shrinkA=3, shrinkB=3,
    ))
    if label:
        mx = lx if lx is not None else (p1[0] + p2[0]) / 2
        my = ly if ly is not None else (p1[1] + p2[1]) / 2
        ax.text(mx, my, label, ha="center", va="center", fontsize=fs,
                color=color, zorder=5,
                bbox=dict(boxstyle="round,pad=0.3", fc=BG, ec="none", alpha=0.97))


# Title
ax.text(0.5, 9.20, "dsh-memory-dream", fontsize=20, fontweight="bold", color=INK)
ax.text(0.5, 8.82, "Layered memory with a dream pass that checks memory against the conversation",
        fontsize=10.5, color=MUTED)

# --- injected layer ---
box(0.5, 7.35, 5.2, 1.15, "MEMORY.md",
    "index only · hard cap · injected every turn",
    face=BLUE_L, edge=BLUE, title_color=BLUE, lw=2.2)

box(6.55, 7.35, 5.35, 1.15, "prompt", "systemPrompt.context, rendered per turn",
    face="#2d3748", edge="#2d3748", title_color="#ffffff")
arrow((5.7, 7.92), (6.55, 7.92), "injected", color=BLUE, lw=2.4, lx=6.12, ly=8.14)

# --- wiki ---
box(0.5, 5.55, 5.2, 1.15, "wiki/", "one page per topic · detail lives here")

# --- notes ---
box(0.5, 3.75, 5.2, 1.15, "notes/", "YYYY-MM-DD.md · what the agent recorded")

# --- transcripts ---
box(0.5, 1.95, 5.2, 1.15, "transcripts", "~/.dsh/sessions/ · what was actually said",
    face=GREEN_L, edge=GREEN, title_color=GREEN)

# left column flow
arrow((3.1, 3.75), (3.1, 5.55), "memory_wiki", lx=4.35, ly=4.65)
arrow((3.1, 1.95), (3.1, 3.75), "memory_note", lx=4.35, ly=2.85)

# --- dream outputs ---
box(6.55, 5.55, 5.35, 1.15, "dreams/YYYY-MM-DD.md",
    "history · appended to, never rewritten",
    face=AMBER_L, edge=AMBER, title_color=AMBER, fs=11.5)

box(6.55, 3.75, 5.35, 1.15, "dreams/SYNTHESIS.md",
    "current guidance · rewritten freely",
    face=AMBER_L, edge=AMBER, title_color=AMBER, fs=11.5)

# dream hub
ax.text(9.22, 3.05, "dream", ha="center", va="center",
        fontsize=12.5, fontweight="bold", color=AMBER, zorder=4)
ax.text(9.22, 2.55, "verify memory against the transcripts,\nrecord what it cannot resolve",
        ha="center", va="center", fontsize=8.8, color=MUTED, linespacing=1.6, zorder=4)

# dream -> layers
arrow((6.55, 6.12), (5.7, 6.12), "correct", color=AMBER, lx=6.12, ly=6.36)
arrow((6.55, 4.32), (5.7, 4.32), "promote", color=AMBER, lx=6.12, ly=4.56)
arrow((9.22, 5.55), (9.22, 4.90), color=AMBER, lw=1.6)
arrow((9.22, 3.75), (9.22, 3.35), color=AMBER, lw=1.6)

# transcripts feed the dream (the key 0.2 change).
# Routed below the dream description so the label does not overlap it.
ax.add_patch(FancyArrowPatch(
    (5.7, 2.30), (9.22, 2.30), arrowstyle="-|>", mutation_scale=13,
    linewidth=2.0, color=GREEN,
    connectionstyle="arc3,rad=0.0", zorder=1, shrinkA=3, shrinkB=3,
))
ax.text(7.46, 2.08, "evidence", ha="center", va="center", fontsize=9,
        color=GREEN, zorder=5,
        bbox=dict(boxstyle="round,pad=0.3", fc=BG, ec="none", alpha=0.97))

# synthesis -> prompt
arrow((11.9, 4.32), (11.9, 7.35), color=AMBER, ls=":", lw=1.8)
ax.text(12.02, 5.85, "referenced", ha="center", va="center", fontsize=8.2,
        color=AMBER, rotation=90, zorder=5,
        bbox=dict(boxstyle="round,pad=0.22", fc=BG, ec="none", alpha=0.97))

# --- guarantees strip ---
ax.add_patch(FancyBboxPatch(
    (0.5, 0.55), 11.4, 0.92,
    boxstyle="round,pad=0.02,rounding_size=0.1",
    linewidth=1.3, edgecolor=BLUE, facecolor=BLUE_L, zorder=2,
))
ax.text(0.78, 1.22, "guarantees", fontsize=9.5, fontweight="bold",
        color=BLUE, va="center", zorder=3)
ax.text(0.78, 0.86,
        "atomic writes (temp + rename)   ·   one writer per root (in-process mutex + lock file)   ·   "
        "path validation on every model-supplied name",
        fontsize=8.6, color=MUTED, va="center", zorder=3)

ax.text(0.78, 0.70,
        "injection scan on every read path   ·   blocked entries are replaced, never deleted",
        fontsize=8.6, color=MUTED, va="center", zorder=3)

plt.tight_layout(pad=0.3)
plt.savefig("docs/architecture.svg", format="svg", facecolor=BG,
            bbox_inches="tight", pad_inches=0.25)
plt.savefig("docs/architecture.png", format="png", dpi=160, facecolor=BG,
            bbox_inches="tight", pad_inches=0.25)
print("wrote docs/architecture.svg and .png")
