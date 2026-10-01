import bpy, sys, os
out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 64; sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 960, 540
bpy.ops.mesh.primitive_plane_add(size=20)
bpy.ops.mesh.primitive_monkey_add(location=(0, 0, 1)); bpy.ops.object.shade_smooth()
m = bpy.data.materials.new('m'); m.use_nodes = True
m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.8, 0.5, 0.3, 1)
bpy.context.object.data.materials.append(m)
bpy.ops.object.light_add(type='SUN', rotation=(0.8, 0.2, 0.6)); bpy.context.object.data.energy = 4
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.6, 0.75, 1, 1)
bpy.ops.object.camera_add(location=(4, -5, 3), rotation=(1.1, 0, 0.67)); sc.camera = bpy.context.object
sc.render.image_settings.file_format = 'JPEG'; sc.render.filepath = os.path.abspath(out)
bpy.ops.render.render(write_still=True)
print('RENDERED', out)
