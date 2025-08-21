// File: commands.mjs (ESM)
// Node >= 18
// ----------------------------------------------------------------------------
// Fixes & Improvements
// - Correctly handles `.schem` variants where the block data is wrapped under
//   a `Blocks` compound ("states_wrapped") and the Palette is a name->index map.
// - Fixes reversed palette mapping bug (object case) causing all blocks to read as air.
// - Computes bits-per-entry using actual palette size for object palettes.
// - Adds support for inner BlockData (LEB128 varints) inside wrapped `Blocks`.
// - Adds last-resort fallback: scan for any keys containing "block" to locate
//   block arrays (BlockStates/BlockData/Data) and a palette near them.
// - Memory-friendly merging using Uint8Array visited flags.
// ----------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { gunzipSync, inflateSync } from "zlib";
import crypto from "crypto";
import AdmZip from "adm-zip";
import readline from "readline";

// ---------- config / maps ----------
const legacyMap = JSON.parse(
  await fs.promises.readFile(new URL("./legacy-conversion-map.json", import.meta.url), "utf8")
);

const javaToBedrockMap = JSON.parse(
  await fs.promises.readFile(new URL("./java-to-bedrock.json", import.meta.url), "utf8")
);

const INVALID_BLOCKS = new Set([
  "minecraft:piston_head",
  "minecraft:moving_block",
  "minecraft:moving_piston",
]);

// ---------- tiny utils ----------
const isAir = (n) => n === "minecraft:air" || n === "minecraft:cave_air" || n === "minecraft:void_air";
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

function maybeDecompress(raw) {
  try { return gunzipSync(raw); } catch {}
  try { return inflateSync(raw); } catch {}
  return raw;
}

function normalizeNamespace(n) {
  if (!n) return "";
  if (typeof n !== "string") n = String(n);
  n = n.toLowerCase();
  return n.includes(":") ? n : `minecraft:${n}`;
}

function isNumericOrBoolean(value) {
  if (typeof value === "boolean") return true;
  if (value === "true" || value === "false") return true;
  return Number.isFinite(Number(value));
}

// ---------- NBT reader (minimal, zero-dependency) ----------
class BinaryReader {
  constructor(b){this.buffer=b;this.offset=0;}
  readByte(){const v=this.buffer.readInt8(this.offset);this.offset+=1;return v;}
  readUnsignedByte(){const v=this.buffer.readUInt8(this.offset);this.offset+=1;return v;}
  readUnsignedShort(){const v=this.buffer.readUInt16BE(this.offset);this.offset+=2;return v;}
  readShort(){const v=this.buffer.readInt16BE(this.offset);this.offset+=2;return v;}
  readInt(){const v=this.buffer.readInt32BE(this.offset);this.offset+=4;return v;}
  readLong(){const hi=this.readInt();const lo=this.readInt();return (BigInt(hi)<<32n) | BigInt(lo>>>0);}
  readFloat(){const v=this.buffer.readFloatBE(this.offset);this.offset+=4;return v;}
  readDouble(){const v=this.buffer.readDoubleBE(this.offset);this.offset+=8;return v;}
  readBytes(n){const s=this.buffer.subarray(this.offset,this.offset+n);this.offset+=n;return s;}
  readString(){const len=this.readUnsignedShort();const s=this.buffer.toString("utf8",this.offset,this.offset+len);this.offset+=len;return s;}
}
function readPayload(type,r){
  switch(type){
    case 1: return r.readByte();
    case 2: return r.readShort();
    case 3: return r.readInt();
    case 4: return r.readLong();
    case 5: return r.readFloat();
    case 6: return r.readDouble();
    case 7: { const n=r.readInt(); return r.readBytes(n); }           // ByteArray -> Buffer
    case 8: return r.readString();
    case 9: { const ct=r.readUnsignedByte(); const n=r.readInt(); const list=new Array(n); for(let i=0;i<n;i++) list[i]=readPayload(ct,r); return list; }
    case 10:{ const obj={}; for(;;){ const t=r.readUnsignedByte(); if(t===0) break; const nm=r.readString(); obj[nm]=readPayload(t,r);} return obj; }
    case 11:{ const n=r.readInt(); const arr=new Int32Array(n); for(let i=0;i<n;i++) arr[i]=r.readInt(); return arr; }
    case 12:{ const n=r.readInt(); const arr=new BigInt64Array(n); for(let i=0;i<n;i++) arr[i]=r.readLong(); return arr; }
    default: throw new Error("Unsupported NBT tag type: "+type);
  }
}
function readTag(reader, expectName=true){
  const type=reader.readUnsignedByte();
  if(type===0) return {type:0,name:null,value:null};
  const name=expectName?reader.readString():null;
  return {type,name,value:readPayload(type,reader)};
}
function parseNBT(buf){
  const r=new BinaryReader(buf);
  const root=readTag(r,true);
  return root.value;
}

