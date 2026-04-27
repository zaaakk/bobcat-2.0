"""Retarget pipeline: bobcat mesh → Quaternius Pug skeleton + animations.

Approach: keep the Pug mesh in the scene and use a Data Transfer modifier to
copy its (already-correct) skin weights onto our bobcat mesh by proximity.
Bone Heat fails silently on the bobcat (the mesh has internal teeth/eyeballs);
proximity transfer is robust for that case.

Output: public/assets/bobcat.glb with armature + Idle / Walk / WalkSlow / Run /
Jump / Death animations.

Run:
  /tmp/bpyenv/bin/python scripts/retarget_bobcat.py
"""
import bpy, os, math
from mathutils import Vector

ROOT = "/Users/Zak/Documents/bobcat-2.0"
PUG_BLEND = os.path.join(ROOT, "Farm Animals Animated  by Quaternius/Blends/Pug.blend")
BOBCAT_GLB = os.path.join(ROOT, "public/assets/bobcat.glb")
OUT_GLB = os.path.join(ROOT, "public/assets/bobcat.glb")
# Save the bound, weighted, animated scene as a .blend too, so the artist
# (you) can open it in Blender, tweak weights / refine bones, then re-export
# without re-running this script. The script over-writes it each run, so any
# manual edits should be saved under a different filename.
OUT_BLEND = os.path.join(ROOT, "bobcat_rigged.blend")

# ---------- context (headless View3D override) ----------
bpy.ops.wm.open_mainfile(filepath=PUG_BLEND)
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
with in_v3d():
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')


def world_bbox(obj):
    mn = Vector(( math.inf,)*3); mx = Vector((-math.inf,)*3)
    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        for i in range(3):
            mn[i] = min(mn[i], p[i]); mx[i] = max(mx[i], p[i])
    return mn, mx


def apply_xforms(obj, location=True, rotation=True, scale=True):
    with in_v3d():
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.transform_apply(location=location, rotation=rotation, scale=scale)


# ---------- start ----------
arm = bpy.data.objects['Armature']
pug = bpy.data.objects['Pug']

# Snapshot the Pug's actions before we import anything so we can cull stray
# actions later. (Re-running this script reads its own previous output as the
# bobcat GLB, which carries an armature + 6 actions of its own — those would
# get appended to the NLA list as 'Idle_Armature.001' etc. and bloat the GLB.)
pug_action_names = {a.name for a in bpy.data.actions}

# Apply armature scale so bones are at world units.
apply_xforms(arm)
apply_xforms(pug)

pug_min, pug_max = world_bbox(pug)
pug_size = pug_max - pug_min
pug_centre = (pug_min + pug_max) * 0.5
print(f"pug bbox:    min={tuple(round(v,3) for v in pug_min)}  max={tuple(round(v,3) for v in pug_max)}  size={tuple(round(v,3) for v in pug_size)}")

# ---------- import bobcat mesh ----------
before = set(bpy.data.objects.keys())
bpy.ops.import_scene.gltf(filepath=BOBCAT_GLB)
imported = [bpy.data.objects[n] for n in bpy.data.objects.keys() if n not in before]
meshes = [o for o in imported if o.type == 'MESH']
arms_imp = [o for o in imported if o.type == 'ARMATURE']
body = max(meshes, key=lambda o: len(o.data.vertices))
print(f"imported body: {body.name}  verts={len(body.data.vertices)}")

# Drop everything else from the import.
junk = [o for o in imported if o is not body]
if junk:
    with in_v3d():
        bpy.ops.object.select_all(action='DESELECT')
        for o in junk:
            o.select_set(True)
        bpy.context.view_layer.objects.active = junk[0]
        bpy.ops.object.delete()
body.parent = None
apply_xforms(body)

# ---------- align bobcat to Pug ----------
# 1. Identify each model's "long" (head-to-tail) axis as the axis of greatest
#    extent. Pug skeleton clearly extends along Y (head/tail along Y in
#    Quaternius FBX). The bobcat's longest axis is whichever of X/Y/Z is the
#    biggest in its bbox.
mn, mx = world_bbox(body)
size = mx - mn
def axis_order_by_size(s):
    return sorted(range(3), key=lambda i: -s[i])
