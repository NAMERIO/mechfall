"""Patch generated collision manifests without a full Blender rebuild.

This is for quick runtime fixes to the Rapier JSON manifest, such as removing
bad broad decorative boxes that block empty air. It does not edit the optional
inspection GLB; run the Blender generator when you need that visual debug asset
to match exactly.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


BROAD_DECORATIVE_WORDS = {
    "wire",
    "wires",
    "vent",
    "vents",
    "skirting",
    "lamp_walls",
    "lamp_ceiling",
    "radio",
}


def clean_name(value: str) -> str:
    value = re.sub(r"\.\d{3}$", "", value).strip().lower()
    return re.sub(r"[^a-z0-9]+", "_", value).strip("_") or "object"


def script_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True, help="Collision manifest JSON to patch.")
    parser.add_argument("--audit-report", type=Path, help="Audit JSON to update beside the manifest.")
    parser.add_argument("--remove-source", action="append", default=[],
                        help="Remove every collider whose source/id contains this cleaned source name.")
    parser.add_argument("--merge-manifest", type=Path,
                        help="Merge colliders from this generated manifest into the target manifest.")
    parser.add_argument("--replace-source", action="append", default=[],
                        help="Before merging, remove existing target colliders matching this source/id pattern.")
    parser.add_argument("--remove-broad-decorative-boxes", action="store_true",
                        help="Remove broad decorative box colliders that likely fill empty air.")
    parser.add_argument("--remove-sealed-enterable", action="store_true",
                        help="Remove primitive/convex colliders from props that need usable holes, seats, or under-space.")
    parser.add_argument("--max-box-size", type=float, default=6.0,
                        help="Largest decorative box axis allowed before removal.")
    parser.add_argument("--max-box-volume", type=float, default=8.0,
                        help="Largest decorative box volume allowed before removal.")
    return parser.parse_args()


ENTERABLE_WORDS = {
    "basket",
    "tire",
    "wheel",
    "toilet",
    "chair",
    "stool",
    "table",
    "desk",
    "sofa",
    "couch",
    "locker",
    "opened",
    "tool_shelf",
    "shelving",
    "bookshelf",
    "bathtub",
    "tub",
    "shower",
    "sink",
}
ENTERABLE_PHRASES = {
    "box_weapon_opened",
    "box_cardboard_medium_opened",
    "box_cardboard_big_opened",
    "cabinet_upper_opened",
}


def broad_decorative_source(source: str) -> bool:
    name = clean_name(source)
    tokens = set(name.split("_"))
    return bool(tokens & BROAD_DECORATIVE_WORDS) or any(word in name for word in ("lamp_walls", "lamp_ceiling"))


def collider_size(collider: dict[str, object]) -> list[float]:
    if collider.get("type") != "box":
        return []
    half_extents = collider.get("halfExtents")
    if not isinstance(half_extents, list) or len(half_extents) != 3:
        return []
    return [float(axis) * 2.0 for axis in half_extents]


def source_matches(collider: dict[str, object], patterns: list[str]) -> bool:
    source = str(collider.get("source", ""))
    identifier = str(collider.get("id", ""))
    cleaned_source = clean_name(source)
    cleaned_id = clean_name(identifier)
    for pattern in patterns:
        cleaned_pattern = clean_name(pattern)
        if cleaned_pattern in cleaned_source or cleaned_pattern in cleaned_id:
            return True
    return False


def remove_reason(collider: dict[str, object], args: argparse.Namespace) -> str | None:
    if source_matches(collider, args.remove_source):
        return "source match"
    if args.merge_manifest and source_matches(collider, args.replace_source):
        return "replaced by merge manifest"

    source = str(collider.get("source", ""))
    if args.remove_broad_decorative_boxes and collider.get("type") == "box" and broad_decorative_source(source):
        size = collider_size(collider)
        if size:
            volume = size[0] * size[1] * size[2]
            if max(size) > args.max_box_size or volume > args.max_box_volume:
                return "broad decorative air box"
    if args.remove_sealed_enterable and collider.get("type") in {"box", "cylinder", "convex"}:
        source_name = clean_name(source)
        tokens = set(source_name.split("_"))
        if tokens & ENTERABLE_WORDS or any(phrase in source_name for phrase in ENTERABLE_PHRASES):
            return "sealed enterable primitive"
    return None


def update_audit(path: Path, kept: list[dict[str, object]], removed: list[dict[str, object]]) -> None:
    if not path.exists():
        return
    audit = json.loads(path.read_text(encoding="utf8"))
    counts = {"box": 0, "cylinder": 0, "convex": 0, "mesh": 0}
    for collider in kept:
        collider_type = str(collider.get("type", ""))
        counts[collider_type] = counts.get(collider_type, 0) + 1
    audit["generatedCount"] = len(kept)
    audit["counts"] = counts
    skipped = audit.setdefault("skipped", {})
    for item in removed:
        reason = str(item["reason"])
        skipped[reason] = skipped.get(reason, 0) + 1
    audit["postProcessRemovedColliders"] = audit.get("postProcessRemovedColliders", []) + removed
    path.write_text(json.dumps(audit, indent=2), encoding="utf8")


def main() -> None:
    args = script_arguments()
    manifest = json.loads(args.manifest.read_text(encoding="utf8"))
    incoming: list[dict[str, object]] = []
    if args.merge_manifest:
        merge_manifest = json.loads(args.merge_manifest.read_text(encoding="utf8"))
        incoming = list(merge_manifest.get("colliders", []))
    kept: list[dict[str, object]] = []
    removed: list[dict[str, object]] = []

    for collider in manifest.get("colliders", []):
        reason = remove_reason(collider, args)
        if reason:
            size = collider_size(collider)
            removed.append({
                "id": collider.get("id"),
                "source": collider.get("source"),
                "type": collider.get("type"),
                "reason": reason,
                "size": [round(value, 6) for value in size],
            })
        else:
            kept.append(collider)

    if incoming:
        kept.extend(incoming)
    manifest["colliders"] = kept
    args.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf8")

    audit_path = args.audit_report
    if audit_path is None:
        audit_path = args.manifest.with_suffix(".audit.json")
    update_audit(audit_path, kept, removed)

    print(f"[patch-collision] Removed {len(removed)} collider(s)")
    for item in removed:
        print(f"[patch-collision] Removed {item['source']} ({item['id']}): {item['reason']}")
    print(f"[patch-collision] Remaining colliders: {len(kept)}")


if __name__ == "__main__":
    main()
