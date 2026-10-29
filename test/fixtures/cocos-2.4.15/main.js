// Hand-written Cocos 2.4.15 web fixture. Builds the scene in code, so it needs no Creator project.
cc.Class({
  extends: cc.Component,
  name: 'InspectorFixture',
  properties: {
    publicValue: 42,
    title: 'canary',
    accessToken: 'must-be-redacted',
    // Backed by `_level` behind an accessor, the 2.x layout the inspector must expose as `level`.
    level: {
      get() { return this._level; },
      set(value) { this._level = value; },
    },
    // Backed by `_mustNotRun`; reading the getter would throw, so the inspector must not call it.
    mustNotRun: {
      get() { throw new Error('getter must not run'); },
      set() {},
    },
  },
  ctor() {
    this._level = 7;
    this._mustNotRun = 'backing-value';
  },
});

function onStart() {
  cc.view.setDesignResolutionSize(960, 640, cc.ResolutionPolicy.SHOW_ALL);
  const scene = new cc.Scene();
  scene.name = 'InspectorTest';

  const canvas = new cc.Node('Canvas');
  canvas.parent = scene;
  canvas.addComponent(cc.Canvas).designResolution = cc.size(960, 640);
  canvas.setPosition(480, 320);

  const camera = new cc.Node('Main Camera');
  camera.parent = canvas;
  camera.addComponent(cc.Camera);

  const panel = new cc.Node('Panel');
  panel.parent = canvas;
  panel.setContentSize(400, 300);
  panel.addComponent('InspectorFixture');

  const title = new cc.Node('Title');
  title.parent = panel;
  title.setPosition(0, 100);
  title.addComponent(cc.Label).string = 'Inspector 2.x';

  const icon = new cc.Node('Icon');
  icon.parent = panel;
  icon.setContentSize(100, 100);
  icon.addComponent(cc.Sprite);

  const play = new cc.Node('PlayButton');
  play.parent = panel;
  play.setContentSize(160, 60);
  play.setPosition(0, -100);
  play.addComponent(cc.Button);

  cc.director.runSceneImmediate(scene);
}
// run() assigns its second argument to cc.game.onStart, so it must be passed here.
cc.game.run({ id: 'GameCanvas', debugMode: cc.debug.DebugMode.WARN, showFPS: false, frameRate: 60 }, onStart);
