import { Mat, Quat, Simulation, Transform, Vec3, clamp, inverseTransformPoint, quatFromAxisAngle,
  quatFromEulerYXZ, quatMultiply, rotateVec, transformPoint, v3 } from '@tvox/core';

export interface VehicleSupportPoint extends Vec3 {
  /** Нижний контур колеса относительно оси: край шины встречает рампу раньше её центра. */
  probes?: readonly Vec3[];
}

export interface VehicleSupport {
  height: number;
  pitch: number;
  roll: number;
  stable: boolean;
  contacts: Vec3[];
}

export function vehicleOrientation(yaw: number, pitch: number, roll: number): Quat {
  return quatMultiply(quatFromEulerYXZ(yaw + Math.PI / 2, 0),
    quatMultiply(quatFromAxisAngle(v3(0, 0, 1), pitch), quatFromAxisAngle(v3(1, 0, 0), roll)));
}

/** Лучи идут от колёс/гусениц через весь путь падения, а не из-под уже пробитого пола. */
export function vehicleSupport(sim: Simulation, pose: Transform, yaw: number, points: VehicleSupportPoint[], fall: number): VehicleSupport {
  const ignore = new Set<number>();
  for (const body of sim.world.bodies.values()) if (body.tags.has('vehicle') || body.tags.has('truck-load')) ignore.add(body.id);
  const levelPose = { position: pose.position, rotation: quatFromEulerYXZ(yaw + Math.PI / 2, 0) };
  const contacts: Vec3[] = [];
  for (const point of points) {
    const foot = transformPoint(pose, point);
    let best = -Infinity;
    for (const probe of point.probes ?? [v3()]) {
      const offset = rotateVec(pose.rotation, probe);
      const p = v3(foot.x + offset.x, foot.y + offset.y + 0.4, foot.z + offset.z);
      const hit = sim.world.raycast(p, v3(0, -1, 0), {
        maxDistance: 0.8 + Math.max(0, fall), ignore,
        filter: mat => mat !== Mat.Water && mat !== Mat.Paint,
      });
      if (hit && hit.normal.y >= 0.35) best = Math.max(best, hit.point.y - offset.y);
    }
    if (Number.isFinite(best)) contacts.push(inverseTransformPoint(levelPose, v3(foot.x, best, foot.z)));
  }
  if (contacts.length < 3) return { height: -Infinity, pitch: 0, roll: 0, stable: false, contacts };
  // Плоскость y = ax + bz + c: обычный МНК по фактическим точкам опоры.
  const matrix = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (const p of contacts) {
    const row = [p.x, p.z, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) matrix[i][j] += row[i] * row[j];
      matrix[i][3] += row[i] * p.y;
    }
  }
  for (let i = 0; i < 3; i++) {
    const pivot = [0, 1, 2].slice(i).sort((a, b) => Math.abs(matrix[b][i]) - Math.abs(matrix[a][i]))[0];
    [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
    const divisor = matrix[i][i];
    if (Math.abs(divisor) < 1e-6) return { height: -Infinity, pitch: 0, roll: 0, stable: false, contacts };
    for (let j = i; j < 4; j++) matrix[i][j] /= divisor;
    for (let k = 0; k < 3; k++) if (k !== i) {
      const factor = matrix[k][i];
      for (let j = i; j < 4; j++) matrix[k][j] -= factor * matrix[i][j];
    }
  }
  const slopeX = Math.abs(matrix[0][3]) < 1e-8 ? 0 : matrix[0][3];
  const slopeZ = Math.abs(matrix[1][3]) < 1e-8 ? 0 : matrix[1][3];
  const pitch = Math.atan(slopeX), roll = -Math.atan(slopeZ / Math.sqrt(1 + slopeX * slopeX));
  // Центр массы должен находиться над многоугольником опоры. Одного
  // заднего моста на краю контейнера недостаточно, чтобы висеть горизонтально.
  const sorted = [...contacts].sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x));
  const stable = sorted.every((p, i) => {
    const q = sorted[(i + 1) % sorted.length];
    return (q.x - p.x) * -p.z - (q.z - p.z) * -p.x >= -0.01;
  }) && Math.abs(pitch) < 0.7 && Math.abs(roll) < 0.6;
  return { height: pose.position.y + matrix[2][3], pitch: clamp(pitch, -1, 1),
    roll: clamp(roll, -1, 1), stable, contacts };
}