// ---------- .schem helpers ----------
function buildStateName(entry){
  if(!entry) return "minecraft:air";
  if(typeof entry==="string") return normalizeNamespace(entry);
  if(typeof entry==="number") return String(entry);
  const name = normalizeNamespace(entry.Name || entry.name || "minecraft:air");
  const props = entry.Properties || entry.properties;
  if(props && Object.keys(props).length){
    const pairs = Object.keys(props).sort().map(k => `${k}=${props[k]}`);
    return `${name}[${pairs.join(",")}]`;
  }
  return name;
}

// Sponge .schem: BlockData is LEB128 varints of palette indices
function decodeLEB128Varints(bytes, expectedCount){
  const out = new Uint32Array(expectedCount);
  let i=0, w=0;
  const n = bytes.length >>> 0;
  while(i<n && w<expectedCount){
    let result = 0 >>> 0;
    let shift = 0;
    for(;;){
      if(i>=n) throw new Error("Unexpected end of BlockData while decoding varint.");
      const b = bytes[i++];
      result |= (b & 0x7F) << shift;
      if((b & 0x80) === 0) break;
      shift += 7;
      if(shift > 35) throw new Error("Varint too long in BlockData.");
    }
    out[w++] = result >>> 0;
  }
  if(w !== expectedCount) throw new Error(`Decoded ${w} varints, expected ${expectedCount}.`);
  return out;
}

// Chunk-like packed BlockStates
function decodePackedBlockStates(longArr, count, bitsPerEntry){
  const maskVal = (1n<<BigInt(bitsPerEntry))-1n;
  const out = new Uint32Array(count);
  for(let i=0;i<count;i++){
    const bitIndex = BigInt(i*bitsPerEntry);
    const longIndex = Number(bitIndex >> 6n);
    const startBit = Number(bitIndex & 63n);
    const base = longArr[longIndex] & ((1n<<64n)-1n);
    let val = (base >> BigInt(startBit)) & maskVal;
    const endBit = startBit + bitsPerEntry;
    if(endBit>64){
      const bitsFromNext = endBit - 64;
      const nextBase = longArr[longIndex+1] & ((1n<<64n)-1n);
      const nextPart = (nextBase & ((1n<<BigInt(bitsFromNext))-1n)) << BigInt(64-startBit);
      val |= nextPart & maskVal;
    }
    out[i] = Number(val);
  }
  return out;
}

// ---------- coordinate order helpers ----------
function coordsXZY(i, w, h, l) {
  const x = i % w;
  const z = Math.floor(i / w) % l;
  const y = Math.floor(i / (w * l));
  return [x, y, z];
}
function indexXZY(x, y, z, w, h, l) { return x + z * w + y * w * l; }

// ---------- palette helpers ----------
function buildPaletteArray(pal){
  // Returns [ index -> name ] array and count
  if (!pal) return { arr: [], count: 0 };
  if (Array.isArray(pal)) {
    const arr = pal.map(buildStateName);
    return { arr, count: arr.length };
  }
  // Sponge Palette object: name -> index (number)
  const arr = [];
  let count = 0;
  for (const [name, idx] of Object.entries(pal)) {
    const i = Number(idx);
    if (Number.isFinite(i)) {
      arr[i] = buildStateName(name);
      count++;
    }
  }
  // If sparse, count might be less than maxIndex+1, but that is ok
  return { arr, count: Math.max(count, arr.length) };
}

function toUint8ArrayLike(input, vol) {
  if (!input) return new Uint8Array(vol);
  if (input instanceof Buffer || input instanceof Uint8Array) return input;
  if (input instanceof Int32Array || input instanceof Uint16Array || input instanceof Int16Array) {
    return new Uint8Array(Array.from(input, x => x & 0xFF));
  }
  if (Array.isArray(input)) {
    return new Uint8Array(input.map(x => Number(x) & 0xFF));
  }
  return null;
}

