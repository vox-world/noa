var glvec3 = require("gl-vec3");
import { removeUnorderedListItem } from "./util";

import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Octree } from "@babylonjs/core/Culling/Octrees/octree";
import { OctreeBlock } from "@babylonjs/core/Culling/Octrees/octreeBlock";
import { Engine } from "@babylonjs/core";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3, Color3 } from "@babylonjs/core/Maths/math";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { OctreeSceneComponent } from "@babylonjs/core/Culling/Octrees/";
import "@babylonjs/core/Meshes/meshBuilder";

export default function (noa, opts, canvas) {
    return new Rendering(noa, opts, canvas);
}

// profiling flag
var PROFILE = 0;

var defaults = {
    showFPS: false,
    antiAlias: true,
    clearColor: [0.8, 0.9, 1],
    ambientColor: [1, 1, 1],
    lightDiffuse: [1, 1, 1],
    lightSpecular: [1, 1, 1],
    groundLightColor: [0.5, 0.5, 0.5],
    useAO: true,
    AOmultipliers: [0.93, 0.8, 0.5],
    reverseAOmultiplier: 1.0,
    preserveDrawingBuffer: true,
};

/**
 * @class
 * @typicalname noa.rendering
 * @classdesc Manages all rendering, and the BABYLON scene, materials, etc.
 */

function Rendering(noa, opts, canvas) {
    this.noa = noa;

    /**
     * `noa.rendering` uses the following options (from the root `noa(opts)` options):
     * ```js
     * {
     *   showFPS: false,
     *   antiAlias: true,
     *   clearColor: [0.8, 0.9, 1],
     *   ambientColor: [1, 1, 1],
     *   lightDiffuse: [1, 1, 1],
     *   lightSpecular: [1, 1, 1],
     *   groundLightColor: [0.5, 0.5, 0.5],
     *   useAO: true,
     *   AOmultipliers: [0.93, 0.8, 0.5],
     *   reverseAOmultiplier: 1.0,
     *   preserveDrawingBuffer: true,
     * }
     * ```
     */
    opts = Object.assign({}, defaults, opts);

    // internals
    this.useAO = !!opts.useAO;
    this.aoVals = opts.AOmultipliers;
    this.revAoVal = opts.reverseAOmultiplier;
    this.meshingCutoffTime = 6; // ms
    this._resizeDebounce = 250; // ms

    // set up babylon scene
    initScene(this, canvas, opts);

    // for debugging
    if (opts.showFPS) setUpFPS();
}

// Constructor helper - set up the Babylon.js scene and basic components
function initScene(self, canvas, opts) {
    // init internal properties
    self._engine = new Engine(canvas, opts.antiAlias, {
        preserveDrawingBuffer: opts.preserveDrawingBuffer,
    });
    self._scene = new Scene(self._engine);
    var scene = self._scene;
    // remove built-in listeners
    scene.detachControl();

    // octree setup
    scene._addComponent(new OctreeSceneComponent(scene));
    self._octree = new Octree(($) => {});
    self._octree.blocks = [];
    scene._selectionOctree = self._octree;

    // camera, and empty mesh to hold it, and one to accumulate rotations
    self._cameraHolder = new Mesh("camHolder", scene);
    self._camera = new UniversalCamera("camera", new Vector3(0, 0, 0), scene);
    self._camera.fov = opts.cameraFOV || 0.8;
    self._camera.parent = self._cameraHolder;
    self._camera.minZ = 0.01;
    self._cameraHolder.visibility = false;

    // plane obscuring the camera - for overlaying an effect on the whole view
    self._camScreen = Mesh.CreatePlane("camScreen", 10, scene);
    self.addMeshToScene(self._camScreen);
    self._camScreen.position.z = 0.1;
    self._camScreen.parent = self._camera;
    self._camScreenMat = self.makeStandardMaterial("camscreenmat");
    self._camScreen.material = self._camScreenMat;
    self._camScreen.setEnabled(false);
    self._camLocBlock = 0;

    // apply some defaults
    var lightVec = new Vector3(0.1, 1, 0.3);
    self._light = new HemisphericLight("light", lightVec, scene);

    function arrToColor(a) {
        return new Color3(a[0], a[1], a[2]);
    }
    scene.clearColor = arrToColor(opts.clearColor);
    scene.ambientColor = arrToColor(opts.ambientColor);
    self._light.diffuse = arrToColor(opts.lightDiffuse);
    self._light.specular = arrToColor(opts.lightSpecular);
    self._light.groundColor = arrToColor(opts.groundLightColor);

    // make a default flat material (used or clone by terrain, etc)
    self.flatMaterial = self.makeStandardMaterial("flatmat");
}

