System.register("chunks:///_virtual/InspectorFixture.ts",["./rollupPluginModLoBabelHelpers.js","cc"],(function(e){var t,r,n,o,i,a,u,l;return{setters:[function(e){t=e.applyDecoratedDescriptor,r=e.inheritsLoose,n=e.initializerDefineProperty,o=e.assertThisInitialized},function(e){i=e.cclegacy,a=e._decorator,u=e.Node,l=e.Component}],execute:function(){var c,s,p,f,d;i._RF.push({},"9d1b9t1w0VEVITzZEiXhZfD","InspectorFixture",void 0);var b=a.ccclass,y=a.property;e("InspectorFixture",b("InspectorFixture")((p=t((s=function(e){function t(){for(var t,r=arguments.length,i=new Array(r),a=0;a<r;a++)i[a]=arguments[a];return t=e.call.apply(e,[this].concat(i))||this,n(t,"title",p,o(t)),n(t,"count",f,o(t)),n(t,"featureEnabled",d,o(t)),t.details={category:"manual-test",password:"must-not-be-returned"},t.staleNode=null,t}return r(t,e),t.prototype.onLoad=function(){this.staleNode=new u("StaleNode"),this.staleNode.destroy(),Object.defineProperty(this,"mustNotRun",{enumerable:!0,get:function(){throw new Error("Property getter was invoked")}})},t}(l)).prototype,"title",[y],{configurable:!0,enumerable:!0,writable:!0,initializer:function(){return"Inspector fixture"}}),f=t(s.prototype,"count",[y],{configurable:!0,enumerable:!0,writable:!0,initializer:function(){return 42}}),d=t(s.prototype,"featureEnabled",[y],{configurable:!0,enumerable:!0,writable:!0,initializer:function(){return!0}}),c=s))||c);i._RF.pop()}}}));

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