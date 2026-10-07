import { Mat, Transform, Vec3, VoxelShape, quatFromAxisAngle, quatFromEulerYXZ, quatMultiply, rotateVec, sub, v3 } from '@tvox/core';

export interface VehicleWheel {
  shape: VoxelShape;
  center: Vec3;
  radius: number;
  steering: boolean;
  /** Визуальное вращение круглой шины не требует пересборки физических коллайдеров. */
  pose: Transform;
}

export function wheelPose(wheel: VehicleWheel, steering: number, roll: number): Transform {
  const rotation = quatMultiply(quatFromEulerYXZ(wheel.steering ? -steering : 0, 0),
    quatFromAxisAngle(v3(0, 0, 1), -roll));
  const shape = wheel.shape;
  const half = v3(shape.sx * shape.voxelSize / 2, shape.sy * shape.voxelSize / 2, shape.sz * shape.voxelSize / 2);
  return { position: sub(wheel.center, rotateVec(rotation, half)), rotation };
}

export function buildVehicleWheels(kind: 'car' | 'pickup' | 'truck', voxelSize: number, size: Vec3): VehicleWheel[] {
  const diameter = kind === 'car' ? 7 : kind === 'truck' ? 10 : 8;
  const radius = diameter * voxelSize / 2;
  const axle = kind === 'car' ? [8.5, 30.5] : kind === 'truck' ? [13, 27, 81] : [9.5, 36.5];
  const wheels: VehicleWheel[] = [];
  for (const [axleIndex, x] of axle.entries()) for (const z of [1.5, size.z - 1.5]) {
    const shape = new VoxelShape({ sx: diameter, sy: diameter, sz: 3, voxelSize, name: `${kind}-wheel` });
    shape.structural = false;
    for (let y = 0; y < diameter; y++) for (let x = 0; x < diameter; x++) {
      const dx = x + 0.5 - diameter / 2, dy = y + 0.5 - diameter / 2;
      const r = Math.hypot(dx, dy);
      if (r > diameter / 2) continue;
      for (let z = 0; z < 3; z++) {
        shape.set(x, y, z, Mat.Metal);
        const rim = r < diameter * 0.28 && z !== 1;
        const spoke = rim && (Math.abs(dx) < 0.6 || Math.abs(dy) < 0.6);
        const tread = !rim && Math.floor((Math.atan2(dy, dx) + Math.PI) * 8 / Math.PI) % 2 === 0;
        // Светлая метка только в одном секторе делает вращение заметным даже на малой скорости.
        const marker = z !== 1 && dx > 1 && Math.abs(dy) < 0.6;
        const color = marker ? 0xe5bd54 : rim ? (spoke ? 0xc5ced5 : 0x52616e) : tread ? 0x303b44 : 0x141c23;
        shape.paint.set(shape.idx(x, y, z), 0x1000000 | color);
      }
    }
    const center = v3((x - size.x / 2) * voxelSize, radius, (z - size.z / 2) * voxelSize);
    const wheel: VehicleWheel = { shape, center, radius, steering: axleIndex === axle.length - 1,
      pose: { position: v3(), rotation: quatFromEulerYXZ(0, 0) } };
    wheel.pose = wheelPose(wheel, 0, 0);
    shape.transform = { position: { ...wheel.pose.position }, rotation: { ...wheel.pose.rotation } };
    wheels.push(wheel);
  }
  return wheels;
}
