// Пол склада слева от полосы для транспорта: его свет зависит от крыши.
// Пол самой полосы принадлежит ground и освещается другой воксельной формой.
export const WAREHOUSE_LIGHT_PROBE = Object.freeze({
  position: Object.freeze({ x: 12, y: 0.35, z: 22 }),
  yaw: 0,
  pitch: -0.55,
});
