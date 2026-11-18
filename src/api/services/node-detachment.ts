/** Compile-time proof that a VM's Node disposition was handled before `endVm`. */
declare const detachment: unique symbol;

export interface NodeDetached {
  readonly [detachment]: true;
}

function detached(): NodeDetached {
  const proof = {};
  return proof as NodeDetached;
}

/** The Node object was deleted from the cluster. */
export function nodeDeleted(): NodeDetached {
  return detached();
}

/** No Node object was observed for this VM at finalization. */
export function nodeNotObserved(): NodeDetached {
  return detached();
}

/** Node deletion failed after its error was recorded for forced removal. */
export function nodeDeletionForced(_recordedError: string): NodeDetached {
  return detached();
}
