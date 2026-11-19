import { structuredPatch } from 'diff';
import type { ChangeHunk, PendingFile } from '../changes/changeset';

export function proposedContent(file: PendingFile): string {
  return applyHunks(file.originalContent, file.hunks.filter((hunk) => hunk.status !== 'rejected'));
}

export function acceptedContent(file: PendingFile): string {
  return applyHunks(file.originalContent, file.hunks.filter((hunk) => hunk.status === 'accepted'));
}

export function applyHunks(original: string, hunks: readonly ChangeHunk[]): string {
  let result = original;
  for (const hunk of hunks) {
    if (!hunk.old) { result += hunk.new; continue; }
    const first = result.indexOf(hunk.old);
    if (first < 0 || result.indexOf(hunk.old, first + hunk.old.length) >= 0) continue;
    result = `${result.slice(0, first)}${hunk.new}${result.slice(first + hunk.old.length)}`;
  }
  return result;
}

export function filePatch(file: PendingFile): ReturnType<typeof structuredPatch> {
  return structuredPatch(file.path, file.path, file.originalContent, proposedContent(file));
}