function normalizeClassicArray(input, mask = 0xFF) {
if (!input) return null;
if (input instanceof Buffer || input instanceof Uint8Array) {
if (mask === 0xFF) return input;
const out = new Uint8Array(input.length);
for (let i = 0; i < input.length; i++) out[i] = input[i] & mask;
return out;
}
if (
input instanceof Int32Array ||
input instanceof Uint16Array ||
input instanceof Int16Array ||
input instanceof Int8Array
) {
const out = new Uint8Array(input.length);
for (let i = 0; i < input.length; i++) out[i] = input[i] & mask;
return out;
}
if (Array.isArray(input)) {
const out = new Uint8Array(input.length);
for (let i = 0; i < input.length; i++) out[i] = Number(input[i]) & mask;
return out;
}
return null; // unsupported encoding
}

// ---------- load schematic ----------
async function loadSchematic(filePath) {
  const raw = await fs.promises.readFile(filePath);
  const buf = maybeDecompress(raw);
  let root = parseNBT(buf);

  if (isObj(root) && isObj(root.Schematic)) root = root.Schematic;

  let fmt = "unknown";
  const has = (k) => Object.prototype.hasOwnProperty.call(root, k);

  // Detection order: states_wrapped > modern (Palette present) > classic > fallback
  if (isObj(root.Blocks) && (root.Blocks.Palette || root.Blocks.BlockStatePalette || root.Blocks.BlockStates || root.Blocks.BlockData || root.Blocks.Data)) {
    fmt = "states_wrapped";
  } else if ((has("Palette") || has("BlockStatePalette")) && (has("BlockStates") || has("BlockData") || has("Blocks") || has("Data"))) {
    fmt = "modern";
  } else if (has("Width") && has("Height") && has("Length") && (has("Blocks") || has("Data") || has("BlockData"))) {
    fmt = "classic";
  }

  let width=0, height=0, length=0;
  let blocks;        // Uint32Array of palette indices
  let paletteStr;    // index -> java name
  let legacyBlocks;  // Uint8Array for classic IDs (or Uint16Array if AddBlocks)
  let legacyData;    // Uint8Array for classic data values

  const setDimsFrom = (obj) => {
    if (obj.Size && Array.isArray(obj.Size) && obj.Size.length>=3) {
      width = obj.Size[0]|0; height = obj.Size[1]|0; length = obj.Size[2]|0;
    } else {
      width = obj.Width|0; height = obj.Height|0; length = obj.Length|0;
    }
  };
  const volume = () => (width|0)*(height|0)*(length|0);

  if (fmt === "classic") {
    setDimsFrom(root);
    const vol = volume();

    const bRaw = root.Blocks ?? null;
    const dRaw = root.Data ?? null;
    const addRaw = root.AddBlocks ?? root.Add ?? null;

    const b = normalizeClassicArray(bRaw, 0xFF);
    const d = normalizeClassicArray(dRaw, 0x0F) || new Uint8Array(vol);

    if (!b) throw new Error("Classic schematic: Unsupported Blocks encoding (could not normalize).");

    let ids;
    const add = normalizeClassicArray(addRaw, 0xFF);
    if (add && add.length >= Math.ceil(vol / 2)) {
      const out = new Uint16Array(vol);
      for (let i = 0; i < vol; i++) {
        const hiByte = add[i >> 1] ?? 0;
        const hi4 = (i & 1) ? (hiByte & 0x0F) : (hiByte >> 4);
        out[i] = ((hi4 & 0x0F) << 8) | (b[i] & 0xFF);
      }
      ids = out;
    } else {
      ids = b;
    }

    legacyBlocks = ids;
    legacyData = d;
  }
  else if (fmt === "modern") {
    setDimsFrom(root);
    const vol = volume();

    const palObj = root.Palette || root.BlockStatePalette || {};
    const { arr: palArr, count: palCount } = buildPaletteArray(palObj);
    paletteStr = palArr;

    if (root.BlockStates) {
      const bits = Math.max(4, Math.ceil(Math.log2(Math.max(1, palCount))));
      if (!(root.BlockStates instanceof BigInt64Array)) throw new Error("BlockStates must be long[]");
      blocks = decodePackedBlockStates(root.BlockStates, vol, bits);
    } else if (root.BlockData) {
      const bytes = root.BlockData;
      if (!(bytes instanceof Buffer || bytes instanceof Uint8Array)) throw new Error("BlockData must be ByteArray");
      blocks = decodeLEB128Varints(bytes, vol);
    } else if (root.Blocks || root.Data) {
      const arr = root.Blocks || root.Data;
      if (arr instanceof Int32Array && arr.length === vol) blocks = new Uint32Array(arr);
      else if (arr instanceof Buffer || arr instanceof Uint8Array) blocks = (arr.length===vol)? new Uint32Array(arr) : decodeLEB128Varints(arr, vol);
      else throw new Error("Unsupported Blocks/Data encoding in modern .schem");
    } else {
      throw new Error("No block data found in modern .schem");
    }
  }
  else if (fmt === "states_wrapped") {
    setDimsFrom(root);
    const vol = volume();
    const inner = root.Blocks || {};

    const palObj = inner.Palette || inner.BlockStatePalette || {};
    const { arr: palArr, count: palCount } = buildPaletteArray(palObj);
    paletteStr = palArr;

    if (inner.BlockStates) {
      const count = Math.max(1, palCount);
      const bits = Math.max(4, Math.ceil(Math.log2(count)));
      if (!(inner.BlockStates instanceof BigInt64Array)) throw new Error("Blocks.BlockStates must be long[]");
      blocks = decodePackedBlockStates(inner.BlockStates, vol, bits);
    } else if (inner.BlockData) {
      const bytes = inner.BlockData;
      if (!(bytes instanceof Buffer || bytes instanceof Uint8Array)) throw new Error("Blocks.BlockData must be ByteArray");
      blocks = decodeLEB128Varints(bytes, vol);
    } else if (inner.Data) {
      const arr = inner.Data;
      if (arr instanceof Int32Array && arr.length === vol) blocks = new Uint32Array(arr);
      else if (arr instanceof Buffer || arr instanceof Uint8Array) blocks = (arr.length===vol)? new Uint32Array(arr) : decodeLEB128Varints(arr, vol);
      else throw new Error("Unsupported Blocks.Data encoding in wrapped .schem");
    } else {
      const lowerKeys = Object.keys(inner).filter(k => /block/i.test(k));
      let picked = null;
      for (const k of lowerKeys) {
        const v = inner[k];
        if (v instanceof BigInt64Array) { picked = {type:"BlockStates", v}; break; }
        if (v instanceof Buffer || v instanceof Uint8Array) { picked = {type:"ByteArray", v}; break; }
        if (v instanceof Int32Array) { picked = {type:"IntArray", v}; break; }
      }
      if (!picked) throw new Error("No block arrays found in inner Blocks.");
      if (picked.type === "BlockStates") {
        const bits = Math.max(4, Math.ceil(Math.log2(Math.max(1, palCount))));
        blocks = decodePackedBlockStates(picked.v, vol, bits);
      } else if (picked.type === "ByteArray") {
        blocks = decodeLEB128Varints(picked.v, vol);
      } else if (picked.type === "IntArray") {
        blocks = new Uint32Array(picked.v);
      }
    }
  }
  else {
    const tryGeneric = () => {
      const objs = [root, root.Blocks].filter(Boolean);
      for (const obj of objs) {
        const palObj = obj?.Palette || obj?.BlockStatePalette;
        const anyBlockArray = obj?.BlockStates || obj?.BlockData || obj?.Data;
        if (palObj && anyBlockArray) {
          setDimsFrom(root);
          const vol = volume();
          const { arr: palArr, count: palCount } = buildPaletteArray(palObj);
          paletteStr = palArr;
          if (obj.BlockStates) {
            const bits = Math.max(4, Math.ceil(Math.log2(Math.max(1, palCount))));
            blocks = decodePackedBlockStates(obj.BlockStates, vol, bits);
          } else if (obj.BlockData) {
            const bytes = obj.BlockData;
            blocks = decodeLEB128Varints(bytes, vol);
          } else if (obj.Data) {
            const arr = obj.Data;
            if (arr instanceof Int32Array && arr.length===vol) blocks = new Uint32Array(arr);
            else if (arr instanceof Buffer || arr instanceof Uint8Array) blocks = (arr.length===vol)? new Uint32Array(arr) : decodeLEB128Varints(arr, vol);
          }
          return true;
        }
      }
      return false;
    };
    if (!tryGeneric()) throw new Error("Unknown/unsupported schematic format (no palette/block arrays found)");
  }

  console.log(`Detected schematic type: ${fmt}`);
  console.log(`Dims: ${width}x${height}x${length}  Volume=${(width|0)*(height|0)*(length|0)}`);

  const coordFn = coordsXZY;
  const indexFn = indexXZY;
  return { width, height, length, type: fmt, order: "XZY", coordFn, indexFn,
           legacyBlocks, legacyData, blocks, paletteStr };
}

