export interface DockerVolumeBind {
  source: string;
  target: string;
  mode?: string;
}

function normalizeContainerPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/, '');
}

export function parseDockerVolumeBind(bind: string): DockerVolumeBind | null {
  const parts = bind.split(':');
  if (parts.length === 1 && bind.startsWith('/')) {
    return { source: '', target: normalizeContainerPath(bind) };
  }
  if (parts.length < 2) return null;
  const [source, target, ...modeParts] = parts;
  if (!source || !target) return null;
  return {
    source,
    target: normalizeContainerPath(target),
    mode: modeParts.length > 0 ? modeParts.join(':') : undefined,
  };
}

export function bindTargetsContainerPath(
  bind: string,
  containerPath: string,
): boolean {
  const parsed = parseDockerVolumeBind(bind);
  if (!parsed) return false;
  const target = normalizeContainerPath(parsed.target);
  const base = normalizeContainerPath(containerPath);
  return target === base || target.startsWith(`${base}/`);
}

export function containerPathsOverlap(left: string, right: string): boolean {
  const a = normalizeContainerPath(left);
  const b = normalizeContainerPath(right);
  return (
    a === b ||
    a === '/' ||
    b === '/' ||
    a.startsWith(`${b}/`) ||
    b.startsWith(`${a}/`)
  );
}
