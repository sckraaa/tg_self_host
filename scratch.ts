// scratch to test TS
import { BinaryWriter } from './self_hosted_version/src/mtproto/binary';
import { writeTlString } from './self_hosted_version/src/mtproto/builders';

export function buildUpdateShortMessage(
  out: boolean,
  id: number,
  userId: number,
  message: string,
  pts: number,
  ptsCount: number,
  date: number
): Buffer {
  const w = new BinaryWriter();
  // updateShortMessage#313bc7f8
  w.writeInt(0x313bc7f8);

  let flags = 0;
  if (out) flags |= (1 << 1);
  w.writeInt(flags);

  w.writeInt(id);
  w.writeLong(BigInt(userId));
  writeTlString(w, message);
  w.writeInt(pts);
  w.writeInt(ptsCount);
  w.writeInt(date);

  return w.getBytes();
}