// ---------- naming helpers ----------
function isAirName(n){ return n==="minecraft:air" || n==="minecraft:cave_air" || n==="minecraft:void_air"; }

function translateBlock(javaBlock) {
  if (!javaBlock) return null;
  if (typeof javaBlock === "object") javaBlock = buildStateName(javaBlock);
  if (typeof javaBlock !== "string") javaBlock = String(javaBlock);

  let [namePart, stateStr] = javaBlock.split("[");
  let blockName = normalizeNamespace(namePart);

  if (isAir(blockName) || INVALID_BLOCKS.has(blockName)) return null;

  const mapEntry =
    javaToBedrockMap[blockName] ??
    javaToBedrockMap[blockName.replace(/^minecraft:/, "")] ??
    null;

  const javaStates = {};
  if (stateStr) {
    stateStr = stateStr.replace(/\]$/, "");
    if (stateStr.length) {
      for (const part of stateStr.split(",")) {
        const [k, v] = part.split("=");
        if (k) javaStates[k] = v;
      }
    }
  }

  if (mapEntry?.defaults) {
    for (const [k, v] of Object.entries(mapEntry.defaults)) {
      if (javaStates[k] === undefined) javaStates[k] = String(v);
    }
  }
  if (mapEntry?.removals) for (const key of mapEntry.removals) delete javaStates[key];
  if (mapEntry?.tile_extra) for (const javaKey of Object.values(mapEntry.tile_extra)) delete javaStates[javaKey];

  // identifier + nested mapping
  let bedrockName = null;
  if (mapEntry?.mapping && mapEntry.identifier) {
    const idKeys = Array.isArray(mapEntry.identifier) ? mapEntry.identifier : [mapEntry.identifier];
    let node = mapEntry.mapping;
    for (const key of idKeys) {
      const val = javaStates[key];
      if (val !== undefined && node[val] !== undefined) node = node[val];
      else if (node.def !== undefined) node = node.def;
      else { node = null; break; }
    }
    if (node) {
      if (typeof node === "string") {
        bedrockName = normalizeNamespace(node);
      } else if (isObj(node)) {
        bedrockName = normalizeNamespace(node.name || buildStateName(node));
        if (node.additions) mapEntry.additions = { ...(mapEntry.additions ?? {}), ...node.additions };
        if (node.removals)  mapEntry.removals  = [ ...(mapEntry.removals  ?? []), ...node.removals ];
        if (node.renames)   mapEntry.renames   = { ...(mapEntry.renames   ?? {}), ...node.renames };
        if (node.remaps)    mapEntry.remaps    = { ...(mapEntry.remaps    ?? {}), ...node.remaps  };
      }
    }
    for (const key of idKeys) delete javaStates[key];
  }

  if (!bedrockName && mapEntry?.name) bedrockName = normalizeNamespace(mapEntry.name);
  if (!bedrockName) bedrockName = blockName;

  const bedrockStates = [];
  for (const [jKey, jValRaw] of Object.entries(javaStates)) {
    const renamedKey = (mapEntry?.renames && mapEntry.renames[jKey]) || jKey;
    let value = jValRaw;
    const remapSpec = mapEntry?.remaps?.[renamedKey] ?? mapEntry?.remaps?.[jKey];
    if (remapSpec !== undefined) {
      if (Array.isArray(remapSpec)) {
        const idx = Number(value);
        if (Number.isFinite(idx) && remapSpec[idx] !== undefined) value = remapSpec[idx];
      } else if (isObj(remapSpec) && remapSpec[value] !== undefined) {
        value = remapSpec[value];
      }
    }
    const valStr = isNumericOrBoolean(value) ? String(value) : `"${value}"`;
    bedrockStates.push(`"${renamedKey}"=${valStr}`);
  }
  if (mapEntry?.additions) {
    for (const [k, v] of Object.entries(mapEntry.additions)) {
      const valStr = isNumericOrBoolean(v) ? String(v) : `"${v}"`;
      bedrockStates.push(`"${k}"=${valStr}`);
    }
  }
  if (bedrockStates.length) bedrockName += `[${bedrockStates.join(",")}]`;

  if (typeof bedrockName === "object") bedrockName = buildStateName(bedrockName);
  if (typeof bedrockName !== "string") bedrockName = String(bedrockName);

  // Post-translation filter (handles anything mapped to an invalid target)
  const outNameOnly = normalizeNamespace(bedrockName.split("[")[0]);
  if (isAir(outNameOnly) || INVALID_BLOCKS.has(outNameOnly)) return null;

  return bedrockName;
}