/*
 *   PUBLIC API
 */

/**
 * The Babylon `scene` object representing the game world.
 * @member
 */
Rendering.prototype.getScene = function () {
    return this._scene;
};

// per-tick listener for rendering-related stuff
Rendering.prototype.tick = function (dt) {
    // nothing here at the moment
};

Rendering.prototype.render = function (dt) {
    profile_hook("start");
    updateCameraForRender(this);
    profile_hook("updateCamera");
    this._engine.beginFrame();
    profile_hook("beginFrame");
    this._scene.render();
    profile_hook("render");
    fps_hook();
    this._engine.endFrame();
    profile_hook("endFrame");
    profile_hook("end");
};

Rendering.prototype.resize = function (e) {
    if (!pendingResize) {
        pendingResize = true;
        setTimeout(() => {
            this._engine.resize();
            pendingResize = false;
        }, this._resizeDebounce);
    }
};
var pendingResize = false;

Rendering.prototype.highlightBlockFace = function (show, posArr, normArr) {
    var m = getHighlightMesh(this);
    if (show) {
        // floored local coords for highlight mesh
        this.noa.globalToLocal(posArr, null, hlpos);
        // offset to avoid z-fighting, bigger when camera is far away
        var dist = glvec3.dist(this.noa.camera._localGetPosition(), hlpos);
        var slop = 0.001 + 0.001 * dist;
        for (var i = 0; i < 3; i++) {
            if (normArr[i] === 0) {
                hlpos[i] += 0.5;
            } else {
                hlpos[i] += normArr[i] > 0 ? 1 + slop : -slop;
            }
        }
        m.position.copyFromFloats(hlpos[0], hlpos[1], hlpos[2]);
        m.rotation.x = normArr[1] ? Math.PI / 2 : 0;
        m.rotation.y = normArr[0] ? Math.PI / 2 : 0;
    }
    m.setEnabled(show);
};
var hlpos = [];

/**
 * Add a mesh to the scene's octree setup so that it renders.
 *
 * @param mesh: the mesh to add to the scene
 * @param isStatic: pass in true if mesh never moves (i.e. change octree blocks)
 * @param position: (optional) global position where the mesh should be
 * @param chunk: (optional) chunk to which the mesh is statically bound
 * @method
 */
Rendering.prototype.addMeshToScene = function (
    mesh,
    isStatic,
    pos,
    _containingChunk
) {
    // exit silently if mesh has already been added and not removed
    if (mesh._noaContainingChunk) return;
    if (this._octree.dynamicContent.includes(mesh)) return;

    // find local position for mesh and move it there (unless it's parented)
    if (!mesh.parent) {
        if (!pos) pos = [mesh.position.x, mesh.position.y, mesh.position.z];
        var lpos = [];
        this.noa.globalToLocal(pos, null, lpos);
        mesh.position.copyFromFloats(lpos[0], lpos[1], lpos[2]);
    }

    // statically tie to a chunk's octree, or treat as dynamic?
    var addToOctree = false;
    if (isStatic) {
        var chunk =
            _containingChunk ||
            this.noa.world._getChunkByCoords(pos[0], pos[1], pos[2]);
        addToOctree = !!(chunk && chunk.octreeBlock);
    }

    if (addToOctree) {
        chunk.octreeBlock.entries.push(mesh);
        mesh._noaContainingChunk = chunk;
    } else {
        this._octree.dynamicContent.push(mesh);
    }

    if (isStatic) {
        mesh.freezeWorldMatrix();
        mesh.freezeNormals();
    }

    // add dispose event to undo everything done here
    var remover = this.removeMeshFromScene.bind(this, mesh);
    mesh.onDisposeObservable.add(remover);
};

/**  Undoes everything `addMeshToScene` does
 * @method
 */
Rendering.prototype.removeMeshFromScene = function (mesh) {
    if (mesh._noaContainingChunk && mesh._noaContainingChunk.octreeBlock) {
        removeUnorderedListItem(
            mesh._noaContainingChunk.octreeBlock.entries,
            mesh
        );
    }
    mesh._noaContainingChunk = null;
    removeUnorderedListItem(this._octree.dynamicContent, mesh);
};

