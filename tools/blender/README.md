# Automatic compound collision generator

[`generate_compound_colliders.py`](generate_compound_colliders.py) turns a detailed house GLB into a lightweight collision-only GLB and a Rapier-ready JSON manifest.

It generates:

- oriented boxes for floors, walls, ceilings, cabinets, counters, and genuinely rectangular objects;
- cylinders for pillars, columns, pipes, barrels, and other round objects;
- reduced convex hulls for stairs, ramps, chairs, rocks, vehicles, and irregular solid objects;
- static triangle meshes for gameplay-sized props whose geometry looks concave, hollow, or open, so baskets, lockers, shelves, containers, wheels, and similarly shaped assets keep usable openings without being listed by name;
- no collision for tiny decoration such as handles, plates, trim, lamps, cables, books, and bottles;
- no door collision by default, so imported doorways remain passable;
- room collections such as `COLLISION_ROOM__kitchen` when room names exist in the GLB hierarchy.

Material primitives that share one parent are clustered before classification. Touching pieces can share a collider, while disconnected copies and furniture parts stay separate so collision never bridges empty space between them. The temporary grouped sources keep their triangle faces long enough for the classifier to measure surface complexity and open edges, but the final output still uses cheap boxes/cylinders/convex hulls unless the geometry needs a detailed mesh.

The visual model is never edited. Generated objects are placed under `COLLISION_GENERATED` and carry custom properties describing their shape and source.

## Run it in Blender

Open the house in Blender, switch to the **Scripting** workspace, open `generate_compound_colliders.py`, and click **Run Script**. With no command-line arguments it processes the current scene and writes outputs next to the current `.blend` file.

For a direct GLB conversion, close Blender and run:

```powershell
blender --background --python-exit-code 1 --python tools/blender/generate_compound_colliders.py -- `
  --input "C:\maps\house.glb" `
  --output "C:\maps\house.colliders.glb" `
  --manifest "C:\maps\house.colliders.json" `
  --save-blend "C:\maps\house.with-colliders.blend"
```

If the whole house was exported as one merged mesh, add `--split-loose`. The script makes temporary copies, separates disconnected mesh islands, generates colliders, and removes those copies without changing the visual objects:

```powershell
blender --background --python tools/blender/generate_compound_colliders.py -- `
  --input "C:\maps\merged-house.glb" --split-loose
```

Useful options:

| Option | Purpose |
| --- | --- |
| `--min-size 0.12` | Skip objects smaller than this world-space size. |
| `--min-volume 0.002` | Skip objects below this world-space volume. |
| `--max-convex-points 192` | Limit irregular convex collision complexity. |
| `--max-convex-size 12` | Prevent a large unclassified structure becoming one giant convex blocker. |
| `--cylinder-sides 12` | Set cylinder preview detail. |
| `--include-doors` | Add collision to doors and gates. Doors are ignored by default. |
| `--include-all` | Generate collision for decorative, tiny, and door objects that are normally skipped. This is heavier and can make tiny props block the player. |
| `--split-loose` | Process disconnected parts of merged mesh objects separately. |
| `--no-group-materials` | Disable the default merging of sibling material meshes. |
| `--audit-report path.json` | Write a review report for hollow, skipped, and detailed colliders. Defaults beside the manifest. |
| `--strict-audit` | Fail if an automatically detected hollow/concave gameplay object was sealed by a box, cylinder, or convex hull. |
| `--max-mesh-triangles 12000` | Set the per-object detailed-mesh warning budget. |
| `--mesh-dissolve-angle 1` | Merge near-coplanar detailed-mesh triangles while preserving boundaries and openings. |
| `--no-export` | Only generate the collision collection in the open scene. |
| `--keep-existing` | Do not clear a previous generated collection. |

## Override incorrect guesses

Name objects clearly (`Kitchen_Wall`, `LivingRoom_Couch`, `Pillar_04`) for the best automatic result. For exact control, add these Blender custom properties to any source object:

| Property | Values | Effect |
| --- | --- | --- |
| `collision_shape` | `BOX`, `CYLINDER`, `CONVEX`, `MESH`, `NONE` | Overrides automatic classification. Use `MESH` sparingly for static hollow objects. |
| `collision_room` | Any room name | Overrides its generated room group. |

Use `CONVEX` only for genuinely irregular solid objects. A convex hull cannot contain holes or inward corners. `MESH` preserves holes but costs more, so reserve manual `MESH` overrides for static hollow props the automatic geometry pass still misses; an entire house must not be one mesh or convex collider.

The default audit recognizes gameplay-hollow objects from geometry by comparing source surface complexity to its bounds and checking open boundary edges. Run production generation with `--strict-audit` so an import, grouping, or simplification change cannot silently turn one of them into a solid primitive. The audit file also records triangle counts for detailed meshes and larger skipped objects that deserve manual review.

As a safety rule, an unclassified irregular object larger than `--max-convex-size` is skipped and reported instead of being turned into a giant blocker. Rename its components, set per-object overrides, split it into objects in Blender, or use `--split-loose`.

## Patch Runtime JSON Quickly

When only the runtime collision JSON needs a small fix, use [`patch_collider_manifest.py`](patch_collider_manifest.py) instead of a full Blender regeneration:

```powershell
python tools/blender/patch_collider_manifest.py `
  --manifest client/public/models/maps/bunker.compound-colliders.json `
  --remove-broad-decorative-boxes
```

This is meant for fast fixes such as removing bad broad decorative boxes that block empty air. It updates the JSON manifest and audit report, but not the optional collision GLB used for visual inspection.

## Outputs

- `*.colliders.glb` contains only the simplified invisible collision meshes. It can be inspected by importing it into Blender alongside the visual GLB.
- `*.colliders.json` uses glTF Y-up coordinates and includes box half-extents, cylinder sizes, convex points, selected hollow mesh triangles, world translation, and quaternion rotation. Each entry also includes its source object and room.

The collision GLB and manifest are small runtime assets; the original high-detail visual GLB stays unchanged.
