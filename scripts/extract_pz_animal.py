"""Convert an extracted Planet Zoo animal (.ms2 + .manis) into a runtime GLB.

Generalized from extract_pz_bobcat.py — same headless-bpy + cobra-tools
pipeline, parameterized so any extracted animal can be converted:

  /tmp/bpyenv44/bin/python scripts/extract_pz_animal.py \
      --ms2 /tmp/mob_extract/deer_male/deer_white_tailed_male_.ms2 \
      --manis-dir /tmp/mob_extract/deer_male \
      --out public/assets/mobs/deer.glb

  # goat juvenile carries no animations (the mod references base-game manis
  # we don't have) — its skeleton shares 108/118 bone names with the deer,
  # so we borrow the deer's clips:
  /tmp/bpyenv44/bin/python scripts/extract_pz_animal.py \
      --ms2 /tmp/mob_extract/goat_juvenile/american_pygmy_goat_juvenile_.ms2 \
      --manis-dir /tmp/mob_extract/deer_male \
      --out public/assets/mobs/goat.glb

Prereqs: /tmp/cobra-tools clone + /tmp/cobra_tools_pkg symlink + bpy 4.4 venv
(see extract_pz_bobcat.py header), and the extracted folders from
scripts/extract_pz_ovl.py.
"""
import argparse
import glob
import os
import sys
import traceback

COBRA_DIR = "/tmp/cobra-tools"

# Prey animation whitelist (case-insensitive substring match on action names).
# Smaller than the bobcat's: prey needs locomotion, idles to graze/stand
# around with, and a death for the hunt's kill moment.
WANTED_ANIMS = (
    "idle", "walk", "run", "trot", "canter", "gallop",
    "death", "die", "graze", "eat", "stand", "breath", "look",
)

# Only these manis sets are worth importing — fighting/partials are dozens of
# clips we'd just prune again (importing is the slow step, ~seconds per clip).
MANIS_PATTERNS = (
    "animationmotionextractedlocomotion*.manis",
    "animationmotionextractedbehaviour*.manis",
    "animationnotmotionextractedbehaviour*.manis",
    "animationnotmotionextractedlocomotion*.manis",
)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--ms2", required=True, help="extracted .ms2 (model + skeleton)")
    p.add_argument("--manis-dir", required=True, help="folder with .manis files to import")
    p.add_argument("--out", required=True, help="output .glb path")
    p.add_argument("--blend", help="optional debug .blend save path")
    return p.parse_args()


def main():
    args = parse_args()
    ms2_path = os.path.abspath(args.ms2)
    out_glb = os.path.abspath(args.out)

    if COBRA_DIR not in sys.path:
        sys.path.insert(0, COBRA_DIR)
    # /tmp/cobra_tools_pkg symlink — see extract_pz_bobcat.py for why.
    if "/tmp" not in sys.path:
        sys.path.insert(0, "/tmp")

    import bpy
    print("bpy version:", bpy.app.version)

    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Headless V3D context for addon ops that need one.
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type != 'VIEW_3D':
                area.type = 'VIEW_3D'
                break

    import importlib
    print("registering cobra-tools addon ...")
    cobra_addon = importlib.import_module("cobra_tools_pkg")
    cobra_addon.register()
    bpy.context.scene.cobra.game = "Planet Zoo"

    class StdoutReporter:
        def show_warning(self, msg): print(f"WARN: {msg}")
        def show_error(self, msg): print(f"ERR: {msg}")
        def show_info(self, msg): print(f"INFO: {msg}")

    # ---------- model + skeleton ----------
    print(f"\nimporting MS2: {ms2_path}")
    from plugin import import_ms2 as ms2_loader
    ms2_loader.load(
        StdoutReporter(),
        filepath=ms2_path,
        use_custom_normals=False,
        mirror_mesh=False,
        quadrify=False,
        merge_vertices=True,
        load_libraries=False,
    )

    arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    print(f"after MS2 import: {len(arms)} armatures, {len(meshes)} meshes")
    assert arms, "no armature imported"

    # ---------- animations ----------
    from plugin import import_manis as manis_loader
    manis_files = []
    for pat in MANIS_PATTERNS:
        manis_files.extend(sorted(glob.glob(os.path.join(args.manis_dir, pat))))
    print(f"\nimporting {len(manis_files)} manis sets ...")
    for path in manis_files:
        print(f"  {os.path.basename(path)}")
        try:
            manis_loader.load(StdoutReporter(), files=(), filepath=path,
                              disable_ik=True, set_fps=False)
        except Exception as e:
            print(f"    FAILED: {e}")
            traceback.print_exc()

    print(f"actions in scene: {len(bpy.data.actions)}")

    # ---------- prune ----------
    keep, dropped = [], 0
    for act in list(bpy.data.actions):
        if any(tok in act.name.lower() for tok in WANTED_ANIMS):
            keep.append(act)
        else:
            bpy.data.actions.remove(act)
            dropped += 1
    print(f"kept {len(keep)}, dropped {dropped}")
    for a in keep:
        print(f"    {a.name}")

    if args.blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.blend),
                                    check_existing=False, copy=True)

    # ---------- promote to NLA for glTF export ----------
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
    os.makedirs(os.path.dirname(out_glb), exist_ok=True)
    print(f"\nexporting GLB → {out_glb}")
    bpy.ops.export_scene.gltf(
        filepath=out_glb,
        export_format='GLB',
        export_animations=True,
        export_nla_strips=True,
        export_apply=False,
        export_skins=True,
        export_yup=True,
        export_optimize_animation_size=True,
    )
    print(f"wrote {out_glb} ({os.path.getsize(out_glb) / 1024 / 1024:.2f} MB)")


if __name__ == "__main__":
    main()
