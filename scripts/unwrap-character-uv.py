"""Generate a non-overlapping UV atlas while preserving a skinned GLB's attributes.

Setup: ``python -m pip install numpy xatlas``
Usage: ``python scripts/unwrap-character-uv.py input.glb output.glb``
"""

from __future__ import annotations

import argparse
import copy
import json
import struct
from pathlib import Path

import numpy as np
import xatlas


COMPONENT_DTYPES = {
    5120: np.dtype("i1"),
    5121: np.dtype("u1"),
    5122: np.dtype("<i2"),
    5123: np.dtype("<u2"),
    5125: np.dtype("<u4"),
    5126: np.dtype("<f4"),
}
TYPE_WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def node_local_matrix(node: dict) -> np.ndarray:
    if "matrix" in node:
        return np.asarray(node["matrix"], dtype=np.float64).reshape(4, 4).T

    translation = np.asarray(node.get("translation", [0, 0, 0]), dtype=np.float64)
    scale = np.asarray(node.get("scale", [1, 1, 1]), dtype=np.float64)
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    rotation = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=np.float64)
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, :3] = rotation @ np.diag(scale)
    matrix[:3, 3] = translation
    return matrix


def node_world_matrices(document: dict) -> list[np.ndarray]:
    nodes = document["nodes"]
    parents: list[int | None] = [None] * len(nodes)
    for parent, node in enumerate(nodes):
        for child in node.get("children", []):
            parents[child] = parent

    result: list[np.ndarray | None] = [None] * len(nodes)

    def resolve(index: int) -> np.ndarray:
        cached = result[index]
        if cached is not None:
            return cached
        local = node_local_matrix(nodes[index])
        parent = parents[index]
        world = local if parent is None else resolve(parent) @ local
        result[index] = world
        return world

    return [resolve(index) for index in range(len(nodes))]


def skinned_positions(document: dict, binary: bytearray, primitive: dict) -> np.ndarray:
    mesh_nodes = [(index, node) for index, node in enumerate(document["nodes"]) if node.get("mesh") == 0]
    if len(mesh_nodes) != 1 or "skin" not in mesh_nodes[0][1]:
        return read_accessor(document, binary, primitive["attributes"]["POSITION"]).astype(np.float32)

    mesh_node_index, mesh_node = mesh_nodes[0]
    skin = document["skins"][mesh_node["skin"]]
    worlds = node_world_matrices(document)
    bind_matrix = worlds[mesh_node_index]
    inverse_bind = read_accessor(document, binary, skin["inverseBindMatrices"]).astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
    positions = read_accessor(document, binary, primitive["attributes"]["POSITION"]).astype(np.float64)
    joints = read_accessor(document, binary, primitive["attributes"]["JOINTS_0"]).astype(np.int64)
    weights = read_accessor(document, binary, primitive["attributes"]["WEIGHTS_0"]).astype(np.float64)
    base_positions = np.concatenate([positions, np.ones((len(positions), 1))], axis=1) @ bind_matrix.T
    deformed = np.zeros((len(positions), 4), dtype=np.float64)
    for influence in range(4):
        for vertex in range(len(positions)):
            weight = weights[vertex, influence]
            if weight == 0:
                continue
            joint = joints[vertex, influence]
            bone_world = worlds[skin["joints"][joint]]
            deformed[vertex] += weight * (bone_world @ inverse_bind[joint] @ base_positions[vertex])
    mesh_local = deformed @ np.linalg.inv(bind_matrix).T
    return mesh_local[:, :3].astype(np.float32)


