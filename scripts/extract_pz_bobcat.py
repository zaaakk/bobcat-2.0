"""Convert the Planet Zoo NABobCat pack (.ms2 + .manis) into a glTF.

We boot a headless bpy 4.4, register cobra-tools as an addon, then call its
import functions for the ms2 (model + skeleton) and each manis (animations).
Final step exports the assembled scene as bobcat_pz.glb.

Usage:
  /tmp/bpyenv44/bin/python scripts/extract_pz_bobcat.py
"""
import os
import sys
import logging
import traceback

ROOT = "/Users/Zak/Documents/bobcat-2.0"
COBRA_DIR = "/tmp/cobra-tools"
EXTRACT_DIR = "/tmp/bobcat_extract"
MS2 = os.path.join(EXTRACT_DIR, "nabobcat_mod_male_.ms2")
MANIS_FILES = [
    # Skip fighting/partials/climb-only sets — we just need walk, run, idle,
    # pounce/jump. The "motion" versions carry root-motion bakes; the runtime
    # overrides root motion via state.position so that's fine.
    "animationmotionextractedlocomotion.manisetbf394642.manis",
    "animationmotionextractedbehaviour.manisete32df926.manis",
    "animationmotionextractedpounce.manisetff40f17f.manis",
    # The notmotion behaviour pack carries the idle / lookaround / breathe /
    # groom variants — the in-place poses Planet Zoo plays when the animal is
    # standing still. This is where we'll find a real bobcat idle clip.
    "animationnotmotionextractedbehaviour.maniset50eb60a8.manis",
]
# Whitelist the action names we actually want (case-insensitive substring
# match). Keeps the GLB tiny and skips the IK bake on dozens of unused anims.
WANTED_ANIMS = (
    "idle", "walk", "run", "jump", "pounce", "lying", "death", "stand",
    "breath", "groom", "lookaround", "lookbehind", "look", "rest", "sit",
)
OUT_GLB = os.path.join(ROOT, "public/assets/bobcat.glb")
OUT_BLEND = os.path.join(ROOT, "bobcat_pz.blend")

logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")

# Make cobra-tools importable as both `cobra_tools` and as `plugin.*` (the
# addon's own internal layout). The addon is at /tmp/cobra-tools/, with the
# Blender plugin code under /tmp/cobra-tools/plugin/. Adding both paths lets
# its `from plugin.modules_import...` and `from generated.formats...` lines
# resolve cleanly without registering as a packaged addon.
if COBRA_DIR not in sys.path:
    sys.path.insert(0, COBRA_DIR)
# /tmp/cobra_tools_pkg is a symlink to /tmp/cobra-tools — needed because
# the cobra-tools __init__.py uses `from .utils.logs import ...` (relative
# import), which only resolves when imported as a package. Python can't
# import a directory whose name has a dash, so we point at the symlink.
if "/tmp" not in sys.path:
    sys.path.insert(0, "/tmp")

import bpy

# The cobra-tools root __init__.py refuses to load below blender 4.4.
# Our bpy is 4.4.0 — should clear the threshold.
print("bpy version:", bpy.app.version)

# Import the formats first (no bpy required for parsing); these are the same
# modules the Blender addon uses.
from generated.formats.ms2 import Ms2File  # noqa: E402

# Reset the scene so we start clean.
bpy.ops.wm.read_factory_settings(use_empty=True)

# Set a headless View3D context so addon ops that need it can run.
for win in bpy.context.window_manager.windows:
    for area in win.screen.areas:
        if area.type != 'VIEW_3D':
            area.type = 'VIEW_3D'
            break
WIN = bpy.context.window_manager.windows[0]
AREA = next(a for a in WIN.screen.areas if a.type == 'VIEW_3D')
REGION = next(r for r in AREA.regions if r.type == 'WINDOW')

def in_v3d():
    return bpy.context.temp_override(
        window=WIN, screen=WIN.screen, area=AREA, region=REGION,
        scene=bpy.context.scene, view_layer=bpy.context.view_layer,
    )

# Register the cobra-tools addon. Its registration adds a `scene.cobra` PG
# that the importers read for game version handling.
import importlib

# The addon's package is the cobra-tools dir itself (it has bl_info in
# __init__.py). Importing as a module then calling register() is what bpy
# would do internally for File > Preferences > Add-ons > Install.
print("registering cobra-tools addon ...")
cobra_addon = importlib.import_module("cobra_tools_pkg")
if hasattr(cobra_addon, "register"):
    cobra_addon.register()
    print("  registered")
else:
    print("  WARNING: no register() — properties may not be set")

