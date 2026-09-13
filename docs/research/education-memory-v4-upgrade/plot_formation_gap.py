"""Render the audited source-probe routing gap; no inferred or generated counts."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--diagnostic", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.diagnostic.read_text())
    counts = data["counts"]
    total = counts["probes"]
    assert data["status"] == "post_hoc_diagnostic_not_new_experiment"
    assert len(data["records"]) == total == counts["complete_event_text_matches_probe"]
    assert total == counts["no_mutation"] + counts["control_only_excluded_from_fact_projection"]
    assert counts["has_fact"] == counts["has_source_node"] == counts["delivered"] == 0
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "svg.fonttype": "none"})
    fig, ax = plt.subplots(figsize=(9.4, 3.45))
    ax.set(xlim=(0, 10), ylim=(0, 3.8))
    ax.axis("off")

    def box(x, y, w, h, title, body, fill="#f2f5f6"):
        patch = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.03,rounding_size=0.07",
                              linewidth=0.9, edgecolor="#a1b3b8", facecolor=fill)
        ax.add_patch(patch)
        ax.text(x+w/2, y+h*.71, title, ha="center", va="center", weight="bold", color="#173c47", fontsize=10)
        ax.text(x+w/2, y+h*.30, body, ha="center", va="center", fontsize=8.5, color="#344d55")

    def arrow(start, end):
        ax.add_patch(FancyArrowPatch(start, end, arrowstyle="-|>", mutation_scale=11,
                                    color="#71888f", linewidth=1.15))

    box(.1, 1.24, 2.05, 1.18, f"{total:,} statements", "Complete Event payload\nNo observed truncation", "#e5f0f0")
    box(2.85, 2.12, 2.25, 1.10, f"{counts['control_only_excluded_from_fact_projection']:,} controls", "Control-only mutations\nExcluded from Fact projection")
    box(2.85, .43, 2.25, 1.10, f"{counts['no_mutation']:,} other inputs", "No mutation at this\nteaching-control input route")
    box(5.8, 1.24, 1.6, 1.18, "0 target Facts", "No corresponding\nMemoryNode", "#f4ede5")
    box(8.05, 1.24, 1.8, 1.18, f"0 / {total:,}", "Strict source-text\nprobes delivered", "#f4ede5")
    arrow((2.18, 2.04), (2.8, 2.62))
    arrow((2.18, 1.59), (2.8, .97))
    arrow((5.14, 2.62), (5.75, 2.04))
    arrow((5.14, .97), (5.75, 1.59))
    arrow((7.44, 1.83), (8.0, 1.83))
    fig.text(.025, .94, "Why the original raw-statement probe cannot identify the reader effect", fontsize=12, weight="bold")
    fig.text(.025, .87, "Post-hoc routing audit · Computing-education benchmark · Source / 3,200 budget", fontsize=8.5, color="#4f5c63")
    fig.text(.025, .065, "The benchmark uses a teaching-control event for these statements. This does not establish that every product input route loses them.", fontsize=7.5, color="#4f5c63")
    fig.subplots_adjust(left=.02, right=.99, top=.85, bottom=.10)
    args.output.mkdir(parents=True, exist_ok=True)
    for ext in ("svg", "png"):
        fig.savefig(args.output / ("formation-gap."+ext), dpi=220, facecolor="white")
    svg_path = args.output / "formation-gap.svg"
    svg_path.write_text('\n'.join(line.rstrip() for line in svg_path.read_text().splitlines())+'\n')
    plt.close(fig)


if __name__ == "__main__":
    main()
