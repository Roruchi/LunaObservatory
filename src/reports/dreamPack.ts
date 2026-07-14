import type { LunaObsPaths } from "../fs/paths.js";
import type { InefficiencyScore } from "../scoring/score.js";
import { prepareDreamPacket, selectDreamSessions, writePreparedDreamPacket } from "../dream/prepare.js";

export { selectDreamSessions };

export function writeDreamPack(paths: LunaObsPaths, _scores: InefficiencyScore[], top = 5): ReturnType<typeof prepareDreamPacket> {
  const packet = prepareDreamPacket(paths.lunaobs, top);
  writePreparedDreamPacket(packet, paths.dream);
  return packet;
}
