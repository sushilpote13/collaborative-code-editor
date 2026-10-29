import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';

function bytesFromBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function getDisplayName(user) {
  return user.username ? `@${user.username}` : `${user.firstName} ${user.lastName}`;
}

function getUserCursorColor(userId) {
  let hash = 0;
  for (const character of userId) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    color: `hsl(${hue}, 78%, 70%)`,
    colorLight: `hsla(${hue}, 78%, 62%, 0.28)`,
  };
}

export function useCollaborativeRoom(roomId, user) {
  const [session, setSession] = useState(null);
  const [roomState, setRoomState] = useState({
    roomId: null,
    status: 'connecting',
    error: '',
    members: [],
    activity: '',
  });
  const currentRoomState = roomState.roomId === roomId
    ? roomState
    : { roomId, status: 'connecting', error: '', members: [], activity: '' };

  useEffect(() => {
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const socket = io({ autoConnect: false, withCredentials: true });
    let isJoined = false;

    awareness.setLocalStateField('user', {
      id: user.id,
      name: getDisplayName(user),
      ...getUserCursorColor(user.id),
    });
    function updateRoomState(patch) {
      setRoomState((current) => ({
        ...(current.roomId === roomId
          ? current
          : { roomId, status: 'connecting', error: '', members: [], activity: '' }),
        ...patch,
        roomId,
      }));
    }

    function joinRoom() {
      updateRoomState({ status: 'joining' });
      socket.timeout(7000).emit('room:join', { roomId }, (timeoutError, result) => {
        if (timeoutError) {
          updateRoomState({
            status: 'error',
            error: 'The collaboration server did not respond. Check that the API is running.',
          });
          return;
        }
        if (!result?.ok) {
          updateRoomState({
            status: 'error',
            error: result?.error || 'Could not join this room.',
          });
          return;
        }

        try {
          Y.applyUpdate(document, bytesFromBase64(result.state), 'server');
          setSession({ roomId, document, awareness });
          updateRoomState({ members: result.members, status: 'connected', error: '' });
          isJoined = true;
          socket.emit('room:document-update', {
            update: Y.encodeStateAsUpdate(document),
          });
          socket.emit('room:awareness-update', {
            update: encodeAwarenessUpdate(awareness, [document.clientID]),
          });
        } catch (syncError) {
          console.error('Could not synchronize the room workspace:', syncError);
          updateRoomState({
            status: 'error',
            error: 'The room workspace could not be synchronized.',
          });
        }
      });
    }

    function handleDocumentUpdate(payload) {
      const update = toUint8Array(payload?.update);
      if (!update) {
        console.error('Received an invalid remote workspace update.');
        updateRoomState({
          error: 'A workspace update could not be applied. Reconnect to synchronize.',
        });
        return;
      }

      try {
        Y.applyUpdate(document, update, 'remote');
      } catch (syncError) {
        console.error('Could not apply a remote workspace update:', syncError);
        updateRoomState({
          error: 'A workspace update could not be applied. Reconnect to synchronize.',
        });
      }
    }

    function handleAwarenessUpdate(payload) {
      const update = toUint8Array(payload?.update);
      if (!update) {
        console.error('Received an invalid participant update.');
        return;
      }

      try {
        applyAwarenessUpdate(awareness, update, 'remote');
      } catch (syncError) {
        console.error('Could not apply a participant update:', syncError);
      }
    }

    function handleRoomError(payload) {
      updateRoomState({ error: payload?.error || 'A collaboration error occurred.' });
    }

    function handleDisconnect() {
      isJoined = false;
      updateRoomState({ status: 'connecting' });
    }

    async     function handleConnectError(connectError) {
      isJoined = false;
      updateRoomState({
        status: 'error',
        error: connectError.message === 'Authentication required.'
          ? 'Your login session has expired. Log in again to rejoin this workspace.'
          : connectError.message || 'Could not connect to the collaboration server.',
      });
    }

    function handleMembersUpdate(nextMembers) {
      updateRoomState({ members: nextMembers });
    }

    function handleParticipantJoined(participant) {
      updateRoomState({ activity: `${getDisplayName(participant)} joined the room.` });
    }

    function handleParticipantLeft(participant) {
      updateRoomState({ activity: `${getDisplayName(participant)} left the room.` });
    }

    document.on('update', (update, origin) => {
      if (isJoined && origin !== 'server' && origin !== 'remote') {
        socket.emit('room:document-update', { update });
      }
    });
    awareness.on('update', ({ added, updated, removed }, origin) => {
      if (!isJoined || origin === 'remote') {
        return;
      }
      const changedClients = [...added, ...updated, ...removed];
      if (changedClients.length > 0) {
        socket.emit('room:awareness-update', {
          update: encodeAwarenessUpdate(awareness, changedClients),
        });
      }
    });

    socket.on('connect', () => {
      joinRoom();
    });
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on('room:document-update', handleDocumentUpdate);
    socket.on('room:awareness-update', handleAwarenessUpdate);
    socket.on('room:error', handleRoomError);
    socket.on('room:members', handleMembersUpdate);
    socket.on('room:participant-joined', handleParticipantJoined);
    socket.on('room:participant-left', handleParticipantLeft);
    socket.connect();

    return () => {
      isJoined = false;
      socket.emit('room:leave');
      socket.disconnect();
      awareness.destroy();
      document.destroy();
    };
  }, [roomId, user]);

  const currentSession = session?.roomId === roomId ? session : null;
  return {
    activity: currentRoomState.activity,
    awareness: currentSession?.awareness,
    document: currentSession?.document,
    error: currentRoomState.error,
    members: currentRoomState.members,
    status: currentRoomState.status,
  };
}
