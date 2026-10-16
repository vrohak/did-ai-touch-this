/** A file an apply_patch patch adds, updates or deletes; an update can also move it. */
export interface PatchedFile {
  path: string;
  op: 'add' | 'update' | 'delete';
  moveTo?: string;
}

/** The files a Codex apply_patch patch (`*** Begin Patch` … `*** End Patch`) names. */
export function patchedFiles(patch: string): PatchedFile[] {
  const files: PatchedFile[] = [];
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/.exec(line);
    if (m) {
      files.push({ path: m[2]!, op: m[1]!.toLowerCase() as PatchedFile['op'] });
      continue;
    }
    const move = /^\*\*\* Move to: (.+?)\s*$/.exec(line);
    const last = files[files.length - 1];
    if (move && last) last.moveTo = move[1]!;
  }
  return files;
}