mesh_long_axis = axis_order_by_size(size)[0]
arm_long_axis  = axis_order_by_size(pug_size)[0]
print(f"bobcat long axis: {'XYZ'[mesh_long_axis]}  (size={size[mesh_long_axis]:.3f})")
print(f"pug    long axis: {'XYZ'[arm_long_axis]}  (size={pug_size[arm_long_axis]:.3f})")

# 2. Rotate the bobcat so its long axis lines up with the Pug's. We map mesh
#    long → pug long, and the next-largest axis (the height) accordingly.
import math as m
target = ['XYZ'[arm_long_axis]]
need_rot = mesh_long_axis != arm_long_axis
if need_rot:
    if (mesh_long_axis, arm_long_axis) in {(2, 1), (1, 2)}:
        body.rotation_euler = (math.radians(90), 0, 0)   # swap Y↔Z
    elif (mesh_long_axis, arm_long_axis) in {(0, 1), (1, 0)}:
        body.rotation_euler = (0, 0, math.radians(90))   # swap X↔Y
    elif (mesh_long_axis, arm_long_axis) in {(0, 2), (2, 0)}:
        body.rotation_euler = (0, math.radians(90), 0)   # swap X↔Z
    apply_xforms(body, location=False, rotation=True, scale=False)
    mn, mx = world_bbox(body)
    size = mx - mn
    print(f"after rotation: size={tuple(round(v,3) for v in size)}")

# 3. Per-axis scale to match the Pug's bbox.
sx = pug_size[0] / size[0]
sy = pug_size[1] / size[1]
sz = pug_size[2] / size[2]
# Bias slightly toward uniform — pure non-uniform scale distorts the head/legs
# unrecognisably. Take the geometric mean of the three.
uniform = (sx * sy * sz) ** (1/3)
# But we also want to keep the *long* axis really matched (the head-to-tail
# length is what readers compare), so blend 65% non-uniform + 35% uniform per
# axis.
sx = 0.65 * sx + 0.35 * uniform
sy = 0.65 * sy + 0.35 * uniform
sz = 0.65 * sz + 0.35 * uniform
body.scale = (sx, sy, sz)
apply_xforms(body, location=False, rotation=False, scale=True)

# 4. Translate so its bbox centre matches the Pug's.
mn, mx = world_bbox(body)
centre = (mn + mx) * 0.5
body.location = pug_centre - centre
apply_xforms(body, location=True, rotation=False, scale=False)

mn, mx = world_bbox(body)
print(f"bobcat bbox: min={tuple(round(v,3) for v in mn)}  max={tuple(round(v,3) for v in mx)}  size={tuple(round(v,3) for v in (mx-mn))}")

# ---------- transfer skin weights from Pug mesh ----------
# The Pug mesh already has correct vertex groups + weights for the armature.
# Add a Data Transfer modifier on the bobcat to copy "Vertex Group Data" by
# nearest-face proximity, then bake it.
print("transferring skin weights from Pug mesh by proximity ...")
with in_v3d():
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    bpy.context.view_layer.objects.active = body

    # First make sure body has the matching vertex group names (Data Transfer
    # creates them but Blender wants pre-existing groups for a clean baking).
    for vg in pug.vertex_groups:
        if vg.name not in body.vertex_groups:
            body.vertex_groups.new(name=vg.name)

    dt = body.modifiers.new("WeightTransfer", 'DATA_TRANSFER')
    dt.object = pug
    dt.use_vert_data = True
    dt.data_types_verts = {'VGROUP_WEIGHTS'}
    dt.vert_mapping = 'POLYINTERP_NEAREST'
    dt.layers_vgroup_select_src = 'ALL'
    dt.layers_vgroup_select_dst = 'NAME'
    dt.mix_mode = 'REPLACE'

    # Run the "Generate Data Layers" then bake the modifier.
    try:
        bpy.ops.object.datalayout_transfer(modifier=dt.name)
    except Exception as e:
        print(f"  datalayout_transfer skipped: {e}")
    bpy.ops.object.modifier_apply(modifier=dt.name)

