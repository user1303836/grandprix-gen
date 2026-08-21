/**
 * A simple stylized race car that laps the circuit following the speed
 * profile. Low-poly but readable: floor + body + cabin + wing + wheels.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
} from "three";

export function buildCar(color = 0x2a52c8): Group {
  const car = new Group();
  const paint = new MeshStandardMaterial({ color, roughness: 0.25, metalness: 0.55 });
  const dark = new MeshStandardMaterial({ color: 0x14161a, roughness: 0.6 });
  const chrome = new MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.3, metalness: 0.8 });

  // floor
  const floor = new Mesh(new BoxGeometry(2.0, 0.14, 4.6), dark);
  floor.position.y = 0.18;
  car.add(floor);
  // main body
  const body = new Mesh(new BoxGeometry(1.85, 0.52, 4.2), paint);
  body.position.y = 0.5;
  car.add(body);
  // nose taper
  const nose = new Mesh(new BoxGeometry(1.5, 0.4, 1.1), paint);
  nose.position.set(0, 0.42, -2.5);
  nose.rotation.x = 0.08;
  car.add(nose);
  // cabin
  const cabin = new Mesh(new BoxGeometry(1.05, 0.42, 1.5), dark);
  cabin.position.set(0, 0.94, 0.35);
  car.add(cabin);
  // halo
  const halo = new Mesh(new BoxGeometry(0.09, 0.3, 1.5), chrome);
  halo.position.set(0, 1.2, 0.35);
  car.add(halo);
  // rear wing
  const wing = new Mesh(new BoxGeometry(1.7, 0.08, 0.7), paint);
  wing.position.set(0, 1.05, 2.1);
  wing.rotation.x = -0.12;
  car.add(wing);
  for (const sx of [-0.7, 0.7]) {
    const strut = new Mesh(new BoxGeometry(0.08, 0.5, 0.08), dark);
    strut.position.set(sx, 0.82, 2.1);
    car.add(strut);
  }
  // wheels
  const wheelGeo = new CylinderGeometry(0.34, 0.34, 0.4, 12);
  for (const [wx, wz] of [
    [-0.95, -1.45],
    [0.95, -1.45],
    [-0.95, 1.45],
    [0.95, 1.45],
  ]) {
    const wheel = new Mesh(wheelGeo, dark);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.34, wz);
    car.add(wheel);
  }
  car.traverse((o) => {
    if (o instanceof Mesh) o.castShadow = true;
  });
  return car;
}
