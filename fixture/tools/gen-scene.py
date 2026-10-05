"""Generate assets/scenes/InspectorTest.scene from real Cocos 3.8.8 serialization samples.

Run from the project root: python3 tools/gen-scene.py <samples.json>
The samples file maps cc.* type names to one serialized object each (see README).
"""
import copy
import json
import sys

SCENE_UUID = '64fcba57-76ff-4d9a-af4d-3e9dcc172197'
# Compressed uuid of assets/scripts/InspectorFixture.ts (9d1b9b75-c345-4454-84f3-6448978597c3).
FIXTURE_TYPE = '9d1b9t1w0VEVITzZEiXhZfD'
# Built-in default_ui/default_sprite_splash.png sprite frame shipped with Creator 3.8.8.
SPLASH_FRAME = '7d8f9b89-4fd1-4c9f-a3ab-38ec7cded7ca@f9941'
UI_LAYER = 33554432

samples = json.load(open(sys.argv[1]))
objects = []


def add(obj):
    objects.append(obj)
    return len(objects) - 1


def ref(index):
    return {'__id__': index}


def sample(type_name, **overrides):
    obj = copy.deepcopy(samples[type_name])
    obj.update(overrides)
    return obj


def vec3(x=0, y=0, z=0):
    return {'__type__': 'cc.Vec3', 'x': x, 'y': y, 'z': z}


def node(name, parent, x=0, y=0, layer=UI_LAYER):
    return add({
        '__type__': 'cc.Node', '_name': name, '_objFlags': 0, '__editorExtras__': {},
        '_parent': ref(parent) if parent is not None else None, '_children': [], '_active': True,
        '_components': [], '_prefab': None, '_lpos': vec3(x, y), '_lrot': {'__type__': 'cc.Quat', 'x': 0, 'y': 0, 'z': 0, 'w': 1},
        '_lscale': vec3(1, 1, 1), '_mobility': 0, '_layer': layer, '_euler': vec3(), '_id': '',
    })


def attach(node_index, component):
    component['node'] = ref(node_index)
    component['__prefab'] = None
    component['_id'] = ''
    index = add(component)
    objects[node_index]['_components'].append(ref(index))
    return index


def child(parent, name, x=0, y=0, width=200, height=40):
    index = node(name, parent, x, y)
    objects[parent]['_children'].append(ref(index))
    attach(index, sample('cc.UITransform', _contentSize={'__type__': 'cc.Size', 'width': width, 'height': height}))
    return index


add(sample('cc.SceneAsset', _name='InspectorTest'))
scene = node('InspectorTest', None, layer=1073741824)
objects[0]['scene'] = ref(scene)
scene_obj = objects[scene]
scene_obj.update({'__type__': 'cc.Scene', 'autoReleaseAssets': False, '_id': SCENE_UUID})
del scene_obj['_lpos'], scene_obj['_lrot'], scene_obj['_lscale'], scene_obj['_euler']
scene_obj.update({k: samples['cc.Scene'][k] for k in ('_lpos', '_lrot', '_lscale', '_euler')})

canvas = child(scene, 'Canvas', 640, 360, 1280, 720)
camera_node = child(canvas, 'UICamera', 0, 0, 0, 0)
objects[camera_node]['_lpos'] = vec3(0, 0, 1000)
objects[canvas]['_children'] = []  # Panel must come before UICamera in hierarchy order.
camera = attach(camera_node, sample('cc.Camera', _orthoHeight=360))
attach(canvas, sample('cc.Canvas', _cameraComponent=ref(camera)))

panel = child(canvas, 'Panel', 0, 0, 800, 500)
objects[canvas]['_children'].append(ref(camera_node))
attach(panel, {'__type__': FIXTURE_TYPE, '_name': '', '_objFlags': 0, '__editorExtras__': {}, '_enabled': True,
               'title': 'Inspector fixture', 'count': 42, 'featureEnabled': True})

title = child(panel, 'TitleLabel', 0, 180, 400, 50)
attach(title, sample('cc.Label', _string='Inspector title'))

button = child(panel, 'TestButton', -200, 60, 160, 60)
attach(button, sample('cc.Sprite', _spriteFrame={'__uuid__': SPLASH_FRAME, '__expectedType__': 'cc.SpriteFrame'}, _sizeMode=0))
attach(button, sample('cc.Button', _interactable=True, _target=ref(button)))

icon = child(panel, 'IconSprite', 200, 60, 80, 80)
attach(icon, sample('cc.Sprite', _spriteFrame={'__uuid__': SPLASH_FRAME, '__expectedType__': 'cc.SpriteFrame'}, _sizeMode=0))

toggle = child(panel, 'TestToggle', -200, -80, 60, 60)
toggle_bg = attach(toggle, sample('cc.Sprite', _spriteFrame={'__uuid__': SPLASH_FRAME, '__expectedType__': 'cc.SpriteFrame'}, _sizeMode=0))
checkmark_node = child(toggle, 'Checkmark', 0, 0, 40, 40)
checkmark = attach(checkmark_node, sample('cc.Sprite', _spriteFrame={'__uuid__': SPLASH_FRAME, '__expectedType__': 'cc.SpriteFrame'}, _sizeMode=0))
attach(toggle, sample('cc.Toggle', _isChecked=True, _checkMark=ref(checkmark), _target=ref(toggle), _normalSprite=None))

rich = child(panel, 'TestRichText', 120, -80, 300, 50)
attach(rich, sample('cc.RichText', _string='<b>Rich</b> fixture'))

# Scene globals, copied verbatim from a working 3.8.8 scene.
globals_types = ['cc.AmbientInfo', 'cc.ShadowsInfo', 'cc.SkyboxInfo', 'cc.FogInfo', 'cc.OctreeInfo', 'cc.SkinInfo', 'cc.LightProbeInfo', 'cc.PostSettingsInfo']
globals_obj = sample('cc.SceneGlobals')
globals_index = add(globals_obj)
for key, type_name in zip(['ambient', 'shadows', '_skybox', 'fog', 'octree', 'skin', 'lightProbeInfo', 'postSettings'], globals_types):
    globals_obj[key] = ref(add(sample(type_name)))
scene_obj['_globals'] = ref(globals_index)
scene_obj['_prefab'] = None

json.dump(objects, open('assets/scenes/InspectorTest.scene', 'w'), indent=2)
print(f'wrote {len(objects)} objects')