# Sanity: how many vertices got weights?
weighted = sum(1 for v in body.data.vertices if any(g.weight > 0 for g in v.groups))
print(f"weighted_verts after transfer: {weighted} / {len(body.data.vertices)}")

# ---------- weight cleanup ----------
# Pure proximity transfer leaves verts with up to N influences and noisy edges
# along bone-region boundaries — that's what makes the limbs go "spaghetti"
# during a walk cycle: a single belly vert ends up tugged by both a hip bone
# AND a torso bone with comparable weights, so as the hip rotates it shears
# the belly geometry. Three passes here:
#   1. Limit each vert to its top 4 bone influences (glTF caps at 4 anyway, so
#      anything beyond is dropped at export — better to control which 4 stay).
#   2. Smooth weights along the surface so neighbouring verts don't have
#      wildly different blends; this is what kills the visible shearing.
#   3. Normalize so weights sum to 1 per vert (Blender doesn't enforce this
#      after limit/smooth).
print("cleaning up transferred weights ...")
with in_v3d():
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    bpy.context.view_layer.objects.active = body

    # Need to be in WEIGHT_PAINT mode for vertex_group_smooth to behave
    # consistently on the deform groups; vertex_group_limit_total works in
    # OBJECT mode.
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)

    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    # Two moderate passes — one strong pass tends to bleed weights too far,
    # while two of factor=0.5 smooth out the per-face transfer banding while
    # preserving the limb regions. expand=0 keeps the smoothed area from
    # growing into untouched verts.
    bpy.ops.object.vertex_group_smooth(group_select_mode='ALL', factor=0.5, repeat=2, expand=0.0)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    bpy.ops.object.mode_set(mode='OBJECT')

weighted = sum(1 for v in body.data.vertices if any(g.weight > 0 for g in v.groups))
print(f"weighted_verts after cleanup: {weighted} / {len(body.data.vertices)}")

# ---------- bind to armature ----------
# Add an Armature modifier (don't use parent_set — it'd run auto-weights again
# and we already have transferred weights).
arm_mod = body.modifiers.new("Armature", 'ARMATURE')
arm_mod.object = arm
arm_mod.use_vertex_groups = True
arm_mod.use_bone_envelopes = False
body.parent = arm

# Now we can drop the Pug mesh — the bobcat carries its own copy of the weights.
with in_v3d():
    bpy.ops.object.select_all(action='DESELECT')
    pug.select_set(True)
    bpy.context.view_layer.objects.active = pug
    bpy.ops.object.delete()

# ---------- prune stray actions ----------
# Drop anything that wasn't in the original Pug blend (i.e. came along with
# the previously-rigged bobcat GLB). Their fcurves point at the just-deleted
# imported armature anyway and they'd just bloat the export.
for act in list(bpy.data.actions):
    if act.name not in pug_action_names:
        print(f"  pruning stray action: {act.name}")
        bpy.data.actions.remove(act)

# ---------- one NLA track per action ----------
ad = arm.animation_data_create()
ad.action = None
for tr in list(ad.nla_tracks):
    ad.nla_tracks.remove(tr)
for action in bpy.data.actions:
    tr = ad.nla_tracks.new()
    tr.name = action.name
    tr.strips.new(action.name, int(action.frame_range[0]), action)
print(f"NLA tracks: {[t.name for t in ad.nla_tracks]}")

# ---------- save .blend for manual weight tweaking ----------
# Save *before* export so the saved scene mirrors what gets exported. If the
# artist later edits weights and re-exports, they'll get the same NLA layout.
print(f"saving editable scene → {OUT_BLEND}")
bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND, check_existing=False, copy=True)

# ---------- export ----------
print(f"exporting → {OUT_GLB}")
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
sz = os.path.getsize(OUT_GLB)
print(f"wrote {OUT_GLB} ({sz/1024/1024:.2f} MB)")
