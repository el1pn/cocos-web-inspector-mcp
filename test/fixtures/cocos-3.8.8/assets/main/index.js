System.register("chunks:///_virtual/InspectorFixture.ts", ['./rollupPluginModLoBabelHelpers.js', 'cc'], function (exports) {
  var _applyDecoratedDescriptor, _inheritsLoose, _initializerDefineProperty, _assertThisInitialized, cclegacy, _decorator, Component;
  return {
    setters: [function (module) {
      _applyDecoratedDescriptor = module.applyDecoratedDescriptor;
      _inheritsLoose = module.inheritsLoose;
      _initializerDefineProperty = module.initializerDefineProperty;
      _assertThisInitialized = module.assertThisInitialized;
    }, function (module) {
      cclegacy = module.cclegacy;
      _decorator = module._decorator;
      Component = module.Component;
    }],
    execute: function () {
      var _dec, _class, _class2, _descriptor, _descriptor2, _descriptor3;
      cclegacy._RF.push({}, "9d1b9t1w0VEVITzZEiXhZfD", "InspectorFixture", undefined);
      var ccclass = _decorator.ccclass,
        property = _decorator.property;

      // Canary component for cocos-web-inspector-mcp. Keep values in sync with fixture-manifest.json.
      var InspectorFixture = exports('InspectorFixture', (_dec = ccclass('InspectorFixture'), _dec(_class = (_class2 = /*#__PURE__*/function (_Component) {
        _inheritsLoose(InspectorFixture, _Component);
        function InspectorFixture() {
          var _this;
          for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
            args[_key] = arguments[_key];
          }
          _this = _Component.call.apply(_Component, [this].concat(args)) || this;
          _initializerDefineProperty(_this, "title", _descriptor, _assertThisInitialized(_this));
          _initializerDefineProperty(_this, "count", _descriptor2, _assertThisInitialized(_this));
          _initializerDefineProperty(_this, "featureEnabled", _descriptor3, _assertThisInitialized(_this));
          _this.details = {
            category: 'manual-test',
            password: 'must-not-be-returned'
          };
          return _this;
        }
        var _proto = InspectorFixture.prototype;
        _proto.onLoad = function onLoad() {
          Object.defineProperty(this, 'mustNotRun', {
            enumerable: true,
            get: function get() {
              throw new Error('Property getter was invoked');
            }
          });
        };
        return InspectorFixture;
      }(Component), (_descriptor = _applyDecoratedDescriptor(_class2.prototype, "title", [property], {
        configurable: true,
        enumerable: true,
        writable: true,
        initializer: function initializer() {
          return 'Inspector fixture';
        }
      }), _descriptor2 = _applyDecoratedDescriptor(_class2.prototype, "count", [property], {
        configurable: true,
        enumerable: true,
        writable: true,
        initializer: function initializer() {
          return 42;
        }
      }), _descriptor3 = _applyDecoratedDescriptor(_class2.prototype, "featureEnabled", [property], {
        configurable: true,
        enumerable: true,
        writable: true,
        initializer: function initializer() {
          return true;
        }
      })), _class2)) || _class));
      cclegacy._RF.pop();
    }
  };
});

System.register("chunks:///_virtual/main", ['./InspectorFixture.ts'], function () {
  return {
    setters: [null],
    execute: function () {}
  };
});

(function(r) {
  r('virtual:///prerequisite-imports/main', 'chunks:///_virtual/main'); 
})(function(mid, cid) {
    System.register(mid, [cid], function (_export, _context) {
    return {
        setters: [function(_m) {
            var _exportObj = {};

            for (var _key in _m) {
              if (_key !== "default" && _key !== "__esModule") _exportObj[_key] = _m[_key];
            }
      
            _export(_exportObj);
        }],
        execute: function () { }
    };
    });
});