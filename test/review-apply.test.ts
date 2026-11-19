import { describe, expect, it } from 'vitest';
import { ChangeSet } from '../src/changes/changeset';
import { acceptedContent, filePatch } from '../src/review/apply';
describe('review application', () => { it('applies only accepted hunks', () => { const set = new ChangeSet(); const [first, second, third] = set.queueEdits('a.txt', 'one\ntwo\nthree\n', [{ old: 'one', new: 'ONE' }, { old: 'two', new: 'TWO' }, { old: 'three', new: 'THREE' }]); set.setHunkStatus('a.txt', first.id, 'accepted'); set.setHunkStatus('a.txt', second.id, 'rejected'); set.setHunkStatus('a.txt', third.id, 'accepted'); const file = set.getFile('a.txt')!; expect(acceptedContent(file)).toBe('ONE\ntwo\nTHREE\n'); expect(filePatch(file).hunks.length).toBeGreaterThan(0); }); });
