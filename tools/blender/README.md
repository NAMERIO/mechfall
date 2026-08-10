# Automatic compound collision generator

[`generate_compound_colliders.py`](generate_compound_colliders.py) turns a detailed house GLB into a lightweight collision-only GLB and a Rapier-ready JSON manifest.

It generates:

- oriented boxes for floors, walls, ceilings, cabinets, counters, and genuinely rectangular objects;
- cylinders for pillars, columns, pipes, barrels, and other round objects;
- reduced convex hulls for stairs, ramps, chairs, rocks, vehicles, and irregular large objects;
- limited static triangle meshes for hollow tires/wheels and toilets so their openings remain open;
- no collision for tiny decoration such as handles, plates, trim, lamps, cables, books, and bottles;
- no door collision by default, so imported doorways remain passable;
- room collections such as `COLLISION_ROOM__kitchen` when room names exist in the GLB hierarchy.

Material primitives that share one parent are clustered before classification. Touching pieces can share a collider, while disconnected copies and furniture parts stay separate so collision never bridges empty space between them.

The visual model is never edited. Generated objects are placed under `COLLISION_GENERATED` and carry custom properties describing their shape and source.

## Run it in Blender

Open the house in Blender, switch to the **Scripting** workspace, open `generate_compound_colliders.py`, and click **Run Script**. With no command-line arguments it processes the current scene and writes outputs next to the current `.blend` file.

For a direct GLB conversion, close Blender and run:

```powershell
blender --background --python tools/blender/generate_compound_colliders.py -- `
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
| `--split-loose` | Process disconnected parts of merged mesh objects separately. |
| `--no-group-materials` | Disable the default merging of sibling material meshes. |
| `--no-export` | Only generate the collision collection in the open scene. |
| `--keep-existing` | Do not clear a previous generated collection. |

## Override incorrect guesses

Name objects clearly (`Kitchen_Wall`, `LivingRoom_Couch`, `Pillar_04`) for the best automatic result. For exact control, add these Blender custom properties to any source object:

| Property | Values | Effect |
| --- | --- | --- |
| `collision_shape` | `BOX`, `CYLINDER`, `CONVEX`, `MESH`, `NONE` | Overrides automatic classification. Use `MESH` sparingly for static hollow objects. |
| `collision_room` | Any room name | Overrides its generated room group. |

Use `CONVEX` only for genuinely irregular solid objects. A convex hull cannot contain holes or inward corners. `MESH` preserves holes but costs more, so reserve it for a small number of static hollow props; an entire house must not be one mesh or convex collider.

As a safety rule, an unclassified irregular object larger than `--max-convex-size` is skipped and reported instead of being turned into a giant blocker. Rename its components, set per-object overrides, split it into objects in Blender, or use `--split-loose`.

## Outputs

- `*.colliders.glb` contains only the simplified invisible collision meshes. It can be inspected by importing it into Blender alongside the visual GLB.
- `*.colliders.json` uses glTF Y-up coordinates and includes box half-extents, cylinder sizes, convex points, selected hollow mesh triangles, world translation, and quaternion rotation. Each entry also includes its source object and room.

The collision GLB and manifest are small runtime assets; the original high-detail visual GLB stays unchanged.
