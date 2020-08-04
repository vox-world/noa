import { SolidParticleSystem } from "@babylonjs/core/Particles/solidParticleSystem";

export default new ObjectMesher();

// enable for profiling..
var PROFILE = 0;

// helper class to hold data about a single object mesh
function ObjMeshDat(id, x, y, z) {
    this.id = id | 0;
    this.x = x | 0;
    this.y = y | 0;
    this.z = z | 0;
}

/*
 *
 *
 *          Object meshing
 *  Per-chunk handling of the creation/disposal of voxels with static meshes
 *
 *
 */

function ObjectMesher() {
    // adds properties to the new chunk that will be used when processing
    this.initChunk = function (chunk) {
        chunk._objectBlocks = {};
        chunk._objectSystems = [];

        chunk._objectMeshes = {};
    };

    this.disposeChunk = function (chunk) {
        this.removeObjectMeshes(chunk);
        chunk._objectBlocks = null;
    };

    // accessors for the chunk to regester as object voxels are set/unset
    this.addObjectBlock = function (chunk, id, x, y, z) {
        var key = x + "|" + y + "|" + z;
        chunk._objectBlocks[key] = new ObjMeshDat(id, x, y, z, null);
    };

    this.removeObjectBlock = function (chunk, x, y, z) {
        var key = x + "|" + y + "|" + z;
        if (chunk._objectBlocks[key]) delete chunk._objectBlocks[key];
    };

    /*
     *
     *    main implementation - remove / rebuild all needed object mesh instances
     *
     */

    this.removeObjectMeshes = function (chunk) {
        // remove the current (if any) sps/mesh
        var systems = chunk._objectSystems || [];
        while (systems.length) {
            var sps = systems.pop();
            if (sps.mesh) sps.mesh.dispose();
            sps.dispose();
        }
    };

    this.buildObjectMeshes = function (chunk) {
        profile_hook("start");

        var scene = chunk.noa.rendering.getScene();
        var objectMeshLookup = chunk.noa.registry._blockMeshLookup;
        var blockHandlerLookup = chunk.noa.registry._blockHandlerLookup;

        var x0 = chunk.i * chunk.size;
        var y0 = chunk.j * chunk.size;
        var z0 = chunk.k * chunk.size;
        // preprocess everything to build lists of object block keys
        // hashed by material ID and then by block ID
        // var matIndexes = {};

        // For now: use one SPS for all the meshes
        var sps = new SolidParticleSystem("object_sps_" + chunk.id, scene, {
            updatable: false,
            useModelMaterial: true,
        });
        for (var key in chunk._objectBlocks) {
            console.log("key", key);
            var blockDat = chunk._objectBlocks[key];
            var blockID = blockDat.id;
            var mesh = objectMeshLookup[blockID];
            var handlerFn;
            var handlers = blockHandlerLookup[blockID];
            // console.log(handlers);
            if (handlers) {
                handlerFn = handlers.customizeMesh;
            }
            const [_x, _y, _z] = [
                x0 + blockDat.x,
                y0 + blockDat.y,
                z0 + blockDat.z,
            ];
            mesh = mesh.clone();
            if (mesh.material) {
                mesh.material = mesh.material.clone();
            }
            if (handlerFn) {
                const coords = _x + "|" + _y + "|" + _z;
                const objectID = chunk.coordsToObjectID.get(coords);
                const object = chunk.objects.get(objectID);
                mesh = handlerFn(mesh, object, objectID, coords);
            }
            var setShape = function (particle, partIndex, shapeIndex) {
                // set (local) pos and call handler (with global coords)
                particle.position.set(
                    blockDat.x + 0.5,
                    blockDat.y,
                    blockDat.z + 0.5
                );
                // if (handlerFn) handlerFn(particle);
            };
            sps.addShape(mesh, 1, { positionFunction: setShape });
            // var mat = mesh.material;
            // var matIndex = mat ? scene.materials.indexOf(mat) : -1;
            // if (!matIndexes[matIndex]) matIndexes[matIndex] = {};
            // if (!matIndexes[matIndex][blockID])
            //     matIndexes[matIndex][blockID] = [];
            // matIndexes[matIndex][blockID].push(key);
        }
        const merged = sps.buildMesh();
        return [merged];

        // return meshes;
        // profile_hook("preprocess");

        // data structure now looks like:
        // matIndexes = {
        //      2: {                    // i.e. 2nd material in scene
        //          14: {               // i.e. voxel ID 14 from registry
        //              [ '2|3|4' ]     // key of block's local coords
        //          }
        //      }
        // }

        // build one SPS mesh for each material
        // var meshes = [];
        // for (var ix in matIndexes) {
        //     var meshHash = matIndexes[ix];
        //     var sps = buildSPSforMaterialIndex(
        //         chunk,
        //         scene,
        //         meshHash,
        //         x0,
        //         y0,
        //         z0
        //     );
        //     profile_hook("made SPS");

        //     // build SPS into the scene
        //     var merged = sps.buildMesh();
        //     profile_hook("built mesh");

        //     // finish up
        //     merged.material = ix > -1 ? scene.materials[ix] : null;
        //     meshes.push(merged);
        //     chunk._objectSystems.push(sps);
        // }

        // profile_hook("end");
        // return meshes;
    };

    function buildSPSforMaterialIndex(chunk, scene, meshHash, x0, y0, z0) {
        var blockHash = chunk._objectBlocks;
        // base sps
        var sps = new SolidParticleSystem("object_sps_" + chunk.id, scene, {
            updatable: false,
        });

        var blockHandlerLookup = chunk.noa.registry._blockHandlerLookup;
        var objectMeshLookup = chunk.noa.registry._blockMeshLookup;

        // run through mesh hash adding shapes and position functions
        for (var blockID in meshHash) {
            var mesh = objectMeshLookup[blockID];
            var blockArr = meshHash[blockID];
            console.log(`blockArr`, blockArr);
            var count = blockArr.length;

            var handlerFn;
            var handlers = blockHandlerLookup[blockID];
            if (handlers) {
                handlerFn = handlers.onCustomMeshCreate;
            }
            var setShape = function (particle, partIndex, shapeIndex) {
                var key = blockArr[shapeIndex];
                var dat = blockHash[key];

                // set (local) pos and call handler (with global coords)
                particle.position.set(dat.x + 0.5, dat.y, dat.z + 0.5);
                if (handlerFn) handlerFn(particle);
            };
            sps.addShape(mesh, count, { positionFunction: setShape });
            blockArr.length = 0;
        }

        return sps;
    }
}

import { makeProfileHook } from "./util";
var profile_hook = PROFILE ? makeProfileHook(50, "Object meshing") : () => {};
