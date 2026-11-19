export type TextEdit = {
  old: string;
  new: string;
};

export type ChangeHunk = TextEdit & {
  id: string;
  status: 'pending' | 'accepted' | 'rejected';
};

export type PendingFile = {
  path: string;
  created: boolean;
  originalContent: string;
  proposedContent: string;
  hunks: readonly ChangeHunk[];
};

export class ChangeSetError extends Error {}

/**
 * In-memory proposed edits. This class deliberately has no filesystem API: only
 * the later review flow may apply accepted hunks to a workspace.
 */
export class ChangeSet {
  private readonly files = new Map<string, PendingFile>();
  private nextHunkId = 1;

  queueEdits(path: string, diskContent: string, edits: readonly TextEdit[]): readonly ChangeHunk[] {
    if (edits.length === 0) {
      throw new ChangeSetError('At least one edit is required.');
    }

    const pending = this.files.get(path);
    if (pending?.created) {
      throw new ChangeSetError(`Cannot replace text in new file ${path}; replace its content in a new proposal.`);
    }

    let proposedContent = pending?.proposedContent ?? diskContent;
    const hunks: ChangeHunk[] = [];
    for (const edit of edits) {
      if (edit.old.length === 0) {
        throw new ChangeSetError('Each edit.old value must be non-empty. Use create: true to create a file.');
      }

      const matches = countOccurrences(proposedContent, edit.old);
      if (matches !== 1) {
        const closest = closestMatchLine(proposedContent, edit.old);
        throw new ChangeSetError(
          `Edit in ${path} must match exactly once; it matched ${matches} times. ${closest}`
        );
      }

      proposedContent = proposedContent.replace(edit.old, edit.new);
      hunks.push({ id: `hunk-${this.nextHunkId++}`, ...edit, status: 'pending' });
    }

    const mergedHunks = [...(pending?.hunks ?? []), ...hunks];
    this.files.set(path, {
      path,
      created: false,
      originalContent: pending?.originalContent ?? diskContent,
      proposedContent,
      hunks: mergedHunks
    });
    return hunks;
  }

  queueNewFile(path: string, content: string): ChangeHunk {
    if (this.files.has(path)) {
      throw new ChangeSetError(`${path} already has queued changes.`);
    }

    const hunk: ChangeHunk = {
      id: `hunk-${this.nextHunkId++}`,
      old: '',
      new: content,
      status: 'pending'
    };
    this.files.set(path, {
      path,
      created: true,
      originalContent: '',
      proposedContent: content,
      hunks: [hunk]
    });
    return hunk;
  }

  getFile(path: string): PendingFile | undefined {
    return this.files.get(path);
  }

  listFiles(): readonly PendingFile[] {
    return [...this.files.values()];
  }

  pendingHunkCount(): number {
    return [...this.files.values()].reduce((count, file) => count + file.hunks.length, 0);
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function closestMatchLine(text: string, wanted: string): string {
  const wantedLine = wanted.split(/\r?\n/, 1)[0];
  const lines = text.split(/\r?\n/);
  let bestLine = 0;
  let bestScore = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const score = sharedPrefixLength(lines[index], wantedLine);
    if (score > bestScore) {
      bestScore = score;
      bestLine = index;
    }
  }

  const preview = lines[bestLine]?.slice(0, 200) ?? '(file is empty)';
  return `Closest match starts at line ${bestLine + 1}: ${preview}`;
}

function sharedPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}
