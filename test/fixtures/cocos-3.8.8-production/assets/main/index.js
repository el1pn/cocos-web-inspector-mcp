System.register("chunks:///_virtual/InspectorFixture.ts",["./rollupPluginModLoBabelHelpers.js","cc"],(function(e){var t,r,n,i,o,u,a;return{setters:[function(e){t=e.applyDecoratedDescriptor,r=e.inheritsLoose,n=e.initializerDefineProperty,i=e.assertThisInitialized},function(e){o=e.cclegacy,u=e._decorator,a=e.Component}],execute:function(){var c,l,s,p,f;o._RF.push({},"9d1b9t1w0VEVITzZEiXhZfD","InspectorFixture",void 0);var b=u.ccclass,d=u.property;e("InspectorFixture",b("InspectorFixture")((s=t((l=function(e){function t(){for(var t,r=arguments.length,o=new Array(r),u=0;u<r;u++)o[u]=arguments[u];return t=e.call.apply(e,[this].concat(o))||this,n(t,"title",s,i(t)),n(t,"count",p,i(t)),n(t,"featureEnabled",f,i(t)),t.details={category:"manual-test",password:"must-not-be-returned"},t}return r(t,e),t.prototype.onLoad=function(){Object.defineProperty(this,"mustNotRun",{enumerable:!0,get:function(){throw new Error("Property getter was invoked")}})},t}(a)).prototype,"title",[d],{configurable:!0,enumerable:!0,writable:!0,initializer:function(){return"Inspector fixture"}}),p=t(l.prototype,"count",[d],{configurable:!0,enumerable:!0,writable:!0,initializer:function(){return 42}}),f=t(l.prototype,"featureEnabled",[d],{configurable:!0,enumerable:!0,writable:!0,initializer:function(){return!0}}),c=l))||c);o._RF.pop()}}}));

System.register("chunks:///_virtual/main",["./InspectorFixture.ts"],(function(){return{setters:[null],execute:function(){}}}));

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