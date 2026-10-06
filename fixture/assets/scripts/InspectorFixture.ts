import { _decorator, Component, Node } from 'cc';

const { ccclass, property } = _decorator;

// Canary component for cocos-web-inspector-mcp. Keep values in sync with fixture-manifest.json.
@ccclass('InspectorFixture')
export class InspectorFixture extends Component {
  @property
  title = 'Inspector fixture';

  @property
  count = 42;

  @property
  featureEnabled = true;

  details = {
    category: 'manual-test',
    password: 'must-not-be-returned',
  };

  // Runtime-only reference to a node destroyed in onLoad; the inspector must flag it destroyed.
  staleNode: Node | null = null;

  onLoad(): void {
    this.staleNode = new Node('StaleNode');
    this.staleNode.destroy();
    Object.defineProperty(this, 'mustNotRun', {
      enumerable: true,
      get: () => {
        throw new Error('Property getter was invoked');
      },
    });
  }
}
