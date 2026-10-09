import * as THREE from 'three';

export interface TaperOpts {
  /** Scale of the top face (x, z). */
  top?: [number, number];
  /** Scale of the bottom face (x, z). */
  bottom?: [number, number];
  /** Offset of the top face (x, z) — shears the part. */
  shiftTop?: [number, number];
  shiftBottom?: [number, number];
  /** Where the origin sits: 'top' hangs the part below its pivot (limbs), 'bottom' stands it on it. */
  anchor?: 'center' | 'top' | 'bottom';
}

// Outward-facing CCW triangles of a hexahedron: bottom 0-3, top 4-7.
const BOX_TRIS = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 3, 2, 6, 3, 6, 7, 1, 0, 4, 1, 4, 5, 2, 1, 5, 2, 5, 6, 0, 3, 7, 0, 7, 4];

/** A box whose top and bottom faces can be scaled and offset independently — the building block of every mech. */
export function taperBox(w: number, h: number, d: number, o: TaperOpts = {}) {
  const [tx, tz] = o.top ?? [1, 1];
  const [bx, bz] = o.bottom ?? [1, 1];
  const [stx, stz] = o.shiftTop ?? [0, 0];
  const [sbx, sbz] = o.shiftBottom ?? [0, 0];
  const hw = w / 2;
  const hh = h / 2;
  const hd = d / 2;
  const v = [
    [-hw * bx + sbx, -hh, -hd * bz + sbz],
    [hw * bx + sbx, -hh, -hd * bz + sbz],
    [hw * bx + sbx, -hh, hd * bz + sbz],
    [-hw * bx + sbx, -hh, hd * bz + sbz],
    [-hw * tx + stx, hh, -hd * tz + stz],
    [hw * tx + stx, hh, -hd * tz + stz],
    [hw * tx + stx, hh, hd * tz + stz],
    [-hw * tx + stx, hh, hd * tz + stz],
  ];
  const pos = new Float32Array(BOX_TRIS.length * 3);
  BOX_TRIS.forEach((vi, i) => {
    pos[i * 3] = v[vi][0];
    pos[i * 3 + 1] = v[vi][1];
    pos[i * 3 + 2] = v[vi][2];
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dy = o.anchor === 'top' ? -hh : o.anchor === 'bottom' ? hh : 0;
  if (dy) g.translate(0, dy, 0);
  g.computeVertexNormals();
  return g;
}

/** Faceted cylinder/cone. `axis` picks the direction its length runs along. */
export function prism(rTop: number, rBottom: number, h: number, sides = 8, axis: 'y' | 'z' = 'y', anchor: 'center' | 'start' = 'center') {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, sides, 1);
  if (anchor === 'start') g.translate(0, h / 2, 0);
  // +Y -> +Z
  if (axis === 'z') g.rotateX(Math.PI / 2);
  return g;
}

export interface PartOpts {
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
}

/** Create a mesh, place it, and parent it in one go. */
export function part(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, o: PartOpts = {}) {
  const m = new THREE.Mesh(geo, mat);
  if (o.pos) m.position.set(o.pos[0], o.pos[1], o.pos[2]);
  if (o.rot) m.rotation.set(o.rot[0], o.rot[1], o.rot[2]);
  if (o.scale) m.scale.set(o.scale[0], o.scale[1], o.scale[2]);
  parent.add(m);
  return m;
}

/** Create an empty pivot node. */
export function pivot(parent: THREE.Object3D, x = 0, y = 0, z = 0, name = '') {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.name = name;
  parent.add(g);
  return g;
}
