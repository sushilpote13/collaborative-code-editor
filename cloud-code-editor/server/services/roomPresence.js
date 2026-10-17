const presenceTimeoutMs = 35_000;
const rooms = new Map();

function removeExpiredMembers(now = Date.now()) {
  for (const [roomId, members] of rooms) {
    for (const [userId, member] of members) {
      if (member.socketIds.size === 0 && now - member.lastSeenAt > presenceTimeoutMs) {
        members.delete(userId);
      }
    }
    if (members.size === 0) {
      rooms.delete(roomId);
    }
  }
}

export function updateRoomMember(roomId, member) {
  const now = Date.now();
  removeExpiredMembers(now);
  let members = rooms.get(roomId);
  if (!members) {
    members = new Map();
    rooms.set(roomId, members);
  }

  const existing = members.get(member.id);
  members.set(member.id, {
    ...member,
    joinedAt: existing?.joinedAt ?? now,
    lastSeenAt: now,
    socketIds: existing?.socketIds ?? new Set(),
  });

  return listRoomMembers(roomId, now);
}

export function connectRoomMember(roomId, member, socketId) {
  updateRoomMember(roomId, member);
  const roomMembers = rooms.get(roomId);
  const existing = roomMembers.get(member.id);
  const joined = existing.socketIds.size === 0;
  existing.socketIds.add(socketId);
  existing.lastSeenAt = Date.now();

  return { joined, members: listRoomMembers(roomId) };
}

export function disconnectRoomMember(roomId, userId, socketId) {
  const members = rooms.get(roomId);
  const member = members?.get(userId);
  if (!member || !member.socketIds.delete(socketId)) {
    return { left: null, members: listRoomMembers(roomId) };
  }

  member.lastSeenAt = Date.now();
  let left = null;
  if (member.socketIds.size === 0) {
    members.delete(userId);
    left = {
      id: member.id,
      username: member.username,
      firstName: member.firstName,
      lastName: member.lastName,
    };
  }
  if (members.size === 0) {
    rooms.delete(roomId);
  }

  return { left, members: listRoomMembers(roomId) };
}

export function listRoomMembers(roomId, now = Date.now()) {
  removeExpiredMembers(now);
  return [...(rooms.get(roomId)?.values() ?? [])]
    .map(({ id, username, firstName, lastName, joinedAt }) => ({
      id,
      username,
      firstName,
      lastName,
      joinedAt,
    }))
    .sort((first, second) => first.joinedAt - second.joinedAt);
}
