import { renameSync, rmSync, writeFileSync } from 'node:fs';

let writeSequence = 0;

/** Write UTF-8 text through a sibling file so readers never see partial data. */
export function writeTextFileAtomicSync(
  path: string,
  contents: string,
  options: { mode?: number } = {},
): void {
  const temporaryPath = `${path}.tmp.${process.pid}.${writeSequence++}`;
  let renamed = false;
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: 'utf8',
      mode: options.mode,
    });
    renameSync(temporaryPath, path);
    renamed = true;
  } finally {
    if (!renamed) rmSync(temporaryPath, { force: true });
  }
}