# Set the game so importers pick the right format variants.
try:
    bpy.context.scene.cobra.game = "Planet Zoo"
    print("  game = Planet Zoo")
except Exception as e:
    print(f"  could not set scene.cobra.game: {e}")


class StdoutReporter:
    """Stand-in for the addon's reporter — logs warnings/errors to stdout."""
    def show_warning(self, msg): print(f"WARN: {msg}")
    def show_error(self, msg): print(f"ERR: {msg}")
    def show_info(self, msg): print(f"INFO: {msg}")


# ---------- import the model + skeleton ----------
print(f"\nimporting MS2: {MS2}")
from plugin import import_ms2 as ms2_loader  # noqa: E402

# cobra-tools' loader does its own scene/view_layer plumbing — don't wrap in
# temp_override, that would pin a stale scene reference and break create_ob().
ms2_loader.load(
    StdoutReporter(),
    filepath=MS2,
    use_custom_normals=False,
    mirror_mesh=False,
    quadrify=False,
    merge_vertices=True,
    load_libraries=False,
)

# Inspect what we got.
arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
print(f"after MS2 import: {len(arms)} armatures, {len(meshes)} meshes")
if arms:
    arm = arms[0]
    print(f"  armature: {arm.name}  bones={len(arm.data.bones)}")
if meshes:
    by_verts = sorted(meshes, key=lambda m: -len(m.data.vertices))
    for m in by_verts[:8]:
        print(f"  mesh: {m.name}  verts={len(m.data.vertices)}  vgroups={len(m.vertex_groups)}")


# ---------- import each .manis ----------
print("\nimporting animations ...")
from plugin import import_manis as manis_loader  # noqa: E402

for f in MANIS_FILES:
    path = os.path.join(EXTRACT_DIR, f)
    if not os.path.isfile(path):
        print(f"  missing: {path}")
        continue
    print(f"  {f}")
    try:
        # disable_ik=True bypasses the IK constraint setup; without it the
        # glTF exporter has to bake every IK'd animation frame by frame, which
        # turns a 90-second export into a 30-minute one for 200 anims.
        manis_loader.load(StdoutReporter(), files=(), filepath=path,
                          disable_ik=True, set_fps=False)
    except Exception as e:
        print(f"    FAILED: {e}")
        traceback.print_exc()

print(f"actions in scene: {len(bpy.data.actions)}")
for a in list(bpy.data.actions)[:30]:
    fr = a.frame_range
    print(f"  {a.name}  frames=[{fr[0]:.0f}..{fr[1]:.0f}]  fcurves={len(a.fcurves)}")


# ---------- save .blend before export so we can debug if export fails ----------
print(f"\nsaving editable .blend → {OUT_BLEND}")
try:
    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND, check_existing=False, copy=True)
except Exception as e:
    print(f"  blend save failed: {e}")


# ---------- prune to wanted animations ----------
# Cobra-tools dropped >100 actions in the scene (one per imported manis
# entry). Keep only the ones whose names contain a token from WANTED_ANIMS,
# delete the rest. Massively shrinks the GLB.
print(f"\npruning to wanted animations ({WANTED_ANIMS}) ...")
keep, dropped = [], 0
for act in list(bpy.data.actions):
    name_lc = act.name.lower()
    if any(tok in name_lc for tok in WANTED_ANIMS):
        keep.append(act)
    else:
        bpy.data.actions.remove(act)
        dropped += 1
print(f"  kept {len(keep)}, dropped {dropped}")
for a in keep[:40]:
    print(f"    {a.name}")

# ---------- promote actions onto NLA, ready for glTF export ----------
if arms:
    arm = arms[0]
    ad = arm.animation_data_create()
    for tr in list(ad.nla_tracks):
        ad.nla_tracks.remove(tr)
    for action in bpy.data.actions:
        tr = ad.nla_tracks.new()
        tr.name = action.name
        try:
            tr.strips.new(action.name, int(action.frame_range[0]), action)
        except Exception as e:
            print(f"  strip {action.name}: {e}")
    print(f"NLA tracks: {len(ad.nla_tracks)}")


# ---------- export ----------
print(f"\nexporting GLB → {OUT_GLB}")
try:
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format='GLB',
        export_animations=True,
        export_nla_strips=True,
        export_apply=False,
        export_skins=True,
        export_yup=True,
        export_optimize_animation_size=True,
    )
    sz = os.path.getsize(OUT_GLB) / 1024 / 1024
    print(f"wrote {OUT_GLB} ({sz:.2f} MB)")
except Exception as e:
    print(f"GLB export failed: {e}")
    traceback.print_exc()