def read_glb(path: Path) -> tuple[dict, bytearray]:
    data = path.read_bytes()
    magic, version, _ = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2:
        raise ValueError(f"{path} is not a GLB 2.0 file")

    document = None
    binary = None
    cursor = 12
    while cursor < len(data):
        length, chunk_type = struct.unpack_from("<II", data, cursor)
        cursor += 8
        chunk = data[cursor : cursor + length]
        cursor += length
        if chunk_type == 0x4E4F534A:
            document = json.loads(chunk.rstrip(b" \0"))
        elif chunk_type == 0x004E4942:
            binary = bytearray(chunk)

    if document is None or binary is None:
        raise ValueError("GLB must contain JSON and BIN chunks")
    if len(document.get("buffers", [])) != 1:
        raise ValueError("Only single-buffer GLBs are supported")
    return document, binary[: document["buffers"][0]["byteLength"]]


def read_accessor(document: dict, binary: bytearray, accessor_index: int) -> np.ndarray:
    accessor = document["accessors"][accessor_index]
    if "sparse" in accessor:
        raise ValueError("Sparse accessors are not supported")
    view = document["bufferViews"][accessor["bufferView"]]
    dtype = COMPONENT_DTYPES[accessor["componentType"]]
    width = TYPE_WIDTHS[accessor["type"]]
    packed_size = dtype.itemsize * width
    stride = view.get("byteStride", packed_size)
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    values = np.empty((accessor["count"], width), dtype=dtype)
    for row in range(accessor["count"]):
        values[row] = np.frombuffer(binary, dtype=dtype, count=width, offset=start + row * stride)
    return values


def append_accessor(document: dict, binary: bytearray, values: np.ndarray, template: dict) -> int:
    while len(binary) % 4:
        binary.append(0)
    values = np.ascontiguousarray(values)
    byte_offset = len(binary)
    payload = values.tobytes()
    binary.extend(payload)
    document["bufferViews"].append({"buffer": 0, "byteOffset": byte_offset, "byteLength": len(payload)})

    accessor = copy.deepcopy(template)
    accessor["bufferView"] = len(document["bufferViews"]) - 1
    accessor["byteOffset"] = 0
    accessor["count"] = len(values)
    accessor.pop("sparse", None)
    document["accessors"].append(accessor)
    return len(document["accessors"]) - 1