// ---------- merge helpers ----------
function makeMergeKeyGetter(schem){
  const { type } = schem;
  const paletteToBedrock = new Map(); // palette index -> bedrock (no namespace) | null
  const classicToBedrock = new Map(); // "id:dv" -> bedrock | null

  const sanitize = (n) => (n && n.startsWith("minecraft:")) ? n.slice(10) : n;

  if (type === "classic") {
    const blocks = schem.legacyBlocks;
    const data = schem.legacyData;
    return function(i){
      const id = blocks[i];
      const dv = data[i] ?? 0;
      const key = `${id}:${dv}`;
      if (classicToBedrock.has(key)) return classicToBedrock.get(key);
      const javaName = legacyMap[key] ?? legacyMap[`${id}:0`] ?? "minecraft:air";
      if (isAirName(javaName)) { classicToBedrock.set(key, null); return null; }
      const br = translateBlock(javaName);
      const out = isAir(br ?? "") ? null : sanitize(br);
      classicToBedrock.set(key, out);
      return out;
    };
  } else {
    const blocks = schem.blocks;           // Uint32Array indices
    const palette = schem.paletteStr || []; // index -> name
    return function(i){
      const p = blocks[i] >>> 0;
      if (paletteToBedrock.has(p)) return paletteToBedrock.get(p);
      const javaName = palette[p] || "minecraft:air";
      if (isAirName(javaName)) { paletteToBedrock.set(p, null); return null; }
      const br = translateBlock(javaName);
      const out = isAir(br ?? "") ? null : sanitize(br);
      paletteToBedrock.set(p, out);
      return out;
    };
  }
}

