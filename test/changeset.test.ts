import { describe, expect, it } from 'vitest';
import { ChangeSet, ChangeSetError } from '../src/changes/changeset';

describe('ChangeSet', () => {
  it('queues exact replacements without mutating its source string', () => {
    const source = 'one\ntwo\n';
    const changes = new ChangeSet();

    changes.queueEdits('sample.txt', source, [{ old: 'two', new: 'three' }]);

    expect(source).toBe('one\ntwo\n');
    expect(changes.getFile('sample.txt')?.proposedContent).toBe('one\nthree\n');
    expect(changes.pendingHunkCount()).toBe(1);
  });

  it('rejects replacements that do not match exactly once with a useful location', () => {
    const changes = new ChangeSet();

    expect(() => changes.queueEdits('sample.txt', 'same\nsame\n', [{ old: 'same', new: 'new' }]))
      .toThrowError(ChangeSetError);
    expect(() => changes.queueEdits('sample.txt', 'first\nsecond\n', [{ old: 'missing', new: 'new' }]))
      .toThrow('Closest match starts at line');
  });

  it('keeps new files in memory', () => {
    const changes = new ChangeSet();
    changes.queueNewFile('new.txt', 'contents');

    expect(changes.getFile('new.txt')).toMatchObject({ created: true, proposedContent: 'contents' });
  });
});
