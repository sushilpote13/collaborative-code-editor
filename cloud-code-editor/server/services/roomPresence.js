const presenceTimeoutMs = 35_000;
const rooms = new Map();

function removeExpiredMembers(now = Date.now()) {
  for (const [roomId, members] of rooms) {
    for (const [userId, member] of members) {
      if (now - member.lastSeenAt > presenceTimeoutMs) {
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
  });

  return listRoomMembers(roomId, now);
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
