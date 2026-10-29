import assert from 'node:assert/strict';
import test from 'node:test';
import {
  connectRoomMember,
  disconnectRoomMember,
} from '../server/services/roomPresence.js';

test('room presence counts users, not tabs, and removes a user after their last socket leaves', () => {
  const roomId = `presence-${Date.now()}`;
  const member = {
    id: 'user-presence-test',
    username: 'tester',
    firstName: 'Test',
    lastName: 'User',
  };

  const firstJoin = connectRoomMember(roomId, member, 'socket-one');
  const secondJoin = connectRoomMember(roomId, member, 'socket-two');
  assert.equal(firstJoin.joined, true);
  assert.equal(secondJoin.joined, false);
  assert.equal(secondJoin.members.length, 1);

  const firstDisconnect = disconnectRoomMember(roomId, member.id, 'socket-one');
  assert.equal(firstDisconnect.left, null);
  assert.equal(firstDisconnect.members.length, 1);

  const lastDisconnect = disconnectRoomMember(roomId, member.id, 'socket-two');
  assert.equal(lastDisconnect.left.id, member.id);
  assert.deepEqual(lastDisconnect.members, []);
});