// Create a default standardMaterial:
//      flat, nonspecular, fully reflects diffuse and ambient light
Rendering.prototype.makeStandardMaterial = function (name) {
    var mat = new StandardMaterial(name, this._scene);
    mat.specularColor.copyFromFloats(0, 0, 0);
    mat.ambientColor.copyFromFloats(1, 1, 1);
    mat.diffuseColor.copyFromFloats(1, 1, 1);
    return mat;
};

/*
 *
 *
 *   ACCESSORS FOR CHUNK ADD/REMOVAL/MESHING
 *
 *
 */

Rendering.prototype.prepareChunkForRendering = function (chunk) {
    var cs = chunk.size;
    var loc = [];
    this.noa.globalToLocal([chunk.x, chunk.y, chunk.z], null, loc);
    var min = new Vector3(loc[0], loc[1], loc[2]);
    var max = new Vector3(loc[0] + cs, loc[1] + cs, loc[2] + cs);
    chunk.octreeBlock = new OctreeBlock(
        min,
        max,
        undefined,
        undefined,
        undefined,
        ($) => {}
    );
    this._octree.blocks.push(chunk.octreeBlock);
};

Rendering.prototype.disposeChunkForRendering = function (chunk) {
    if (!chunk.octreeBlock) return;
    removeUnorderedListItem(this._octree.blocks, chunk.octreeBlock);
    chunk.octreeBlock.entries.length = 0;
    chunk.octreeBlock = null;
};

/*
 *
 *   INTERNALS
 *
 */

// change world origin offset, and rebase everything with a position

Rendering.prototype._rebaseOrigin = function (delta) {
    var dvec = new Vector3(delta[0], delta[1], delta[2]);

    this._scene.meshes.forEach((mesh) => {
        // parented meshes don't live in the world coord system
        if (mesh.parent) return;

        // move each mesh by delta (even though most are managed by components)
        mesh.position.subtractInPlace(dvec);

        if (mesh._isWorldMatrixFrozen) mesh.markAsDirty();
    });

    // update octree block extents
    this._octree.blocks.forEach((octreeBlock) => {
        octreeBlock.minPoint.subtractInPlace(dvec);
        octreeBlock.maxPoint.subtractInPlace(dvec);
        octreeBlock._boundingVectors.forEach((v) => {
            v.subtractInPlace(dvec);
        });
    });
};

// updates camera position/rotation to match settings from noa.camera

function updateCameraForRender(self) {
    var cam = self.noa.camera;
    var tgtLoc = cam._localGetTargetPosition();
    self._cameraHolder.position.copyFromFloats(tgtLoc[0], tgtLoc[1], tgtLoc[2]);
    self._cameraHolder.rotation.x = cam.pitch;
    self._cameraHolder.rotation.y = cam.heading;
    self._camera.position.z = -cam.currentZoom;

    // applies screen effect when camera is inside a transparent voxel
    var cloc = cam._localGetPosition();
    var off = self.noa.worldOriginOffset;
    var cx = Math.floor(cloc[0] + off[0]);
    var cy = Math.floor(cloc[1] + off[1]);
    var cz = Math.floor(cloc[2] + off[2]);
    var id = self.noa.getBlock(cx, cy, cz);
    checkCameraEffect(self, id);
}

//  If camera's current location block id has alpha color (e.g. water), apply/remove an effect

function checkCameraEffect(self, id) {
    if (id === self._camLocBlock) return;
    if (id === 0) {
        self._camScreen.setEnabled(false);
    } else {
        var matId = self.noa.registry.getBlockFaceMaterial(id, 0);
        if (matId) {
            var matData = self.noa.registry.getMaterialData(matId);
            var col = matData.color;
            var alpha = matData.alpha;
            if (col && alpha && alpha < 1) {
                self._camScreenMat.diffuseColor.set(0, 0, 0);
                self._camScreenMat.ambientColor.set(col[0], col[1], col[2]);
                self._camScreenMat.alpha = alpha;
                self._camScreen.setEnabled(true);
            }
        }
    }
    self._camLocBlock = id;
}

// make or get a mesh for highlighting active voxel
function getHighlightMesh(rendering) {
    var mesh = rendering._highlightMesh;
    if (!mesh) {
        mesh = Mesh.CreatePlane("highlight", 1.0, rendering._scene);
        var hlm = rendering.makeStandardMaterial("highlightMat");
        hlm.backFaceCulling = false;
        hlm.emissiveColor = new Color3(1, 1, 1);
        hlm.alpha = 0.2;
        mesh.material = hlm;

        // outline
        var s = 0.5;
        var lines = Mesh.CreateLines(
            "hightlightLines",
            [
                new Vector3(s, s, 0),
                new Vector3(s, -s, 0),
                new Vector3(-s, -s, 0),
                new Vector3(-s, s, 0),
                new Vector3(s, s, 0),
            ],
            rendering._scene
        );
        lines.color = new Color3(1, 1, 1);
        lines.parent = mesh;

        rendering.addMeshToScene(mesh);
        rendering.addMeshToScene(lines);
        rendering._highlightMesh = mesh;
    }
    return mesh;
}