function findOrigin(schem){
  const { width:w, height:h, length:l } = schem;
  const getKeyAt = makeMergeKeyGetter(schem);
  let origin = null;
  let minZ = Infinity, minX = Infinity, minY = Infinity;
  for(let i=0;i<w*h*l;i++){
    const key = getKeyAt(i);
    if(!key) continue;
    const [x,y,z] = coordsXZY(i, w, h, l);
    if( z < minZ || (z===minZ && x<minX) || (z===minZ && x===minX && y<minY) ){
      minZ=z; minX=x; minY=y; origin={x,y,z};
    }
  }
  return origin || {x:0,y:0,z:0};
}

async function dumpSetblockCommands(schem, outPath) {
  const stream = fs.createWriteStream(outPath, { flags: "w" });
  const { width:w, height:h, length:l } = schem;

  const origin = findOrigin(schem);
  console.log("Chosen origin (min corner):", origin);

  const visited = new Uint8Array(w*h*l);
  const getKeyAt = makeMergeKeyGetter(schem);
  let total = 0;

  const sameKey = (i0, i1) => {
    const k0 = getKeyAt(i0);
    if (!k0) return false;
    return k0 === getKeyAt(i1);
  };

  for (let i = 0; i < visited.length; i++) {
    if (visited[i]) continue;
    const k0 = getKeyAt(i);
    if (!k0) { visited[i]=1; continue; }

    const [x0,y0,z0] = coordsXZY(i, w, h, l);
    let x1=x0, y1=y0, z1=z0;

    // expand X
    while (x1 + 1 < w) {
      const j = indexXZY(x1 + 1, y0, z0, w, h, l);
      if (visited[j] || !sameKey(i, j)) break;
      x1++;
    }
    // expand Z
    outerZ: while (z1 + 1 < l) {
      for (let xi = x0; xi <= x1; xi++) {
        const j = indexXZY(xi, y0, z1 + 1, w, h, l);
        if (visited[j] || !sameKey(i, j)) break outerZ;
      }
      z1++;
    }
    // expand Y
    outerY: while (y1 + 1 < h) {
      for (let zi = z0; zi <= z1; zi++) {
        for (let xi = x0; xi <= x1; xi++) {
          const j = indexXZY(xi, y1 + 1, zi, w, h, l);
          if (visited[j] || !sameKey(i, j)) break outerY;
        }
      }
      y1++;
    }

    // mark visited
    for (let zz = z0; zz <= z1; zz++) {
      for (let yy = y0; yy <= y1; yy++) {
        let base = indexXZY(x0, yy, zz, w, h, l);
        for (let xx = x0; xx <= x1; xx++, base++) visited[base] = 1;
      }
    }

    const rx1 = x0 - origin.x + 1, ry1 = y0 - origin.y + 1, rz1 = z0 - origin.z + 1;
    const rx2 = x1 - origin.x + 1, ry2 = y1 - origin.y + 1, rz2 = z1 - origin.z + 1;

    if (rx1 === rx2 && ry1 === ry2 && rz1 === rz2) {
      stream.write(`setblock ~${rx1} ~${ry1} ~${rz1} ${k0}\n`);
    } else {
      stream.write(`fill ~${rx1} ~${ry1} ~${rz1} ~${rx2} ~${ry2} ~${rz2} ${k0}\n`);
    }
    total++;
  }

  await new Promise((resolve, reject) => {
    stream.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  console.log(`Wrote ${total} commands to ${outPath}`);
}

// ---------- pack build helpers ----------
function uuid() { return crypto.randomUUID(); }

async function buildPack(commandsFile, packName) {
  const baseZip = path.join(path.dirname(import.meta.url.replace('file://', '')), "pack_base.zip");
  const workDir = "pack_work";
  const functionsDir = path.join(workDir, "functions");
  const manifestPath = path.join(workDir, "manifest.json");
  const builderPath = path.join(workDir, "scripts", "builder.js");

  fs.rmSync(workDir, { recursive: true, force: true });

  const zipBase = new AdmZip(baseZip);
  zipBase.extractAllTo(workDir, true);

  const rl = readline.createInterface({
    input: fs.createReadStream(commandsFile, "utf8"),
    crlfDelay: Infinity,
  });
  const MAX_LINES = 10000;
  fs.mkdirSync(functionsDir, { recursive: true });

  let fileCount = 0;
  let buffer = [];
  for await (const line of rl) {
    if (!line) continue;
    buffer.push(line);
    if (buffer.length === MAX_LINES) {
      fileCount++;
      const outFile = path.join(functionsDir, `function_part_${fileCount}.mcfunction`);
      fs.writeFileSync(outFile, buffer.join("\n"));
      buffer.length = 0;
    }
  }
  if (buffer.length) {
    fileCount++;
    const outFile = path.join(functionsDir, `function_part_${fileCount}.mcfunction`);
    fs.writeFileSync(outFile, buffer.join("\n"));
  }
  console.log(`Split into ${fileCount} .mcfunction files`);

  const builderJS = fs.readFileSync(builderPath, "utf8").replace(
    /const\s+MAX_FUNCTIONS\s*=\s*\d+\s*;/,
    `const MAX_FUNCTIONS = ${fileCount};`
  );
  fs.writeFileSync(builderPath, builderJS);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.header.name = packName;
  manifest.header.uuid = uuid();
  if (Array.isArray(manifest.modules)) manifest.modules.forEach(m => m.uuid = uuid());
  if (manifest.metadata?.generated_with && Array.isArray(manifest.metadata.generated_with)) {
    manifest.metadata.generated_with.forEach(e => e.uuid = uuid());
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Sanitize pack name for filename
  const sanitizedPackName = packName.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
  const outPack = path.resolve(`${sanitizedPackName}.mcpack`);
  const outZip = new AdmZip();
  outZip.addLocalFolder(workDir);
  outZip.writeZip(outPack);

  console.log(`Built ${outPack}`);

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(commandsFile, { force: true });
}

// Export functions for use by the API
export { loadSchematic, dumpSetblockCommands, buildPack };
