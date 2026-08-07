/**
 * What the app says when the microphone will not cooperate.
 *
 * The pipe and the tuner both ask for the microphone, both can be refused, and
 * both had their own copy of these three sentences. Identical today, because
 * they were written on the same afternoon — but the whole reason a permission
 * message is worth agonising over is that somebody reads it once, in a hall,
 * already annoyed, and either fixes it or gives up. Two copies is one of them
 * going stale after the next edit.
 *
 * Only the states that mean *the microphone is not available* live here. What
 * each screen says when things are working is genuinely its own business: the
 * pipe says "Blow at the bottom of your phone", the tuner says nothing at all,
 * and flattening that into a shared table would be tidiness at the cost of
 * saying the right thing.
 */
export const MIC_TEXT = {
  requesting: 'Asking for the microphone…',
  denied: 'Microphone blocked. Allow it in your browser settings.',
  error: 'Microphone unavailable.',
} as const