/*
 *
 *      sanity checks:
 *
 */

Rendering.prototype.debug_SceneCheck = function () {
    var meshes = this._scene.meshes;
    var dyns = this._octree.dynamicContent;
    var octs = [];
    var numOcts = 0;
    var mats = this._scene.materials;
    var allmats = [];
    mats.forEach((mat) => {
        if (mat.subMaterials)
            mat.subMaterials.forEach((mat) => allmats.push(mat));
        else allmats.push(mat);
    });
    this._octree.blocks.forEach(function (block) {
        numOcts++;
        block.entries.forEach((m) => octs.push(m));
    });
    meshes.forEach(function (m) {
        if (m._isDisposed) warn(m, "disposed mesh in scene");
        if (empty(m)) return;
        if (missing(m, dyns, octs))
            warn(m, "non-empty mesh missing from octree");
        if (!m.material) {
            warn(m, "non-empty scene mesh with no material");
            return;
        }
        (m.material.subMaterials || [m.material]).forEach(function (mat) {
            if (missing(mat, mats)) warn(mat, "mesh material not in scene");
        });
    });
    var unusedMats = [];
    allmats.forEach((mat) => {
        var used = false;
        meshes.forEach((mesh) => {
            if (mesh.material === mat) used = true;
            if (!mesh.material || !mesh.material.subMaterials) return;
            if (mesh.material.subMaterials.includes(mat)) used = true;
        });
        if (!used) unusedMats.push(mat.name);
    });
    if (unusedMats.length) {
        console.warn("Materials unused by any mesh: ", unusedMats.join(", "));
    }
    dyns.forEach(function (m) {
        if (missing(m, meshes)) warn(m, "octree/dynamic mesh not in scene");
    });
    octs.forEach(function (m) {
        if (missing(m, meshes)) warn(m, "octree block mesh not in scene");
    });
    var avgPerOct = Math.round((10 * octs.length) / numOcts) / 10;
    console.log(
        "meshes - octree:",
        octs.length,
        "  dynamic:",
        dyns.length,
        "   avg meshes/octreeBlock:",
        avgPerOct
    );

    function warn(obj, msg) {
        console.warn(obj.name + " --- " + msg);
    }

    function empty(mesh) {
        return mesh.getIndices().length === 0;
    }

    function missing(obj, list1, list2) {
        if (!obj) return false;
        if (list1.includes(obj)) return false;
        if (list2 && list2.includes(obj)) return false;
        return true;
    }
    return "done.";
};

Rendering.prototype.debug_MeshCount = function () {
    var ct = {};
    this._scene.meshes.forEach((m) => {
        var n = m.name || "";
        n = n.replace(/-\d+.*/, "#");
        n = n.replace(/\d+.*/, "#");
        n = n.replace(/(rotHolder|camHolder|camScreen)/, "rendering use");
        n = n.replace(/atlas sprite .*/, "atlas sprites");
        ct[n] = ct[n] || 0;
        ct[n]++;
    });
    for (var s in ct) console.log("   " + (ct[s] + "       ").substr(0, 7) + s);
};

import { makeProfileHook } from "./util";
var profile_hook = PROFILE
    ? makeProfileHook(200, "render internals")
    : () => {};

var fps_hook = function () {};

function setUpFPS() {
    var div = document.createElement("div");
    div.id = "noa_fps";
    var style = "position:absolute; top:0; right:0; z-index:0;";
    style += "color:white; background-color:rgba(0,0,0,0.5);";
    style += "font:14px monospace; text-align:center;";
    style += "min-width:2em; margin:4px;";
    div.style = style;
    document.body.appendChild(div);
    var every = 1000;
    var ct = 0;
    var longest = 0;
    var start = performance.now();
    var last = start;
    fps_hook = function () {
        ct++;
        var nt = performance.now();
        if (nt - last > longest) longest = nt - last;
        last = nt;
        if (nt - start < every) return;
        var fps = Math.round((ct / (nt - start)) * 1000);
        var min = Math.round((1 / longest) * 1000);
        div.innerHTML = fps + "<br>" + min;
        ct = 0;
        longest = 0;
        start = nt;
    };
}
