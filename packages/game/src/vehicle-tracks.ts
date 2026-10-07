import { Vec3, v3 } from '@tvox/core';

export interface VehicleTrack {
  center: Vec3;
  radius: number;
  halfStraight: number;
  width: number;
  travel: number;
  visible: boolean;
}

/** Беговая лента обходит опорное шасси; её фаза зависит от пути каждой стороны. */
export function buildVehicleTracks(kind: string, size: number): VehicleTrack[] {
  if (kind !== 'bulldozer' && kind !== 'excavator') return [];
  const dozer = kind === 'bulldozer';
  return [dozer ? 4.5 : 3.5, dozer ? 29.5 : 24.5].map(z => ({
    center: v3((dozer ? -3.5 : -3) * size, (dozer ? 4 : 3) * size,
      (z - (dozer ? 17 : 14)) * size),
    radius: (dozer ? 4 : 3) * size, halfStraight: (dozer ? 19.5 : 19) * size,
    width: (dozer ? 7 : 5) * size, travel: 0, visible: true,
  }));
}