def unwrap(document: dict, binary: bytearray) -> None:
    if len(document.get("meshes", [])) != 1 or len(document["meshes"][0].get("primitives", [])) != 1:
        raise ValueError("Expected one character mesh with one primitive")
    primitive = document["meshes"][0]["primitives"][0]
    if primitive.get("mode", 4) != 4 or "indices" not in primitive:
        raise ValueError("Expected an indexed triangle primitive")

    # FBX skinning stores many vertices in bone-local clusters. Unwrapping those
    # raw coordinates collapses more than half the UV triangles to zero area.
    # xatlas must see the fully skinned bind shape while the original attributes
    # remain untouched for animation.
    positions = skinned_positions(document, binary, primitive)
    source_indices = read_accessor(document, binary, primitive["indices"]).reshape(-1).astype(np.uint32)
    if len(source_indices) % 3:
        raise ValueError("Triangle index count is not divisible by three")

    # Imported FBX/GLB files commonly duplicate the same physical vertex for
    # normals, material boundaries, or an earlier UV layout. Passing those
    # duplicates directly to xatlas makes it see hundreds of disconnected
    # islands, which turns a round runtime brush into visible shards. Weld only
    # the topology used by xatlas; the original per-corner render attributes are
    # restored below so skin weights and normals are never merged.
    welded_positions: list[np.ndarray] = []
    welded_lookup: dict[tuple[int, int, int], int] = {}
    source_to_welded = np.empty(len(positions), dtype=np.uint32)
    for vertex, position in enumerate(positions):
        key = tuple(np.rint(position * 1_000_000).astype(np.int64).tolist())
        welded = welded_lookup.get(key)
        if welded is None:
            welded = len(welded_positions)
            welded_lookup[key] = welded
            welded_positions.append(position)
        source_to_welded[vertex] = welded
    welded_indices = source_to_welded[source_indices].reshape(-1, 3)

    atlas = xatlas.Atlas()
    atlas.add_mesh(np.asarray(welded_positions, dtype=np.float32), welded_indices)
    pack_options = xatlas.PackOptions()
    pack_options.padding = 8
    pack_options.resolution = 1024
    pack_options.bilinear = True
    atlas.generate(xatlas.ChartOptions(), pack_options)
    vertex_map, atlas_indices, atlas_uvs = atlas[0]
    vertex_map = np.asarray(vertex_map, dtype=np.int64)
    atlas_indices = np.asarray(atlas_indices).reshape(-1, 3)
    atlas_uvs = np.asarray(atlas_uvs, dtype=np.float32)

    # xatlas preserves triangle order. Verify that explicitly, then split its
    # output vertices only where the original render attributes differ.
    if not np.array_equal(vertex_map[atlas_indices], welded_indices):
        raise ValueError("xatlas changed triangle order; cannot safely restore render attributes")
    output_lookup: dict[tuple[int, int], int] = {}
    output_sources: list[int] = []
    output_uvs: list[np.ndarray] = []
    output_indices = np.empty_like(atlas_indices, dtype=np.uint32)
    source_triangles = source_indices.reshape(-1, 3)
    for face in range(len(atlas_indices)):
        for corner in range(3):
            atlas_vertex = int(atlas_indices[face, corner])
            source_vertex = int(source_triangles[face, corner])
            key = (atlas_vertex, source_vertex)
            output_vertex = output_lookup.get(key)
            if output_vertex is None:
                output_vertex = len(output_sources)
                output_lookup[key] = output_vertex
                output_sources.append(source_vertex)
                output_uvs.append(atlas_uvs[atlas_vertex])
            output_indices[face, corner] = output_vertex
    output_sources_array = np.asarray(output_sources, dtype=np.int64)
    atlas_uvs = np.asarray(output_uvs, dtype=np.float32)

    remapped_attributes = {}
    for semantic, accessor_index in primitive["attributes"].items():
        if semantic == "TEXCOORD_0":
            continue
        source = read_accessor(document, binary, accessor_index)
        remapped = source[output_sources_array]
        remapped_attributes[semantic] = append_accessor(
            document, binary, remapped, document["accessors"][accessor_index]
        )

    uv_template = {
        "componentType": 5126,
        "count": len(atlas_uvs),
        "type": "VEC2",
        "min": atlas_uvs.min(axis=0).tolist(),
        "max": atlas_uvs.max(axis=0).tolist(),
    }
    remapped_attributes["TEXCOORD_0"] = append_accessor(document, binary, atlas_uvs, uv_template)

    index_component = 5123 if len(output_sources) <= 65_535 else 5125
    index_dtype = COMPONENT_DTYPES[index_component]
    flat_indices = output_indices.reshape(-1).astype(index_dtype).reshape(-1, 1)
    index_template = {
        "componentType": index_component,
        "count": len(flat_indices),
        "type": "SCALAR",
        "min": [int(flat_indices.min())],
        "max": [int(flat_indices.max())],
    }
    primitive["attributes"] = remapped_attributes
    primitive["indices"] = append_accessor(document, binary, flat_indices, index_template)
    document["buffers"][0]["byteLength"] = len(binary)


def write_glb(path: Path, document: dict, binary: bytearray) -> None:
    json_chunk = bytearray(json.dumps(document, separators=(",", ":")).encode("utf-8"))
    while len(json_chunk) % 4:
        json_chunk.append(0x20)
    while len(binary) % 4:
        binary.append(0)
    total_length = 12 + 8 + len(json_chunk) + 8 + len(binary)
    output = bytearray(struct.pack("<4sII", b"glTF", 2, total_length))
    output.extend(struct.pack("<II", len(json_chunk), 0x4E4F534A))
    output.extend(json_chunk)
    output.extend(struct.pack("<II", len(binary), 0x004E4942))
    output.extend(binary)
    path.write_bytes(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    document, binary = read_glb(args.input)
    unwrap(document, binary)
    write_glb(args.output, document, binary)


if __name__ == "__main__":
    main()
