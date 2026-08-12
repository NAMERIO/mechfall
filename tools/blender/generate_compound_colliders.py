"""Generate a lightweight compound collision scene from a visual Blender/GLB map.

Run inside Blender's Scripting workspace, or from a terminal:

blender --background --python tools/blender/generate_compound_colliders.py -- \
  --input house.glb --output house.colliders.glb --manifest house.colliders.json

The generated GLB contains only collision geometry. The JSON manifest uses
glTF's Y-up coordinate system and records Rapier-ready primitive dimensions,
transforms, and convex-hull points.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Iterable

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector


COLLISION_COLLECTION = "COLLISION_GENERATED"
WORK_COLLECTION = "COLLISION_SOURCE_PARTS"

# Explicit names win over geometric guesses for broad categories. Gameplay
# hollow objects are detected from geometry below instead of a name list.
SKIP_WORDS = (
    "lamp", "lightbulb", "bulb", "handle", "knob", "plate", "cutlery",
    "spoon", "fork", "knife", "trim", "molding", "skirting", "cable",
    "wire", "cord", "curtain", "picture", "painting", "poster", "vase",
    "book", "paper", "bottle", "cup", "glass", "leaf", "leaves", "flower",
    "rug", "carpet", "decal", "switch", "outlet", "vent", "hinge",
    "ammo", "bullet", "shell", "shotgun", "glock", "mp5", "fireaxe",
    "flashlight", "screwdriver", "bolt", "saw_", "medkit", "radio",
    "bottle", "bottel", "canned", "tin_can", "tincan", "soda", "soup",
    "jar", "cigaret", "pencil", "towel", "vinyl", "respirator", "toiletbrush",
    "fryingpan", "supply", "gramophone",
)
BOX_WORDS = (
    "wall", "floor", "ceiling", "roof", "beam", "table", "desk", "counter",
    "cabinet", "cupboard", "island", "shelf", "bookcase", "dresser", "drawer",
    "wardrobe", "couch", "sofa", "bed", "mattress", "tvstand", "tv_stand",
    "bench", "crate", "box", "railing", "fence", "window", "appliance",
    "fridge", "freezer", "oven", "washer", "dryer",
    "locker", "shelving", "workbench", "generator", "pallet",
)
CYLINDER_WORDS = (
    "pillar", "column", "post", "pipe", "barrel", "trunk", "pole", "tank",
)
CONVEX_WORDS = (
    "stair", "stairs", "staircase", "ramp", "chair", "toilet", "sink",
    "bathtub", "tub", "rock", "statue", "vehicle", "car",
)
# These are commonly connected meshes but are not well represented by one
# rectangular block. Check them before BOX_WORDS so their silhouette survives.
DETAILED_CONVEX_WORDS = (
    "sofa", "couch", "chair", "stool", "table", "desk", "toilet", "sink",
    "bathtub", "stair", "ramp", "vehicle", "car_wheel", "box_wood", "crate", "opened",
)
ENTERABLE_MESH_WORDS = (
    "basket", "tire", "wheel", "toilet", "chair", "stool", "table", "desk",
    "sofa", "couch", "locker", "opened", "tool_shelf", "shelving", "bookshelf",
    "bathtub", "tub", "shower", "sink",
)
DOOR_WORDS = ("door", "gate")
ROOM_WORDS = (
    "room", "living", "kitchen", "bedroom", "bathroom", "garage", "hall",
    "foyer", "office", "upstairs", "downstairs", "basement", "attic", "lobby",
)

# Blender is Z-up. glTF/Three.js/Rapier in this project are Y-up.
BLENDER_TO_GLTF = Matrix((
    (1.0, 0.0, 0.0, 0.0),
    (0.0, 0.0, 1.0, 0.0),
    (0.0, -1.0, 0.0, 0.0),
    (0.0, 0.0, 0.0, 1.0),
))

# The player collider is a capsule in-game. These values are intentionally a
# little smaller than the real capsule so the generator only promotes props
# whose cavities are plausibly gameplay space, not every decorative groove.
AUTO_MESH_MIN_SIZE = 0.65
AUTO_MESH_MIN_MID_SIZE = 0.34
AUTO_MESH_SURFACE_RATIO = 1.35
AUTO_MESH_OPEN_EDGE_RATIO = 0.55
AUTO_MESH_OPEN_SURFACE_RATIO = 0.95
AUTO_MESH_MIN_POLYGONS = 48
INCLUDED_DECOR_MAX_BOX_VOLUME = 8.0
INCLUDED_DECOR_MAX_BOX_SIZE = 6.0


def script_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="Optional GLB/GLTF to import into an empty scene.")
    parser.add_argument("--output", type=Path, help="Output collision-only GLB path.")
    parser.add_argument("--manifest", type=Path, help="Output Rapier collision JSON path.")
    parser.add_argument("--save-blend", type=Path, help="Optionally save a .blend containing generated colliders.")
    parser.add_argument("--min-size", type=float, default=0.12, help="Skip objects smaller than this world-space size.")
    parser.add_argument("--min-volume", type=float, default=0.002, help="Skip objects below this world-space volume.")
    parser.add_argument("--max-convex-points", type=int, default=192, help="Maximum support points per convex hull.")
    parser.add_argument("--max-convex-size", type=float, default=12.0,
                        help="Never turn a larger unclassified object into one giant convex hull.")
    parser.add_argument("--cylinder-sides", type=int, default=12, help="Sides used by generated cylinder preview meshes.")
    parser.add_argument("--include-doors", action="store_true", help="Generate colliders for doors/gates. Off keeps passages open.")
    parser.add_argument("--include-all", action="store_true",
                        help="Generate colliders for decorative, tiny, and door objects that are normally skipped.")
    parser.add_argument("--only-source", action="append", default=[],
                        help="Only generate colliders whose source or logical parent name contains this cleaned text.")
    parser.add_argument("--split-loose", action="store_true", help="Split copied meshes into disconnected parts before classifying.")
    parser.add_argument("--no-group-materials", action="store_true",
                        help="Do not merge sibling material meshes under their logical parent object.")
    parser.add_argument("--audit-report", type=Path,
                        help="Audit JSON path. Defaults next to the manifest as *.audit.json.")
    parser.add_argument("--strict-audit", action="store_true",
                        help="Fail if an enterable/hollow object is sealed by a primitive collider.")
    parser.add_argument("--max-mesh-triangles", type=int, default=12000,
                        help="Warn when one detailed static mesh exceeds this triangle count.")
    parser.add_argument("--mesh-dissolve-angle", type=float, default=1.0,
                        help="Merge near-coplanar detailed-mesh faces up to this angle in degrees; 0 disables it.")
    parser.add_argument("--keep-existing", action="store_true", help="Keep an existing COLLISION_GENERATED collection.")
    parser.add_argument("--no-export", action="store_true", help="Only create colliders in the current Blender scene.")
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(argv)


def clean_name(value: str) -> str:
    value = re.sub(r"\.\d{3}$", "", value).strip().lower()
    return re.sub(r"[^a-z0-9]+", "_", value).strip("_") or "object"


def name_matches(name: str, words: Iterable[str]) -> bool:
    tokens = set(name.split("_"))
    for word in words:
        cleaned = clean_name(word)
        if "_" in cleaned:
            if cleaned in name:
                return True
        elif cleaned in tokens:
            return True
    return False


def source_matches_filter(obj: bpy.types.Object, patterns: Iterable[str]) -> bool:
    cleaned_patterns = [clean_name(pattern) for pattern in patterns if clean_name(pattern)]
    if not cleaned_patterns:
        return True
    names = [clean_name(obj.name)]
    if obj.parent:
        names.append(clean_name(obj.parent.name))
    source_name = obj.get("collision_source_name")
    if source_name:
        names.append(clean_name(str(source_name)))
    return any(pattern in name for pattern in cleaned_patterns for name in names)


def remove_collection(name: str) -> None:
    collection = bpy.data.collections.get(name)
    if not collection:
        return

    def remove_branch(branch: bpy.types.Collection) -> None:
        for child in list(branch.children):
            remove_branch(child)
        for obj in list(branch.objects):
            data = obj.data if obj.type == "MESH" else None
            bpy.data.objects.remove(obj, do_unlink=True)
            if data and data.users == 0:
                bpy.data.meshes.remove(data)
        bpy.data.collections.remove(branch)

    remove_branch(collection)


def reset_and_import(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(path)
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.users == 0:
            bpy.data.collections.remove(collection)
    bpy.ops.import_scene.gltf(filepath=str(path.resolve()))


def source_meshes() -> list[bpy.types.Object]:
    result = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or obj.hide_get() or not obj.visible_get():
            continue
        if obj.name.startswith("COL_") or obj.get("is_collision"):
            continue
        result.append(obj)
    return result


def split_loose_copies(sources: Iterable[bpy.types.Object]) -> list[bpy.types.Object]:
    """Split copies, never the visual source objects, into loose mesh islands."""
    remove_collection(WORK_COLLECTION)
    work = bpy.data.collections.new(WORK_COLLECTION)
    bpy.context.scene.collection.children.link(work)
    parts: list[bpy.types.Object] = []
    for source in sources:
        copy = source.copy()
        copy.data = source.data.copy()
        copy.animation_data_clear()
        work.objects.link(copy)
        bpy.ops.object.select_all(action="DESELECT")
        copy.select_set(True)
        bpy.context.view_layer.objects.active = copy
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.separate(type="LOOSE")
        bpy.ops.object.mode_set(mode="OBJECT")
        separated = [obj for obj in bpy.context.selected_objects if obj.type == "MESH"]
        for index, part in enumerate(separated, 1):
            part.name = f"{source.name}__part_{index:04d}"
            part["collision_source_name"] = source.name
        parts.extend(separated)
    return parts


def group_material_sources(sources: Iterable[bpy.types.Object], args: argparse.Namespace) -> list[bpy.types.Object]:
    """Bake sibling material primitives into one temporary logical source.

    glTF commonly imports one Blender mesh per material. Their shared parent is
    the actual bed, cabinet, wall, etc. Treating every material as collision
    creates overlapping blockers and hundreds of useless hulls.
    """
    remove_collection(WORK_COLLECTION)
    work = bpy.data.collections.new(WORK_COLLECTION)
    bpy.context.scene.collection.children.link(work)
    grouped: dict[bpy.types.Object, list[bpy.types.Object]] = {}
    for source in sources:
        logical = source.parent if source.parent else source
        grouped.setdefault(logical, []).append(source)

    depsgraph = bpy.context.evaluated_depsgraph_get()
    proxies: list[bpy.types.Object] = []
    for logical, members in grouped.items():
        frame = logical.matrix_world.copy()
        inverse_frame = frame.inverted_safe()
        logical_name = clean_name(logical.name)
        if name_matches(logical_name, ("wall", "floor", "ceiling", "roof")):
            part_index = 0
            for member in members:
                evaluated = member.evaluated_get(depsgraph)
                evaluated_mesh = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=depsgraph)
                try:
                    to_group = inverse_frame @ member.matrix_world
                    for component_points, component_faces in connected_mesh_components(evaluated_mesh):
                        part_index += 1
                        points = [to_group @ point for point in component_points]
                        proxy = make_source_proxy(
                            work,
                            f"{logical.name}__part_{part_index:04d}",
                            frame,
                            points,
                            component_faces,
                            room_name(member),
                            logical.get("collision_shape"),
                            args.include_all,
                            architecture=True
                        )
                        proxies.append(proxy)
                finally:
                    evaluated.to_mesh_clear()
            continue
        components: list[tuple[list[Vector], list[tuple[int, int, int]]]] = []
        for member in members:
            evaluated = member.evaluated_get(depsgraph)
            evaluated_mesh = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=depsgraph)
            try:
                to_group = inverse_frame @ member.matrix_world
                components.extend(
                    ([to_group @ point for point in points], faces)
                    for points, faces in connected_mesh_components(evaluated_mesh)
                )
            finally:
                evaluated.to_mesh_clear()
        if not components:
            continue
        override = logical.get("collision_shape")
        if override is None:
            override = next((member.get("collision_shape") for member in members
                             if member.get("collision_shape") is not None), None)
        clusters = cluster_touching_components(components)
        for part_index, (points, faces) in enumerate(clusters, 1):
            part_name = logical.name if len(clusters) == 1 else f"{logical.name}__part_{part_index:04d}"
            proxy = make_source_proxy(
                work, part_name, frame, points, faces, room_name(members[0]), override, args.include_all
            )
            proxies.append(proxy)
    return proxies


def make_source_proxy(collection: bpy.types.Collection, name: str, frame: Matrix,
                      points: list[Vector], faces: list[tuple[int, int, int]], room: str,
                      override: object | None, include_all: bool,
                      architecture: bool = False) -> bpy.types.Object:
    metrics = collision_geometry_metrics(name, points, faces, architecture, include_all)
    preserve_faces = bool(metrics.get("collision_auto_mesh")) \
        or name_matches(clean_name(name), ENTERABLE_MESH_WORDS) \
        or str(override).strip().upper() == "MESH"
    mesh = bpy.data.meshes.new(f"COL_SOURCE__{clean_name(name)}")
    mesh.from_pydata(points, [], faces if preserve_faces else [])
    mesh.update()
    proxy = bpy.data.objects.new(name, mesh)
    collection.objects.link(proxy)
    proxy.matrix_world = frame
    proxy["collision_source_name"] = name
    proxy["collision_polygon_count"] = len(faces)
    proxy["collision_room"] = room
    proxy["collision_architecture"] = architecture
    for key, value in metrics.items():
        proxy[key] = value
    if override is not None:
        proxy["collision_shape"] = override
    return proxy


def collision_geometry_metrics(name: str, points: list[Vector], faces: list[tuple[int, int, int]],
                               architecture: bool, include_all: bool) -> dict[str, object]:
    metrics: dict[str, object] = {
        "collision_auto_mesh": False,
        "collision_surface_ratio": 1.0,
        "collision_boundary_edge_ratio": 0.0,
    }
    clean_source = clean_name(name)
    if (
        architecture
        or (name_matches(clean_source, SKIP_WORDS) and not name_matches(clean_source, ENTERABLE_MESH_WORDS))
        or name_matches(clean_source, CYLINDER_WORDS)
    ):
        return metrics
    if len(points) < 4 or len(faces) < AUTO_MESH_MIN_POLYGONS:
        return metrics

    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    dimensions = maximum - minimum
    ordered = sorted(abs(value) for value in dimensions)
    if ordered[2] < AUTO_MESH_MIN_SIZE or ordered[1] < AUTO_MESH_MIN_MID_SIZE:
        return metrics

    boundary_ratio = boundary_edge_ratio(faces)
    metrics["collision_boundary_edge_ratio"] = round(boundary_ratio, 5)

    surface_ratio = source_surface_area(points, faces) / max(bounding_surface_area(dimensions), 1e-7)
    metrics["collision_surface_ratio"] = round(surface_ratio, 5)

    concave_shell = surface_ratio > AUTO_MESH_SURFACE_RATIO
    open_shell = (
        boundary_ratio > AUTO_MESH_OPEN_EDGE_RATIO
        and surface_ratio > AUTO_MESH_OPEN_SURFACE_RATIO
        and len(faces) >= AUTO_MESH_MIN_POLYGONS * 2
    )
    if concave_shell or open_shell:
        metrics["collision_auto_mesh"] = True
    return metrics


def boundary_edge_ratio(faces: list[tuple[int, int, int]]) -> float:
    edge_counts: dict[tuple[int, int], int] = {}
    for face in faces:
        for first, second in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])):
            edge = (first, second) if first < second else (second, first)
            edge_counts[edge] = edge_counts.get(edge, 0) + 1
    if not edge_counts:
        return 0.0
    boundary_edges = sum(1 for count in edge_counts.values() if count == 1)
    return boundary_edges / len(edge_counts)


def source_surface_area(points: list[Vector], faces: list[tuple[int, int, int]]) -> float:
    area = 0.0
    for first, second, third in faces:
        area += ((points[second] - points[first]).cross(points[third] - points[first])).length * 0.5
    return area


def bounding_surface_area(dimensions: Vector) -> float:
    x, y, z = (abs(dimensions.x), abs(dimensions.y), abs(dimensions.z))
    return 2.0 * ((x * y) + (x * z) + (y * z))


def connected_mesh_components(mesh: bpy.types.Mesh) -> list[tuple[list[Vector], list[tuple[int, int, int]]]]:
    """Return face-connected mesh islands without invoking slow Edit Mode separation."""
    vertex_count = len(mesh.vertices)
    parents = list(range(vertex_count))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(first: int, second: int) -> None:
        first_root = find(first)
        second_root = find(second)
        if first_root != second_root:
            parents[second_root] = first_root

    used: set[int] = set()
    for polygon in mesh.polygons:
        indices = list(polygon.vertices)
        if not indices:
            continue
        used.update(indices)
        for index in indices[1:]:
            union(indices[0], index)

    grouped_vertices: dict[int, list[int]] = {}
    for index in used:
        grouped_vertices.setdefault(find(index), []).append(index)
    results = []
    for root, indices in grouped_vertices.items():
        if len(indices) < 4:
            continue
        remap = {old_index: new_index for new_index, old_index in enumerate(indices)}
        faces: list[tuple[int, int, int]] = []
        for polygon in mesh.polygons:
            polygon_indices = list(polygon.vertices)
            if not polygon_indices or find(polygon_indices[0]) != root:
                continue
            first = remap[polygon_indices[0]]
            for corner in range(1, len(polygon_indices) - 1):
                faces.append((first, remap[polygon_indices[corner]], remap[polygon_indices[corner + 1]]))
        results.append(([mesh.vertices[index].co.copy() for index in indices], faces))
    return results


def cluster_touching_components(
    components: list[tuple[list[Vector], list[tuple[int, int, int]]]],
    tolerance: float = 0.025,
) -> list[tuple[list[Vector], list[tuple[int, int, int]]]]:
    """Join only mesh islands whose AABBs touch; never bridge distant pieces.

    Exported meshes often duplicate vertices along material seams, so a single
    table leg or barrel can contain several topologically disconnected faces.
    A small bounds tolerance reunites those faces without merging separate
    furniture, prop copies, or pieces placed across a room.
    """
    if len(components) <= 1:
        return components
    bounds = []
    for points, _ in components:
        minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        bounds.append((minimum, maximum))
    parents = list(range(len(components)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(first: int, second: int) -> None:
        first_root = find(first)
        second_root = find(second)
        if first_root != second_root:
            parents[second_root] = first_root

    for first in range(len(components)):
        first_min, first_max = bounds[first]
        for second in range(first + 1, len(components)):
            second_min, second_max = bounds[second]
            if all(
                first_max[axis] + tolerance >= second_min[axis]
                and second_max[axis] + tolerance >= first_min[axis]
                for axis in range(3)
            ):
                union(first, second)

    clusters: dict[int, tuple[list[Vector], list[tuple[int, int, int]]]] = {}
    for index, (points, faces) in enumerate(components):
        root = find(index)
        cluster_points, cluster_faces = clusters.get(root, ([], []))
        offset = len(cluster_points)
        cluster_points.extend(points)
        cluster_faces.extend(tuple(vertex + offset for vertex in face) for face in faces)
        clusters[root] = (cluster_points, cluster_faces)
    return list(clusters.values())


def evaluated_local_bounds(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    corners = [Vector(corner) for corner in evaluated.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in corners) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in corners) for axis in range(3)))
    return minimum, maximum


def object_frame(obj: bpy.types.Object) -> tuple[Vector, Quaternion, Vector]:
    translation, rotation, scale = obj.matrix_world.decompose()
    return translation, rotation, scale


def room_name(obj: bpy.types.Object) -> str:
    override = obj.get("collision_room")
    if isinstance(override, str) and override.strip():
        return clean_name(override)
    current: bpy.types.Object | None = obj
    while current:
        name = clean_name(current.name)
        if name_matches(name, ROOM_WORDS):
            return name
        current = current.parent
    for collection in obj.users_collection:
        name = clean_name(collection.name)
        if name not in {"collection", "scene_collection"} and not name.startswith("collision_"):
            return name
    return "house"


def classify(obj: bpy.types.Object, dimensions: Vector, args: argparse.Namespace) -> tuple[str, str]:
    override = str(obj.get("collision_shape", "")).strip().upper()
    if override in {"NONE", "BOX", "CYLINDER", "CONVEX", "MESH"}:
        return override, "custom property"
    name = clean_name(str(obj.get("collision_source_name", obj.name)))
    if not args.include_all and name_matches(name, SKIP_WORDS):
        return "NONE", "decorative name"
    if not args.include_all and not args.include_doors and name_matches(name, DOOR_WORDS):
        return "NONE", "open doorway"
    largest = max(dimensions)
    volume = dimensions.x * dimensions.y * dimensions.z
    if obj.get("collision_architecture"):
        ordered = sorted(dimensions)
        if not args.include_all and (largest < 0.5 or ordered[1] < max(args.min_size, 0.18)):
            return "NONE", "architectural fragment too small"
        return "BOX", "architectural surface"
    if not args.include_all and (largest < args.min_size or volume < args.min_volume):
        return "NONE", "too small"
    if args.include_all and name_matches(name, SKIP_WORDS):
        ordered = sorted(dimensions)
        if ordered[0] / max(ordered[2], 1e-9) <= 0.1:
            return "BOX", "included decorative thin shape"
        if ordered[2] / max(ordered[1], 1e-9) >= 2.2 and ordered[0] / max(ordered[1], 1e-9) >= 0.72:
            return "CYLINDER", "included decorative cylinder"
        return "BOX", "included decorative box"
    if name_matches(name, CYLINDER_WORDS):
        return "CYLINDER", "cylinder name"
    if name_matches(name, ENTERABLE_MESH_WORDS):
        return "MESH", "enterable gameplay mesh"
    if bool(obj.get("collision_auto_mesh")):
        ratio = float(obj.get("collision_surface_ratio", 1.0))
        boundary = float(obj.get("collision_boundary_edge_ratio", 0.0))
        return "MESH", f"auto hollow geometry ({ratio:.2f} surface, {boundary:.2f} boundary)"
    if "bookshelf" in name:
        return "BOX", "box name"
    if name_matches(name, DETAILED_CONVEX_WORDS):
        return "CONVEX", "detailed silhouette"
    if name_matches(name, BOX_WORDS):
        return "BOX", "box name"
    if name_matches(name, CONVEX_WORDS):
        return "CONVEX", "irregular name"
    ordered = sorted(dimensions)
    if ordered[0] / max(ordered[2], 1e-9) <= 0.1:
        return "BOX", "thin shape"
    if ordered[2] / max(ordered[1], 1e-9) >= 2.2 and ordered[0] / max(ordered[1], 1e-9) >= 0.72:
        return "CYLINDER", "round elongated shape"
    polygons = int(obj.get("collision_polygon_count", len(obj.data.polygons) if obj.data else 0))
    if polygons <= 24:
        return "BOX", "simple shape"
    if largest > args.max_convex_size:
        if args.include_all:
            return "BOX", "large fallback box"
        return "NONE", "merged structure (use named objects or --split-loose)"
    return "CONVEX", "irregular shape"


def room_collection(root: bpy.types.Collection, name: str) -> bpy.types.Collection:
    existing = bpy.data.collections.get(f"COLLISION_ROOM__{name}")
    if existing:
        return existing
    collection = bpy.data.collections.new(f"COLLISION_ROOM__{name}")
    root.children.link(collection)
    return collection


def mesh_object(name: str, mesh: bpy.types.Mesh, matrix: Matrix, collection: bpy.types.Collection,
                source: bpy.types.Object, shape: str, reason: str) -> bpy.types.Object:
    collider = bpy.data.objects.new(name, mesh)
    collection.objects.link(collider)
    collider.matrix_world = matrix
    collider.display_type = "WIRE"
    collider.show_in_front = True
    collider["is_collision"] = True
    collider["collider_type"] = shape
    collider["collision_source"] = str(source.get("collision_source_name", source.name))
    collider["collision_reason"] = reason
    collider["collision_room"] = room_name(source)
    return collider


def box_mesh(name: str, size: Vector) -> bpy.types.Mesh:
    half = size * 0.5
    vertices = [
        (-half.x, -half.y, -half.z), (half.x, -half.y, -half.z),
        (half.x, half.y, -half.z), (-half.x, half.y, -half.z),
        (-half.x, -half.y, half.z), (half.x, -half.y, half.z),
        (half.x, half.y, half.z), (-half.x, half.y, half.z),
    ]
    faces = [
        (0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1),
        (1, 5, 6, 2), (2, 6, 7, 3), (4, 0, 3, 7),
    ]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    return mesh


def cylinder_mesh(name: str, radius: float, half_height: float, sides: int) -> bpy.types.Mesh:
    sides = max(6, sides)
    vertices = []
    for z in (-half_height, half_height):
        vertices.extend((radius * math.cos(i * math.tau / sides), radius * math.sin(i * math.tau / sides), z)
                        for i in range(sides))
    faces = [tuple(range(sides - 1, -1, -1)), tuple(range(sides, sides * 2))]
    for i in range(sides):
        next_i = (i + 1) % sides
        faces.append((i, next_i, sides + next_i, sides + i))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    return mesh


def convex_hull_mesh(name: str, points: list[Vector], max_points: int) -> bpy.types.Mesh:
    if len(points) < 4:
        raise ValueError("not enough vertices for a convex hull")
    max_points = max(4, int(max_points))
    temporary = bpy.data.meshes.new(f"{name}__input")
    temporary.from_pydata(points, [], [])
    bm = bmesh.new()
    bm.from_mesh(temporary)
    result = bmesh.ops.convex_hull(bm, input=list(bm.verts), use_existing_faces=False)
    unused = list({item for key in ("geom_unused", "geom_interior")
                   for item in result.get(key, []) if isinstance(item, bmesh.types.BMVert)})
    if unused:
        bmesh.ops.delete(bm, geom=unused, context="VERTS")
    hull_points = [vertex.co.copy() for vertex in bm.verts]
    bm.free()
    bpy.data.meshes.remove(temporary)

    if len(hull_points) > max_points:
        hull_points = support_sample(hull_points, max_points)

    temporary = bpy.data.meshes.new(f"{name}__final_input")
    temporary.from_pydata(hull_points, [], [])
    bm = bmesh.new()
    bm.from_mesh(temporary)
    result = bmesh.ops.convex_hull(bm, input=list(bm.verts), use_existing_faces=False)
    unused = list({item for key in ("geom_unused", "geom_interior")
                   for item in result.get(key, []) if isinstance(item, bmesh.types.BMVert)})
    if unused:
        bmesh.ops.delete(bm, geom=unused, context="VERTS")
    bpy.data.meshes.remove(temporary)

    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return mesh


def support_sample(points: list[Vector], limit: int) -> list[Vector]:
    """Approximate a convex hull using evenly distributed support directions."""
    directions = [
        Vector((1, 0, 0)), Vector((-1, 0, 0)), Vector((0, 1, 0)),
        Vector((0, -1, 0)), Vector((0, 0, 1)), Vector((0, 0, -1)),
    ]
    count = max(6, limit)
    golden = math.pi * (3.0 - math.sqrt(5.0))
    for index in range(count):
        y = 1.0 - (index / max(1, count - 1)) * 2.0
        radius = math.sqrt(max(0.0, 1.0 - y * y))
        angle = golden * index
        directions.append(Vector((math.cos(angle) * radius, y, math.sin(angle) * radius)))
    selected: dict[tuple[float, float, float], Vector] = {}
    for direction in directions:
        point = max(points, key=lambda candidate: candidate.dot(direction))
        selected[(point.x, point.y, point.z)] = point
        if len(selected) >= limit:
            break
    return list(selected.values())


def evaluated_scaled_points(obj: bpy.types.Object, scale: Vector) -> list[Vector]:
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=bpy.context.evaluated_depsgraph_get())
    try:
        return [Vector((vertex.co.x * scale.x, vertex.co.y * scale.y, vertex.co.z * scale.z)) for vertex in mesh.vertices]
    finally:
        evaluated.to_mesh_clear()


def detailed_mesh(name: str, obj: bpy.types.Object, scale: Vector,
                  dissolve_angle_degrees: float) -> bpy.types.Mesh:
    """Copy evaluated source triangles while baking object scale into vertices."""
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    source = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=bpy.context.evaluated_depsgraph_get())
    try:
        source.calc_loop_triangles()
        points: list[Vector] = []
        point_lookup: dict[tuple[float, float, float], int] = {}
        remap: list[int] = []
        for vertex in source.vertices:
            point = Vector((vertex.co.x * scale.x, vertex.co.y * scale.y, vertex.co.z * scale.z))
            key = (round(point.x, 6), round(point.y, 6), round(point.z, 6))
            index = point_lookup.get(key)
            if index is None:
                index = len(points)
                point_lookup[key] = index
                points.append(point)
            remap.append(index)
        triangles = []
        for triangle in source.loop_triangles:
            mapped = tuple(remap[index] for index in triangle.vertices)
            if len(set(mapped)) == 3:
                triangles.append(mapped)
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(points, [], triangles)
        mesh.update()
        if dissolve_angle_degrees > 0 and len(mesh.polygons) > 8:
            bm = bmesh.new()
            bm.from_mesh(mesh)
            bmesh.ops.dissolve_limit(
                bm,
                angle_limit=math.radians(dissolve_angle_degrees),
                use_dissolve_boundaries=False,
                verts=list(bm.verts),
                edges=list(bm.edges),
                delimit={"NORMAL"},
            )
            bmesh.ops.triangulate(bm, faces=list(bm.faces))
            bm.to_mesh(mesh)
            bm.free()
            mesh.update()
        return mesh
    finally:
        evaluated.to_mesh_clear()


def base_frame(obj: bpy.types.Object) -> tuple[Vector, Quaternion, Vector, Vector]:
    minimum, maximum = evaluated_local_bounds(obj)
    translation, rotation, scale = object_frame(obj)
    local_center = (minimum + maximum) * 0.5
    center_offset = Vector((local_center.x * scale.x, local_center.y * scale.y, local_center.z * scale.z))
    world_center = translation + rotation @ center_offset
    dimensions = Vector(((maximum.x - minimum.x) * abs(scale.x),
                         (maximum.y - minimum.y) * abs(scale.y),
                         (maximum.z - minimum.z) * abs(scale.z)))
    return world_center, rotation, dimensions, scale


def create_collider(obj: bpy.types.Object, shape: str, reason: str, index: int,
                    root: bpy.types.Collection, args: argparse.Namespace) -> bpy.types.Object:
    center, rotation, dimensions, scale = base_frame(obj)
    if obj.get("collision_architecture"):
        dimensions = Vector(tuple(max(value, args.min_size) for value in dimensions))
    collection = room_collection(root, room_name(obj))
    safe_source = clean_name(str(obj.get("collision_source_name", obj.name)))
    name = f"COL_{shape}__{safe_source}__{index:04d}"

    if shape == "BOX":
        matrix = Matrix.Translation(center) @ rotation.to_matrix().to_4x4()
        collider = mesh_object(name, box_mesh(f"{name}__mesh", dimensions), matrix, collection, obj, shape, reason)
        collider["size"] = list(dimensions)
        return collider

    if shape == "CYLINDER":
        axis = max(range(3), key=lambda component: dimensions[component])
        half_height = dimensions[axis] * 0.5
        radius = sum(dimensions[component] for component in range(3) if component != axis) * 0.25
        axis_rotation = (Matrix.Rotation(math.pi / 2, 4, "Y") if axis == 0
                         else Matrix.Rotation(-math.pi / 2, 4, "X") if axis == 1
                         else Matrix.Identity(4))
        matrix = Matrix.Translation(center) @ rotation.to_matrix().to_4x4() @ axis_rotation
        collider = mesh_object(name, cylinder_mesh(f"{name}__mesh", radius, half_height, args.cylinder_sides),
                               matrix, collection, obj, shape, reason)
        collider["radius"] = radius
        collider["half_height"] = half_height
        return collider

    translation, rotation, _ = obj.matrix_world.decompose()
    if shape == "MESH":
        matrix = Matrix.Translation(translation) @ rotation.to_matrix().to_4x4()
        return mesh_object(
            name,
            detailed_mesh(f"{name}__mesh", obj, scale, args.mesh_dissolve_angle),
            matrix,
            collection,
            obj,
            shape,
            reason,
        )

    points = evaluated_scaled_points(obj, scale)
    matrix = Matrix.Translation(translation) @ rotation.to_matrix().to_4x4()
    collider = mesh_object(name, convex_hull_mesh(f"{name}__mesh", points, args.max_convex_points),
                           matrix, collection, obj, shape, reason)
    collider["point_count"] = len(collider.data.vertices)
    return collider


def gltf_transform(matrix: Matrix) -> tuple[Vector, Quaternion, Vector]:
    converted = BLENDER_TO_GLTF @ matrix @ BLENDER_TO_GLTF.inverted()
    return converted.decompose()


def gltf_point(point: Vector) -> list[float]:
    converted = BLENDER_TO_GLTF @ point.to_4d()
    return [round(converted.x, 6), round(converted.y, 6), round(converted.z, 6)]


def manifest_entry(collider: bpy.types.Object) -> dict[str, object]:
    translation, rotation, scale = gltf_transform(collider.matrix_world)
    entry: dict[str, object] = {
        "id": collider.name,
        "node": collider.name,
        "type": str(collider["collider_type"]).lower(),
        "source": str(collider["collision_source"]),
        "room": str(collider["collision_room"]),
        "translation": [round(value, 6) for value in translation],
        "rotation": [round(rotation.x, 7), round(rotation.y, 7), round(rotation.z, 7), round(rotation.w, 7)],
    }
    shape = collider["collider_type"]
    if shape == "BOX":
        size = Vector(collider["size"])
        entry["halfExtents"] = [round(size.x * 0.5, 6), round(size.z * 0.5, 6), round(size.y * 0.5, 6)]
    elif shape == "CYLINDER":
        entry["radius"] = round(float(collider["radius"]), 6)
        entry["halfHeight"] = round(float(collider["half_height"]), 6)
    elif shape == "MESH":
        collider.data.calc_loop_triangles()
        entry["points"] = [gltf_point(vertex.co) for vertex in collider.data.vertices]
        entry["triangles"] = [list(triangle.vertices) for triangle in collider.data.loop_triangles]
    else:
        entry["points"] = [gltf_point(vertex.co) for vertex in collider.data.vertices]
    if any(abs(value - 1.0) > 1e-5 for value in scale):
        entry["scale"] = [round(value, 6) for value in scale]
    return entry


def source_bounds_center(sources: Iterable[bpy.types.Object]) -> list[float]:
    """Match Three.js Box3.setFromObject before its visual-centering step."""
    points = [
        obj.matrix_world @ Vector(corner)
        for obj in sources
        for corner in obj.bound_box
    ]
    if not points:
        return [0.0, 0.0, 0.0]
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return gltf_point((minimum + maximum) * 0.5)


def source_audit_record(source: bpy.types.Object, shape: str, reason: str,
                        dimensions: Vector, collider: bpy.types.Object | None,
                        args: argparse.Namespace) -> tuple[dict[str, object], list[dict[str, str]]]:
    source_name = str(source.get("collision_source_name", source.name))
    auto_mesh_candidate = bool(source.get("collision_auto_mesh"))
    intentionally_simple = reason in {
        "custom property",
        "decorative name",
        "cylinder name",
        "too small",
        "architectural fragment too small",
    }
    hollow = auto_mesh_candidate and not intentionally_simple and (shape != "NONE" or max(dimensions) >= 0.75)
    record: dict[str, object] = {
        "source": source_name,
        "shape": shape.lower(),
        "reason": reason,
        "dimensions": [round(value, 5) for value in dimensions],
    }
    if auto_mesh_candidate:
        record["autoMeshCandidate"] = True
        record["surfaceRatio"] = float(source.get("collision_surface_ratio", 1.0))
        record["boundaryEdgeRatio"] = float(source.get("collision_boundary_edge_ratio", 0.0))
    warnings: list[dict[str, str]] = []
    if hollow:
        record["expectedHollow"] = True
        if shape in {"BOX", "CYLINDER", "CONVEX"}:
            warnings.append({
                "severity": "error",
                "source": source_name,
                "message": f"hollow gameplay object was sealed by {shape.lower()} collision",
            })
        elif shape == "NONE" and reason not in {"too small", "architectural fragment too small"}:
            warnings.append({
                "severity": "error",
                "source": source_name,
                "message": f"hollow gameplay object has no collision ({reason})",
            })
    if shape == "MESH" and collider is not None:
        collider.data.calc_loop_triangles()
        triangle_count = len(collider.data.loop_triangles)
        record["meshTriangles"] = triangle_count
        if triangle_count > args.max_mesh_triangles:
            warnings.append({
                "severity": "warning",
                "source": source_name,
                "message": (f"detailed collider has {triangle_count} triangles; "
                            f"review against the {args.max_mesh_triangles} triangle budget"),
            })
    if reason.startswith("included decorative") and shape == "BOX":
        volume = dimensions.x * dimensions.y * dimensions.z
        if max(dimensions) > INCLUDED_DECOR_MAX_BOX_SIZE or volume > INCLUDED_DECOR_MAX_BOX_VOLUME:
            warnings.append({
                "severity": "error",
                "source": source_name,
                "message": (
                    "included decorative object generated a broad box collider "
                    f"({[round(value, 3) for value in dimensions]}); split it or use a narrower shape"
                ),
            })
    return record, warnings


def write_audit_report(path: Path, source_count: int, counts: dict[str, int],
                       skipped: dict[str, int], review: list[dict[str, object]],
                       warnings: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "sourceCount": source_count,
        "generatedCount": sum(counts.values()),
        "counts": {key.lower(): value for key, value in counts.items()},
        "skipped": skipped,
        "review": review,
        "warnings": warnings,
        "errors": sum(1 for warning in warnings if warning["severity"] == "error"),
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf8")
    print(f"[compound-collision] Wrote audit report to {path}")


def export_outputs(
    colliders: list[bpy.types.Object],
    args: argparse.Namespace,
    visual_center: list[float],
) -> None:
    source_path = args.input.resolve() if args.input else None
    base = source_path.with_suffix("") if source_path else Path(bpy.data.filepath or "compound_collision").with_suffix("")
    output = (args.output or (base.parent / f"{base.name}.colliders.glb")).resolve()
    manifest = (args.manifest or output.with_suffix(".json")).resolve()
    if source_path and output == source_path:
        raise ValueError("collision output must not overwrite the visual source GLB")
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.object.select_all(action="DESELECT")
    for collider in colliders:
        collider.hide_set(False)
        collider.select_set(True)
    if colliders:
        bpy.context.view_layer.objects.active = colliders[0]
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_extras=True,
        export_yup=True,
    )

    payload = {
        "version": 1,
        "coordinateSystem": "gltf-y-up",
        "source": str(source_path) if source_path else bpy.data.filepath,
        "collisionGlb": output.name,
        "visualCenter": visual_center,
        "colliders": [manifest_entry(collider) for collider in colliders],
    }
    manifest.write_text(json.dumps(payload, indent=2), encoding="utf8")
    print(f"[compound-collision] Exported {len(colliders)} colliders to {output}")
    print(f"[compound-collision] Wrote Rapier manifest to {manifest}")


def main() -> None:
    args = script_arguments()
    if args.input:
        reset_and_import(args.input)
    if not args.keep_existing:
        remove_collection(COLLISION_COLLECTION)
    root = bpy.data.collections.get(COLLISION_COLLECTION)
    if not root:
        root = bpy.data.collections.new(COLLISION_COLLECTION)
        bpy.context.scene.collection.children.link(root)

    original_sources = source_meshes()
    visual_center = source_bounds_center(original_sources)
    filtered_sources = [source for source in original_sources if source_matches_filter(source, args.only_source)]
    if args.only_source:
        print(f"[compound-collision] Source filter kept {len(filtered_sources)}/{len(original_sources)} visual meshes")
    if args.split_loose:
        sources = split_loose_copies(filtered_sources)
        uses_work_sources = True
    elif not args.no_group_materials:
        sources = group_material_sources(filtered_sources, args)
        uses_work_sources = True
    else:
        sources = filtered_sources
        uses_work_sources = False
    colliders: list[bpy.types.Object] = []
    skipped: dict[str, int] = {}
    skipped_examples: dict[str, list[str]] = {}
    counts = {"BOX": 0, "CYLINDER": 0, "CONVEX": 0, "MESH": 0}
    audit_review: list[dict[str, object]] = []
    audit_warnings: list[dict[str, str]] = []

    for index, source in enumerate(sources, 1):
        if index == 1 or index % 500 == 0:
            print(f"[compound-collision] Processing source {index}/{len(sources)}")
        _, _, dimensions, _ = base_frame(source)
        shape, reason = classify(source, dimensions, args)
        if shape == "NONE":
            skipped[reason] = skipped.get(reason, 0) + 1
            examples = skipped_examples.setdefault(reason, [])
            if len(examples) < 8:
                examples.append(str(source.get("collision_source_name", source.name)))
            record, warnings = source_audit_record(source, shape, reason, dimensions, None, args)
            if (record.get("expectedHollow") or warnings
                    or (reason not in {"decorative name", "architectural fragment too small"}
                        and max(dimensions) >= 1.0)):
                audit_review.append(record)
            audit_warnings.extend(warnings)
            continue
        try:
            collider = create_collider(source, shape, reason, index, root, args)
        except (RuntimeError, ValueError) as error:
            failure = f"generation failed: {error}"
            skipped[failure] = skipped.get(failure, 0) + 1
            examples = skipped_examples.setdefault(failure, [])
            if len(examples) < 8:
                examples.append(str(source.get("collision_source_name", source.name)))
            record, warnings = source_audit_record(source, "NONE", failure, dimensions, None, args)
            audit_review.append(record)
            audit_warnings.extend(warnings)
            continue
        colliders.append(collider)
        counts[shape] += 1
        record, warnings = source_audit_record(source, shape, reason, dimensions, collider, args)
        if record.get("expectedHollow") or shape == "MESH" or warnings:
            audit_review.append(record)
        audit_warnings.extend(warnings)

    if uses_work_sources:
        remove_collection(WORK_COLLECTION)
    if not args.no_export:
        export_outputs(colliders, args, visual_center)
    audit_path = args.audit_report
    if audit_path is None and not args.no_export:
        if args.manifest:
            audit_path = args.manifest.with_suffix(".audit.json")
        elif args.output:
            audit_path = args.output.with_suffix(".audit.json")
        elif args.input:
            audit_path = args.input.with_suffix(".colliders.audit.json")
    if audit_path:
        write_audit_report(audit_path.resolve(), len(sources), counts, skipped, audit_review, audit_warnings)
    if args.save_blend:
        args.save_blend.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(args.save_blend.resolve()))

    print(f"[compound-collision] Sources: {len(sources)}")
    print(f"[compound-collision] Boxes: {counts['BOX']}, cylinders: {counts['CYLINDER']}, "
          f"convex: {counts['CONVEX']}, meshes: {counts['MESH']}")
    print(f"[compound-collision] Skipped: {sum(skipped.values())} {skipped}")
    print(f"[compound-collision] Skip examples: {skipped_examples}")
    print(f"[compound-collision] Audit warnings: {len(audit_warnings)}")
    audit_errors = [warning for warning in audit_warnings if warning["severity"] == "error"]
    if args.strict_audit and audit_errors:
        raise RuntimeError(f"collision audit failed with {len(audit_errors)} error(s): {audit_errors[:8]}")


if __name__ == "__main__":
    main()
